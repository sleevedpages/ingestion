/**
 * ebayOrderSync.ts — the eBay Phase-3 ORDER SYNC trigger (Content migration 0133).
 *
 * THE THIRD JOB THAT CALLS OUT INTO CONTENT AND COMPUTES NOTHING — the
 * valueSnapshots.ts / priceAnomalyScan.ts seam, exactly. The whole job is one
 * authenticated HTTP POST: Content polls each linked eBay seller account
 * (sell.fulfillment getOrders), records every order line under its idempotency key, and
 * applies each one — a vendor_sales ledger row (channel='ebay', source='ebay_sync') plus
 * the SAME sanctioned inventory decrement checkout uses. Every piece of that lives in
 * Content, where the checkout core, the encrypted seller tokens and the ledger already
 * live. THIS WORKER NEVER TOUCHES AN EBAY SELLER TOKEN — its own same-named eBay secrets
 * are the unrelated Browse-UPC app credentials (see /ebay/upc); never conflate them.
 *
 * AUTH — the same shared secret, pointed the other way: Content's
 * POST /api/internal/ebay/sync-orders checks `x-worker-secret === INGESTION_WORKER_SECRET`
 * at the top of the handler, fail-closed when unset. No new secret.
 *
 * CONTENT_APP_URL IS REQUIRED — no default origin, on purpose (a prod fallback would let
 * a UAT worker decrement PRODUCTION inventory). Absent → self-skip with a named reason.
 *
 * CADENCE: the every-15-minutes prod cron fires this, but the INTERVAL is
 * config-driven on the Content side (app_config.ebay_order_sync_interval_min — accounts
 * synced more recently are skipped), so slowing the sync is an UPDATE, not a redeploy.
 * Content also self-gates on ebay_listings_enabled (the dark wall's flag half) and
 * ebay_order_sync_enabled (the sync's own kill switch) — a dark or disabled feature makes
 * this POST a cheap no-op, which is why the cron can exist before the feature is lit.
 */

import type { Env } from './worker.js';
import { logger } from './ingestion/logger.js';

/** Path on the Content app. Keep in lockstep with functions/api/internal/ebay/sync-orders.js. */
export const EBAY_ORDER_SYNC_PATH = '/api/internal/ebay/sync-orders';

/**
 * Wall-clock cap on the request. The run pages eBay's order feed per account (each
 * upstream call is itself timed Content-side), so it is not instant — but a hung
 * connection must not sit on the invocation forever. Aborting is SAFE: recorded rows
 * stand, applied rows are terminal, and the next 15-minute tick (or the self-heal sweep)
 * picks up whatever this one did not — nothing is double-decremented.
 */
export const EBAY_ORDER_SYNC_TIMEOUT_MS = 120_000;

export interface EbayOrderSyncRunResult {
  ok: boolean;
  /** Set when the job did not run for a configuration reason (not a failure). */
  skipped?: 'not_configured' | string;
  status?: number;
  accounts?: number;
  synced?: number;
  skippedRecent?: number;
  decremented?: number;
  needsAttention?: number;
  errors?: number;
  truncated?: boolean;
}

/** Resolve the absolute endpoint URL, or null when unset/unusable. */
export function ebayOrderSyncUrl(base: string | undefined | null): string | null {
  const raw = String(base ?? '').trim();
  if (!raw) return null;
  try {
    const u = new URL(EBAY_ORDER_SYNC_PATH, raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Ask the Content app to sync eBay orders for every active linked account.
 *
 * THROWS on a genuine failure (unreachable app, non-2xx, unexpected body) so `runStage`
 * records `status='error'` in ingestion_run_log; the cron call site's `.catch(logger.error)`
 * makes it log-and-continue, and the next 15-minute tick is the retry (everything
 * Content-side is idempotent by the order key). A MISSING CONTENT_APP_URL resolves rather
 * than throwing — not-configured is a state, not an error. A Content-side skip
 * (feature dark / sync disabled) also resolves: the feature being off is not a failed run.
 */
export async function runEbayOrderSync(env: Env): Promise<EbayOrderSyncRunResult> {
  const url = ebayOrderSyncUrl(env.CONTENT_APP_URL);
  if (!url) {
    logger.warn('ebay-order-sync skipped: CONTENT_APP_URL is not set', { job: 'ebay-order-sync' });
    return { ok: false, skipped: 'not_configured' };
  }
  if (!env.INGESTION_WORKER_SECRET) {
    logger.warn('ebay-order-sync skipped: INGESTION_WORKER_SECRET is not set', { job: 'ebay-order-sync' });
    return { ok: false, skipped: 'not_configured' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EBAY_ORDER_SYNC_TIMEOUT_MS);

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
    // Deliberately body-free: a 401 body is uninteresting and a 500 body could carry app
    // internals into this worker's log stream.
    throw new Error(`ebay order sync returned HTTP ${res.status}`);
  }

  const body = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || body.ok !== true) {
    throw new Error('ebay order sync returned an unexpected body');
  }

  if (typeof body.skipped === 'string') {
    // Content declined for a config reason (feature_dark / sync_disabled) — a state, not
    // a failure; keep the run log green and legible.
    logger.info('ebay_order_sync_skipped', { job: 'ebay-order-sync', skipped: body.skipped });
    return { ok: true, skipped: body.skipped, status: res.status };
  }

  const result: EbayOrderSyncRunResult = {
    ok: true,
    status: res.status,
    accounts:       Number(body.accounts ?? 0),
    synced:         Number(body.synced ?? 0),
    skippedRecent:  Number(body.skippedRecent ?? 0),
    decremented:    Number(body.decremented ?? 0),
    needsAttention: Number(body.needsAttention ?? 0),
    errors:         Number(body.errors ?? 0),
    truncated:      body.truncated === true,
  };

  // One structured line so a log search answers "did orders sync this tick" without
  // opening the database. `errors` > 0 means SOME accounts failed and the rest landed.
  logger.info('ebay_order_sync_run', { job: 'ebay-order-sync', ...result });
  return result;
}
