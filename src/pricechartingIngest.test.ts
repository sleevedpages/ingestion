import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  fetchPriceChartingCsvToR2,
  processPriceChartingWindow,
  startPriceChartingProcessing,
  resolveProcessKey,
  rawKeyFor,
  R2_RAW_PREFIX,
  type PcProcessMessage,
} from './pricechartingIngest.js'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

// ── In-memory fakes ─────────────────────────────────────────────────────────────
function makeKV() {
  const store = new Map<string, string>()
  return {
    _store: store,
    async get(k: string) { return store.has(k) ? store.get(k)! : null },
    async put(k: string, v: string) { store.set(k, String(v)) },
    async delete(k: string) { store.delete(k) },
  }
}

interface Product {
  id: number; tcgplayer_product_id: number | null; name: string; number: string; category: number
  kind?: 'card' | 'sealed'   // product_kind (default 'card') — gates the number-less candidate pool
  setName?: string           // sets.name — console↔set corroboration for the number-less rung
}

function makeFakeDb(products: Product[]) {
  const prices = new Map<string, number>()                       // `${productId}|${grade}` → value
  const pcMap = new Map<string, { canonical_product_id: number | null; match_method: string | null }>()

  function query(sql: string, args: any[]) {
    // loadExistingMatches: keyset-paginated already-matched map (mint stamps / prior runs).
    if (sql.includes('FROM pricecharting_products')) {
      const cursor = String(args[1] ?? '')
      const rows = [...pcMap.entries()]
        .filter(([id, v]) => v.canonical_product_id != null && id > cursor)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([pcId, v]) => ({ pcId, productId: v.canonical_product_id }))
      return { results: rows }
    }
    // loadProductIndex: number-less candidate pool (cards only, with set name).
    if (sql.includes('p.number IS NULL')) {
      const cats = args.map(Number)
      const offsetMatch = sql.match(/OFFSET (\d+)/)
      const offset = offsetMatch ? Number(offsetMatch[1]) : 0
      if (offset > 0) return { results: [] }
      return { results: products
        .filter((p) => cats.includes(p.category) && !p.number && (p.kind ?? 'card') === 'card')
        .map((p) => ({ id: p.id, name: p.name, setName: p.setName ?? '' })) }
    }
    // loadProductIndex: the paginated primary product pull (scoped by category). One page.
    if (sql.includes('FROM products p') && sql.includes('JOIN canonical_games')) {
      const cats = args.map(Number)
      const offsetMatch = sql.match(/OFFSET (\d+)/)
      const offset = offsetMatch ? Number(offsetMatch[1]) : 0
      if (offset > 0) return { results: [] }
      return { results: products.filter((p) => cats.includes(p.category))
        .map((p) => ({ id: p.id, tcgId: p.tcgplayer_product_id, name: p.name, number: p.number })) }
    }
    throw new Error('unhandled query SQL: ' + sql.slice(0, 60))
  }
  function write(sql: string, args: any[]) {
    if (sql.includes('INTO pricecharting_products')) {
      const pcId = String(args[0]); const canonical = args[2]; const method = args[3]
      const prev = pcMap.get(pcId)
      // Mirrors the real upsert's COALESCE semantics: a NULL excluded value preserves the
      // stored canonical_product_id / match_method (the mint-stamp survival contract).
      pcMap.set(pcId, {
        canonical_product_id: canonical ?? prev?.canonical_product_id ?? null,
        match_method:         method ?? prev?.match_method ?? null,
      })
    } else if (sql.includes('INTO prices')) {
      // binds: productId, condition, finish, grade, is_graded, value, retail_buy, retail_sell
      const grade = args[3] ?? null
      if ((grade == null ? 0 : 1) !== args[4]) throw new Error('is_graded bind out of step with grade label')
      prices.set(`${args[0]}|${grade ?? ''}`, args[5])
    } else throw new Error('unhandled write SQL: ' + sql.slice(0, 60))
  }
  const db = {
    _prices: prices, _pcMap: pcMap,
    prepare(sql: string) {
      return {
        bind(...a: any[]) {
          return { _sql: sql, _args: a, all: async () => query(sql, a), run: async () => { write(sql, a); return {} } }
        },
      }
    },
    async batch(stmts: any[]) { for (const s of stmts) write(s._sql, s._args); return stmts.map(() => ({})) },
  }
  return db
}

function csvStream(csv: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(csv)
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close() } })
}

// Fake R2 bucket: get/put/head/list, value normalised to a string. Mirrors the bits we use —
// and, like real R2, REJECTS a no-length ReadableStream (the regression guard for the put bug).
function makeR2() {
  const store = new Map<string, string>()
  return {
    _store: store,
    async put(key: string, value: any) {
      let s: string
      if (typeof value === 'string') s = value
      else if (value instanceof Uint8Array) s = new TextDecoder().decode(value)
      else if (value instanceof ArrayBuffer) s = new TextDecoder().decode(new Uint8Array(value))
      else if (value && typeof value.getReader === 'function') {
        // Real R2 REJECTS a no-length ReadableStream ("Provided readable stream must have a known
        // length"). Mimic that so a regression to `put(res.body)` fails this test (it shipped once).
        throw new TypeError('Provided readable stream must have a known length')
      }
      else s = String(value)
      store.set(key, s)
      return { key }
    },
    async get(key: string) {
      if (!store.has(key)) return null
      const s = store.get(key)!
      return { key, body: csvStream(s), async text() { return s } }
    },
    async head(key: string) { return store.has(key) ? { key } : null },
    async list({ prefix, cursor }: { prefix?: string; cursor?: string } = {}) {
      void cursor
      const objects = [...store.keys()]
        .filter((k) => !prefix || k.startsWith(prefix))
        .map((key) => ({ key }))
      return { objects, truncated: false as const }
    },
  }
}

function makeQueue() {
  const sent: any[] = []
  return { sent, async send(m: any) { sent.push(m) } }
}

// TAB-separated — the real PriceCharting export format (price fields carry unquoted commas).
const COLS = [
  'id', 'console-name', 'product-name', 'loose-price', 'cib-price', 'new-price', 'graded-price',
  'box-only-price', 'manual-only-price', 'bgs-10-price', 'condition-17-price', 'condition-18-price',
  'sales-volume', 'genre', 'tcg-id',
]
const HEADER = COLS.join('\t')
function row(vals: Partial<Record<string, string>>): string {
  return COLS.map((c) => vals[c] ?? '').join('\t')
}

const PRODUCTS: Product[] = [
  { id: 7,  tcgplayer_product_id: 12345, name: 'Charizard ex', number: '125/197', category: 3 },
  { id: 8,  tcgplayer_product_id: 99999, name: 'Pikachu',      number: '58/197',  category: 3 },
  { id: 20, tcgplayer_product_id: 55555, name: 'Booster Box',  number: '',        category: 3, kind: 'sealed' },
]

function buildCsv() {
  return [
    HEADER,
    // A — tcg-id primary hit (ungraded + PSA 10 + Grade 9); $2,200.00 exercises the real
    //     tab-separated format where price fields carry unquoted thousands commas.
    row({ id: 'pcA', 'console-name': 'Pokemon Obsidian Flames', 'product-name': 'Charizard ex #125',
          'loose-price': '$2,200.00 ', 'manual-only-price': '$1,450.50', 'graded-price': '$88.00',
          'sales-volume': '33', genre: 'Pokemon Obsidian Flames', 'tcg-id': '12345' }),
    // B — fuzzy fallback (no tcg-id), name+number → product 8
    row({ id: 'pcB', 'console-name': 'Pokemon Obsidian Flames', 'product-name': 'Pikachu #58',
          'loose-price': '$2.00', genre: 'Pokemon Obsidian Flames', 'tcg-id': '' }),
    // C — weak/unmatched (number with no canonical candidate)
    row({ id: 'pcC', 'console-name': 'Pokemon X', 'product-name': 'Mewtwo #10',
          'loose-price': '$5.00', genre: 'Pokemon X', 'tcg-id': '' }),
    // D — sealed, tcg-id hit; ONLY the ungraded row must be written (manual-only ignored)
    row({ id: 'pcD', 'console-name': 'Pokemon', 'product-name': 'Booster Box',
          'loose-price': '$120.00', 'manual-only-price': '$999.00', genre: 'Sealed Product', 'tcg-id': '55555' }),
  ].join('\n')
}

const today = () => new Date().toISOString().slice(0, 10)
const procMsg = (key: string, offset = 0): PcProcessMessage =>
  ({ kind: 'pricecharting-process', category: 'pokemon-cards', key, offset })

// ── FETCH (download → R2; the only rate-limited path) ───────────────────────────
describe('fetchPriceChartingCsvToR2', () => {
  it('throws on a missing token (no download attempted)', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(fetchPriceChartingCsvToR2({ IMAGES_BUCKET: makeR2(), SLEEVEDPAGES_KV: makeKV() } as any, 'pokemon-cards'))
      .rejects.toThrow('PRICECHARTING_TOKEN')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('downloads ONCE → stores the dated R2 key and arms the cooldown', async () => {
    const r2 = makeR2(); const kv = makeKV()
    const fetchSpy = vi.fn(async () => new Response(csvStream(buildCsv()), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    const env = { PRICECHARTING_TOKEN: 'tok', IMAGES_BUCKET: r2, SLEEVEDPAGES_KV: kv }
    const res = await fetchPriceChartingCsvToR2(env as any, 'pokemon-cards')

    expect(fetchSpy).toHaveBeenCalledTimes(1)           // exactly one download
    expect(res.key).toBe(rawKeyFor('pokemon-cards', today()))
    expect(r2._store.has(res.key)).toBe(true)
    expect(r2._store.get(res.key)).toContain('Charizard ex') // raw bytes cached verbatim
    expect(kv._store.has('ingestion_pc_csv_cooldown')).toBe(true) // cooldown armed
  })

  it('throws on a non-200 download but STILL arms the cooldown (never retry-loop into the limit)', async () => {
    const r2 = makeR2(); const kv = makeKV()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 429 })))
    const env = { PRICECHARTING_TOKEN: 'tok', IMAGES_BUCKET: r2, SLEEVEDPAGES_KV: kv }

    await expect(fetchPriceChartingCsvToR2(env as any, 'pokemon-cards')).rejects.toThrow(/HTTP 429/)
    expect(kv._store.has('ingestion_pc_csv_cooldown')).toBe(true) // a 429 still cools down
    expect(r2._store.size).toBe(0)                                // nothing cached on failure
  })
})

// ── PROCESS (from R2; unlimited, no download) ───────────────────────────────────
describe('processPriceChartingWindow', () => {
  function seedR2() {
    const r2 = makeR2()
    const key = rawKeyFor('pokemon-cards', today())
    r2._store.set(key, buildCsv())
    return { r2, key }
  }

  it('ingests the cached file (tcg-id + fuzzy + unmatched + sealed) with NO download', async () => {
    const { r2, key } = seedR2(); const db = makeFakeDb(PRODUCTS)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const c = await processPriceChartingWindow({ DB: db, IMAGES_BUCKET: r2 } as any, procMsg(key))

    expect(fetchSpy).not.toHaveBeenCalled()  // PROCESS never downloads
    expect(c.matchedTcgId).toBe(2)           // A + D
    expect(c.matchedFuzzy).toBe(1)           // B
    expect(c.unmatched).toBe(1)              // C
    expect(c.sealedRows).toBe(1)             // D
    expect(c.sealedMatched).toBe(1)
    expect(c.wrapped).toBe(true)             // whole file processed in one window

    // A → ungraded + PSA 10 + Grade 9 (dollars). $2,200.00 (comma) parsed correctly.
    expect(db._prices.get('7|')).toBe(2200)
    expect(db._prices.get('7|PSA 10')).toBe(1450.5)
    expect(db._prices.get('7|Grade 9')).toBe(88)
    expect(db._prices.get('8|')).toBe(2)        // B ungraded only
    expect(db._prices.get('20|')).toBe(120)     // D (sealed) ungraded ONLY
    expect(db._prices.has('20|PSA 10')).toBe(false)
    // Unmatched row C recorded (null), matched rows persisted.
    expect(db._pcMap.get('pcC')).toEqual({ canonical_product_id: null, match_method: null })
    expect(db._pcMap.get('pcA')?.canonical_product_id).toBe(7)
    expect(db._pcMap.get('pcB')?.canonical_product_id).toBe(8)
  })

  it('windows across invocations via the message offset — advances, then wraps at EOF', async () => {
    const { r2, key } = seedR2(); const db = makeFakeDb(PRODUCTS)
    const env = { DB: db, IMAGES_BUCKET: r2, PC_INGEST_MAX_ROWS: '2' } as any  // 2 of 4 rows per window

    const r1 = await processPriceChartingWindow(env, procMsg(key, 0))
    expect(r1.rowsProcessed).toBe(2)     // A + B
    expect(r1.wrapped).toBe(false)
    expect(r1.cursorNext).toBe(2)        // next offset travels in the (re-enqueued) message
    expect(db._prices.get('7|')).toBe(2200)
    expect(db._prices.has('20|')).toBe(false)  // D not reached yet

    const r2c = await processPriceChartingWindow(env, procMsg(key, r1.cursorNext))
    expect(r2c.windowStart).toBe(2)
    expect(r2c.rowsProcessed).toBe(2)    // C + D
    expect(r2c.wrapped).toBe(true)       // EOF → chain stops
    expect(db._prices.get('20|')).toBe(120)
  })

  it('is idempotent — re-processing the same R2 file writes no duplicate prices', async () => {
    const { r2, key } = seedR2(); const db = makeFakeDb(PRODUCTS)
    vi.stubGlobal('fetch', vi.fn())
    await processPriceChartingWindow({ DB: db, IMAGES_BUCKET: r2 } as any, procMsg(key))
    const after1 = db._prices.size
    await processPriceChartingWindow({ DB: db, IMAGES_BUCKET: r2 } as any, procMsg(key))
    expect(db._prices.size).toBe(after1)
  })

  it('treats a missing R2 object as terminal (wrapped) — no throw, no download', async () => {
    const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy)
    const c = await processPriceChartingWindow({ DB: makeFakeDb(PRODUCTS), IMAGES_BUCKET: makeR2() } as any,
      procMsg('ingest-raw/pricecharting/pokemon-cards/1999-01-01.csv'))
    expect(c.wrapped).toBe(true)
    expect(c.rowsProcessed).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// ── Driver: enqueue (prod) vs inline (no queue) ─────────────────────────────────
describe('startPriceChartingProcessing', () => {
  it('enqueues the first window when a queue is bound (no inline work)', async () => {
    const r2 = makeR2(); const key = rawKeyFor('pokemon-cards', today()); r2._store.set(key, buildCsv())
    const db = makeFakeDb(PRODUCTS); const q = makeQueue()
    const res = await startPriceChartingProcessing({ DB: db, IMAGES_BUCKET: r2, PC_PROCESS_QUEUE: q } as any,
      'pokemon-cards', key)
    expect(res.enqueued).toBe(true)
    expect(q.sent).toEqual([{ kind: 'pricecharting-process', category: 'pokemon-cards', key, offset: 0, stale: false }])
    expect(db._prices.size).toBe(0)  // the queue does the work, not this call
  })

  it('processes inline to EOF when no queue is bound (local/dry-run path)', async () => {
    const r2 = makeR2(); const key = rawKeyFor('pokemon-cards', today()); r2._store.set(key, buildCsv())
    const db = makeFakeDb(PRODUCTS)
    const res = await startPriceChartingProcessing({ DB: db, IMAGES_BUCKET: r2, PC_INGEST_MAX_ROWS: '2' } as any,
      'pokemon-cards', key)
    expect(res.enqueued).toBe(false)
    expect(res.counts!.at(-1)!.wrapped).toBe(true)         // ran every window to EOF
    expect(db._prices.get('20|')).toBe(120)                // last row written
  })
})

// ── End-to-end: a BIG category completes from ONE download ──────────────────────
describe('big category — ONE download, then full ingest across many windows', () => {
  // A scaled stand-in for the ~88k-row export: N rows, each tcg-id-matched to a product.
  function bigCsvAndProducts(n: number) {
    const products: Product[] = []
    const lines = [HEADER]
    for (let i = 0; i < n; i++) {
      const tcg = 100000 + i
      products.push({ id: 1000 + i, tcgplayer_product_id: tcg, name: `Card ${i}`, number: `${i}/999`, category: 3 })
      lines.push(row({ id: `pc${i}`, 'console-name': 'Pokemon Set', 'product-name': `Card ${i} #${i}`,
        'loose-price': `$${(i % 50) + 1}.00`, genre: 'Pokemon Set', 'tcg-id': String(tcg) }))
    }
    return { csv: lines.join('\n'), products }
  }

  // Mimic the worker's queue consumer: process a window, re-enqueue the next offset, until wrapped.
  async function drainChain(env: any, key: string): Promise<number> {
    let msg = procMsg(key, 0)
    let windows = 0
    for (;;) {
      const c = await processPriceChartingWindow(env, msg)
      windows++
      if (c.wrapped) break
      msg = { ...msg, offset: c.cursorNext }
      if (windows > 5000) throw new Error('runaway chain (never wrapped)')
    }
    return windows
  }

  it('fetches ONCE → R2, then ingests every row across many windows with ZERO re-downloads', async () => {
    const { csv, products } = bigCsvAndProducts(2500)
    const r2 = makeR2(); const kv = makeKV(); const db = makeFakeDb(products)
    const fetchSpy = vi.fn(async () => new Response(csvStream(csv), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const env = { PRICECHARTING_TOKEN: 'tok', IMAGES_BUCKET: r2, SLEEVEDPAGES_KV: kv, DB: db, PC_INGEST_MAX_ROWS: '300' }

    // FETCH — exactly one download lands in R2 under the dated key.
    const { key } = await fetchPriceChartingCsvToR2(env as any, 'pokemon-cards')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(r2._store.has(key)).toBe(true)

    // PROCESS — the chain spans MANY windows (one download, N cheap R2 reads), zero re-downloads.
    const windows = await drainChain(env, key)
    expect(windows).toBeGreaterThan(5)            // genuinely spanned many invocations
    expect(fetchSpy).toHaveBeenCalledTimes(1)     // STILL one download total — never N
    expect(db._prices.size).toBe(2500)            // every row ingested
    expect(db._prices.get('1123|')).toBe(24)      // spot-check a known card (i=123 → (123%50)+1)

    // RE-PROCESS without download — idempotent; still exactly one download ever.
    await drainChain(env, key)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(db._prices.size).toBe(2500)
  })
})

// ── Number-less rung (DON!!s) + mint-stamp skip (2026-07-15) ────────────────────
describe('number-less set-corroborated matching (One Piece DON!!s)', () => {
  // Real prod shape (DIAGNOSTIC_DON_AND_GEMPACK A3): pc_id 13256449 "DON!! Card [Dodgers]",
  // console "One Piece Promo", NO tcg-id, NO digit token → structurally unmatchable before
  // this rung. Canonical 'DON!! Card (Dodgers)' has number NULL by Bandai design.
  const OP_PRODUCTS: Product[] = [
    { id: 30, tcgplayer_product_id: 619417, name: 'DON!! Card (Dodgers)', number: '', category: 68,
      setName: 'One Piece Promotion Cards' },
    // Same base name, different set — must NOT corroborate against the Promo console.
    { id: 31, tcgplayer_product_id: 619500, name: 'DON!! Card', number: '', category: 68,
      setName: 'Starter Deck 01' },
  ]
  const opCsv = [
    HEADER,
    row({ id: 'pcDON', 'console-name': 'One Piece Promo', 'product-name': 'DON!! Card [Dodgers]',
          'loose-price': '$50.00', 'graded-price': '$80.00', genre: 'One Piece Card', 'tcg-id': '' }),
  ].join('\n')
  const opMsg = (key: string): PcProcessMessage =>
    ({ kind: 'pricecharting-process', category: 'one-piece-cards', key, offset: 0 })

  it('matches the Dodgers DON via the number-less rung (loose + graded prices written)', async () => {
    const r2 = makeR2(); const key = rawKeyFor('one-piece-cards', today()); r2._store.set(key, opCsv)
    const db = makeFakeDb(OP_PRODUCTS)
    const c = await processPriceChartingWindow({ DB: db, IMAGES_BUCKET: r2 } as any, opMsg(key))
    expect(c.matchedNumberless).toBe(1)
    expect(c.numberlessAttempts).toBe(1)
    expect(c.unmatched).toBe(0)
    expect(db._pcMap.get('pcDON')).toEqual({ canonical_product_id: 30, match_method: 'numberless' })
    expect(db._prices.get('30|')).toBe(50)          // loose/ungraded
    expect(db._prices.get('30|Grade 9')).toBe(80)   // graded bucket flows too
  })

  it('a digit-bearing Chinese Gem Pack row NEVER enters the number-less rung (no English cross-match)', async () => {
    const r2 = makeR2(); const key = rawKeyFor('pokemon-cards', today())
    r2._store.set(key, [
      HEADER,
      row({ id: 'pcGP', 'console-name': 'Pokemon Chinese Gem Pack', 'product-name': 'Gengar #307',
            'loose-price': '$14.00', genre: 'Pokemon Card', 'tcg-id': '' }),
    ].join('\n'))
    // English catalogue: a numbered Gengar (different number) AND a number-less English Gengar —
    // neither may capture the Chinese row (the digit token keeps it on the numeric rung).
    const db = makeFakeDb([
      { id: 40, tcgplayer_product_id: 88001, name: 'Gengar', number: '226/264', category: 3 },
      { id: 41, tcgplayer_product_id: null,  name: 'Gengar', number: '', category: 3, setName: 'Pokemon Promo' },
    ])
    const c = await processPriceChartingWindow({ DB: db, IMAGES_BUCKET: r2 } as any, procMsg(key))
    expect(c.numberlessAttempts).toBe(0)   // digit token → number-less rung never fires
    expect(c.matchedNumberless).toBe(0)
    expect(c.unmatched).toBe(1)            // pre-mint: recorded unmatched, never mispriced
    expect(db._pcMap.get('pcGP')?.canonical_product_id).toBeNull()
    expect(db._prices.size).toBe(0)
  })

  it('a pre-stamped (minted) row skips the matcher, keeps its method, and gets prices written', async () => {
    const r2 = makeR2(); const key = rawKeyFor('pokemon-cards', today())
    r2._store.set(key, [
      HEADER,
      row({ id: 'pcMINT', 'console-name': 'Pokemon Chinese Gem Pack', 'product-name': 'Gengar #307',
            'loose-price': '$12.00', 'manual-only-price': '$99.00', genre: 'Pokemon Card', 'tcg-id': '' }),
    ].join('\n'))
    const db = makeFakeDb([])   // minted product is NOT in the matcher index — the stamp alone carries it
    db._pcMap.set('pcMINT', { canonical_product_id: 500, match_method: 'minted' })
    const c = await processPriceChartingWindow({ DB: db, IMAGES_BUCKET: r2 } as any, procMsg(key))
    expect(c.matchedExisting).toBe(1)
    expect(c.unmatched).toBe(0)
    // The stamp survives (matcher never fights it) and the ordinary price write path fires.
    expect(db._pcMap.get('pcMINT')).toEqual({ canonical_product_id: 500, match_method: 'minted' })
    expect(db._prices.get('500|')).toBe(12)
    expect(db._prices.get('500|PSA 10')).toBe(99)
  })
})

// ── Stale fallback resolution ───────────────────────────────────────────────────
describe('resolveProcessKey', () => {
  it('prefers today’s file (not stale)', async () => {
    const r2 = makeR2(); const key = rawKeyFor('pokemon-cards', today()); r2._store.set(key, 'x')
    expect(await resolveProcessKey({ IMAGES_BUCKET: r2 } as any, 'pokemon-cards')).toEqual({ key, stale: false })
  })

  it('falls back to the most-recent older file and flags it stale', async () => {
    const r2 = makeR2()
    const older = rawKeyFor('pokemon-cards', '2020-01-01'); r2._store.set(older, 'x')
    const newer = rawKeyFor('pokemon-cards', '2020-06-15'); r2._store.set(newer, 'x')
    expect(await resolveProcessKey({ IMAGES_BUCKET: r2 } as any, 'pokemon-cards'))
      .toEqual({ key: newer, stale: true })   // lexicographically-greatest dated key
  })

  it('returns null when nothing has ever been fetched', async () => {
    expect(await resolveProcessKey({ IMAGES_BUCKET: makeR2() } as any, 'pokemon-cards')).toBeNull()
  })

  it('scopes by category (R2 prefix)', async () => {
    const r2 = makeR2()
    r2._store.set(rawKeyFor('magic-cards', today()), 'x')      // wrong category present
    expect(await resolveProcessKey({ IMAGES_BUCKET: r2 } as any, 'pokemon-cards')).toBeNull()
    expect(R2_RAW_PREFIX).toBe('ingest-raw/pricecharting')
  })
})
