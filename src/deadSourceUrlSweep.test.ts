import { describe, it, expect, vi, afterEach } from 'vitest'
import { sweepDeadSourceUrls } from './deadSourceUrlSweep.js'
import { PLACEHOLDER_IMAGE_HASHES, sha256Hex } from './lib/placeholderImages.js'

// ── fakes ─────────────────────────────────────────────────────────────────────

function makeDB(rows: any[], remaining = 0) {
  const db: any = {
    runCalls: [] as { sql: string; args: unknown[] }[],
    prepare(sql: string) {
      const stmt: any = {
        sql,
        args: [] as unknown[],
        bind(...a: unknown[]) { stmt.args = a; return stmt },
        async all() { return { results: rows } },
        async first() { return { n: remaining } },
        async run() { db.runCalls.push({ sql, args: stmt.args }); return { meta: {} } },
      }
      return stmt
    },
  }
  return db
}

function makeBucket() {
  const puts: { key: string }[] = []
  return {
    puts,
    async put(key: string) { puts.push({ key }) },
    async delete() {},
  } as any
}

function okResponse(bytes: Uint8Array) {
  return {
    ok: true, status: 200,
    headers: { get: () => 'image/png' },
    arrayBuffer: async () => bytes.buffer.slice(0),
  } as any
}
function notFoundResponse() {
  return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) } as any
}

const REAL_ART = new Uint8Array(4096).fill(9)
const CARD_BACK = new Uint8Array(4096).fill(7)
let addedHash: string | null = null

afterEach(() => {
  vi.unstubAllGlobals()
  if (addedHash) { PLACEHOLDER_IMAGE_HASHES.delete(addedHash); addedHash = null }
})

describe('sweepDeadSourceUrls', () => {
  it('leaves an alive (2xx, non-placeholder) source_url untouched', async () => {
    const rows = [{
      product_id: 1, tcgplayer_product_id: 100,
      source_url: 'https://tcgplayer-cdn.tcgplayer.com/product/100_in_1000x1000.jpg',
      card_number: '1', set_name: 'Base Set',
    }]
    const db = makeDB(rows, 0)
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(REAL_ART)))

    const res = await sweepDeadSourceUrls({ DB: db, IMAGES_BUCKET: makeBucket() }, { cursor: 0, limit: 100 })

    expect(res.scanned).toBe(1)
    expect(res.alive).toBe(1)
    expect(res.dead).toBe(0)
    expect(res.repaired).toBe(0)
    expect(db.runCalls).toHaveLength(0) // no bookkeeping write for a live row
  })

  it('marks a plain-dead (404) source_url via the EXISTING mirror_attempts bookkeeping — no new column', async () => {
    const rows = [{
      product_id: 2, tcgplayer_product_id: 200,
      source_url: 'https://tcgplayer-cdn.tcgplayer.com/product/200_in_1000x1000.jpg',
      card_number: '2', set_name: 'Base Set',
    }]
    const db = makeDB(rows, 0)
    vi.stubGlobal('fetch', vi.fn(async () => notFoundResponse()))

    const res = await sweepDeadSourceUrls({ DB: db, IMAGES_BUCKET: makeBucket() }, { cursor: 0, limit: 100 })

    expect(res.scanned).toBe(1)
    expect(res.dead).toBe(1)
    expect(res.alive).toBe(0)
    expect(res.repaired).toBe(0)

    const bookkeeping = db.runCalls.find((c: any) => c.sql.includes('mirror_attempts'))
    expect(bookkeeping).toBeTruthy()
    expect(bookkeeping.args[1]).toBe(200) // tcgplayer_product_id
    // never the placeholder repair path
    expect(db.runCalls.some((c: any) => c.sql.includes('mirrored_at = NULL'))).toBe(false)
  })

  it('marks a network-error source_url as dead too (never throws the batch)', async () => {
    const rows = [{
      product_id: 3, tcgplayer_product_id: 300,
      source_url: 'https://tcgplayer-cdn.tcgplayer.com/product/300_in_1000x1000.jpg',
      card_number: '3', set_name: 'Base Set',
    }]
    const db = makeDB(rows, 0)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))

    const res = await sweepDeadSourceUrls({ DB: db, IMAGES_BUCKET: makeBucket() }, { cursor: 0, limit: 100 })
    expect(res.dead).toBe(1)
  })

  it('a placeholder-hash match repairs via the SAME tcgplayerPlaceholderFallback path (no parallel implementation)', async () => {
    addedHash = await sha256Hex(CARD_BACK.buffer.slice(0) as ArrayBuffer)
    PLACEHOLDER_IMAGE_HASHES.add(addedHash)

    const rows = [{
      product_id: 4, tcgplayer_product_id: 400,
      source_url: 'https://images.scrydex.com/pokemon/base1-999999/large',
      card_number: '400', set_name: 'Celebrations: Classic Collection',
    }]
    const db = makeDB(rows, 0)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      // the sweep's own probe of the stored (Scrydex) source_url → card-back
      if (url.includes('images.scrydex.com')) return okResponse(CARD_BACK)
      // tcgplayerPlaceholderFallback's own attempt to fetch the TCGplayer CDN image
      // (from a worker datacenter IP this normally 403s/404s — treated as a miss)
      return notFoundResponse()
    }))

    const res = await sweepDeadSourceUrls({ DB: db, IMAGES_BUCKET: makeBucket() }, { cursor: 0, limit: 100 })

    expect(res.repaired).toBe(1)
    expect(res.dead).toBe(0)
    expect(res.alive).toBe(0)
    // the repair path stamped source_url at the reconstructed TCGplayer CDN url
    const repair = db.runCalls.find((c: any) => c.sql.includes('mirrored_at = NULL'))
    expect(repair).toBeTruthy()
    expect(repair.args).toEqual(['https://tcgplayer-cdn.tcgplayer.com/product/400_in_1000x1000.jpg', 400])
  })

  it('reports hasMore + remaining + cursorNext when the batch fills the limit (keyset pagination)', async () => {
    const rows = Array.from({ length: 2 }, (_, i) => ({
      product_id: i + 1, tcgplayer_product_id: 1000 + i,
      source_url: `https://tcgplayer-cdn.tcgplayer.com/product/${1000 + i}_in_1000x1000.jpg`,
      card_number: String(i), set_name: 'Set',
    }))
    const db = makeDB(rows, 7)
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(REAL_ART)))

    const res = await sweepDeadSourceUrls({ DB: db, IMAGES_BUCKET: makeBucket() }, { cursor: 0, limit: 2 })
    expect(res.scanned).toBe(2)
    expect(res.hasMore).toBe(true)
    expect(res.remaining).toBe(7)
    expect(res.cursorNext).toBe(2)
  })

  it('an empty batch reports hasMore:false and preserves the cursor', async () => {
    const db = makeDB([], 0)
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(REAL_ART)))
    const res = await sweepDeadSourceUrls({ DB: db, IMAGES_BUCKET: makeBucket() }, { cursor: 42, limit: 50 })
    expect(res.scanned).toBe(0)
    expect(res.hasMore).toBe(false)
    expect(res.cursorNext).toBe(42)
  })
})
