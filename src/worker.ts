import { runIngestion, processGroupMessage, type IngestionConfig, type SyncGroupMessage } from './ingestion/index.js';
import { runMirrorJob, getPendingCards, uploadCardImage } from './image-mirror.js';
import { processPendingWebhooks, refreshCardPrices } from './scrydexProcessor.js';
import { syncSingleSet } from './scrydexSyncSet.js';
import { syncScrydexSetMappings } from './scrydexSetMapping.js';
import { syncScrydexImages } from './scrydexImageSync.js';
import { cleanupScrydexApiLog, scrydexVisionIdentify, ScrydexCreditLimitError } from './lib/scrydexClient.js';
import { fetchTcggoGradedPrices, searchTcggoArtists, fetchAllArtistCards } from './lib/tcggoClient.js';
import { fetchPriceChartingGraded } from './lib/pricechartingClient.js';
import { backfillR2ImageUrls, backfillVariantImages, seedVariantProducts } from './backfillR2Urls.js';
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
  // tcggo (pokemon-tcg-api.p.rapidapi.com) RapidAPI key — graded eBay-sold medians
  // (admin-only demo path; key lives here, never in the Content app)
  TCGGO_RAPIDAPI_KEY?: string;
  // PriceCharting API token — PRIMARY admin graded-price source (operator sets it;
  // lives here, never in the Content app). See lib/pricechartingClient.ts.
  PRICECHARTING_TOKEN?: string;
  // Shared KV namespace (the Content app's SLEEVEDPAGES_KV) — caches resolved
  // PriceCharting ids (pc_id:*) and raw product responses (pc_product:*).
  SLEEVEDPAGES_KV?: KVNamespace;
  // Credit-control env vars (see scrydexProcessor.ts for details)
  SCRYDEX_PRICE_FRESHNESS_HOURS?: string;  // default 20 — freshness window before re-fetching an expansion (MUST stay <24h, the daily drain interval)
  SCRYDEX_PRICE_GAMES?: string;            // comma-separated slug allowlist, e.g. 'pokemon,onepiece' — deliberately UNSET in prod
  SCRYDEX_DRAIN_MAX_FETCHES?: string;      // default 1500 — cap on Scrydex page-calls per daily drain invocation (waitUntil safety)
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

    // ── tcggo graded prices (require x-worker-secret; GET) ──────────────────────
    // Returns eBay-sold graded medians for a TCGPlayer product id. The Content app
    // proxies this ADMIN-ONLY and KV-caches it 24h to protect the free-tier quota.
    // No Scrydex key needed — this uses TCGGO_RAPIDAPI_KEY (the RapidAPI key lives
    // here, never in the Content app).
    if (pathname === '/tcggo/graded-prices' && request.method === 'GET') {
      const secret = request.headers.get('x-worker-secret');
      if (!env.INGESTION_WORKER_SECRET || secret !== env.INGESTION_WORKER_SECRET) {
        return json({ ok: false, error: 'Unauthorized' }, 401);
      }
      if (!env.TCGGO_RAPIDAPI_KEY) {
        return json({ ok: false, error: 'TCGGO_RAPIDAPI_KEY not configured' }, 503);
      }
      const tcgplayerId = new URL(request.url).searchParams.get('tcgplayerId');
      if (!tcgplayerId) {
        return json({ ok: false, error: 'tcgplayerId is required' }, 400);
      }
      try {
        const result = await fetchTcggoGradedPrices(env, tcgplayerId);
        return json({ ok: true, ...result });
      } catch (err) {
        logger.error('tcggo graded fetch failed', { error: String(err), tcgplayerId });
        return json({ ok: false, error: String(err) }, 502);
      }
    }

    // ── tcggo artist search (require x-worker-secret; GET) ──────────────────────
    // Repurposed tcggo: list/search artists so the Content admin can mint an owned
    // template binder from an artist's card list. Admin-only + KV-cached by Content.
    if (pathname === '/tcggo/artists' && request.method === 'GET') {
      const secret = request.headers.get('x-worker-secret');
      if (!env.INGESTION_WORKER_SECRET || secret !== env.INGESTION_WORKER_SECRET) {
        return json({ ok: false, error: 'Unauthorized' }, 401);
      }
      if (!env.TCGGO_RAPIDAPI_KEY) return json({ ok: false, error: 'TCGGO_RAPIDAPI_KEY not configured' }, 503);
      const u = new URL(request.url);
      const search = (u.searchParams.get('search') ?? '').trim();
      const page = Math.max(1, Number(u.searchParams.get('page')) || 1);
      try {
        const result = await searchTcggoArtists(env, search, page);
        return json({ ok: true, ...result });
      } catch (err) {
        logger.error('tcggo artist search failed', { error: String(err), search });
        return json({ ok: false, error: String(err) }, 502);
      }
    }

    // ── tcggo artist cards (require x-worker-secret; GET) ───────────────────────
    // Paginate ALL of an artist's cards (bounded; see fetchAllArtistCards). The
    // Content admin maps these to canonical products + builds the template.
    const artistCardsMatch = pathname.match(/^\/tcggo\/artists\/([^/]+)\/cards$/);
    if (artistCardsMatch && request.method === 'GET') {
      const secret = request.headers.get('x-worker-secret');
      if (!env.INGESTION_WORKER_SECRET || secret !== env.INGESTION_WORKER_SECRET) {
        return json({ ok: false, error: 'Unauthorized' }, 401);
      }
      if (!env.TCGGO_RAPIDAPI_KEY) return json({ ok: false, error: 'TCGGO_RAPIDAPI_KEY not configured' }, 503);
      const artistId = decodeURIComponent(artistCardsMatch[1]);
      const u = new URL(request.url);
      const ccRaw = Number(u.searchParams.get('cardsCount'));
      const cardsCount = Number.isFinite(ccRaw) && ccRaw > 0 ? ccRaw : undefined;
      try {
        const result = await fetchAllArtistCards(env, artistId, { cardsCount });
        return json({ ok: true, artistId, count: result.cards.length, ...result });
      } catch (err) {
        logger.error('tcggo artist cards failed', { error: String(err), artistId });
        return json({ ok: false, error: String(err) }, 502);
      }
    }

    // ── PriceCharting graded prices (require x-worker-secret; GET) ───────────────
    // PRIMARY admin graded-price source. Resolves the canonical product → a
    // PriceCharting id (KV-cached), fetches /api/product, decodes the (company,
    // grade) tier, and returns { price, key, productName, console, salesVolume }.
    // The Content app proxies this ADMIN-ONLY and KV-caches it 24h. price:null means
    // unsupported/no-match — the Content source chain then falls back to tcggo.
    if (pathname === '/pricecharting/graded' && request.method === 'GET') {
      const secret = request.headers.get('x-worker-secret');
      if (!env.INGESTION_WORKER_SECRET || secret !== env.INGESTION_WORKER_SECRET) {
        return json({ ok: false, error: 'Unauthorized' }, 401);
      }
      if (!env.PRICECHARTING_TOKEN) {
        return json({ ok: false, error: 'PRICECHARTING_TOKEN not configured' }, 503);
      }
      const url = new URL(request.url);
      const canonicalProductId = Number(url.searchParams.get('canonicalProductId'));
      const company = (url.searchParams.get('company') ?? '').trim();
      const grade   = (url.searchParams.get('grade') ?? '').trim();
      if (!Number.isInteger(canonicalProductId) || canonicalProductId <= 0) {
        return json({ ok: false, error: 'canonicalProductId is required' }, 400);
      }
      if (!company || !grade) {
        return json({ ok: false, error: 'company and grade are required' }, 400);
      }
      try {
        const result = await fetchPriceChartingGraded(env, { canonicalProductId, company, grade });
        return json({ ok: true, ...result });
      } catch (err) {
        logger.error('pricecharting graded fetch failed', { error: String(err), canonicalProductId });
        return json({ ok: false, error: String(err) }, 502);
      }
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

      // Per-set Scrydex sync — BLOCKING (returns inserted/updated/variant counts so the
      // admin UI can show the result). Body: { setId | scrydexExpansionId, force? }.
      // One expansion fetch + canonical price/image writes; credit-guarded; marks the
      // expansion fresh on success (resumable). See scrydexSyncSet.ts.
      if (pathname === '/scrydex/sync-set') {
        const body = await request.json().catch(() => ({})) as { setId?: number | string; scrydexExpansionId?: string; force?: boolean };
        const setId = body.setId != null && body.setId !== '' ? Number(body.setId) : undefined;
        const scrydexExpansionId = body.scrydexExpansionId ? String(body.scrydexExpansionId) : undefined;
        if (setId == null && !scrydexExpansionId) {
          return json({ ok: false, error: 'setId or scrydexExpansionId is required' }, 400);
        }
        if (setId != null && !Number.isInteger(setId)) {
          return json({ ok: false, error: 'setId must be an integer' }, 400);
        }
        const result = await syncSingleSet(env, { setId, scrydexExpansionId, force: !!body.force });
        return json(result, result.ok ? 200 : 502);
      }

      // Scrydex Vision — identify a card from an image. BLOCKING (returns matches).
      // multipart/form-data: `image` (file) + optional `games` (csv scope). The Content
      // app proxies here admin-only; this centralises the key, credit guard, and the
      // 5-credit scrydex_api_log debit. 403 (credit cap / forbidden) → 502 with a flag so
      // the caller can fall back to Claude.
      if (pathname === '/scrydex/vision-identify') {
        const form = await request.formData().catch(() => null);
        const imageEntry = form?.get('image');
        const games = (form?.get('games') as string) || undefined;
        if (!imageEntry || typeof imageEntry === 'string') {
          return json({ ok: false, error: 'image file is required' }, 400);
        }
        const image = imageEntry as unknown as Blob;
        if (image.size > 20 * 1024 * 1024) {
          return json({ ok: false, error: 'image too large (max 20MB)' }, 413);
        }
        try {
          const res = await scrydexVisionIdentify(env, image, games);
          if (res.status === 403) {
            return json({ ok: false, error: 'Scrydex 403 (credit cap / forbidden)', status: 403 }, 502);
          }
          if (!res.ok) {
            return json({ ok: false, error: `Scrydex ${res.status}`, status: res.status }, 502);
          }
          const data = await res.json().catch(() => ({})) as { data?: { analysis?: unknown; matches?: unknown[] } };
          return json({
            ok:       true,
            analysis: data?.data?.analysis ?? null,
            matches:  data?.data?.matches ?? [],
          });
        } catch (err) {
          if (err instanceof ScrydexCreditLimitError) {
            return json({ ok: false, error: 'Scrydex credit guard triggered' }, 502);
          }
          logger.error('Vision identify failed', { error: String(err) });
          return json({ ok: false, error: String(err) }, 502);
        }
      }

      // Vendor on-demand single-card refresh — BLOCKING (returns the fresh result).
      // The Content app gates this (vendor access + ownership + 1/hour rate limit)
      // before proxying; here we just do the credit-guarded fetch + upsert.
      if (pathname === '/scrydex/refresh-card') {
        const body = await request.json().catch(() => ({})) as { product_id?: number | string };
        const productId = Number(body.product_id);
        if (!Number.isInteger(productId) || productId < 1) {
          return json({ ok: false, error: 'product_id (canonical products.id) is required' }, 400);
        }
        const result = await refreshCardPrices(env, productId);
        return json(result, result.ok ? 200 : 502);
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

    // POST /admin/seed-variant-products — seed missing alt art rows from Scrydex marketplace data
    if (pathname === '/admin/seed-variant-products' && request.method === 'POST') {
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
        seedVariantProducts(env, game).catch((err) =>
          logger.error('Variant product seeding failed', { error: String(err) })
        )
      );
      return json({ ok: true, message: game ? `Variant product seeding started for ${game}` : 'Variant product seeding started for all variant-image games' });
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
      const scrydexOnly = qs.get('scrydex_only') === '1';
      const cards       = await getPendingCards(env.DB, limit, scrydexOnly);
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
          source:               'scrydex' | 'tcgplayer';
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

      case '0 4 * * *':
        // DAILY: drain pending Scrydex webhook log rows (was */10 — see wrangler.toml
        // cost-control note). The drain dedups a day's notifications to one fetch per
        // distinct expansion. Freshness (20h) < this 24h interval, so prices still advance.
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
