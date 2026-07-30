import { describe, it, expect, vi, afterEach } from 'vitest'
import { writeRunLog, runStage, RUN_STAGE_RUNNING } from './runLog.js'

/**
 * A D1 double that models the pieces `runStage` depends on: `.run()` for writes and
 * `.first()` honouring the START row's `RETURNING id`. `runCalls` records terminal
 * INSERTs + UPDATEs; `startCalls` records START inserts.
 *
 * `noReturning: true` models a driver/table that can't hand back an id — the degraded
 * path that must still produce exactly ONE terminal row (the pre-2026-07-30 behaviour).
 */
function makeDB({ noReturning = false, updateChanges = 1 } = {}) {
  const runCalls: { sql: string; args: unknown[] }[] = []
  const startCalls: { sql: string; args: unknown[] }[] = []
  let nextId = 100
  const db: any = {
    runCalls,
    startCalls,
    prepare(sql: string) {
      const stmt: any = {
        sql,
        args: [] as unknown[],
        bind(...a: unknown[]) { stmt.args = a; return stmt },
        async first() {
          if (!/RETURNING id/.test(sql)) return null
          startCalls.push({ sql, args: stmt.args })
          return noReturning ? null : { id: nextId++ }
        },
        async run() {
          runCalls.push({ sql, args: stmt.args })
          return /^\s*UPDATE/.test(sql) ? { meta: { changes: updateChanges } } : { meta: {} }
        },
      }
      return stmt
    },
  }
  return db
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('writeRunLog', () => {
  it('inserts a row with the given fields, JSON-encoding counts', async () => {
    const db = makeDB()
    await writeRunLog(db, {
      job: 'tcg-sync', stage: 'sync', startedAt: 't0', finishedAt: 't1',
      status: 'success', counts: { products: 5 }, firstError: null,
    })
    expect(db.runCalls).toHaveLength(1)
    const call = db.runCalls[0]
    expect(call.sql).toContain('INSERT INTO ingestion_run_log')
    expect(call.args).toEqual(['tcg-sync', 'sync', 't0', 't1', 'success', JSON.stringify({ products: 5 }), null])
  })

  it('encodes undefined counts as null rather than the string "undefined"', async () => {
    const db = makeDB()
    await writeRunLog(db, {
      job: 'news-poll', stage: 'poll', startedAt: 't0', finishedAt: 't1',
      status: 'error', counts: undefined, firstError: 'boom',
    })
    expect(db.runCalls[0].args[5]).toBeNull()
  })

  it('NEVER throws when the DB write fails (missing table, transient error, malformed db)', async () => {
    const brokenDb: any = { prepare() { throw new Error('no such table: ingestion_run_log') } }
    await expect(writeRunLog(brokenDb, {
      job: 'x', stage: 'y', startedAt: 't0', finishedAt: 't1', status: 'success', counts: null, firstError: null,
    })).resolves.toBeUndefined()

    // even a fully empty object (the shape adminJobs.pipeline.test.ts passes as env.DB)
    await expect(writeRunLog({} as any, {
      job: 'x', stage: 'y', startedAt: 't0', finishedAt: 't1', status: 'success', counts: null, firstError: null,
    })).resolves.toBeUndefined()
  })
})

describe('runStage', () => {
  it('resolves to what fn resolves to, and closes the start row out as a success', async () => {
    const db = makeDB()
    const result = await runStage(db, 'tcg-sync', 'sync', async () => ({ products: 3 }))
    expect(result).toEqual({ products: 3 })

    // ONE start row, written before the stage ran…
    expect(db.startCalls).toHaveLength(1)
    const [sJob, sStage, , sStatus] = db.startCalls[0].args
    expect(sJob).toBe('tcg-sync')
    expect(sStage).toBe('sync')
    expect(sStatus).toBe(RUN_STAGE_RUNNING)

    // …and ONE terminal UPDATE, not a second INSERT.
    expect(db.runCalls).toHaveLength(1)
    expect(db.runCalls[0].sql).toContain('UPDATE ingestion_run_log')
    const [finishedAt, status, countsJson, firstError, id] = db.runCalls[0].args
    expect(typeof finishedAt).toBe('string')
    expect(status).toBe('success')
    expect(countsJson).toBe(JSON.stringify({ products: 3 }))
    expect(firstError).toBeNull()
    expect(id).toBe(100)
  })

  it('rethrows fn\'s error (preserving existing .catch() chains) AND records it on the start row', async () => {
    const db = makeDB()
    await expect(
      runStage(db, 'scrydex-drain', 'drain', async () => { throw new Error('drain exploded') })
    ).rejects.toThrow('drain exploded')

    expect(db.startCalls).toHaveLength(1)
    expect(db.runCalls).toHaveLength(1)
    expect(db.runCalls[0].sql).toContain('UPDATE ingestion_run_log')
    const [, status, countsJson, firstError] = db.runCalls[0].args
    expect(status).toBe('error')
    expect(countsJson).toBeNull()
    expect(String(firstError)).toContain('drain exploded')
  })

  // ── The start-row contract (2026-07-30) ──────────────────────────────────────
  // The row used to be written ONLY in `finally`, so an invocation killed mid-stage
  // (the waitUntil death the image-pipeline audit named) left NO row at all — the
  // observability floor was blind to exactly the failure it existed to catch.
  describe('start row', () => {
    it('is written BEFORE the stage body runs, with a NULL finish', async () => {
      const db = makeDB()
      let sawStartRow = false
      await runStage(db, 'image-mirror', 'mirror', async () => {
        // Inside the stage: the start row exists and nothing has been finalised.
        sawStartRow = db.startCalls.length === 1 && db.runCalls.length === 0
        return { mirrored: 1 }
      })
      expect(sawStartRow).toBe(true)
      // finished_at is bound NULL by the INSERT's literal, and the status says 'running'.
      expect(db.startCalls[0].sql).toContain('finished_at')
      expect(db.startCalls[0].args[3]).toBe(RUN_STAGE_RUNNING)
    })

    it('SURVIVES a stage abandoned without either terminal path (the died-mid-stage signal)', async () => {
      // Model the kill: the start row is written, then the invocation goes away before
      // `fn` settles — `runStage`'s finally never runs, so the row stays NULL-finish.
      const db = makeDB()
      let release: (() => void) | undefined
      const never = new Promise<void>((resolve) => { release = resolve })
      const pending = runStage(db, 'scrydex-drain', 'drain', () => never.then(() => ({})))
      await Promise.resolve()   // let the start write land

      expect(db.startCalls).toHaveLength(1)
      expect(db.runCalls).toHaveLength(0)          // NOTHING finalised — the row is the evidence
      expect(db.startCalls[0].args[3]).toBe(RUN_STAGE_RUNNING)

      release!()                                    // tidy up so the test doesn't leak
      await pending
    })

    it('a start write that THROWS never stops the stage — it falls back to one terminal INSERT', async () => {
      const calls: string[] = []
      const db: any = {
        prepare(sql: string) {
          if (/RETURNING id/.test(sql)) throw new Error('start write exploded')
          return {
            bind() { return this },
            async run() { calls.push(sql); return { meta: {} } },
          }
        },
      }
      const result = await runStage(db, 'news-poll', 'poll', async () => ({ inserted: 2 }))
      expect(result).toEqual({ inserted: 2 })
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain('INSERT INTO ingestion_run_log')
    })

    it('a driver that cannot return an id degrades to the legacy single terminal INSERT', async () => {
      const db = makeDB({ noReturning: true })
      await runStage(db, 'news-poll', 'poll', async () => ({ inserted: 1 }))
      expect(db.runCalls).toHaveLength(1)
      expect(db.runCalls[0].sql).toContain('INSERT INTO ingestion_run_log')
    })

    it('a start row that vanished before the finish still yields exactly one terminal row', async () => {
      const db = makeDB({ updateChanges: 0 })
      await runStage(db, 'tcg-sync', 'sync', async () => ({ products: 1 }))
      expect(db.runCalls).toHaveLength(2)                                  // the no-op UPDATE…
      expect(db.runCalls[0].sql).toContain('UPDATE ingestion_run_log')
      expect(db.runCalls[1].sql).toContain('INSERT INTO ingestion_run_log') // …then the fallback row
    })
  })

  it('a log-write failure never masks the stage result (guarantee parity with the WP-2 mirror pattern)', async () => {
    const brokenDb: any = { prepare() { throw new Error('log db exploded') } }
    const result = await runStage(brokenDb, 'news-poll', 'poll', async () => ({ inserted: 2 }))
    expect(result).toEqual({ inserted: 2 })
  })

  it('a log-write failure never masks the stage error either', async () => {
    const brokenDb: any = { prepare() { throw new Error('log db exploded') } }
    await expect(
      runStage(brokenDb, 'news-poll', 'poll', async () => { throw new Error('real failure') })
    ).rejects.toThrow('real failure')
  })

  it('works against the bare {} env.DB shape used by adminJobs.pipeline.test.ts style mocks', async () => {
    const result = await runStage({} as any, 'image-mirror', 'mirror', async () => ({ mirrored: 1 }))
    expect(result).toEqual({ mirrored: 1 })
  })
})
