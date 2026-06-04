import { runIngestion, processGroupMessage, type IngestionConfig, type SyncGroupMessage } from './ingestion/index.js';
import { runMirrorJob, getPendingCards, uploadCardImage } from './image-mirror.js';
import { processPendingWebhooks } from './scrydexProcessor.js';
import { syncScrydexSetMappings } from './scrydexSetMapping.js';
import { syncScrydexImages } from './scrydexImageSync.js';
import { cleanupScrydexApiLog } from './lib/scrydexClient.js';
import { backfillR2ImageUrls, backfillVariantImages } from './backfillR2Urls.js';
import { logger } from './ingestion/logger.js';

export interface Env {
  DB: D1Database;
  IMAGES_BUCKET: R2Bucket;
  SYNC_QUEUE?: Queue<SyncGroupMessage>;
  TCGCSV_BASE_URL?: string;
  LOG_LEVEL?: string;
  DRY_RUN?: string;
  BACKFILL_LIMIT?: string;
  FORCE_SYNC?: string;
  // Scrydex
  SCRYDEX_API_KEY?: string;
  SCRYDEX_TEAM_ID?: string;
  SCRYDEX_MONTHLY_LIMIT?: string;
  // Shared secret for admin-triggered HTTP endpoints
  INGESTION_WORKER_SECRET?: string;
  // Credit-control env vars (see scrydexProcessor.ts for details)
  SCRYDEX_PRICE_FRESHNESS_HOURS?: string;  // default 20 — freshness window before re-fetching an expansion
  SCRYDEX_PRICE_GAMES?: string;            // comma-separated slug allowlist, e.g. 'pokemon,onepiece'
}

function buildConfig(env: Env): IngestionConfig {
  return {
    db: env.DB,
    syncQueue: env.SYNC_QUEUE ?? null,
    tcgcsvBaseUrl: env.TCGCSV_BASE_URL ?? 'https://tcgcsv.com',
    logLevel: env.LOG_LEVEL ?? 'info',
    dryRun: env.DRY_RUN === 'true',
    backfillLimit: env.BACKFILL_LIMIT ? parseInt(env.BACKFILL_LIMIT, 10) : null,
    forceSync: env.FORCE_SYNC === 'true',
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default {
  /**
   * HTTP handler — used for manual triggers and health checks.
   *
   * GET /          → health check
   * POST /sync     → kick off a sync run; responds immediately, runs in background
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === '/') {
      return json({ ok: true, service: 'sleevedpages-ingestion' });
    }

    if (pathname === '/sync' && request.method === 'POST') {
      ctx.waitUntil(
        runIngestion(buildConfig(env)).catch((err) =>
          logger.error('Manual sync failed', { error: String(err) })
        )
      );
      return json({ ok: true, message: 'Sync started' });
    }

    // ── Scrydex manual trigger endpoints (require x-worker-secret header) ────────
    if (pathname.startsWith('/scrydex/') && request.method === 'POST') {
      const secret = request.headers.get('x-worker-secret');
      if (!env.INGESTION_WORKER_SECRET || secret !== env.INGESTION_WORKER_SECRET) {
        return json({ ok: false, error: 'Unauthorized' }, 401);
      }
      if (!env.SCRYDEX_API_KEY || !env.SCRYDEX_TEAM_ID) {
        return json({ ok: false, error: 'SCRYDEX_API_KEY / SCRYDEX_TEAM_ID not configured' }, 503);
      }

      if (pathname === '/scrydex/process') {
        ctx.waitUntil(
          processPendingWebhooks(env).catch((err) =>
            logger.error('Manual Scrydex process failed', { error: String(err) })
          )
        );
        return json({ ok: true, message: 'Scrydex webhook processing started' });
      }

      if (pathname === '/scrydex/sync-sets') {
        ctx.waitUntil(
          syncScrydexSetMappings(env).catch((err) =>
            logger.error('Manual Scrydex set mapping failed', { error: String(err) })
          )
        );
        return json({ ok: true, message: 'Scrydex set mapping started' });
      }

      if (pathname === '/scrydex/sync-images') {
        const body = request.headers.get('content-type')?.includes('application/json')
          ? await request.json().catch(() => ({})) as { game?: string }
          : {} as { game?: string };
        const game = body.game || undefined;
        ctx.waitUntil(
          syncScrydexImages(env, game).catch((err) =>
            logger.error('Manual Scrydex image sync failed', { error: String(err) })
          )
        );
        return json({ ok: true, message: game ? `Scrydex image sync started for ${game}` : 'Scrydex image sync started' });
      }
    }

    // POST /admin/sync-variant-images — re-mirror variant-specific images per game
    if (pathname === '/admin/sync-variant-images' && request.method === 'POST') {
      const secret = request.headers.get('x-worker-secret');
      if (!env.INGESTION_WORKER_SECRET || secret !== env.INGESTION_WORKER_SECRET) {
        return json({ ok: false, error: 'Unauthorized' }, 401);
      }
      if (!env.SCRYDEX_API_KEY || !env.SCRYDEX_TEAM_ID) {
        return json({ ok: false, error: 'SCRYDEX_API_KEY / SCRYDEX_TEAM_ID not configured' }, 503);
      }
      const body = request.headers.get('content-type')?.includes('application/json')
        ? await request.json().catch(() => ({})) as { game?: string }
        : {} as { game?: string };
      const game = body.game || undefined;
      ctx.waitUntil(
        backfillVariantImages(env, game).catch((err) =>
          logger.error('Variant image backfill failed', { error: String(err) })
        )
      );
      return json({ ok: true, message: game ? `Variant image re-sync started for ${game}` : 'Variant image re-sync started for all variant-image games' });
    }

    // POST /admin/backfill-r2-urls — one-time backfill of R2 URLs in tcg_products
    if (pathname === '/admin/backfill-r2-urls' && request.method === 'POST') {
      const secret = request.headers.get('x-worker-secret');
      if (!env.INGESTION_WORKER_SECRET || secret !== env.INGESTION_WORKER_SECRET) {
        return json({ ok: false, error: 'Unauthorized' }, 401);
      }
      ctx.waitUntil(
        backfillR2ImageUrls(env).catch((err) =>
          logger.error('R2 URL backfill failed', { error: String(err) })
        )
      );
      return json({ ok: true, message: 'R2 backfill started — check worker logs for completion summary' });
    }

    if (pathname === '/mirror' && request.method === 'POST') {
      try {
        // maxBatches=1 keeps the HTTP response well under 30s
        const result = await runMirrorJob({ DB: env.DB, IMAGES_BUCKET: env.IMAGES_BUCKET }, 1);
        return json({ ok: true, ...result });
      } catch (err) {
        logger.error('Manual mirror failed', { error: String(err) });
        return json({ ok: false, error: String(err) }, 500);
      }
    }

    // GET /mirror/pending?limit=N
    // Returns the next N cards that still need mirroring, for use by mirror-local.mjs.
    if (pathname === '/mirror/pending' && request.method === 'GET') {
      const qs          = new URL(request.url).searchParams;
      const limit       = Math.min(200, Math.max(1, parseInt(qs.get('limit') ?? '50', 10)));
      const skrydexOnly = qs.get('skrydex_only') === '1';
      const cards       = await getPendingCards(env.DB, limit, skrydexOnly);
      return json({ ok: true, cards, has_more: cards.length === limit });
    }

    // POST /mirror/upload
    // Accepts image bytes (base64) fetched by mirror-local.mjs from a non-datacenter IP,
    // writes them to R2, and updates tcg_products.
    if (pathname === '/mirror/upload' && request.method === 'POST') {
      try {
        const body = await request.json() as {
          tcgplayer_product_id: number;
          imageBase64:          string;
          contentType:          string;
          source:               'skrydex' | 'tcgplayer';
        };

        // Decode base64 → ArrayBuffer
        const binary = atob(body.imageBase64);
        const bytes  = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        const r2Url = await uploadCardImage(
          { DB: env.DB, IMAGES_BUCKET: env.IMAGES_BUCKET },
          body.tcgplayer_product_id,
          bytes.buffer,
          body.contentType,
          body.source,
        );
        return json({ ok: true, url: r2Url });
      } catch (err) {
        logger.error('Mirror upload failed', { error: String(err) });
        return json({ ok: false, error: String(err) }, 500);
      }
    }

    return json({ ok: false, error: 'Not found' }, 404);
  },

  // Cron handler:
  //   "0 6 * * *"         — daily TCGPlayer data sync
  //   "0 3 * * SUN"       — weekly image mirror + Scrydex set mapping
  //   every-10-min cron   — process pending Scrydex webhook log rows
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    switch (event.cron) {

      case '0 3 * * SUN':
        // Weekly pipeline (production only — UAT has this cron permanently disabled in wrangler.toml)
        ctx.waitUntil(
          (async () => {
            if (env.SCRYDEX_API_KEY && env.SCRYDEX_TEAM_ID) {
              await syncScrydexSetMappings(env)
                .catch((err) => logger.error('Scrydex set mapping failed', { error: String(err) }))
              await syncScrydexImages(env)
                .catch((err) => logger.error('Scrydex image sync failed', { error: String(err) }))
            }
            await runMirrorJob({ DB: env.DB, IMAGES_BUCKET: env.IMAGES_BUCKET }, Infinity)
              .catch((err) => logger.error('Scheduled mirror failed', { error: String(err) }))

            await cleanupScrydexApiLog(env.DB)
              .catch((err) => logger.error('scrydex_api_log cleanup failed', { error: String(err) }))
          })()
        );
        break;

      case '*/10 * * * *':
        // Every 10 min: drain pending Scrydex webhook log rows
        if (env.SCRYDEX_API_KEY && env.SCRYDEX_TEAM_ID) {
          ctx.waitUntil(
            processPendingWebhooks(env).catch((err) =>
              logger.error('Scrydex webhook processing failed', { error: String(err) })
            )
          );
        }
        break;

      default:
        // "0 6 * * *" and any other cron — daily TCG sync
        ctx.waitUntil(
          runIngestion(buildConfig(env)).catch((err) =>
            logger.error('Scheduled sync failed', { error: String(err) })
          )
        );
        break;
    }
  },

  /**
   * Queue consumer — invoked for each batch of group messages.
   * Processes up to max_batch_size groups sequentially; max_concurrent_consumers = 1
   * ensures TCGCSV fetch rate stays orderly across invocations.
   *
   * HTTP fetch errors are caught inside processGroupMessage (groups_completed still
   * advances). D1 errors propagate here, causing the queue to retry the message.
   */
  async queue(
    batch: MessageBatch<SyncGroupMessage>,
    env: Env
  ): Promise<void> {
    for (const message of batch.messages) {
      await processGroupMessage(message.body, env.DB);
      message.ack();
    }
  },
};
