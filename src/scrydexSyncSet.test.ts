import { describe, it, expect, vi, afterEach } from 'vitest'
import { syncSingleSet } from './scrydexSyncSet.js'

// ─────────────────────────────────────────────────────────────────────────────
// Minimal fake D1 (same shape as scrydexProcessor.test.ts) — records run()/batch()
// and routes first()/all() via callbacks. SQL semantics are validated on UAT.
// ─────────────────────────────────────────────────────────────────────────────
interface FakeOpts {
  first?: (sql: string, args: unknown[]) => unknown
  all?:   (sql: string, args: unknown[]) => unknown[]
}
interface FakeStmt { sql: string; args: unknown[]; bind: (...a: unknown[]) => FakeStmt; first: () => Promise<unknown>; all: () => Promise<{ results: unknown[] }>; run: () => Promise<{ meta: { last_row_id: number } }> }

function makeFakeDB(opts: FakeOpts = {}) {
  const runs: { sql: string; args: unknown[] }[] = []
  const batches: FakeStmt[][] = []
  const db = {
    prepare(sql: string): FakeStmt {
      const stmt: FakeStmt = {
        sql,
        args: [],
        bind(...a: unknown[]) { stmt.args = a; return stmt },
        async first() { return opts.first ? opts.first(sql, stmt.args) : null },
        async all() { return { results: opts.all ? opts.all(sql, stmt.args) : [] } },
        async run() { runs.push({ sql, args: stmt.args }); return { meta: { last_row_id: 1 } } },
      }
      return stmt
    },
    async batch(stmts: FakeStmt[]) { batches.push(stmts); return stmts.map(() => ({})) },
    _runs: runs,
    _batches: batches,
  }
  return db
}

const POKEMON_SET = {
  id: 5, name: 'Surging Sparks', set_code: 'SSP',
  scrydex_expansion_id: 'sv08', tcgplayer_group_id: 1234, game: 'Pokemon',
}

// Router: a set lookup, freshness misses, and a product-id match for the price upsert.
function baseFirst(setRow: any = POKEMON_SET) {
  return (sql: string) => {
    if (sql.includes('FROM   sets s') && sql.includes('JOIN   canonical_games g')) return setRow
    if (sql.includes('scrydex_expansion_freshness')) return null    // not fresh
    if (sql.includes('SUM(credits_used)')) return { total: 0 }       // credit guard: unused
    if (sql.includes('FROM products WHERE tcgplayer_product_id')) return { id: 42 }
    return null
  }
}

const POKE_CARD = {
  number: '25',
  images: [{ type: 'front', large: 'https://img/25.png' }],
  variants: [{
    name: 'normal',
    marketplaces: [{ name: 'tcgplayer', product_id: '999' }],
    prices: [{ type: 'raw', condition: 'NM', market: 1.5, trends: {} }],
  }],
}

function okFetch(cards: any[]) {
  return vi.fn(async () =>
    new Response(JSON.stringify({ data: cards, totalCount: cards.length }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('syncSingleSet — happy path', () => {
  it('fetches one expansion, writes canonical prices + images, and marks the expansion fresh', async () => {
    const fetchMock = okFetch([POKE_CARD])
    vi.stubGlobal('fetch', fetchMock)

    const db = makeFakeDB({ first: baseFirst() })
    const res = await syncSingleSet(
      { DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any,
      { scrydexExpansionId: 'sv08' },
    )

    expect(res.ok).toBe(true)
    expect(res.skipped).toBeFalsy()
    expect(res.setName).toBe('Surging Sparks')
    expect(res.cardsFetched).toBe(1)
    expect(res.pricesUpserted).toBe(1)   // one raw price for the normal variant
    expect(res.imagesUpdated).toBe(1)    // card-level image (group+number)
    expect(res.requests).toBe(1)

    // Exactly one freshness write per price type (raw + graded) → 2 rows.
    const freshWrites = db._runs.filter(r => r.sql.includes('INSERT INTO scrydex_expansion_freshness'))
    expect(freshWrites).toHaveLength(2)
    expect(new Set(freshWrites.map(r => r.args[1]))).toEqual(new Set(['raw', 'graded']))

    // Only ONE Scrydex page-call for the single expansion.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('syncSingleSet — resolution + freshness', () => {
  it('returns an error when the set is not found', async () => {
    vi.stubGlobal('fetch', okFetch([]))
    const db = makeFakeDB({ first: () => null })
    const res = await syncSingleSet({ DB: db } as any, { scrydexExpansionId: 'nope' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not found/i)
  })

  it('skips (no API call) when both price types are already fresh and not forced', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const db = makeFakeDB({
      first: (sql) => {
        if (sql.includes('FROM   sets s')) return POKEMON_SET
        if (sql.includes('scrydex_expansion_freshness')) return { 1: 1 }   // fresh
        return null
      },
    })
    const res = await syncSingleSet({ DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any, { scrydexExpansionId: 'sv08' })
    expect(res.ok).toBe(true)
    expect(res.skipped).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('force=true bypasses the freshness skip and fetches anyway', async () => {
    const fetchMock = okFetch([POKE_CARD])
    vi.stubGlobal('fetch', fetchMock)
    const db = makeFakeDB({
      first: (sql) => {
        if (sql.includes('FROM   sets s')) return POKEMON_SET
        if (sql.includes('scrydex_expansion_freshness')) return { 1: 1 }   // fresh
        if (sql.includes('FROM products WHERE tcgplayer_product_id')) return { id: 42 }
        return null
      },
    })
    const res = await syncSingleSet({ DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any, { scrydexExpansionId: 'sv08', force: true })
    expect(res.ok).toBe(true)
    expect(res.skipped).toBeFalsy()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('syncSingleSet — credit guard short-circuit', () => {
  it('returns ok:false without an API call when the monthly credit guard trips', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    // Guard threshold = limit - 500; report usage above it.
    const db = makeFakeDB({
      first: (sql) => {
        if (sql.includes('FROM   sets s')) return POKEMON_SET
        if (sql.includes('scrydex_expansion_freshness')) return null
        if (sql.includes('SUM(credits_used)')) return { total: 99999 }
        return null
      },
    })
    const res = await syncSingleSet(
      { DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't', SCRYDEX_MONTHLY_LIMIT: '5000' } as any,
      { scrydexExpansionId: 'sv08' },
    )
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/credit guard/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
