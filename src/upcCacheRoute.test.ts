import { describe, it, expect } from 'vitest'
import worker from './worker.js'
import { EBAY_UPC_PREFIX } from './lib/ebayUpc.js'
import { UPCITEMDB_UPC_PREFIX } from './lib/upcitemdbUpc.js'

/**
 * Route coverage for POST /upc/cache/invalidate (2026-08-21) — 401 / 400 / happy path.
 * The route is the seam Content's admin correction endpoint calls so a stale provider
 * verdict can never outlive a correction.
 */

const SECRET = 'worker-secret'

function makeKV(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed))
  return {
    _store: store,
    async get(k: string) { return store.has(k) ? store.get(k)! : null },
    async put(k: string, v: string) { store.set(k, v) },
    async delete(k: string) { store.delete(k) },
  } as any
}

const env = (kv: any) => ({ INGESTION_WORKER_SECRET: SECRET, SLEEVEDPAGES_KV: kv } as any)
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as any

const post = (body: unknown, secret?: string) =>
  new Request('https://w.dev/upc/cache/invalidate', {
    method: 'POST',
    headers: secret ? { 'x-worker-secret': secret, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('POST /upc/cache/invalidate', () => {
  it('401 without / with a wrong x-worker-secret — never an open cache-busting endpoint', async () => {
    expect((await worker.fetch(post({ upc: '196214136144' }), env(makeKV()), ctx)).status).toBe(401)
    expect((await worker.fetch(post({ upc: '196214136144' }, 'nope'), env(makeKV()), ctx)).status).toBe(401)
  })

  it('401 when the worker itself has no secret configured (fail-closed, never open)', async () => {
    const res = await worker.fetch(post({ upc: '196214136144' }, SECRET), { SLEEVEDPAGES_KV: makeKV() } as any, ctx)
    expect(res.status).toBe(401)
  })

  it('400 on a malformed / missing / out-of-range barcode', async () => {
    for (const bad of [{}, { upc: '' }, { upc: '1234567' }, { upc: '123456789012345' }, { upc: 'not-a-code' }]) {
      expect((await worker.fetch(post(bad, SECRET), env(makeKV()), ctx)).status).toBe(400)
    }
  })

  it('deletes both rungs in both barcode forms and reports the count', async () => {
    const kv = makeKV({
      [`${EBAY_UPC_PREFIX}196214136144`]: '{"found":false}',
      [`${UPCITEMDB_UPC_PREFIX}0196214136144`]: '{"found":false}',
    })
    const res = await worker.fetch(post({ upc: '196214136144' }, SECRET), env(kv), ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, upc: '196214136144', deleted: 2 })
    expect(kv._store.size).toBe(0)
  })

  it('accepts a formatted barcode (digits are extracted, as everywhere else in the ladder)', async () => {
    const kv = makeKV({ [`${EBAY_UPC_PREFIX}196214136144`]: '{"found":false}' })
    const res = await worker.fetch(post({ upc: '1-9621-4136144' }, SECRET), env(kv), ctx)
    expect(await res.json()).toMatchObject({ ok: true, deleted: 1 })
  })
})
