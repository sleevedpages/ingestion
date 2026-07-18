// hashProductImages — perceptual-hash corpus sweep + packed per-game index build
// (bulk scan intake; Content migration 0107 owns the product_image_hashes table).
//
// Sweeps product_images rows that have NO product_image_hashes row at the
// current HASH_VERSION, fetches the image bytes (R2 mirror preferred via the
// bucket binding; else source_url — EXCEPT tcgplayer-cdn hosts, which
// 403-block Worker egress IPs, the standing mirror wall: those rows are
// structurally excluded and COUNTED, never attempted), decodes (jpeg-js /
// hand-rolled PNG), and writes the versioned hash. After a run that produced
// new hashes it regenerates the packed per-game index blobs the Content hash
// engine serves matches from:
//   R2 key hash-index/v{HASH_VERSION}/{gameId}.bin
//   fixed 42-byte records [product_id u32 LE][38-byte hash], no header
//
// Convergence bookkeeping (no cursor persistence needed): the anti-join is
// self-advancing — a hashed row drops out of the candidate pool, and a
// PERMANENTLY undecodable/dead row gets a zero-length SENTINEL hash row
// (excluded from index packing by length(hash)=38) so the sweep never
// re-spends budget on it. TRANSIENT failures (network/5xx/R2 errors) write
// nothing and retry next run; ≥ CIRCUIT_LIMIT consecutive transient failures
// circuit-breaks the run (house pattern).
//
// Budget-limited per run (wall clock + image cap) — the sweep converges over
// multiple runs (daily cron + the admin panel loop).

import { logger } from './ingestion/logger';
import { r2KeyFromUrl } from './purgePlaceholderMirrors';
import { HASH_VERSION, HASH_BYTES, grayFromRgba, computeHashFromGray } from './lib/cardHash';
import { decodeImage } from './lib/imageDecode';

export interface HashEnv {
  DB: D1Database;
  IMAGES_BUCKET: R2Bucket;
}

export const HASH_SWEEP_DEFAULT_LIMIT = 400;
export const HASH_SWEEP_MAX_LIMIT = 1000;
const READ_CONCURRENCY = 10;
const WALL_CLOCK_LIMIT = 22_000;
const CIRCUIT_LIMIT = 10;      // consecutive transient failures → stop the run
const DB_BATCH = 90;           // D1 statement cap headroom (bound-param rule)
const REPACK_PAGE = 5000;

export const RECORD_BYTES = 4 + HASH_BYTES; // 42

const TCGPLAYER_CDN = 'tcgplayer-cdn.tcgplayer.com';

export interface HashSweepResult {
  scanned: number;
  hashed: number;
  undecodable: number;         // permanent → sentinel rows written
  transientFailures: number;
  circuitBroken: boolean;
  remaining: number;           // candidates still unhashed after this run
  excludedTcgplayerCdn: number; // structurally unreachable rows (coverage signal)
  gamesRepacked: number[];
  hasMore: boolean;
  cursorNext: number | null;
}

interface CandidateRow {
  product_id: number;
  game_id: number;
  r2_url: string | null;
  source_url: string | null;
}

const CANDIDATE_WHERE = `
      h.product_id IS NULL
  AND (
        pi.r2_url IS NOT NULL
     OR (pi.source_url IS NOT NULL AND pi.source_url NOT LIKE '%${TCGPLAYER_CDN}%')
  )`;

async function fetchCandidates(env: HashEnv, cursor: number, limit: number): Promise<CandidateRow[]> {
  const { results } = await env.DB.prepare(`
    SELECT p.id AS product_id, s.game_id AS game_id, pi.r2_url, pi.source_url
    FROM product_images pi
    JOIN products p ON p.id = pi.product_id
    JOIN sets s ON s.id = p.set_id
    LEFT JOIN product_image_hashes h
      ON h.product_id = p.id AND h.hash_version = ?
    WHERE ${CANDIDATE_WHERE}
      AND p.id > ?
    ORDER BY p.id
    LIMIT ?
  `).bind(HASH_VERSION, cursor, limit).all<CandidateRow>();
  return results ?? [];
}

async function countRemaining(env: HashEnv): Promise<number> {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS n
    FROM product_images pi
    JOIN products p ON p.id = pi.product_id
    JOIN sets s ON s.id = p.set_id
    LEFT JOIN product_image_hashes h
      ON h.product_id = p.id AND h.hash_version = ?
    WHERE ${CANDIDATE_WHERE}
  `).bind(HASH_VERSION).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function countExcludedTcgplayer(env: HashEnv): Promise<number> {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS n
    FROM product_images pi
    LEFT JOIN product_image_hashes h
      ON h.product_id = pi.product_id AND h.hash_version = ?
    WHERE h.product_id IS NULL
      AND pi.r2_url IS NULL
      AND pi.source_url LIKE '%${TCGPLAYER_CDN}%'
  `).bind(HASH_VERSION).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

type FetchOutcome =
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'permanent' }   // 4xx / object gone with no fallback → sentinel
  | { kind: 'transient' };  // network / 5xx / R2 error → retry next run

async function fetchImageBytes(env: HashEnv, row: CandidateRow): Promise<FetchOutcome> {
  // Prefer the R2 mirror (no egress, no CDN blocks).
  if (row.r2_url) {
    const key = r2KeyFromUrl(row.r2_url);
    if (key) {
      try {
        const obj = await env.IMAGES_BUCKET.get(key);
        if (obj) return { kind: 'bytes', bytes: new Uint8Array(await obj.arrayBuffer()) };
        // Mirrored object gone — fall through to source_url when fetchable.
      } catch {
        return { kind: 'transient' };
      }
    }
  }
  const url = row.source_url;
  if (!url || url.includes(TCGPLAYER_CDN)) return { kind: 'permanent' };
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SleevedPagesBot/1.0)',
        'Referer': 'https://sleevedpages.com/',
      },
    });
    if (!res.ok) {
      // 4xx = the URL is dead/blocked for good; 5xx = upstream hiccup.
      return res.status >= 500 ? { kind: 'transient' } : { kind: 'permanent' };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length < 512) return { kind: 'permanent' }; // sub-floor body
    return { kind: 'bytes', bytes };
  } catch {
    return { kind: 'transient' };
  }
}

function hashUpsert(env: HashEnv, row: CandidateRow, hash: Uint8Array): D1PreparedStatement {
  return env.DB.prepare(`
    INSERT OR REPLACE INTO product_image_hashes (product_id, game_id, hash, hash_version, computed_at)
    VALUES (?, ?, ?, ?, unixepoch())
  `).bind(row.product_id, row.game_id, hash, HASH_VERSION);
}

/** Pack records into the fixed-width blob format ([u32 LE id][38-byte hash]). */
export function packIndex(records: Array<{ productId: number; hash: Uint8Array }>): Uint8Array {
  const out = new Uint8Array(records.length * RECORD_BYTES);
  const view = new DataView(out.buffer);
  records.forEach((r, i) => {
    const off = i * RECORD_BYTES;
    view.setUint32(off, r.productId >>> 0, true);
    out.set(r.hash.subarray(0, HASH_BYTES), off + 4);
  });
  return out;
}

export function indexKeyForGame(gameId: number): string {
  return `hash-index/v${HASH_VERSION}/${gameId}.bin`;
}

/** Regenerate one game's packed index blob from D1 (sentinel rows excluded). */
export async function repackGameIndex(env: HashEnv, gameId: number): Promise<number> {
  const records: Array<{ productId: number; hash: Uint8Array }> = [];
  let cursor = 0;
  for (;;) {
    const { results } = await env.DB.prepare(`
      SELECT product_id, hash FROM product_image_hashes
      WHERE game_id = ? AND hash_version = ? AND length(hash) = ?
        AND product_id > ?
      ORDER BY product_id
      LIMIT ?
    `).bind(gameId, HASH_VERSION, HASH_BYTES, cursor, REPACK_PAGE).all<{ product_id: number; hash: ArrayBuffer }>();
    const page = results ?? [];
    for (const r of page) {
      records.push({ productId: Number(r.product_id), hash: new Uint8Array(r.hash) });
    }
    if (page.length < REPACK_PAGE) break;
    cursor = Number(page[page.length - 1].product_id);
  }
  await env.IMAGES_BUCKET.put(indexKeyForGame(gameId), packIndex(records) as unknown as ArrayBuffer);
  return records.length;
}

export async function runHashProductImages(
  env: HashEnv,
  opts: { cursor?: number; limit?: number } = {},
): Promise<HashSweepResult> {
  const start = Date.now();
  const limit = Math.min(Math.max(1, opts.limit ?? HASH_SWEEP_DEFAULT_LIMIT), HASH_SWEEP_MAX_LIMIT);
  let cursor = Math.max(0, opts.cursor ?? 0);

  let scanned = 0;
  let hashed = 0;
  let undecodable = 0;
  let transientFailures = 0;
  let consecutiveTransient = 0;
  let circuitBroken = false;
  let lastId: number | null = null;
  const touchedGames = new Set<number>();
  const statements: D1PreparedStatement[] = [];
  const sentinel = new Uint8Array(0);

  outer: while (scanned < limit && Date.now() - start < WALL_CLOCK_LIMIT) {
    const batch = await fetchCandidates(env, cursor, Math.min(100, limit - scanned));
    if (!batch.length) break;
    cursor = batch[batch.length - 1].product_id;

    for (let i = 0; i < batch.length; i += READ_CONCURRENCY) {
      const slice = batch.slice(i, i + READ_CONCURRENCY);
      const outcomes = await Promise.all(slice.map(row => fetchImageBytes(env, row)));
      for (let j = 0; j < slice.length; j++) {
        const row = slice[j];
        const outcome = outcomes[j];
        scanned++;
        lastId = row.product_id;
        if (outcome.kind === 'transient') {
          transientFailures++;
          consecutiveTransient++;
          if (consecutiveTransient >= CIRCUIT_LIMIT) {
            circuitBroken = true;
            logger.error('hashProductImages circuit break — repeated fetch failures', {
              consecutive: consecutiveTransient, at: row.product_id,
            });
            break outer;
          }
          continue;
        }
        consecutiveTransient = 0;
        if (outcome.kind === 'permanent') {
          statements.push(hashUpsert(env, row, sentinel));
          undecodable++;
          continue;
        }
        const decoded = await decodeImage(outcome.bytes);
        if (!decoded) {
          // Undecodable bytes → sentinel; log + skip, never fail the run.
          logger.warn('hashProductImages undecodable image', { product_id: row.product_id });
          statements.push(hashUpsert(env, row, sentinel));
          undecodable++;
          continue;
        }
        const gray = grayFromRgba(decoded.data, decoded.width, decoded.height);
        statements.push(hashUpsert(env, row, computeHashFromGray(gray, decoded.width, decoded.height)));
        touchedGames.add(row.game_id);
        hashed++;
      }
      if (Date.now() - start >= WALL_CLOCK_LIMIT) break outer;
    }
  }

  // Flush writes (chunked ≤90 statements per D1 batch).
  for (let i = 0; i < statements.length; i += DB_BATCH) {
    await env.DB.batch(statements.slice(i, i + DB_BATCH));
  }

  // Regenerate the packed index for every game this run added hashes to.
  const gamesRepacked: number[] = [];
  for (const gameId of touchedGames) {
    try {
      const count = await repackGameIndex(env, gameId);
      gamesRepacked.push(gameId);
      logger.info('hashProductImages repacked game index', { gameId, records: count });
    } catch (err) {
      logger.error('hashProductImages repack failed', { gameId, error: String(err) });
    }
  }

  const [remaining, excludedTcgplayerCdn] = await Promise.all([
    countRemaining(env),
    countExcludedTcgplayer(env),
  ]);

  const result: HashSweepResult = {
    scanned, hashed, undecodable, transientFailures, circuitBroken,
    remaining, excludedTcgplayerCdn, gamesRepacked,
    hasMore: remaining > 0,
    cursorNext: remaining > 0 ? lastId : null,
  };
  logger.info('hashProductImages run complete', result as unknown as Record<string, unknown>);
  return result;
}
