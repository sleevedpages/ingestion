import { describe, it, expect, afterEach } from 'vitest'
import { purgePlaceholderMirrors, r2KeyFromUrl } from './purgePlaceholderMirrors.js'
import { PLACEHOLDER_IMAGE_HASHES, sha256Hex } from './lib/placeholderImages.js'

// ── fakes ─────────────────────────────────────────────────────────────────────

function makeDB(rows: any[], remaining = 0) {
  const db: any = {
    batchCalls: [] as { sql: string; args: unknown[] }[][],
    prepare(sql: string) {
      const stmt: any = {
        sql,
        args: [] as unknown[],
        bind(...a: unknown[]) { stmt.args = a; return stmt },
        async all() { return { results: rows } },
        async first() { return { n: remaining } },
      }
      return stmt
    },
    async batch(stmts: any[]) {
      db.batchCalls.push(stmts.map((s) => ({ sql: s.sql, args: s.args })))
      return stmts.map(() => ({}))
    },
  }
  return db
}

function makeBucket(objects: Record<string, Uint8Array>) {
  const deletes: string[] = []
  return {
    deletes,
    async get(key: string) {
      const bytes = objects[key]
      if (!bytes) return null
      return { arrayBuffer: async () => bytes.buffer.slice(0) }
    },
    async delete(key: string) { deletes.push(key) },
  } as any
}

const CARD_BACK = new Uint8Array(4096).fill(7)   // stand-in placeholder bytes
const REAL_ART = new Uint8Array(4096).fill(9)    // a genuine image
let addedHash: string | null = null

afterEach(() => {
  if (addedHash) { PLACEHOLDER_IMAGE_HASHES.delete(addedHash); addedHash = null }
})

describe('r2KeyFromUrl', () => {
  it('extracts the object key from a public r2 url', () => {
    expect(r2KeyFromUrl('https://images.sleevedpages.com/cards/250321.png')).toBe('cards/250321.png')
  })
  it('returns null for junk', () => {
    expect(r2KeyFromUrl('not a url')).toBeNull()
  })
})

describe('purgePlaceholderMirrors', () => {
  it('purges a card-back R2 object, repairs the row to TCGplayer, leaves a real image alone', async () => {
    // Register the stand-in card-back bytes as a known placeholder for this test.
    addedHash = await sha256Hex(CARD_BACK.buffer.slice(0) as ArrayBuffer)
    PLACEHOLDER_IMAGE_HASHES.add(addedHash)

    const rows = [
      { product_id: 10, tcgplayer_product_id: 250321, r2_url: 'https://images.sleevedpages.com/cards/250321.png' },
      { product_id: 11, tcgplayer_product_id: 999,    r2_url: 'https://images.sleevedpages.com/cards/999.png' },
    ]
    const db = makeDB(rows, 0)
    const bucket = makeBucket({
      'cards/250321.png': CARD_BACK, // placeholder → purge
      'cards/999.png':    REAL_ART,  // real → keep
    })

    const res = await purgePlaceholderMirrors({ DB: db, IMAGES_BUCKET: bucket }, { cursor: 0, limit: 100 })

    expect(res.scanned).toBe(2)
    expect(res.purged).toBe(1)
    expect(res.repaired).toBe(1)
    expect(res.hasMore).toBe(false)       // batch under the limit
    expect(res.cursorNext).toBe(11)       // last product_id scanned

    // only the card-back object was deleted
    expect(bucket.deletes).toEqual(['cards/250321.png'])

    // exactly one repair statement, pointing the placeholder row at the TCGplayer url
    const repairs = db.batchCalls.flat().filter((s: any) => s.sql.includes('mirrored_at = NULL'))
    expect(repairs).toHaveLength(1)
    expect(repairs[0].args).toEqual([
      'https://tcgplayer-cdn.tcgplayer.com/product/250321_in_1000x1000.jpg',
      250321,
    ])
  })

  it('reports hasMore when the batch fills the limit', async () => {
    const rows = Array.from({ length: 2 }, (_, i) => ({
      product_id: i + 1, tcgplayer_product_id: 1000 + i,
      r2_url: `https://images.sleevedpages.com/cards/${1000 + i}.png`,
    }))
    const db = makeDB(rows, 5)
    const bucket = makeBucket({}) // all gets return null (dangling) → nothing purged
    const res = await purgePlaceholderMirrors({ DB: db, IMAGES_BUCKET: bucket }, { cursor: 0, limit: 2 })
    expect(res.scanned).toBe(2)
    expect(res.purged).toBe(0)
    expect(res.hasMore).toBe(true)
    expect(res.remaining).toBe(5)
    expect(res.cursorNext).toBe(2)
  })
})
