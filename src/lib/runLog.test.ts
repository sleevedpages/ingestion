import { describe, it, expect, vi, afterEach } from 'vitest'
import { writeRunLog, runStage } from './runLog.js'

function makeDB() {
  const runCalls: { sql: string; args: unknown[] }[] = []
  const db: any = {
    runCalls,
    prepare(sql: string) {
      const stmt: any = {
        sql,
        args: [] as unknown[],
        bind(...a: unknown[]) { stmt.args = a; return stmt },
        async run() { runCalls.push({ sql, args: stmt.args }); return { meta: {} } },
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
  it('resolves to what fn resolves to, and logs a success row', async () => {
    const db = makeDB()
    const result = await runStage(db, 'tcg-sync', 'sync', async () => ({ products: 3 }))
    expect(result).toEqual({ products: 3 })
    expect(db.runCalls).toHaveLength(1)
    const [job, stage, , , status, countsJson, firstError] = db.runCalls[0].args
    expect(job).toBe('tcg-sync')
    expect(stage).toBe('sync')
    expect(status).toBe('success')
    expect(countsJson).toBe(JSON.stringify({ products: 3 }))
    expect(firstError).toBeNull()
  })

  it('rethrows fn\'s error (preserving existing .catch() chains) AND still writes an error row', async () => {
    const db = makeDB()
    await expect(
      runStage(db, 'scrydex-drain', 'drain', async () => { throw new Error('drain exploded') })
    ).rejects.toThrow('drain exploded')

    expect(db.runCalls).toHaveLength(1)
    const [job, stage, , , status, countsJson, firstError] = db.runCalls[0].args
    expect(job).toBe('scrydex-drain')
    expect(stage).toBe('drain')
    expect(status).toBe('error')
    expect(countsJson).toBeNull()
    expect(String(firstError)).toContain('drain exploded')
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
