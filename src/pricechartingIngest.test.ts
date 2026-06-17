import { describe, it, expect, vi, afterEach } from 'vitest'
import { ingestPriceChartingCategory } from './pricechartingIngest.js'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

// ── In-memory fakes ─────────────────────────────────────────────────────────────
function makeKV() {
  const store = new Map<string, string>()
  return {
    _store: store,
    async get(k: string) { return store.has(k) ? store.get(k)! : null },
    async put(k: string, v: string) { store.set(k, String(v)) },
  }
}

interface Product { id: number; tcgplayer_product_id: number; name: string; number: string; category: number }

function makeFakeDb(products: Product[]) {
  const prices = new Map<string, number>()                       // `${productId}|${grade}` → value
  const pcMap = new Map<string, { canonical_product_id: number | null }>()

  function query(sql: string, args: any[]) {
    // The only read now: loadProductIndex's paginated product pull (scoped by category).
    // OFFSET/LIMIT are inline in the SQL; the test fixture is one page, so we return all
    // matching rows on the first call (offset 0) and an empty page on any later offset.
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
      const pcId = String(args[0]); const canonical = args[2]
      const prev = pcMap.get(pcId)
      pcMap.set(pcId, { canonical_product_id: canonical ?? prev?.canonical_product_id ?? null })
    } else if (sql.includes('INTO prices')) {
      prices.set(`${args[0]}|${args[3] ?? ''}`, args[4])
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

// TAB-separated — the real PriceCharting export format (price fields carry unquoted commas).
const COLS = [
  'id', 'console-name', 'product-name', 'loose-price', 'cib-price', 'new-price', 'graded-price',
  'box-only-price', 'manual-only-price', 'bgs-10-price', 'condition-17-price', 'condition-18-price',
  'sales-volume', 'genre', 'tcg-id',
]
const HEADER = COLS.join('\t')

// Row helper: positional values keyed to COLS, tab-joined.
function row(vals: Partial<Record<string, string>>): string {
  return COLS.map((c) => vals[c] ?? '').join('\t')
}

const PRODUCTS: Product[] = [
  { id: 7,  tcgplayer_product_id: 12345, name: 'Charizard ex', number: '125/197', category: 3 },
  { id: 8,  tcgplayer_product_id: 99999, name: 'Pikachu',      number: '58/197',  category: 3 },
  { id: 20, tcgplayer_product_id: 55555, name: 'Booster Box',  number: '',        category: 3 },
]

function buildCsv() {
  return [
    HEADER,
    // A — tcg-id primary hit (ungraded + PSA 10 + Grade 9); $2,200.00 exercises the
    //     real tab-separated format where price fields carry unquoted thousands commas.
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

const baseEnv = (db: any, kv: any) => ({ PRICECHARTING_TOKEN: 'tok', DB: db, SLEEVEDPAGES_KV: kv })

describe('ingestPriceChartingCategory', () => {
  it('throws on a missing token', async () => {
    await expect(ingestPriceChartingCategory({} as any, 'pokemon-cards'))
      .rejects.toThrow('PRICECHARTING_TOKEN')
  })

  it('matches (tcg-id + fuzzy), counts unmatched, and upserts source=pricecharting prices', async () => {
    const db = makeFakeDb(PRODUCTS); const kv = makeKV()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(csvStream(buildCsv()), { status: 200 })))

    const c = await ingestPriceChartingCategory(baseEnv(db, kv) as any, 'pokemon-cards')

    expect(c.matchedTcgId).toBe(2)     // A + D
    expect(c.matchedFuzzy).toBe(1)     // B
    expect(c.unmatched).toBe(1)        // C
    expect(c.sealedRows).toBe(1)       // D
    expect(c.sealedMatched).toBe(1)

    // A → ungraded + PSA 10 + Grade 9 (dollars). $2,200.00 (comma) parsed correctly.
    expect(db._prices.get('7|')).toBe(2200)
    expect(db._prices.get('7|PSA 10')).toBe(1450.5)
    expect(db._prices.get('7|Grade 9')).toBe(88)
    // B → ungraded only.
    expect(db._prices.get('8|')).toBe(2)
    // D (sealed) → ungraded ONLY; the graded manual-only column must NOT be written.
    expect(db._prices.get('20|')).toBe(120)
    expect(db._prices.has('20|PSA 10')).toBe(false)

    // Unmatched row C is RECORDED (counted, not dropped) with a null canonical id.
    expect(db._pcMap.get('pcC')).toEqual({ canonical_product_id: null })
    // Matched rows persisted for incremental re-ingest.
    expect(db._pcMap.get('pcA')?.canonical_product_id).toBe(7)
    expect(db._pcMap.get('pcB')?.canonical_product_id).toBe(8)
  })

  it('is idempotent — a re-run produces no duplicate price rows', async () => {
    const db = makeFakeDb(PRODUCTS); const kv = makeKV()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(csvStream(buildCsv()), { status: 200 })))

    await ingestPriceChartingCategory(baseEnv(db, kv) as any, 'pokemon-cards')
    const after1 = db._prices.size
    // Second run re-matches in-memory (cheap + deterministic) and upserts on the same
    // conflict keys → no duplicate price rows.
    const c2 = await ingestPriceChartingCategory(baseEnv(db, kv) as any, 'pokemon-cards')
    expect(db._prices.size).toBe(after1)
    expect(c2.matchedTcgId).toBe(2)   // A + D match again
    expect(c2.matchedFuzzy).toBe(1)   // B matches again
  })

  it('windows the file across runs — cursor advances, then wraps at EOF (resumable; bounds per-run time)', async () => {
    const db = makeFakeDb(PRODUCTS); const kv = makeKV()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(csvStream(buildCsv()), { status: 200 })))
    // maxRows=2 → each run processes 2 of the 4 data rows.
    const env = { ...baseEnv(db, kv), PC_INGEST_MAX_ROWS: '2' }

    const r1 = await ingestPriceChartingCategory(env as any, 'pokemon-cards')
    expect(r1.rowsProcessed).toBe(2)        // A + B
    expect(r1.wrapped).toBe(false)
    expect(r1.cursorNext).toBe(2)           // resume offset persisted
    expect(kv._store.get('pc_ingest_cursor:pokemon-cards')).toBe('2')
    expect(db._prices.get('7|')).toBe(2200) // A written
    expect(db._prices.has('20|')).toBe(false) // D not reached yet

    const r2 = await ingestPriceChartingCategory(env as any, 'pokemon-cards')
    expect(r2.windowStart).toBe(2)          // resumed where run 1 stopped
    expect(r2.rowsProcessed).toBe(2)        // C + D
    expect(r2.wrapped).toBe(true)           // reached EOF → fresh pass next time
    expect(r2.cursorNext).toBe(0)
    expect(db._prices.get('20|')).toBe(120) // D (sealed) now written
  })

  it('throws on a non-200 CSV download', async () => {
    const db = makeFakeDb(PRODUCTS); const kv = makeKV()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 429 })))
    await expect(ingestPriceChartingCategory(baseEnv(db, kv) as any, 'pokemon-cards'))
      .rejects.toThrow(/HTTP 429/)
  })
})
