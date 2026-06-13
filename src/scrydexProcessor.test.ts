import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  deriveCanonicalPriceFields,
  extractTrends,
  buildPriceUpserts,
  processPendingWebhooks,
  ScrydexFetchError,
  freshnessSafeForDrain,
  DRAIN_INTERVAL_HOURS,
  DEFAULT_FRESHNESS_HOURS,
} from './scrydexProcessor.js'

// ─────────────────────────────────────────────────────────────────────────────
// Minimal fake D1 — records run()/batch() and routes first()/all() via callbacks.
// No real SQLite; these tests assert the worker issues the right SQL/binds and
// follows the right control flow. SQL semantics (FK resolution, ON CONFLICT merge,
// the unique freshness PK) are validated on UAT — see the deployment checklist.
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

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ─────────────────────────────────────────────────────────────────────────────
// deriveCanonicalPriceFields — must match what migration 0060 produced.
// ─────────────────────────────────────────────────────────────────────────────
describe('deriveCanonicalPriceFields', () => {
  it('raw normal → tier condition, normal finish, no grade', () => {
    expect(deriveCanonicalPriceFields('NM', 'normal', 'raw'))
      .toEqual({ condition: 'NM', finish: 'normal', grade: null })
  })

  it('raw foil variant → tier condition + foil finish', () => {
    expect(deriveCanonicalPriceFields('NM', 'foil', 'raw'))
      .toEqual({ condition: 'NM', finish: 'foil', grade: null })
  })

  it('raw altArt variant → tier condition + altArt finish', () => {
    expect(deriveCanonicalPriceFields('LP', 'altArt', 'raw'))
      .toEqual({ condition: 'LP', finish: 'altArt', grade: null })
  })

  it('graded → null condition, grade = the price condition string', () => {
    expect(deriveCanonicalPriceFields('PSA 10', 'normal', 'graded'))
      .toEqual({ condition: null, finish: 'normal', grade: 'PSA 10' })
  })

  it('graded foil → grade carried, foil finish preserved', () => {
    expect(deriveCanonicalPriceFields('BGS 9.5', 'foil', 'graded'))
      .toEqual({ condition: null, finish: 'foil', grade: 'BGS 9.5' })
  })

  it('missing/undefined variant name defaults finish to normal', () => {
    expect(deriveCanonicalPriceFields('NM', undefined, 'raw'))
      .toEqual({ condition: 'NM', finish: 'normal', grade: null })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// extractTrends — pulls days_{1,7,14,30,90}.percent_change.
// ─────────────────────────────────────────────────────────────────────────────
describe('extractTrends', () => {
  it('extracts all five trend windows', () => {
    const trends = {
      days_1:  { percent_change: 1.1 },
      days_7:  { percent_change: -2.2 },
      days_14: { percent_change: 3.3 },
      days_30: { percent_change: -4.4 },
      days_90: { percent_change: 5.5 },
    }
    expect(extractTrends(trends)).toEqual({
      trend_1d: 1.1, trend_7d: -2.2, trend_14d: 3.3, trend_30d: -4.4, trend_90d: 5.5,
    })
  })

  it('returns nulls for missing windows / null input', () => {
    expect(extractTrends(null)).toEqual({
      trend_1d: null, trend_7d: null, trend_14d: null, trend_30d: null, trend_90d: null,
    })
    expect(extractTrends({ days_7: { percent_change: 9 } })).toEqual({
      trend_1d: null, trend_7d: 9, trend_14d: null, trend_30d: null, trend_90d: null,
    })
  })

  it('ignores non-numeric percent_change', () => {
    expect(extractTrends({ days_1: { percent_change: undefined } }).trend_1d).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// buildPriceUpserts — id resolution (R1 primary, R2 fallback) + canonical binds.
// ─────────────────────────────────────────────────────────────────────────────
describe('buildPriceUpserts', () => {
  const rawCard = {
    number: '25',
    variants: [{
      name: 'normal',
      marketplaces: [{ name: 'tcgplayer', product_id: '999' }],
      prices: [{ type: 'raw', condition: 'NM', market: 1.5, trends: { days_1: { percent_change: 2 } } }],
    }],
  }

  it('resolves the canonical product via tcgplayer_product_id (R1) and binds canonical fields', async () => {
    const db = makeFakeDB({
      first: (sql) => sql.includes('FROM products WHERE tcgplayer_product_id') ? { id: 42 } : null,
    })
    const upserts = await buildPriceUpserts(db as any, rawCard, 'exp1', 'raw') as unknown as FakeStmt[]
    expect(upserts).toHaveLength(1)
    // product_id, condition, finish, grade, value, trend_1d, 7d, 14d, 30d, 90d
    expect(upserts[0].args).toEqual([42, 'NM', 'normal', null, 1.5, 2, null, null, null, null])
    expect(upserts[0].sql).toContain("'scrydex'")
    expect(upserts[0].sql).toContain('ON CONFLICT')
  })

  it('falls back to number + scrydex_expansion_id (R2) when the product_id does not resolve', async () => {
    const db = makeFakeDB({
      first: (sql) =>
        sql.includes('FROM products WHERE tcgplayer_product_id') ? null      // R1 miss
        : sql.includes('JOIN   sets s ON p.set_id = s.id')        ? { id: 7 } // R2 hit
        : null,
    })
    const upserts = await buildPriceUpserts(db as any, rawCard, 'exp1', 'raw') as unknown as FakeStmt[]
    expect(upserts).toHaveLength(1)
    expect(upserts[0].args[0]).toBe(7)
  })

  it('skips a variant when no product resolves at all', async () => {
    const db = makeFakeDB({ first: () => null })
    const upserts = await buildPriceUpserts(db as any, rawCard, 'exp1', 'raw') as unknown as FakeStmt[]
    expect(upserts).toHaveLength(0)
  })

  it('only emits upserts for the requested price type', async () => {
    const db = makeFakeDB({ first: () => ({ id: 1 }) })
    const upserts = await buildPriceUpserts(db as any, rawCard, 'exp1', 'graded') as unknown as FakeStmt[]
    expect(upserts).toHaveLength(0)  // the only price is type 'raw'
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// processPendingWebhooks — 403 circuit breaker + freshness write.
// ─────────────────────────────────────────────────────────────────────────────
function webhookFirstRouter(sql: string) {
  if (sql.includes('scrydex_expansion_freshness')) return null       // not fresh
  if (sql.includes('SUM(credits_used)')) return { total: 0 }          // credit guard: unused
  if (sql.includes('FROM products WHERE tcgplayer_product_id')) return { id: 42 }
  return null
}
const pendingRow = { id: 1, event_name: 'pokemon.prices.raw', expansion_ids_json: '["exp1"]' }
const pendingAll = (sql: string) => sql.includes("status = 'pending'") ? [pendingRow] : []

describe('processPendingWebhooks — 403 masking fix', () => {
  it('marks the webhook ERROR (not complete) and breaks on a 403 CREDIT_CAP_HIT', async () => {
    const fetchMock = vi.fn(async () => new Response('{"code":"CREDIT_CAP_HIT"}', { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)

    const db = makeFakeDB({ first: webhookFirstRouter, all: pendingAll })
    await processPendingWebhooks({ DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any)

    // Circuit breaker: exactly one Scrydex call, then stop.
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const webhookUpdates = db._runs.filter(r => r.sql.includes('scrydex_webhook_log'))
    const errored  = webhookUpdates.some(r => /status\s*=\s*'error'/.test(r.sql) && r.args.includes(1))
    const completed = webhookUpdates.some(r => /status\s*=\s*'complete'/.test(r.sql))
    expect(errored).toBe(true)
    expect(completed).toBe(false)

    // No freshness row written on a failed fetch.
    expect(db._runs.some(r => r.sql.includes('INSERT INTO scrydex_expansion_freshness'))).toBe(false)
  })

  it('marks the webhook COMPLETE and records freshness on a successful fetch', async () => {
    const card = {
      number: '25',
      variants: [{
        name: 'normal',
        marketplaces: [{ name: 'tcgplayer', product_id: '999' }],
        prices: [{ type: 'raw', condition: 'NM', market: 1.5, trends: { days_1: { percent_change: 2 } } }],
      }],
    }
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [card] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const db = makeFakeDB({ first: webhookFirstRouter, all: pendingAll })
    await processPendingWebhooks({ DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any)

    const webhookUpdates = db._runs.filter(r => r.sql.includes('scrydex_webhook_log'))
    expect(webhookUpdates.some(r => /status\s*=\s*'complete'/.test(r.sql))).toBe(true)
    expect(webhookUpdates.some(r => /status\s*=\s*'error'/.test(r.sql))).toBe(false)

    // Canonical price upsert was batched, and freshness recorded.
    expect(db._batches.flat().length).toBe(1)
    expect(db._runs.some(r => r.sql.includes('INSERT INTO scrydex_expansion_freshness'))).toBe(true)
  })

  it('skips the fetch entirely when the expansion is fresh', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const db = makeFakeDB({
      first: (sql) => sql.includes('scrydex_expansion_freshness') ? { 1: 1 } : webhookFirstRouter(sql),
      all: pendingAll,
    })
    await processPendingWebhooks({ DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(db._runs.some(r => r.sql.includes('scrydex_webhook_log') && /status\s*=\s*'complete'/.test(r.sql))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Daily drain — dedup by expansion: N pending rows for one expansion → ONE fetch,
// all rows marked complete.
// ─────────────────────────────────────────────────────────────────────────────
describe('processPendingWebhooks — daily drain dedup by expansion', () => {
  it('collapses N pending rows for one expansion into a single fetch and completes all', async () => {
    const card = {
      number: '25',
      variants: [{
        name: 'normal',
        marketplaces: [{ name: 'tcgplayer', product_id: '999' }],
        prices: [{ type: 'raw', condition: 'NM', market: 1.5, trends: {} }],
      }],
    }
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [card] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    // 5 distinct pending rows, all for the SAME (pokemon, raw, exp1).
    const rows = [1, 2, 3, 4, 5].map(id => ({ id, event_name: 'pokemon.prices.raw', expansion_ids_json: '["exp1"]' }))
    const db = makeFakeDB({
      first: webhookFirstRouter,
      all: (sql) => sql.includes("status = 'pending'") ? rows : [],
    })
    await processPendingWebhooks({ DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any)

    // ONE Scrydex fetch for the shared expansion (deduped), not five.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Exactly one freshness write for the expansion.
    expect(db._runs.filter(r => r.sql.includes('INSERT INTO scrydex_expansion_freshness'))).toHaveLength(1)
    // All five rows marked complete (one UPDATE per row id), none errored.
    const completes = db._runs.filter(r => /status\s*=\s*'complete'/.test(r.sql))
    expect(completes).toHaveLength(5)
    expect(new Set(completes.map(r => r.args[r.args.length - 1]))).toEqual(new Set([1, 2, 3, 4, 5]))
    expect(db._runs.some(r => /status\s*=\s*'error'/.test(r.sql))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Freshness ↔ drain-interval invariant: freshness MUST be < the 24h daily interval
// or every daily run no-ops and prices freeze.
// ─────────────────────────────────────────────────────────────────────────────
describe('freshnessSafeForDrain', () => {
  it('the production default (20h) is safe against the 24h daily drain', () => {
    expect(DRAIN_INTERVAL_HOURS).toBe(24)
    expect(DEFAULT_FRESHNESS_HOURS).toBe(20)
    expect(freshnessSafeForDrain(DEFAULT_FRESHNESS_HOURS)).toBe(true)
  })
  it('freshness ≥ the drain interval is unsafe (would silently freeze prices)', () => {
    expect(freshnessSafeForDrain(24)).toBe(false)
    expect(freshnessSafeForDrain(30)).toBe(false)
    expect(freshnessSafeForDrain(23)).toBe(true)
  })
})

describe('ScrydexFetchError', () => {
  it('carries the HTTP status', () => {
    const e = new ScrydexFetchError(403, 'boom')
    expect(e.status).toBe(403)
    expect(e.name).toBe('ScrydexFetchError')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Structured audit line (Part B, §4 #8) — one machine-parseable JSON record per run
// carrying the credit-consumption fields (rows_in, distinct_expansions, fetches_made,
// fetches_skipped_fresh, …) so a drain is measurable from logs.
// ─────────────────────────────────────────────────────────────────────────────
function findAuditLine(spy: ReturnType<typeof vi.spyOn>): any | null {
  for (const call of spy.mock.calls) {
    const arg = call[0]
    if (typeof arg !== 'string') continue
    try { const o = JSON.parse(arg); if (o?.log === 'scrydex_drain_audit') return o } catch { /* not json */ }
  }
  return null
}

describe('processPendingWebhooks — structured drain audit log', () => {
  it('emits the audit fields and quantifies the dedup collapse (5 rows / 1 expansion → 1 fetch)', async () => {
    const card = {
      number: '25',
      variants: [{
        name: 'normal',
        marketplaces: [{ name: 'tcgplayer', product_id: '999' }],
        prices: [{ type: 'raw', condition: 'NM', market: 1.5, trends: {} }],
      }],
    }
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [card] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const rows = [1, 2, 3, 4, 5].map(id => ({ id, event_name: 'pokemon.prices.raw', expansion_ids_json: '["exp1"]' }))
    const db = makeFakeDB({
      first: webhookFirstRouter,
      all: (sql) => sql.includes("status = 'pending'") ? rows : [],
    })
    await processPendingWebhooks({ DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any)

    const audit = findAuditLine(logSpy)
    expect(audit).not.toBeNull()
    expect(audit.rows_in).toBe(5)
    expect(audit.distinct_expansions).toBe(1)
    expect(audit.fetches_made).toBe(1)
    expect(audit.fetches_skipped_fresh).toBe(0)
    expect(audit.expansions_fetched).toBe(1)
    expect(audit.rows_completed).toBe(5)
    expect(audit.rows_left_pending).toBe(0)
    expect(audit.circuit_broken).toBe(false)
    // Per-game credit velocity: the single Pokémon expansion fetch = 1 credit.
    expect(audit.credits_by_game).toEqual({ pokemon: 1 })
  })

  it('reports fresh-skips with no fetch in the audit line', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const db = makeFakeDB({
      first: (sql) => sql.includes('scrydex_expansion_freshness') ? { 1: 1 } : webhookFirstRouter(sql),
      all: pendingAll,
    })
    await processPendingWebhooks({ DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any)

    const audit = findAuditLine(logSpy)
    expect(audit).not.toBeNull()
    expect(audit.distinct_expansions).toBe(1)
    expect(audit.fetches_made).toBe(0)
    expect(audit.fetches_skipped_fresh).toBe(1)
    expect(audit.expansions_fetched).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
