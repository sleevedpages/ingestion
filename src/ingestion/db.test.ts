import { describe, it, expect } from 'vitest'
import { upsertProductSourceImages } from './db.js'

// Fake D1 that records every batched statement's SQL + binds.
function makeFakeDB() {
  const batched: { sql: string; args: unknown[] }[] = []
  const db = {
    prepare(sql: string) {
      const stmt = { sql, args: [] as unknown[], bind(...a: unknown[]) { stmt.args = a; return stmt } }
      return stmt
    },
    async batch(stmts: { sql: string; args: unknown[] }[]) {
      batched.push(...stmts)
      return stmts.map(() => ({}))
    },
    _batched: batched,
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
