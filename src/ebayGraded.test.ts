import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  parsePrice,
  isExcludedListing,
  titleMatchesSlab,
  median,
  trimOutliers,
  aggregateEbaySold,
  extractTitle,
  extractPrice,
  mapDatasetItems,
  fetchEbayGraded,
  GRADED_MIN_SAMPLE,
} from './lib/ebayGradedClient.js'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

// ── Pure price parsing (confirmed actor: soldPrice is a STRING dollar value) ─────
describe('parsePrice', () => {
  it('reads numbers, $-strings, and { value } objects', () => {
    expect(parsePrice(412.5)).toBe(412.5)
    expect(parsePrice('$1,234.56')).toBe(1234.56)
    expect(parsePrice({ value: 99.99 })).toBe(99.99)
    expect(parsePrice({ amount: '250' })).toBe(250)
  })
  it('parses a bare dollar string like the actor "soldPrice" — NOT as pennies', () => {
    // Guard: "215" is $215, NOT $2.15. A /100 here would be 100× too low.
    expect(parsePrice('215')).toBe(215)
    expect(parsePrice('215')).not.toBe(2.15)
  })
  it('rejects non-positive / non-numeric', () => {
    expect(parsePrice(0)).toBeNull()
    expect(parsePrice(-5)).toBeNull()
    expect(parsePrice('free shipping')).toBeNull()
    expect(parsePrice(null)).toBeNull()
  })
})

// ── Match filter ─────────────────────────────────────────────────────────────
describe('titleMatchesSlab', () => {
  const slab = { name: 'Charizard ex', number: '125/197', company: 'PSA', grade: '10' }
  it('keeps a true match (name + number + company + grade)', () => {
    expect(titleMatchesSlab('Charizard ex 125 Obsidian Flames PSA 10 GEM MINT', slab)).toBe(true)
    expect(titleMatchesSlab('PSA 10 Charizard ex #125/197 Pokemon', slab)).toBe(true)
  })
  it('drops the wrong grade (PSA 9 when we want PSA 10)', () => {
    expect(titleMatchesSlab('Charizard ex 125 PSA 9 MINT', slab)).toBe(false)
  })
  it('does not let "9" match "9.5" or "10"', () => {
    const s95 = { name: 'Pikachu', number: '58', company: 'BGS', grade: '9.5' }
    expect(titleMatchesSlab('Pikachu 58 BGS 9.5', s95)).toBe(true)
    expect(titleMatchesSlab('Pikachu 58 BGS 9', s95)).toBe(false)
  })
  it('drops the wrong company', () => {
    expect(titleMatchesSlab('Charizard ex 125 CGC 10', slab)).toBe(false)
  })
  it('drops a listing missing the card number', () => {
    expect(titleMatchesSlab('Charizard ex PSA 10', slab)).toBe(false)
  })
  it('drops a listing missing a name token', () => {
    expect(titleMatchesSlab('Pikachu 125 PSA 10', slab)).toBe(false)
  })
})

describe('isExcludedListing', () => {
  it('drops lots / bundles / proxies / repacks / damaged / multipliers', () => {
    expect(isExcludedListing('Charizard PSA 10 LOT of 5')).toBe(true)
    expect(isExcludedListing('Pokemon bundle PSA 10')).toBe(true)
    expect(isExcludedListing('Charizard PSA 10 PROXY custom')).toBe(true)
    expect(isExcludedListing('Charizard PSA 10 repack')).toBe(true)
    expect(isExcludedListing('Charizard PSA 10 damaged')).toBe(true)
    expect(isExcludedListing('Charizard PSA 10 x3')).toBe(true)
    expect(isExcludedListing('')).toBe(true)
  })
  it('keeps a clean single-slab title', () => {
    expect(isExcludedListing('Charizard ex 125 PSA 10 GEM MINT')).toBe(false)
  })
})

// ── Aggregation ────────────────────────────────────────────────────────────────
describe('median / trimOutliers', () => {
  it('median of odd + even arrays', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([])).toBe(0)
  })
  it('keeps everything when < 4 points or MAD is zero', () => {
    expect(trimOutliers([1, 1000, 5]).length).toBe(3)
    expect(trimOutliers([10, 10, 10, 10]).length).toBe(4)
  })
  it('drops a gross outlier from a tight cluster', () => {
    const trimmed = trimOutliers([100, 102, 98, 101, 99, 5000])
    expect(trimmed).not.toContain(5000)
    expect(trimmed.length).toBe(5)
  })
})

describe('aggregateEbaySold (sample-size-aware)', () => {
  const slab = { name: 'Charizard ex', number: '125', company: 'PSA', grade: '10' }
  const item = (title: string, price: number | null) => ({ title, price })

  it('match-filters, returns median + n + spread, confident when n≥3 and tight', () => {
    const items = [
      item('Charizard ex 125 PSA 10', 100),
      item('Charizard ex 125 PSA 10 GEM', 110),
      item('PSA 10 Charizard ex 125', 105),
      item('Charizard ex 125 PSA 9', 40),         // wrong grade → dropped
      item('Charizard ex 125 PSA 10 LOT', 300),   // lot → dropped
      item('Pikachu 125 PSA 10', 999),            // wrong name → dropped
    ]
    const r = aggregateEbaySold(items, slab)
    expect(r.n).toBe(3)
    expect(r.price).toBe(105)
    expect(r.spread).toEqual({ min: 100, max: 110 })
    expect(r.lowConfidence).toBe(false)
  })

  it('drops sub-floor accessory/junk listings via the price floor', () => {
    const r = aggregateEbaySold([
      item('Charizard ex 125 PSA 10', 100),
      item('Charizard ex 125 PSA 10', 0.99),  // below PRICE_FLOOR → dropped
    ], slab)
    expect(r.n).toBe(1)
    expect(r.price).toBe(100)
  })

  it('SKIPS the statistical fence below n=10 (keeps a real high sale)', () => {
    // 5 comps incl. a genuine high sale; below the fence we keep all → median 120.
    const r = aggregateEbaySold([
      item('Charizard ex 125 PSA 10', 100),
      item('Charizard ex 125 PSA 10', 110),
      item('Charizard ex 125 PSA 10', 120),
      item('Charizard ex 125 PSA 10', 130),
      item('Charizard ex 125 PSA 10', 800),   // high but kept (n<10, no fence)
    ], slab)
    expect(r.n).toBe(5)
    expect(r.price).toBe(120)
  })

  it('APPLIES the statistical fence at n≥10 (drops a gross outlier, re-medians)', () => {
    const prices = [100, 102, 98, 101, 99, 103, 97, 100, 101, 5000]  // 10 comps, 1 outlier
    const r = aggregateEbaySold(prices.map(p => item('Charizard ex 125 PSA 10', p)), slab)
    expect(r.n).toBe(9)                 // the 5000 outlier fenced out
    expect(r.spread?.max).toBeLessThan(5000)
  })

  it('downgrades to low-confidence on WIDE dispersion even when n≥3', () => {
    const r = aggregateEbaySold([
      item('Charizard ex 125 PSA 10', 100),
      item('Charizard ex 125 PSA 10', 100),
      item('Charizard ex 125 PSA 10', 5000),  // range/median huge → wide
    ], slab)
    expect(r.n).toBe(3)
    expect(r.lowConfidence).toBe(true)
  })

  it('reports thin (1–2) and null (0) buckets', () => {
    const thin = aggregateEbaySold([item('Charizard ex 125 PSA 10', 120)], slab)
    expect(thin.n).toBe(1)
    expect(thin.lowConfidence).toBe(true)
    expect(thin.n < GRADED_MIN_SAMPLE).toBe(true)

    const empty = aggregateEbaySold([item('totally unrelated', 50)], slab)
    expect(empty.price).toBeNull()
    expect(empty.n).toBe(0)
  })
})

// ── Dataset mapping (confirmed actor: soldPrice string) ─────────────────────────
describe('mapDatasetItems', () => {
  it('extracts title + soldPrice (string dollars) from the confirmed actor rows', () => {
    const mapped = mapDatasetItems([
      { title: 'A PSA 10', soldPrice: '215', endedAt: '2026-06-01', itemId: '1' },
      { title: 'B PSA 10', soldPrice: '1,234.56' },
    ])
    expect(mapped[0]).toEqual({ title: 'A PSA 10', price: 215 })   // NOT 2.15
    expect(mapped[1]).toEqual({ title: 'B PSA 10', price: 1234.56 })
  })
  it('tolerates other shapes + array wrappers', () => {
    expect(mapDatasetItems({ items: [{ title: 'X', price: 1 }] })[0].title).toBe('X')
    expect(mapDatasetItems(null)).toEqual([])
    expect(extractTitle({})).toBe('')
    expect(extractPrice({})).toBeNull()
  })
})

// ── Integration: resolve → run actor → aggregate ────────────────────────────────
function makeDb(card: any) {
  return { prepare() { return { bind() { return this }, async first() { return card } } } }
}
const baseEnv = (over: any = {}) => ({
  APIFY_TOKEN: 'tok',
  APIFY_EBAY_ACTOR_ID: 'oTtB3VgfuE9GtxQt2',
  DB: makeDb({ name: 'Charizard ex', number: '125/197', set_name: 'Obsidian Flames' }),
  ...over,
})

describe('fetchEbayGraded', () => {
  it('throws when credentials are missing (→ 503 at the edge)', async () => {
    await expect(fetchEbayGraded({} as any, { canonicalProductId: 1, company: 'PSA', grade: '10' }))
      .rejects.toThrow('APIFY_TOKEN')
  })

  it('passes BARE keyword terms (not a URL), a capped count, and detailedSearch:false', async () => {
    const fetchMock = vi.fn(async (url: string, opts: any) => {
      expect(String(url)).toContain('api.apify.com/v2/acts/oTtB3VgfuE9GtxQt2/run-sync-get-dataset-items')
      expect(String(url)).toContain('token=tok')
      const body = JSON.parse(opts.body)
      // keywords[0] is the search TERMS, not an eBay URL.
      expect(body.keywords[0]).toBe('Charizard ex 125/197 PSA 10')
      expect(body.keywords[0]).not.toContain('ebay.com')
      expect(body.keywords[0]).not.toContain('http')
      expect(body.count).toBe(30)
      expect(body.detailedSearch).toBe(false)
      expect(body.sortOrder).toBe('endedRecently')
      expect(body.daysToScrape).toBe(60)
      // ≥ ADAPTIVE_MIN survivors so the 60-day window suffices (no widen).
      return new Response(JSON.stringify([
        { title: 'Charizard ex 125 PSA 10 GEM MINT', soldPrice: '100' },
        { title: 'PSA 10 Charizard ex #125 Obsidian Flames', soldPrice: '110' },
        { title: 'Charizard ex 125 PSA 10', soldPrice: '105' },
        { title: 'Charizard ex 125 PSA 10 mint', soldPrice: '108' },
        { title: 'Charizard ex 125 PSA 10 graded', soldPrice: '112' },
      ]), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const res = await fetchEbayGraded(baseEnv() as any, { canonicalProductId: 7, company: 'PSA', grade: '10' })
    expect(res.price).toBe(108)            // dollars, NOT 1.08 (string parse, no /100)
    expect(res.n).toBe(5)
    expect(res.spread).toEqual({ min: 100, max: 112 })
    expect(res.lowConfidence).toBe(false)
    expect(res.source).toBe('ebay-apify')
    expect(fetchMock).toHaveBeenCalledTimes(1)   // 60-day window sufficed
  })

  it('widens 60→90 days when too few comps survive, and prefers the wider pull', async () => {
    let call = 0
    const fetchMock = vi.fn(async (_url: string, opts: any) => {
      call++
      const body = JSON.parse(opts.body)
      if (body.daysToScrape === 60) {
        // Only 2 survivors at 60 days → below ADAPTIVE_MIN, triggers the widen.
        return new Response(JSON.stringify([
          { title: 'Charizard ex 125 PSA 10', soldPrice: '100' },
          { title: 'Charizard ex 125 PSA 10', soldPrice: '110' },
        ]), { status: 200 })
      }
      expect(body.daysToScrape).toBe(90)
      return new Response(JSON.stringify([
        { title: 'Charizard ex 125 PSA 10', soldPrice: '100' },
        { title: 'Charizard ex 125 PSA 10', soldPrice: '110' },
        { title: 'Charizard ex 125 PSA 10', soldPrice: '120' },
        { title: 'Charizard ex 125 PSA 10', soldPrice: '130' },
        { title: 'Charizard ex 125 PSA 10', soldPrice: '140' },
      ]), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const res = await fetchEbayGraded(baseEnv() as any, { canonicalProductId: 7, company: 'PSA', grade: '10' })
    expect(call).toBe(2)            // widened
    expect(res.n).toBe(5)
    expect(res.price).toBe(120)
  })

  it('circuit-breaks to null on an actor error (non-OK)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    const res = await fetchEbayGraded(baseEnv() as any, { canonicalProductId: 7, company: 'PSA', grade: '10' })
    expect(res.price).toBeNull()
    expect(res.n).toBe(0)
    expect(res.lowConfidence).toBe(true)
  })

  it('circuit-breaks to null when the actor throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network') }))
    const res = await fetchEbayGraded(baseEnv() as any, { canonicalProductId: 7, company: 'PSA', grade: '10' })
    expect(res.price).toBeNull()
    expect(res.n).toBe(0)
  })

  it('returns null when the canonical product cannot be resolved', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const env = baseEnv({ DB: makeDb(null) })
    const res = await fetchEbayGraded(env as any, { canonicalProductId: 999, company: 'PSA', grade: '10' })
    expect(res.price).toBeNull()
    expect(res.n).toBe(0)
  })

  it('never leaks the Apify token in the result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ title: 'Charizard ex 125 PSA 10', soldPrice: '100' }]), { status: 200 })))
    const res = await fetchEbayGraded(baseEnv() as any, { canonicalProductId: 7, company: 'PSA', grade: '10' })
    expect(JSON.stringify(res)).not.toContain('tok')
  })
})
