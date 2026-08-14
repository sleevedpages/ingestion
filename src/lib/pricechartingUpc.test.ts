import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  lookupPriceChartingUpc,
  upcQueryForms,
  PC_UPC_PREFIX,
  PC_UPC_TTL,
  PC_UPC_NEGATIVE_TTL,
} from './pricechartingUpc.js'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

// ── Pure form derivation ─────────────────────────────────────────────────────
describe('upcQueryForms', () => {
  it('a 13-digit code with a leading zero also queries its 12-digit UPC-A form', () => {
    expect(upcQueryForms('0196214132474')).toEqual(['0196214132474', '196214132474'])
  })
  it('a 12-digit UPC-A also queries its 0-prefixed EAN-13 form', () => {
    expect(upcQueryForms('196214132474')).toEqual(['196214132474', '0196214132474'])
  })
  it('a 13-digit code NOT starting with 0 has no UPC-A twin', () => {
    expect(upcQueryForms('4902370542191')).toEqual(['4902370542191'])
  })
  it('an EAN-8 queries as-is', () => {
    expect(upcQueryForms('12345670')).toEqual(['12345670'])
  })
})

// ── In-memory fakes ──────────────────────────────────────────────────────────
function makeKV() {
  const store = new Map<string, { value: string; ttl?: number }>()
  return {
    _store: store,
    async get(k: string) { return store.has(k) ? store.get(k)!.value : null },
    async put(k: string, v: string, opts?: { expirationTtl?: number }) {
      store.set(k, { value: v, ttl: opts?.expirationTtl })
    },
  }
}

interface DbState {
  stampedByPcId?: Record<string, number | null>
  productByTcgId?: Record<string, { id: number; name: string | null; categoryId: number | null }>
}
function makeDb(state: DbState = {}) {
  const writes: Array<{ sql: string; args: any[] }> = []
  return {
    _writes: writes,
    prepare(sql: string) {
      return {
        bind(...args: any[]) {
          return {
            async first() {
              if (sql.includes('FROM pricecharting_products')) {
                const pcId = String(args[0])
                if (state.stampedByPcId && pcId in state.stampedByPcId) {
                  return { productId: state.stampedByPcId[pcId] }
                }
                return null
              }
              if (sql.includes('p.tcgplayer_product_id')) {
                return state.productByTcgId?.[String(args[0])] ?? null
              }
              return null
            },
            async run() { writes.push({ sql, args }); return {} },
          }
        },
      }
    },
  }
}

const PRODUCT_RESPONSE = {
  status: 'success',
  id: 11748902,
  'product-name': 'Elite Trainer Box',
  'console-name': 'Pokemon Ascended Heroes',
  genre: 'Sealed Product',
  'tcg-id': '99001',
  'sales-volume': '12',
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

const baseEnv = (over: any = {}) => ({
  PRICECHARTING_TOKEN: 'tok',
  DB: makeDb(),
  SLEEVEDPAGES_KV: makeKV(),
  ...over,
})

const noSleep = { sleepFn: vi.fn(async () => {}) }

// ── Lookup flow ──────────────────────────────────────────────────────────────
describe('lookupPriceChartingUpc', () => {
  it('throws when the token is missing (caller maps to 503)', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    await expect(lookupPriceChartingUpc({} as any, '196214132474')).rejects.toThrow('PRICECHARTING_TOKEN')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('serves a cached POSITIVE with no API call', async () => {
    const kv = makeKV()
    kv._store.set(`${PC_UPC_PREFIX}196214132474`, {
      value: JSON.stringify({ found: true, pcId: '1', canonicalProductId: 7, productName: 'X', consoleName: 'Y' }),
    })
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const res = await lookupPriceChartingUpc(baseEnv({ SLEEVEDPAGES_KV: kv }) as any, '196214132474', noSleep)
    expect(res).toMatchObject({ found: true, canonicalProductId: 7, cached: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('serves a cached NEGATIVE with no API call (repeated unknown scans never hammer the API)', async () => {
    const kv = makeKV()
    kv._store.set(`${PC_UPC_PREFIX}196214132474`, { value: JSON.stringify({ found: false }) })
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const res = await lookupPriceChartingUpc(baseEnv({ SLEEVEDPAGES_KV: kv }) as any, '196214132474', noSleep)
    expect(res).toMatchObject({ found: false, cached: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rung 1: an already-stamped pc_id reuses the stored canonical id and stamps the UPC onto the row', async () => {
    const db = makeDb({ stampedByPcId: { '11748902': 42 } })
    const kv = makeKV()
    const fetchMock = vi.fn(async () => jsonResponse(PRODUCT_RESPONSE))
    vi.stubGlobal('fetch', fetchMock)
    const res = await lookupPriceChartingUpc(baseEnv({ DB: db, SLEEVEDPAGES_KV: kv }) as any, '196214132474', noSleep)
    expect(res).toEqual({
      found: true, pcId: '11748902', canonicalProductId: 42,
      productName: 'Elite Trainer Box', consoleName: 'Pokemon Ascended Heroes',
    })
    // The UPDATE wrote the upc so the NEXT scan is a Content-side D1 hit.
    const upd = db._writes.find((w) => w.sql.includes('UPDATE pricecharting_products'))
    expect(upd?.args).toEqual(['196214132474', '11748902'])
    // Positive cached at the long TTL.
    const cached = kv._store.get(`${PC_UPC_PREFIX}196214132474`)
    expect(cached?.ttl).toBe(PC_UPC_TTL)
    expect(JSON.parse(cached!.value)).toMatchObject({ found: true, canonicalProductId: 42 })
  })

  it('rung 2: an unstamped product resolves via validated tcg-id and persists the mapping', async () => {
    const db = makeDb({
      productByTcgId: { '99001': { id: 77, name: 'Elite Trainer Box', categoryId: 3 } },
    })
    const kv = makeKV()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(PRODUCT_RESPONSE)))
    const res = await lookupPriceChartingUpc(baseEnv({ DB: db, SLEEVEDPAGES_KV: kv }) as any, '196214132474', noSleep)
    expect(res).toMatchObject({ found: true, pcId: '11748902', canonicalProductId: 77 })
    const ins = db._writes.find((w) => w.sql.includes('INSERT INTO pricecharting_products'))
    expect(ins).toBeTruthy()
    // pc_id, game_category (derived from the canonical game), canonical id, tcg-id,
    // console/product names, sealed flag, sales volume, upc.
    expect(ins!.args).toEqual([
      '11748902', 'pokemon-cards', 77, '99001',
      'Pokemon Ascended Heroes', 'Elite Trainer Box', 1, 12, '196214132474',
    ])
  })

  it('NEVER trusts an unvalidated tcg-id — a name mismatch is a negative-cached miss', async () => {
    const db = makeDb({
      productByTcgId: { '99001': { id: 77, name: 'Completely Different Product', categoryId: 3 } },
    })
    const kv = makeKV()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(PRODUCT_RESPONSE)))
    const res = await lookupPriceChartingUpc(baseEnv({ DB: db, SLEEVEDPAGES_KV: kv }) as any, '196214132474', noSleep)
    expect(res).toEqual({ found: false })
    expect(db._writes.find((w) => w.sql.includes('INSERT'))).toBeUndefined()
    const cached = kv._store.get(`${PC_UPC_PREFIX}196214132474`)
    expect(cached?.ttl).toBe(PC_UPC_NEGATIVE_TTL)   // negatives expire sooner
    expect(JSON.parse(cached!.value)).toEqual({ found: false })
  })

  it('a match OUTSIDE the 4 ingested categories is returned but not persisted (game_category is NOT NULL)', async () => {
    const db = makeDb({
      productByTcgId: { '99001': { id: 88, name: 'Elite Trainer Box', categoryId: 71 } },  // Lorcana-shaped
    })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(PRODUCT_RESPONSE)))
    const res = await lookupPriceChartingUpc(baseEnv({ DB: db }) as any, '196214132474', noSleep)
    expect(res).toMatchObject({ found: true, canonicalProductId: 88 })
    expect(db._writes.find((w) => w.sql.includes('INSERT'))).toBeUndefined()
  })

  it('tries the sibling barcode form after a definitive miss, 1 req/sec apart', async () => {
    const sleepFn = vi.fn(async () => {})
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const upc = new URL(String(url)).searchParams.get('upc')!
      calls.push(upc)
      if (upc === '0196214132474') return jsonResponse({ status: 'error' })   // EAN-13 form unknown
      return jsonResponse(PRODUCT_RESPONSE)                                    // UPC-A form hits
    }))
    const db = makeDb({ stampedByPcId: { '11748902': 42 } })
    const res = await lookupPriceChartingUpc(baseEnv({ DB: db }) as any, '0196214132474', { sleepFn })
    expect(res.found).toBe(true)
    expect(calls).toEqual(['0196214132474', '196214132474'])
    expect(sleepFn).toHaveBeenCalledTimes(1)
    expect(sleepFn).toHaveBeenCalledWith(1100)
  })

  it('a definitive miss on BOTH forms negative-caches; a TRANSIENT failure does not cache at all', async () => {
    // Definitive: status:'error' bodies.
    const kv = makeKV()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 'error' })))
    let res = await lookupPriceChartingUpc(baseEnv({ SLEEVEDPAGES_KV: kv }) as any, '196214132474', noSleep)
    expect(res).toEqual({ found: false })
    expect(kv._store.get(`${PC_UPC_PREFIX}196214132474`)?.ttl).toBe(PC_UPC_NEGATIVE_TTL)

    // Transient: HTTP 500 — must NOT suppress retries for 6h.
    const kv2 = makeKV()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 'error' }, 500)))
    res = await lookupPriceChartingUpc(baseEnv({ SLEEVEDPAGES_KV: kv2 }) as any, '196214132474', noSleep)
    expect(res).toEqual({ found: false })
    expect(kv2._store.size).toBe(0)
  })

  it('never returns or persists the token', async () => {
    const kv = makeKV()
    const db = makeDb({ stampedByPcId: { '11748902': 42 } })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(PRODUCT_RESPONSE)))
    const res = await lookupPriceChartingUpc(baseEnv({ DB: db, SLEEVEDPAGES_KV: kv }) as any, '196214132474', noSleep)
    expect(JSON.stringify(res)).not.toContain('tok')
    for (const { value } of kv._store.values()) expect(value).not.toContain('tok')
    for (const w of db._writes) expect(JSON.stringify(w.args)).not.toContain('tok')
  })
})
