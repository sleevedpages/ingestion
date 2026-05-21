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

const BATCH_SIZE  = 50;   // cards per DB page
const MAX_BATCHES = 8;    // max pages per invocation (~400 cards) — stays within Worker CPU + subrequest limits
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
  const normalised = categoryName
    .toLowerCase()
    .replace(/é/g, 'e')  // é
    .replace(/É/g, 'e'); // É
  return normalised.includes('pokemon');
}

/** Fetches image bytes from a URL. Returns null on any non-2xx or network error. */
async function fetchImage(url: string): Promise<{ buffer: ArrayBuffer; contentType: string } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? 'image/jpeg';
    const buffer = await res.arrayBuffer();
    return { buffer, contentType };
  } catch {
    return null;
  }
}

/** Derives file extension from content-type header. */
function extFromContentType(ct: string): string {
  if (ct.includes('png'))  return 'png';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('gif'))  return 'gif';
  return 'jpg';
}

/** Processes a single card: fetches image and stores in R2. Returns source used. */
async function mirrorCard(
  card: CardRow,
  bucket: R2Bucket,
  db: D1Database
): Promise<'skrydex' | 'tcgplayer' | 'failed'> {
  const isPoke = isPokemon(card.category_name);

  let imageUrl: string | null = null;
  let source: 'skrydex' | 'tcgplayer' | null = null;

  // Attempt 1: Skrydex (Pokémon only)
  // buildSkrydexImageUrl / buildSkrydexImageUrlFromSetName both call
  // formatSkrydexCardNumber internally, which strips "/165" suffixes,
  // leading zeros, and handles gallery prefixes (TG, GG, etc.).
  if (isPoke && card.card_number) {
    const skrydexUrl = card.skrydex_set_id
      ? buildSkrydexImageUrl(card.skrydex_set_id, card.card_number)
      : (card.set_name ? buildSkrydexImageUrlFromSetName(card.set_name, card.card_number) : null);

    if (skrydexUrl) {
      const fetched = await fetchImage(skrydexUrl);
      if (fetched) {
        // Store result and skip straight to R2 upload
        const ext = extFromContentType(fetched.contentType);
        const key = `cards/${card.tcgplayer_product_id}.${ext}`;
        try {
          await bucket.put(key, fetched.buffer, {
            httpMetadata: {
              contentType: fetched.contentType,
              cacheControl: 'public, max-age=31536000, immutable',
            },
          });
          const r2Url = `${R2_PUBLIC_BASE}/cards/${card.tcgplayer_product_id}.${ext}`;
          await db.prepare(
            `UPDATE tcg_products SET image_url = ?, image_source = 'skrydex' WHERE tcgplayer_product_id = ?`
          ).bind(r2Url, card.tcgplayer_product_id).run();
          return 'skrydex';
        } catch (e) {
          logger.warn('R2 put failed (skrydex)', { key, error: String(e) });
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

  if (!imageUrl || !source) return 'failed';

  // Fetch actual bytes
  const fetched = await fetchImage(imageUrl);
  if (!fetched) return 'failed';

  const ext = extFromContentType(fetched.contentType);
  const key = `cards/${card.tcgplayer_product_id}.${ext}`;

  try {
    await bucket.put(key, fetched.buffer, {
      httpMetadata: {
        contentType: fetched.contentType,
        cacheControl: 'public, max-age=31536000, immutable',
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

export interface MirrorJobResult {
  processed: number;
  mirrored: number;
  failed: number;
  skrydex_hits: number;
  tcgplayer_hits: number;
  duration_ms: number;
  has_more: boolean;  // true if more cards remain after this invocation's limit
}

export async function runMirrorJob(env: MirrorEnv): Promise<MirrorJobResult> {
  const start = Date.now();
  const stats: MirrorStats = { processed: 0, mirrored: 0, failed: 0, skrydex_hits: 0, tcgplayer_hits: 0 };

  logger.info('Image mirror job started');

  let offset = 0;
  let batchesRun = 0;
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

    for (const card of batch) {
      stats.processed++;
      const result = await mirrorCard(card, env.IMAGES_BUCKET, env.DB);

      if (result === 'failed') {
        stats.failed++;
      } else {
        stats.mirrored++;
        if (result === 'skrydex') stats.skrydex_hits++;
        else stats.tcgplayer_hits++;
      }
    }

    batchesRun++;
    offset += batch.length;

    if (batch.length < BATCH_SIZE) break;  // last page — no more cards

    if (batchesRun >= MAX_BATCHES) {
      has_more = true;  // hit the per-invocation cap — more cards remain
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
