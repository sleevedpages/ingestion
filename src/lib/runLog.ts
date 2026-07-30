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

/**
 * The status a START row carries until its stage reaches a terminal path. A row still
 * showing this with `finished_at IS NULL` long after `started_at` is the "died mid-stage"
 * signal — see the START-ROW CONTRACT below. Content's
 * `GET /api/admin/ingestion/jobs` classifies it (running vs stuck).
 */
export const RUN_STAGE_RUNNING = 'running';

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
 * Writes the START row and returns its id — or `null` if anything at all went wrong
 * (un-migrated table, transient D1 error, a test double with no `.first()`, a driver that
 * doesn't honour RETURNING). NEVER throws and NEVER blocks: a start-row failure must not
 * be able to stop the stage from running, so the caller simply falls back to the legacy
 * write-one-terminal-row-at-the-end behaviour.
 */
async function writeRunStart(
  db: D1Database,
  job: string,
  stage: string,
  startedAt: string,
): Promise<number | null> {
  try {
    const row = await db.prepare(`
      INSERT INTO ingestion_run_log (job, stage, started_at, finished_at, status)
      VALUES (?, ?, ?, NULL, ?)
      RETURNING id
    `).bind(job, stage, startedAt, RUN_STAGE_RUNNING).first<{ id: number }>();
    const id = Number(row?.id);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch (e) {
    logger.error('ingestion_run_log start write failed', { error: String(e), job, stage });
    return null;
  }
}

/**
 * Closes out a START row. Returns false when there was no row to update (no id, or the row
 * vanished), so the caller can fall back to the legacy terminal INSERT and the log still
 * ends up with exactly ONE row per invocation. NEVER throws.
 */
async function finishRunLog(db: D1Database, id: number, entry: RunLogEntry): Promise<boolean> {
  try {
    const res = await db.prepare(`
      UPDATE ingestion_run_log
         SET finished_at = ?, status = ?, counts_json = ?, first_error = ?
       WHERE id = ?
    `).bind(entry.finishedAt, entry.status, safeStringify(entry.counts), entry.firstError, id).run();
    // A driver that doesn't report `changes` must not send us down the duplicate-row path.
    const changes = (res as { meta?: { changes?: number } } | undefined)?.meta?.changes;
    return changes === undefined || changes > 0;
  } catch (e) {
    logger.error('ingestion_run_log finish write failed', { error: String(e), job: entry.job, stage: entry.stage });
    return false;
  }
}

/**
 * Runs `fn`, timing it and recording exactly one `ingestion_run_log` row for the
 * (job, stage) pair. Rethrows whatever `fn` threw (preserving existing caller `.catch()`
 * behavior); resolves to whatever `fn` resolved to.
 *
 * ── START-ROW CONTRACT (2026-07-30) ───────────────────────────────────────────────
 * The row used to be written ONLY in `finally`, which meant an invocation killed
 * mid-stage — precisely the `waitUntil` death the image-pipeline audit named as the
 * silent failure mode — left NO row at all. The observability floor was blind to exactly
 * the failure it was built to catch: a stage that died looked identical to a stage that
 * never ran.
 *
 * So a START row is written up front (`finished_at NULL`, `status='running'`) and UPDATEd
 * on the terminal path. `ingestion_run_log.finished_at` was already nullable (Content
 * mig 0090) — **no migration is required for this.** The signals:
 *   • finished_at NOT NULL          → the stage completed; status is its real outcome.
 *   • finished_at NULL, recent      → the stage is in flight right now.
 *   • finished_at NULL, long stale  → THE SIGNAL: the invocation died mid-stage.
 * Content classifies the last two (`GET /api/admin/ingestion/jobs` → `state`), so a
 * NULL-finish row is surfaced rather than quietly ignored.
 *
 * Neither write is allowed to be a failure point: if the START write fails we fall back to
 * the legacy single terminal INSERT, and if the UPDATE finds no row we insert one. Either
 * way the stage runs, its result/error is untouched, and the log gets exactly one row.
 */
export async function runStage<T>(
  db: D1Database,
  job: string,
  stage: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = new Date().toISOString();
  const runId = await writeRunStart(db, job, stage, startedAt);
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
    const entry: RunLogEntry = { job, stage, startedAt, finishedAt, status, counts: result, firstError };
    const closed = runId != null && await finishRunLog(db, runId, entry);
    if (!closed) await writeRunLog(db, entry);
  }
}
