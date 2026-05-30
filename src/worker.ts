import { runIngestion, processGroupMessage, type IngestionConfig, type SyncGroupMessage } from './ingestion/index.js';
import { runMirrorJob, getPendingCards, uploadCardImage } from './image-mirror.js';
import { processPendingWebhooks } from './scrydexProcessor.js';
import { syncScrydexSetMappings } from './scrydexSetMapping.js';
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
  // Scrydex price + set mapping
  SCRYDEX_API_KEY?: string;
  SCRYDEX_TEAM_ID?: string;
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

  /**
   * Cron handler:
   *  "0 6 * * *"    — daily TCGPlayer data sync
   *  "0 3 * * SUN"  — weekly image mirror + Scrydex set mapping
   *  "*/10 * * * *" — every 10 min: process pending Scrydex webhook log rows
   */
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    switch (event.cron) {

      case '0 3 * * SUN':
        // Weekly: image mirror (loop until empty) + Scrydex set mapping in parallel
        ctx.waitUntil(
          Promise.all([
            runMirrorJob({ DB: env.DB, IMAGES_BUCKET: env.IMAGES_BUCKET }, Infinity)
              .catch((err) => logger.error('Scheduled mirror failed', { error: String(err) })),
            syncScrydexSetMappings(env)
              .catch((err) => logger.error('Scrydex set mapping failed', { error: String(err) })),
          ])
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
