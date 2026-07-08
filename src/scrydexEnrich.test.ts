import { describe, it, expect, vi, afterEach } from 'vitest'

// Mock the Scrydex client so enrichCard's control flow (credit guard, 403 cap, happy upsert)
// is testable without real network/credits. The pure parsers below import nothing networked.
vi.mock('./lib/scrydexClient.js', () => {
  class ScrydexCreditLimitError extends Error { constructor() { super('guard'); this.name = 'ScrydexCreditLimitError' } }
  return { scrydexFetch: vi.fn(), ScrydexCreditLimitError }
})

import {
  parseTrends6,
  normaliseCompany,
  deriveScrydexCardId,
  parseCardPrices,
  parsePopReports,
  parseListings,
  parsePriceHistory,
  enrichCard,
} from './scrydexEnrich.js'
import { scrydexFetch, ScrydexCreditLimitError } from './lib/scrydexClient.js'

// ── Representative Umbreon (neo2-13) fixture, built to the documented Scrydex card shape ──
// (the live payload isn't in the workspace — confirm with one operator probe at deploy).
// Two variants (first-edition vs unlimited holofoil) that SHARE one TCGPlayer product id,
// a multi-company graded matrix, and signed/error/perfect graded sub-variants.
const UMBREON: any = {
  id: 'neo2-13',
  number: '13',
  variants: [
    {
      name: 'firstEditionHolofoil',
      marketplaces: [{ name: 'tcgplayer', product_id: '12345' }],
      // CONFIRMED shape: pop reports nested PER VARIANT, one entry per company w/ grades[].
      pop_reports: [
        {
          company: 'PSA', total: 1832, grade_total: 1811, qualified_grade_total: 0, half_grade_total: 21,
          grades: [{ grade: '10', count: 104 }, { grade: '9', count: 618 }, { grade: '8', count: 416 }],
        },
      ],
      prices: [
        { type: 'raw', condition: 'NM', low: 380, mid: 420, high: 500, market: 430, trends: { days_1: { percent_change: 1.2 }, days_180: { percent_change: -5 } } },
        { type: 'raw', condition: 'LP', low: 300, mid: 330, high: 360, market: 340, trends: {} },
        { type: 'graded', company: 'PSA', grade: '10', low: 1800, mid: 2000, high: 2400, market: 2100, trends: { days_30: { percent_change: 3 } } },
        { type: 'graded', company: 'CGC', grade: '9.5', market: 1400 },
        { type: 'graded', company: 'PSA', grade: '10', is_signed: true,  market: 2600 },  // signed sub-variant
        { type: 'graded', company: 'BGS', grade: '10', is_error: true,   market: 5000 },  // error sub-variant
        { type: 'graded', company: 'PSA', grade: '10', is_perfect: true, market: 9000 },  // black-label / perfect
      ],
    },
    {
      name: 'unlimitedHolofoil',
      marketplaces: [{ name: 'tcgplayer', product_id: '12345' }],   // SHARES the same TCGPlayer id
      pop_reports: [
        { company: 'CGC', total: 900, grade_total: 880, grades: [{ grade: '9.5', count: 120 }, { grade: 'auth', count: 1 }] },
      ],
      prices: [
        { type: 'raw', condition: 'NM', low: 90, mid: 110, high: 140, market: 120, trends: {} },
      ],
    },
  ],
}

afterEach(() => { vi.restoreAllMocks() })

describe('parseTrends6', () => {
  it('extracts the 6 percent-change windows + full JSON', () => {
    const t = parseTrends6({ days_1: { percent_change: 1 }, days_180: { percent_change: -4 } })
    expect(t.trend_1d).toBe(1)
    expect(t.trend_180d).toBe(-4)
    expect(t.trend_7d).toBeNull()
    expect(JSON.parse(t.trends_json!).days_180.percent_change).toBe(-4)
  })
  it('empty trends → all null + null json', () => {
    const t = parseTrends6({})
    expect(t.trend_1d).toBeNull()
    expect(t.trends_json).toBeNull()
  })
})

describe('normaliseCompany / deriveScrydexCardId', () => {
  it('uppercases and maps the CGS typo to CGC', () => {
    expect(normaliseCompany('psa')).toBe('PSA')
    expect(normaliseCompany('cgs')).toBe('CGC')
    expect(normaliseCompany('')).toBeNull()
    expect(normaliseCompany(null)).toBeNull()
  })
  it('derives `{expansion}-{number}` (strips /total + leading zeros)', () => {
    expect(deriveScrydexCardId('neo2', '13')).toBe('neo2-13')
    expect(deriveScrydexCardId('sv08', '025/198')).toBe('sv08-25')
    expect(deriveScrydexCardId(null, '13')).toBeNull()
    expect(deriveScrydexCardId('neo2', null)).toBeNull()
  })
})

describe('parseCardPrices (Umbreon)', () => {
  const rows = parseCardPrices(UMBREON)

  it('BOTH variants persist as distinct keyed price sets (even sharing one TCGPlayer id)', () => {
    const variants = new Set(rows.map(r => r.variant))
    expect(variants.has('firstEditionHolofoil')).toBe(true)
    expect(variants.has('unlimitedHolofoil')).toBe(true)
    // both NM raw rows resolve to the SAME tcg product id — only `variant` keeps them apart
    const nmRows = rows.filter(r => r.condition === 'NM')
    expect(nmRows).toHaveLength(2)
    expect(new Set(nmRows.map(r => r.tcgProductId))).toEqual(new Set([12345]))
  })

  it('raw rows carry low/mid/high + 6-window trends', () => {
    const nm = rows.find(r => r.variant === 'firstEditionHolofoil' && r.condition === 'NM')!
    expect(nm.low).toBe(380); expect(nm.mid).toBe(420); expect(nm.high).toBe(500); expect(nm.value).toBe(430)
    expect(nm.grade).toBeNull(); expect(nm.company).toBeNull()
    expect(nm.trends.trend_1d).toBe(1.2)
    expect(JSON.parse(nm.trends.trends_json!).days_180.percent_change).toBe(-5)
  })

  it('graded rows use the combined label and flag signed/error/perfect sub-variants', () => {
    const graded = rows.filter(r => r.grade)
    const psa10Normal = graded.find(r => r.grade === 'PSA 10' && !r.is_signed && !r.is_error && !r.is_perfect)!
    expect(psa10Normal.company).toBe('PSA'); expect(psa10Normal.value).toBe(2100); expect(psa10Normal.low).toBe(1800)
    expect(graded.find(r => r.is_signed === 1)?.value).toBe(2600)
    expect(graded.find(r => r.is_error === 1)?.value).toBe(5000)
    expect(graded.find(r => r.is_perfect === 1)?.value).toBe(9000)
    expect(graded.find(r => r.grade === 'CGC 9.5')?.company).toBe('CGC')
  })

  it('the DEFAULT graded grid (signed=0 AND error=0 AND perfect=0) excludes every sub-variant', () => {
    // Mirrors getGradedPrices' grid filter: a signed PSA 7 must never read as "PSA 7", and a
    // $9000 black-label PSA 10 must not override the $2100 standard PSA 10.
    const grid = rows.filter(r => r.grade && r.is_signed === 0 && r.is_error === 0 && r.is_perfect === 0)
    const psa10 = grid.filter(r => r.grade === 'PSA 10')
    expect(psa10).toHaveLength(1)
    expect(psa10[0].value).toBe(2100)            // the standard slab, not 2600/9000
    expect(grid.some(r => r.value === 5000)).toBe(false)   // BGS error excluded
  })

  it('tier-resilient: a card with no variants/prices yields []', () => {
    expect(parseCardPrices({})).toEqual([])
    expect(parseCardPrices({ variants: [{ name: 'normal' }] })).toEqual([])
  })
})

describe('parsePopReports', () => {
  it('parses pop reports nested per variant → one row per (variant, company, grade)', () => {
    const pops = parsePopReports(UMBREON)
    // firstEd PSA: 3 grades; unlimited CGC: 2 grades (incl. 'auth') → 5 rows.
    expect(pops).toHaveLength(5)
    const psa10 = pops.find(p => p.variant === 'firstEditionHolofoil' && p.grade === 'PSA 10')!
    expect(psa10.count).toBe(104)
    expect(psa10.total).toBe(1832)            // company-level total carried onto the grade row
    expect(psa10.grade_total).toBe(1811)
    expect(psa10.half_grade_total).toBe(21)
    // per-variant separation: the unlimited CGC pops are distinct rows
    const cgcAuth = pops.find(p => p.variant === 'unlimitedHolofoil' && p.grade === 'CGC auth')!
    expect(cgcAuth.count).toBe(1)
  })
  it('tier-resilient: missing/empty pop_reports → []', () => {
    expect(parsePopReports({})).toEqual([])
    expect(parsePopReports({ variants: [{ name: 'normal' }] })).toEqual([])
  })
})

describe('parseListings', () => {
  it('maps fields, normalises company, and converts sold_at', () => {
    const out = parseListings({ data: [
      { id: 'L1', title: 'PSA 10 Umbreon neo2', company: 'psa', grade: '10', price: '$2,100.00', sold_at: '2026-06-01T00:00:00Z', url: 'http://x', is_signed: false },
    ] }, 42)
    expect(out).toHaveLength(1)
    expect(out[0].listing_id).toBe('L1')
    expect(out[0].company).toBe('PSA')
    expect(out[0].grade).toBe('PSA 10')
    expect(out[0].price).toBe(2100)
    expect(out[0].sold_at).toBe(Math.floor(Date.parse('2026-06-01T00:00:00Z') / 1000))
  })
  it('synthesizes a stable id when Scrydex omits one', () => {
    const out = parseListings([{ company: 'PSA', grade: '10', price: 500, sold_at: 1700 }], 42)
    expect(out[0].listing_id).toContain('42:')
  })
  it('tier-resilient: empty → []', () => {
    expect(parseListings({}, 42)).toEqual([])
    expect(parseListings(null, 42)).toEqual([])
  })
})

describe('parsePriceHistory', () => {
  it('parses the confirmed day→prices[] shape (one row per day×point), slash dates → ISO', () => {
    const out = parsePriceHistory({ data: [
      { date: '2026/06/18', prices: [
        { variant: 'unlimitedHolofoil', grade: '8.5', company: 'BGS', type: 'graded', low: 399, mid: 500, high: 760, market: 700.36, currency: 'USD' },
        { variant: 'unlimitedHolofoil', condition: 'NM', type: 'raw', low: 1000, market: 499.2, currency: 'USD' },
      ] },
      { date: '2026/06/17', prices: [
        { variant: 'firstEditionHolofoil', grade: '10', company: 'CGC', type: 'graded', low: 4066, market: 11745.91, currency: 'USD' },
      ] },
    ] })
    expect(out).toHaveLength(3)
    const bgs = out.find(p => p.grade === 'BGS 8.5')!
    expect(bgs).toMatchObject({ variant: 'unlimitedHolofoil', company: 'BGS', condition: null, date: '2026-06-18', low: 399, market: 700.36 })
    const raw = out.find(p => p.condition === 'NM')!
    expect(raw).toMatchObject({ grade: null, company: null, date: '2026-06-18', market: 499.2 })
    expect(out.find(p => p.grade === 'CGC 10')!.date).toBe('2026-06-17')
  })
  it('day-level fallback shape still parses', () => {
    const out = parsePriceHistory({ data: [{ date: '2026-06-01', low: 10, market: 12 }] })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ date: '2026-06-01', market: 12 })
  })
  it('tier-resilient: missing → []', () => {
    expect(parsePriceHistory({})).toEqual([])
  })
})

// ── enrichCard control flow (Scrydex client mocked) ─────────────────────────────
function makeDb(productRow: any) {
  const runs: { sql: string; args: unknown[] }[] = []
  const batches: unknown[][] = []
  const db: any = {
    prepare(sql: string) {
      const stmt: any = {
        args: [] as unknown[],
        bind(...a: unknown[]) { stmt.args = a; return stmt },
        async first() {
          if (sql.includes('canonical_games')) return productRow
          return null
        },
        async all() {
          if (sql.includes('tcgplayer_product_id IN')) return { results: [{ id: 42, pid: 12345 }] }
          return { results: [] }
        },
        async run() { runs.push({ sql, args: stmt.args }); return { meta: {} } },
      }
      return stmt
    },
    async batch(stmts: any[]) { batches.push(stmts); return stmts.map(() => ({})) },
    _runs: runs, _batches: batches,
  }
  return db
}
const PRODUCT_ROW = { id: 42, scrydex_card_id: 'neo2-13', number: '13', expansion_id: 'neo2', game: 'Pokemon' }
const okRes = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

describe('enrichCard', () => {
  it('no scrydex card mapping → skipped gracefully', async () => {
    const db = makeDb({ ...PRODUCT_ROW, scrydex_card_id: null, expansion_id: null, number: null })
    const r = await enrichCard({ DB: db } as any, { canonicalProductId: 42, classes: ['core'] })
    expect(r).toEqual({ ok: true, skipped: 'no_scrydex_id' })
  })

  it('unsupported game → skipped', async () => {
    const db = makeDb({ ...PRODUCT_ROW, game: 'Yu-Gi-Oh!' })
    const r = await enrichCard({ DB: db } as any, { canonicalProductId: 42, classes: ['core'] })
    expect(r).toMatchObject({ ok: true, skipped: 'unsupported_game' })
  })

  // WP-3 (audit IMG-5) pricing-path fix: the local GAME_NAME_TO_SLUG once keyed 'Lorcana'/
  // 'Riftbound' — spellings that matched NO canonical_games.name, so a Lorcana TCG / Riftbound
  // card returned skipped='unsupported_game' and could never detail-enrich. It now imports the
  // shared lib/gameNames.ts map keyed by the EXACT canonical names.
  it('WP-3: a Lorcana TCG card resolves the correct slug end-to-end (was silently unsupported)', async () => {
    ;(scrydexFetch as any).mockClear()
    const db = makeDb({ ...PRODUCT_ROW, game: 'Lorcana TCG' })
    ;(scrydexFetch as any).mockResolvedValue(okRes({ data: UMBREON }))
    const r = await enrichCard({ DB: db } as any, { canonicalProductId: 42, classes: ['core'] })
    expect(r.ok).toBe(true)
    expect(r.skipped).toBeUndefined()
    // The Scrydex endpoint carries the resolved slug — never a skipped run.
    expect((scrydexFetch as any).mock.calls[0][1]).toMatch(/^\/lorcana\/v1\/cards\//)
  })

  it('WP-3: a Riftbound card (full canonical name) resolves the correct slug end-to-end', async () => {
    ;(scrydexFetch as any).mockClear()
    const db = makeDb({ ...PRODUCT_ROW, game: 'Riftbound League of Legends Trading Card Game' })
    ;(scrydexFetch as any).mockResolvedValue(okRes({ data: UMBREON }))
    const r = await enrichCard({ DB: db } as any, { canonicalProductId: 42, classes: ['core'] })
    expect(r.ok).toBe(true)
    expect(r.skipped).toBeUndefined()
    expect((scrydexFetch as any).mock.calls[0][1]).toMatch(/^\/riftbound\/v1\/cards\//)
  })

  it('WP-3/IMG-6: a Pokemon Japan card is unsupported and never fetches (no English-slug collision)', async () => {
    ;(scrydexFetch as any).mockClear()
    const db = makeDb({ ...PRODUCT_ROW, game: 'Pokemon Japan' })
    const r = await enrichCard({ DB: db } as any, { canonicalProductId: 42, classes: ['core'] })
    expect(r).toMatchObject({ ok: true, skipped: 'unsupported_game' })
    expect(scrydexFetch as any).not.toHaveBeenCalled()   // JP never rides the English 'pokemon' slug
  })

  it('core: parses + batches upserts and marks the class fresh', async () => {
    const db = makeDb(PRODUCT_ROW)
    ;(scrydexFetch as any).mockResolvedValue(okRes({ data: UMBREON }))
    const r = await enrichCard({ DB: db } as any, { canonicalProductId: 42, classes: ['core'] })
    expect(r.ok).toBe(true)
    expect(r.core!.pricesUpserted).toBeGreaterThan(0)
    expect(r.core!.popUpserted).toBe(5)   // 3 PSA (firstEd) + 2 CGC (unlimited) grade rows
    expect(db._batches.length).toBeGreaterThan(0)
    // markFresh ran for 'core'
    expect(db._runs.some((x: any) => x.sql.includes('card_enrichment_freshness') && x.args.includes('core'))).toBe(true)
  })

  it('403 credit cap → stops with skipped=credit_cap (serve last-persisted)', async () => {
    const db = makeDb(PRODUCT_ROW)
    ;(scrydexFetch as any).mockResolvedValue(new Response('{}', { status: 403 }))
    const r = await enrichCard({ DB: db } as any, { canonicalProductId: 42, classes: ['core'] })
    expect(r.skipped).toBe('credit_cap')
  })

  it('credit guard trip → skipped=credit_guard', async () => {
    const db = makeDb(PRODUCT_ROW)
    ;(scrydexFetch as any).mockRejectedValue(new ScrydexCreditLimitError())
    const r = await enrichCard({ DB: db } as any, { canonicalProductId: 42, classes: ['core', 'comps'] })
    expect(r.skipped).toBe('credit_guard')
  })
})
