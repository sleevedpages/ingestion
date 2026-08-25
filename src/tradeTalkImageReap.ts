/**
 * tradeTalkImageReap.ts — the daily trade-talk photo reaper trigger (Content migration 0137).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THIS WORKER DELETES NOTHING (the value-snapshots seam, exactly)
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The whole job is one authenticated HTTP POST. The table (`trade_talk_images`), the R2 prefix
 * (`trade-talk-images/`), the retention TTL and the expiry semantics all live in the Content app,
 * and they stay there — a second implementation of "which photos are due" would be a second
 * answer to a privacy question, which is the worst possible thing to fork. So the SCHEDULE lives
 * here (Content is a Pages project and cannot cron) and the WORK lives in Content
 * (`POST /api/internal/trade-talk-images/reap`).
 *
 * ⚠️ THIS JOB IS HOUSEKEEPING, NOT THE PRIVACY CONTROL. Content's READ path re-checks
 * `expires_at` on every request and 404s an expired photo whether or not this cron has ever run.
 * A dead reaper therefore costs storage, not confidentiality — and the R2 lifecycle rule on the
 * `trade-talk-images/` prefix (TTL + grace) is the third layer under both.
 *
 * WHY 09:00 UTC. It wants a quiet slot with no dependency on anything: the reap reads only its
 * own table, so it does not need to follow the price ingest. 09:00 is simply the free hour
 * between the 08:00 price-anomaly scan and the 10:00 value snapshot / card-watch lane.
 * ⚠️ The session brief proposed `0 7 * * *` and called it free — it is NOT: `0 7 * * *` is the
 * daily news-poll, and the cron handler is a switch on the cron STRING, so a second job on that
 * string would have to be bolted into the news-poll case. 09:00 is genuinely unused.
 * PROD ONLY — never added to [env.preview.triggers]; UAT fires it on demand via
 * POST /admin/run-job { job: 'trade-talk-image-reap' } (the news-poll precedent).
 *
 * AUTH + CONTENT_APP_URL: identical to valueSnapshots.ts / priceAnomalyScan.ts — the same shared
 * secret pointed outbound, and NO fallback origin (a hardcoded prod URL would make a UAT worker
 * reap PRODUCTION photos); an absent CONTENT_APP_URL self-skips with a named reason.
 */

import type { Env } from './worker.js';
import { logger } from './ingestion/logger.js';

/** Path on the Content app. Keep in lockstep with
 *  functions/api/internal/trade-talk-images/reap.js. */
export const TRADE_TALK_IMAGE_REAP_PATH = '/api/internal/trade-talk-images/reap';

/**
 * Wall-clock cap on the request. The reap is one bounded 500-row batch plus a best-effort R2
 * multi-delete, so it is quick — but a hung connection must not sit on the invocation.
 * Aborting is SAFE: the row delete either committed or did not, the sweep is best-effort by
 * contract, and the job is idempotent, so the next run picks up whatever is still due.
 */
export const TRADE_TALK_IMAGE_REAP_TIMEOUT_MS = 60_000;

export interface TradeTalkImageReapResult {
  ok: boolean;
  /** Set when the job did not run for a configuration reason (not a failure). */
  skipped?: 'not_configured';
  status?: number;
  rowsDeleted?: number;
  /** Objects HANDED TO Content's best-effort background sweep — not a confirmed delete count. */
  objectsDeleted?: number;
  /** Rows still past their expiry after this batch; -1 when Content could not count them. */
  remaining?: number;
}

/** Resolve the absolute endpoint URL, or null when unset/unusable. */
export function tradeTalkImageReapUrl(base: string | undefined | null): string | null {
  const raw = String(base ?? '').trim();
  if (!raw) return null;
  try {
    const u = new URL(TRADE_TALK_IMAGE_REAP_PATH, raw);
    // http(s) only — a stray `file:`/`data:` value in config must never become a fetch target.
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Ask the Content app to reap expired trade-talk photos.
 *
 * THROWS on a genuine failure (unreachable app, non-2xx, unparseable body) so `runStage` records
 * `status='error'` + the message in `ingestion_run_log` — an honest observability row is the
 * whole alerting story for a janitor job. The CRON CALL SITE catches it
 * (`.catch(logger.error)`, the pattern every other cron here uses), which makes the failure
 * log-and-continue: it never escapes into `waitUntil` and cannot touch the ingest jobs (separate
 * cron cases, separate invocations). No retry — tomorrow's run is the retry, and nothing is lost
 * in the meantime because Content's read path already refuses an expired photo.
 *
 * A MISSING `CONTENT_APP_URL` resolves rather than throwing: not-configured is a state, not an
 * error, and it must be legible in the run log instead of buried in a stack string.
 */
export async function runTradeTalkImageReap(env: Env): Promise<TradeTalkImageReapResult> {
  const url = tradeTalkImageReapUrl(env.CONTENT_APP_URL);
  if (!url) {
    logger.warn('trade-talk-image-reap skipped: CONTENT_APP_URL is not set', { job: 'trade-talk-image-reap' });
    return { ok: false, skipped: 'not_configured' };
  }
  if (!env.INGESTION_WORKER_SECRET) {
    logger.warn('trade-talk-image-reap skipped: INGESTION_WORKER_SECRET is not set', { job: 'trade-talk-image-reap' });
    return { ok: false, skipped: 'not_configured' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRADE_TALK_IMAGE_REAP_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-worker-secret': env.INGESTION_WORKER_SECRET,
        'content-type': 'application/json',
      },
      body: '{}',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Deliberately does NOT include the response body: a 401 body is uninteresting and a 500
    // body could carry app internals into this worker's log stream.
    throw new Error(`trade-talk image reap returned HTTP ${res.status}`);
  }

  const body = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || body.ok !== true) {
    throw new Error('trade-talk image reap returned an unexpected body');
  }

  const result: TradeTalkImageReapResult = {
    ok: true,
    status: res.status,
    rowsDeleted:    Number(body.rowsDeleted ?? 0),
    objectsDeleted: Number(body.objectsDeleted ?? 0),
    remaining:      Number(body.remaining ?? 0),
  };

  // One structured line so a log search answers "is retention actually being enforced on disk"
  // without opening the database. `remaining` > 0 means one batch did not keep up — re-fire the
  // job (or raise the batch size) rather than waiting a day per 500 rows.
  logger.info('trade_talk_image_reap_run', { job: 'trade-talk-image-reap', ...result });
  return result;
}
