import { describe, it, expect, vi, afterEach } from 'vitest'
import { seedVariantProducts } from './backfillR2Urls.js'

// ── Fake D1: records prepared SQL + batched statements; routes first()/all() by SQL. ──
interface FakeStmt { sql: string; args: unknown[]; bind: (...a: unknown[]) => FakeStmt; first: () => Promise<unknown>; all: () => Promise<{ results: unknown[] }>; run: () => Promise<unknown> }
function makeFakeDB(opts: { first?: (sql: string, a: unknown[]) => unknown; all?: (sql: string, a: unknown[]) => unknown[] }) {
  const batches: FakeStmt[][] = []
  const prepared: string[] = []
  const db = {
    prepare(sql: string): FakeStmt {
      prepared.push(sql)
      const stmt: FakeStmt = {
        sql, args: [],
        bind(...a: unknown[]) { stmt.args = a; return stmt },
        async first() { return opts.first ? opts.first(sql, stmt.args) : null },
        async all() { return { results: opts.all ? opts.all(sql, stmt.args) : [] } },
        async run() { return {} },
      }
      return stmt
    },
    async batch(stmts: FakeStmt[]) { batches.push(stmts); return stmts.map(() => ({})) },
    _batches: batches,
    _prepared: prepared,
  }
  return db
}

const SET_ROW = { game_id: 7, game: 'One Piece Card Game', scrydex_set_id: 'op09' }
const BASE_ROW = { set_id: 10, name: 'Monkey D. Luffy', number: 'OP09-004', rarity: 'L' }

// Two clean variants + a 657442 intra-payload collision pair.
const CARD = {
  id: 'OP09-004', number: 'OP09-004',
  printings: ['OP09', 'OP13', 'PRB02'],
  variants: [
    { name: 'foil',              marketplaces: [{ name: 'tcgplayer', product_id: '111' }], images: [{ type: 'front', large: 'a.jpg' }], printings: ['OP09'] },
    { name: 'altArt',            marketplaces: [{ name: 'tcgplayer', product_id: '222' }], images: [{ type: 'front', large: 'b.jpg' }], printings: ['OP09'] },
    { name: 'wantedPoster',      marketplaces: [{ name: 'tcgplayer', product_id: '657442' }], images: [{ type: 'front', large: 'c.jpg' }], printings: ['OP13'] },
    { name: 'goldSpecialAltArt', marketplaces: [{ name: 'tcgplayer', product_id: '657442' }], images: [{ type: 'front', large: 'd.jpg' }], printings: ['PRB02'] },
  ],
}

function firstRouter(sql: string) {
  if (sql.includes('SUM(credits_used)')) return { total: 0 }   // credit guard
  return null
}
function allRouter(sql: string) {
  if (sql.includes('canonical_games g ON g.id = s.game_id')) return [SET_ROW]            // set list
  if (sql.includes('LOWER(p.number) IN')) return [BASE_ROW]                              // batched base lookup
  if (sql.includes('tcgplayer_product_id IN')) return []                                 // no existing products
  return []
}

afterEach(() => { vi.unstubAllGlobals() })

describe('seedVariantProducts — canonical repoint', () => {
  it('writes canonical products (never tcg_products) and routes the 657442 collision', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ data: [CARD] }), { status: 200, headers: { 'content-type': 'application/json' } })))

    const db = makeFakeDB({ first: firstRouter, all: allRouter })
    const res = await seedVariantProducts(
      { DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any,
      'One Piece Card Game',
    )

    // foil(111) + altArt(222) seeded; wantedPoster/goldSpecialAltArt share 657442 → conflicts.
    expect(res.inserted).toBe(2)
    expect(res.conflicted).toBe(2)

    const batched = db._batches.flat()
    const sqls = batched.map(s => s.sql)

    // Seeds canonical products, with structured capture + preserve-on-conflict.
    const inserts = sqls.filter(s => s.includes('INSERT INTO products'))
    expect(inserts.length).toBe(2)
    expect(inserts[0]).toContain('ON CONFLICT (tcgplayer_product_id)')
    expect(inserts[0]).toContain('scrydex_card_id = COALESCE(excluded.scrydex_card_id, products.scrydex_card_id)')

    // Per-variant image keyed on the product_id bridge (canonical product_images).
    expect(sqls.some(s => s.includes('INSERT INTO product_images') && s.includes('tcgplayer_product_id = ?'))).toBe(true)

    // Collision routed to the conflict queue, not written as a product.
    const conflicts = batched.filter(s => s.sql.includes('variant_ingest_conflicts'))
    expect(conflicts).toHaveLength(2)
    expect(conflicts.every(s => s.args[1] === '657442')).toBe(true)

    // NO writer touches the frozen tcg_* tables.
    expect(db._prepared.every(s => !/\btcg_products\b|\btcg_sets\b|\btcg_categories\b/.test(s))).toBe(true)
  })
})
