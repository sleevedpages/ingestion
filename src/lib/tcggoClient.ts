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

// ── Artist → card-list ingestion (Part 2) ─────────────────────────────────────
//
// tcggo is repurposed as a CONTENT source: ingest an artist's full card list so the
// operator can mint an owned, editable TEMPLATE binder from it. These endpoints are
// admin-triggered + low-frequency (free tier is 100 req/day) and the Content side
// KV-caches results. Response shapes are tolerated defensively (array / { data } /
// { artists|cards|results }) — the documented card fields are: name, card_number,
// rarity, episode (set), image, tcgplayer_id (often null — the known gap), tcgid.

const ARTIST_CARD_SORT = 'card_number_lowest'
/** Free-tier safety cap on pages per artist (each page = 1 request). */
const MAX_ARTIST_PAGES = 40

export interface TcggoArtist {
  id:          string
  name:        string
  slug:        string | null
  cards_count: number | null
}

export interface TcggoArtistCard {
  name:         string
  card_number:  string | null
  rarity:       string | null
  episode:      string | null   // set name
  image:        string | null
  tcgplayer_id: string | null   // bridge to products.tcgplayer_product_id (often null)
  tcgid:        string | null
}

function tcggoHeaders(env: Env): Record<string, string> {
  return {
    'x-rapidapi-key':  env.TCGGO_RAPIDAPI_KEY as string,
    'x-rapidapi-host': TCGGO_HOST,
    'Accept':          'application/json',
  }
}

/** Pull an array of records out of the common tcggo response shapes. */
function extractList(payload: unknown, ...keys: string[]): any[] {
  if (Array.isArray(payload)) return payload
  const obj = payload as Record<string, unknown> | null
  if (!obj) return []
  for (const k of [...keys, 'data', 'results']) {
    if (Array.isArray(obj[k])) return obj[k] as any[]
  }
  return []
}

/** total_pages if the API reports it (various shapes), else null. */
function totalPagesOf(payload: unknown): number | null {
  const o = payload as any
  const tp = o?.total_pages ?? o?.totalPages ?? o?.pagination?.total_pages ?? o?.meta?.total_pages
  const n = Number(tp)
  return Number.isFinite(n) && n > 0 ? n : null
}

export function normalizeArtist(raw: any): TcggoArtist | null {
  const id = String(raw?.id ?? raw?.artist_id ?? raw?.slug ?? '').trim()
  const name = String(raw?.name ?? raw?.artist ?? '').trim()
  if (!id || !name) return null
  const cc = raw?.cards_count ?? raw?.cardsCount ?? raw?.card_count
  return {
    id,
    name,
    slug: raw?.slug ?? null,
    cards_count: cc != null && Number.isFinite(Number(cc)) ? Number(cc) : null,
  }
}

export function normalizeArtistCard(raw: any): TcggoArtistCard {
  // `episode` / `image` arrive as either a string or a nested object.
  const episode = typeof raw?.episode === 'object' && raw?.episode
    ? (raw.episode.name ?? raw.episode.title ?? null)
    : (raw?.episode ?? raw?.set?.name ?? raw?.set ?? null)
  const image = typeof raw?.image === 'object' && raw?.image
    ? (raw.image.large ?? raw.image.url ?? raw.image.front ?? null)
    : (raw?.image ?? raw?.images?.large ?? null)
  const tcgplayerId = raw?.tcgplayer_id ?? raw?.tcgplayerId ?? null
  return {
    name:         String(raw?.name ?? '').trim(),
    card_number:  raw?.card_number != null ? String(raw.card_number) : (raw?.number != null ? String(raw.number) : null),
    rarity:       raw?.rarity ?? null,
    episode:      episode != null ? String(episode) : null,
    image:        image != null ? String(image) : null,
    tcgplayer_id: tcgplayerId != null && tcgplayerId !== '' ? String(tcgplayerId) : null,
    tcgid:        raw?.tcgid != null ? String(raw.tcgid) : (raw?.tcg_id != null ? String(raw.tcg_id) : null),
  }
}

/** Search/list artists by name. */
export async function searchTcggoArtists(env: Env, search: string, page = 1): Promise<{ artists: TcggoArtist[]; page: number }> {
  if (!env.TCGGO_RAPIDAPI_KEY) throw new Error('TCGGO_RAPIDAPI_KEY not configured')
  const url = new URL(`https://${TCGGO_HOST}/artists`)
  if (search) url.searchParams.set('search', search)
  url.searchParams.set('page', String(page))

  const res = await fetch(url.toString(), { headers: tcggoHeaders(env) })
  if (!res.ok) throw new Error(`tcggo artists HTTP ${res.status}`)
  const payload = await res.json().catch(() => null)
  const artists = extractList(payload, 'artists')
    .map(normalizeArtist)
    .filter((a): a is TcggoArtist => a != null)
  return { artists, page }
}

/**
 * Fetch ALL of an artist's cards across pages (sorted by card number). Bounded by
 * the reported total_pages, the artist's cards_count hint, a short final page, and
 * a hard MAX_ARTIST_PAGES free-tier cap.
 */
export async function fetchAllArtistCards(
  env: Env,
  artistId: string,
  opts: { cardsCount?: number } = {},
): Promise<{ cards: TcggoArtistCard[]; pagesFetched: number; requests: number }> {
  if (!env.TCGGO_RAPIDAPI_KEY) throw new Error('TCGGO_RAPIDAPI_KEY not configured')
  const all: TcggoArtistCard[] = []
  let page = 1
  let requests = 0
  let pageSize = 0

  while (page <= MAX_ARTIST_PAGES) {
    const url = new URL(`https://${TCGGO_HOST}/artists/${encodeURIComponent(artistId)}/cards`)
    url.searchParams.set('page', String(page))
    url.searchParams.set('sort', ARTIST_CARD_SORT)

    const res = await fetch(url.toString(), { headers: tcggoHeaders(env) })
    requests++
    if (res.status === 404) break
    if (!res.ok) throw new Error(`tcggo artist cards HTTP ${res.status}`)
    const payload = await res.json().catch(() => null)
    const raw = extractList(payload, 'cards')
    if (raw.length === 0) break
    for (const c of raw) all.push(normalizeArtistCard(c))
    if (page === 1) pageSize = raw.length

    const totalPages = totalPagesOf(payload)
    if (totalPages != null && page >= totalPages) break
    if (opts.cardsCount && all.length >= opts.cardsCount) break
    if (pageSize > 0 && raw.length < pageSize) break   // short page = last
    page++
  }
  return { cards: all, pagesFetched: page, requests }
}
