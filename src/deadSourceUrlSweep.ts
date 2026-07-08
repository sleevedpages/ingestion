/**
 * deadSourceUrlSweep.ts — dead `source_url` probe sweep (audit WP-6, IMG-7).
 *
 * `product_images.source_url` is the ONLY serving path for a row with no `r2_url`
 * (the app resolves `r2_url ?? source_url ?? snapshot`) — the audit measured ~2.5% of
 * stored TCGPlayer source_urls dead upstream (403), and separately Scrydex serves its
 * card-back placeholder at HTTP 200 for cards it has no scan of (the card-back guard's
 * root cause, `lib/placeholderImages.ts`). A bare HTTP 200 is NOT proof of life for
 * either reason — every probed body is hashed and a placeholder match is treated as
 * dead, exactly like the mirror's own guard.
 *
 * Manual-trigger only (no new cron — `POST /admin/dead-url-sweep`), bounded keyset
 * batches (`products.id`, same idiom as `purgePlaceholderMirrors.ts`), so this can be
 * looped from the admin panel without ever exceeding the request budget. Scoped to rows
 * with NO `r2_url` (r2_url already wins in serving when present — checking source_url
 * liveness there would be probing something nothing reads).
 *
 * Marking, deliberately reusing EXISTING bookkeeping (no new column):
 *  - a PLAIN dead probe (non-2xx / network error / empty body) bumps
 *    `product_images.mirror_attempts` + `mirror_last_attempt_at` via the SAME
 *    `mirrorAttemptUpsert()` the mirror itself calls on every processed card — the row
 *    ages out of the mirror's candidate pool through the ordinary attempt-ceiling +
 *    backoff (Content migration 0086), same mechanism, no parallel one.
 *  - a PLACEHOLDER match repairs through the ONE existing repair path,
 *    `tcgplayerPlaceholderFallback()` (image-mirror.ts) — never a second implementation.
 */

import { isPlaceholderImage } from './lib/placeholderImages.js';
import { mirrorAttemptUpsert } from './lib/productImages.js';
import { tcgplayerPlaceholderFallback } from './image-mirror.js';
import { logger } from './ingestion/logger.js';

export interface SweepEnv {
  DB: D1Database;
  IMAGES_BUCKET: R2Bucket;
}

export interface DeadUrlSweepResult {
  scanned: number;    // source_url rows probed this batch
  alive: number;      // 2xx, non-placeholder — left untouched
  dead: number;       // non-2xx / network error / empty body — mirror_attempts bumped
  repaired: number;   // placeholder match — repaired via tcgplayerPlaceholderFallback
  remaining: number;  // r2_url-less, source_url-bearing rows still to scan past this batch's cursor
  hasMore: boolean;
  cursorNext: number; // pass back as `cursor` for the next batch
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;       // bounded batch of live HTTP probes; keep under the subrequest budget
const PROBE_CONCURRENCY = 8;

interface Row {
  product_id: number;
  tcgplayer_product_id: number;
  source_url: string;
  card_number: string | null;
  set_name: string | null;
}

type Verdict = 'alive' | 'dead' | 'placeholder';

/** Probes one source_url and hashes the body — mirrors image-mirror.ts's fetchImage
 *  headers (TCGPlayer's hotlink guard checks Referer) but returns a verdict rather than
 *  bytes, since the sweep never needs to keep the body around. */
async function probeSourceUrl(url: string): Promise<Verdict> {
  try {
    const res = await fetch(url, {
      headers: {
        'Referer': 'https://www.tcgplayer.com/',
        'User-Agent': 'Mozilla/5.0 (compatible; SleevedPages/1.0)',
      },
    });
    if (!res.ok) return 'dead';
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength === 0) return 'dead';
    if (await isPlaceholderImage(buffer)) return 'placeholder';
    return 'alive';
  } catch (e) {
    logger.warn('dead-url-sweep: probe failed', { url, error: String(e) });
    return 'dead';
  }
}

/**
 * Runs ONE bounded batch. `cursor` is the last `products.id` scanned by the previous
 * batch (0 to start). Bounded by `limit` rows.
 */
export async function sweepDeadSourceUrls(
  env: SweepEnv,
  opts: { cursor?: number; limit?: number } = {},
): Promise<DeadUrlSweepResult> {
  const cursor = Math.max(0, Math.floor(opts.cursor ?? 0));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)));

  const { results } = await env.DB.prepare(`
    SELECT p.id                    AS product_id,
           p.tcgplayer_product_id  AS tcgplayer_product_id,
           pi.source_url           AS source_url,
           p.number                AS card_number,
           s.name                  AS set_name
    FROM   product_images pi
    JOIN   products p ON p.id = pi.product_id
    JOIN   sets s      ON s.id = p.set_id
    WHERE  pi.r2_url IS NULL
      AND  pi.source_url IS NOT NULL AND pi.source_url != ''
      AND  p.id > ?
    ORDER BY p.id
    LIMIT ${limit}
  `).bind(cursor).all<Row>();

  const rows = results ?? [];
  let scanned = 0;
  let alive = 0;
  let dead = 0;
  let repaired = 0;

  for (let i = 0; i < rows.length; i += PROBE_CONCURRENCY) {
    const chunk = rows.slice(i, i + PROBE_CONCURRENCY);
    const verdicts = await Promise.all(chunk.map(async (row) => {
      scanned++;
      const verdict = await probeSourceUrl(row.source_url);
      return { row, verdict };
    }));

    for (const { row, verdict } of verdicts) {
      if (verdict === 'alive') { alive++; continue; }
      if (verdict === 'placeholder') {
        repaired++;
        // The ONE repair path (image-mirror.ts) — reconstructs the TCGplayer CDN url,
        // opportunistically tries to mirror it, and regardless repairs source_url so
        // the app stops serving the card-back. No-ops safely with no id to reconstruct.
        await tcgplayerPlaceholderFallback(row, env.IMAGES_BUCKET, env.DB, null);
        continue;
      }
      // Plain dead — mark via the EXISTING mirror bookkeeping (no new column).
      dead++;
      await mirrorAttemptUpsert(env.DB, row.tcgplayer_product_id).run();
    }
  }

  const cursorNext = rows.length > 0 ? rows[rows.length - 1].product_id : cursor;
  const hasMore = rows.length === limit;

  const rem = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM product_images
     WHERE r2_url IS NULL AND source_url IS NOT NULL AND source_url != '' AND product_id > ?`
  ).bind(cursorNext).first<{ n: number }>();
  const remaining = rem?.n ?? 0;

  logger.info('dead-url-sweep batch', { scanned, alive, dead, repaired, remaining, cursorNext, hasMore });

  return { scanned, alive, dead, repaired, remaining, hasMore, cursorNext };
}
