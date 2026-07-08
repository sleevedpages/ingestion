// Admin-triggered manual runs of the four scheduled Ingestion cron jobs.
//
// These let an admin fire the SAME job functions the cron handler calls, on demand, from
// the Content admin portal (proxied to `POST /admin/run-job`, x-worker-secret). The cron
// handler (`worker.ts` `scheduled`) and the manual trigger share the code here, so there is
// ONE implementation per job — no duplicated logic.
//
// The four prod crons (`wrangler.toml` [triggers]) and what each runs:
//   0 6 * * *    tcg-sync          → runIngestion()                 (worker.ts default case)
//   0 3 * * SUN  image-mirror      → runWeeklyImagePipeline()        (this file)
//   0 4 * * *    scrydex-drain     → processPendingWebhooks()        (scrydexProcessor.ts)
//   0 5 * * *    (PriceCharting)   → runPriceChartingFetch()         (pricechartingIngest.ts)
//
// PriceCharting is FETCH/PROCESS-split (pricechartingIngest.ts): the daily cron FETCHes one
// rotated category's CSV → R2 (the only download; arms the 10-min cooldown) then the dedicated
// PC_PROCESS_QUEUE ingests the WHOLE category from that cached file. The two admin job ids map to
// the two halves: `pricecharting-csv` = PROCESS the cached R2 file (no download, unlimited);
// `pricecharting-download` = FETCH fresh → PROCESS (cooldown-gated). The job bodies live in
// pricechartingIngest.ts; the worker run-job switch calls them.

import type { Env } from './worker.js';
import { runMirrorJob } from './image-mirror.js';
import { syncScrydexSetMappings } from './scrydexSetMapping.js';
import { syncScrydexImages } from './scrydexImageSync.js';
import { cleanupScrydexApiLog } from './lib/scrydexClient.js';
import { PRICECHARTING_CATEGORIES, type PriceChartingCategory } from './lib/pricechartingCsv.js';
import { runStage } from './lib/runLog.js';
import { logger } from './ingestion/logger.js';

export type AdminJobId =
  | 'tcg-sync'
  | 'image-mirror'
  | 'scrydex-drain'
  | 'pricecharting-csv'        // PROCESS the cached R2 CSV (no download, unlimited, safe)
  | 'pricecharting-download'   // FETCH a fresh CSV → R2 (the only download; cooldown-gated) then PROCESS
  | 'news-poll';               // poll the DotGG RSS feeds → upsert news_items (link-out only; no API key)

export const ADMIN_JOB_IDS: AdminJobId[] = [
  'tcg-sync',
  'image-mirror',
  'scrydex-drain',
  'pricecharting-csv',
  'pricecharting-download',
  'news-poll',
];

export function isAdminJobId(value: unknown): value is AdminJobId {
  return typeof value === 'string' && (ADMIN_JOB_IDS as string[]).includes(value);
}

// ── Weekly image pipeline ─────────────────────────────────────────────────────
// The EXACT sequence the `0 3 * * SUN` cron runs. Called by BOTH the cron handler and the
// manual `image-mirror` trigger, so there is a single source of truth. The Scrydex sub-steps
// are guarded (skipped when keys are absent — e.g. UAT); the R2 mirror (Infinity batches) and
// the api-log cleanup always run.
//
// ORDER IS LOAD-BEARING (WP-2, audit IMG-3): the MIRROR runs FIRST. The 2026-07-05 run died
// inside the Scrydex sync stages and the mirror never executed (no image_mirror_log row at
// all). Mirror-first guarantees the mirror stage always gets budget: it consumes the
// source_urls the PREVIOUS week's sync wrote, and this week's sync then refreshes them for
// the next run. The sync stages run after, with whatever budget remains.
//
// Each of the four sub-stages is ALSO wrapped in `runStage` (audit WP-4, `lib/runLog.ts`) —
// one `ingestion_run_log` row per stage, success or failure, alongside the existing
// `.catch(logger.error)` (unchanged — `runStage` rethrows so that chain still fires).
export async function runWeeklyImagePipeline(env: Env): Promise<void> {
  await runStage(env.DB, 'image-mirror', 'mirror', () =>
    runMirrorJob({ DB: env.DB, IMAGES_BUCKET: env.IMAGES_BUCKET }, Infinity))
    .catch((err) => logger.error('Scheduled mirror failed', { error: String(err) }));
  if (env.SCRYDEX_API_KEY && env.SCRYDEX_TEAM_ID) {
    await runStage(env.DB, 'image-mirror', 'scrydex-set-mappings', () => syncScrydexSetMappings(env))
      .catch((err) => logger.error('Scrydex set mapping failed', { error: String(err) }));
    await runStage(env.DB, 'image-mirror', 'scrydex-image-sync', () => syncScrydexImages(env))
      .catch((err) => logger.error('Scrydex image sync failed', { error: String(err) }));
  }
  await runStage(env.DB, 'image-mirror', 'api-log-cleanup', () => cleanupScrydexApiLog(env.DB))
    .catch((err) => logger.error('scrydex_api_log cleanup failed', { error: String(err) }));
}

// ── PriceCharting day-rotated category ────────────────────────────────────────
// The `0 5 * * *` cron pulls ONE category/run, rotated by day across a 4-day cycle. A manual
// run picks the SAME category the cron would today, so the on-demand pull stays faithful to
// the scheduled behaviour.
export function priceChartingCategoryForDay(now: number = Date.now()): PriceChartingCategory {
  const idx = Math.floor(now / 86_400_000) % PRICECHARTING_CATEGORIES.length;
  return PRICECHARTING_CATEGORIES[idx];
}

// ── Double-fire guard (best-effort KV lock) ───────────────────────────────────
// A manual run sets a KV lock for the job and clears it when the job settles; a second
// trigger while the lock is held is rejected (409). The TTL is the backstop if the worker
// dies mid-run. KV is eventually consistent (~seconds), so this guards refresh / second-tab /
// multi-minute re-fires; the admin UI's button-disable handles rapid same-tab mashing. The
// Content status endpoint reads these SAME keys (shared SLEEVEDPAGES_KV namespace) to show a
// job as "running" — keep `JOB_LOCK_PREFIX` in sync with
// `Content/functions/api/admin/ingestion/jobs.js`.
export const JOB_LOCK_PREFIX = 'ingestion_job_lock:';

const JOB_LOCK_TTL_SECONDS: Record<AdminJobId, number> = {
  'tcg-sync': 1800, // full sync is long-running; generous backstop
  'image-mirror': 3600, // Infinity-batch mirror can run long
  'scrydex-drain': 1200,
  'pricecharting-csv': 600,      // fire-and-forget enqueue (the queue does the work); guard rapid re-fire
  'pricecharting-download': 600, // download + enqueue; the 10-min cooldown is the real rate guard
  'news-poll': 600,              // a handful of feeds; quick, but guard rapid re-fire
};

export async function isJobRunning(env: Env, job: AdminJobId): Promise<boolean> {
  if (!env.SLEEVEDPAGES_KV) return false;
  return (await env.SLEEVEDPAGES_KV.get(JOB_LOCK_PREFIX + job)) !== null;
}

// Returns false when the job is already locked (caller must NOT start a second run).
export async function acquireJobLock(env: Env, job: AdminJobId): Promise<boolean> {
  if (!env.SLEEVEDPAGES_KV) return true; // no KV bound → can't lock; allow (best-effort)
  if (await env.SLEEVEDPAGES_KV.get(JOB_LOCK_PREFIX + job)) return false;
  await env.SLEEVEDPAGES_KV.put(JOB_LOCK_PREFIX + job, new Date().toISOString(), {
    expirationTtl: JOB_LOCK_TTL_SECONDS[job],
  });
  return true;
}

export async function releaseJobLock(env: Env, job: AdminJobId): Promise<void> {
  if (!env.SLEEVEDPAGES_KV) return;
  await env.SLEEVEDPAGES_KV.delete(JOB_LOCK_PREFIX + job).catch(() => {});
}

// ── PriceCharting CSV download cooldown ───────────────────────────────────────
// PriceCharting's per-game CSV download is HARD rate-limited to ~1 per 10 minutes (abuse →
// account revocation), and the CSV only regenerates ~once/24h. The in-flight lock above
// releases on completion (~20s), which does NOT cover that 10-minute window, so the
// pricecharting-csv job is additionally gated by a download cooldown set whenever a download
// is initiated (manual trigger OR the daily cron). The value is the unix-ms expiry so the
// status endpoint can show a countdown. Keep PC_CSV_COOLDOWN_KEY in sync with
// `Content/functions/api/admin/ingestion/jobs.js`.
export const PC_CSV_COOLDOWN_KEY = 'ingestion_pc_csv_cooldown';
const PC_CSV_COOLDOWN_SECONDS = 660; // just over the 10-minute download limit

// Seconds left on the cooldown (0 = clear / no KV bound).
export async function priceChartingCooldownRemaining(env: Env): Promise<number> {
  if (!env.SLEEVEDPAGES_KV) return 0;
  const v = await env.SLEEVEDPAGES_KV.get(PC_CSV_COOLDOWN_KEY);
  if (!v) return 0;
  const expiresAt = Number(v);
  if (!Number.isFinite(expiresAt)) return PC_CSV_COOLDOWN_SECONDS; // present but odd → treat as cooling
  const remMs = expiresAt - Date.now();
  return remMs > 0 ? Math.ceil(remMs / 1000) : 0;
}

export async function startPriceChartingCooldown(env: Env): Promise<void> {
  if (!env.SLEEVEDPAGES_KV) return;
  const expiresAt = Date.now() + PC_CSV_COOLDOWN_SECONDS * 1000;
  await env.SLEEVEDPAGES_KV.put(PC_CSV_COOLDOWN_KEY, String(expiresAt), {
    expirationTtl: PC_CSV_COOLDOWN_SECONDS,
  }).catch(() => {});
}
