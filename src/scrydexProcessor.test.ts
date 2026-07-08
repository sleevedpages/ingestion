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
  MAX_DRAIN_ATTEMPTS,
  PROCESSING_STALE_SECONDS,
  ERROR_RETRY_BASE_SECONDS,
  errorRetryBackoffSeconds,
  isErrorRetryDue,
  isProcessingStale,
  refreshCardPrices,
  type UnmatchedCardEntry,
} from './scrydexProcessor.js'
import { GAME_SLUG_BY_CANONICAL_NAME } from './lib/gameNames.js'

// ─────────────────────────────────────────────────────────────────────────────
// Minimal fake D1 — records run()/batch() and routes first()/all() via callbacks.
// No real SQLite; these tests assert the worker issues the right SQL/binds and
// follows the right control flow. SQL semantics (FK resolution, ON CONFLICT merge,
// the unique freshness PK) are validated on UAT — see the deployment checklist.
// ─────────────────────────────────────────────────────────────────────────────
interface FakeOpts {
  first?: (sql: string, args: unknown[]) => unknown
  all?:   (sql: string, args: unknown[]) => unknown[]
  // Per-statement meta.changes for batched UPDATEs (the WP-8 claim protocol reads it);
  // default 1 = every claim wins. Return 0 to simulate losing a claim race.
  batchChanges?: (sql: string, args: unknown[]) => number
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
    async batch(stmts: FakeStmt[]) {
      batches.push(stmts)
      return stmts.map(s => ({ meta: { changes: opts.batchChanges ? opts.batchChanges(s.sql, s.args) : 1 } }))
    },
    _runs: runs,
    _batches: batches,
  }
  return db
}

// Every batched statement across the run, flattened (claims + price upserts + unmatched + releases).
function batchedStmts(db: ReturnType<typeof makeFakeDB>): FakeStmt[] {
  return db._batches.flat()
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
const pendingRow = { id: 1, event_name: 'pokemon.prices.raw', expansion_ids_json: '["exp1"]', status: 'pending', attempts: 0 }
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

    // Canonical price upsert was batched, and freshness recorded. (Batches now also
    // carry the WP-8 claim statements — filter to the price writes.)
    expect(batchedStmts(db).filter(s => s.sql.includes('INSERT INTO prices'))).toHaveLength(1)
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
// WP-8 — retry semantics: pure spec helpers (mirrored by the candidate SQL).
// ─────────────────────────────────────────────────────────────────────────────
const okCard = {
  number: '25',
  variants: [{
    name: 'normal',
    marketplaces: [{ name: 'tcgplayer', product_id: '999' }],
    prices: [{ type: 'raw', condition: 'NM', market: 1.5, trends: {} }],
  }],
}
const okFetch = () => vi.fn(async () =>
  new Response(JSON.stringify({ data: [okCard] }), { status: 200, headers: { 'content-type': 'application/json' } }))

describe('WP-8 retry spec helpers', () => {
  it('error-retry backoff doubles per attempt from the 2h base', () => {
    expect(ERROR_RETRY_BASE_SECONDS).toBe(2 * 3600)
    expect(errorRetryBackoffSeconds(0)).toBe(2 * 3600)
    expect(errorRetryBackoffSeconds(1)).toBe(4 * 3600)
    expect(errorRetryBackoffSeconds(2)).toBe(8 * 3600)
    expect(errorRetryBackoffSeconds(4)).toBe(32 * 3600)
  })

  it('isErrorRetryDue honours the backoff window and the attempt cap', () => {
    const now = 1_000_000
    // attempts=1 → due after 4h.
    expect(isErrorRetryDue(1, now - 4 * 3600, now)).toBe(true)
    expect(isErrorRetryDue(1, now - 4 * 3600 + 1, now)).toBe(false)
    // at/over MAX attempts → never due, regardless of age (terminal cap).
    expect(isErrorRetryDue(MAX_DRAIN_ATTEMPTS, 0, now)).toBe(false)
    expect(isErrorRetryDue(MAX_DRAIN_ATTEMPTS + 3, 0, now)).toBe(false)
  })

  it('isProcessingStale flips at the 6h staleness threshold', () => {
    const now = 1_000_000
    expect(PROCESSING_STALE_SECONDS).toBe(6 * 3600)
    expect(isProcessingStale(now - PROCESSING_STALE_SECONDS, now)).toBe(true)
    expect(isProcessingStale(now - PROCESSING_STALE_SECONDS + 1, now)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// WP-8 — candidate selection + atomic claims.
// ─────────────────────────────────────────────────────────────────────────────
describe('processPendingWebhooks — WP-8 candidate selection + claims', () => {
  it('the candidate scan covers stale-processing reclaim and backoff-gated error retries', async () => {
    let selectionSql = ''
    const db = makeFakeDB({
      first: webhookFirstRouter,
      all: (sql) => {
        if (sql.includes("status = 'pending'")) { selectionSql = sql; return [] }
        return []
      },
    })
    await processPendingWebhooks({ DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any)

    // Reclaim clause: stale 'processing' claims re-enter the pool.
    expect(selectionSql).toContain("status = 'processing'")
    expect(selectionSql).toContain(`unixepoch() - ${PROCESSING_STALE_SECONDS}`)
    // Error-retry clause: capped attempts + exponential (bit-shift) backoff.
    expect(selectionSql).toContain(`attempts < ${MAX_DRAIN_ATTEMPTS}`)
    expect(selectionSql).toContain(`${ERROR_RETRY_BASE_SECONDS} << attempts`)
  })

  it('RECLAIM: a stuck processing row is claimed with a staleness-guarded UPDATE and drains to complete', async () => {
    vi.stubGlobal('fetch', okFetch())
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const stuckRow = { id: 9, event_name: 'pokemon.prices.raw', expansion_ids_json: '["exp1"]', status: 'processing', attempts: 0 }
    const db = makeFakeDB({
      first: webhookFirstRouter,
      all: (sql) => sql.includes("status = 'pending'") ? [stuckRow] : [],
    })
    await processPendingWebhooks({ DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any)

    // The claim used the reclaim shape: no status flip (it is already 'processing'),
    // and the WHERE re-checks staleness so a concurrent run cannot also take it.
    const claim = batchedStmts(db).find(s => s.sql.includes('last_attempt_at = unixepoch()') && s.args.includes(9))
    expect(claim).toBeDefined()
    expect(claim!.sql).toContain(`unixepoch() - ${PROCESSING_STALE_SECONDS}`)

    // The stranded row drained to complete.
    const completes = db._runs.filter(r => /status\s*=\s*'complete'/.test(r.sql) && r.args.includes(9))
    expect(completes).toHaveLength(1)
    const audit = findAuditLine(logSpy)
    expect(audit.rows_reclaimed_processing).toBe(1)
  })

  it('DOUBLE-DRAIN GUARD: a row whose claim is lost (changes=0) is not processed at all', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const db = makeFakeDB({
      first: webhookFirstRouter,
      all: pendingAll,
      // Another overlapping run already owns every row.
      batchChanges: (sql) => sql.includes('scrydex_webhook_log') ? 0 : 1,
    })
    await processPendingWebhooks({ DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any)

    expect(fetchMock).not.toHaveBeenCalled()                                        // no credit spend
    expect(db._runs.filter(r => r.sql.includes('scrydex_webhook_log'))).toHaveLength(0) // no status writes
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// WP-8 — error retry, terminal state, guard-stops-retry, idempotent re-drain.
// ─────────────────────────────────────────────────────────────────────────────
describe('processPendingWebhooks — WP-8 retry outcomes', () => {
  const errorRow = (attempts: number) =>
    ({ id: 5, event_name: 'pokemon.prices.raw', expansion_ids_json: '["exp1"]', status: 'error', attempts })

  it('BACKOFF RETRY: an error row is claimed (status → processing) and completes on success', async () => {
    vi.stubGlobal('fetch', okFetch())
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const db = makeFakeDB({
      first: webhookFirstRouter,
      all: (sql) => sql.includes("status = 'pending'") ? [errorRow(2)] : [],
    })
    await processPendingWebhooks({ DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any)

    const claim = batchedStmts(db).find(s => s.sql.includes("status = 'error'") && s.args.includes(5))
    expect(claim).toBeDefined()
    expect(claim!.sql).toContain("SET status = 'processing'")
    expect(db._runs.filter(r => /status\s*=\s*'complete'/.test(r.sql) && r.args.includes(5))).toHaveLength(1)
    expect(findAuditLine(logSpy).rows_retried_error).toBe(1)
  })

  it('TERMINAL STATE: a row-specific failure at the attempt cap goes to failed, never error', async () => {
    // Transient 500 on the expansion fetch — a row-specific failure that burns an attempt.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const db = makeFakeDB({
      first: webhookFirstRouter,
      all: (sql) => sql.includes("status = 'pending'") ? [errorRow(MAX_DRAIN_ATTEMPTS - 1)] : [],
    })
    await processPendingWebhooks({ DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any)
    errSpy.mockRestore()

    // The failure write burns an attempt and carries the terminal CASE.
    const failure = db._runs.find(r => r.sql.includes('attempts = attempts + 1') && r.args.includes(5))
    expect(failure).toBeDefined()
    expect(failure!.sql).toContain(`CASE WHEN attempts + 1 >= ${MAX_DRAIN_ATTEMPTS} THEN 'failed' ELSE 'error' END`)
    expect(findAuditLine(logSpy).rows_failed_terminal).toBe(1)
  })

  it('TERMINAL STATE: unparseable expansion_ids_json goes straight to failed (deterministic poison)', async () => {
    const badRow = { id: 3, event_name: 'pokemon.prices.raw', expansion_ids_json: 'not json', status: 'pending', attempts: 0 }
    const db = makeFakeDB({
      first: webhookFirstRouter,
      all: (sql) => sql.includes("status = 'pending'") ? [badRow] : [],
    })
    await processPendingWebhooks({ DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any)

    const failed = db._runs.find(r => /status\s*=\s*'failed'/.test(r.sql) && r.args.includes(3))
    expect(failed).toBeDefined()
    expect(db._runs.some(r => /status\s*=\s*'error'/.test(r.sql))).toBe(false)
  })

  it('GUARD STOPS RETRY: a credit-guard trip on a retried row spends nothing further and burns no attempt', async () => {
    // The guard reads monthly usage BEFORE any API call — an exhausted budget throws
    // ScrydexCreditLimitError without fetching. The retried row must stay retryable
    // ('error', attempts unchanged) so it drains once credits return.
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = makeFakeDB({
      first: (sql) => sql.includes('SUM(credits_used)') ? { total: 999_999 } : webhookFirstRouter(sql),
      all: (sql) => sql.includes("status = 'pending'") ? [errorRow(2)] : [],
    })
    await processPendingWebhooks({ DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any)
    warnSpy.mockRestore()

    expect(fetchMock).not.toHaveBeenCalled()   // the guard blocked the call itself
    const errorWrite = db._runs.find(r => /status\s*=\s*'error'/.test(r.sql) && r.args.includes(5))
    expect(errorWrite).toBeDefined()
    expect(errorWrite!.sql).not.toContain('attempts = attempts + 1')  // no attempt burned
    expect(db._runs.some(r => /status\s*=\s*'failed'/.test(r.sql))).toBe(false)
  })

  it('IDEMPOTENT RE-DRAIN: a retried row whose expansion is already fresh completes with ZERO fetches', async () => {
    // The SCRYDEX_PRICE_FRESHNESS_HOURS dedup is what makes re-processing safe: the
    // expansion was fetched by the earlier (failed-after-fetch or overlapping) run, so
    // the retry costs no credits and re-writes nothing.
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const db = makeFakeDB({
      first: (sql) => sql.includes('scrydex_expansion_freshness') ? { 1: 1 } : webhookFirstRouter(sql),
      all: (sql) => sql.includes("status = 'pending'") ? [errorRow(1)] : [],
    })
    await processPendingWebhooks({ DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(batchedStmts(db).filter(s => s.sql.includes('INSERT INTO prices'))).toHaveLength(0)
    expect(db._runs.filter(r => /status\s*=\s*'complete'/.test(r.sql) && r.args.includes(5))).toHaveLength(1)
  })

  it('RELEASE: rows claimed but unreached (maxFetches cut) go back to pending, not stranded processing', async () => {
    vi.stubGlobal('fetch', okFetch())
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Two rows for two DISTINCT expansions; maxFetches=1 stops after the first.
    const rows = [
      { id: 1, event_name: 'pokemon.prices.raw', expansion_ids_json: '["exp1"]', status: 'pending', attempts: 0 },
      { id: 2, event_name: 'pokemon.prices.raw', expansion_ids_json: '["exp2"]', status: 'pending', attempts: 0 },
    ]
    const db = makeFakeDB({
      first: webhookFirstRouter,
      all: (sql) => sql.includes("status = 'pending'") ? rows : [],
    })
    await processPendingWebhooks({
      DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't', SCRYDEX_DRAIN_MAX_FETCHES: '1',
    } as any)
    warnSpy.mockRestore()

    // Row 1 completed; row 2 was claimed then released back to pending (guarded on the claim).
    expect(db._runs.filter(r => /status\s*=\s*'complete'/.test(r.sql) && r.args.includes(1))).toHaveLength(1)
    const release = batchedStmts(db).find(s => s.sql.includes("SET status = 'pending'") && s.args.includes(2))
    expect(release).toBeDefined()
    expect(release!.sql).toContain("AND status = 'processing'")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// WP-8 — unknown-card logging (audit ING-3): no more silent drops.
// ─────────────────────────────────────────────────────────────────────────────
describe('processPendingWebhooks — unknown-card logging', () => {
  it('records an unmatched webhook card to scrydex_unmatched_cards and counts it in the audit line', async () => {
    const unknownCard = {
      id: 'XX01-999', name: 'Mystery Promo', number: '999',
      variants: [{
        name: 'normal',
        marketplaces: [{ name: 'tcgplayer', product_id: '424242' }],
        prices: [{ type: 'raw', condition: 'NM', market: 3, trends: {} }],
      }],
    }
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ data: [unknownCard] }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    // No product resolves (neither R1 nor R2) → the card is unknown to the catalogue.
    const db = makeFakeDB({
      first: (sql) => sql.includes('FROM products') ? null : webhookFirstRouter(sql),
      all: pendingAll,
    })
    await processPendingWebhooks({ DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any)

    const unmatchedWrites = batchedStmts(db).filter(s => s.sql.includes('scrydex_unmatched_cards'))
    expect(unmatchedWrites).toHaveLength(1)
    // (scrydex_card_id, name, number, game_slug, expansion_id, tcgplayer_product_id, variant)
    expect(unmatchedWrites[0].args).toEqual(['XX01-999', 'Mystery Promo', '999', 'pokemon', 'exp1', '424242', 'normal'])
    // Deduped upsert — a daily re-encounter bumps the counter instead of duplicating.
    expect(unmatchedWrites[0].sql).toContain('ON CONFLICT')
    expect(unmatchedWrites[0].sql).toContain('seen_count           = seen_count + 1')

    // The row still completes (0 prices) and the audit line counts the unmatched card.
    expect(db._runs.filter(r => /status\s*=\s*'complete'/.test(r.sql) && r.args.includes(1))).toHaveLength(1)
    expect(findAuditLine(logSpy).unmatched_cards).toBe(1)
  })

  it('buildPriceUpserts pushes unresolved variants onto the collector without changing its return', async () => {
    const db = makeFakeDB({ first: () => null })
    const collector: UnmatchedCardEntry[] = []
    const card = {
      id: 'OP99-001', name: 'Ghost Leader', number: 'OP99-001',
      variants: [
        { name: 'normal', marketplaces: [{ name: 'tcgplayer', product_id: '111' }], prices: [{ type: 'raw', condition: 'NM', market: 1 }] },
        { name: 'altArt', marketplaces: [], prices: [{ type: 'raw', condition: 'NM', market: 2 }] },
      ],
    }
    const upserts = await buildPriceUpserts(db as any, card, 'OP99', 'raw', collector)
    expect(upserts).toHaveLength(0)
    expect(collector).toEqual([
      { scrydexCardId: 'OP99-001', cardName: 'Ghost Leader', cardNumber: 'OP99-001', variantName: 'normal', tcgplayerProductId: '111' },
      { scrydexCardId: 'OP99-001', cardName: 'Ghost Leader', cardNumber: 'OP99-001', variantName: 'altArt', tcgplayerProductId: null },
    ])
  })

  it('omitting the collector keeps the legacy silent-skip shape for sync-set/refresh callers', async () => {
    const db = makeFakeDB({ first: () => null })
    const card = { number: '25', variants: [{ name: 'normal', marketplaces: [], prices: [{ type: 'raw', condition: 'NM', market: 1 }] }] }
    await expect(buildPriceUpserts(db as any, card, 'exp1', 'raw')).resolves.toEqual([])
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

// ─────────────────────────────────────────────────────────────────────────────
// WP-3 (audit IMG-5) pricing-path fix — the vendor single-card refresh once used a
// derived GAME_NAME_TO_SLUG whose 'Lorcana'/'Riftbound' keys matched NO canonical_games.name,
// so refreshCardPrices returned "unsupported game" for both. It now resolves through the
// shared lib/gameNames.ts map keyed by the EXACT canonical names.
// ─────────────────────────────────────────────────────────────────────────────
function refreshFirstRouter(game: string) {
  return (sql: string) => {
    // The refresh product lookup (JOINs canonical_games) → the target card row.
    if (sql.includes('canonical_games')) {
      return { id: 42, tcgplayer_product_id: 999, number: '25', expansion_id: 'exp1', game }
    }
    if (sql.includes('SUM(credits_used)')) return { total: 0 }          // credit guard: unused
    if (sql.includes('FROM products WHERE tcgplayer_product_id')) return { id: 42 }
    return null
  }
}
const refreshCardResp = () => new Response(
  JSON.stringify({ data: [okCard] }),
  { status: 200, headers: { 'content-type': 'application/json' } },
)

describe('refreshCardPrices — WP-3 pricing-path slug resolution', () => {
  it('a Lorcana TCG card resolves the correct slug end-to-end (was silently unsupported)', async () => {
    const fetchMock = vi.fn(async () => refreshCardResp())
    vi.stubGlobal('fetch', fetchMock)
    const db = makeFakeDB({ first: refreshFirstRouter('Lorcana TCG') })
    const r = await refreshCardPrices({ DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any, 42)
    expect(r.ok).toBe(true)
    expect(r.pricesUpserted).toBeGreaterThan(0)
    // The Scrydex cards endpoint carries the resolved slug — never an "unsupported game" bail-out.
    expect(String(fetchMock.mock.calls[0][0])).toContain('/lorcana/v1/cards')
  })

  it('a Riftbound card (full canonical name) resolves the correct slug end-to-end', async () => {
    const fetchMock = vi.fn(async () => refreshCardResp())
    vi.stubGlobal('fetch', fetchMock)
    const db = makeFakeDB({ first: refreshFirstRouter('Riftbound League of Legends Trading Card Game') })
    const r = await refreshCardPrices({ DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any, 42)
    expect(r.ok).toBe(true)
    expect(String(fetchMock.mock.calls[0][0])).toContain('/riftbound/v1/cards')
  })

  it('a Pokemon Japan card is unsupported and never fetches (no English-slug collision)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const db = makeFakeDB({ first: refreshFirstRouter('Pokemon Japan') })
    const r = await refreshCardPrices({ DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any, 42)
    expect(r).toEqual({ ok: false, error: 'unsupported game: Pokemon Japan' })
    expect(fetchMock).not.toHaveBeenCalled()   // JP must never collide onto the English 'pokemon' slug
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The name↔slug resolution the drain + refresh rely on, round-tripped for ALL canonical
// games (incl. the two IMG-5 fixes) — the SHARED map (lib/gameNames.test.ts stays the drift
// anchor for the exact key list; this asserts the pricing-path consumer's round-trip contract).
// ─────────────────────────────────────────────────────────────────────────────
describe('game name ↔ slug resolution (WP-3) — round-trip, no collision', () => {
  it('every canonical game name resolves to a slug that reverses to exactly one name', () => {
    const slugToName = new Map<string, string>()
    for (const [name, slug] of Object.entries(GAME_SLUG_BY_CANONICAL_NAME)) {
      expect(slug).toBeTruthy()
      // No two distinct canonical names may collapse to one slug — that would make the
      // reverse ambiguous and could mis-route a card (e.g. a JP card onto English pokemon).
      expect(slugToName.has(slug)).toBe(false)
      slugToName.set(slug, name)
    }
    // The two IMG-5 fixes are present with the correct slugs.
    expect(GAME_SLUG_BY_CANONICAL_NAME['Lorcana TCG']).toBe('lorcana')
    expect(GAME_SLUG_BY_CANONICAL_NAME['Riftbound League of Legends Trading Card Game']).toBe('riftbound')
  })

  it('Pokemon Japan does not resolve, and the pokemon slug reverses ONLY to English Pokemon', () => {
    expect(GAME_SLUG_BY_CANONICAL_NAME['Pokemon Japan']).toBeUndefined()
    const pokemonNames = Object.entries(GAME_SLUG_BY_CANONICAL_NAME)
      .filter(([, slug]) => slug === 'pokemon')
      .map(([name]) => name)
    expect(pokemonNames).toEqual(['Pokemon'])
  })
})
