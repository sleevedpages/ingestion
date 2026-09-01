/**
 * priceArchive.ts — the daily R2 price-archive capture trigger (Price Index Capture Phase 1).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THIS WORKER PRICES NOTHING AND ARCHIVES NOTHING (the value-snapshots seam, looped)
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The prices table, the identity tuple, the day convention and the PRICE_ARCHIVE bucket binding
 * all live in the Content app. This worker carries the SCHEDULE only. The one difference from
 * the snapshots/anomaly-scan/reap seams: a full capture is ~1.33M rows and cannot fit one
 * Content invocation, so the Content endpoint does one BOUNDED batch per POST (resumable via
 * R2 part metadata) and THIS trigger loops it until the day reports `done` — the same
 * loop-until-finished shape as the purge/dead-url-sweep drivers, pointed across the seam.
 *
 * AUTH + CONTENT_APP_URL: identical to valueSnapshots.ts — the same shared secret sent
 * outbound (`x-worker-secret`; Content checks it at the top, fail-closed when unset), and NO
 * fallback origin (a hardcoded prod URL would make a UAT worker archive PROD prices into
 * whatever bucket UAT is pointed at — or worse); an absent CONTENT_APP_URL self-skips with a
 * named reason.
 *
 * FAILURE ISOLATION: a genuine failure THROWS so `runStage` records an honest status='error'
 * run-log row; the cron call site catches it (`.catch(logger.error)`) so it can never touch any
 * other job. A failed or cancelled run loses NOTHING — landed parts stay landed, and the next
 * fire (tomorrow's cron or a manual job) RESUMES the same day from the last part. The capture
 * is additive bookkeeping; no live pricing path depends on it.
 */

import type { Env } from './worker.js';
import { logger } from './ingestion/logger.js';

/** Path on the Content app. Keep in lockstep with functions/api/internal/price-archive/run.js. */
export const PRICE_ARCHIVE_RUN_PATH = '/api/internal/price-archive/run';

/**
 * Wall-clock cap per POST. Content's batch stops itself at ~15s of work plus read/gzip tails,
 * so 60s is generous; aborting is SAFE (landed parts are kept, the next call resumes).
 */
export const PRICE_ARCHIVE_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Cap on batch POSTs per trigger firing. At the measured prod volume (~1.33M rows, ~20k-row
 * parts, ~15s budget/batch) a full day completes in well under 15 calls; 30 is headroom. A day
 * that somehow needs more is NOT lost: the run reports done:false, landed parts are kept, and a
 * re-fire of the MANUAL `price-archive-capture` job the SAME local day resumes from the last
 * landed part. (Tomorrow's cron targets tomorrow's partition — a cut-short day left un-refired
 * stays a partial partition with no manifest, which any reader treats as an absent day.)
 */
export const PRICE_ARCHIVE_MAX_CALLS = 30;

export interface PriceArchiveRunResult {
  ok: boolean;
  /** Set when the job did not run for a configuration reason (not a failure). */
  skipped?: 'not_configured';
  day?: string;
  calls?: number;
  partsWritten?: number;
  partsSkipped?: number;
  rowsWritten?: number;
  bytesWritten?: number;
  done?: boolean;
}

/** Resolve the absolute endpoint URL, or null when unset/unusable. */
export function priceArchiveRunUrl(base: string | undefined | null): string | null {
  const raw = String(base ?? '').trim();
  if (!raw) return null;
  try {
    const u = new URL(PRICE_ARCHIVE_RUN_PATH, raw);
    // http(s) only — a stray `file:`/`data:` value in config must never become a fetch target.
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

async function postOnce(url: string, secret: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PRICE_ARCHIVE_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'x-worker-secret': secret, 'content-type': 'application/json' },
      body: '{}',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    // Deliberately no response body in the error: a 401 body is uninteresting and a 500/503
    // body could carry app internals into this worker's log stream.
    throw new Error(`price archive run returned HTTP ${res.status}`);
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || body.ok !== true) {
    throw new Error('price archive run returned an unexpected body');
  }
  return body;
}

/**
 * Ask the Content app to capture TODAY's price archive, looping its bounded batch endpoint
 * until the day reports `done` (or the call cap is hit — reported honestly, never silently).
 *
 * THROWS on a genuine failure so `runStage` records status='error'; already-landed parts are
 * kept and the next fire resumes. A MISSING CONTENT_APP_URL resolves rather than throwing:
 * not-configured is a state, not an error.
 */
export async function runPriceArchive(env: Env): Promise<PriceArchiveRunResult> {
  const url = priceArchiveRunUrl(env.CONTENT_APP_URL);
  if (!url) {
    logger.warn('price-archive-capture skipped: CONTENT_APP_URL is not set', { job: 'price-archive-capture' });
    return { ok: false, skipped: 'not_configured' };
  }
  if (!env.INGESTION_WORKER_SECRET) {
    logger.warn('price-archive-capture skipped: INGESTION_WORKER_SECRET is not set', { job: 'price-archive-capture' });
    return { ok: false, skipped: 'not_configured' };
  }

  let calls = 0;
  let partsWritten = 0;
  let partsSkipped = 0;
  let rowsWritten = 0;
  let bytesWritten = 0;
  let day: string | undefined;
  let done = false;

  while (calls < PRICE_ARCHIVE_MAX_CALLS && !done) {
    const body = await postOnce(url, env.INGESTION_WORKER_SECRET);
    calls += 1;
    day = typeof body.day === 'string' ? body.day : day;
    partsWritten += Number(body.partsWritten ?? 0);
    partsSkipped = Math.max(partsSkipped, Number(body.partsSkipped ?? 0));
    rowsWritten += Number(body.rowsWritten ?? 0);
    bytesWritten += Number(body.bytesWritten ?? 0);
    done = body.done === true;
  }

  const result: PriceArchiveRunResult = {
    ok: true, day, calls, partsWritten, partsSkipped, rowsWritten, bytesWritten, done,
  };

  // One structured line so a log search answers "did today's archive land, whole" without
  // opening R2. done:false here means the call cap cut the run short — re-fire the manual job
  // the SAME day; the resume machinery continues from the last landed part.
  logger.info('price_archive_capture_run', { job: 'price-archive-capture', ...result });
  return result;
}
