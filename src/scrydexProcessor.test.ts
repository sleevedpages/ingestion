import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  deriveCanonicalPriceFields,
  extractTrends,
  buildPriceUpserts,
  processPendingWebhooks,
  ScrydexFetchError,
  freshnessSafeForDrain,
  watchFreshnessSafeForLane,
  WATCH_LANE_INTERVAL_HOURS,
  DEFAULT_WATCH_FRESHNESS_HOURS,
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
// deriveCanonicalPriceFields — POSITIVE write-time classification (the ARS-10-leak
// fix, Content mig 0099). Graded-ness comes from Scrydex's own price.type; the grade
// label is built from the live { company, grade } payload fields (price.condition is
// only the legacy fallback); unknown companies land graded BY CONSTRUCTION; a graded
// row with no resolvable label is null (skip) — never a raw fall-through.
// ─────────────────────────────────────────────────────────────────────────────
const RAW_ZERO = { company: null, is_signed: 0, is_error: 0, is_perfect: 0, is_graded: 0 }

describe('deriveCanonicalPriceFields', () => {
  it('raw normal → tier condition, normal finish, no grade, is_graded 0', () => {
    expect(deriveCanonicalPriceFields({ condition: 'NM' }, 'normal', 'raw'))
      .toEqual({ condition: 'NM', finish: 'normal', grade: null, ...RAW_ZERO })
  })

  it('raw foil variant → tier condition + foil finish', () => {
    expect(deriveCanonicalPriceFields({ condition: 'NM' }, 'foil', 'raw'))
      .toEqual({ condition: 'NM', finish: 'foil', grade: null, ...RAW_ZERO })
  })

  it('raw altArt variant → tier condition + altArt finish', () => {
    expect(deriveCanonicalPriceFields({ condition: 'LP' }, 'altArt', 'raw'))
      .toEqual({ condition: 'LP', finish: 'altArt', grade: null, ...RAW_ZERO })
  })

  it('graded (live shape: company + grade fields) → combined label + company + is_graded 1', () => {
    expect(deriveCanonicalPriceFields({ company: 'PSA', grade: '10' }, 'normal', 'graded'))
      .toEqual({ condition: null, finish: 'normal', grade: 'PSA 10', company: 'PSA', is_signed: 0, is_error: 0, is_perfect: 0, is_graded: 1 })
  })

  it('UNKNOWN grading company (ARS) lands on the graded side by construction', () => {
    expect(deriveCanonicalPriceFields({ company: 'ARS', grade: 10 }, 'holofoil', 'graded'))
      .toEqual({ condition: null, finish: 'holofoil', grade: 'ARS 10', company: 'ARS', is_signed: 0, is_error: 0, is_perfect: 0, is_graded: 1 })
  })

  it('graded sub-variant flags are captured', () => {
    expect(deriveCanonicalPriceFields({ company: 'BGS', grade: '10', is_error: true }, 'foil', 'graded'))
      .toEqual({ condition: null, finish: 'foil', grade: 'BGS 10', company: 'BGS', is_signed: 0, is_error: 1, is_perfect: 0, is_graded: 1 })
  })

  it('legacy combined condition string still resolves the graded label (fallback)', () => {
    expect(deriveCanonicalPriceFields({ condition: 'BGS 9.5' }, 'foil', 'graded'))
      .toEqual({ condition: null, finish: 'foil', grade: 'BGS 9.5', company: null, is_signed: 0, is_error: 0, is_perfect: 0, is_graded: 1 })
  })

  it('graded row with NO resolvable label → null (caller skips) — NEVER a raw fall-through', () => {
    expect(deriveCanonicalPriceFields({ market: 230 }, 'holofoil', 'graded')).toBeNull()
  })

  it('CGS legacy typo normalises to CGC in the label', () => {
    expect(deriveCanonicalPriceFields({ company: 'cgs', grade: '9' }, 'normal', 'graded'))
      .toMatchObject({ grade: 'CGC 9', company: 'CGC', is_graded: 1 })
  })

  it('missing/undefined variant name defaults finish to normal', () => {
    expect(deriveCanonicalPriceFields({ condition: 'NM' }, undefined, 'raw'))
      .toEqual({ condition: 'NM', finish: 'normal', grade: null, ...RAW_ZERO })
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
    // product_id, condition, finish, grade, company, is_signed, is_error, is_perfect, is_graded,
    // value, trend_1d, 7d, 14d, 30d, 90d
    expect(upserts[0].args).toEqual([42, 'NM', 'normal', null, null, 0, 0, 0, 0, 1.5, 2, null, null, null, null])
    expect(upserts[0].sql).toContain("'scrydex'")
    expect(upserts[0].sql).toContain('ON CONFLICT')
    expect(upserts[0].sql).toContain('is_graded')
  })

  it('graded ARS payload row → labelled graded row (is_graded 1), never an anonymous market row', async () => {
    // The ARS-10-leak reproduction: the live graded shape has NO condition string. The old
    // writer bound grade=NULL/condition=NULL here (an anonymous untiered "market" row that the
    // ungraded chain then served as the raw price). It must now bind the combined label + flag.
    const gradedCard = {
      number: '115',
      variants: [{
        name: 'holofoil',
        marketplaces: [{ name: 'tcgplayer', product_id: '655891' }],
        prices: [{ type: 'graded', company: 'ARS', grade: 10, market: 230 }],
      }],
    }
    const db = makeFakeDB({ first: () => ({ id: 154256 }) })
    const upserts = await buildPriceUpserts(db as any, gradedCard, 'm2', 'graded') as unknown as FakeStmt[]
    expect(upserts).toHaveLength(1)
    expect(upserts[0].args).toEqual([154256, null, 'holofoil', 'ARS 10', 'ARS', 0, 0, 0, 1, 230, null, null, null, null, null])
  })

  it('graded row with no resolvable label is SKIPPED — never written as raw', async () => {
    const degenerate = {
      number: '115',
      variants: [{
        name: 'holofoil',
        marketplaces: [{ name: 'tcgplayer', product_id: '655891' }],
        prices: [{ type: 'graded', market: 230 }],   // no company, no grade, no condition
      }],
    }
    const db = makeFakeDB({ first: () => ({ id: 154256 }) })
    await expect(buildPriceUpserts(db as any, degenerate, 'm2', 'graded')).resolves.toEqual([])
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

// ═════════════════════════════════════════════════════════════════════════════
// CARD WATCH PRIORITY LANE (Card Watch feature, Session 1) — the watched scope of
// processPendingWebhooks. Shares the entire drain machinery; the differences under test:
//   (1) only watched expansions are fetched (others stay pending for the daily drain);
//   (2) the dedup still collapses N rows for one watched expansion → 1 fetch;
//   (3) it uses its OWN freshness window (4h default), independent of the daily 20h;
//   (4) the credit guard / 403 circuit break still fires;
//   (5) the freshness↔lane-interval invariant guard warns when violated.
// ═════════════════════════════════════════════════════════════════════════════

// `card_watches` → products → sets → canonical_games resolution; the fake returns the watched
// expansion rows for the resolver's `.all()`, and the candidate pending rows for the drain's.
function watchedAll(watched: Array<{ game: string; expansion_id: string }>, pending: any[]) {
  return (sql: string): any[] => {
    if (sql.includes('card_watches')) return watched
    if (sql.includes("status = 'pending'")) return pending
    return []
  }
}
const watchCard = (productId: string) => ({
  number: '25',
  variants: [{
    name: 'normal',
    marketplaces: [{ name: 'tcgplayer', product_id: productId }],
    prices: [{ type: 'raw', condition: 'NM', market: 1.5, trends: {} }],
  }],
})
function findWatchAuditLine(spy: ReturnType<typeof vi.spyOn>): any | null {
  for (const call of spy.mock.calls) {
    const arg = call[0]
    if (typeof arg !== 'string') continue
    try { const o = JSON.parse(arg); if (o?.log === 'scrydex_watch_drain_audit') return o } catch { /* not json */ }
  }
  return null
}

describe('processPendingWebhooks — watched scope (Card Watch priority lane)', () => {
  it('fetches ONLY watched expansions; unwatched pending rows are never claimed', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [watchCard('999')] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    // exp1 is watched; exp2 is not. Two distinct pending rows.
    const pending = [
      { id: 1, event_name: 'pokemon.prices.raw', expansion_ids_json: '["exp1"]' },
      { id: 2, event_name: 'pokemon.prices.raw', expansion_ids_json: '["exp2"]' },
    ]
    const db = makeFakeDB({
      first: webhookFirstRouter,
      all: watchedAll([{ game: 'Pokemon', expansion_id: 'exp1' }], pending),
    })
    await processPendingWebhooks({ DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any, { scope: 'watched' })

    // Exactly ONE Scrydex fetch, and it is the WATCHED expansion (exp1), never exp2.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('exp1')
    expect(url).not.toContain('exp2')

    // The unwatched row (id 2) is never touched — no claim/complete/error/release references it.
    const idInvolvingTwo = db._runs.filter(r => r.sql.includes('scrydex_webhook_log') && r.args.includes(2))
    const claimTwo = batchedStmts(db).filter(s => s.sql.includes('scrydex_webhook_log') && s.args.includes(2))
    expect(idInvolvingTwo).toHaveLength(0)
    expect(claimTwo).toHaveLength(0)

    // The watched row (id 1) completes and the expansion is marked fresh.
    expect(db._runs.some(r => /status\s*=\s*'complete'/.test(r.sql) && r.args.includes(1))).toBe(true)
    expect(db._runs.some(r => r.sql.includes('INSERT INTO scrydex_expansion_freshness'))).toBe(true)
  })

  it('shared dedup still collapses N rows for one watched expansion into a single fetch', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [watchCard('999')] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const pending = [1, 2, 3].map(id => ({ id, event_name: 'pokemon.prices.raw', expansion_ids_json: '["exp1"]' }))
    const db = makeFakeDB({
      first: webhookFirstRouter,
      all: watchedAll([{ game: 'Pokemon', expansion_id: 'exp1' }], pending),
    })
    await processPendingWebhooks({ DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any, { scope: 'watched' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(db._runs.filter(r => /status\s*=\s*'complete'/.test(r.sql))).toHaveLength(3)

    // The audit line is the WATCH variant and reports the watched-expansion total.
    const audit = findWatchAuditLine(logSpy)
    expect(audit).not.toBeNull()
    expect(audit.watched_expansions_total).toBe(1)
    expect(audit.rows_in).toBe(3)
    expect(audit.distinct_expansions).toBe(1)
    expect(audit.fetches_made).toBe(1)
  })

  it('a mixed row (watched + unwatched expansion) fetches only the watched one and is released back to pending', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [watchCard('999')] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    // One row references BOTH exp1 (watched) and exp2 (unwatched).
    const pending = [{ id: 7, event_name: 'pokemon.prices.raw', expansion_ids_json: '["exp1","exp2"]' }]
    const db = makeFakeDB({
      first: webhookFirstRouter,
      all: watchedAll([{ game: 'Pokemon', expansion_id: 'exp1' }], pending),
    })
    await processPendingWebhooks({ DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any, { scope: 'watched' })

    // Only exp1 fetched; the row is NOT completed (exp2 still owed) and is released to 'pending' so
    // the 04:00 daily drain fetches exp2. The watch lane must never complete a mixed row.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('exp1')
    expect(db._runs.some(r => /status\s*=\s*'complete'/.test(r.sql) && r.args.includes(7))).toBe(false)
    const released = batchedStmts(db).filter(s => /status\s*=\s*'pending'/.test(s.sql) && s.args.includes(7))
    expect(released.length).toBeGreaterThan(0)
  })

  it('uses the 4h watch freshness window (not the daily 20h) and skips a fresh watched expansion', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    let freshnessMaxAge: number | null = null

    const db = makeFakeDB({
      first: (sql, args) => {
        if (sql.includes('scrydex_expansion_freshness')) { freshnessMaxAge = args[2] as number; return { 1: 1 } } // fresh
        return webhookFirstRouter(sql)
      },
      all: watchedAll([{ game: 'Pokemon', expansion_id: 'exp1' }],
        [{ id: 1, event_name: 'pokemon.prices.raw', expansion_ids_json: '["exp1"]' }]),
    })
    await processPendingWebhooks({ DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any, { scope: 'watched' })

    // Fresh within 4h → no fetch, row completes.
    expect(fetchMock).not.toHaveBeenCalled()
    expect(freshnessMaxAge).toBe(4 * 3600)   // 14400s — the watch window, NOT the daily 72000s (20h)
    expect(db._runs.some(r => /status\s*=\s*'complete'/.test(r.sql) && r.args.includes(1))).toBe(true)
  })

  it('the DAILY scope still uses the 20h freshness window (unchanged by the watch lane)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    let freshnessMaxAge: number | null = null
    const db = makeFakeDB({
      first: (sql, args) => {
        if (sql.includes('scrydex_expansion_freshness')) { freshnessMaxAge = args[2] as number; return { 1: 1 } }
        return webhookFirstRouter(sql)
      },
      all: pendingAll,
    })
    await processPendingWebhooks({ DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any)
    expect(freshnessMaxAge).toBe(20 * 3600)   // 72000s — the daily window is untouched
  })

  it('credit-guard 403 in watched scope marks the row error and circuit-breaks', async () => {
    const fetchMock = vi.fn(async () => new Response('{"code":"CREDIT_CAP_HIT"}', { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)
    const db = makeFakeDB({
      first: webhookFirstRouter,
      all: watchedAll([{ game: 'Pokemon', expansion_id: 'exp1' }],
        [{ id: 1, event_name: 'pokemon.prices.raw', expansion_ids_json: '["exp1"]', status: 'pending', attempts: 0 }]),
    })
    await processPendingWebhooks({ DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any, { scope: 'watched' })

    expect(fetchMock).toHaveBeenCalledTimes(1)   // one call then break
    const webhookUpdates = db._runs.filter(r => r.sql.includes('scrydex_webhook_log'))
    expect(webhookUpdates.some(r => /status\s*=\s*'error'/.test(r.sql) && r.args.includes(1))).toBe(true)
    expect(webhookUpdates.some(r => /status\s*=\s*'complete'/.test(r.sql))).toBe(false)
    // A guard/403 burns NO attempt (the June-outage invariant) and writes no freshness row.
    expect(db._runs.some(r => r.sql.includes('INSERT INTO scrydex_expansion_freshness'))).toBe(false)
  })

  it('an empty watched set is an immediate no-op (no watches → no claims, no fetch)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const db = makeFakeDB({
      first: webhookFirstRouter,
      all: watchedAll([], [{ id: 1, event_name: 'pokemon.prices.raw', expansion_ids_json: '["exp1"]' }]),
    })
    await processPendingWebhooks({ DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any, { scope: 'watched' })

    expect(fetchMock).not.toHaveBeenCalled()
    // No candidate is ever claimed (the daily drain owns everything).
    expect(db._batches.flat().some(s => s.sql.includes("status = 'processing'"))).toBe(false)
    const audit = findWatchAuditLine(logSpy)
    expect(audit).not.toBeNull()
    expect(audit.watched_expansions_total).toBe(0)
    expect(audit.fetches_made).toBe(0)
  })

  it('returns the (gameSlug, expansion) pairs it refreshed live — the Session-3 alert hook input', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [watchCard('999')] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const db = makeFakeDB({
      first: webhookFirstRouter,
      all: watchedAll([{ game: 'Pokemon', expansion_id: 'exp1' }],
        [{ id: 1, event_name: 'pokemon.prices.raw', expansion_ids_json: '["exp1"]' }]),
    })
    const result = await processPendingWebhooks({ DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any, { scope: 'watched' })

    // gameSlug is the webhook event_name's first segment ('pokemon'); expansion is the fetched id.
    expect(result.scope).toBe('watched')
    expect(result.expansionsFetched).toBe(1)
    expect(result.refreshedExpansions).toEqual([{ gameSlug: 'pokemon', expansion: 'exp1' }])
  })

  it('the DAILY scope leaves refreshedExpansions empty (it never triggers alerts this session)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [watchCard('999')] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const db = makeFakeDB({ first: webhookFirstRouter, all: pendingAll })
    const result = await processPendingWebhooks({ DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any)

    expect(result.scope).toBe('daily')
    expect(result.refreshedExpansions).toEqual([])   // the daily drain never feeds the alert hook
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Watch freshness ↔ lane-interval invariant: the watch freshness window MUST be < the
// lane's cron interval (default 6h) or every intraday run no-ops and watched prices freeze.
// ─────────────────────────────────────────────────────────────────────────────
describe('watchFreshnessSafeForLane', () => {
  it('the production default (4h) is safe against the 6h min lane gap', () => {
    expect(WATCH_LANE_INTERVAL_HOURS).toBe(6)
    expect(DEFAULT_WATCH_FRESHNESS_HOURS).toBe(4)
    expect(watchFreshnessSafeForLane(DEFAULT_WATCH_FRESHNESS_HOURS)).toBe(true)
  })
  it('a freshness window ≥ the lane interval is UNSAFE (would freeze watched prices)', () => {
    expect(watchFreshnessSafeForLane(6)).toBe(false)   // == interval → no-op against prior run
    expect(watchFreshnessSafeForLane(8)).toBe(false)
    expect(watchFreshnessSafeForLane(5.9)).toBe(true)
  })
  it('an over-long watch freshness window logs a loud warning at the drain', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = makeFakeDB({
      first: webhookFirstRouter,
      all: watchedAll([{ game: 'Pokemon', expansion_id: 'exp1' }], []),
    })
    await processPendingWebhooks(
      { DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't', SCRYDEX_WATCH_FRESHNESS_HOURS: '6' } as any,
      { scope: 'watched' },
    )
    expect(errSpy.mock.calls.some(c => String(c[0]).includes('SCRYDEX_WATCH_FRESHNESS_HOURS=6'))).toBe(true)
  })
})
