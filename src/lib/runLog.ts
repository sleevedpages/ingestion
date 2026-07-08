/**
 * runLog.ts — the shared per-stage observability writer (audit WP-4).
 *
 * ONE row per stage invocation in `ingestion_run_log` (Content migration 0090), covering
 * every worker cron/pipeline stage: tcg-sync, the four image-mirror weekly sub-stages,
 * scrydex-drain, pricecharting-csv/download, news-poll. Mirrors the try/finally discipline
 * `image-mirror.ts`'s `runMirrorJob` already established for its OWN log
 * (`image_mirror_log`) — the row is written even when the stage throws, and a failure to
 * WRITE the row can never mask (or replace) the stage's own error.
 *
 * Deliberately does NOT change any stage function's signature or return type — `runStage`
 * wraps the EXISTING call at the call site, awaits it, and rethrows exactly what it threw
 * (or returns exactly what it resolved), so callers' existing `.catch(err => logger.error(...))`
 * chains keep working unchanged. The stage's resolved value (if any) is stored as
 * best-effort `counts_json` — this table has no fixed per-job schema on purpose, since each
 * stage returns a different shape (or nothing at all).
 */

import { logger } from '../ingestion/logger.js';

export type RunStageStatus = 'success' | 'error';

export interface RunLogEntry {
  job: string;
  stage: string;
  startedAt: string;
  finishedAt: string;
  status: RunStageStatus;
  counts: unknown;
  firstError: string | null;
}

/** Best-effort JSON encode — a stage's return value should always be a plain object, but
 *  this must never be the thing that makes the run log itself blow up. */
function safeStringify(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/**
 * Writes one row to `ingestion_run_log`. NEVER throws — a log-write failure (missing table
 * on an un-migrated DB, a transient D1 error, a malformed `db` in a test double) is caught
 * and logged, never propagated, so it can never mask the stage's own outcome.
 */
export async function writeRunLog(db: D1Database, entry: RunLogEntry): Promise<void> {
  try {
    await db.prepare(`
      INSERT INTO ingestion_run_log (job, stage, started_at, finished_at, status, counts_json, first_error)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      entry.job,
      entry.stage,
      entry.startedAt,
      entry.finishedAt,
      entry.status,
      safeStringify(entry.counts),
      entry.firstError,
    ).run();
  } catch (e) {
    logger.error('ingestion_run_log write failed', { error: String(e), job: entry.job, stage: entry.stage });
  }
}

/**
 * Runs `fn`, timing it and writing exactly one `ingestion_run_log` row for the
 * (job, stage) pair — on success OR failure, via try/finally. Rethrows whatever `fn` threw
 * (preserving existing caller `.catch()` behavior); resolves to whatever `fn` resolved to.
 */
export async function runStage<T>(
  db: D1Database,
  job: string,
  stage: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = new Date().toISOString();
  let status: RunStageStatus = 'success';
  let firstError: string | null = null;
  let result: T | undefined;
  try {
    result = await fn();
    return result;
  } catch (e) {
    status = 'error';
    firstError = String(e);
    throw e;
  } finally {
    const finishedAt = new Date().toISOString();
    await writeRunLog(db, { job, stage, startedAt, finishedAt, status, counts: result, firstError });
  }
}
