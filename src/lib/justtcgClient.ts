/**
 * justtcgClient.ts — the SINGLE JustTCG entry point for the Ingestion worker (probe only, 2026-10-05).
 *
 * JustTCG (https://justtcg.com/docs) is being EVALUATED as the replacement for Scrydex's condition
 * tiers / graded matrix / trends / history. Nothing in this file is reachable from a cron, a queue
 * consumer or any read path — only `POST /admin/justtcg-probe` (x-worker-secret) calls it, and the
 * probe writes NOTHING to D1. Production never reads JustTCG live; the app reads our own `prices`.
 *
 * STANDING RULES (session 2026-10-05):
 *   • Documented API only, with an API key (`x-api-key`). Never justtcg.com HTML, never an
 *     undocumented route. Base URL + every shape here was pinned from the published OpenAPI spec
 *     (https://justtcg.com/docs/swagger.json, read 2026-10-05) and is re-pinned from ONE live UAT
 *     call before any parser is trusted (the audit doc records what was observed).
 *   • The Free tier is "for personal, non-commercial use" — UAT ONLY. `JUSTTCG_API_KEY` goes on the
 *     UAT worker (`wrangler secret put JUSTTCG_API_KEY --env preview`), never on prod, never in the
 *     Content app, never logged, never returned. Unset → every caller fails CLOSED with
 *     `JustTcgError('not_configured')` → the route answers 503 `justtcg_not_configured`.
 *   • A per-day call counter in KV (`justtcg_calls:<YYYY-MM-DD>`, UTC — JustTCG's daily window
 *     resets at 00:00 UTC) refuses to exceed the plan's daily cap minus a reserve. Free plan:
 *     100 calls/day, 10/min, 20 cards per batch request (Starter: 1,000/day, 50/min, 100/batch;
 *     Pro: 5,000/day, 100/min, 100/batch — https://justtcg.com/docs/rate-limits). The counter is
 *     the WORKER's own ledger (JustTCG also reports `_metadata.apiDailyRequestsUsed` on v1 — the
 *     probe records both so drift is visible). A KV counter is not atomic; the reserve absorbs the
 *     race, and this is a probe, not a production path.
 *   • Typed errors: 401/403 → `auth`; 429 → `rate_limit` (per-minute) or `quota`
 *     (DAILY_LIMIT_EXCEEDED / REQUEST_LIMIT_EXCEEDED); the counter → `cap`; a timeout → `timeout`.
 *     The caller (the probe) stops the run on `auth`/`quota`/`cap` and reports `capHit`, never retries
 *     into a wall.
 */

import type { Env } from '../worker.js'

export const JUSTTCG_BASE = 'https://api.justtcg.com'

/** Free-plan defaults. Override per environment with JUSTTCG_DAILY_CAP / JUSTTCG_DAILY_RESERVE /
 *  JUSTTCG_BATCH_SIZE / JUSTTCG_MIN_INTERVAL_MS once a paid plan exists. */
export const DEFAULT_DAILY_CAP      = 100
export const DEFAULT_DAILY_RESERVE  = 10
export const DEFAULT_BATCH_SIZE     = 20
/** 10 calls/min on Free → 6,500 ms between calls keeps a run under the per-minute limit. */
export const DEFAULT_MIN_INTERVAL_MS = 6500
export const REQUEST_TIMEOUT_MS     = 20_000

export type JustTcgErrorKind =
  | 'not_configured' | 'cap' | 'auth' | 'rate_limit' | 'quota' | 'http' | 'network' | 'timeout'

export class JustTcgError extends Error {
  constructor(
    public kind:   JustTcgErrorKind,
    message:       string,
    public status: number | null = null,
    public code:   string | null = null,
  ) {
    super(message)
    this.name = 'JustTcgError'
  }
}

/** True when a key is present. The key's VALUE never leaves this module. */
export function justtcgConfigured(env: Pick<Env, 'JUSTTCG_API_KEY'>): boolean {
  return typeof env.JUSTTCG_API_KEY === 'string' && env.JUSTTCG_API_KEY.trim().length > 0
}

function intEnv(v: string | undefined, dflt: number): number {
  const n = v == null ? NaN : parseInt(v, 10)
  return Number.isFinite(n) && n >= 0 ? n : dflt
}

export function justtcgLimits(env: Pick<Env, 'JUSTTCG_DAILY_CAP' | 'JUSTTCG_DAILY_RESERVE' | 'JUSTTCG_BATCH_SIZE' | 'JUSTTCG_MIN_INTERVAL_MS'>) {
  return {
    dailyCap:      intEnv(env.JUSTTCG_DAILY_CAP, DEFAULT_DAILY_CAP),
    dailyReserve:  intEnv(env.JUSTTCG_DAILY_RESERVE, DEFAULT_DAILY_RESERVE),
    batchSize:     Math.max(1, intEnv(env.JUSTTCG_BATCH_SIZE, DEFAULT_BATCH_SIZE)),
    minIntervalMs: intEnv(env.JUSTTCG_MIN_INTERVAL_MS, DEFAULT_MIN_INTERVAL_MS),
  }
}

/** `justtcg_calls:<YYYY-MM-DD>` — the UTC day, matching JustTCG's 00:00 UTC daily reset. */
export function dailyCounterKey(now: Date = new Date()): string {
  return `justtcg_calls:${now.toISOString().slice(0, 10)}`
}

export interface CounterState { used: number; cap: number; reserve: number; allowed: number }

/** Read the day's counter without reserving. Absent KV → refuses (fail closed: no ledger, no calls). */
export async function readDailyCounter(env: Env, now: Date = new Date()): Promise<CounterState> {
  const { dailyCap, dailyReserve } = justtcgLimits(env)
  if (!env.SLEEVEDPAGES_KV) throw new JustTcgError('not_configured', 'SLEEVEDPAGES_KV is not bound — the daily call counter cannot be kept, so no JustTCG call is made')
  const raw  = await env.SLEEVEDPAGES_KV.get(dailyCounterKey(now))
  const used = raw ? parseInt(raw, 10) || 0 : 0
  return { used, cap: dailyCap, reserve: dailyReserve, allowed: Math.max(0, dailyCap - dailyReserve) }
}

/**
 * Reserve ONE call against the day's counter. Throws `cap` when used >= cap − reserve. The counter
 * is incremented BEFORE the HTTP call (a failed call still spent a request on JustTCG's side).
 */
export async function reserveDailyCall(env: Env, now: Date = new Date()): Promise<CounterState> {
  const state = await readDailyCounter(env, now)
  if (state.used >= state.allowed) {
    throw new JustTcgError('cap', `JustTCG daily call counter at ${state.used}/${state.allowed} (cap ${state.cap} − reserve ${state.reserve}) — refusing`)
  }
  const next = state.used + 1
  // 2-day TTL: the key outlives the UTC day it names and then expires on its own.
  await env.SLEEVEDPAGES_KV!.put(dailyCounterKey(now), String(next), { expirationTtl: 2 * 86_400 })
  return { ...state, used: next }
}

export interface JustTcgUsage {
  apiPlan?:                string
  apiRequestLimit?:        number
  apiRequestsUsed?:        number
  apiRequestsRemaining?:   number
  apiDailyLimit?:          number
  apiDailyRequestsUsed?:   number
  apiRateLimit?:           number
}

export interface JustTcgResponse<T = unknown> {
  status:  number
  body:    T
  /** v1 responses carry `_metadata` (UsageMetadata); v2 responses do not. */
  usage:   JustTcgUsage | null
  counter: CounterState
}

interface FetchOpts {
  method?: 'GET' | 'POST'
  query?:  Record<string, string | undefined>
  body?:   unknown
  jobName: string
}

/**
 * One authenticated JustTCG request: counter → fetch (20 s timeout) → typed errors. Returns the
 * parsed body for 2xx. The key is sent ONLY as the `x-api-key` header and appears in no log line.
 */
export async function justtcgFetch<T = unknown>(env: Env, path: string, opts: FetchOpts): Promise<JustTcgResponse<T>> {
  if (!justtcgConfigured(env)) throw new JustTcgError('not_configured', 'JUSTTCG_API_KEY is not configured')
  const counter = await reserveDailyCall(env)

  const url = new URL(`${JUSTTCG_BASE}${path}`)
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v != null && v !== '') url.searchParams.set(k, v)

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(url.toString(), {
      method:  opts.method ?? 'GET',
      headers: {
        'x-api-key':    env.JUSTTCG_API_KEY!,
        'accept':       'application/json',
        ...(opts.body != null ? { 'content-type': 'application/json' } : {}),
      },
      body:   opts.body != null ? JSON.stringify(opts.body) : undefined,
      signal: ac.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    const aborted = (err as { name?: string })?.name === 'AbortError'
    throw new JustTcgError(aborted ? 'timeout' : 'network', `${opts.jobName}: ${aborted ? `timed out after ${REQUEST_TIMEOUT_MS} ms` : String(err)}`)
  }
  clearTimeout(timer)

  const text = await res.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch { body = null }
  // v1 errors are `{ error, code }`; v2 errors are RFC 7807 problem+json `{ type, title, status,
  // detail, code }` (observed 2026-10-05: a v2 graded lookup answered 404 with a problem body) —
  // fold both into one { error, code } view so the recorded message carries the reason.
  const raw = (body ?? {}) as { error?: string; code?: string; title?: string; detail?: string }
  const problemText = [raw.title, raw.detail].filter(Boolean).join(': ')
  const errBody = { error: raw.error ?? (problemText || undefined), code: raw.code }

  if (res.status === 401 || res.status === 403) {
    throw new JustTcgError('auth', `${opts.jobName}: JustTCG ${res.status} ${errBody.code ?? ''} ${errBody.error ?? ''}`.trim(), res.status, errBody.code ?? null)
  }
  if (res.status === 429) {
    const code = errBody.code ?? null
    const kind: JustTcgErrorKind = (code === 'DAILY_LIMIT_EXCEEDED' || code === 'REQUEST_LIMIT_EXCEEDED') ? 'quota' : 'rate_limit'
    throw new JustTcgError(kind, `${opts.jobName}: JustTCG 429 ${code ?? ''} ${errBody.error ?? ''}`.trim(), 429, code)
  }
  if (!res.ok) {
    throw new JustTcgError('http', `${opts.jobName}: JustTCG HTTP ${res.status} ${errBody.code ?? ''} ${errBody.error ?? ''}`.trim(), res.status, errBody.code ?? null)
  }
  const usage = (body && typeof body === 'object' && '_metadata' in (body as object))
    ? ((body as { _metadata?: JustTcgUsage })._metadata ?? null)
    : null
  return { status: res.status, body: body as T, usage, counter }
}

// ── Typed calls (shapes from the OpenAPI spec; re-pinned by the first live UAT call) ────────────

/** v1 Card (POST/GET /v1/cards). Raw variants only — v1 never returns graded variants. */
export interface JtV1Variant {
  id?: string; uuid?: string
  condition?: string            // 'Near Mint' | 'Lightly Played' | … (full names)
  printing?: string             // 'Normal' | 'Foil' | 'Holofoil' | '1st Edition Holofoil' | …
  language?: string             // absent/'English' = English
  tcgplayerSkuId?: string
  price?: number | null
  lastUpdated?: number          // unix seconds
  priceChange24hr?: number | null
  priceChange7d?: number | null
  priceChange30d?: number | null
  priceChange90d?: number | null
  avgPrice?: number | null
  minPrice7d?: number | null; maxPrice7d?: number | null
  minPrice30d?: number | null; maxPrice30d?: number | null
  priceHistory?: Array<{ p: number; t: number }>
  priceHistory30d?: Array<{ p: number; t: number }>
  [k: string]: unknown
}
export interface JtV1Card {
  id?: string; uuid?: string; name?: string; game?: string; set?: string; set_name?: string
  number?: string; rarity?: string; tcgplayerId?: string | null; details?: string | null
  variants?: JtV1Variant[]
  [k: string]: unknown
}
export interface JtV1CardsResponse { data?: JtV1Card[]; meta?: unknown; _metadata?: JustTcgUsage }

/** v2 Card (GET /v2/cards). Graded variants arrive here (type 'graded' + grading + markets). */
export interface JtV2Market {
  region?: string; currency?: string; price?: number | null; updated_at?: number
  change_24h_pct?: number | null
  periods?: Record<string, { change_pct?: number | null; avg?: number | null; min?: number | null; max?: number | null; trend_slope?: number | null; changes_count?: number | null; range_position?: number | null }>
  price_history?: Array<{ p: number; t: number }>
  [k: string]: unknown
}
export interface JtV2Grading {
  company?: string; grade?: number | null; grade_label?: string | null; qualifier?: string | null; canonical?: string
}
export interface JtV2Variant {
  id?: string; slug?: string; type?: 'raw' | 'graded'; condition?: string | null; printing?: string | null
  language?: string | null; grading?: JtV2Grading | null; markets?: JtV2Market[]
  external_ids?: { tcgplayer_sku?: string | null }
  [k: string]: unknown
}
export interface JtV2Card {
  id?: string; slug?: string; name?: string; number?: string | null; rarity?: string | null
  game?: { id?: string; name?: string }; set?: { id?: string; name?: string | null }
  external_ids?: { tcgplayer?: string | null; scryfall?: string | null; mtgjson?: string | null }
  variants?: JtV2Variant[]
  [k: string]: unknown
}
export interface JtV2CardsResponse { data?: JtV2Card[]; meta?: { count?: number; total?: number | null; has_more?: boolean } }

export interface JtGame { id?: string; name?: string; cards_count?: number; sets_count?: number; last_updated?: number; [k: string]: unknown }
export interface JtGamesResponse { data?: JtGame[]; _metadata?: JustTcgUsage }

/** GET /v1/games — one call; the game-id map for search + the coverage table. */
export function justtcgGames(env: Env) {
  return justtcgFetch<JtGamesResponse>(env, '/v1/games', { jobName: 'justtcg:games' })
}

/**
 * POST /v1/cards — the RAW batch (all conditions, all printings, graded never included on v1).
 * One identifier per item; items beyond the plan's batch size are the caller's to chunk.
 */
export function justtcgBatchByTcgplayerIds(env: Env, tcgplayerIds: Array<string | number>, priceHistoryDuration = '30d') {
  const items = tcgplayerIds.map(id => ({ tcgplayerId: String(id) }))
  return justtcgFetch<JtV1CardsResponse>(env, '/v1/cards', {
    method: 'POST', body: items, jobName: `justtcg:batch(${items.length})`,
    query: { priceHistoryDuration },
  })
}

/** GET /v2/cards?tcgplayer_id=…&graded=only — the GRADED-ONLY call (never `include`: surcharge). */
export function justtcgGradedByTcgplayerId(env: Env, tcgplayerId: string | number) {
  return justtcgFetch<JtV2CardsResponse>(env, '/v2/cards', {
    query: { tcgplayer_id: String(tcgplayerId), graded: 'only', include: 'periods.30d,price_history.30d' },
    jobName: 'justtcg:graded',
  })
}

/** GET /v1/cards?q=…&game=…[&number=…] — name search for products with NO TCGplayer id. */
export function justtcgSearch(env: Env, q: string, gameId?: string | null, number?: string | null, limit = 5) {
  return justtcgFetch<JtV1CardsResponse>(env, '/v1/cards', {
    query: { q, game: gameId ?? undefined, number: number ?? undefined, limit: String(limit), include_price_history: 'false' },
    jobName: 'justtcg:search',
  })
}
