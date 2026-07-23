/**
 * watchAlerts.ts — the Card Watch price-movement alert hook (Content migration 0117, Session 3).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THIS WORKER DIFFS AND SENDS NOTHING
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * After the WATCHED-scope drain (`processPendingWebhooks(env, {scope:'watched'})`) refreshes the
 * Scrydex expansions containing a watched card, it hands back the list of `(gameSlug, expansion)`
 * pairs it fetched live. This module is one authenticated HTTP POST of that list to the Content
 * app, and NOTHING else. The pricing diff (against `alert_baseline_price`) and the FCM send both
 * live in Content — porting either here would fork the pricing chain (the exact mistake the s40
 * value-snapshot seam exists to avoid) and grow this worker an FCM code path it must not have.
 *
 * Content owns the WORK (`POST /api/internal/watch-alerts/run`), this worker owns the SCHEDULE (the
 * priority lane cron + the manual drain job). This module is deliberately thin enough that there is
 * nothing in it to drift.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * AUTH + CONTENT_APP_URL — identical to the s40 snapshot seam (valueSnapshots.ts)
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Same shared secret pointed the same direction: `x-worker-secret === INGESTION_WORKER_SECRET`,
 * which Content checks at the top of its handler (401, fail-closed when unset). No new secret.
 * `CONTENT_APP_URL` is REQUIRED with no in-code default — a `https://sleevedpages.com` fallback
 * would make the UAT worker POST into the PRODUCTION app, so an absent value self-skips with a named
 * reason. Prod sets it in `[vars]`; UAT deliberately leaves it unset (the UAT worker log-and-skips
 * the hook — UAT alert-endpoint verification is the direct call in the deploy checklist).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * FAILURE IS ISOLATED FROM THE DRAIN
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The drain's price writes must never depend on alerting. The call sites (the cron lane + the
 * `card-watch-drain` admin job) fire this AFTER the drain has committed its writes and wrap it in
 * `.catch(logger.error)`, so a thrown alert failure is logged and dropped — it can never fail or
 * roll back the drain. A genuine failure (unreachable / non-2xx / unexpected body) THROWS so the
 * caller's catch records it; a missing config resolves (not throws) so it reads as a state, not an
 * error. There is no retry — the next lane run (10/16/22) re-refreshes and re-evaluates.
 */

import type { Env } from './worker.js';
import { logger } from './ingestion/logger.js';

/** Path on the Content app. Keep in lockstep with functions/api/internal/watch-alerts/run.js. */
export const WATCH_ALERTS_RUN_PATH = '/api/internal/watch-alerts/run';

/** Wall-clock cap on the request. The Content endpoint sends at most one push per watched card in a
 *  small set of just-refreshed expansions, so it is quick — but a hung connection must not sit on
 *  the invocation. Aborting is SAFE: Content re-anchors a baseline only AFTER a successful send, so
 *  a dropped connection leaves un-fired alerts to the next lane run (baseline-anchoring is idempotent
 *  by design). */
export const WATCH_ALERTS_REQUEST_TIMEOUT_MS = 30_000;

export interface WatchAlertRunResult {
  ok: boolean;
  /** Set when the hook did not run for a non-failure reason. */
  skipped?: 'not_configured' | 'empty';
  status?: number;
  expansions?: number;
  watchesEvaluated?: number;
  alertsFired?: number;
  skippedCooldown?: number;
  skippedNoTokens?: number;
  sendFailures?: number;
}

/** Resolve the absolute endpoint URL, or null when unset/unusable (the UAT self-skip). */
export function watchAlertsRunUrl(base: string | undefined | null): string | null {
  const raw = String(base ?? '').trim();
  if (!raw) return null;
  try {
    const u = new URL(WATCH_ALERTS_RUN_PATH, raw);
    // http(s) only — a stray file:/data: value in config must never become a fetch target.
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Ask the Content app to evaluate + push Card Watch price-movement alerts for the given
 * just-refreshed expansions. THROWS on a genuine failure (so the cron/job `.catch` logs it); an
 * empty list or a missing `CONTENT_APP_URL`/secret RESOLVES with a `skipped` reason rather than
 * throwing (not-configured and nothing-to-do are states, not errors).
 */
export async function runWatchAlerts(
  env: Env,
  refreshedExpansions: { gameSlug: string; expansion: string }[],
): Promise<WatchAlertRunResult> {
  const expansions = (Array.isArray(refreshedExpansions) ? refreshedExpansions : [])
    .filter((e) => e && e.expansion);
  if (!expansions.length) return { ok: true, skipped: 'empty' };

  const url = watchAlertsRunUrl(env.CONTENT_APP_URL);
  if (!url) {
    logger.warn('watch-alerts skipped: CONTENT_APP_URL is not set', { job: 'card-watch-alerts' });
    return { ok: false, skipped: 'not_configured' };
  }
  if (!env.INGESTION_WORKER_SECRET) {
    logger.warn('watch-alerts skipped: INGESTION_WORKER_SECRET is not set', { job: 'card-watch-alerts' });
    return { ok: false, skipped: 'not_configured' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WATCH_ALERTS_REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-worker-secret': env.INGESTION_WORKER_SECRET,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ expansions }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Deliberately excludes the response body: a 401 body is uninteresting and a 500 body could
    // carry app internals into this worker's log stream.
    throw new Error(`watch-alerts run returned HTTP ${res.status}`);
  }

  const body = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || body.ok !== true) {
    throw new Error('watch-alerts run returned an unexpected body');
  }

  const result: WatchAlertRunResult = {
    ok: true,
    status: res.status,
    expansions:       Number(body.expansions ?? 0),
    watchesEvaluated: Number(body.watches_evaluated ?? 0),
    alertsFired:      Number(body.alerts_fired ?? 0),
    skippedCooldown:  Number(body.skipped_cooldown ?? 0),
    skippedNoTokens:  Number(body.skipped_no_tokens ?? 0),
    sendFailures:     Number(body.send_failures ?? 0),
  };

  // One structured line so a log search answers "did watched cards alert this run" without opening
  // the DB. `alertsFired` > 0 means at least one push went out.
  logger.info('watch_alerts_run', { job: 'card-watch-alerts', ...result });
  return result;
}
