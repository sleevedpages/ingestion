/**
 * UPCitemdb resolver — the SECONDARY external rung of the UPC resolution ladder (worker
 * route GET /upcitemdb/upc; consulted by Content only after the map AND eBay both miss).
 *
 * UPCitemdb aggregates retail product titles by barcode. Two API paths, auto-selected:
 *   - KEYLESS trial (the default): https://api.upcitemdb.com/prod/trial/lookup?upc= —
 *     no key at this tier, HARD-limited to 100 requests/day + a ~6/min burst (429).
 *   - Keyed: when UPCITEMDB_KEY is present in env, /prod/v1/lookup with the
 *     user_key/key_type headers (same shape, paid quota). Both supported; keyless default.
 *
 * The response's item titles go through the SAME aggregation + catalogue matcher as the
 * eBay resolver (lib/upcTitleMatch.ts — one matcher, one noise list). Confident match →
 * canonical id (Content writes the map); anything else → clean miss.
 *
 * QUOTA DISCIPLINE (the 100/day tier is tiny):
 *   - `upc_upcitemdb_daily_cap` app_config soft cap, code default 60 — deliberately WELL
 *     under 100 so a scanning spree can never eat the whole day.
 *   - positive + definitive-negative KV caching (`upcitemdb_upc:{code}`).
 *   - a 429 arms a KV BACKOFF (10 min) — every lookup inside it is an instant miss; never
 *     a retry loop against a rate-limited API.
 */

import type { Env } from '../worker.js'
import { aggregateTitles, matchAggregateToCatalogue, readConfigInt, dailyCapExhausted, bumpDailyCount, logRungResolution, type MatchTrace } from './upcTitleMatch.js'
import { logger } from '../ingestion/logger.js'

export const UPCITEMDB_TRIAL_URL = 'https://api.upcitemdb.com/prod/trial/lookup'
export const UPCITEMDB_KEYED_URL = 'https://api.upcitemdb.com/prod/v1/lookup'

export const UPCITEMDB_UPC_PREFIX = 'upcitemdb_upc:'
export const UPCITEMDB_UPC_TTL = 60 * 60 * 24 * 30       // 30d positive (the map is the durable record)
export const UPCITEMDB_UPC_NEGATIVE_TTL = 60 * 60 * 24   // 24h negative
export const UPCITEMDB_BACKOFF_KEY = 'upcitemdb_backoff'
export const UPCITEMDB_BACKOFF_TTL = 60 * 10             // 10 min after a 429
export const UPCITEMDB_DAILY_COUNTER_PREFIX = 'upcitemdb_upc_calls:'
export const UPCITEMDB_DAILY_CAP_KEY = 'upc_upcitemdb_daily_cap'
export const UPCITEMDB_DAILY_CAP_DEFAULT = 60            // well under the 100/day trial limit

export interface UpcitemdbUpcResult {
  found: boolean
  cached?: boolean
  canonicalProductId?: number
  productKind?: string | null
  skipped?: 'daily_cap' | 'backoff'
}

type FetchFn = typeof fetch

/** Resolve a normalized digits-only barcode via UPCitemdb. Clean miss on every failure. */
export async function lookupUpcitemdbUpc(env: Env, code: string, fetchFn: FetchFn = fetch): Promise<UpcitemdbUpcResult> {
  const kv = env.SLEEVEDPAGES_KV
  const cacheKey = `${UPCITEMDB_UPC_PREFIX}${code}`

  if (kv) {
    const raw = await kv.get(cacheKey)
    if (raw != null) {
      try {
        const cached = { ...(JSON.parse(raw) as UpcitemdbUpcResult), cached: true }
        logRungResolution({ rung: 'upcitemdb', code, outcome: cached.found ? 'hit' : 'miss', skipped: 'kv_cache', canonicalProductId: cached.canonicalProductId })
        return cached
      } catch { /* fall through */ }
    }
    // ⚠️ This gate was SILENT until 2026-08-21: a lookup inside the 10-minute post-429 window
    // returned a bare miss with nothing in the tail, indistinguishable from a real miss. The
    // rung still answers correctly by falling through, so this is `warn`, never `error`.
    if (await kv.get(UPCITEMDB_BACKOFF_KEY) != null) {
      logger.warn('upcitemdb rung in post-429 BACKOFF — treating as miss', { backoffTtlSec: UPCITEMDB_BACKOFF_TTL })
      logRungResolution({ rung: 'upcitemdb', code, outcome: 'skipped', skipped: 'backoff' })
      return { found: false, skipped: 'backoff' }
    }
  }

  const cap = await readConfigInt(env.DB, UPCITEMDB_DAILY_CAP_KEY, UPCITEMDB_DAILY_CAP_DEFAULT)
  if (await dailyCapExhausted(kv, UPCITEMDB_DAILY_COUNTER_PREFIX, cap)) {
    logger.warn('upcitemdb daily cap reached — treating as miss', { cap })
    logRungResolution({ rung: 'upcitemdb', code, outcome: 'skipped', skipped: 'daily_cap' })
    return { found: false, skipped: 'daily_cap' }
  }

  // Keyless trial by default; the keyed /prod/v1 path iff UPCITEMDB_KEY is present.
  const keyed = Boolean(env.UPCITEMDB_KEY)
  const url = `${keyed ? UPCITEMDB_KEYED_URL : UPCITEMDB_TRIAL_URL}?upc=${encodeURIComponent(code)}`
  const headers: Record<string, string> = keyed
    ? { user_key: env.UPCITEMDB_KEY as string, key_type: '3scale' }
    : {}

  let res: Response
  try {
    await bumpDailyCount(kv, UPCITEMDB_DAILY_COUNTER_PREFIX)
    res = await fetchFn(url, { headers })
  } catch (err) {
    logger.warn('upcitemdb lookup failed — treating as miss', { error: String(err) })
    logRungResolution({ rung: 'upcitemdb', code, outcome: 'miss', skipped: 'transport_error' })
    return { found: false }   // transport failure — never negative-cached
  }

  if (res.status === 429) {
    // Rate-limited: arm the backoff window and miss. NEVER retry-loop.
    if (kv) await kv.put(UPCITEMDB_BACKOFF_KEY, '1', { expirationTtl: UPCITEMDB_BACKOFF_TTL })
    logger.warn('upcitemdb 429 — backoff armed', {})
    logRungResolution({ rung: 'upcitemdb', code, outcome: 'skipped', skipped: 'rate_limited' })
    return { found: false, skipped: 'backoff' }
  }
  if (!res.ok) {
    logger.warn('upcitemdb non-OK response — treating as miss', { status: res.status })
    logRungResolution({ rung: 'upcitemdb', code, outcome: 'miss', skipped: `http_${res.status}` })
    return { found: false }   // transient/unknown — never negative-cached
  }

  const body = await res.json().catch(() => null) as { code?: string; items?: Array<{ title?: string }> } | null
  const titles = (body?.items ?? []).map((i) => String(i?.title ?? '')).filter((t) => t.length > 0)

  const aggregate = titles.length > 0 ? aggregateTitles(titles) : null
  let trace: MatchTrace | undefined
  const match = aggregate
    ? await matchAggregateToCatalogue(env.DB, aggregate, { onTrace: (t) => { trace = t } })
    : null

  if (!match) {
    logRungResolution({ rung: 'upcitemdb', code, outcome: 'miss', titles: titles.length, aggregate, trace })
    // A served response with no confident match is a DEFINITIVE miss → negative-cache.
    if (kv) await kv.put(cacheKey, JSON.stringify({ found: false } satisfies UpcitemdbUpcResult), { expirationTtl: UPCITEMDB_UPC_NEGATIVE_TTL })
    return { found: false }
  }

  const positive: UpcitemdbUpcResult = { found: true, canonicalProductId: match.canonicalProductId, productKind: match.productKind }
  logRungResolution({ rung: 'upcitemdb', code, outcome: 'hit', titles: titles.length, aggregate, canonicalProductId: match.canonicalProductId, trace })
  if (kv) await kv.put(cacheKey, JSON.stringify(positive), { expirationTtl: UPCITEMDB_UPC_TTL })
  return positive
}
