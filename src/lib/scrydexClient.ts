/**
 * Scrydex API fetch wrapper
 *
 * Single entry point for every outbound Scrydex API call in the Ingestion worker.
 * Responsibilities:
 *   - Monthly credit guard: blocks calls when usage >= SCRYDEX_MONTHLY_LIMIT - 500
 *   - Logs every call (success, error, or blocked) to scrydex_api_log
 *   - Logging failures are silently swallowed — they never prevent a response from returning
 */

import type { Env } from '../worker.js'

const SCRYDEX_BASE             = 'https://api.scrydex.com'
const DEFAULT_MONTHLY_LIMIT    = 5000
const VISION_CREDITS           = 5   // Scrydex Vision is a premium endpoint — 5 credits/request

export class ScrydexCreditLimitError extends Error {
  constructor() {
    super('Scrydex monthly credit guard triggered — call blocked to protect monthly limit')
    this.name = 'ScrydexCreditLimitError'
  }
}

/**
 * Statuses that mean "this key will not be served, and retrying now cannot help" — an ACCOUNT-level
 * refusal, as opposed to a transient error worth another attempt:
 *
 *   403  CREDIT_CAP_HIT — the plan's monthly cap is spent (the June 2026 outage).
 *   402  Payment Required — the plan is not currently serving this key (the 2026-08-04 outage:
 *        every call refused for eight days while the daily drain re-attempted 600–1,000 rows a day
 *        against a wall it could not pass, because only 403 broke the circuit).
 *
 * Every loop that fetches per-expansion or per-card MUST break on this, not just on 403.
 */
export const SCRYDEX_REFUSAL_STATUSES: ReadonlySet<number> = new Set([402, 403])

export function isScrydexRefusal(status: number | null | undefined): boolean {
  return status != null && SCRYDEX_REFUSAL_STATUSES.has(status)
}

async function getMonthlyCreditsUsed(db: D1Database): Promise<number> {
  const row = await db.prepare(`
    SELECT COALESCE(SUM(credits_used), 0) AS total
    FROM   scrydex_api_log
    WHERE  status != 'blocked'
    AND    called_at >= datetime('now', 'start of month')
  `).first<{ total: number }>()
  return row?.total ?? 0
}

async function logCall(
  db:             D1Database,
  endpoint:       string,
  jobName:        string,
  status:         'success' | 'error' | 'blocked',
  responseStatus: number | null,
  creditsUsed:    number,
  notes:          string | null,
): Promise<void> {
  await db.prepare(`
    INSERT INTO scrydex_api_log
      (endpoint, job_name, response_status, credits_used, status, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(endpoint, jobName, responseStatus, creditsUsed, status, notes).run()
}

/**
 * Make an authenticated Scrydex API request, enforcing the monthly credit guard
 * and logging every call to scrydex_api_log.
 *
 * @param env      - Worker env bindings (needs DB, SCRYDEX_API_KEY, SCRYDEX_TEAM_ID)
 * @param endpoint - Path portion of the URL, e.g. '/pokemon/v1/cards'
 * @param jobName  - Human-readable caller name written to the log, e.g. 'syncScrydexImages'
 * @param options  - Optional query params
 * @throws ScrydexCreditLimitError when the monthly guard blocks the call
 * @throws Error on network failure or non-OK response (429, 5xx, etc.)
 * @returns The raw Response — callers check .ok and call .json() as needed
 */
export async function scrydexFetch(
  env:      Env,
  endpoint: string,
  jobName:  string,
  options?: { params?: Record<string, string> },
): Promise<Response> {
  const monthlyLimit    = env.SCRYDEX_MONTHLY_LIMIT ? parseInt(env.SCRYDEX_MONTHLY_LIMIT, 10) : DEFAULT_MONTHLY_LIMIT
  const guardThreshold  = monthlyLimit - 500

  // ── Monthly credit guard ──────────────────────────────────────────────────
  let currentUsage = 0
  try {
    currentUsage = await getMonthlyCreditsUsed(env.DB)
  } catch {
    // DB read failure → allow the call through; don't block on a monitoring error
  }

  if (currentUsage >= guardThreshold) {
    try {
      await logCall(env.DB, endpoint, jobName, 'blocked', null, 0, 'Monthly credit guard triggered')
    } catch {
      // non-blocking
    }
    throw new ScrydexCreditLimitError()
  }

  // ── Build URL ─────────────────────────────────────────────────────────────
  const url = new URL(`${SCRYDEX_BASE}${endpoint}`)
  for (const [k, v] of Object.entries(options?.params ?? {})) {
    url.searchParams.set(k, v)
  }

  // ── Make the request ──────────────────────────────────────────────────────
  let response: Response
  try {
    response = await fetch(url.toString(), {
      headers: {
        'X-Api-Key': env.SCRYDEX_API_KEY!,
        'X-Team-ID': env.SCRYDEX_TEAM_ID!,
        'Accept':    'application/json',
      },
    })
  } catch (err) {
    try {
      // A call that never reached Scrydex served no data and is not billable — see below.
      await logCall(env.DB, endpoint, jobName, 'error', null, 0, String(err))
    } catch {
      // non-blocking
    }
    throw err
  }

  // ── Log the result ────────────────────────────────────────────────────────
  // ⚠️ A FAILED CALL COSTS 0 CREDITS (2026-08-12). This row is what `getMonthlyCreditsUsed` sums to
  // decide whether to block, so charging failures against the guard means an OUTAGE eats the budget:
  // the 2026-08-04 402 wall alone booked 5,295 phantom credits in a single month, which on a
  // correctly-set limit would have locked the worker out well after the provider had recovered. The
  // row is still written with its real status — attempt volume stays visible in the burn tooling —
  // it simply no longer counts against a cap it never spent.
  const logStatus = response.ok ? 'success' : 'error'
  const logNotes  = response.ok ? null : `HTTP ${response.status}`
  try {
    await logCall(env.DB, endpoint, jobName, logStatus, response.status, response.ok ? 1 : 0, logNotes)
  } catch {
    // non-blocking — a logging failure must never prevent the response from returning
  }

  return response
}

/**
 * Scrydex Vision — identify a card from an image (POST /vision/v1/cards/identify).
 *
 * A premium endpoint billed at VISION_CREDITS (5) credits/request, so it goes through
 * the SAME monthly credit guard + scrydex_api_log accounting as every other Scrydex
 * call (the documented single entry point). Sends multipart/form-data (image + optional
 * comma-separated `games` scope). Returns the raw Response so the caller can apply its
 * own 403/circuit-breaker handling and parse the body.
 *
 * @param env   Worker bindings (DB, SCRYDEX_API_KEY, SCRYDEX_TEAM_ID, SCRYDEX_MONTHLY_LIMIT?)
 * @param image The card image as a Blob/File
 * @param games Optional comma-separated TCG scope, e.g. 'pokemon' (improves speed/accuracy)
 * @throws ScrydexCreditLimitError when the monthly guard blocks the call
 */
export async function scrydexVisionIdentify(
  env:   Env,
  image: Blob,
  games?: string,
): Promise<Response> {
  const endpoint = '/vision/v1/cards/identify'
  const jobName  = 'visionIdentify'

  const monthlyLimit   = env.SCRYDEX_MONTHLY_LIMIT ? parseInt(env.SCRYDEX_MONTHLY_LIMIT, 10) : DEFAULT_MONTHLY_LIMIT
  const guardThreshold = monthlyLimit - 500

  // ── Monthly credit guard (Vision costs 5; guard on current usage) ───────────
  let currentUsage = 0
  try {
    currentUsage = await getMonthlyCreditsUsed(env.DB)
  } catch {
    // DB read failure → allow the call; don't block on a monitoring error
  }
  if (currentUsage >= guardThreshold) {
    try {
      await logCall(env.DB, endpoint, jobName, 'blocked', null, 0, 'Monthly credit guard triggered')
    } catch { /* non-blocking */ }
    throw new ScrydexCreditLimitError()
  }

  // ── Build multipart body — do NOT set Content-Type; fetch sets the boundary ──
  const form = new FormData()
  form.append('image', image, 'card.jpg')
  if (games) form.append('games', games)

  let response: Response
  try {
    response = await fetch(`${SCRYDEX_BASE}${endpoint}`, {
      method: 'POST',
      headers: {
        'X-Api-Key': env.SCRYDEX_API_KEY!,
        'X-Team-ID': env.SCRYDEX_TEAM_ID!,
        'Accept':    'application/json',
      },
      body: form,
    })
  } catch (err) {
    try {
      await logCall(env.DB, endpoint, jobName, 'error', null, 0, String(err))
    } catch { /* non-blocking */ }
    throw err
  }

  try {
    // Same rule as scrydexFetch: only a served response is billable (5 credits for Vision).
    await logCall(
      env.DB, endpoint, jobName,
      response.ok ? 'success' : 'error',
      response.status,
      response.ok ? VISION_CREDITS : 0,
      response.ok ? null : `HTTP ${response.status}`,
    )
  } catch { /* non-blocking */ }

  return response
}

/**
 * Delete scrydex_api_log rows older than 90 days.
 * Called from the weekly cron handler.
 */
export async function cleanupScrydexApiLog(db: D1Database): Promise<void> {
  await db.prepare(
    "DELETE FROM scrydex_api_log WHERE called_at < datetime('now', '-90 days')"
  ).run()
}
