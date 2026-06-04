/**
 * image-mirror.ts
 *
 * Mirrors card images into R2:
 *  - Pokémon cards: tries Skrydex CDN first (free, high-res), falls back to TCGPlayer
 *  - All other games: uses TCGPlayer image_url directly
 *
 * Stores images at: cards/{tcgplayer_product_id}.{ext}
 * Updates tcg_products.image_url to the R2 public URL.
 * Logs totals to image_mirror_log.
 *
 * Called by:
 *  - Scheduled cron: Sunday 3 AM UTC
 *  - HTTP POST /mirror for manual trigger
 */

import { buildSkrydexImageUrl, buildSkrydexImageUrlFromSetName } from './lib/skrydexUrl.js';
import { logger } from './ingestion/logger.js';

const BATCH_SIZE = 100;     // cards fetched from DB per invocation
const CONCURRENCY = 10;     // cards processed in parallel within each batch
const WALL_CLOCK_LIMIT = 25_000; // stop looping at 25s to stay inside the 30s Worker limit
const R2_PUBLIC_BASE = 'https://images.sleevedpages.com';

export interface MirrorEnv {
  DB: D1Database;
  IMAGES_BUCKET: R2Bucket;
}

interface CardRow {
  tcgplayer_product_id: number;
  image_url: string | null;
  image_source: string | null;
  card_number: string | null;
  set_name: string | null;
  skrydex_set_id: string | null;
  category_name: string | null;
}

interface MirrorStats {
  processed: number;
  mirrored: number;
  failed: number;
  skrydex_hits: number;
  tcgplayer_hits: number;
}

/** Returns true if the category name is Pokémon (accent-normalized comparison). */
function isPokemon(categoryName: string | null): boolean {
  if (!categoryName) return false;
  return categoryName.toLowerCase().replace(/é/g, 'e').replace(/É/g, 'e').includes('pokemon');
}


/** Fetches image bytes from a URL. Returns null on any non-2xx or network error. */
async function fetchImage(url: string): Promise<{ buffer: ArrayBuffer; contentType: string; status: number } | null> {
  try {
    const res = await fetch(url, {
      headers: {
        // TCGPlayer CDN uses hotlink protection that checks Referer.
        // Skrydex is fine without it, but the header doesn't hurt either.
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
    // Guard against Scrydex placeholder images (card back returned for unknown URLs).
    // The placeholder is ~181 KB; real card scans should be larger.
    // Threshold set to 300 KB — placeholder is ~181 KB, real cards are ~400 KB+.
    if (buffer.byteLength < 300_000) {
      logger.debug('Image too small — likely Scrydex placeholder', { url, bytes: buffer.byteLength });
      return null;
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

/** Processes a single card: fetches image and stores in R2. Returns source used.
 *  When sourceImageUrl is provided it is used directly as the mirror source (variant backfill path),
 *  skipping both the Pokémon Skrydex CDN attempt and the tcg_products.image_url lookup. */
async function mirrorCard(
  card: CardRow,
  bucket: R2Bucket,
  db: D1Database,
  sourceImageUrl?: string
): Promise<'skrydex' | 'tcgplayer' | 'failed'> {
  // Fast path: caller supplies a specific source URL (e.g. per-variant Scrydex CDN URL)
  if (sourceImageUrl) {
    const fetched = await fetchImage(sourceImageUrl);
    if (!fetched) return 'failed';
    const ext = extFromContentType(fetched.contentType);
    const key = `cards/${card.tcgplayer_product_id}.${ext}`;
    try {
      await bucket.put(key, fetched.buffer, {
        httpMetadata: { contentType: fetched.contentType, cacheControl: 'public, max-age=31536000' },
      });
      const r2Url = `${R2_PUBLIC_BASE}/${key}`;
      await db.prepare(
        `UPDATE tcg_products SET image_url = ?, image_source = 'skrydex' WHERE tcgplayer_product_id = ?`
      ).bind(r2Url, card.tcgplayer_product_id).run();
      return 'skrydex';
    } catch (e) {
      logger.warn('R2 put failed (variant source URL)', { key, error: String(e) });
      return 'failed';
    }
  }

  const isPoke = isPokemon(card.category_name);

  let imageUrl: string | null = null;
  let source: 'skrydex' | 'tcgplayer' | null = null;

  // Attempt 1: Skrydex CDN (Pokémon only)
  //  - Tries skrydex_set_id first, then falls back to set-name lookup
  if (isPoke && card.card_number) {
    let scrydexUrl: string | null = null;

    scrydexUrl = card.skrydex_set_id
      ? buildSkrydexImageUrl(card.skrydex_set_id, card.card_number)
      : (card.set_name ? buildSkrydexImageUrlFromSetName(card.set_name, card.card_number) : null);

    if (scrydexUrl) {
      const fetched = await fetchImage(scrydexUrl);
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
          const r2Url = `${R2_PUBLIC_BASE}/cards/${card.tcgplayer_product_id}.${ext}`;
          await db.prepare(
            `UPDATE tcg_products SET image_url = ?, image_source = 'skrydex' WHERE tcgplayer_product_id = ?`
          ).bind(r2Url, card.tcgplayer_product_id).run();
          return 'skrydex';
        } catch (e) {
          logger.warn('R2 put failed (scrydex)', { key, error: String(e) });
          // fall through to TCGPlayer
        }
      }
    }
  }

  // Attempt 2: TCGPlayer original URL
  if (card.image_url) {
    imageUrl = card.image_url;
    source = 'tcgplayer';
  }

  if (!imageUrl || !source) {
    logger.debug('No source image URL', {
      id:     card.tcgplayer_product_id,
      number: card.card_number,
      set:    card.set_name,
    });
    return 'failed';
  }

  // Fetch actual bytes
  const fetched = await fetchImage(imageUrl);
  if (!fetched) {
    // URL + status already logged inside fetchImage
    logger.debug('TCGPlayer fetch returned null', {
      id:  card.tcgplayer_product_id,
      url: imageUrl,
    });
    return 'failed';
  }

  const ext = extFromContentType(fetched.contentType);
  const key = `cards/${card.tcgplayer_product_id}.${ext}`;

  try {
    await bucket.put(key, fetched.buffer, {
      httpMetadata: {
        contentType: fetched.contentType,
        cacheControl: 'public, max-age=31536000',
      },
    });
  } catch (e) {
    logger.warn('R2 put failed (tcgplayer)', { key, error: String(e) });
    return 'failed';
  }

  const r2Url = `${R2_PUBLIC_BASE}/${key}`;
  await db.prepare(
    `UPDATE tcg_products SET image_url = ?, image_source = 'tcgplayer' WHERE tcgplayer_product_id = ?`
  ).bind(r2Url, card.tcgplayer_product_id).run();

  return source;
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
  skrydex_set_id:       string | null;
  category_name:        string | null;
}

/** Returns the next `limit` cards that still need mirroring.
 *  Pass `skrydexOnly = true` to restrict to Pokémon cards with a Skrydex set
 *  mapping — useful to prioritise high-res images before TCGPlayer fallbacks. */
export async function getPendingCards(
  db: D1Database,
  limit = 50,
  skrydexOnly = false,
): Promise<PendingCardRow[]> {
  const extra = skrydexOnly
    ? `AND s.skrydex_set_id IS NOT NULL
       AND LOWER(REPLACE(c.name, 'é', 'e')) LIKE '%pokemon%'`
    : '';

  const { results } = await db.prepare(`
    SELECT
      p.tcgplayer_product_id,
      p.image_url,
      p.card_number,
      s.name          AS set_name,
      s.skrydex_set_id,
      c.name          AS category_name
    FROM  tcg_products    p
    JOIN  tcg_sets        s ON s.tcgplayer_group_id    = p.tcgplayer_group_id
    JOIN  tcg_categories  c ON c.tcgplayer_category_id = s.tcgplayer_category_id
    WHERE p.card_number IS NOT NULL
      AND (
        p.image_source IS NULL
        OR (p.image_source = 'tcgplayer' AND s.skrydex_set_id IS NOT NULL)
      )
      ${extra}
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
  source:      'skrydex' | 'tcgplayer',
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
  await env.DB.prepare(
    `UPDATE tcg_products SET image_url = ?, image_source = ? WHERE tcgplayer_product_id = ?`
  ).bind(r2Url, source, productId).run();
  return r2Url;
}

export interface MirrorJobResult {
  processed: number;
  mirrored: number;
  failed: number;
  skrydex_hits: number;
  tcgplayer_hits: number;
  duration_ms: number;
  has_more: boolean;  // true if more cards remain after this invocation's limit
}

export async function runMirrorJob(
  env: MirrorEnv,
  maxBatches = 1   // 1 for HTTP requests (fast response); Infinity for cron (run until done)
): Promise<MirrorJobResult> {
  const start = Date.now();
  const stats: MirrorStats = { processed: 0, mirrored: 0, failed: 0, skrydex_hits: 0, tcgplayer_hits: 0 };

  logger.info('Image mirror job started', { maxBatches });

  let offset = 0;
  let batchCount = 0;
  let has_more = false;

  while (true) {
    const { results: batch } = await env.DB.prepare(`
      SELECT
        p.tcgplayer_product_id,
        p.image_url,
        p.card_number,
        p.image_source,
        s.name          AS set_name,
        s.skrydex_set_id,
        c.name          AS category_name
      FROM  tcg_products    p
      JOIN  tcg_sets        s ON s.tcgplayer_group_id    = p.tcgplayer_group_id
      JOIN  tcg_categories  c ON c.tcgplayer_category_id = s.tcgplayer_category_id
      WHERE p.card_number IS NOT NULL
        AND (
          -- Never mirrored yet
          p.image_source IS NULL
          -- Previously mirrored from TCGPlayer but a Skrydex mapping is now available
          OR (p.image_source = 'tcgplayer' AND s.skrydex_set_id IS NOT NULL)
        )
      LIMIT ${BATCH_SIZE} OFFSET ?
    `).bind(offset).all<CardRow>();

    if (!batch || batch.length === 0) break;

    // Process cards concurrently in chunks of CONCURRENCY.
    // 10 parallel fetches × ~200ms each ≈ 1s per chunk, 5 chunks = ~5s total.
    // Keeps well within the 30s Worker wall-clock limit.
    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      const chunk = batch.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        chunk.map(card => mirrorCard(card, env.IMAGES_BUCKET, env.DB))
      );
      for (const result of results) {
        stats.processed++;
        if (result === 'failed') {
          stats.failed++;
        } else {
          stats.mirrored++;
          if (result === 'skrydex') stats.skrydex_hits++;
          else stats.tcgplayer_hits++;
        }
      }
    }

    batchCount++;
    offset += batch.length;
    has_more = batch.length === BATCH_SIZE;

    if (stats.failed > 0) {
      logger.info('Mirror batch complete', {
        batch:    batchCount,
        processed: stats.processed,
        mirrored:  stats.mirrored,
        failed:    stats.failed,
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

  const duration_ms = Date.now() - start;
  logger.info('Image mirror job complete', { ...stats, has_more });

  // Write log row
  await env.DB.prepare(`
    INSERT INTO image_mirror_log (processed, mirrored, failed, skrydex_hits, tcgplayer_hits, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    stats.processed,
    stats.mirrored,
    stats.failed,
    stats.skrydex_hits,
    stats.tcgplayer_hits,
    duration_ms,
  ).run();

  return { ...stats, duration_ms, has_more };
}
