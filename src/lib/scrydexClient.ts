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

export class ScrydexCreditLimitError extends Error {
  constructor() {
    super('Scrydex monthly credit guard triggered — call blocked to protect monthly limit')
    this.name = 'ScrydexCreditLimitError'
  }
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
      await logCall(env.DB, endpoint, jobName, 'error', null, 1, String(err))
    } catch {
      // non-blocking
    }
    throw err
  }

  // ── Log the result ────────────────────────────────────────────────────────
  const logStatus = response.ok ? 'success' : 'error'
  const logNotes  = response.ok ? null : `HTTP ${response.status}`
  try {
    await logCall(env.DB, endpoint, jobName, logStatus, response.status, 1, logNotes)
  } catch {
    // non-blocking — a logging failure must never prevent the response from returning
  }

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
