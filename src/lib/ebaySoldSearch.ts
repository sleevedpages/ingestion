/**
 * eBay "completed + sold" search-term builder (worker mirror of the Content
 * helper src/lib/ebaySoldSearch.js — src↔worker is not import-shareable, so the
 * PURE builder is mirrored here, same convention as pricechartingClient.ts).
 *
 * This is the BASIS for the Apify eBay actor's search input: the actor is fed the
 * exact sold-search URL a user would open from the public "See sold listings on
 * eBay" link, so the scraped comps and the link point at the same query.
 *
 * The query is `{name} {number} {company} {grade}` with empty fields dropped
 * cleanly (never "undefined"). `LH_Complete=1` + `LH_Sold=1` scope results to
 * completed AND sold listings (always present). Returns null when there is no name.
 */

const EBAY_SEARCH_BASE = 'https://www.ebay.com/sch/i.html'

export interface EbaySlab {
  name?: string | null
  number?: string | number | null
  company?: string | null
  grade?: string | number | null
}

const clean = (v: unknown): string => (v == null ? '' : String(v).trim())

/** The raw `{name} {number} {company} {grade}` keyword string, or null if no name. */
export function buildEbaySoldQuery({ name, number, company, grade }: EbaySlab = {}): string | null {
  const cardName = clean(name)
  if (!cardName) return null
  return [cardName, clean(number), clean(company), clean(grade)].filter(Boolean).join(' ')
}

/** Full eBay completed+sold search URL for the slab, or null if no name. */
export function buildEbaySoldSearchUrl(slab: EbaySlab = {}): string | null {
  const query = buildEbaySoldQuery(slab)
  if (query == null) return null
  return `${EBAY_SEARCH_BASE}?_nkw=${encodeURIComponent(query)}&LH_Complete=1&LH_Sold=1`
}
