/**
 * childConsentReap.ts — the daily trigger that deletes child accounts whose parental consent was
 * NEVER CONFIRMED within the 7-day window (Content child-accounts S2, 2026-09-22).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THIS WORKER DELETES NOTHING (the value-snapshots seam, exactly — tradeTalkImageReap.ts's twin)
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The whole job is one authenticated HTTP POST to Content's `/api/internal/child-consents/reap`.
 * The consent table, the 7-day window and the ONE account-deletion plan all live in Content; a
 * second definition of "which children are due" here would fork a CHILD-PRIVACY question, which is
 * the worst possible thing to fork. The SCHEDULE lives here (Content is a Pages project and cannot
 * cron); the WORK lives in Content.
 *
 * ⚠️ HOUSEKEEPING, NOT THE CONTROL. Content enforces the window at READ time: an expired pending
 * consent can never be confirmed, and nothing can ever be collected under it. A dead reaper leaves
 * an inert row a little longer; it never exposes anything.
 *
 * WHEN: it rides the existing `0 9 * * *` case beside the trade-talk photo reap (both are
 * dependency-free janitors; the cron handler is a switch on the cron STRING, so a new string
 * would need a new trigger slot for no benefit). The two run as SEPARATE waitUntil promises — a
 * failure in one never stops the other. PROD ONLY; UAT fires it on demand via
 * POST /admin/run-job { job: 'child-consent-reap' } (the news-poll precedent).
 *
 * CROSS-REPO ORDER — by direction of call: Content's endpoint deploys FIRST, then this worker
 * (until then the POST 404s and runStage records an honest error row; nothing is lost).
 *
 * AUTH + CONTENT_APP_URL: identical to tradeTalkImageReap.ts — the shared secret pointed outbound,
 * and NO fallback origin (a hardcoded prod URL would make a UAT worker delete PRODUCTION children).
 */

import type { Env } from './worker.js';
import { logger } from './ingestion/logger.js';

/** Path on the Content app. Keep in lockstep with functions/api/internal/child-consents/reap.js. */
export const CHILD_CONSENT_REAP_PATH = '/api/internal/child-consents/reap';

/** Wall-clock cap. Content deletes a bounded batch (25), each child in its own transaction. */
export const CHILD_CONSENT_REAP_TIMEOUT_MS = 60_000;

export interface ChildConsentReapResult {
  ok: boolean;
  skipped?: 'not_configured';
  status?: number;
  deleted?: number;
  failed?: number;
  /** > 0 when more expired consents were due than one batch; re-fire the job. */
  remaining?: number;
}

/** Resolve the absolute endpoint URL, or null when unset/unusable. */
export function childConsentReapUrl(base: string | undefined | null): string | null {
  const raw = String(base ?? '').trim();
  if (!raw) return null;
  try {
    const u = new URL(CHILD_CONSENT_REAP_PATH, raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Ask the Content app to delete the child accounts whose consent expired unconfirmed.
 * THROWS on a genuine failure (so runStage records status='error'); a missing CONTENT_APP_URL or
 * secret RESOLVES as not-configured. No retry — tomorrow's run is the retry.
 */
export async function runChildConsentReap(env: Env): Promise<ChildConsentReapResult> {
  const url = childConsentReapUrl(env.CONTENT_APP_URL);
  if (!url) {
    logger.warn('child-consent-reap skipped: CONTENT_APP_URL is not set', { job: 'child-consent-reap' });
    return { ok: false, skipped: 'not_configured' };
  }
  if (!env.INGESTION_WORKER_SECRET) {
    logger.warn('child-consent-reap skipped: INGESTION_WORKER_SECRET is not set', { job: 'child-consent-reap' });
    return { ok: false, skipped: 'not_configured' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHILD_CONSENT_REAP_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'x-worker-secret': env.INGESTION_WORKER_SECRET, 'content-type': 'application/json' },
      body: '{}',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Never the body: it could carry app internals into this worker's log stream.
    throw new Error(`child consent reap returned HTTP ${res.status}`);
  }
  const body = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || body.ok !== true) throw new Error('child consent reap returned an unexpected body');

  const result: ChildConsentReapResult = {
    ok: true,
    status: res.status,
    deleted: Number(body.deleted ?? 0),
    failed: Number(body.failed ?? 0),
    remaining: Number(body.remaining ?? 0),
  };
  // Counts only — never an id. A child's id is not this worker's business.
  logger.info('child_consent_reap_run', { job: 'child-consent-reap', ...result });
  return result;
}
