/**
 * purgePlaceholderMirrors.ts — cleanup sweep for card-back placeholders in R2.
 *
 * The Step-0 fix stops NEW card-backs (mirror guard + source_url precedence), but
 * placeholders already mirrored into R2 keep winning via `r2_url ?? source_url`. This
 * bounded, cursor-based sweep hashes each existing R2 object and, on a placeholder
 * match (static PLACEHOLDER_IMAGE_HASHES), deletes the R2 object and repairs the row:
 *   - source_url → the reconstructed TCGplayer CDN image (from tcgplayer_product_id),
 *   - r2_url / mirrored_at → NULL, source → NULL (a plain TCGCSV-style source_url row).
 * The next mirror cron then re-checks the row; the Part-1 guard keeps it from
 * regressing to a card-back, and the app immediately serves the real TCGplayer art
 * from the CDN. Data changes are regenerable — never destructive.
 *
 * ONE batch per invocation (keyset by products.id), returning
 * { scanned, purged, repaired, remaining, hasMore, cursorNext } so the admin panel
 * loops until hasMore is false (same shape as the FETCH/PROCESS + bulk-enrich loops).
 * Reads bytes straight from the R2 bucket (no external fetch → no tcgplayer-cdn 403,
 * no worker-IP block); hashing is the authoritative placeholder test.
 */

import { isPlaceholderImage, tcgplayerFullImageUrl } from './lib/placeholderImages.js';
import { placeholderRepairUpsert } from './lib/productImages.js';
import { logger } from './ingestion/logger.js';

export interface MirrorEnv2 {
  DB: D1Database;
  IMAGES_BUCKET: R2Bucket;
}

export interface PurgeResult {
  scanned: number;    // r2-bearing rows examined this batch
  purged: number;     // R2 objects deleted (confirmed card-backs)
  repaired: number;   // rows whose source_url was repaired to the TCGplayer CDN
  remaining: number;  // r2-bearing rows still to scan past this batch's cursor
  hasMore: boolean;   // more rows to scan (drives the admin loop)
  cursorNext: number; // pass back as `cursor` for the next batch
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 300;      // one batch of R2 reads + hashes; keep under the subrequest budget
const READ_CONCURRENCY = 10;
const REPAIR_BATCH = 90;    // D1 bound-param cap

interface Row {
  product_id: number;
  tcgplayer_product_id: number;
  r2_url: string;
}

/** Derive the R2 object key from a public r2_url (e.g. .../cards/250321.png → cards/250321.png). */
export function r2KeyFromUrl(r2Url: string): string | null {
  try {
    return new URL(r2Url).pathname.replace(/^\/+/, '') || null;
  } catch {
    return null;
  }
}

/**
 * Run ONE purge batch. `cursor` is the last products.id scanned by the previous batch
 * (0 to start). Bounded by `limit` rows.
 */
export async function purgePlaceholderMirrors(
  env: MirrorEnv2,
  opts: { cursor?: number; limit?: number } = {},
): Promise<PurgeResult> {
  const cursor = Math.max(0, Math.floor(opts.cursor ?? 0));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)));

  const { results } = await env.DB.prepare(`
    SELECT p.id                    AS product_id,
           p.tcgplayer_product_id  AS tcgplayer_product_id,
           pi.r2_url               AS r2_url
    FROM   product_images pi
    JOIN   products p ON p.id = pi.product_id
    WHERE  pi.r2_url IS NOT NULL
      AND  p.id > ?
    ORDER BY p.id
    LIMIT ${limit}
  `).bind(cursor).all<Row>();

  const rows = results ?? [];
  let scanned = 0;
  let purged = 0;
  const repairStmts: D1PreparedStatement[] = [];
  const deleteKeys: string[] = [];

  // Read + hash each R2 object with bounded concurrency.
  for (let i = 0; i < rows.length; i += READ_CONCURRENCY) {
    const chunk = rows.slice(i, i + READ_CONCURRENCY);
    const verdicts = await Promise.all(chunk.map(async (row) => {
      scanned++;
      const key = r2KeyFromUrl(row.r2_url);
      if (!key) return null;
      try {
        const obj = await env.IMAGES_BUCKET.get(key);
        if (!obj) return null;   // dangling r2_url — not our concern here
        const buffer = await obj.arrayBuffer();
        if (!(await isPlaceholderImage(buffer))) return null;
        return { row, key };
      } catch (e) {
        logger.warn('purge: R2 read/hash failed', { key, error: String(e) });
        return null;
      }
    }));

    for (const v of verdicts) {
      if (!v) continue;
      const tcgUrl = tcgplayerFullImageUrl(v.row.tcgplayer_product_id);
      if (!tcgUrl) {
        // No id to reconstruct — leave the row (can't repair to a real url safely).
        logger.warn('purge: placeholder with no tcgplayer id — left in place', { productId: v.row.product_id });
        continue;
      }
      deleteKeys.push(v.key);
      repairStmts.push(placeholderRepairUpsert(env.DB, v.row.tcgplayer_product_id, tcgUrl));
      purged++;
    }
  }

  // Repair rows first (D1-batched ≤90), THEN delete the R2 objects. Ordering so a
  // crash between the two leaves a repaired row pointing at TCGplayer (correct) with
  // a stale-but-harmless R2 object — never a nulled r2_url with the card-back still
  // "live". Re-running the sweep is idempotent (the object is gone / re-repaired).
  for (let i = 0; i < repairStmts.length; i += REPAIR_BATCH) {
    await env.DB.batch(repairStmts.slice(i, i + REPAIR_BATCH));
  }
  await Promise.all(deleteKeys.map((k) =>
    env.IMAGES_BUCKET.delete(k).catch((e) => logger.warn('purge: R2 delete failed', { key: k, error: String(e) }))
  ));

  const cursorNext = rows.length > 0 ? rows[rows.length - 1].product_id : cursor;
  const hasMore = rows.length === limit;

  // Count r2-bearing rows still to scan (informational; the loop uses hasMore).
  const rem = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM product_images WHERE r2_url IS NOT NULL AND product_id > ?`
  ).bind(cursorNext).first<{ n: number }>();
  const remaining = rem?.n ?? 0;

  logger.info('purge-placeholder-mirrors batch', { scanned, purged, remaining, cursorNext, hasMore });

  return { scanned, purged, repaired: purged, remaining, hasMore, cursorNext };
}
