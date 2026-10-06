import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  fetchPriceChartingCsvToR2,
  processPriceChartingWindow,
  startPriceChartingProcessing,
  resolveProcessKey,
  rawKeyFor,
  twinRank,
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
  const pcMap = new Map<string, { canonical_product_id: number | null; match_method: string | null; upc: string | null }>()

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
      // setName rides the primary index too (2026-07-30) — the numeric fuzzy rung needs it
      // for the language + console↔set gates, and rejects any candidate without one.
      return { results: products.filter((p) => cats.includes(p.category))
        .map((p) => ({ id: p.id, tcgId: p.tcgplayer_product_id, name: p.name, number: p.number, setName: p.setName ?? '' })) }
    }
    throw new Error('unhandled query SQL: ' + sql.slice(0, 60))
  }
  function write(sql: string, args: any[]) {
    if (sql.includes('INTO pricecharting_products')) {
      const pcId = String(args[0]); const canonical = args[2]; const method = args[3]; const upc = args[9]
      const prev = pcMap.get(pcId)
      // Mirrors the real upsert's COALESCE semantics: a NULL excluded value preserves the
      // stored canonical_product_id / match_method (the mint-stamp survival contract) and
      // the stored upc (mig 0127 — a CSV that stops publishing a UPC never blanks it).
      pcMap.set(pcId, {
        canonical_product_id: canonical ?? prev?.canonical_product_id ?? null,
        match_method:         method ?? prev?.match_method ?? null,
        upc:                  upc ?? prev?.upc ?? null,
      })
    } else if (sql.includes('INTO prices')) {
      // binds: productId, condition, finish, grade, company, is_perfect, is_graded, value, retail_buy, retail_sell
      // (company / is_perfect since 2026-10-06 — NULL / 0 on every row but the CSV-only premium buckets)
      const grade = args[3] ?? null
      if ((grade == null ? 0 : 1) !== args[6]) throw new Error('is_graded bind out of step with grade label')
      prices.set(`${args[0]}|${grade ?? ''}${args[4] ? '|' + args[4] + (args[5] ? '*' : '') : ''}`, args[7])
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
  'upc', 'sales-volume', 'genre', 'tcg-id',
]
const HEADER = COLS.join('\t')
function row(vals: Partial<Record<string, string>>): string {
  return COLS.map((c) => vals[c] ?? '').join('\t')
}

const PRODUCTS: Product[] = [
  { id: 7,  tcgplayer_product_id: 12345, name: 'Charizard ex', number: '125/197', category: 3, setName: 'Obsidian Flames' },
  { id: 8,  tcgplayer_product_id: 99999, name: 'Pikachu',      number: '58/197',  category: 3, setName: 'Obsidian Flames' },
  { id: 20, tcgplayer_product_id: 55555, name: 'Booster Box',  number: '',        category: 3, kind: 'sealed', setName: 'Obsidian Flames' },
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
    expect(db._pcMap.get('pcC')).toEqual({ canonical_product_id: null, match_method: null, upc: null })
    expect(db._pcMap.get('pcA')?.canonical_product_id).toBe(7)
    expect(db._pcMap.get('pcB')?.canonical_product_id).toBe(8)
  })

  // ── 2026-10-06b: Pokémon Japanese rows through the foreign sibling catalogue (category 85) ──
  describe('Japanese rows → Pokémon Japan (tcg-id only, language-gated)', () => {
    const JP_PRODUCTS: Product[] = [
      ...PRODUCTS,
      { id: 501, tcgplayer_product_id: 613779, name: "Alto Mare's Latias", number: '', category: 85, setName: '10th Movie Commemoration Promo' },
      { id: 502, tcgplayer_product_id: 700021, name: 'Blastoise EX - 021/087', number: '021/087', category: 85, setName: '20th Anniversary' },
      { id: 503, tcgplayer_product_id: 700014, name: 'Cosmog (Mirror Holofoil)', number: '', category: 85, setName: '25th Anniversary Collection' },
      // a Japanese product whose name + number collide with an English fuzzy candidate's
      { id: 504, tcgplayer_product_id: 700058, name: 'Pikachu - 058/197', number: '058/197', category: 85, setName: 'Japanese set' },
      // the SAME tcg-id as an English product — the English index owns it
      { id: 505, tcgplayer_product_id: 12345, name: 'Charizard ex', number: '125/197', category: 85, setName: 'Shadow' },
      // one TCGplayer product, two PriceCharting rows (unlimited + 1st Edition)
      { id: 506, tcgplayer_product_id: 700006, name: 'Charizard - 006/087', number: '006/087', category: 85, setName: 'Rocket Gang' },
    ]
    const jpCsv = () => [
      HEADER,
      // J1 — Japanese console + id in cat 85 + names agree → matched, raw + graded written
      row({ id: 'pcJ1', 'console-name': 'Pokemon Japanese 10th Movie Commemoration Promo', 'product-name': "Alto Mare's Latias [Holo]",
            'loose-price': '$95.00', 'graded-price': '$164.00', 'manual-only-price': '$540.00', genre: 'Pokemon Card', 'tcg-id': '613779' }),
      // J2 — the " - 021/087" name: matched only because the suffix is stripped
      row({ id: 'pcJ2', 'console-name': 'Pokemon Japanese 20th Anniversary', 'product-name': 'Blastoise EX [1st Edition] #21',
            'loose-price': '$40.00', genre: 'Pokemon Card', 'tcg-id': '700021' }),
      // J3 — finish disagrees (Reverse Holo vs Mirror Holofoil) → rejected, stays unmatched
      row({ id: 'pcJ3', 'console-name': 'Pokemon Japanese 25th Anniversary Collection', 'product-name': 'Cosmog [Reverse Holo] #14',
            'loose-price': '$3.00', genre: 'Pokemon Card', 'tcg-id': '700014' }),
      // J4 — a CHINESE console carrying a cat-85 id → language gate rejects
      row({ id: 'pcJ4', 'console-name': 'Pokemon Chinese Gem Pack', 'product-name': "Alto Mare's Latias #5",
            'loose-price': '$7.00', genre: 'Pokemon Card', 'tcg-id': '613779' }),
      // J5 — an ENGLISH console carrying a cat-85 id → language gate rejects
      row({ id: 'pcJ5', 'console-name': 'Pokemon Promo', 'product-name': "Alto Mare's Latias",
            'loose-price': '$8.00', genre: 'Pokemon Card', 'tcg-id': '613779' }),
      // J6 — Japanese row WITHOUT a tcg-id → never reaches the Japanese catalogue (fuzzy is English-only)
      row({ id: 'pcJ6', 'console-name': 'Pokemon Japanese Obsidian Flames', 'product-name': 'Pikachu #58',
            'loose-price': '$9.00', genre: 'Pokemon Card', 'tcg-id': '' }),
      // J7 — Japanese row whose id belongs to an ENGLISH product → the English rung's behaviour, unchanged
      row({ id: 'pcJ7', 'console-name': 'Pokemon Japanese Promo', 'product-name': 'Charizard ex #125',
            'loose-price': '$11.00', genre: 'Pokemon Card', 'tcg-id': '12345' }),
      // J8 + J9 — the unlimited row and its [1st Edition] twin share one tcg-id; the tagged one sorts LAST
      row({ id: 'pcJ8', 'console-name': 'Pokemon Japanese Rocket Gang', 'product-name': 'Charizard #6',
            'loose-price': '$50.00', 'manual-only-price': '$400.00', genre: 'Pokemon Card', 'tcg-id': '700006' }),
      row({ id: 'pcJ9', 'console-name': 'Pokemon Japanese Rocket Gang', 'product-name': 'Charizard [1st Edition] #6',
            'loose-price': '$90.00', 'manual-only-price': '$900.00', genre: 'Pokemon Card', 'tcg-id': '700006' }),
    ].join('\n')

    async function runJp() {
      const r2 = makeR2(); const key = rawKeyFor('pokemon-cards', today())
      r2._store.set(key, jpCsv())
      const db = makeFakeDb(JP_PRODUCTS)
      const c = await processPriceChartingWindow({ DB: db, IMAGES_BUCKET: r2 } as any, procMsg(key))
      return { c, db }
    }

    it('matches a Japanese row to its Pokémon Japan product by tcg-id, labelled tcg-id-foreign, raw + graded', async () => {
      const { c, db } = await runJp()
      expect(c.matchedTcgIdForeign).toBe(3)                        // J1 + J2 + J8
      expect(db._pcMap.get('pcJ1')).toMatchObject({ canonical_product_id: 501, match_method: 'tcg-id-foreign' })
      expect(db._pcMap.get('pcJ2')).toMatchObject({ canonical_product_id: 502, match_method: 'tcg-id-foreign' })
      expect(db._prices.get('501|')).toBe(95)
      expect(db._prices.get('501|Grade 9')).toBe(164)
      expect(db._prices.get('501|PSA 10')).toBe(540)
      expect(db._prices.get('502|')).toBe(40)
    })

    it('rejects a finish mismatch, a Chinese or English console on a Japanese id, and never fuzzes into Japan', async () => {
      const { c, db } = await runJp()
      for (const id of ['pcJ3', 'pcJ4', 'pcJ5']) expect(db._pcMap.get(id)?.canonical_product_id).toBeNull()
      // J6 (no tcg-id, Japanese console) is NOT priced onto the Japanese Pikachu 504, and the
      // English fuzzy pool's language gate keeps it off the English Pikachu 8 too.
      expect(db._pcMap.get('pcJ6')?.canonical_product_id).toBeNull()
      expect([...db._prices.keys()].some((k) => k.startsWith('504|'))).toBe(false)
      expect(db._prices.has('503|')).toBe(false)
      expect(c.unmatched).toBe(5)                                   // J3 J4 J5 J6 + J9 (yielded)
    })

    it('one price per product: a [1st Edition] twin yields to the untagged row, even sorted last', async () => {
      const { c, db } = await runJp()
      expect(c.foreignYieldedToPlain).toBe(1)                       // J9
      expect(db._prices.get('506|')).toBe(50)                       // the unlimited price, not $90
      expect(db._prices.get('506|PSA 10')).toBe(400)
      expect(db._pcMap.get('pcJ8')).toMatchObject({ canonical_product_id: 506, match_method: 'tcg-id-foreign' })
      expect(db._pcMap.get('pcJ9')?.canonical_product_id).toBeNull()
      // …while a 1st-Edition-only card (J2: no untagged twin) still matches
      expect(db._pcMap.get('pcJ2')?.canonical_product_id).toBe(502)
    })

    it('a Japanese pair the in-window yield misses (split by a window boundary, or already stamped) settles at the write', async () => {
      // Window boundary between J8 (row 7) and J9 (row 8): J9's window holds no untagged sibling,
      // so the matcher's in-window yield cannot fire — J8's stamp from the previous window makes it
      // the product's owner, and the write-time twin rule holds J9's prices back.
      const r2 = makeR2(); const key = rawKeyFor('pokemon-cards', today()); r2._store.set(key, jpCsv())
      const db = makeFakeDb(JP_PRODUCTS)
      const env = { DB: db, IMAGES_BUCKET: r2, PC_INGEST_MAX_ROWS: '8' } as any
      const w1 = await processPriceChartingWindow(env, procMsg(key, 0))
      const w2 = await processPriceChartingWindow(env, procMsg(key, w1.cursorNext))
      expect(w2.wrapped).toBe(true)
      expect(w2.foreignYieldedToPlain).toBe(0)
      expect(w2.yieldedToTwin).toBe(1)                              // J9
      expect(db._prices.get('506|')).toBe(50)
      expect(db._prices.get('506|PSA 10')).toBe(400)

      // Both rows already stamped (what a split leaves behind): rung 0 resolves both, and the
      // write-time rule keeps the unlimited price.
      const db2 = makeFakeDb(JP_PRODUCTS)
      db2._pcMap.set('pcJ8', { canonical_product_id: 506, match_method: 'tcg-id-foreign', upc: null })
      db2._pcMap.set('pcJ9', { canonical_product_id: 506, match_method: 'tcg-id-foreign', upc: null })
      const c = await processPriceChartingWindow({ DB: db2, IMAGES_BUCKET: r2 } as any, procMsg(key))
      expect(c.yieldedToTwin).toBe(1)
      expect(db2._prices.get('506|')).toBe(50)
      expect(db2._prices.get('506|PSA 10')).toBe(400)
    })

    it('an id the English catalogue owns stays with the English product (the Japanese twin never shadows it)', async () => {
      const { c, db } = await runJp()
      expect(c.matchedTcgId).toBe(1)                                // J7 → English product 7, as before
      expect(db._pcMap.get('pcJ7')).toMatchObject({ canonical_product_id: 7, match_method: 'tcg-id' })
      expect([...db._prices.keys()].some((k) => k.startsWith('505|'))).toBe(false)
    })

    it('an English-only catalogue (no category-85 products) behaves exactly as before', async () => {
      const { r2, key } = seedR2(); const db = makeFakeDb(PRODUCTS)
      const c = await processPriceChartingWindow({ DB: db, IMAGES_BUCKET: r2 } as any, procMsg(key))
      expect(c).toMatchObject({ matchedTcgId: 2, matchedTcgIdForeign: 0, matchedFuzzy: 1, unmatched: 1 })
    })
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
    expect(db._pcMap.get('pcDON')).toEqual({ canonical_product_id: 30, match_method: 'numberless', upc: null })
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

  it('a Chinese row whose number DOES match an English product is still rejected (language gate)', async () => {
    // The case the test above could not catch: it relied on the English Gengar carrying a
    // DIFFERENT number (226 vs 307), so the numeric rung found no candidate at all. Here the
    // English product has the SAME name AND the SAME number — before the 2026-07-30 fix the
    // fuzzy rung scored 5 and wrote CHINESE pricing onto the ENGLISH product.
    const r2 = makeR2(); const key = rawKeyFor('pokemon-cards', today())
    r2._store.set(key, [
      HEADER,
      row({ id: 'pcGP2', 'console-name': 'Pokemon Chinese Gem Pack', 'product-name': 'Gengar #307',
            'loose-price': '$14.00', genre: 'Pokemon Card', 'tcg-id': '' }),
    ].join('\n'))
    const db = makeFakeDb([
      { id: 44, tcgplayer_product_id: 88002, name: 'Gengar', number: '307/193', category: 3,
        setName: 'Scarlet & Violet 151' },
    ])
    const c = await processPriceChartingWindow({ DB: db, IMAGES_BUCKET: r2 } as any, procMsg(key))
    expect(c.matchedFuzzy).toBe(0)
    expect(c.unmatched).toBe(1)
    expect(db._pcMap.get('pcGP2')?.canonical_product_id).toBeNull()
    expect(db._prices.size).toBe(0)        // NOTHING written to the English product
  })

  it('a pre-stamped (minted) row skips the matcher, keeps its method, and gets prices written', async () => {
    const r2 = makeR2(); const key = rawKeyFor('pokemon-cards', today())
    r2._store.set(key, [
      HEADER,
      row({ id: 'pcMINT', 'console-name': 'Pokemon Chinese Gem Pack', 'product-name': 'Gengar #307',
            'loose-price': '$12.00', 'manual-only-price': '$99.00', genre: 'Pokemon Card', 'tcg-id': '' }),
    ].join('\n'))
    const db = makeFakeDb([])   // minted product is NOT in the matcher index — the stamp alone carries it
    db._pcMap.set('pcMINT', { canonical_product_id: 500, match_method: 'minted', upc: null })
    const c = await processPriceChartingWindow({ DB: db, IMAGES_BUCKET: r2 } as any, procMsg(key))
    expect(c.matchedExisting).toBe(1)
    expect(c.unmatched).toBe(0)
    // The stamp survives (matcher never fights it) and the ordinary price write path fires.
    expect(db._pcMap.get('pcMINT')).toEqual({ canonical_product_id: 500, match_method: 'minted', upc: null })
    expect(db._prices.get('500|')).toBe(12)
    expect(db._prices.get('500|PSA 10')).toBe(99)
  })
})

// ── One price per product: PriceCharting twin rows (2026-10-06c) ────────────────
describe('twin rows — one price per product', () => {
  // Real prod case (tcgplayer_product_id 101437): PC splits the printing TCGplayer keeps as ONE
  // product into "Flareon #13" + "Flareon [Reverse Holo] #13", both carrying tcg-id 101437. Before
  // the fix the tagged row (later in the file) overwrote every key: prod stored 4.69 (Reverse Holo)
  // instead of 1.43, and the Reverse Holo PSA 10 in the graded matrix.
  const FLAREON: Product = { id: 16632, tcgplayer_product_id: 101437, name: 'Flareon', number: '13/98',
    category: 3, setName: 'XY - Ancient Origins' }
  const plain = row({ id: '959032', 'console-name': 'Pokemon Ancient Origins', 'product-name': 'Flareon #13',
    'loose-price': '$1.43', 'manual-only-price': '$41.14', genre: 'Pokemon Card', 'tcg-id': '101437' })
  const reverse = row({ id: '959129', 'console-name': 'Pokemon Ancient Origins', 'product-name': 'Flareon [Reverse Holo] #13',
    'loose-price': '$4.69', 'manual-only-price': '$451.76', 'bgs-10-price': '$587.00', genre: 'Pokemon Card', 'tcg-id': '101437' })

  async function run(lines: string[], products: Product[], env: Record<string, string> = {}, seed?: (db: ReturnType<typeof makeFakeDb>) => void) {
    const r2 = makeR2(); const key = rawKeyFor('pokemon-cards', today()); r2._store.set(key, [HEADER, ...lines].join('\n'))
    const db = makeFakeDb(products); seed?.(db)
    const counts: Awaited<ReturnType<typeof processPriceChartingWindow>>[] = []
    for (let offset = 0; ;) {
      const c = await processPriceChartingWindow({ DB: db, IMAGES_BUCKET: r2, ...env } as any, procMsg(key, offset))
      counts.push(c)
      if (c.wrapped) break
      offset = c.cursorNext
    }
    return { db, counts, yielded: counts.reduce((s, c) => s + c.yieldedToTwin, 0) }
  }

  it('the untagged row owns the product: loose AND graded come from it; the tagged twin writes nothing', async () => {
    const { db, yielded } = await run([plain, reverse], [FLAREON])
    expect(yielded).toBe(1)
    expect(db._prices.get('16632|')).toBe(1.43)
    expect(db._prices.get('16632|PSA 10')).toBe(41.14)
    expect(db._prices.has('16632|BGS 10')).toBe(false)   // only the twin priced it → never written
    // The twin keeps its map stamp — it IS a printing of the product, not a catalogue gap.
    expect(db._pcMap.get('959129')).toEqual({ canonical_product_id: 16632, match_method: 'tcg-id', upc: null })
  })

  it('already-STAMPED twins (rung 0, the prod state) self-correct on the next PROCESS', async () => {
    // Every prod twin is already stamped, so the matcher never runs for it — the yield must sit at
    // the write, not in the tcg-id rung. Seed the prod's wrong value too: the fix overwrites it.
    const { db, counts } = await run([plain, reverse], [FLAREON], {}, (d) => {
      d._pcMap.set('959032', { canonical_product_id: 16632, match_method: 'tcg-id', upc: null })
      d._pcMap.set('959129', { canonical_product_id: 16632, match_method: 'tcg-id', upc: null })
      d._prices.set('16632|', 4.69); d._prices.set('16632|PSA 10', 451.76)
    })
    expect(counts[0].matchedExisting).toBe(2)
    expect(counts[0].matchedTcgId).toBe(0)
    expect(counts[0].yieldedToTwin).toBe(1)
    expect(db._prices.get('16632|')).toBe(1.43)
    expect(db._prices.get('16632|PSA 10')).toBe(41.14)
  })

  it('ownership is decided over the WHOLE file — window boundaries never matter, in either order', async () => {
    for (const lines of [[plain, reverse], [reverse, plain]]) {
      const { db, counts, yielded } = await run(lines, [FLAREON], { PC_INGEST_MAX_ROWS: '1' })
      expect(counts).toHaveLength(2)                    // one row per window
      expect(counts[0].wrapped).toBe(false)
      expect(yielded).toBe(1)
      expect(db._prices.get('16632|')).toBe(1.43)
      expect(db._prices.has('16632|BGS 10')).toBe(false)
    }
  })

  it('with no untagged row, the row with fewer tag words owns ([Holo] over [Reverse Holo], [Shadowless] over [1st Edition])', async () => {
    const products: Product[] = [
      { id: 1, tcgplayer_product_id: 501, name: 'Kleavor', number: '086/189', category: 3, setName: 'SWSH10: Astral Radiance' },
      { id: 2, tcgplayer_product_id: 502, name: 'Charizard', number: '4/102', category: 3, setName: 'Base Set (Shadowless)' },
    ]
    const { db, yielded } = await run([
      row({ id: 'k1', 'console-name': 'Pokemon Astral Radiance', 'product-name': 'Kleavor [Holo] #86', 'loose-price': '$0.45', 'tcg-id': '501' }),
      row({ id: 'k2', 'console-name': 'Pokemon Astral Radiance', 'product-name': 'Kleavor [Reverse Holo] #86', 'loose-price': '$0.99', 'tcg-id': '501' }),
      row({ id: 'c1', 'console-name': 'Pokemon Base Set', 'product-name': 'Charizard [1st Edition] #4', 'loose-price': '$9000.00', 'tcg-id': '502' }),
      row({ id: 'c2', 'console-name': 'Pokemon Base Set', 'product-name': 'Charizard [Shadowless] #4', 'loose-price': '$1500.00', 'tcg-id': '502' }),
    ], products)
    expect(yielded).toBe(2)
    expect(db._prices.get('1|')).toBe(0.45)
    expect(db._prices.get('2|')).toBe(1500)
  })

  it('a row whose #number disagrees with the product yields ("Alomomola #38" vs "#39" on one tcg-id)', async () => {
    const { db, yielded } = await run([
      row({ id: 'a38', 'console-name': 'Pokemon Black & White', 'product-name': 'Alomomola #38', 'loose-price': '$1.06', 'tcg-id': '600' }),
      row({ id: 'a39', 'console-name': 'Pokemon Black & White', 'product-name': 'Alomomola #39', 'loose-price': '$1.12', 'tcg-id': '600' }),
      row({ id: 'a38r', 'console-name': 'Pokemon Black & White', 'product-name': 'Alomomola [Reverse Holo] #38', 'loose-price': '$1.49', 'tcg-id': '600' }),
    ], [{ id: 3, tcgplayer_product_id: 600, name: 'Alomomola', number: '39/114', category: 3, setName: 'Black and White' }])
    expect(yielded).toBe(2)
    expect(db._prices.get('3|')).toBe(1.12)
  })

  it('old cross-console STAMPS yield to the row whose console matches the product set (KFC / Oreo / Japanese vs SV 151)', async () => {
    // Pre-2026-07-30 fuzzy stamps put every "Pikachu #25" from every console onto the English
    // SV 151 Pikachu; the file's last one ("Pokemon x Oreo", $12.00) was its price instead of $0.38.
    const pika: Product = { id: 5204, tcgplayer_product_id: 517045, name: 'Pikachu - 025/165', number: '025/165',
      category: 3, setName: 'SV: Scarlet & Violet 151' }
    const lines = [
      row({ id: 'p1', 'console-name': 'Pokemon 1998 KFC', 'product-name': 'Pikachu #25', 'loose-price': '$54.00' }),
      row({ id: 'p2', 'console-name': 'Pokemon Japanese Scarlet & Violet 151', 'product-name': 'Pikachu #25', 'loose-price': '$1.76' }),
      row({ id: 'p3', 'console-name': 'Pokemon Scarlet & Violet 151', 'product-name': 'Pikachu #25', 'loose-price': '$0.38' }),
      row({ id: 'p4', 'console-name': 'Pokemon x Oreo', 'product-name': 'Pikachu #25', 'loose-price': '$12.00' }),
    ]
    const { db, yielded } = await run(lines, [pika], {}, (d) => {
      for (const id of ['p1', 'p2', 'p3', 'p4']) d._pcMap.set(id, { canonical_product_id: 5204, match_method: 'fuzzy', upc: null })
    })
    expect(yielded).toBe(3)
    expect(db._prices.get('5204|')).toBe(0.38)
  })

  it('a lone row, and rows on different products, are untouched; rows that TIE still write (last wins, as before)', async () => {
    const { db, yielded } = await run([
      plain,
      row({ id: 'm1', 'console-name': 'Pokemon Ancient Origins', 'product-name': 'Magikarp #19', 'loose-price': '$1.90', 'tcg-id': '101440' }),
      row({ id: 't1', 'console-name': 'Pokemon Ancient Origins', 'product-name': 'Gyarados [Burger King] #20', 'loose-price': '$9.00', 'tcg-id': '101441' }),
      row({ id: 't2', 'console-name': 'Pokemon Ancient Origins', 'product-name': 'Gyarados [Reverse Holo] #20', 'loose-price': '$5.36', 'tcg-id': '101441' }),
    ], [
      FLAREON,
      { id: 16635, tcgplayer_product_id: 101440, name: 'Magikarp', number: '19/98', category: 3, setName: 'XY - Ancient Origins' },
      { id: 16636, tcgplayer_product_id: 101441, name: 'Gyarados', number: '20/98', category: 3, setName: 'XY - Ancient Origins' },
    ])
    expect(yielded).toBe(0)
    expect(db._prices.get('16632|')).toBe(1.43)
    expect(db._prices.get('16635|')).toBe(1.9)
    expect(db._prices.get('16636|')).toBe(5.36)   // a 2-word tie → the file's last row, unchanged behaviour
  })
})

describe('twinRank (pure)', () => {
  const prod = { number: '13/98', setName: 'XY - Ancient Origins' }
  const r = (name: string, console_ = 'Pokemon Ancient Origins') => ({ 'product-name': name, 'console-name': console_ })
  it('counts bracket-tag words; untagged is 0', () => {
    expect(twinRank(r('Flareon #13'), prod)).toBe(0)
    expect(twinRank(r('Flareon [Holo] #13'), prod)).toBe(1)
    expect(twinRank(r('Flareon [Reverse Holo] #13'), prod)).toBe(2)
    expect(twinRank(r('Flareon [Prize Pack Cosmos Holo] #13'), prod)).toBe(4)
  })
  it('a disagreeing #number outweighs any tags; a missing number on either side never counts against', () => {
    expect(twinRank(r('Flareon #14'), prod)).toBe(1000)
    expect(twinRank(r('Flareon [Reverse Holo] #013'), prod)).toBe(2)   // leading zeros normalised
    expect(twinRank(r('Flareon'), prod)).toBe(0)
    expect(twinRank(r('Flareon #14'), { number: null, setName: prod.setName })).toBe(0)
  })
  it('console gates: an uncorroborated set (+2000) and a disagreeing language (+4000), skipped without a set name', () => {
    expect(twinRank(r('Flareon #13', 'Pokemon Burger King'), prod)).toBe(2000)
    expect(twinRank(r('Flareon #13', 'Pokemon Japanese Ancient Origins'), prod)).toBe(4000)
    expect(twinRank(r('Flareon #13', 'Pokemon Japanese Promo'), prod)).toBe(6000)
    expect(twinRank(r('Flareon #13', 'Pokemon Burger King'), { number: '13/98', setName: null })).toBe(0)
    expect(twinRank(r('Flareon #13'), undefined)).toBe(0)
  })
})

// ── UPC capture (mig 0127 — sealed barcode lookup, Phase 1) ─────────────────────
describe('UPC capture on the map upsert', () => {
  it('captures a normalized UPC for matched AND unmatched rows (cards + sealed)', async () => {
    const r2 = makeR2(); const key = rawKeyFor('pokemon-cards', today())
    r2._store.set(key, [
      HEADER,
      // Sealed, tcg-id hit, hyphenated UPC → digits-only stored.
      row({ id: 'pcU1', 'console-name': 'Pokemon', 'product-name': 'Booster Box',
            'loose-price': '$120.00', upc: ' 0742818-061452 ', genre: 'Sealed Product', 'tcg-id': '55555' }),
      // Unmatched card row with a UPC — captured anyway (the map records unmatched rows too).
      row({ id: 'pcU2', 'console-name': 'Pokemon X', 'product-name': 'Mewtwo #10',
            'loose-price': '$5.00', upc: '196214132474', genre: 'Pokemon X', 'tcg-id': '' }),
    ].join('\n'))
    const db = makeFakeDb(PRODUCTS)
    await processPriceChartingWindow({ DB: db, IMAGES_BUCKET: r2 } as any, procMsg(key))
    expect(db._pcMap.get('pcU1')).toEqual({ canonical_product_id: 20, match_method: 'tcg-id', upc: '0742818061452' })
    expect(db._pcMap.get('pcU2')).toEqual({ canonical_product_id: null, match_method: null, upc: '196214132474' })
  })

  it('a pre-stamped (incremental) row still GAINS its UPC on re-ingest, and a later blank never erases it', async () => {
    const r2 = makeR2(); const key = rawKeyFor('pokemon-cards', today())
    const csvWithUpc = [
      HEADER,
      row({ id: 'pcMINT', 'console-name': 'Pokemon Chinese Gem Pack', 'product-name': 'Gengar #307',
            'loose-price': '$12.00', upc: '196214141469', genre: 'Pokemon Card', 'tcg-id': '' }),
    ].join('\n')
    r2._store.set(key, csvWithUpc)
    const db = makeFakeDb([])
    // Stamped by the mint job BEFORE UPCs existed — the matcher-skip path must still write upc.
    db._pcMap.set('pcMINT', { canonical_product_id: 500, match_method: 'minted', upc: null })
    await processPriceChartingWindow({ DB: db, IMAGES_BUCKET: r2 } as any, procMsg(key))
    expect(db._pcMap.get('pcMINT')).toEqual({ canonical_product_id: 500, match_method: 'minted', upc: '196214141469' })

    // Re-ingest WITHOUT the upc column populated — COALESCE preserves the stored value.
    r2._store.set(key, [
      HEADER,
      row({ id: 'pcMINT', 'console-name': 'Pokemon Chinese Gem Pack', 'product-name': 'Gengar #307',
            'loose-price': '$12.00', genre: 'Pokemon Card', 'tcg-id': '' }),
    ].join('\n'))
    await processPriceChartingWindow({ DB: db, IMAGES_BUCKET: r2 } as any, procMsg(key))
    expect(db._pcMap.get('pcMINT')?.upc).toBe('196214141469')
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
