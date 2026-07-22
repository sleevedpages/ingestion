/**
 * valueSnapshots.ts — the daily inventory-value snapshot trigger (Content migration 0115).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THIS WORKER PRICES NOTHING
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The whole job is one authenticated HTTP POST. Every figure in a snapshot — graded slabs, the
 * printing dimension, the ungraded source chain, the "unvalued, never $0" rule — comes from the
 * Content app's `valueInventoryRows()` batch valuator, and it stays there. Re-implementing any
 * part of that here would fork the valuator: two answers to "what is this card worth", drifting
 * apart the first time a pricing rung changes, and the divergence would surface only as an
 * unexplainable step in a history chart nobody can re-derive.
 *
 * So the division is: Content owns the COMPUTE (it has the chain), this worker owns the SCHEDULE
 * (Content is a Pages project and cannot have a cron). This module is the seam, and it is
 * deliberately thin enough that there is nothing in it to drift.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * AUTH — the same shared secret, pointed the other way
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Every HTTP endpoint on THIS worker is gated by `x-worker-secret === INGESTION_WORKER_SECRET`
 * (audit ING-1). This is the first call that travels the other direction, and it uses the SAME
 * secret and the SAME header — Content's `POST /api/internal/snapshots/run` checks it at the top
 * of the handler and 401s otherwise, fail-closed when unset. No new secret is introduced; both
 * repos already hold this one.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * CONTENT_APP_URL IS REQUIRED — there is no default origin, on purpose
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A hardcoded `https://sleevedpages.com` fallback would mean the UAT worker silently writes
 * snapshots into the PRODUCTION database the first time someone fires the job there. So an absent
 * `CONTENT_APP_URL` self-skips with a named reason rather than guessing. Prod sets it in
 * `[vars]`; UAT sets it in `[env.preview.vars]` (wrangler does NOT inherit top-level `vars` into a
 * named environment, which is what makes "unset by default" the safe state here).
 */

import type { Env } from './worker.js';
import { logger } from './ingestion/logger.js';

/** Path on the Content app. Keep in lockstep with functions/api/internal/snapshots/run.js. */
export const SNAPSHOT_RUN_PATH = '/api/internal/snapshots/run';

/**
 * Wall-clock cap on the request. The run is sequential over every business profile and each one
 * values its whole inventory, so it is not instant — but a hung connection must not sit on the
 * invocation forever. Aborting is SAFE: Content's write is `INSERT OR IGNORE` on
 * (profile_id, day_start), so whatever it completed before we stopped listening is kept, whatever
 * it did not is picked up by the lazy fallback or tomorrow's run, and nothing is double-written.
 */
export const SNAPSHOT_REQUEST_TIMEOUT_MS = 60_000;

export interface ValueSnapshotRunResult {
  ok: boolean;
  /** Set when the job did not run for a configuration reason (not a failure). */
  skipped?: 'not_configured';
  status?: number;
  dayStart?: number;
  tzOffsetMinutes?: number;
  profiles?: number;
  written?: number;
  skippedProfiles?: number;
  errors?: number;
  truncated?: boolean;
}

/** Resolve the absolute endpoint URL, or null when unset/unusable. */
export function snapshotRunUrl(base: string | undefined | null): string | null {
  const raw = String(base ?? '').trim();
  if (!raw) return null;
  try {
    const u = new URL(SNAPSHOT_RUN_PATH, raw);
    // http(s) only — a stray `file:`/`data:` value in config must never become a fetch target.
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Ask the Content app to write today's value snapshot for every business profile.
 *
 * THROWS on a genuine failure (unreachable app, non-2xx, unparseable body) so `runStage` records
 * `status='error'` + the message in `ingestion_run_log` — an honest observability row is the point
 * of having one. The CRON CALL SITE catches it (`.catch(logger.error)`, the pattern every other
 * cron in this worker uses), which is what makes the failure log-and-continue: it never escapes
 * into `waitUntil`, and it cannot touch the Scrydex or PriceCharting jobs, which are separate
 * cron cases in separate invocations. There is no retry — snapshots are per-DAY and idempotent,
 * so tomorrow's run (and the Content-side lazy fallback in between) is the retry.
 *
 * A MISSING `CONTENT_APP_URL` resolves rather than throwing: not-configured is a state, not an
 * error, and it must be legible in the run log instead of buried in a stack string.
 */
export async function runValueSnapshots(env: Env): Promise<ValueSnapshotRunResult> {
  const url = snapshotRunUrl(env.CONTENT_APP_URL);
  if (!url) {
    logger.warn('value-snapshots skipped: CONTENT_APP_URL is not set', { job: 'value-snapshots' });
    return { ok: false, skipped: 'not_configured' };
  }
  if (!env.INGESTION_WORKER_SECRET) {
    logger.warn('value-snapshots skipped: INGESTION_WORKER_SECRET is not set', { job: 'value-snapshots' });
    return { ok: false, skipped: 'not_configured' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SNAPSHOT_REQUEST_TIMEOUT_MS);

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
    // Deliberately does NOT include the response body: a 401 body is uninteresting and a 500 body
    // could carry app internals into this worker's log stream.
    throw new Error(`snapshot run returned HTTP ${res.status}`);
  }

  const body = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || body.ok !== true) {
    throw new Error('snapshot run returned an unexpected body');
  }

  const result: ValueSnapshotRunResult = {
    ok: true,
    status: res.status,
    dayStart:        Number(body.dayStart ?? 0),
    tzOffsetMinutes: Number(body.tzOffsetMinutes ?? 0),
    profiles:        Number(body.profiles ?? 0),
    written:         Number(body.written ?? 0),
    skippedProfiles: Number(body.skipped ?? 0),
    errors:          Number(body.errors ?? 0),
    truncated:       body.truncated === true,
  };

  // One structured line so a log search answers "did the series get a point today" without
  // opening the database. `errors` > 0 means SOME profiles failed and the rest still landed.
  logger.info('value_snapshots_run', { job: 'value-snapshots', ...result });
  return result;
}
