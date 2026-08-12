import { describe, it, expect, vi, afterEach } from 'vitest'
import { probeScrydexFields, censusFields, tcgplayerProductIdOf } from './scrydexFieldProbe.js'

// Minimal fake D1 — the shape scrydexSyncSet.test.ts / scrydexProcessor.test.ts use.
function makeFakeDB(opts: {
  first?: (sql: string, args: unknown[]) => unknown
  all?:   (sql: string, args: unknown[]) => unknown[]
} = {}) {
  const reads: { sql: string; args: unknown[] }[] = []
  const writes: string[] = []
  return {
    prepare(sql: string) {
      const stmt = {
        sql,
        args: [] as unknown[],
        bind(...a: unknown[]) { stmt.args = a; return stmt },
        async first() { reads.push({ sql, args: stmt.args }); return opts.first ? opts.first(sql, stmt.args) : null },
        async all()   { reads.push({ sql, args: stmt.args }); return { results: opts.all ? opts.all(sql, stmt.args) : [] } },
        async run()   { writes.push(sql); return { meta: {} } },
      }
      return stmt
    },
    async batch(stmts: { sql: string }[]) { for (const s of stmts) writes.push(s.sql); return [] },
    _reads: reads,
    _writes: writes,
  }
}

/**
 * Writes that are NOT the mandatory `scrydex_api_log` credit accounting. The probe must never make
 * one: no attribute rows, no freshness marks, no hash stamps. (Every Scrydex call logs its credit
 * through the shared client — that row is the guard's input, not a data write.)
 */
const dataWrites = (db: { _writes: string[] }) =>
  db._writes.filter(sql => !sql.includes('scrydex_api_log'))

const MAPPED_SET = { name: 'Foundations', scrydex_expansion_id: 'FDN' }

/** The shape Scrydex's docs describe for a Magic card — the probe must not depend on it. */
const MTG_CARD = {
  id: 'FDN-214', name: 'Zurgo Helmsmasher', number: '214',
  mana_cost: '{2}{R}{W}{B}', mana_value: 5,
  colors: ['B', 'R', 'W'], color_identity: ['B', 'R', 'W'],
  type: 'Legendary Creature — Orc Warrior', types: ['Creature'],
  supertypes: ['Legendary'], subtypes: ['Orc', 'Warrior'],
  rarity: 'Mythic',
  variants: [{ name: 'normal', marketplaces: [{ name: 'tcgplayer', product_id: '9001' }] }],
}
const LAND_CARD = {
  id: 'FDN-270', name: 'Island', number: '270',
  mana_cost: '', mana_value: 0, colors: [], color_identity: [],
  type: 'Basic Land — Island',
  variants: [{ name: 'normal', marketplaces: [] }],
}

function mockFetch(payload: unknown, status = 200) {
  return vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({
    ok: status === 200,
    status,
    async json() { return payload },
  } as any)
}

const env = (db: any) => ({
  DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't', SCRYDEX_MONTHLY_LIMIT: '50000',
}) as any

afterEach(() => vi.restoreAllMocks())

describe('censusFields', () => {
  it('counts presence per key and treats empty string / [] / {} as absent', () => {
    const rows = censusFields([MTG_CARD, LAND_CARD])
    const by = Object.fromEntries(rows.map(r => [r.field, r]))
    expect(by.mana_cost.present).toBe(1)         // the land's '' does not count
    expect(by.colors.present).toBe(1)            // the land's [] does not count
    expect(by.name.present).toBe(2)
    expect(by.mana_cost.sample).toBe('{2}{R}{W}{B}')
    expect(by.colors.kind).toBe('array<string>')
  })

  it('ignores non-objects instead of throwing', () => {
    expect(censusFields([null, 'x', 42, undefined])).toEqual([])
  })
})

describe('tcgplayerProductIdOf', () => {
  it('reads the tcgplayer marketplace product id, and returns null for anything else', () => {
    expect(tcgplayerProductIdOf(MTG_CARD.variants[0])).toBe(9001)
    expect(tcgplayerProductIdOf(LAND_CARD.variants[0])).toBeNull()
    expect(tcgplayerProductIdOf({ marketplaces: [{ name: 'ebay', product_id: '1' }] })).toBeNull()
    expect(tcgplayerProductIdOf(null)).toBeNull()
  })
})

describe('probeScrydexFields', () => {
  it('reports the field census and per-rung match counts, and writes NOTHING', async () => {
    const db = makeFakeDB({
      first: (sql) => (sql.includes('FROM   sets s') ? MAPPED_SET : { total: 0 }),
      all: (sql) => {
        if (sql.includes('tcgplayer_product_id IN')) return [{ tcgplayer_product_id: 9001 }]
        if (sql.includes('LOWER(p.number) IN'))      return [{ number: 'fdn-270' }]
        return []
      },
    })
    mockFetch({ data: [MTG_CARD, LAND_CARD], totalCount: 2 })

    const res = await probeScrydexFields(env(db))

    expect(res.ok).toBe(true)
    expect(res.expansionId).toBe('FDN')
    expect(res.setName).toBe('Foundations')
    expect(res.cardsSampled).toBe(2)
    expect(res.requests).toBe(1)                       // ONE page = one credit
    expect(res.withTcgplayerProductId).toBe(1)

    // The two fields the whole workstream turns on are surfaced by name.
    const fields = Object.fromEntries((res.cardFields ?? []).map(f => [f.field, f.present]))
    expect(fields.mana_cost).toBe(1)
    expect(fields.colors).toBe(1)

    // Zurgo matches on R1 (tcgplayer id); the Island matches on R2 (card.id vs products.number).
    expect(res.matchRungs).toEqual({
      r1_tcgplayerProductId: 1,
      r2_cardIdVsNumber:     1,
      r3_numberInExpansion:  0,
      anyRung:               2,
      unmatched:             0,
    })
    expect(dataWrites(db)).toEqual([])                     // READ-ONLY, always
  })

  it('records an unmatched card as a catalogue gap instead of forcing a match', async () => {
    const db = makeFakeDB({
      first: (sql) => (sql.includes('FROM   sets s') ? MAPPED_SET : { total: 0 }),
      all: () => [],                                   // nothing in our catalogue resolves
    })
    mockFetch({ data: [MTG_CARD], totalCount: 1 })

    const res = await probeScrydexFields(env(db))
    expect(res.matchRungs?.unmatched).toBe(1)
    expect(res.matchRungs?.anyRung).toBe(0)
    expect(res.unmatchedSample).toEqual([{ id: 'FDN-214', name: 'Zurgo Helmsmasher', number: '214' }])
    expect(dataWrites(db)).toEqual([])
  })

  it('returns the provider status rather than throwing when Scrydex refuses the call', async () => {
    const db = makeFakeDB({ first: (sql) => (sql.includes('FROM   sets s') ? MAPPED_SET : { total: 0 }) })
    mockFetch({}, 402)                                 // the live 2026-08-04 wall: HTTP 402

    const res = await probeScrydexFields(env(db))
    expect(res.ok).toBe(false)
    expect(res.status).toBe(402)
    expect(res.expansionId).toBe('FDN')                // context preserved for the operator
    expect(dataWrites(db)).toEqual([])
  })

  it('fails clearly for a game with no Scrydex slug, before spending anything', async () => {
    const fetchSpy = mockFetch({ data: [] })
    const res = await probeScrydexFields(env(makeFakeDB()), { game: 'YuGiOh' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('no Scrydex slug')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fails clearly when the game has no mapped expansion at all', async () => {
    const fetchSpy = mockFetch({ data: [] })
    const db = makeFakeDB({ first: () => null })
    const res = await probeScrydexFields(env(db), { game: 'Magic' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('no mapped set found')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
