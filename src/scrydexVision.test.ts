import { describe, it, expect, vi, afterEach } from 'vitest'
import { scrydexVisionIdentify, ScrydexCreditLimitError } from './lib/scrydexClient.js'

// Fake D1 mirroring scrydexProcessor.test.ts — records run()s, routes first() via callback.
interface FakeStmt { sql: string; args: unknown[]; bind: (...a: unknown[]) => FakeStmt; first: () => Promise<unknown>; all: () => Promise<{ results: unknown[] }>; run: () => Promise<{ meta: { last_row_id: number } }> }

function makeFakeDB(first?: (sql: string, args: unknown[]) => unknown) {
  const runs: { sql: string; args: unknown[] }[] = []
  const db = {
    prepare(sql: string): FakeStmt {
      const stmt: FakeStmt = {
        sql, args: [],
        bind(...a: unknown[]) { stmt.args = a; return stmt },
        async first() { return first ? first(sql, stmt.args) : null },
        async all() { return { results: [] } },
        async run() { runs.push({ sql, args: stmt.args }); return { meta: { last_row_id: 1 } } },
      }
      return stmt
    },
    _runs: runs,
  }
  return db
}

const ENV = { DB: null as any, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' }
const img = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('scrydexVisionIdentify', () => {
  it('blocks via the monthly credit guard before any HTTP call', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const db = makeFakeDB(sql => sql.includes('SUM(credits_used)') ? { total: 99999 } : null)

    await expect(scrydexVisionIdentify({ ...ENV, DB: db } as any, img(), 'pokemon'))
      .rejects.toBeInstanceOf(ScrydexCreditLimitError)
    expect(fetchMock).not.toHaveBeenCalled()
    // A 'blocked' row is logged (credits 0).
    const blocked = db._runs.find(r => r.sql.includes('INSERT INTO scrydex_api_log') && r.args[4] === 'blocked')
    expect(blocked).toBeTruthy()
  })

  it('POSTs multipart to the Vision endpoint and logs a 5-credit success', async () => {
    const fetchMock = vi.fn(async (url: string, opts: any) => {
      expect(String(url)).toBe('https://api.scrydex.com/vision/v1/cards/identify')
      expect(opts.method).toBe('POST')
      expect(opts.headers['X-Api-Key']).toBe('k')
      expect(opts.headers['X-Team-ID']).toBe('t')
      // Content-Type is set by fetch from the FormData boundary — we must NOT set it ourselves.
      expect(opts.headers['Content-Type'] ?? opts.headers['content-type']).toBeUndefined()
      return new Response(JSON.stringify({ data: { analysis: {}, matches: [] } }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const db = makeFakeDB(sql => sql.includes('SUM(credits_used)') ? { total: 0 } : null)

    const res = await scrydexVisionIdentify({ ...ENV, DB: db } as any, img(), 'pokemon')
    expect(res.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // scrydex_api_log success row with credits_used = 5 (the Vision premium debit).
    const log = db._runs.find(r => r.sql.includes('INSERT INTO scrydex_api_log') && r.args[4] === 'success')
    expect(log).toBeTruthy()
    expect(log!.args[3]).toBe(5)
  })

  it('logs a 5-credit error row on a non-OK response (still returns it for caller circuit-breaking)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"code":"CREDIT_CAP_HIT"}', { status: 403 })))
    const db = makeFakeDB(sql => sql.includes('SUM(credits_used)') ? { total: 0 } : null)

    const res = await scrydexVisionIdentify({ ...ENV, DB: db } as any, img())
    expect(res.status).toBe(403)
    const log = db._runs.find(r => r.sql.includes('INSERT INTO scrydex_api_log') && r.args[4] === 'error')
    expect(log).toBeTruthy()
    expect(log!.args[3]).toBe(5)
  })
})
