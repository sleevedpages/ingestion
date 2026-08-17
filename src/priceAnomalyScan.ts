/**
 * priceAnomalyScan.ts — the nightly pricing anomaly sentinel trigger (Content migration 0129).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THIS WORKER PRICES NOTHING (the value-snapshots seam, exactly)
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The whole job is one authenticated HTTP POST. The detection rules run against the provenance
 * chain (`MARKET_PRICE_CHAIN_SQL`) and that chain lives in the Content app — re-implementing any
 * rung here would fork "what is this card worth" into two drifting answers, which is the exact
 * failure class the sentinel exists to catch. So the SCHEDULE lives here (Content is a Pages
 * project and cannot cron) and the COMPUTE lives in Content
 * (`POST /api/internal/price-anomalies/run`). Report-only: the scan writes `price_anomalies`
 * rows for the admin panel and never changes a served price.
 *
 * WHY 08:00 UTC. The scan must read the day's FRESH prices: the Scrydex drain lands at 04:00,
 * the PriceCharting fetch at 05:00 (its queue PROCESS finishes well within the hour at current
 * category sizes), and the TCG sync at 06:00. 07:00 is taken (news-poll), so 08:00 is the first
 * free hour after the whole ingest block — and comfortably before the 10:00 value snapshot, so
 * an operator can act on a currency-scale anomaly before it is snapshotted into the value
 * series. PROD ONLY — never added to [env.preview.triggers] (UAT fires it on demand via
 * POST /admin/run-job { job: 'price-anomaly-scan' }, the news-poll precedent).
 *
 * AUTH + CONTENT_APP_URL: identical to valueSnapshots.ts — the same shared secret pointed
 * outbound, and NO fallback origin (a hardcoded prod URL would make a UAT worker scan the
 * production DB); an absent CONTENT_APP_URL self-skips with a named reason.
 */

import type { Env } from './worker.js';
import { logger } from './ingestion/logger.js';

/** Path on the Content app. Keep in lockstep with functions/api/internal/price-anomalies/run.js. */
export const ANOMALY_SCAN_RUN_PATH = '/api/internal/price-anomalies/run';

/**
 * Wall-clock cap on the request. The scan is a handful of set-based passes over `prices` plus
 * bounded upserts — heavier than the snapshot POST, so it gets a wider budget. Aborting is
 * SAFE: detection upserts per (product, rule) and the baseline refresh is change-filtered, so
 * whatever landed before the abort is kept and the next run re-detects the rest.
 */
export const ANOMALY_SCAN_REQUEST_TIMEOUT_MS = 120_000;

export interface PriceAnomalyScanResult {
  ok: boolean;
  /** Set when the job did not run for a configuration reason (not a failure). */
  skipped?: 'not_configured';
  status?: number;
  scanRun?: number;
  scanned?: number;
  detected?: number;
  newAnomalies?: number;
  resolved?: number;
  open?: number;
  byRule?: Record<string, number>;
  ruleErrors?: string[];
}

/** Resolve the absolute endpoint URL, or null when unset/unusable. */
export function anomalyScanRunUrl(base: string | undefined | null): string | null {
  const raw = String(base ?? '').trim();
  if (!raw) return null;
  try {
    const u = new URL(ANOMALY_SCAN_RUN_PATH, raw);
    // http(s) only — a stray `file:`/`data:` value in config must never become a fetch target.
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Ask the Content app to run the price sanity scan.
 *
 * THROWS on a genuine failure (unreachable app, non-2xx, unparseable body) so `runStage`
 * records `status='error'` in `ingestion_run_log` — the observability row IS the alerting for
 * a failed scan. The cron call site catches it (`.catch(logger.error)`), which makes the
 * failure log-and-continue: it can never touch the Scrydex/PriceCharting/TCG jobs (separate
 * cron cases, separate invocations). No retry — the scan is nightly and re-detection is
 * idempotent, so tomorrow's run (or a manual fire from the admin panel) is the retry.
 *
 * A MISSING `CONTENT_APP_URL` resolves rather than throwing: not-configured is a state, not an
 * error, and it must be legible in the run log instead of buried in a stack string.
 */
export async function runPriceAnomalyScan(env: Env): Promise<PriceAnomalyScanResult> {
  const url = anomalyScanRunUrl(env.CONTENT_APP_URL);
  if (!url) {
    logger.warn('price-anomaly-scan skipped: CONTENT_APP_URL is not set', { job: 'price-anomaly-scan' });
    return { ok: false, skipped: 'not_configured' };
  }
  if (!env.INGESTION_WORKER_SECRET) {
    logger.warn('price-anomaly-scan skipped: INGESTION_WORKER_SECRET is not set', { job: 'price-anomaly-scan' });
    return { ok: false, skipped: 'not_configured' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANOMALY_SCAN_REQUEST_TIMEOUT_MS);

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
    throw new Error(`price anomaly scan returned HTTP ${res.status}`);
  }

  const body = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || body.ok !== true) {
    throw new Error('price anomaly scan returned an unexpected body');
  }

  const result: PriceAnomalyScanResult = {
    ok: true,
    status: res.status,
    scanRun:      Number(body.scanRun ?? 0),
    scanned:      Number(body.scanned ?? 0),
    detected:     Number(body.detected ?? 0),
    newAnomalies: Number(body.new ?? 0),
    resolved:     Number(body.resolved ?? 0),
    open:         Number(body.open ?? 0),
    byRule:       (body.by_rule ?? {}) as Record<string, number>,
    ruleErrors:   Array.isArray(body.ruleErrors) ? body.ruleErrors as string[] : [],
  };

  // One structured line so a log search answers "what did last night's scan find" without
  // opening the database. `ruleErrors` non-empty means SOME rules failed and the rest ran.
  logger.info('price_anomaly_scan_run', { job: 'price-anomaly-scan', ...result });
  return result;
}
