/**
 * image-mirror.ts
 *
 * Mirrors card images into R2 (WP-2 resurrection, 2026-07-07 — audit IMG-1/3/4/10):
 *  - English Pokémon: constructed Scrydex CDN URL (free, high-res)
 *  - Any game whose product_images.source_url is a Scrydex CDN url: direct fetch
 *  - TCGPlayer-cdn-only rows are NOT candidates (datacenter 403 + the deliberate
 *    no-TCGPlayer-in-R2 decision) — they serve from source_url via the app fallback
 *
 * Candidate selection applies an attempt ceiling + exponential backoff
 * (product_images.mirror_attempts / mirror_last_attempt_at, Content migration 0086)
 * and paginates by keyset (p.id > ?), never OFFSET.
 *
 * Stores images at: cards/{tcgplayer_product_id}.{ext}
 * Upserts product_images.r2_url (+ source, mirrored_at).
 * ALWAYS writes a per-run summary row to image_mirror_log (try/finally) —
 * processed/mirrored/failed/skipped + first_error — even if the run dies early.
 *
 * Called by:
 *  - Scheduled cron: Sunday 3 AM UTC (runWeeklyImagePipeline — mirror runs FIRST)
 *  - HTTP POST /mirror for manual trigger
 */

import { buildScrydexImageUrl, buildScrydexImageUrlFromSetName } from './lib/scrydexUrl.js';
import {
  writeR2Image,
  mirrorAttemptUpsert,
  isTcgplayerCdnUrl,
  isScrydexImageUrl,
  placeholderRepairUpsert,
  forceSourceUrlUpsert,
} from './lib/productImages.js';
import { isPlaceholderImage, sha256Hex, tcgplayerFullImageUrl } from './lib/placeholderImages.js';
import { isEnglishPokemon } from './lib/gameNames.js';
import { logger } from './ingestion/logger.js';

// Re-export sha256Hex from the shared placeholder module so existing importers
// (image-mirror tests, mirror-local.mjs helpers) keep resolving it from here.
export { sha256Hex } from './lib/placeholderImages.js';

const BATCH_SIZE = 100;     // cards fetched from DB per invocation
const CONCURRENCY = 10;     // cards processed in parallel within each batch
const WALL_CLOCK_LIMIT = 25_000; // stop looping at 25s to stay inside the 30s Worker limit
const R2_PUBLIC_BASE = 'https://images.sleevedpages.com';

// ── WP-2 attempt bookkeeping knobs (audit IMG-4) ─────────────────────────────
// A row over the ceiling is permanently out of the pool (operator can reset by
// zeroing mirror_attempts). Below the ceiling, a failed row backs off
// exponentially: eligible again MIRROR_BACKOFF_BASE_DAYS * 2^attempts days after
// its last attempt (attempts=1 → 6d, 2 → 12d, 3 → 24d, 4 → 48d) — so a fresh
// failure sits out at least until the next weekly run and repeat failures fade
// out instead of starving the wall-clock budget forever.
export const MAX_MIRROR_ATTEMPTS = 5;
export const MIRROR_BACKOFF_BASE_DAYS = 3;

/** Pure JS mirror of the SQL backoff clause — the testable spec.
 *  True when a row with `attempts` prior attempts, last attempted at
 *  `lastAttemptAt` (ISO | null), is due for another try at `nowMs`. */
export function isMirrorRetryDue(attempts: number, lastAttemptAt: string | null, nowMs: number = Date.now()): boolean {
  if (attempts >= MAX_MIRROR_ATTEMPTS) return false;
  if (!lastAttemptAt) return true;
  const last = Date.parse(lastAttemptAt);
  if (!Number.isFinite(last)) return true;
  const backoffDays = MIRROR_BACKOFF_BASE_DAYS * 2 ** attempts;
  return nowMs - last >= backoffDays * 86_400_000;
}

/**
 * The ONE candidate-selection predicate (WP-2, audit IMG-4) — shared by
 * runMirrorJob and getPendingCards so the cron and mirror-local.mjs agree on
 * what is mirrorable. Alias contract: products p, sets s, canonical_games g,
 * LEFT JOIN product_images pi.
 *
 * A candidate must be ALL of:
 *  1. eligible — never mirrored (no pi row / r2 NULL with no source), or a
 *     TCGPlayer mirror upgradeable to Scrydex art. A source='scrydex' row with
 *     r2_url NULL (One Piece/Gundam CDN-as-final) stays deliberately EXCLUDED.
 *  2. mirrorable — the worker can actually fetch it: a Scrydex-CDN source_url,
 *     or English Pokémon (NOT 'Pokemon Japan' — IMG-6) with a mapped expansion
 *     for URL construction. TCGPlayer-cdn-only rows are OUT: the CDN 403s
 *     worker datacenter IPs AND TCGPlayer images are deliberately never
 *     mirrored to R2 (watermarked alts — see Ingestion/CLAUDE.md).
 *  3. due — under the attempt ceiling and past the exponential backoff.
 *     (1 << mirror_attempts) is SQLite's core bit-shift = 2^attempts; keep in
 *     exact step with isMirrorRetryDue() above.
 */
export function mirrorCandidateWhere(): string {
  return `p.number IS NOT NULL
      AND (
        (pi.r2_url IS NULL AND (pi.product_id IS NULL OR pi.source IS NULL))
        OR (pi.source = 'tcgplayer' AND s.scrydex_expansion_id IS NOT NULL)
      )
      AND (
        pi.source_url LIKE '%images.scrydex.com/%'
        OR (
          LOWER(REPLACE(g.name, 'é', 'e')) LIKE '%pokemon%'
          AND LOWER(g.name) NOT LIKE '%japan%'
          AND s.scrydex_expansion_id IS NOT NULL
        )
      )
      AND COALESCE(pi.mirror_attempts, 0) < ${MAX_MIRROR_ATTEMPTS}
      AND (
        pi.mirror_last_attempt_at IS NULL
        OR julianday('now') - julianday(pi.mirror_last_attempt_at)
           >= ${MIRROR_BACKOFF_BASE_DAYS} * (1 << COALESCE(pi.mirror_attempts, 0))
      )`;
}

export interface MirrorEnv {
  DB: D1Database;
  IMAGES_BUCKET: R2Bucket;
}

interface CardRow {
  product_row_id: number;           // products.id — the keyset cursor
  tcgplayer_product_id: number;
  image_url: string | null;
  image_source: string | null;
  card_number: string | null;
  set_name: string | null;
  scrydex_set_id: string | null;
  category_name: string | null;
}

interface MirrorStats {
  processed: number;
  mirrored: number;
  failed: number;
  skipped: number;
  scrydex_hits: number;
  tcgplayer_hits: number;
  placeholder_skips: number;    // Scrydex card-backs detected + rejected (not stamped)
  tcgplayer_fallbacks: number;  // rows whose source_url was repaired to the TCGplayer CDN
}

// WP-3 (audit IMG-6): English-Pokémon check lives in lib/gameNames.ts — it EXCLUDES
// 'Pokemon Japan' so the mirror never constructs English-set Scrydex URLs for JP cards.

// ── WP-2 placeholder fingerprint (audit IMG-10) ──────────────────────────────
// Scrydex serves its card-back placeholder (HTTP 200) for unknown card URLs. The
// old defence was a blanket <300 KB size guard, which also rejected legitimate
// small card scans. Replacement: at run start, fetch a card URL that CANNOT
// exist and hash the response — any subsequent fetch whose bytes hash the same
// IS the placeholder, byte-for-byte, regardless of size. If the probe fails the
// run proceeds with detection disabled (a real image still mirrors correctly).

/** Sanity floor: a sub-1 KB body is an error page/empty response, never card art. */
export const MIN_IMAGE_BYTES = 1024;

/** A Pokémon card number that cannot exist — the probe URL for the placeholder. */
export const PLACEHOLDER_PROBE_URL = 'https://images.scrydex.com/pokemon/base1-999999/large';

/** Fetches + hashes the Scrydex placeholder for this run. null = probe failed
 *  (404/network) → placeholder detection disabled for the run. */
export async function fetchPlaceholderHash(): Promise<string | null> {
  try {
    const res = await fetch(PLACEHOLDER_PROBE_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SleevedPages/1.0)' },
    });
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength === 0) return null;
    const hash = await sha256Hex(buffer);
    logger.info('Placeholder fingerprint calibrated', { bytes: buffer.byteLength, hash });
    return hash;
  } catch (e) {
    logger.warn('Placeholder fingerprint probe failed — detection disabled this run', { error: String(e) });
    return null;
  }
}

export interface FetchedImage { buffer: ArrayBuffer; contentType: string; status: number }

/**
 * Fetches image bytes from a URL. Returns:
 *  - the image on success,
 *  - the sentinel `'placeholder'` when the bytes ARE a Scrydex card-back (matched
 *    against the static PLACEHOLDER_IMAGE_HASHES set OR this run's live probe hash) —
 *    so the caller can trigger the TCGplayer fallback/repair,
 *  - `null` on any non-2xx, network error, or sub-floor body (a genuine miss).
 * The placeholder check hashes the bytes ONCE, so format/size are irrelevant.
 */
export async function fetchImage(
  url: string,
  placeholderHash: string | null = null,
): Promise<FetchedImage | 'placeholder' | null> {
  try {
    const res = await fetch(url, {
      headers: {
        // TCGPlayer CDN uses hotlink protection that checks Referer.
        // Scrydex is fine without it, but the header doesn't hurt either.
        'Referer':    'https://www.tcgplayer.com/',
        'User-Agent': 'Mozilla/5.0 (compatible; SleevedPages/1.0)',
      },
    });
    if (!res.ok) {
      // 404 is expected (card simply isn't on the CDN); anything else is worth flagging.
      if (res.status === 404) {
        logger.debug('Image not found', { url, status: res.status });
      } else {
        logger.warn('Image fetch non-2xx', { url, status: res.status });
      }
      return null;
    }
    const contentType = res.headers.get('content-type') ?? 'image/jpeg';
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength < MIN_IMAGE_BYTES) {
      logger.debug('Image body below sanity floor', { url, bytes: buffer.byteLength });
      return null;
    }
    // Placeholder detection (IMG-10 + Step-0 card-back fix): the static
    // PLACEHOLDER_IMAGE_HASHES set (known card-backs, incl. historical R2 bytes) plus
    // this run's live probe fingerprint. A hit is a KNOWN card-back, byte-for-byte,
    // whatever its size or format.
    if (await isPlaceholderImage(buffer, placeholderHash ? [placeholderHash] : null)) {
      logger.debug('Image is a Scrydex card-back placeholder (hash match)', { url });
      return 'placeholder';
    }
    return { buffer, contentType, status: res.status };
  } catch (e) {
    logger.warn('Image fetch network error', { url, error: String(e) });
    return null;
  }
}

/** Derives file extension from content-type header. */
function extFromContentType(ct: string): string {
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('gif')) return 'gif';
  return 'jpg';
}

export interface MirrorOutcome {
  outcome: 'scrydex' | 'tcgplayer' | 'failed' | 'skipped';
  error?: string;             // first meaningful error for this card (feeds the run's first_error)
  placeholder?: boolean;      // a Scrydex card-back placeholder was detected + handled
  tcgplayerFallback?: boolean;// the source_url was repaired to the reconstructed TCGplayer CDN url
}

/**
 * Card-back fallback (Step-0 fix). A Scrydex placeholder was detected for this card.
 * Reconstruct the correct TCGplayer image and (a) opportunistically try to mirror it
 * into R2 — usually 403s from a worker datacenter IP (tcgplayer-cdn blocks them; see
 * CLAUDE.md), succeeds only from non-datacenter contexts; and regardless (b) repair
 * source_url to the TCGplayer CDN url with r2_url/mirrored_at cleared, so the app
 * serves the real art directly from the CDN via `r2_url ?? source_url`. NEVER stamps
 * mirrored_at on a placeholder. Returns 'tcgplayer' when the mirror landed, else
 * 'skipped' with the repair applied.
 */
async function tcgplayerPlaceholderFallback(
  card: CardRow,
  bucket: R2Bucket,
  db: D1Database,
  placeholderHash: string | null,
): Promise<MirrorOutcome> {
  const tcgUrl = tcgplayerFullImageUrl(card.tcgplayer_product_id);
  if (!tcgUrl) {
    logger.debug('Scrydex placeholder but no tcgplayer id to repair', {
      id: card.tcgplayer_product_id, number: card.card_number, set: card.set_name,
    });
    return { outcome: 'skipped', placeholder: true, error: 'scrydex placeholder; no tcgplayer fallback id' };
  }

  const fetched = await fetchImage(tcgUrl, placeholderHash);
  if (fetched && fetched !== 'placeholder') {
    // Non-datacenter context (e.g. local mirror): the real TCGplayer art fetched.
    const ext = extFromContentType(fetched.contentType);
    const key = `cards/${card.tcgplayer_product_id}.${ext}`;
    try {
      await bucket.put(key, fetched.buffer, {
        httpMetadata: { contentType: fetched.contentType, cacheControl: 'public, max-age=31536000' },
      });
      const r2Url = `${R2_PUBLIC_BASE}/${key}`;
      await writeR2Image(db, card.tcgplayer_product_id, r2Url, 'tcgplayer');
      // Point source_url at the TCGplayer CDN too (r2_url already wins in serving).
      await forceSourceUrlUpsert(db, card.tcgplayer_product_id, tcgUrl).run();
      return { outcome: 'tcgplayer', placeholder: true, tcgplayerFallback: true };
    } catch (e) {
      logger.warn('R2 put failed (tcgplayer fallback)', { key, error: String(e) });
      // fall through to the source_url-only repair
    }
  }

  // Expected worker path: tcgplayer-cdn 403s the worker → repair source_url so the app
  // serves the real art from the CDN; leave r2_url NULL, never stamp mirrored_at.
  await placeholderRepairUpsert(db, card.tcgplayer_product_id, tcgUrl).run();
  return { outcome: 'skipped', placeholder: true, tcgplayerFallback: true };
}

/** Processes a single card: fetches image and stores in R2.
 *  When sourceImageUrl is provided it is used directly as the mirror source (variant backfill path),
 *  skipping both the Pokémon Scrydex CDN attempt and the source_url lookup.
 *  Outcomes: mirrored via 'scrydex'/'tcgplayer' · 'failed' (attempted, no image landed) ·
 *  'skipped' (no viable source URL — nothing was attempted). */
async function mirrorCard(
  card: CardRow,
  bucket: R2Bucket,
  db: D1Database,
  opts: { sourceImageUrl?: string; placeholderHash?: string | null } = {},
): Promise<MirrorOutcome> {
  const placeholderHash = opts.placeholderHash ?? null;

  // Fast path: caller supplies a specific source URL (e.g. per-variant Scrydex CDN URL)
  if (opts.sourceImageUrl) {
    const fetched = await fetchImage(opts.sourceImageUrl, placeholderHash);
    if (fetched === 'placeholder') return tcgplayerPlaceholderFallback(card, bucket, db, placeholderHash);
    if (!fetched) return { outcome: 'failed', error: `fetch failed: ${opts.sourceImageUrl}` };
    const ext = extFromContentType(fetched.contentType);
    const key = `cards/${card.tcgplayer_product_id}.${ext}`;
    try {
      await bucket.put(key, fetched.buffer, {
        httpMetadata: { contentType: fetched.contentType, cacheControl: 'public, max-age=31536000' },
      });
      const r2Url = `${R2_PUBLIC_BASE}/${key}`;
      await writeR2Image(db, card.tcgplayer_product_id, r2Url, 'scrydex');
      return { outcome: 'scrydex' };
    } catch (e) {
      logger.warn('R2 put failed (variant source URL)', { key, error: String(e) });
      return { outcome: 'failed', error: `R2 put failed: ${String(e)}` };
    }
  }

  const isPoke = isEnglishPokemon(card.category_name);
  let firstError: string | undefined;

  // Attempt 1: constructed Scrydex CDN URL (English Pokémon only)
  //  - Tries scrydex_set_id first, then falls back to set-name lookup
  if (isPoke && card.card_number) {
    const scrydexUrl = card.scrydex_set_id
      ? buildScrydexImageUrl(card.scrydex_set_id, card.card_number)
      : (card.set_name ? buildScrydexImageUrlFromSetName(card.set_name, card.card_number) : null);

    if (scrydexUrl) {
      const fetched = await fetchImage(scrydexUrl, placeholderHash);
      // The constructed Scrydex CDN url returned the card-back placeholder (the
      // Celebrations: Classic Collection case) — repair to the TCGplayer image
      // instead of mirroring a card-back.
      if (fetched === 'placeholder') return tcgplayerPlaceholderFallback(card, bucket, db, placeholderHash);
      if (fetched) {
        const ext = extFromContentType(fetched.contentType);
        const key = `cards/${card.tcgplayer_product_id}.${ext}`;
        try {
          await bucket.put(key, fetched.buffer, {
            httpMetadata: {
              contentType: fetched.contentType,
              cacheControl: 'public, max-age=31536000',
            },
          });
          const r2Url = `${R2_PUBLIC_BASE}/${key}`;
          await writeR2Image(db, card.tcgplayer_product_id, r2Url, 'scrydex');
          return { outcome: 'scrydex' };
        } catch (e) {
          logger.warn('R2 put failed (scrydex)', { key, error: String(e) });
          firstError ??= `R2 put failed: ${String(e)}`;
          // fall through to the stored source_url
        }
      } else {
        firstError ??= `scrydex fetch failed: ${scrydexUrl}`;
      }
    }
  }

  // Attempt 2: the stored source_url — but NEVER a TCGPlayer-CDN url from the
  // worker: the CDN 403s datacenter IPs, and TCGPlayer images are deliberately
  // not mirrored to R2 anyway (watermarked alts — Ingestion/CLAUDE.md). The
  // candidate query excludes tcgplayer-only rows; this guard keeps a stray one
  // from burning a fetch.
  const imageUrl = card.image_url && !isTcgplayerCdnUrl(card.image_url) ? card.image_url : null;

  if (!imageUrl) {
    if (firstError) return { outcome: 'failed', error: firstError };
    logger.debug('No mirrorable source image URL', {
      id:     card.tcgplayer_product_id,
      number: card.card_number,
      set:    card.set_name,
    });
    return { outcome: 'skipped' };
  }

  const fetched = await fetchImage(imageUrl, placeholderHash);
  if (fetched === 'placeholder') {
    // The stored Scrydex source_url is a card-back — repair to TCGplayer art.
    return tcgplayerPlaceholderFallback(card, bucket, db, placeholderHash);
  }
  if (!fetched) {
    // URL + status already logged inside fetchImage
    return { outcome: 'failed', error: firstError ?? `fetch failed: ${imageUrl}` };
  }

  const ext = extFromContentType(fetched.contentType);
  const key = `cards/${card.tcgplayer_product_id}.${ext}`;
  const source: 'scrydex' | 'tcgplayer' = isScrydexImageUrl(imageUrl) ? 'scrydex' : 'tcgplayer';

  try {
    await bucket.put(key, fetched.buffer, {
      httpMetadata: {
        contentType: fetched.contentType,
        cacheControl: 'public, max-age=31536000',
      },
    });
  } catch (e) {
    logger.warn('R2 put failed (source_url)', { key, error: String(e) });
    return { outcome: 'failed', error: `R2 put failed: ${String(e)}` };
  }

  const r2Url = `${R2_PUBLIC_BASE}/${key}`;
  await writeR2Image(db, card.tcgplayer_product_id, r2Url, source);

  return { outcome: source };
}

// ─── Local-mirror support ────────────────────────────────────────────────────
// Used by the GET /mirror/pending and POST /mirror/upload Worker endpoints,
// which exist so mirror-local.mjs can fetch images from a non-datacenter IP
// and hand the bytes back to the Worker to write into R2.

export interface PendingCardRow {
  tcgplayer_product_id: number;
  image_url:            string | null;
  card_number:          string | null;
  set_name:             string | null;
  scrydex_set_id:       string | null;
  category_name:        string | null;
}

/** Returns the next `limit` cards that still need mirroring.
 *  Pass `scrydexOnly = true` to restrict to Pokémon cards with a Scrydex set
 *  mapping — useful to prioritise high-res images before TCGPlayer fallbacks. */
export async function getPendingCards(
  db: D1Database,
  limit = 50,
  scrydexOnly = false,
): Promise<PendingCardRow[]> {
  // WP-2: shares mirrorCandidateWhere() with runMirrorJob — eligibility (never
  // mirrored / tcgplayer-upgrade; OP/Gundam CDN-as-final stays excluded),
  // mirrorability (Scrydex source_url or English-Pokémon construction; never
  // tcgplayer-cdn-only), attempt ceiling + backoff. The local script's successes
  // shrink the pool, so a plain LIMIT (no OFFSET) always makes progress.
  const extra = scrydexOnly
    ? `AND s.scrydex_expansion_id IS NOT NULL
       AND LOWER(REPLACE(g.name, 'é', 'e')) LIKE '%pokemon%'
       AND LOWER(g.name) NOT LIKE '%japan%'`
    : '';

  const { results } = await db.prepare(`
    SELECT
      p.tcgplayer_product_id,
      pi.source_url           AS image_url,
      p.number                AS card_number,
      s.name                  AS set_name,
      s.scrydex_expansion_id  AS scrydex_set_id,
      g.name                  AS category_name
    FROM  products        p
    JOIN  sets            s ON s.id = p.set_id
    JOIN  canonical_games g ON g.id = s.game_id
    LEFT JOIN product_images pi ON pi.product_id = p.id
    WHERE ${mirrorCandidateWhere()}
      ${extra}
    ORDER BY p.id
    LIMIT ?
  `).bind(limit).all<PendingCardRow>();
  return results ?? [];
}

/**
 * Writes pre-fetched image bytes to R2 and updates tcg_products.
 * Called by the POST /mirror/upload endpoint after the local script
 * has fetched the bytes from its non-datacenter IP.
 */
export async function uploadCardImage(
  env:         MirrorEnv,
  productId:   number,
  buffer:      ArrayBuffer,
  contentType: string,
  source:      'scrydex' | 'tcgplayer',
): Promise<string> {
  const ext = extFromContentType(contentType);
  const key = `cards/${productId}.${ext}`;
  await env.IMAGES_BUCKET.put(key, buffer, {
    httpMetadata: {
      contentType,
      cacheControl: 'public, max-age=31536000',
    },
  });
  const r2Url = `${R2_PUBLIC_BASE}/${key}`;
  await writeR2Image(env.DB, productId, r2Url, source);
  return r2Url;
}

export interface MirrorJobResult {
  processed: number;
  mirrored: number;
  failed: number;
  skipped: number;
  scrydex_hits: number;
  tcgplayer_hits: number;
  placeholder_skips: number;    // Scrydex card-backs detected + rejected this run
  tcgplayer_fallbacks: number;  // rows whose source_url was repaired to the TCGplayer CDN
  duration_ms: number;
  has_more: boolean;          // true if more cards remain after this invocation's limit
  first_error: string | null; // first error seen this run (also persisted to image_mirror_log)
}

export async function runMirrorJob(
  env: MirrorEnv,
  maxBatches = 1   // 1 for HTTP requests (fast response); Infinity for cron (run until done)
): Promise<MirrorJobResult> {
  const start = Date.now();
  const stats: MirrorStats = { processed: 0, mirrored: 0, failed: 0, skipped: 0, scrydex_hits: 0, tcgplayer_hits: 0, placeholder_skips: 0, tcgplayer_fallbacks: 0 };
  let firstError: string | null = null;
  let has_more = false;

  logger.info('Image mirror job started', { maxBatches });

  // WP-2 (audit IMG-1): the WHOLE run body is try/finally'd — the summary row is
  // written to image_mirror_log even if the run dies mid-batch (the 2026-07-05
  // failure mode was a run that died leaving no log row at all).
  try {
    // Calibrate the placeholder fingerprint once per run (IMG-10).
    const placeholderHash = await fetchPlaceholderHash();

    // Keyset pagination (IMG-4): never OFFSET. Attempted rows get their backoff
    // bumped, so each run naturally starts past last run's attempts and the cron
    // makes forward progress through the pool within its ~25s budget.
    let lastRowId = 0;
    let batchCount = 0;

    while (true) {
      const { results: batch } = await env.DB.prepare(`
        SELECT
          p.id                    AS product_row_id,
          p.tcgplayer_product_id,
          pi.source_url           AS image_url,
          p.number                AS card_number,
          pi.source               AS image_source,
          s.name                  AS set_name,
          s.scrydex_expansion_id  AS scrydex_set_id,
          g.name                  AS category_name
        FROM  products        p
        JOIN  sets            s ON s.id = p.set_id
        JOIN  canonical_games g ON g.id = s.game_id
        LEFT JOIN product_images pi ON pi.product_id = p.id
        WHERE ${mirrorCandidateWhere()}
          AND p.id > ?
        ORDER BY p.id
        LIMIT ${BATCH_SIZE}
      `).bind(lastRowId).all<CardRow>();

      if (!batch || batch.length === 0) break;

      // Process cards concurrently in chunks of CONCURRENCY.
      // 10 parallel fetches × ~200ms each ≈ 1s per chunk, 5 chunks = ~5s total.
      // Keeps well within the 30s Worker wall-clock limit.
      for (let i = 0; i < batch.length; i += CONCURRENCY) {
        const chunk = batch.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          chunk.map(card => mirrorCard(card, env.IMAGES_BUCKET, env.DB, { placeholderHash }))
        );
        for (const result of results) {
          stats.processed++;
          if (result.outcome === 'failed') stats.failed++;
          else if (result.outcome === 'skipped') stats.skipped++;
          else {
            stats.mirrored++;
            if (result.outcome === 'scrydex') stats.scrydex_hits++;
            else stats.tcgplayer_hits++;
          }
          // Card-back observability (Step-0 fix): count every placeholder detection
          // and every source_url repair. These surface in the structured run-summary
          // log line + the returned result (image_mirror_log has no column for them —
          // no migration this session).
          if (result.placeholder) stats.placeholder_skips++;
          if (result.tcgplayerFallback) stats.tcgplayer_fallbacks++;
          if (result.error) firstError ??= result.error;
        }
        // Attempt bookkeeping for every processed card (success, fail, AND skip —
        // a skip re-selected forever is exactly the IMG-4 poison-pool bug). Written
        // per chunk so an early death loses at most CONCURRENCY rows of bookkeeping.
        const attemptedAt = new Date().toISOString();
        await env.DB.batch(
          chunk.map(card => mirrorAttemptUpsert(env.DB, card.tcgplayer_product_id, attemptedAt))
        );
      }

      batchCount++;
      lastRowId = batch[batch.length - 1].product_row_id;
      has_more = batch.length === BATCH_SIZE;

      if (stats.failed > 0) {
        logger.info('Mirror batch complete', {
          batch:    batchCount,
          processed: stats.processed,
          mirrored:  stats.mirrored,
          failed:    stats.failed,
          skipped:   stats.skipped,
        });
      }

      // Stop if this was the last page
      if (!has_more) break;

      // Stop if we've hit the caller's batch cap (HTTP path: maxBatches=1)
      if (batchCount >= maxBatches) break;

      // Stop if we're approaching the Worker wall-clock limit (cron path)
      if (Date.now() - start >= WALL_CLOCK_LIMIT) {
        has_more = true;
        break;
      }
    }
  } catch (e) {
    firstError ??= String(e);
    logger.error('Image mirror job died mid-run', { error: String(e), ...stats });
  } finally {
    const duration_ms = Date.now() - start;
    logger.info('Image mirror job complete', { ...stats, has_more, first_error: firstError });
    // The per-run summary row — written even on early death. Guarded so a
    // log-write failure never masks the run's own error.
    try {
      await env.DB.prepare(`
        INSERT INTO image_mirror_log (processed, mirrored, failed, skipped, scrydex_hits, tcgplayer_hits, duration_ms, first_error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        stats.processed,
        stats.mirrored,
        stats.failed,
        stats.skipped,
        stats.scrydex_hits,
        stats.tcgplayer_hits,
        duration_ms,
        firstError,
      ).run();
    } catch (logErr) {
      logger.error('image_mirror_log write failed', { error: String(logErr) });
    }
  }

  return { ...stats, duration_ms: Date.now() - start, has_more, first_error: firstError };
}
