/**
 * tcggo (pokemon-tcg-api.p.rapidapi.com) graded-price client.
 *
 * Fetches eBay-sold graded medians for a TCGPlayer product id from the tcggo
 * RapidAPI ("pokemon-api.com"). This is the FREE-tier data source used to demo
 * graded pricing — it is ADMIN-ONLY on the Content side and routed through this
 * worker so the RapidAPI key never lives in the Content app (same pattern as the
 * Scrydex key).
 *
 * tcggo covers Pokémon, Lorcana, Riftbound, One Piece. A non-covered game / no
 * match / no graded data → returns null so the caller falls back (manual price).
 *
 * Live response contract (operator-supplied spec sample):
 *   <card>.prices.ebay.graded[company][grade] = { median_price, sample_size }
 *   companies: psa | bgs | cgc   grade: e.g. "10", "9.5"
 *
 * FREE-TIER PROTECTION: the only caller is the Content admin proxy, which
 * KV-caches results 24h per tcgplayerId — so a demo session does not blow the
 * 100-requests/day free quota. (One probe call confirms the shape at deploy.)
 */

import type { Env } from '../worker.js'

const TCGGO_HOST = 'pokemon-tcg-api.p.rapidapi.com'

/** A single graded median entry, compacted from the tcggo payload. */
export interface GradedEntry {
  median_price: number
  sample_size:  number
}

/** Compact graded map: { psa: { "10": {...} }, bgs: {...}, cgc: {...} }. */
export type GradedMap = Record<string, Record<string, GradedEntry>>

export interface TcggoGradedResult {
  tcgplayerId: string
  graded:      GradedMap | null
  source:      'tcggo'
}

/**
 * Normalise a raw `prices.ebay.graded` object into the compact GradedMap.
 * Lowercases company keys; keeps only entries with a numeric median_price.
 * Returns null when there is no usable graded data.
 */
export function normalizeGraded(rawGraded: unknown): GradedMap | null {
  if (!rawGraded || typeof rawGraded !== 'object') return null
  const out: GradedMap = {}
  for (const [company, grades] of Object.entries(rawGraded as Record<string, unknown>)) {
    if (!grades || typeof grades !== 'object') continue
    const companyKey = company.toLowerCase().trim()
    const byGrade: Record<string, GradedEntry> = {}
    for (const [grade, entry] of Object.entries(grades as Record<string, unknown>)) {
      const e = entry as { median_price?: unknown; sample_size?: unknown } | null
      const median = e && typeof e.median_price === 'number' ? e.median_price : Number(e?.median_price)
      if (e == null || median == null || Number.isNaN(median)) continue
      const sample = typeof e.sample_size === 'number' ? e.sample_size : Number(e.sample_size ?? 0)
      byGrade[String(grade).trim()] = {
        median_price: median,
        sample_size:  Number.isFinite(sample) ? sample : 0,
      }
    }
    if (Object.keys(byGrade).length) out[companyKey] = byGrade
  }
  return Object.keys(out).length ? out : null
}

/**
 * Pull `prices.ebay.graded` from a tcggo card object (tolerates array / { data }
 * / single-object response shapes). Returns the first card carrying graded data.
 */
export function extractGradedFromPayload(payload: unknown): GradedMap | null {
  if (payload == null) return null
  const candidates: unknown[] = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: unknown[] }).data)
      ? (payload as { data: unknown[] }).data
      : [payload]
  for (const card of candidates) {
    const graded = (card as { prices?: { ebay?: { graded?: unknown } } } | null)
      ?.prices?.ebay?.graded
    const norm = normalizeGraded(graded)
    if (norm) return norm
  }
  return null
}

/**
 * Fetch graded medians for a TCGPlayer product id from tcggo.
 * Returns { tcgplayerId, graded, source } — graded is null on no match / no
 * graded data / a non-covered game (caller falls back to manual price).
 *
 * @throws Error on a missing key or a network/HTTP failure (caller maps to 502).
 */
export async function fetchTcggoGradedPrices(env: Env, tcgplayerId: string): Promise<TcggoGradedResult> {
  if (!env.TCGGO_RAPIDAPI_KEY) throw new Error('TCGGO_RAPIDAPI_KEY not configured')

  const url = new URL(`https://${TCGGO_HOST}/cards`)
  url.searchParams.set('tcgplayer_id', String(tcgplayerId))

  const res = await fetch(url.toString(), {
    headers: {
      'x-rapidapi-key':  env.TCGGO_RAPIDAPI_KEY,
      'x-rapidapi-host': TCGGO_HOST,
      'Accept':          'application/json',
    },
  })

  // 404 / not-covered → treat as "no match" (null graded), not a hard error.
  if (res.status === 404) return { tcgplayerId: String(tcgplayerId), graded: null, source: 'tcggo' }
  if (!res.ok) throw new Error(`tcggo HTTP ${res.status}`)

  const payload = await res.json().catch(() => null)
  return {
    tcgplayerId: String(tcgplayerId),
    graded:      extractGradedFromPayload(payload),
    source:      'tcggo',
  }
}
