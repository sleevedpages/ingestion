import { describe, it, expect } from 'vitest'
import worker from './worker.js'
import { mintPcConsole, parsePcProductName, isSealedMintRow } from './mintPcConsole.js'

// ── Pure parsers ─────────────────────────────────────────────────────────────────
describe('parsePcProductName', () => {
  it('splits "Gengar #307" → name Gengar, number 307', () => {
    expect(parsePcProductName('Gengar #307')).toEqual({ name: 'Gengar', number: '307' })
  })
  it('handles multi-word names ("Captain Pikachu #709")', () => {
    expect(parsePcProductName('Captain Pikachu #709')).toEqual({ name: 'Captain Pikachu', number: '709' })
  })
  it('no #NNN token → number null (sealed "Booster Box")', () => {
    expect(parsePcProductName('Booster Box')).toEqual({ name: 'Booster Box', number: null })
  })
  it('embedded token position is tolerated', () => {
    expect(parsePcProductName('Gengar #307 [Holo]')).toEqual({ name: 'Gengar [Holo]', number: '307' })
  })
})

describe('isSealedMintRow', () => {
  it('trusts the genre-derived is_sealed flag', () => {
    expect(isSealedMintRow({ product_name: 'Anything', is_sealed: 1 })).toBe(true)
  })
  it('classifies Booster Box/Pack–shaped names even without the flag', () => {
    expect(isSealedMintRow({ product_name: 'Booster Box', is_sealed: 0 })).toBe(true)
    expect(isSealedMintRow({ product_name: 'Booster Pack', is_sealed: null })).toBe(true)
  })
  it('cards stay cards', () => {
    expect(isSealedMintRow({ product_name: 'Gengar #307', is_sealed: 0 })).toBe(false)
  })
})

// ── Fake D1 with the four tables the mint touches ────────────────────────────────
interface PcRow { pc_id: string; game_category: string; console_name: string; product_name: string;
                  is_sealed: number; canonical_product_id: number | null; match_method: string | null }

function makeMintDb(pcRows: PcRow[]) {
  const games = [{ id: 12, tcgplayer_category_id: 3 }]           // canonical Pokémon spine row
  const sets: Array<{ id: number; game_id: number; name: string; code: string | null }> = []
  const products: Array<{ id: number; set_id: number; name: string; number: string | null; product_kind: string }> = []
  let nextSetId = 900, nextProductId = 5000

  function run(sql: string, args: any[]): any {
    if (sql.includes('INSERT INTO sets')) {
      sets.push({ id: nextSetId++, game_id: args[0], name: args[1], code: args[2] })
      return { results: [] }
    }
    if (sql.includes('INSERT INTO products')) {
      products.push({ id: nextProductId++, set_id: args[0], name: args[1], number: args[2], product_kind: args[3] })
      return { results: [] }
    }
    if (sql.includes('UPDATE pricecharting_products')) {
      const [productId, pcId] = args
      const row = pcRows.find((r) => r.pc_id === pcId)
      if (row && row.canonical_product_id == null) {
        row.canonical_product_id = productId
        row.match_method = 'minted'
      }
      return { results: [] }
    }
    if (sql.includes('FROM canonical_games')) {
      return { results: games.filter((g) => g.tcgplayer_category_id === args[0]) }
    }
    if (sql.includes('FROM pricecharting_products')) {
      return { results: pcRows.filter((r) =>
        r.game_category === args[0] && r.console_name === args[1] && r.canonical_product_id == null) }
    }
    if (sql.includes('FROM sets')) {
      return { results: sets.filter((s) => s.game_id === args[0] && s.name === args[1]) }
    }
    if (sql.includes('MIN(id)')) {
      const inSet = products.filter((p) => p.set_id === args[0]).map((p) => p.id)
      return { results: [{ min: inSet.length ? Math.min(...inSet) : null, max: inSet.length ? Math.max(...inSet) : null }] }
    }
    if (sql.includes('FROM products')) {
      return { results: products.filter((p) => p.set_id === args[0])
        .map((p) => ({ id: p.id, name: p.name, number: p.number ?? '' })) }
    }
    throw new Error('unhandled SQL: ' + sql.slice(0, 60))
  }

  const db = {
    _sets: sets, _products: products, _pcRows: pcRows,
    prepare(sql: string) {
      return {
        bind(...a: any[]) {
          return {
            _sql: sql, _args: a,
            all: async () => run(sql, a),
            first: async () => run(sql, a).results[0] ?? null,
            run: async () => { run(sql, a); return {} },
          }
        },
      }
    },
    async batch(stmts: any[]) { for (const s of stmts) run(s._sql, s._args); return stmts.map(() => ({})) },
  }
  return db
}

const GEM_ROWS = (): PcRow[] => [
  { pc_id: 'gp1', game_category: 'pokemon-cards', console_name: 'Pokemon Chinese Gem Pack',
    product_name: 'Gengar #307', is_sealed: 0, canonical_product_id: null, match_method: null },
  { pc_id: 'gp2', game_category: 'pokemon-cards', console_name: 'Pokemon Chinese Gem Pack',
    product_name: 'Captain Pikachu #709', is_sealed: 0, canonical_product_id: null, match_method: null },
  { pc_id: 'gp3', game_category: 'pokemon-cards', console_name: 'Pokemon Chinese Gem Pack',
    product_name: 'Booster Box', is_sealed: 1, canonical_product_id: null, match_method: null },
  // A different console in the same category — must be untouched.
  { pc_id: 'other1', game_category: 'pokemon-cards', console_name: 'Pokemon Chinese Gem Pack 2',
    product_name: 'Cubone #407', is_sealed: 0, canonical_product_id: null, match_method: null },
]

describe('mintPcConsole', () => {
  const input = { gameCategory: 'pokemon-cards', consoleName: 'Pokemon Chinese Gem Pack', setCode: 'CBB1C' }

  it('mints ONE set + parsed products (sealed classified) and stamps the map rows', async () => {
    const db = makeMintDb(GEM_ROWS())
    const res = await mintPcConsole({ DB: db } as any, input)

    expect(res.ok).toBe(true)
    expect(res.setCreated).toBe(true)
    expect(res.productsCreated).toBe(3)
    expect(res.sealed).toBe(1)
    expect(res.stamped).toBe(3)
    expect(res.skipped).toBe(0)
    expect(res.productIds).toBeTruthy()

    // Set: canonical Pokémon game, PC console name, operator code, NO tcgplayer_group_id column set.
    expect(db._sets).toEqual([{ id: 900, game_id: 12, name: 'Pokemon Chinese Gem Pack', code: 'CBB1C' }])
    // Products: name/number parsed; Booster Box sealed with number null; no external ids bound.
    const byName = Object.fromEntries(db._products.map((p) => [p.name, p]))
    expect(byName['Gengar']).toMatchObject({ number: '307', product_kind: 'card', set_id: 900 })
    expect(byName['Captain Pikachu']).toMatchObject({ number: '709', product_kind: 'card' })
    expect(byName['Booster Box']).toMatchObject({ number: null, product_kind: 'sealed' })
    // Stamps: canonical id + method 'minted' on THIS console's rows only.
    const gp1 = db._pcRows.find((r) => r.pc_id === 'gp1')!
    expect(gp1.canonical_product_id).toBe(byName['Gengar'].id)
    expect(gp1.match_method).toBe('minted')
    expect(db._pcRows.find((r) => r.pc_id === 'other1')!.canonical_product_id).toBeNull()
  })

  it('is idempotent — a double-run creates no duplicate sets/products and stamps nothing new', async () => {
    const db = makeMintDb(GEM_ROWS())
    await mintPcConsole({ DB: db } as any, input)
    const setsAfter1 = db._sets.length, productsAfter1 = db._products.length

    const res2 = await mintPcConsole({ DB: db } as any, input)
    expect(res2.ok).toBe(true)
    expect(res2.setCreated).toBe(false)
    expect(res2.productsCreated).toBe(0)
    expect(res2.stamped).toBe(0)              // nothing left unmatched
    expect(db._sets.length).toBe(setsAfter1)
    expect(db._products.length).toBe(productsAfter1)
  })

  it('a later-appearing unmatched row lands in the EXISTING minted set on re-run', async () => {
    const rows = GEM_ROWS()
    const db = makeMintDb(rows)
    await mintPcConsole({ DB: db } as any, input)
    // The next daily CSV pass records a brand-new Gem Pack card, unmatched.
    rows.push({ pc_id: 'gp4', game_category: 'pokemon-cards', console_name: 'Pokemon Chinese Gem Pack',
      product_name: 'Mewtwo #150', is_sealed: 0, canonical_product_id: null, match_method: null })

    const res = await mintPcConsole({ DB: db } as any, input)
    expect(res.setCreated).toBe(false)
    expect(res.productsCreated).toBe(1)
    expect(res.stamped).toBe(1)
    expect(db._sets.length).toBe(1)
    expect(db._pcRows.find((r) => r.pc_id === 'gp4')!.match_method).toBe('minted')
  })

  it('rejects an unknown category and a missing console', async () => {
    const db = makeMintDb([])
    expect((await mintPcConsole({ DB: db } as any, { gameCategory: 'beanie-babies', consoleName: 'x' })).ok).toBe(false)
    expect((await mintPcConsole({ DB: db } as any, { gameCategory: 'pokemon-cards', consoleName: '' })).ok).toBe(false)
  })

  it('a console with zero unmatched rows mints nothing (no empty set)', async () => {
    const db = makeMintDb([])
    const res = await mintPcConsole({ DB: db } as any, { gameCategory: 'pokemon-cards', consoleName: 'Pokemon Chinese Gem Pack' })
    expect(res.ok).toBe(true)
    expect(res.unmatchedRows).toBe(0)
    expect(db._sets.length).toBe(0)
  })
})

// ── Endpoint auth (matches the WP-0 worker pattern) ──────────────────────────────
describe('POST /admin/mint-pc-console — auth + validation', () => {
  const ctx = { waitUntil: (p: Promise<unknown>) => { p.catch(() => {}) } } as any

  it('401 without the worker secret', async () => {
    const res = await worker.fetch(
      new Request('https://w/admin/mint-pc-console', { method: 'POST', body: '{}' }),
      { DB: {} as any, IMAGES_BUCKET: {} as any, INGESTION_WORKER_SECRET: 's' } as any, ctx)
    expect(res.status).toBe(401)
  })

  it('400 when console_name / game are missing', async () => {
    const res = await worker.fetch(
      new Request('https://w/admin/mint-pc-console', {
        method: 'POST', headers: { 'x-worker-secret': 's', 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
      { DB: {} as any, IMAGES_BUCKET: {} as any, INGESTION_WORKER_SECRET: 's' } as any, ctx)
    expect(res.status).toBe(400)
  })

  it('runs the mint with the correct secret', async () => {
    const db = makeMintDb(GEM_ROWS())
    const res = await worker.fetch(
      new Request('https://w/admin/mint-pc-console', {
        method: 'POST', headers: { 'x-worker-secret': 's', 'content-type': 'application/json' },
        body: JSON.stringify({ console_name: 'Pokemon Chinese Gem Pack', game: 'pokemon-cards', set_code: 'CBB1C' }),
      }),
      { DB: db, IMAGES_BUCKET: {} as any, INGESTION_WORKER_SECRET: 's' } as any, ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ok).toBe(true)
    expect(body.productsCreated).toBe(3)
  })
})
