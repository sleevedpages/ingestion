/**
 * priceDailyCapture.ts — the daily `price_daily` PROJECTION trigger (Price Index Capture Phase 2).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THIS WORKER PRICES NOTHING AND PROJECTS NOTHING (the price-archive seam, looped)
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The R2 archive, the dedicated price DB (`PRICE_DB`), the TCGplayer-basis filter and the
 * write-on-change/retention rules all live in the Content app. This worker carries the SCHEDULE
 * only: it POSTs Content's bounded `/api/internal/price-daily/run` until the run reports `done`
 * (every completed archive day projected, oldest first) — the exact `priceArchive.ts` shape,
 * because one archive day is ~69 parts and a catch-up can span several days.
 *
 * AUTH + CONTENT_APP_URL: identical to priceArchive.ts — the shared secret sent outbound
 * (`x-worker-secret`; Content checks it at the top, fail-closed when unset), and NO fallback
 * origin (a hardcoded prod URL would let a UAT worker drive PROD projections).
 *
 * FAILURE ISOLATION: a genuine failure THROWS so `runStage` records an honest status='error'
 * run-log row; the cron call site catches it (`.catch(logger.error)`) so it can never touch any
 * other job. Nothing is lost on failure — the projection resumes from its `price_daily_days`
 * cursor on the next fire. Additive bookkeeping; no live pricing path depends on it.
 */

import type { Env } from './worker.js';
import { logger } from './ingestion/logger.js';

/** Path on the Content app. Keep in lockstep with functions/api/internal/price-daily/run.js. */
export const PRICE_DAILY_RUN_PATH = '/api/internal/price-daily/run';

/** Wall-clock cap per POST. Content's batch stops itself at ~15s of work; aborting is SAFE. */
export const PRICE_DAILY_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Cap on batch POSTs per trigger firing. One archive day is ~69 parts at ≤12 parts/batch ≈ 6–8
 * calls; the initial catch-up (the ~14 days accumulated before this shipped) needs ~100. The cron's
 * scheduled-event budget (15 min) is the real bound — a run cut short reports done:false, nothing
 * is lost, and the next fire (tomorrow's cron or the manual job) resumes from the day cursor.
 */
export const PRICE_DAILY_MAX_CALLS = 120;

export interface PriceDailyRunResult {
  ok: boolean;
  /** Set when the job did not run for a configuration reason (not a failure). */
  skipped?: 'not_configured';
  calls?: number;
  /** Days that reached `complete` during this firing. */
  daysCompleted?: string[];
  /** The day the last batch worked on (null when caught up on the first call). */
  lastDay?: string | null;
  rowsWritten?: number;
  rowsUnchanged?: number;
  rowsPruned?: number;
  done?: boolean;
  /** Content's terminal reason: 'caught_up' | 'disabled' | null. */
  reason?: string | null;
}

/** Resolve the absolute endpoint URL, or null when unset/unusable. */
export function priceDailyRunUrl(base: string | undefined | null): string | null {
  const raw = String(base ?? '').trim();
  if (!raw) return null;
  try {
    const u = new URL(PRICE_DAILY_RUN_PATH, raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

async function postOnce(url: string, secret: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PRICE_DAILY_REQUEST_TIMEOUT_MS);
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
    // No response body in the error: a 503 body could carry app internals into this log stream.
    throw new Error(`price daily run returned HTTP ${res.status}`);
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || body.ok !== true) {
    throw new Error('price daily run returned an unexpected body');
  }
  return body;
}

/**
 * Ask the Content app to project every completed archive day into `price_daily`, looping its
 * bounded batch endpoint until it reports `done` (or the call cap — reported honestly).
 *
 * THROWS on a genuine failure so `runStage` records status='error'. A MISSING CONTENT_APP_URL
 * resolves rather than throwing: not-configured is a state, not an error.
 */
export async function runPriceDailyCapture(env: Env): Promise<PriceDailyRunResult> {
  const url = priceDailyRunUrl(env.CONTENT_APP_URL);
  if (!url) {
    logger.warn('price-daily-capture skipped: CONTENT_APP_URL is not set', { job: 'price-daily-capture' });
    return { ok: false, skipped: 'not_configured' };
  }
  if (!env.INGESTION_WORKER_SECRET) {
    logger.warn('price-daily-capture skipped: INGESTION_WORKER_SECRET is not set', { job: 'price-daily-capture' });
    return { ok: false, skipped: 'not_configured' };
  }

  let calls = 0;
  let rowsWritten = 0;
  let rowsUnchanged = 0;
  let rowsPruned = 0;
  let lastDay: string | null = null;
  let done = false;
  let reason: string | null = null;
  const daysCompleted: string[] = [];

  while (calls < PRICE_DAILY_MAX_CALLS && !done) {
    const body = await postOnce(url, env.INGESTION_WORKER_SECRET);
    calls += 1;
    if (typeof body.day === 'string') lastDay = body.day;
    if (body.dayDone === true && typeof body.day === 'string' && !daysCompleted.includes(body.day)) {
      daysCompleted.push(body.day);
    }
    rowsWritten += Number(body.rowsWritten ?? 0);
    rowsUnchanged += Number(body.rowsUnchanged ?? 0);
    rowsPruned += Number(body.rowsPruned ?? 0);
    done = body.done === true || body.hasMore === false;
    if (typeof body.skipped === 'string') reason = body.skipped;
  }

  const result: PriceDailyRunResult = {
    ok: true, calls, daysCompleted, lastDay, rowsWritten, rowsUnchanged, rowsPruned, done, reason,
  };

  // One structured line so a log search answers "is price_daily caught up" without opening D1.
  // done:false = the call cap cut the run short — the next fire resumes; nothing is lost.
  logger.info('price_daily_capture_run', { job: 'price-daily-capture', ...result });
  return result;
}
