// The ON-VIEW PriceCharting refresh (session 16, 2026-10-07) — the worker half. Pins:
//   1. the PURE mapper against the API shape pinned in Phase 0 (PriceCharting's API documentation,
//      read 2026-10-07): integer PENNIES → dollars; loose → the ungraded row + retail buy/sell; every
//      graded bucket incl. condition-19…22 (CGC Pristine / BGS Black Label as `is_perfect` + company,
//      TAG 10 / ACE 10 as company rows) and condition-9…16 (Grade 1…6); a zero / blank / non-integer
//      field writes nothing; sealed → loose only; the SAME rows the CSV writer decodes;
//   2. the pacer: never two calls within the interval ACROSS invocations (KV slot), the 1,100 ms floor,
//      the bounded queue, the daily cap − reserve, a 429 arms a cooldown and is never retried;
//   3. the route's gate order (401 → 503 → 409 → 400 → the work);
//   4. the 7 d freshness, the 24 h force floor, the 24 h negative cache for a miss;
//   5. resolution: the map first (the twin owner), else ONE validated, language-scoped search; a
//      weak or foreign match is a miss; a search hit is persisted `api-search`; a hit whose tcg-id
//      names another product is a miss; a pc id stamped on another product is never taken;
//   6. the write: the product's PriceCharting GRADED rows are replaced as one batch (a vanished
//      bucket is removed), the loose row upserted, the freshness marked; capacity → ok:false.
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  pcProductToPriceRows, reservePcSlot, pacedPcGet, enrichPcCard, pickMapOwner, expectedConsoleLanguage,
  gameCategoryFor, pcOnViewLimits, onViewCounterKey, PcCapacityError, NEXT_SLOT_KEY, COOLDOWN_KEY,
  PC_ONVIEW_CLASS, PC_ONVIEW_MISS_CLASS, PC_API_SEARCH_METHOD,
} from './lib/pricechartingOnView.js'
import { csvRowToPriceRows } from './lib/pricechartingCsv.js'
import worker from './worker.js'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

// ── The Phase-0 pinned product shape (pennies; field names from the API documentation) ─────────
const DOC_PRODUCT = {
  status: 'success', id: '630417', 'product-name': 'Charizard #4', 'console-name': 'Pokemon Base Set',
  'loose-price': 41250, 'cib-price': 98000, 'new-price': 125000, 'graded-price': 199900,
  'box-only-price': 450000, 'manual-only-price': 1850000, 'bgs-10-price': 2600000,
  'condition-17-price': 1500000, 'condition-18-price': 900000,
  'condition-19-price': 3200000, 'condition-20-price': 9900000, 'condition-21-price': 1100000, 'condition-22-price': 700000,
  'condition-9-price': 20000, 'condition-10-price': 25000, 'condition-13-price': 30000, 'condition-14-price': 36000,
  'condition-15-price': 42000, 'condition-16-price': 55000,
  'retail-loose-buy': 30000, 'retail-loose-sell': 45000, 'retail-cib-buy': 1, 'retail-new-sell': 2,
  'gamestop-price': 0, 'sales-volume': '512', 'tcg-id': '42382', epid: '123', genre: 'Pokemon Card',
  'release-date': '1999-01-09', upc: '',
}

describe('pcProductToPriceRows (PURE)', () => {
  const rows = pcProductToPriceRows(DOC_PRODUCT, 27710)
  const by = (grade: string | null, company?: string) => rows.find(r => r.grade === grade && (company === undefined || r.company === company))

  it('pennies → dollars; loose is the ungraded row with the retail buy/sell spread', () => {
    expect(by(null)).toEqual({ productId: 27710, grade: null, valueDollars: 412.5, retailBuyDollars: 300, retailSellDollars: 450 })
  })
  it('the CSV-shared buckets keep their labels (value-only, no company)', () => {
    expect(by('PSA 10')?.valueDollars).toBe(18500)
    expect(by('BGS 10', undefined)).toBeDefined()
    expect(by('Grade 9.5')?.valueDollars).toBe(4500)
    expect(by('Grade 9')?.valueDollars).toBe(1999)
    expect(by('Grade 8 / 8.5')?.valueDollars).toBe(1250)
    expect(by('Grade 7 / 7.5')?.valueDollars).toBe(980)
    expect(by('CGC 10')?.valueDollars).toBe(15000)
    expect(by('SGC 10')?.valueDollars).toBe(9000)
  })
  it('condition-19…22: CGC Pristine + BGS Black Label as is_perfect company rows; TAG 10 / ACE 10 as company rows', () => {
    // Content's gradeTiers.js PERFECT_TIER_LABEL relabels a perfect row: CGC → 'Pristine 10', BGS → 'Black Label 10'
    // (pinned on that side by the valuation test). Here: the STANDARD-10 grade string + company + is_perfect.
    expect(rows.filter(r => r.isPerfect)).toEqual([
      { productId: 27710, grade: 'CGC 10', valueDollars: 32000, company: 'CGC', isPerfect: true },
      { productId: 27710, grade: 'BGS 10', valueDollars: 99000, company: 'BGS', isPerfect: true },
    ])
    expect(by('TAG 10', 'TAG')).toEqual({ productId: 27710, grade: 'TAG 10', valueDollars: 11000, company: 'TAG', isPerfect: false })
    expect(by('ACE 10', 'ACE')).toEqual({ productId: 27710, grade: 'ACE 10', valueDollars: 7000, company: 'ACE', isPerfect: false })
  })
  it('condition-9/10/13/14/15/16 → Grade 1 … Grade 6 (company-agnostic)', () => {
    expect(['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6'].map(g => by(g)?.valueDollars)).toEqual([200, 250, 300, 360, 420, 550])
  })
  it('every bucket present → 1 loose + 18 graded rows; non-price fields and other retail pairs are ignored', () => {
    expect(rows).toHaveLength(19)
    expect(rows.filter(r => r.grade != null).every(r => r.retailBuyDollars === undefined)).toBe(true)
  })
  it('zero / blank / non-integer / negative fields write nothing — unpriced is never $0', () => {
    const r = pcProductToPriceRows({ 'loose-price': 0, 'manual-only-price': '', 'graded-price': 12.5, 'bgs-10-price': -5, 'cib-price': '700' }, 1)
    expect(r).toEqual([{ productId: 1, grade: 'Grade 7 / 7.5', valueDollars: 7 }])
  })
  it('sealed (our product_kind OR PriceCharting genre) → the loose row only', () => {
    expect(pcProductToPriceRows(DOC_PRODUCT, 1, { isSealed: true }).map(r => r.grade)).toEqual([null])
    expect(pcProductToPriceRows({ ...DOC_PRODUCT, genre: 'Sealed Product' }, 1).map(r => r.grade)).toEqual([null])
  })
  it('decodes EXACTLY what the CSV writer decodes for the same values (one decoder)', () => {
    const csvRow: Record<string, string> = {}
    for (const [k, v] of Object.entries(DOC_PRODUCT)) if (typeof v === 'number' && v > 0) csvRow[k] = `$${(v / 100).toFixed(2)}`
    expect(pcProductToPriceRows(DOC_PRODUCT, 27710).map(({ productId, ...r }) => r)).toEqual(csvRowToPriceRows(csvRow))
  })
})

// ── Fakes ────────────────────────────────────────────────────────────────────────────────────────

function fakeKV(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return { store, get: vi.fn(async (k: string) => store.get(k) ?? null), put: vi.fn(async (k: string, v: string) => { store.set(k, v) }) }
}

interface PriceRow { product_id: number; grade: string | null; company: string | null; is_perfect: number; is_graded: number; value: number; finish: string | null; retail_buy: number | null }
interface MapRow { pc_id: string; canonical_product_id: number | null; product_name: string | null; console_name: string | null; match_method: string | null; game_category: string; sales_volume: number | null }

function fakeDb(seed: {
  config?: Record<string, string>
  products?: Array<{ id: number; name: string; number: string | null; set_name: string; tcgplayer_product_id: number | null; category_id: number; product_kind?: string }>
  map?: MapRow[]
  prices?: PriceRow[]
  freshness?: Array<{ product_id: number; data_class: string; enriched_at: number }>
} = {}) {
  const config = new Map(Object.entries(seed.config ?? {}))
  const products = seed.products ?? []
  const map: MapRow[] = [...(seed.map ?? [])]
  const prices: PriceRow[] = [...(seed.prices ?? [])]
  const fresh = new Map<string, number>((seed.freshness ?? []).map(f => [`${f.product_id}|${f.data_class}`, f.enriched_at]))
  const batches: string[][] = []
  const exec = (q: string, a: any[]) => {
    if (q.includes('DELETE FROM prices')) {
      for (let i = prices.length - 1; i >= 0; i--) if (prices[i].product_id === a[0] && prices[i].is_graded === 1) prices.splice(i, 1)
    } else if (q.includes('INSERT INTO prices')) {
      const [pid, , finish, grade, company, isPerfect, isGraded, value, rb] = a
      const i = prices.findIndex(p => p.product_id === pid && p.grade === grade && (p.company ?? null) === company && p.is_perfect === isPerfect && p.finish === finish)
      const row = { product_id: pid, grade, company, is_perfect: isPerfect, is_graded: isGraded, value, finish, retail_buy: rb }
      if (i >= 0) prices[i] = row; else prices.push(row)
    } else if (q.includes('INSERT INTO pricecharting_products')) {
      const [pc_id, game_category, cpid, , console_name, product_name, , sales_volume] = a
      const ex = map.find(m => m.pc_id === pc_id)
      if (ex) { ex.canonical_product_id ??= cpid; ex.sales_volume = sales_volume ?? ex.sales_volume }
      else map.push({ pc_id, game_category, canonical_product_id: cpid, match_method: 'api-search', console_name, product_name, sales_volume })
    } else if (q.includes('UPDATE pricecharting_products')) {
      const m = map.find(x => x.pc_id === a[1]); if (m && a[0] != null) m.sales_volume = a[0]
    } else if (q.includes('INSERT INTO card_enrichment_freshness')) {
      fresh.set(`${a[0]}|${a[1]}`, a[2])
    } else if (q.includes('DELETE FROM card_enrichment_freshness')) {
      fresh.delete(`${a[0]}|${a[1]}`)
    } else throw new Error('unhandled write: ' + q.slice(0, 60))
  }
  const stmt = (q: string) => {
    let args: any[] = []
    const s: any = {
      q, bind: (...a: any[]) => { args = a; s.args = a; return s },
      first: async () => {
        if (q.includes('FROM app_config')) return config.has(args[0]) ? { value: config.get(args[0]) } : null
        if (q.includes('FROM   products p')) return products.find(p => p.id === args[0]) ?? null
        if (q.includes('SELECT canonical_product_id FROM pricecharting_products')) {
          const m = map.find(x => x.pc_id === args[0]); return m ? { canonical_product_id: m.canonical_product_id } : null
        }
        throw new Error('unhandled first: ' + q.slice(0, 60))
      },
      all: async () => {
        if (q.includes('FROM card_enrichment_freshness')) {
          return { results: [args[1], args[2]].filter(c => fresh.has(`${args[0]}|${c}`)).map(c => ({ data_class: c, enriched_at: fresh.get(`${args[0]}|${c}`) })) }
        }
        if (q.includes('FROM pricecharting_products WHERE canonical_product_id')) return { results: map.filter(m => m.canonical_product_id === args[0]) }
        throw new Error('unhandled all: ' + q.slice(0, 60))
      },
      run: async () => exec(q, args),
    }
    return s
  }
  return {
    map, prices, fresh, batches,
    prepare: (q: string) => stmt(q),
    batch: async (stmts: any[]) => { batches.push(stmts.map(s => s.q)); for (const s of stmts) exec(s.q, s.args) },
  }
}

const CHARIZARD = { id: 27710, name: 'Charizard', number: '004/102', set_name: 'Base Set', tcgplayer_product_id: 42382, category_id: 3 }
const LORCANA = { id: 501, name: 'Elsa - Spirit of Winter', number: '42', set_name: 'The First Chapter', tcgplayer_product_id: 500100, category_id: 71 }
const JAPAN = { id: 777, name: 'Blastoise EX - 021/087', number: '021/087', set_name: 'Pokemon Card 151', tcgplayer_product_id: 800800, category_id: 85 }
const NOW = 1_760_000_000
const noWait = { sleep: async () => {}, now: () => NOW * 1000 }

type Route = (u: URL) => { status?: number; body: unknown }
function stubPc(route: Route) {
  const calls: URL[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const u = new URL(input); calls.push(u)
    const r = route(u)
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 })
  }))
  return calls
}
const envOf = (db: any, kv = fakeKV(), extra: Record<string, string> = {}) =>
  ({ DB: db, SLEEVEDPAGES_KV: kv, PRICECHARTING_TOKEN: 'tok', ...extra }) as any

// ── 2. The pacer ─────────────────────────────────────────────────────────────────────────────────

describe('the pacer — one serialized caller', () => {
  it('two calls in DIFFERENT invocations are never closer than the interval (the KV slot)', async () => {
    const kv = fakeKV()
    const sleep = vi.fn(async () => {})
    const t = 5_000_000
    await reservePcSlot(envOf(null, kv), { now: () => t, sleep })              // invocation A at t
    expect(kv.store.get(NEXT_SLOT_KEY)).toBe(String(t))
    await reservePcSlot(envOf(null, kv), { now: () => t + 200, sleep })        // invocation B 200 ms later
    expect(sleep).toHaveBeenLastCalledWith(900)                               // waits until t + 1,100
    expect(kv.store.get(NEXT_SLOT_KEY)).toBe(String(t + 1100))
    await reservePcSlot(envOf(null, kv), { now: () => t + 300, sleep })        // C queues behind B
    expect(sleep).toHaveBeenLastCalledWith(1900)
  })
  it('the interval never goes below 1,100 ms whatever the var says', () => {
    expect(pcOnViewLimits({ PC_ONVIEW_MIN_INTERVAL_MS: '200' }).minIntervalMs).toBe(1100)
    expect(pcOnViewLimits({ PC_ONVIEW_MIN_INTERVAL_MS: '1500' }).minIntervalMs).toBe(1500)
    expect(pcOnViewLimits({})).toEqual({ dailyCap: 2000, reserve: 100, minIntervalMs: 1100, maxQueue: 12 })
  })
  it('a full queue is refused (dropped, never waited on without bound)', async () => {
    const t = 9_000_000
    const kv = fakeKV({ [NEXT_SLOT_KEY]: String(t + 3 * 1100) })
    await expect(reservePcSlot(envOf(null, kv, { PC_ONVIEW_MAX_QUEUE: '3' }), { now: () => t, sleep: async () => {} }))
      .rejects.toMatchObject({ why: 'queue_full' })
    await expect(reservePcSlot(envOf(null, kv, { PC_ONVIEW_MAX_QUEUE: '4' }), { now: () => t, sleep: async () => {} })).resolves.toBe(4400)
  })
  it('the daily counter refuses at cap − reserve and counts every call', async () => {
    const day = onViewCounterKey(new Date(NOW * 1000))
    const kv = fakeKV({ [day]: '1899' })
    await reservePcSlot(envOf(null, kv), noWait)
    expect(kv.store.get(day)).toBe('1900')
    await expect(reservePcSlot(envOf(null, kv), noWait)).rejects.toMatchObject({ why: 'daily_cap' })
  })
  it('no KV → capacity (no ledger, no call); a 429 arms the cooldown and is never retried', async () => {
    await expect(reservePcSlot({ PRICECHARTING_TOKEN: 't' } as any, noWait)).rejects.toBeInstanceOf(PcCapacityError)
    const calls = stubPc(() => ({ status: 429, body: {} }))
    const kv = fakeKV()
    await expect(pacedPcGet(envOf(null, kv), '/api/product', { id: '1' }, noWait)).rejects.toMatchObject({ why: 'cooldown' })
    expect(kv.store.get(COOLDOWN_KEY)).toBe('1')
    await expect(pacedPcGet(envOf(null, kv), '/api/product', { id: '1' }, noWait)).rejects.toMatchObject({ why: 'cooldown' })
    expect(calls).toHaveLength(1)
  })
})

// ── 4–6. The enrich ──────────────────────────────────────────────────────────────────────────────

describe('enrichPcCard', () => {
  const mapped = (extra: Partial<MapRow> = {}): MapRow => ({ pc_id: '630417', canonical_product_id: 27710, product_name: 'Charizard #4', console_name: 'Pokemon Base Set', match_method: 'tcg-id', game_category: 'pokemon-cards', sales_volume: null, ...extra })

  it('a mapped product: ONE product call, every bucket written, a vanished bucket removed, fresh 7 d', async () => {
    const db = fakeDb({
      products: [CHARIZARD], map: [mapped()],
      prices: [{ product_id: 27710, grade: 'Grade 6', company: null, is_perfect: 0, is_graded: 1, value: 1, finish: null, retail_buy: null },
               { product_id: 27710, grade: null, company: null, is_perfect: 0, is_graded: 0, value: 400, finish: 'normal', retail_buy: null }],
    })
    const calls = stubPc(() => ({ body: { ...DOC_PRODUCT, 'condition-16-price': 0 } }))
    const r = await enrichPcCard(envOf(db), 27710, { nowSec: NOW, ...noWait })
    expect(r).toMatchObject({ ok: true, refreshed: true, written: 18, pcId: '630417', fetchedAt: NOW, method: 'map' })
    expect(calls.map(c => c.pathname)).toEqual(['/api/product'])
    expect(calls[0].searchParams.get('id')).toBe('630417')
    expect(db.prices.find(p => p.grade === 'Grade 6')).toBeUndefined()            // gone from PriceCharting → removed
    expect(db.prices.find(p => p.grade == null)).toMatchObject({ value: 412.5, finish: 'normal', is_graded: 0, retail_buy: 300 })
    expect(db.prices.filter(p => p.is_perfect === 1).map(p => `${p.company}:${p.grade}`)).toEqual(['CGC:CGC 10', 'BGS:BGS 10'])
    expect(db.prices.every(p => (p.grade == null) === (p.is_graded === 0))).toBe(true)  // is_graded from the bucket
    expect(db.fresh.get(`27710|${PC_ONVIEW_CLASS}`)).toBe(NOW)
    expect(db.batches).toHaveLength(1)                                              // ONE atomic batch
    expect(db.batches[0][0]).toContain('DELETE FROM prices')
    expect(db.map[0].sales_volume).toBe(512)
  })

  it('7 d freshness; force honours a 24 h floor; force after the floor refreshes', async () => {
    const calls = stubPc(() => ({ body: DOC_PRODUCT }))
    const at = (age: number) => fakeDb({ products: [CHARIZARD], map: [mapped()], freshness: [{ product_id: 27710, data_class: PC_ONVIEW_CLASS, enriched_at: NOW - age }] })
    expect(await enrichPcCard(envOf(at(3 * 86400)), 27710, { nowSec: NOW, ...noWait })).toMatchObject({ refreshed: false, reason: 'fresh', fetchedAt: NOW - 3 * 86400, pcId: '630417' })
    expect(await enrichPcCard(envOf(at(3600)), 27710, { nowSec: NOW, force: true, ...noWait })).toMatchObject({ refreshed: false, reason: 'floor', fetchedAt: NOW - 3600 })
    expect(calls).toHaveLength(0)
    expect(await enrichPcCard(envOf(at(25 * 3600)), 27710, { nowSec: NOW, force: true, ...noWait })).toMatchObject({ refreshed: true })
    expect(await enrichPcCard(envOf(at(8 * 86400)), 27710, { nowSec: NOW, ...noWait })).toMatchObject({ refreshed: true })
    expect(calls).toHaveLength(2)
  })

  it('no map row → ONE validated search (language-scoped), persisted `api-search`, then the product', async () => {
    const db = fakeDb({ products: [LORCANA] })
    const calls = stubPc(u => u.pathname === '/api/products'
      ? { body: { status: 'success', products: [
          { id: '9001', 'product-name': 'Elsa Spirit of Winter #42', 'console-name': 'Lorcana Japanese The First Chapter' },
          { id: '9002', 'product-name': 'Elsa Spirit of Winter #42', 'console-name': 'Lorcana The First Chapter' }] } }
      : { body: { status: 'success', id: '9002', 'product-name': 'Elsa Spirit of Winter #42', 'console-name': 'Lorcana The First Chapter', 'loose-price': 1500, 'manual-only-price': 9000, 'condition-21-price': 7000, 'tcg-id': '500100', 'sales-volume': 3 } })
    const r = await enrichPcCard(envOf(db), 501, { nowSec: NOW, ...noWait })
    expect(r).toMatchObject({ ok: true, refreshed: true, written: 3, pcId: '9002', method: PC_API_SEARCH_METHOD })
    expect(calls.map(c => c.pathname)).toEqual(['/api/products', '/api/product'])
    expect(calls[0].searchParams.get('q')).toBe('Elsa - Spirit of Winter The First Chapter')
    expect(db.map).toEqual([expect.objectContaining({ pc_id: '9002', canonical_product_id: 501, match_method: 'api-search', game_category: 'api-only' })])
    expect(db.prices.find(p => p.company === 'TAG')).toMatchObject({ grade: 'TAG 10', value: 70, is_graded: 1 })
  })

  it('Pokémon Japan: the " - 021/087" suffix is stripped and only a Japanese console is accepted', async () => {
    const db = fakeDb({ products: [JAPAN] })
    const calls = stubPc(u => u.pathname === '/api/products'
      ? { body: { status: 'success', products: [
          { id: '1', 'product-name': 'Blastoise EX #21', 'console-name': 'Pokemon Card 151' },
          { id: '2', 'product-name': 'Blastoise EX #21', 'console-name': 'Pokemon Japanese Card 151' }] } }
      : { body: { status: 'success', id: '2', 'loose-price': 800, 'tcg-id': '800800' } })
    expect(await enrichPcCard(envOf(db), 777, { nowSec: NOW, ...noWait })).toMatchObject({ refreshed: true, pcId: '2' })
    expect(calls[0].searchParams.get('q')).toBe('Blastoise EX Pokemon Card 151')
    expect(db.map[0].game_category).toBe('pokemon-cards')
    expect(expectedConsoleLanguage(85, 'Pokemon Card 151')).toBe('japanese')
    expect(expectedConsoleLanguage(3, 'Base Set')).not.toBe('japanese')
    expect(gameCategoryFor(3)).toBe('pokemon-cards')
  })

  it('a weak / foreign-only match is a MISS: nothing written, negative-cached 24 h (no second lookup)', async () => {
    const db = fakeDb({ products: [LORCANA] })
    const calls = stubPc(() => ({ body: { status: 'success', products: [{ id: '5', 'product-name': 'Elsa Spirit of Winter #42', 'console-name': 'Lorcana Japanese Promo' }] } }))
    expect(await enrichPcCard(envOf(db), 501, { nowSec: NOW, ...noWait })).toMatchObject({ ok: true, written: 0, reason: 'no_match' })
    expect(db.fresh.get(`501|${PC_ONVIEW_MISS_CLASS}`)).toBe(NOW)
    expect(db.prices).toHaveLength(0)
    expect(db.map).toHaveLength(0)
    expect(await enrichPcCard(envOf(db), 501, { nowSec: NOW + 3600, ...noWait })).toMatchObject({ reason: 'no_match' })
    expect(await enrichPcCard(envOf(db), 501, { nowSec: NOW + 3600, force: true, ...noWait })).toMatchObject({ reason: 'no_match' })
    expect(calls).toHaveLength(1)
  })

  it('a search hit whose tcg-id names ANOTHER product is a miss; a pc id stamped on another product is never taken', async () => {
    const db = fakeDb({ products: [LORCANA] })
    stubPc(u => u.pathname === '/api/products'
      ? { body: { status: 'success', products: [{ id: '9002', 'product-name': 'Elsa Spirit of Winter #42', 'console-name': 'Lorcana The First Chapter' }] } }
      : { body: { status: 'success', id: '9002', 'loose-price': 1500, 'tcg-id': '999' } })
    expect(await enrichPcCard(envOf(db), 501, { nowSec: NOW, ...noWait })).toMatchObject({ written: 0, reason: 'no_match' })
    expect(db.prices).toHaveLength(0)

    const db2 = fakeDb({ products: [LORCANA], map: [mapped({ pc_id: '9002', canonical_product_id: 12 })] })
    const calls = stubPc(() => ({ body: { status: 'success', products: [{ id: '9002', 'product-name': 'Elsa Spirit of Winter #42', 'console-name': 'Lorcana The First Chapter' }] } }))
    expect(await enrichPcCard(envOf(db2), 501, { nowSec: NOW, ...noWait })).toMatchObject({ reason: 'no_match' })
    expect(calls.map(c => c.pathname)).toEqual(['/api/products'])
  })

  it('a transient failure writes nothing and does NOT negative-cache; capacity answers ok:false', async () => {
    const db = fakeDb({ products: [CHARIZARD], map: [mapped()] })
    stubPc(() => ({ status: 503, body: {} }))
    expect(await enrichPcCard(envOf(db), 27710, { nowSec: NOW, ...noWait })).toMatchObject({ ok: false, reason: 'transient' })
    expect(db.fresh.size).toBe(0)
    const day = onViewCounterKey(new Date(NOW * 1000))
    expect(await enrichPcCard(envOf(db, fakeKV({ [day]: '5000' })), 27710, { nowSec: NOW, ...noWait }))
      .toMatchObject({ ok: false, reason: 'capacity', capacity: 'daily_cap', written: 0 })
  })

  it('twin map rows → the CSV writer’s owner (untagged beats [Reverse Holo])', () => {
    expect(pickMapOwner([
      { pc_id: '7', product_name: 'Flareon [Reverse Holo] #13', console_name: 'Pokemon Jungle' },
      { pc_id: '9', product_name: 'Flareon #13', console_name: 'Pokemon Jungle' },
    ], { number: '13/64', setName: 'Jungle' })).toBe('9')
  })
})

// ── 3. The route ─────────────────────────────────────────────────────────────────────────────────

const SECRET = 's3'
const postTo = (env: any, body: unknown, secret: string | null = SECRET) => worker.fetch(new Request('https://worker.test/pricecharting/enrich-card', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'x-worker-secret': secret } : {}) }, body: JSON.stringify(body),
}), env, { waitUntil() {} } as any)

describe('POST /pricecharting/enrich-card', () => {
  const on = { pricecharting_onview_enabled: '1' }
  it('gate order: 401 → 503 → 409 → 400', async () => {
    expect((await postTo({ DB: fakeDb({ config: on }), INGESTION_WORKER_SECRET: SECRET, PRICECHARTING_TOKEN: 't' }, { canonicalProductId: 1 }, null)).status).toBe(401)
    const r503 = await postTo({ DB: fakeDb({ config: on }), INGESTION_WORKER_SECRET: SECRET }, { canonicalProductId: 1 })
    expect(r503.status).toBe(503); expect(await r503.json()).toMatchObject({ error: 'pricecharting_not_configured' })
    const r409 = await postTo({ DB: fakeDb({ config: { pricecharting_onview_enabled: '0' } }), INGESTION_WORKER_SECRET: SECRET, PRICECHARTING_TOKEN: 't' }, { canonicalProductId: 1 })
    expect(r409.status).toBe(409); expect(await r409.json()).toMatchObject({ error: 'pricecharting_onview_disabled' })
    expect((await postTo({ DB: fakeDb(), INGESTION_WORKER_SECRET: SECRET, PRICECHARTING_TOKEN: 't' }, { canonicalProductId: 1 })).status).toBe(409) // absent row = OFF
    expect((await postTo({ DB: fakeDb({ config: on }), INGESTION_WORKER_SECRET: SECRET, PRICECHARTING_TOKEN: 't' }, { canonicalProductId: 'x' })).status).toBe(400)
  })
  it('the work: writes and returns { ok, written, pcId, fetchedAt }; `force` must be literally true', async () => {
    const db = fakeDb({ config: on, products: [CHARIZARD], map: [{ pc_id: '630417', canonical_product_id: 27710, product_name: 'Charizard #4', console_name: 'Pokemon Base Set', match_method: 'tcg-id', game_category: 'pokemon-cards', sales_volume: null }] })
    stubPc(() => ({ body: DOC_PRODUCT }))
    const res = await postTo({ DB: db, SLEEVEDPAGES_KV: fakeKV(), INGESTION_WORKER_SECRET: SECRET, PRICECHARTING_TOKEN: 't' }, { canonicalProductId: 27710, force: 'yes' })
    expect(res.status).toBe(200)
    const j = await res.json() as any
    expect(j).toMatchObject({ ok: true, refreshed: true, written: 19, pcId: '630417' })
    expect(typeof j.fetchedAt).toBe('number')
    // A second call inside 24 h with force: the floor answers, no fetch.
    const again = await (await postTo({ DB: db, SLEEVEDPAGES_KV: fakeKV(), INGESTION_WORKER_SECRET: SECRET, PRICECHARTING_TOKEN: 't' }, { canonicalProductId: 27710, force: true })).json()
    expect(again).toMatchObject({ refreshed: false, reason: 'floor' })
  })
})

// ── The CSV PROCESS and the on-view rows coexist ─────────────────────────────────────────────────
describe('the CSV writer never undoes the on-view rows', () => {
  it('pricechartingIngest.ts never DELETEs prices and never touches card_enrichment_freshness', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./pricechartingIngest.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/DELETE\s+FROM\s+prices/i)
    expect(src).not.toMatch(/card_enrichment_freshness/)
  })
})
