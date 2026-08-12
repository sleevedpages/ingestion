import { describe, it, expect } from 'vitest'
import { upsertProductSourceImages, syncProductAttributes } from './db.js'
import {
  EMPTY_ATTRIBUTES_HASH,
  attributesHash,
  buildExternalAttributes,
  externalAttributeStatements,
  extractProductAttributes,
} from '../lib/productAttributes.js'

// Fake D1 that records every batched statement's SQL + binds.
// `productRows` seeds the `SELECT id, tcgplayer_product_id, extended_data_hash FROM products`
// read that syncProductAttributes uses to resolve canonical ids + the change guard.
function makeFakeDB(productRows: {
  id: number; tcgplayer_product_id: number; extended_data_hash: string | null
}[] = []) {
  const batched: { sql: string; args: unknown[] }[] = []
  const batchCalls: number[] = []
  const db = {
    prepare(sql: string) {
      const stmt = {
        sql,
        args: [] as unknown[],
        bind(...a: unknown[]) { stmt.args = a; return stmt },
        async all() {
          const ids = new Set(stmt.args as number[])
          return { results: productRows.filter(r => ids.has(r.tcgplayer_product_id)) }
        },
      }
      return stmt
    },
    async batch(stmts: { sql: string; args: unknown[] }[]) {
      batchCalls.push(stmts.length)
      batched.push(...stmts)
      return stmts.map(() => ({}))
    },
    _batched: batched,
    _batchCalls: batchCalls,
  }
  return db
}

const row = (over: Record<string, unknown> = {}) => ({
  tcgplayer_product_id: 999,
  tcgplayer_group_id: 100,
  tcgplayer_category_id: 3,
  name: 'Pikachu',
  clean_name: 'pikachu',
  image_url: 'https://tcgplayer-cdn.tcgplayer.com/product/999_200w.jpg',
  tcgplayer_url: null,
  modified_on: null,
  image_count: 1,
  presale_info: null,
  card_number: '58/102',
  rarity: 'Common',
  extended_data: [],
  synced_at: new Date(),
  ...over,
}) as any

describe('upsertProductSourceImages — TCGPlayer image url -> product_images.source_url', () => {
  it('writes a source_url upsert per product that has an image_url', async () => {
    const db = makeFakeDB()
    await upsertProductSourceImages(db as any, [row({ tcgplayer_product_id: 1 }), row({ tcgplayer_product_id: 2 })], 'tcgplayer')
    expect(db._batched).toHaveLength(2)
    // Targets product_images via INSERT ... SELECT FROM products (resolves products.id),
    // and source is bound NULL (pre-mirror, stays mirror-eligible).
    expect(db._batched[0].sql).toContain('INSERT INTO product_images')
    expect(db._batched[0].sql).toContain('FROM products WHERE tcgplayer_product_id')
    // bind order in sourceUrlUpsertByProductId: (source, sourceUrl, tcgProductId)
    expect(db._batched[0].args[0]).toBeNull()
    expect(db._batched[0].args[1]).toContain('tcgplayer-cdn')
  })

  it('skips products with no image_url (no source to mirror)', async () => {
    const db = makeFakeDB()
    await upsertProductSourceImages(db as any, [row({ image_url: null }), row({ image_url: '' })], 'tcgplayer')
    expect(db._batched).toHaveLength(0)
  })

  it('is a no-op for an empty list', async () => {
    const db = makeFakeDB()
    await upsertProductSourceImages(db as any, [], 'tcgplayer')
    expect(db._batched).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// syncProductAttributes — TCGCSV extendedData -> product_attributes (mig 0125)
// ─────────────────────────────────────────────────────────────────────────────

const POKEMON_ED = [
  { name: 'Rarity', displayName: 'Rarity', value: 'Common' },
  { name: 'Card Type', displayName: 'Card Type', value: 'Lightning' },
  { name: 'Stage', displayName: 'Stage', value: 'Basic' },
  { name: 'CardText', displayName: 'Card Text', value: '<em>prose that must not be stored</em>' },
]
const POKEMON_HASH = attributesHash(extractProductAttributes(POKEMON_ED))

const attrRow = (over: Record<string, unknown> = {}) =>
  row({ extended_data: POKEMON_ED, attributes: extractProductAttributes(POKEMON_ED), ...over })

describe('syncProductAttributes — the change guard', () => {
  it('writes delete + insert + hash stamp for a product whose hash is NULL (the backfill case)', async () => {
    const db = makeFakeDB([{ id: 500, tcgplayer_product_id: 1, extended_data_hash: null }])
    const res = await syncProductAttributes(db as any, [attrRow({ tcgplayer_product_id: 1 })])

    expect(res).toEqual({
      productsChanged: 1,
      productsUnchanged: 0,
      attributeRowsWritten: 3, // CardText is prose and is skipped
      productsUnresolved: 0,
    })
    expect(db._batched.map(s => s.sql.split(' ')[0])).toEqual(['DELETE', 'INSERT', 'UPDATE'])
    // Rows are keyed on the CANONICAL products.id, never tcgplayer_product_id.
    expect(db._batched[0].args).toEqual([500])
    expect(db._batched[1].args.slice(0, 4)).toEqual([500, 'Rarity', 'Common', 0])
    expect(db._batched[1].args).not.toContain('CardText')
    // The stamp is LAST so a batch that never commits leaves the product to be redone.
    expect(db._batched[2].args).toEqual([POKEMON_HASH, 500])
  })

  it('issues NO statements at all when the stored hash already matches (the steady state)', async () => {
    const db = makeFakeDB([{ id: 500, tcgplayer_product_id: 1, extended_data_hash: POKEMON_HASH }])
    const res = await syncProductAttributes(db as any, [attrRow({ tcgplayer_product_id: 1 })])

    expect(res.productsUnchanged).toBe(1)
    expect(res.productsChanged).toBe(0)
    expect(db._batched).toHaveLength(0)
    expect(db._batchCalls).toHaveLength(0)
  })

  it('rewrites only the products that actually changed', async () => {
    const db = makeFakeDB([
      { id: 500, tcgplayer_product_id: 1, extended_data_hash: POKEMON_HASH },
      { id: 501, tcgplayer_product_id: 2, extended_data_hash: 'stale:0' },
      { id: 502, tcgplayer_product_id: 3, extended_data_hash: POKEMON_HASH },
    ])
    const res = await syncProductAttributes(db as any, [
      attrRow({ tcgplayer_product_id: 1 }),
      attrRow({ tcgplayer_product_id: 2 }),
      attrRow({ tcgplayer_product_id: 3 }),
    ])

    expect(res.productsChanged).toBe(1)
    expect(res.productsUnchanged).toBe(2)
    expect(db._batched.every(s => s.args.includes(501) || s.args[1] === 501)).toBe(true)
  })

  it('a product with EMPTY extendedData clears its rows and stamps the empty hash — once', async () => {
    const empty = row({ tcgplayer_product_id: 9, extended_data: [], attributes: [] })

    const first = makeFakeDB([{ id: 900, tcgplayer_product_id: 9, extended_data_hash: null }])
    const r1 = await syncProductAttributes(first as any, [empty])
    expect(r1.productsChanged).toBe(1)
    expect(r1.attributeRowsWritten).toBe(0)
    expect(first._batched.map(s => s.sql.split(' ')[0])).toEqual(['DELETE', 'UPDATE'])
    expect(first._batched[1].args).toEqual([EMPTY_ATTRIBUTES_HASH, 900])

    // Second run: the stamp from the first makes it a no-op, so sealed product stops costing writes.
    const second = makeFakeDB([
      { id: 900, tcgplayer_product_id: 9, extended_data_hash: EMPTY_ATTRIBUTES_HASH },
    ])
    const r2 = await syncProductAttributes(second as any, [empty])
    expect(r2.productsUnchanged).toBe(1)
    expect(second._batched).toHaveLength(0)
  })

  it('a malformed extendedData block persists nothing and never throws', async () => {
    const db = makeFakeDB([{ id: 700, tcgplayer_product_id: 7, extended_data_hash: null }])
    const broken = row({
      tcgplayer_product_id: 7,
      extended_data: 'not an array',
      attributes: undefined,
    })
    const res = await syncProductAttributes(db as any, [broken])
    expect(res.attributeRowsWritten).toBe(0)
    expect(db._batched.map(s => s.sql.split(' ')[0])).toEqual(['DELETE', 'UPDATE'])
    expect(db._batched[1].args).toEqual([EMPTY_ATTRIBUTES_HASH, 700])
  })

  it('counts — and skips — a product whose canonical row did not resolve', async () => {
    const db = makeFakeDB([]) // products read returns nothing
    const res = await syncProductAttributes(db as any, [attrRow({ tcgplayer_product_id: 1 })])
    expect(res.productsUnresolved).toBe(1)
    expect(res.productsChanged).toBe(0)
    expect(db._batched).toHaveLength(0)
  })

  it('never splits one product across two batches, and keeps batches at 100 statements', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => attrRow({ tcgplayer_product_id: i + 1 }))
    const db = makeFakeDB(
      rows.map((_, i) => ({ id: 1000 + i, tcgplayer_product_id: i + 1, extended_data_hash: null }))
    )
    await syncProductAttributes(db as any, rows)

    // 3 statements per product -> 33 products per 100-statement batch.
    expect(db._batchCalls.every(n => n <= 100)).toBe(true)
    expect(db._batched).toHaveLength(60 * 3)
    // Every batch boundary lands on a DELETE — i.e. no group was cut in half.
    let seen = 0
    for (const n of db._batchCalls) {
      expect(db._batched[seen].sql.startsWith('DELETE')).toBe(true)
      expect(db._batched[seen + n - 1].sql.startsWith('UPDATE')).toBe(true)
      seen += n
    }
  })

  it('chunks the products read at 90 ids (D1 caps bound params at 100)', async () => {
    const prepared: string[] = []
    const rows = Array.from({ length: 200 }, (_, i) => attrRow({ tcgplayer_product_id: i + 1 }))
    const base = makeFakeDB(
      rows.map((_, i) => ({
        id: 1000 + i, tcgplayer_product_id: i + 1, extended_data_hash: POKEMON_HASH,
      }))
    )
    const db = {
      ...base,
      prepare(sql: string) {
        if (sql.includes('FROM products')) prepared.push(sql)
        return base.prepare(sql)
      },
    }
    await syncProductAttributes(db as any, rows)

    expect(prepared).toHaveLength(3) // 90 + 90 + 20
    for (const sql of prepared) {
      expect((sql.match(/\?/g) ?? []).length).toBeLessThanOrEqual(90)
    }
  })

  it('is a no-op for an empty list', async () => {
    const db = makeFakeDB()
    const res = await syncProductAttributes(db as any, [])
    expect(res.productsChanged).toBe(0)
    expect(db._batched).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// COEXISTENCE — TCGCSV and an external filler share product_attributes (Session 3A)
//
// The hazard this locks down: `syncProductAttributes` rewrites a product's rows as one atomic
// delete-then-insert group, so an UNSCOPED delete would wipe another source's rows on every day
// the product's TCGCSV hash happened to change. These tests execute the statements both writers
// actually emit against a tiny row store that implements the two LIKE predicates and the
// PRIMARY KEY (product_id, name), and assert neither writer can touch the other's rows.
// ─────────────────────────────────────────────────────────────────────────────

/** Applies the recorded statements to a row set, honouring the PK and the two LIKE patterns. */
function applyStatements(store: { product_id: number; name: string; value: string }[],
                         stmts: { sql: string; args: unknown[] }[]) {
  for (const s of stmts) {
    if (s.sql.startsWith('DELETE')) {
      const productId = s.args[0] as number
      const keep = s.sql.includes('NOT LIKE')
        // TCGCSV: everything that is NOT namespaced
        ? (n: string) => n.startsWith('@')
        // external: everything that is NOT this source's prefix
        : (n: string) => !n.startsWith(String(s.args[1]).replace(/%$/, ''))
      for (let i = store.length - 1; i >= 0; i--) {
        if (store[i].product_id === productId && !keep(store[i].name)) store.splice(i, 1)
      }
    } else if (s.sql.startsWith('INSERT INTO product_attributes')) {
      for (let i = 0; i < s.args.length; i += 4) {
        const rowIn = { product_id: s.args[i] as number, name: s.args[i + 1] as string, value: s.args[i + 2] as string }
        if (store.some(r => r.product_id === rowIn.product_id && r.name === rowIn.name)) {
          throw new Error(`PRIMARY KEY conflict on (${rowIn.product_id}, ${rowIn.name})`)
        }
        store.push(rowIn)
      }
    }
  }
}

describe('product_attributes coexistence — TCGCSV rewrite vs an external filler', () => {
  const SCRYDEX_ROWS = [
    { product_id: 500, name: '@scrydex.mana_cost', value: '{2}{W}{U}' },
    { product_id: 500, name: '@scrydex.colors',    value: 'W;U' },
  ]

  it('a TCGCSV hash-change rewrite PRESERVES the external rows', async () => {
    const store = [
      { product_id: 500, name: 'Rarity',  value: 'Uncommon' },   // stale TCGCSV row
      { product_id: 500, name: 'SubType', value: 'Creature' },
      ...SCRYDEX_ROWS.map(r => ({ ...r })),
    ]
    const db = makeFakeDB([{ id: 500, tcgplayer_product_id: 1, extended_data_hash: 'stale:0' }])
    await syncProductAttributes(db as any, [attrRow({ tcgplayer_product_id: 1 })])
    applyStatements(store, db._batched)

    // The stale TCGCSV rows are gone and replaced by the new set…
    expect(store.filter(r => !r.name.startsWith('@')).map(r => r.name).sort())
      .toEqual(['Card Type', 'Rarity', 'Stage'])
    expect(store.find(r => r.name === 'Rarity')?.value).toBe('Common')
    // …while both Scrydex rows survived the rewrite untouched. This is the deciding assertion.
    expect(store.filter(r => r.name.startsWith('@'))).toEqual(SCRYDEX_ROWS)
  })

  it('the external filler never touches TCGCSV rows, and re-running either writer is idempotent', async () => {
    const store = [
      { product_id: 500, name: 'Rarity',  value: 'Common' },
      { product_id: 500, name: 'SubType', value: 'Creature' },
    ]
    const fill = () => externalAttributeStatements(
      makeFakeDB() as any, 500, 'scrydex',
      buildExternalAttributes('scrydex', { mana_cost: '{2}{W}{U}', colors: ['W', 'U'] }),
    ) as any as { sql: string; args: unknown[] }[]

    applyStatements(store, fill())
    expect(store.map(r => r.name).sort())
      .toEqual(['@scrydex.colors', '@scrydex.mana_cost', 'Rarity', 'SubType'])

    // A second fill re-runs cleanly: its delete clears its own rows first, so no PK conflict and
    // no duplicates — the property that makes a killed run safe to simply re-trigger.
    applyStatements(store, fill())
    expect(store).toHaveLength(4)

    // And a TCGCSV rewrite on top still leaves exactly one copy of each Scrydex row.
    const db = makeFakeDB([{ id: 500, tcgplayer_product_id: 1, extended_data_hash: 'stale:0' }])
    await syncProductAttributes(db as any, [attrRow({ tcgplayer_product_id: 1 })])
    applyStatements(store, db._batched)
    expect(store.filter(r => r.name.startsWith('@scrydex.')).map(r => r.name).sort())
      .toEqual(['@scrydex.colors', '@scrydex.mana_cost'])
  })

  it('a NEW TCGplayer key never strands — the scoped delete still owns every un-namespaced key', async () => {
    const store = [
      { product_id: 500, name: 'RetiredKey', value: 'x' },   // a key TCGCSV no longer sends
      ...SCRYDEX_ROWS.map(r => ({ ...r })),
    ]
    const db = makeFakeDB([{ id: 500, tcgplayer_product_id: 1, extended_data_hash: 'stale:0' }])
    await syncProductAttributes(db as any, [attrRow({ tcgplayer_product_id: 1 })])
    applyStatements(store, db._batched)

    expect(store.some(r => r.name === 'RetiredKey')).toBe(false)
    expect(store.filter(r => r.name.startsWith('@'))).toHaveLength(2)
  })
})
