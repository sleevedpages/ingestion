import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  runMtgAttributeFill,
  attributesForCard,
  tcgplayerProductIdOf,
  FILL_FRESHNESS_CLASS,
} from './mtgAttributeFill.js'

/**
 * FIXTURES ARE FROM THE LIVE PROBE (expansion SPG, 166 cards, 2026-08-12) — the same discipline as
 * the mig-0125 per-game fixtures. What that run established and these tests lock down:
 *   · `mana_cost` is a verbatim symbol string (`{U}{U}`), `colors`/`color_identity` are arrays
 *   · a land carries `mana_value: 0` and NO colours — colourless, which is NOT "unknown"
 *   · R1 (tcgplayer product_id) resolves 98.8%, R3 (number in expansion) 99.4%, R2 0.0%
 *   · Scrydex caps the page at 100 regardless of the 250 we ask for
 */
const MERFOLK = {
  id: 'SPG-1', name: 'Lord of Atlantis', number: '1',
  mana_cost: '{U}{U}', mana_value: 2, colors: ['U'], color_identity: ['U'],
  type: 'Creature — Merfolk',
  variants: [{ name: 'normal', marketplaces: [{ name: 'tcgplayer', product_id: '517534' }] }],
}
const LAND = {
  id: 'SPG-158', name: 'Ancient Tomb', number: '158',
  mana_cost: '', mana_value: 0, colors: [], color_identity: [],
  type: 'Land',
  variants: [{ name: 'normal', marketplaces: [{ name: 'tcgplayer', product_id: '517600' }] }],
}
const GOLD = {
  id: 'SPG-42', name: 'Fires of Victory', number: '42',
  mana_cost: '{2}{W}{U}', mana_value: 4, colors: ['W', 'U'], color_identity: ['W', 'U'],
  variants: [{ name: 'normal', marketplaces: [{ name: 'tcgplayer', product_id: '517700' }] }],
}
/** The real unmatched card from the probe: a lettered number our catalogue doesn't carry. */
const ORPHAN = {
  id: 'SPG-158a', name: 'Library of Alexandria', number: '158a',
  mana_cost: '', mana_value: 0,
  variants: [{ name: 'normal', marketplaces: [{ name: 'tcgplayer', product_id: '999999' }] }],
}

function makeFakeDB(opts: {
  expansions?: { scrydex_expansion_id: string }[]
  byTcgId?:    Record<string, number>
  byNumber?:   Record<string, number[]>
} = {}) {
  const batched: { sql: string; args: unknown[] }[] = []
  const runs: { sql: string; args: unknown[] }[] = []
  const db = {
    prepare(sql: string) {
      const stmt = {
        sql,
        args: [] as unknown[],
        bind(...a: unknown[]) { stmt.args = a; return stmt },
        async first() { return sql.includes('SUM(credits_used)') ? { total: 0 } : null },
        async all() {
          if (sql.includes('FROM   sets s') && sql.includes('GROUP BY s.scrydex_expansion_id')) {
            return { results: opts.expansions ?? [{ scrydex_expansion_id: 'SPG' }] }
          }
          if (sql.includes('tcgplayer_product_id IN')) {
            return {
              results: (stmt.args as number[])
                .filter(id => opts.byTcgId?.[String(id)] !== undefined)
                .map(id => ({ id: opts.byTcgId![String(id)], tcgplayer_product_id: id })),
            }
          }
          if (sql.includes('LOWER(p.number) IN')) {
            const numbers = (stmt.args as string[]).slice(1)
            const out: { id: number; number: string }[] = []
            for (const n of numbers) for (const id of opts.byNumber?.[n] ?? []) out.push({ id, number: n })
            return { results: out }
          }
          return { results: [] }
        },
        async run() { runs.push({ sql, args: stmt.args }); return { meta: {} } },
      }
      return stmt
    },
    async batch(stmts: { sql: string; args: unknown[] }[]) { batched.push(...stmts); return [] },
    _batched: batched,
    _runs: runs,
  }
  return db
}

const env = (db: any) => ({
  DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't', SCRYDEX_MONTHLY_LIMIT: '50000',
}) as any

function mockCards(cards: unknown[], status = 200) {
  return vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({
    ok: status === 200, status,
    async json() { return { data: cards, totalCount: cards.length } },
  } as any)
}

const inserts = (db: any) => db._batched.filter((s: any) => s.sql.startsWith('INSERT INTO product_attributes'))
const rowsOf  = (db: any) => inserts(db).flatMap((s: any) => {
  const out: { productId: number; name: string; value: string }[] = []
  for (let i = 0; i < s.args.length; i += 4) out.push({ productId: s.args[i], name: s.args[i + 1], value: s.args[i + 2] })
  return out
})

afterEach(() => vi.restoreAllMocks())

describe('attributesForCard', () => {
  it('stores the mana cost verbatim and joins colour arrays with `;`', () => {
    expect(attributesForCard(GOLD)).toEqual([
      { name: '@scrydex.mana_cost',      value: '{2}{W}{U}', position: 0 },
      { name: '@scrydex.mana_value',     value: '4',         position: 1 },
      { name: '@scrydex.colors',         value: 'W;U',       position: 2 },
      { name: '@scrydex.color_identity', value: 'W;U',       position: 3 },
    ])
  })

  it('a land keeps mana_value 0 and stores NO colours — colourless, not unknown', () => {
    // The read side tells colourless from unfilled by the PRESENCE of the group, so the mana_value
    // row landing here is what makes "no colours row" mean something.
    expect(attributesForCard(LAND)).toEqual([
      { name: '@scrydex.mana_value', value: '0', position: 0 },
    ])
  })

  it('never throws on a malformed or empty card', () => {
    expect(attributesForCard(null)).toEqual([])
    expect(attributesForCard('nope')).toEqual([])
    expect(attributesForCard({})).toEqual([])
  })
})

describe('tcgplayerProductIdOf', () => {
  it('reads the tcgplayer bridge and ignores everything else', () => {
    expect(tcgplayerProductIdOf(MERFOLK.variants[0])).toBe(517534)
    expect(tcgplayerProductIdOf({ marketplaces: [{ name: 'ebay', product_id: '1' }] })).toBeNull()
    expect(tcgplayerProductIdOf(undefined)).toBeNull()
  })
})

describe('runMtgAttributeFill', () => {
  it('writes @scrydex rows via R1 and marks the expansion done', async () => {
    const db = makeFakeDB({ byTcgId: { '517534': 11, '517600': 12 } })
    mockCards([MERFOLK, LAND])

    const res = await runMtgAttributeFill(env(db))

    expect(res.ok).toBe(true)
    expect(res.expansionsProcessed).toBe(1)
    expect(res.productsWritten).toBe(2)
    expect(res.cardsUnmatched).toBe(0)
    expect(rowsOf(db)).toEqual([
      { productId: 11, name: '@scrydex.mana_cost',      value: '{U}{U}' },
      { productId: 11, name: '@scrydex.mana_value',     value: '2' },
      { productId: 11, name: '@scrydex.colors',         value: 'U' },
      { productId: 11, name: '@scrydex.color_identity', value: 'U' },
      { productId: 12, name: '@scrydex.mana_value',     value: '0' },
    ])
    // Each product's group is delete-then-insert, scoped to our namespace only.
    expect(db._batched[0].sql).toBe('DELETE FROM product_attributes WHERE product_id = ? AND name LIKE ?')
    expect(db._batched[0].args).toEqual([11, '@scrydex.%'])
    // Nothing may stamp the TCGCSV change guard.
    expect(db._batched.some((s: any) => s.sql.includes('extended_data_hash'))).toBe(false)
    // Freshness marked under our OWN class, so it can never fresh-skip a price fetch.
    const fresh = db._runs.find(r => r.sql.includes('scrydex_expansion_freshness'))
    expect(fresh!.args).toEqual(['SPG', FILL_FRESHNESS_CLASS])
  })

  it('falls back to R3 (number in expansion) and writes EVERY printing sharing that number', async () => {
    // No tcgplayer id resolves; the number matches two products (different treatments of one card).
    const db = makeFakeDB({ byTcgId: {}, byNumber: { '1': [21, 22] } })
    mockCards([MERFOLK])

    const res = await runMtgAttributeFill(env(db))

    expect(res.productsWritten).toBe(2)
    expect([...new Set(rowsOf(db).map(r => r.productId))]).toEqual([21, 22])
    expect(res.cardsUnmatched).toBe(0)
  })

  it('records an unmatched card instead of forcing a match', async () => {
    const db = makeFakeDB({ byTcgId: {}, byNumber: {} })
    mockCards([ORPHAN])

    const res = await runMtgAttributeFill(env(db))

    expect(res.cardsUnmatched).toBe(1)
    expect(rowsOf(db)).toEqual([])
    const unmatched = db._batched.find((s: any) => s.sql.includes('scrydex_unmatched_cards'))
    expect(unmatched).toBeTruthy()
    expect(unmatched!.args.slice(0, 3)).toEqual(['SPG-158a', 'Library of Alexandria', '158a'])
  })

  it('a matched card with no fillable fields is left alone — no bare DELETE clears a good fill', async () => {
    const db = makeFakeDB({ byTcgId: { '517534': 11 } })
    mockCards([{ ...MERFOLK, mana_cost: '', mana_value: null, colors: [], color_identity: [] }])

    const res = await runMtgAttributeFill(env(db))

    expect(res.attributeRowsWritten).toBe(0)
    expect(db._batched.filter((s: any) => s.sql.startsWith('DELETE FROM product_attributes'))).toEqual([])
    expect(res.cardsUnmatched).toBe(0)
  })

  it('re-running is a no-op: a marked expansion is filtered out by the freshness clause', async () => {
    const db = makeFakeDB({ expansions: [] })   // the NOT EXISTS filter removed everything
    const fetchSpy = mockCards([MERFOLK])

    const res = await runMtgAttributeFill(env(db))

    expect(res.expansionsProcessed).toBe(0)
    expect(res.hasMore).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()     // resumability costs ZERO credits
  })

  it('bounds the invocation and reports the remainder for the loop driver', async () => {
    const db = makeFakeDB({
      expansions: [{ scrydex_expansion_id: 'A' }, { scrydex_expansion_id: 'B' }, { scrydex_expansion_id: 'C' }],
      byTcgId: { '517534': 11 },
    })
    mockCards([MERFOLK])

    const res = await runMtgAttributeFill(env(db), { maxExpansions: 2 })

    expect(res.expansionsProcessed).toBe(2)
    expect(res.expansionsRemaining).toBe(1)
    expect(res.hasMore).toBe(true)
  })

  it('stops the whole run on a 402 without marking the in-flight expansion done', async () => {
    const db = makeFakeDB({
      expansions: [{ scrydex_expansion_id: 'A' }, { scrydex_expansion_id: 'B' }],
    })
    const fetchSpy = mockCards([], 402)

    const res = await runMtgAttributeFill(env(db))

    expect(res.ok).toBe(false)
    expect(res.stoppedReason).toBe('scrydex_402')
    expect(res.expansionsProcessed).toBe(0)
    expect(fetchSpy).toHaveBeenCalledTimes(1)   // not once per expansion
    expect(db._runs.some(r => r.sql.includes('scrydex_expansion_freshness'))).toBe(false)
  })

  it('chunks its reads at 90 ids (D1 caps bound params at 100)', async () => {
    const prepared: string[] = []
    const cards = Array.from({ length: 200 }, (_, i) => ({
      ...MERFOLK, id: `SPG-${i}`, number: String(i),
      variants: [{ name: 'normal', marketplaces: [{ name: 'tcgplayer', product_id: String(600000 + i) }] }],
    }))
    const base = makeFakeDB({ byTcgId: Object.fromEntries(cards.map((_, i) => [String(600000 + i), 1000 + i])) })
    const db = {
      ...base,
      prepare(sql: string) {
        if (sql.includes('tcgplayer_product_id IN')) prepared.push(sql)
        return base.prepare(sql)
      },
    }
    mockCards(cards)

    await runMtgAttributeFill(env(db))

    expect(prepared).toHaveLength(3)            // 90 + 90 + 20
    for (const sql of prepared) expect((sql.match(/\?/g) ?? []).length).toBeLessThanOrEqual(90)
  })

  it('never splits a product\'s statement group across two batches', async () => {
    const cards = Array.from({ length: 60 }, (_, i) => ({
      ...GOLD, id: `SPG-${i}`, number: String(i),
      variants: [{ name: 'normal', marketplaces: [{ name: 'tcgplayer', product_id: String(700000 + i) }] }],
    }))
    const db = makeFakeDB({ byTcgId: Object.fromEntries(cards.map((_, i) => [String(700000 + i), 2000 + i])) })
    const batchSizes: number[] = []
    const orig = db.batch.bind(db)
    db.batch = async (stmts: any[]) => { batchSizes.push(stmts.length); return orig(stmts) }
    mockCards(cards)

    await runMtgAttributeFill(env(db))

    // Every batch starts on a DELETE — i.e. no group was cut in half.
    let seen = 0
    for (const n of batchSizes) {
      expect(db._batched[seen].sql.startsWith('DELETE')).toBe(true)
      seen += n
    }
    expect(batchSizes.every(n => n <= 100)).toBe(true)
  })
})
