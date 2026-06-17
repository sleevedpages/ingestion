/**
 * tcggo (pokemon-tcg-api.p.rapidapi.com) client — ARTIST → Binder-Template ingestion.
 *
 * tcggo's GRADED eBay-sold role was REMOVED (our canonical ids don't match tcggo's
 * datasets, so its medians were unreliable). eBay sold comps now come from the Apify
 * actor (lib/ebayGradedClient.ts). tcggo remains ONLY as a CONTENT source: it lists an
 * artist's full card set so the Content admin can mint an owned, editable TEMPLATE
 * binder from it. These endpoints are admin-triggered + low-frequency (free tier is
 * 100 req/day) and the Content side KV-caches results. The RapidAPI key (TCGGO_RAPIDAPI_KEY)
 * lives here in the worker, never in the Content app — same convention as the Scrydex key.
 *
 * Response shapes are tolerated defensively (array / { data } / { artists|cards|results }) —
 * the documented card fields are: name, card_number, rarity, episode (set), image,
 * tcgplayer_id (often null — the known gap), tcgid.
 */

import type { Env } from '../worker.js'

const TCGGO_HOST = 'pokemon-tcg-api.p.rapidapi.com'

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
