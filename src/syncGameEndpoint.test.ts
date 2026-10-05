// POST /admin/sync-game — the admin TCG Sync panel's per-game "Sync now".
// Pins: the shared secret first (401); label required (400); unknown label 404; a switched-off
// game 409; refused while the FULL tcg-sync's manual lock is held or the same game is already
// syncing (409, nothing started); otherwise runIngestion runs with { onlyLabel } inside
// runStage('tcg-sync', 'sync-game'), and the per-game lock is released when it settles —
// including after a failure.
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('./ingestion/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ingestion/index.js')>()
  return { ...actual, runIngestion: vi.fn(async () => ({ tcgsProcessed: ['Union Arena'], groupsEnqueued: 82, categoryIds: [81] })) }
})
const stages = vi.hoisted(() => [] as Array<{ job: string; stage: string }>)
vi.mock('./lib/runLog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/runLog.js')>()
  return {
    ...actual,
    runStage: vi.fn(async (_db: unknown, job: string, stage: string, fn: () => Promise<unknown>) => {
      stages.push({ job, stage })
      return fn()
    }),
  }
})

import worker from './worker.js'
import { runIngestion } from './ingestion/index.js'
import { JOB_LOCK_PREFIX, gameSyncLockKey } from './adminJobs.js'

const SECRET = 'test-secret'

function fakeKV() {
  const store = new Map<string, string>()
  return {
    store,
    get: async (k: string) => (store.has(k) ? store.get(k)! : null),
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
  }
}
function fakeDB(rows: Record<string, { label: string; enabled: number }>) {
  return {
    prepare: (sql: string) => ({
      bind: (label: string) => ({
        first: async () => (/FROM tcg_supported_games/.test(sql) ? rows[label] ?? null : null),
      }),
    }),
  }
}
const GAMES = { 'Union Arena': { label: 'Union Arena', enabled: 1 }, Cyberpunk: { label: 'Cyberpunk', enabled: 0 } }

function setup(kv = fakeKV()) {
  const pending: Promise<unknown>[] = []
  const env = { DB: fakeDB(GAMES), SLEEVEDPAGES_KV: kv, INGESTION_WORKER_SECRET: SECRET } as any
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p) } } as any
  const call = async (body: unknown, secret: string | null = SECRET) => {
    const res = await worker.fetch(new Request('https://worker.test/admin/sync-game', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(secret ? { 'x-worker-secret': secret } : {}) },
      body: JSON.stringify(body),
    }), env, ctx)
    return { status: res.status, body: await res.json() as any }
  }
  return { kv, call, settle: () => Promise.all(pending) }
}

afterEach(() => { vi.clearAllMocks(); stages.length = 0 })

describe('POST /admin/sync-game', () => {
  it('401 without (or with the wrong) secret — nothing runs', async () => {
    const { call } = setup()
    expect((await call({ label: 'Union Arena' }, null)).status).toBe(401)
    expect((await call({ label: 'Union Arena' }, 'nope')).status).toBe(401)
    expect(runIngestion).not.toHaveBeenCalled()
  })

  it('400 without a label; 404 for an unknown one; 409 for a switched-off game', async () => {
    const { call } = setup()
    expect((await call({})).status).toBe(400)
    expect((await call({ label: '   ' })).status).toBe(400)
    const unknown = await call({ label: 'Weiss Schwarz' })
    expect(unknown.status).toBe(404)
    expect(unknown.body.error).toBe('No supported game labelled "Weiss Schwarz"')
    const off = await call({ label: 'Cyberpunk' })
    expect(off.status).toBe(409)
    expect(off.body.error).toMatch(/switched off/)
    expect(runIngestion).not.toHaveBeenCalled()
  })

  it('starts runIngestion for THAT game only, inside runStage(tcg-sync, sync-game), then releases its lock', async () => {
    const { call, kv, settle } = setup()
    const res = await call({ label: 'Union Arena' })
    expect(res).toEqual({ status: 200, body: { ok: true, label: 'Union Arena', started: true } })
    await settle()
    expect(runIngestion).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runIngestion).mock.calls[0][0]).toMatchObject({ onlyLabel: 'Union Arena' })
    expect(stages).toEqual([{ job: 'tcg-sync', stage: 'sync-game' }])
    expect(kv.store.has(gameSyncLockKey('Union Arena'))).toBe(false)
  })

  it('refused while the FULL tcg-sync is running (its manual lock is held) — nothing started', async () => {
    const kv = fakeKV()
    kv.store.set(JOB_LOCK_PREFIX + 'tcg-sync', 'x')
    const { call } = setup(kv)
    const res = await call({ label: 'Union Arena' })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ alreadyRunning: true, error: 'The full TCG sync is running now, and it includes this game.' })
    expect(runIngestion).not.toHaveBeenCalled()
  })

  it('refused while the same game is already syncing', async () => {
    const kv = fakeKV()
    kv.store.set(gameSyncLockKey('Union Arena'), 'x')
    const { call } = setup(kv)
    const res = await call({ label: 'Union Arena' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('A sync of "Union Arena" is already running.')
    expect(runIngestion).not.toHaveBeenCalled()
  })

  it('a failing run still releases the lock (the next "Sync now" is not blocked)', async () => {
    vi.mocked(runIngestion).mockRejectedValueOnce(new Error('"Union Arena" matched no TCGCSV category'))
    const { call, kv, settle } = setup()
    expect((await call({ label: 'Union Arena' })).status).toBe(200)
    await settle()
    expect(kv.store.has(gameSyncLockKey('Union Arena'))).toBe(false)
  })
})
