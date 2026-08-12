import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchAllExpansions, ScrydexExpansionsError, syncScrydexSetMappings } from './scrydexSetMapping.js'

/**
 * These cover the 2026-08-12 fix to the `/expansions` call.
 *
 * It sent `limit: '500'`, which Scrydex IGNORES (the same silent-param defect that capped `/cards`
 * at ~100 rows until 2026-06-12), so only the first page of each game's expansions was ever read.
 * Measured cost on prod: 70 of 454 Magic sets carried a `scrydex_expansion_id`, which capped every
 * expansion-scoped Magic job at ~21.7% of the game's products.
 */

/** `rows` are returned only for `forGame`, so a multi-game sweep can't map them six times over. */
function makeFakeDB(rows: any[] = [], forGame?: string) {
  const batches: any[][] = []
  const db = {
    prepare(sql: string) {
      const stmt = {
        sql,
        args: [] as unknown[],
        bind(...a: unknown[]) { stmt.args = a; return stmt },
        async first() { return sql.includes('SUM(credits_used)') ? { total: 0 } : null },
        async all() {
          const wanted = !forGame || stmt.args[0] === forGame
          return { results: sql.includes('FROM   sets s') && wanted ? rows : [] }
        },
        async run() { return { meta: {} } },
      }
      return stmt
    },
    async batch(stmts: any[]) { batches.push(stmts); return [] },
    _batches: batches,
  }
  return db
}

const env = (db: any) => ({
  DB: db, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't', SCRYDEX_MONTHLY_LIMIT: '50000',
}) as any

/** Serves `total` synthetic expansions, `pageSize` at a time, recording every requested URL. */
function mockPagedExpansions(total: number, serverPageSize = 250) {
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(String(url))
    const page = Number(new URL(String(url)).searchParams.get('page') ?? '1')
    const start = (page - 1) * serverPageSize
    const data = Array.from({ length: Math.max(0, Math.min(serverPageSize, total - start)) }, (_, i) => ({
      id: `EX${start + i}`, code: `EX${start + i}`, name: `Expansion ${start + i}`,
    }))
    return { ok: true, status: 200, async json() { return { data, totalCount: total } } } as any
  }))
  return urls
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchAllExpansions', () => {
  it('pages with page/pageSize until totalCount is reached — never one page only', async () => {
    const urls = mockPagedExpansions(620)
    const { expansions, requests, complete } = await fetchAllExpansions(env(makeFakeDB()), 'magicthegathering')

    expect(expansions).toHaveLength(620)
    expect(requests).toBe(3)          // 250 + 250 + 120
    expect(complete).toBe(true)
    // The ignored param is gone; the honoured ones are present.
    expect(urls[0]).toContain('pageSize=250')
    expect(urls[0]).toContain('page=1')
    expect(urls.join(' ')).not.toContain('limit=')
  })

  it('completes even when the server caps the page size below what we asked for', async () => {
    mockPagedExpansions(300, 100)     // asked 250, served 100
    const { expansions, requests, complete } = await fetchAllExpansions(env(makeFakeDB()), 'pokemon')
    expect(expansions).toHaveLength(300)
    expect(requests).toBe(3)
    expect(complete).toBe(true)
  })

  it('keeps the pages it already read when a later page fails transiently', async () => {
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      call++
      if (call === 1) {
        return { ok: true, status: 200, async json() { return { data: [{ id: 'A', code: 'A', name: 'A' }], totalCount: 5 } } } as any
      }
      return { ok: false, status: 500, async json() { return {} } } as any
    }))
    const { expansions, complete } = await fetchAllExpansions(env(makeFakeDB()), 'lorcana')
    expect(expansions).toHaveLength(1)
    expect(complete).toBe(false)      // reported, never silently treated as the whole catalogue
  })

  it('throws a status-carrying error on an account refusal so the caller can circuit-break', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 402, async json() { return {} } } as any)))
    await expect(fetchAllExpansions(env(makeFakeDB()), 'magicthegathering'))
      .rejects.toBeInstanceOf(ScrydexExpansionsError)
  })
})

describe('syncScrydexSetMappings', () => {
  it('maps a set from a LATER page — the mapping the old first-page-only call could never make', async () => {
    // 300 expansions: the target is #260, past any single page of the old call.
    mockPagedExpansions(300, 250)
    const db = makeFakeDB([{ id: 7, name: 'Expansion 260', abbreviation: 'EX260', scrydex_set_id: null }], 'Magic')

    const res = await syncScrydexSetMappings(env(db))

    expect(res.mapped).toBe(1)
    expect(res.notFound).toBe(0)
    const update = db._batches.flat()[0]
    expect(update.sql).toContain('UPDATE sets SET scrydex_expansion_id')
    expect(update.args).toEqual(['EX260', 7])
  })

  it('stops the whole run on a 402/403 rather than repeating it for every game', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 402, async json() { return {} } } as any))
    vi.stubGlobal('fetch', fetchMock)

    const res = await syncScrydexSetMappings(env(makeFakeDB()))

    expect(res.mapped).toBe(0)
    // ONE call total, not one per game (there are six configured games).
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
