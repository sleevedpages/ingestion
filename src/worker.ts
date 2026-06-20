import { runIngestion, processGroupMessage, type IngestionConfig, type SyncGroupMessage } from './ingestion/index.js';
import { runMirrorJob, getPendingCards, uploadCardImage } from './image-mirror.js';
import { processPendingWebhooks, refreshCardPrices } from './scrydexProcessor.js';
import { enrichCard, type EnrichClass } from './scrydexEnrich.js';
import { syncSingleSet } from './scrydexSyncSet.js';
import { syncScrydexSetMappings } from './scrydexSetMapping.js';
import { syncScrydexImages } from './scrydexImageSync.js';
import { scrydexVisionIdentify, ScrydexCreditLimitError } from './lib/scrydexClient.js';
import { searchTcggoArtists, fetchAllArtistCards } from './lib/tcggoClient.js';
import { fetchPriceChartingGraded } from './lib/pricechartingClient.js';
import { fetchEbayGraded } from './lib/ebayGradedClient.js';
import {
  fetchPriceChartingCsvToR2,
  runPriceChartingFetch,
  runPriceChartingProcess,
  processPriceChartingWindow,
  startPriceChartingProcessing,
  resolveProcessKey,
  type PcProcessMessage,
} from './pricechartingIngest.js';
import { PRICECHARTING_CATEGORIES, type PriceChartingCategory } from './lib/pricechartingCsv.js';
import { backfillR2ImageUrls, backfillVariantImages, seedVariantProducts } from './backfillR2Urls.js';
import {
  ADMIN_JOB_IDS,
  isAdminJobId,
  runWeeklyImagePipeline,
  priceChartingCategoryForDay,
  acquireJobLock,
  releaseJobLock,
  priceChartingCooldownRemaining,
} from './adminJobs.js';
import { logger } from './ingestion/logger.js';

export interface Env {
  DB: D1Database;
  IMAGES_BUCKET: R2Bucket;
  SYNC_QUEUE?: Queue<SyncGroupMessage>;
  // Dedicated PriceCharting PROCESS queue — drives the from-R2 windowed ingest across invocations
  // (one window per message, self-perpetuating to EOF). The row offset cursor travels IN the
  // message (no KV cursor). See pricechartingIngest.ts.
  PC_PROCESS_QUEUE?: Queue<PcProcessMessage>;
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
  // tcggo (pokemon-tcg-api.p.rapidapi.com) RapidAPI key — STILL REQUIRED: powers the
  // Artist→Binder-Template ingestion tool (/tcggo/artists, /tcggo/artists/:id/cards).
  // The graded eBay-sold role was REMOVED (unreliable id matching) — eBay sold comps
  // now come from the Apify actor below. Key lives here, never in the Content app.
  TCGGO_RAPIDAPI_KEY?: string;
  // Apify eBay sold-comps gap-filler — graded medians for slabs PriceCharting can't
  // price (TAG/ACE, grade < 7). Confirmed actor: caffein.dev/ebay-sold-listings
  // (APIFY_EBAY_ACTOR_ID = oTtB3VgfuE9GtxQt2). Both live HERE only (admin-proxied;
  // never in the Content app, never logged or returned). See lib/ebayGradedClient.ts.
  APIFY_TOKEN?: string;
  APIFY_EBAY_ACTOR_ID?: string;
  // PriceCharting API token — PRIMARY admin graded-price source (operator sets it;
  // lives here, never in the Content app). Also powers the daily CSV bulk-ingest
  // (src/pricechartingIngest.ts). See lib/pricechartingClient.ts.
  PRICECHARTING_TOKEN?: string;
  // PriceCharting CSV bulk-ingest tuning (optional — sane defaults in pricechartingIngest.ts)
  PC_INGEST_MAX_ROWS?: string;   // rows COLLECTED into the in-memory window per PROCESS invocation; default 25000
  PC_INGEST_FUZZY_MAX?: string;  // bounded fuzzy lookups per window; default 400
  PC_INGEST_BUDGET_MS?: string;  // wall-time budget per PROCESS window before stopping + enqueuing the next; default 20000
  PC_PROCESS_MAX_BATCHES?: string; // D1 DB.batch() cap per PROCESS window (sub-request safety); default 300
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

    // ── eBay sold-comp graded gap-filler (require x-worker-secret; GET) ─────────
    // Graded medians for slabs PriceCharting can't price (TAG/ACE, grade < 7) or has
    // no value for. Resolves the canonical product → eBay completed+sold search terms,
    // runs the Apify eBay actor, then match-filters / trims / takes a median + sample
    // size. The Content app proxies this ADMIN-ONLY, behind the dormant
    // `ebay_graded_enabled` flag, and KV-caches it 24h (incl. nulls) so the actor fires
    // at most once per card/grade/day. APIFY_TOKEN + APIFY_EBAY_ACTOR_ID live here only.
    // price:null / n:0 means no comps survived — the Content chain falls to the sold link.
    if (pathname === '/ebay/graded' && request.method === 'GET') {
      const secret = request.headers.get('x-worker-secret');
      if (!env.INGESTION_WORKER_SECRET || secret !== env.INGESTION_WORKER_SECRET) {
        return json({ ok: false, error: 'Unauthorized' }, 401);
      }
      if (!env.APIFY_TOKEN || !env.APIFY_EBAY_ACTOR_ID) {
        return json({ ok: false, error: 'APIFY_TOKEN / APIFY_EBAY_ACTOR_ID not configured' }, 503);
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
        const result = await fetchEbayGraded(env, { canonicalProductId, company, grade });
        return json({ ok: true, ...result });
      } catch (err) {
        logger.error('ebay graded fetch failed', { error: String(err), canonicalProductId });
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

    // POST /pricecharting/fetch — the ONLY path that DOWNLOADS. Body { category }. Downloads the
    // full CSV ONCE → R2 (dated key), arms the 10-min cooldown, then enqueues PROCESSing. Gated by
    // the cooldown (429 while cooling) so it can never become a rapid re-download vector. Needs
    // PRICECHARTING_TOKEN. See pricechartingIngest.ts.
    if (pathname === '/pricecharting/fetch' && request.method === 'POST') {
      const secret = request.headers.get('x-worker-secret');
      if (!env.INGESTION_WORKER_SECRET || secret !== env.INGESTION_WORKER_SECRET) {
        return json({ ok: false, error: 'Unauthorized' }, 401);
      }
      if (!env.PRICECHARTING_TOKEN) {
        return json({ ok: false, error: 'PRICECHARTING_TOKEN not configured' }, 503);
      }
      const body = await request.json().catch(() => null) as { category?: string } | null;
      const category = (body?.category ?? '').trim() as PriceChartingCategory;
      if (!PRICECHARTING_CATEGORIES.includes(category)) {
        return json({ ok: false, error: `category must be one of ${PRICECHARTING_CATEGORIES.join(', ')}` }, 400);
      }
      const cooldown = await priceChartingCooldownRemaining(env);
      if (cooldown > 0) {
        return json({
          ok: false,
          error: `PriceCharting's CSV download is rate-limited to ~1 per 10 minutes. Try again in ~${Math.max(1, Math.ceil(cooldown / 60))} min.`,
          cooldown: true,
          retryAfterSec: cooldown,
        }, 429);
      }
      try {
        const result = await runPriceChartingFetch(env, category);   // downloads (arms cooldown) + enqueues PROCESS
        return json({ ok: true, ...result, processing: 'enqueued' });
      } catch (err) {
        logger.error('pricecharting csv fetch failed', { error: String(err), category });
        return json({ ok: false, error: String(err) }, 502);
      }
    }

    // POST /pricecharting/ingest — PROCESS the cached R2 file (NO download, unlimited, safe to
    // re-run). Body { category, sync? }. Default: enqueues the PROCESS chain (returns immediately).
    // `sync:true` processes ONE window inline from offset 0 and returns its counts (verification).
    // Does NOT need PRICECHARTING_TOKEN — it only reads R2. 409 if nothing has been fetched yet.
    if (pathname === '/pricecharting/ingest' && request.method === 'POST') {
      const secret = request.headers.get('x-worker-secret');
      if (!env.INGESTION_WORKER_SECRET || secret !== env.INGESTION_WORKER_SECRET) {
        return json({ ok: false, error: 'Unauthorized' }, 401);
      }
      const body = await request.json().catch(() => null) as { category?: string; sync?: boolean } | null;
      const category = (body?.category ?? '').trim() as PriceChartingCategory;
      if (!PRICECHARTING_CATEGORIES.includes(category)) {
        return json({ ok: false, error: `category must be one of ${PRICECHARTING_CATEGORIES.join(', ')}` }, 400);
      }
      try {
        const resolved = await resolveProcessKey(env, category);
        if (!resolved) {
          return json({ ok: false, error: `No cached CSV in R2 for ${category} — run POST /pricecharting/fetch first.` }, 409);
        }
        if (body?.sync) {
          const counts = await processPriceChartingWindow(env, {
            kind: 'pricecharting-process', category, key: resolved.key, offset: 0, stale: resolved.stale,
          });
          return json({ ok: true, mode: 'sync-window', ...counts });
        }
        await startPriceChartingProcessing(env, category, resolved.key, resolved.stale);
        return json({ ok: true, mode: 'enqueued', category, key: resolved.key, stale: resolved.stale });
      } catch (err) {
        logger.error('pricecharting csv process failed', { error: String(err), category });
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

      // Tier-aware detail enrichment — BLOCKING (returns per-class counts). The Content app
      // resolves the viewer's tier + per-data-class freshness and only sends the STALE classes
      // the viewer is entitled to (Collector → ['core']; Curator+ → ['core','comps','history']).
      // This does the credit-guarded Scrydex fetches + canonical upserts. See scrydexEnrich.ts.
      if (pathname === '/scrydex/enrich-card') {
        const body = await request.json().catch(() => ({})) as { canonicalProductId?: number | string; classes?: string[] };
        const canonicalProductId = Number(body.canonicalProductId);
        if (!Number.isInteger(canonicalProductId) || canonicalProductId < 1) {
          return json({ ok: false, error: 'canonicalProductId (canonical products.id) is required' }, 400);
        }
        const allowed: EnrichClass[] = ['core', 'comps', 'history'];
        const classes = (Array.isArray(body.classes) ? body.classes : [])
          .filter((c): c is EnrichClass => (allowed as string[]).includes(c));
        if (classes.length === 0) {
          return json({ ok: false, error: 'classes must include at least one of core|comps|history' }, 400);
        }
        const result = await enrichCard(env, { canonicalProductId, classes });
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

    // POST /admin/run-job — manual, on-demand trigger for a scheduled ingestion job
    // (admin-proxied from the Content portal; requires x-worker-secret). Runs the SAME function the
    // cron/job body calls, fire-and-forget via waitUntil, and guards against double-firing with a
    // best-effort KV lock. Body:
    //   { job: 'tcg-sync'|'image-mirror'|'scrydex-drain'|'pricecharting-csv'|'pricecharting-download', force? }
    // PriceCharting is FETCH/PROCESS-split: 'pricecharting-csv' = PROCESS the cached R2 CSV (no
    // download); 'pricecharting-download' = FETCH fresh → R2 → PROCESS (the only download; cooldown-gated).
    if (pathname === '/admin/run-job' && request.method === 'POST') {
      const secret = request.headers.get('x-worker-secret');
      if (!env.INGESTION_WORKER_SECRET || secret !== env.INGESTION_WORKER_SECRET) {
        return json({ ok: false, error: 'Unauthorized' }, 401);
      }
      const body = await request.json().catch(() => ({})) as { job?: string; force?: boolean };
      const job = body.job;
      if (!isAdminJobId(job)) {
        return json({ ok: false, error: `job must be one of: ${ADMIN_JOB_IDS.join(', ')}` }, 400);
      }
      // Per-job prerequisites (mirror the cron guards). image-mirror runs without Scrydex keys
      // (the Scrydex sub-steps self-skip inside runWeeklyImagePipeline); scrydex-drain requires
      // them. pricecharting-download (the ONLY path that downloads) requires the PriceCharting
      // token; pricecharting-csv (PROCESS from the cached R2 file) needs NO token.
      if (job === 'scrydex-drain' && !(env.SCRYDEX_API_KEY && env.SCRYDEX_TEAM_ID)) {
        return json({ ok: false, error: 'SCRYDEX_API_KEY / SCRYDEX_TEAM_ID not configured' }, 503);
      }
      if (job === 'pricecharting-download' && !env.PRICECHARTING_TOKEN) {
        return json({ ok: false, error: 'PRICECHARTING_TOKEN not configured' }, 503);
      }
      // PriceCharting's per-game CSV download is HARD rate-limited (~1/10min, abuse → account
      // revocation). Gate ONLY the download job behind the cooldown (set by ANY download) so it
      // can't become a rapid-loop vector. pricecharting-csv re-processes the cached file → unlimited.
      if (job === 'pricecharting-download') {
        const cooldown = await priceChartingCooldownRemaining(env);
        if (cooldown > 0) {
          return json({
            ok: false,
            error: `PriceCharting's CSV download is rate-limited to ~1 per 10 minutes. Try again in ~${Math.max(1, Math.ceil(cooldown / 60))} min.`,
            cooldown: true,
            retryAfterSec: cooldown,
          }, 429);
        }
      }
      // Double-fire guard — refuse a second run while one is already in flight.
      if (!(await acquireJobLock(env, job))) {
        return json({ ok: false, error: 'This job is already running.', alreadyRunning: true }, 409);
      }

      // Both PriceCharting jobs operate on the day-rotated category (parity with the cron). The
      // cooldown is armed inside runPriceChartingFetch the moment it downloads — no separate call.
      const category = job === 'pricecharting-csv' || job === 'pricecharting-download'
        ? priceChartingCategoryForDay()
        : undefined;

      ctx.waitUntil(
        (async () => {
          try {
            switch (job) {
              case 'tcg-sync':
                await runIngestion(buildConfig(env));
                break;
              case 'image-mirror':
                await runWeeklyImagePipeline(env);
                break;
              case 'scrydex-drain':
                await processPendingWebhooks(env);
                break;
              case 'pricecharting-csv':
                await runPriceChartingProcess(env, category!);   // PROCESS cached R2 file — NO download
                break;
              case 'pricecharting-download':
                await runPriceChartingFetch(env, category!);     // download fresh → R2 → PROCESS
                break;
            }
          } catch (err) {
            logger.error('Manual job run failed', { job, error: String(err) });
          } finally {
            await releaseJobLock(env, job);
          }
        })()
      );

      return json({ ok: true, job, started: true, ...(category ? { category } : {}) });
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

  // Cron handler (each job can also be run on demand via POST /admin/run-job — see adminJobs.ts):
  //   "0 6 * * *"    — daily TCG (CSV) data sync                 → runIngestion (default case)
  //   "0 3 * * SUN"  — weekly image-mirror pipeline               → runWeeklyImagePipeline
  //   "0 4 * * *"    — daily Scrydex webhook drain                → processPendingWebhooks
  //   "0 5 * * *"    — daily PriceCharting FETCH (day-rotated cat) → runPriceChartingFetch (→ queue PROCESS)
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    switch (event.cron) {

      case '0 3 * * SUN':
        // Weekly image pipeline (production only — UAT has this cron permanently disabled in
        // wrangler.toml). Same function the manual `image-mirror` trigger runs (see adminJobs.ts),
        // so cron and on-demand stay in lockstep.
        ctx.waitUntil(
          runWeeklyImagePipeline(env).catch((err) =>
            logger.error('Weekly image pipeline failed', { error: String(err) })
          )
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

      case '0 5 * * *':
        // DAILY: PriceCharting — FETCH the day-rotated category's CSV ONCE → R2 (arms the 10-min
        // cooldown), then PROCESS the WHOLE category from that single cached download via the
        // dedicated PC_PROCESS_QUEUE (zero further downloads). ONE download/day respects the
        // ~1-per-10-min limit; the queue finishes even a big ~88k-row category (the old per-window
        // re-download never could). The four categories rotate (every 4 days); spaced from the
        // 04:00 Scrydex drain. Prod only (UAT cron list omits it).
        if (env.PRICECHARTING_TOKEN) {
          const category = priceChartingCategoryForDay();
          ctx.waitUntil(
            runPriceChartingFetch(env, category).catch((err) =>
              logger.error('PriceCharting CSV fetch failed', { error: String(err), category })
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
   * Queue consumer — serves TWO queues, discriminated by `batch.queue`:
   *  - sleevedpages-pricecharting-queue → PriceCharting PROCESS: ingest ONE window from the cached
   *    R2 file, then (if not wrapped) enqueue the NEXT offset — self-perpetuating to EOF with ZERO
   *    further downloads. The offset cursor travels in the message. Idempotent upserts make a
   *    redelivery safe. max_batch_size=1 so each message is one bounded window.
   *  - sleevedpages-sync-queue → TCGCSV per-set sync (unchanged). Processes up to max_batch_size
   *    groups sequentially; max_concurrency=1 keeps the TCGCSV fetch rate orderly. HTTP
   *    fetch errors are caught inside processGroupMessage; D1 errors propagate → queue retry.
   */
  async queue(
    batch: MessageBatch<SyncGroupMessage | PcProcessMessage>,
    env: Env
  ): Promise<void> {
    if (batch.queue.includes('pricecharting')) {
      for (const message of batch.messages) {
        const msg = message.body as PcProcessMessage;
        try {
          const counts = await processPriceChartingWindow(env, msg);
          if (!counts.wrapped && env.PC_PROCESS_QUEUE) {
            // Enqueue the continuation BEFORE ack so a crash re-runs this window (idempotent) and
            // re-enqueues — the chain never silently stops mid-category.
            await env.PC_PROCESS_QUEUE.send({ ...msg, offset: counts.cursorNext });
          }
          message.ack();
        } catch (err) {
          logger.error('PriceCharting process window failed', {
            error: String(err), key: msg.key, offset: msg.offset, category: msg.category,
          });
          message.retry();
        }
      }
      return;
    }
    for (const message of batch.messages) {
      await processGroupMessage(message.body as SyncGroupMessage, env.DB);
      message.ack();
    }
  },
};
