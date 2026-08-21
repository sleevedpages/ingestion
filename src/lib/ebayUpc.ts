/**
 * eBay Browse UPC resolver — the PRIMARY external rung of the UPC resolution ladder
 * (behind Content's GET /api/products/upc-lookup; worker route GET /ebay/upc).
 *
 * eBay's Browse API supports GTIN search (`item_summary/search?gtin=`), and sealed TCG
 * product is heavily listed there — so the crowd's listing titles are the best available
 * UPC → identity signal. The flow: one Browse call (≤20 summaries) → majority-signal title
 * aggregation → the SHARED catalogue matcher (lib/upcTitleMatch.ts — never a second
 * matcher). A confident match returns the canonical id; the CONTENT endpoint writes the
 * product_upcs map row (mig 0128), so the map absorbs every hit and this resolver is
 * consulted at most once per code.
 *
 * TOKEN MANAGEMENT — client-credentials OAuth, KV-cached. eBay app tokens live ~2h; the
 * token is cached in KV (EBAY_TOKEN_KV_KEY) until ~5 min before expiry and NEVER fetched
 * per lookup. A 401 from Browse busts the cache once and retries with a fresh token
 * (revoked/rotated credentials heal without a stuck 2h window).
 *
 * QUOTA (~5,000 calls/day default): positive AND negative outcomes are KV-cached
 * (`ebay_upc:{code}` — positives long, since the map absorbs them; negatives 24h), and a
 * KV day-counter stops outbound calls at the `upc_ebay_daily_cap` app_config soft cap
 * (code default 4000, headroom under the 5k). Cap reached → clean miss.
 *
 * FAIL-CLOSED: missing EBAY_CLIENT_ID/SECRET → clean miss (skipped:'not_configured'),
 * never a 500 to the caller — the ladder just falls through to the next rung.
 *
 * ⚠️ 2026-08-21 — WHY `skipped:'not_configured'` RAN IN PRODUCTION FOR A WEEK, and what it
 * does NOT mean. `EBAY_CLIENT_ID`/`EBAY_CLIENT_SECRET` were never present on the DEPLOYED
 * VERSION of this worker: on Workers, a secret belongs to a VERSION, and `wrangler secret
 * list` reports the LATEST version's secret set while traffic is served by the DEPLOYED one.
 * The two disagreed, so "the secrets exist" and "the guard says not configured" were both
 * true at once. Verified with `wrangler versions view <id>` — the versions deployed on
 * 2026-08-14 and 2026-08-17 carry zero eBay credentials. **A secret added in the dashboard
 * is not live until a deploy** (`npm run deploy`, or `wrangler versions deploy <id>`); do not
 * "fix" a repeat of this by loosening the guard below. `logMissingCredentials` now names
 * WHICH env value was absent-vs-blank so the next occurrence is one log line, not three days.
 */

import type { Env } from '../worker.js'
import { aggregateTitles, matchAggregateToCatalogue, readConfigInt, dailyCapExhausted, bumpDailyCount, logRungResolution, type MatchTrace } from './upcTitleMatch.js'
import { logger } from '../ingestion/logger.js'

export const EBAY_TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token'
export const EBAY_BROWSE_SEARCH_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search'
export const EBAY_OAUTH_SCOPE = 'https://api.ebay.com/oauth/api_scope'

/** KV keys/TTLs. Positives are long-lived — the product_upcs map (written by Content) is
 * the durable record; the KV entry only spares the Browse quota if the map write failed. */
export const EBAY_TOKEN_KV_KEY = 'ebay_oauth_token'
export const EBAY_UPC_PREFIX = 'ebay_upc:'
export const EBAY_UPC_TTL = 60 * 60 * 24 * 30       // 30d positive
export const EBAY_UPC_NEGATIVE_TTL = 60 * 60 * 24   // 24h negative — a newly listed product recovers next day
export const EBAY_DAILY_COUNTER_PREFIX = 'ebay_upc_calls:'
export const EBAY_DAILY_CAP_KEY = 'upc_ebay_daily_cap'
export const EBAY_DAILY_CAP_DEFAULT = 4000
/** Refresh the app token when less than this remains — never serve a nearly-dead token. */
export const EBAY_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000

interface CachedToken { token: string; expiresAt: number }

/**
 * Which of the two credential env values is unusable, and how — 'absent' (the binding is not
 * on the deployed version at all) vs 'blank' (present but empty/whitespace, e.g. a `[vars]`
 * entry shadowing the secret, or a shell pipe that swallowed the value). **Names only, never
 * a value and never a prefix of one.** PURE.
 */
export function missingEbayCredentials(env: Pick<Env, 'EBAY_CLIENT_ID' | 'EBAY_CLIENT_SECRET'>): Array<{ name: string; reason: 'absent' | 'blank' }> {
  const out: Array<{ name: string; reason: 'absent' | 'blank' }> = []
  for (const name of ['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET'] as const) {
    const raw = env[name]
    if (raw == null) out.push({ name, reason: 'absent' })
    else if (String(raw).trim() === '') out.push({ name, reason: 'blank' })
  }
  return out
}

/** A HANDLED FALLBACK — warn, never error (CLAUDE.md → observability). The ladder still
 * answers correctly by falling through to the next rung; a human just needs to know the
 * rung is dark, which is exactly what nobody could see between 2026-08-14 and 2026-08-21. */
function logMissingCredentials(missing: Array<{ name: string; reason: string }>): void {
  logger.warn('ebay upc rung NOT CONFIGURED — falling through to the next rung', {
    missing,
    hint: 'a Workers secret belongs to a VERSION; `wrangler secret list` shows the LATEST version, traffic uses the DEPLOYED one. Redeploy the worker after adding it.',
  })
}

export interface EbayUpcResult {
  found: boolean
  cached?: boolean
  canonicalProductId?: number
  productKind?: string | null
  /** Why no lookup was attempted (observability; still a clean miss to the caller). */
  skipped?: 'not_configured' | 'daily_cap'
}

type FetchFn = typeof fetch

/**
 * Get a client-credentials app token, from KV unless within the refresh margin.
 * Throws on an unobtainable token (caller degrades to a miss).
 */
export async function getEbayAppToken(env: Env, fetchFn: FetchFn = fetch, opts: { forceRefresh?: boolean } = {}): Promise<string> {
  if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) throw new Error('eBay credentials not configured')
  const kv = env.SLEEVEDPAGES_KV

  if (!opts.forceRefresh && kv) {
    const raw = await kv.get(EBAY_TOKEN_KV_KEY)
    if (raw != null) {
      try {
        const cached = JSON.parse(raw) as CachedToken
        if (cached?.token && Date.now() < cached.expiresAt - EBAY_TOKEN_REFRESH_MARGIN_MS) return cached.token
      } catch { /* corrupt cache — fetch fresh */ }
    }
  }

  const res = await fetchFn(EBAY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`)}`,
    },
    body: `grant_type=client_credentials&scope=${encodeURIComponent(EBAY_OAUTH_SCOPE)}`,
  })
  if (!res.ok) throw new Error(`eBay token request failed (${res.status})`)
  const body = await res.json().catch(() => null) as { access_token?: string; expires_in?: number } | null
  if (!body?.access_token) throw new Error('eBay token response malformed')

  const expiresInSec = Number(body.expires_in) > 0 ? Number(body.expires_in) : 7200
  if (kv) {
    await kv.put(
      EBAY_TOKEN_KV_KEY,
      JSON.stringify({ token: body.access_token, expiresAt: Date.now() + expiresInSec * 1000 } satisfies CachedToken),
      { expirationTtl: Math.max(60, expiresInSec) },
    )
  }
  return body.access_token
}

/** One Browse GTIN search → the raw listing titles. Throws on transport/token failure. */
async function fetchListingTitles(env: Env, code: string, fetchFn: FetchFn): Promise<string[]> {
  let token = await getEbayAppToken(env, fetchFn)
  let res = await fetchFn(`${EBAY_BROWSE_SEARCH_URL}?gtin=${encodeURIComponent(code)}&limit=20`, {
    headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
  })
  if (res.status === 401) {
    // Stale/revoked cached token — one forced refresh, never a loop.
    token = await getEbayAppToken(env, fetchFn, { forceRefresh: true })
    res = await fetchFn(`${EBAY_BROWSE_SEARCH_URL}?gtin=${encodeURIComponent(code)}&limit=20`, {
      headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
    })
  }
  if (!res.ok) throw new Error(`eBay browse search failed (${res.status})`)
  const body = await res.json().catch(() => null) as { itemSummaries?: Array<{ title?: string }> } | null
  return (body?.itemSummaries ?? []).map((s) => String(s?.title ?? '')).filter((t) => t.length > 0)
}

/**
 * Resolve a normalized digits-only barcode via eBay Browse. Every failure mode is a clean
 * miss ({found:false}) — transport errors are logged and NEVER negative-cached (a flaky
 * call must not suppress retries for a day).
 */
export async function lookupEbayUpc(env: Env, code: string, fetchFn: FetchFn = fetch): Promise<EbayUpcResult> {
  const missing = missingEbayCredentials(env)
  if (missing.length > 0) {
    logMissingCredentials(missing)
    logRungResolution({ rung: 'ebay', code, outcome: 'skipped', skipped: 'not_configured' })
    return { found: false, skipped: 'not_configured' }
  }
  const kv = env.SLEEVEDPAGES_KV
  const cacheKey = `${EBAY_UPC_PREFIX}${code}`

  if (kv) {
    const raw = await kv.get(cacheKey)
    if (raw != null) {
      try { return { ...(JSON.parse(raw) as EbayUpcResult), cached: true } } catch { /* fall through */ }
    }
  }

  const cap = await readConfigInt(env.DB, EBAY_DAILY_CAP_KEY, EBAY_DAILY_CAP_DEFAULT)
  if (await dailyCapExhausted(kv, EBAY_DAILY_COUNTER_PREFIX, cap)) {
    logger.warn('ebay upc daily cap reached — treating as miss', { cap })
    logRungResolution({ rung: 'ebay', code, outcome: 'skipped', skipped: 'daily_cap' })
    return { found: false, skipped: 'daily_cap' }
  }

  let titles: string[]
  try {
    await bumpDailyCount(kv, EBAY_DAILY_COUNTER_PREFIX)
    titles = await fetchListingTitles(env, code, fetchFn)
  } catch (err) {
    logger.warn('ebay upc lookup failed — treating as miss', { error: String(err) })
    logRungResolution({ rung: 'ebay', code, outcome: 'miss', skipped: 'transport_error' })
    return { found: false }   // transient — never negative-cached
  }

  const aggregate = titles.length > 0 ? aggregateTitles(titles) : null
  let trace: MatchTrace | undefined
  const match = aggregate
    ? await matchAggregateToCatalogue(env.DB, aggregate, { onTrace: (t) => { trace = t } })
    : null

  if (!match) {
    logRungResolution({ rung: 'ebay', code, outcome: 'miss', titles: titles.length, aggregate, trace })
    // DEFINITIVE miss for this code today (no listings, or nothing confident) → cache it.
    if (kv) await kv.put(cacheKey, JSON.stringify({ found: false } satisfies EbayUpcResult), { expirationTtl: EBAY_UPC_NEGATIVE_TTL })
    return { found: false }
  }

  const positive: EbayUpcResult = { found: true, canonicalProductId: match.canonicalProductId, productKind: match.productKind }
  logRungResolution({ rung: 'ebay', code, outcome: 'hit', titles: titles.length, aggregate, canonicalProductId: match.canonicalProductId, trace })
  if (kv) await kv.put(cacheKey, JSON.stringify(positive), { expirationTtl: EBAY_UPC_TTL })
  return positive
}
