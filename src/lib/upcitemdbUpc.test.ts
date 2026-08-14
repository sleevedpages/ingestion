import { describe, it, expect, vi } from 'vitest'
import {
  lookupUpcitemdbUpc,
  UPCITEMDB_TRIAL_URL,
  UPCITEMDB_KEYED_URL,
  UPCITEMDB_UPC_PREFIX,
  UPCITEMDB_UPC_TTL,
  UPCITEMDB_UPC_NEGATIVE_TTL,
  UPCITEMDB_BACKOFF_KEY,
  UPCITEMDB_BACKOFF_TTL,
  UPCITEMDB_DAILY_COUNTER_PREFIX,
} from './upcitemdbUpc.js'
import { dayStamp } from './upcTitleMatch.js'

function makeKV() {
  const store = new Map<string, { value: string; ttl?: number }>()
  return {
    _store: store,
    async get(k: string) { return store.has(k) ? store.get(k)!.value : null },
    async put(k: string, v: string, opts?: { expirationTtl?: number }) {
      store.set(k, { value: v, ttl: opts?.expirationTtl })
    },
  } as any
}

function makeDb({ config = {} as Record<string, string>, candidates = [] as any[] } = {}) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: any[]) {
          return {
            async first() {
              if (sql.includes('app_config')) return config[String(args[0])] != null ? { value: config[String(args[0])] } : null
              return null
            },
            async all() { return { results: candidates } },
          }
        },
      }
    },
  } as any
}

const BOX_CANDIDATE = { id: 10, name: 'Stardust Trails Booster Box', productKind: 'sealed', setName: 'Stardust Trails' }

const itemsResponse = (titles: string[], status = 200) =>
  new Response(JSON.stringify({ code: 'OK', items: titles.map((t) => ({ title: t })) }), { status })

const baseEnv = (over: any = {}) => ({
  DB: makeDb({ candidates: [BOX_CANDIDATE] }),
  SLEEVEDPAGES_KV: makeKV(),
  ...over,
})

describe('lookupUpcitemdbUpc', () => {
  it('KEYLESS default: uses the /prod/trial path with NO key headers', async () => {
    const env = baseEnv()
    const fetchFn = vi.fn(async () => itemsResponse(['Pokemon Stardust Trails Booster Box Sealed']))
    const res = await lookupUpcitemdbUpc(env as any, '196214132474', fetchFn as any)
    expect(res.found).toBe(true)
    expect(res.canonicalProductId).toBe(10)
    const [url, init] = fetchFn.mock.calls[0] as any[]
    expect(String(url)).toBe(`${UPCITEMDB_TRIAL_URL}?upc=196214132474`)
    expect(init.headers).toEqual({})
  })

  it('UPCITEMDB_KEY present → the /prod/v1 path with the user_key/key_type headers', async () => {
    const env = baseEnv({ UPCITEMDB_KEY: 'k-123' })
    const fetchFn = vi.fn(async () => itemsResponse(['Pokemon Stardust Trails Booster Box']))
    await lookupUpcitemdbUpc(env as any, '196214132474', fetchFn as any)
    const [url, init] = fetchFn.mock.calls[0] as any[]
    expect(String(url)).toBe(`${UPCITEMDB_KEYED_URL}?upc=196214132474`)
    expect(init.headers).toEqual({ user_key: 'k-123', key_type: '3scale' })
  })

  it('positive hit cached long; served-but-unmatched negative-cached ~24h', async () => {
    const env = baseEnv()
    await lookupUpcitemdbUpc(env as any, '196214132474', vi.fn(async () => itemsResponse(['Pokemon Stardust Trails Booster Box'])) as any)
    expect(env.SLEEVEDPAGES_KV._store.get(`${UPCITEMDB_UPC_PREFIX}196214132474`).ttl).toBe(UPCITEMDB_UPC_TTL)

    const env2 = baseEnv()
    const res = await lookupUpcitemdbUpc(env2 as any, '842776106230', vi.fn(async () => itemsResponse(['Totally Unrelated Blender'])) as any)
    expect(res.found).toBe(false)
    const neg = env2.SLEEVEDPAGES_KV._store.get(`${UPCITEMDB_UPC_PREFIX}842776106230`)
    expect(JSON.parse(neg.value)).toEqual({ found: false })
    expect(neg.ttl).toBe(UPCITEMDB_UPC_NEGATIVE_TTL)
  })

  it('a cached entry short-circuits with no network call', async () => {
    const env = baseEnv()
    await env.SLEEVEDPAGES_KV.put(`${UPCITEMDB_UPC_PREFIX}196214132474`, JSON.stringify({ found: false }))
    const fetchFn = vi.fn()
    const res = await lookupUpcitemdbUpc(env as any, '196214132474', fetchFn as any)
    expect(res).toEqual({ found: false, cached: true })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('429 → arms the KV backoff and misses; lookups INSIDE the backoff never fetch', async () => {
    const env = baseEnv()
    const fetchFn = vi.fn(async () => new Response('slow down', { status: 429 }))
    const res = await lookupUpcitemdbUpc(env as any, '196214132474', fetchFn as any)
    expect(res).toEqual({ found: false, skipped: 'backoff' })
    const backoff = env.SLEEVEDPAGES_KV._store.get(UPCITEMDB_BACKOFF_KEY)
    expect(backoff.ttl).toBe(UPCITEMDB_BACKOFF_TTL)
    // Second lookup while backing off — instant miss, NO fetch (never a retry loop).
    const fetchFn2 = vi.fn()
    const res2 = await lookupUpcitemdbUpc(env as any, '842776106230', fetchFn2 as any)
    expect(res2).toEqual({ found: false, skipped: 'backoff' })
    expect(fetchFn2).not.toHaveBeenCalled()
  })

  it('DAILY CAP (default well under the 100/day trial limit): at the cap → miss, no fetch', async () => {
    const env = baseEnv({ DB: makeDb({ config: { upc_upcitemdb_daily_cap: '2' }, candidates: [BOX_CANDIDATE] }) })
    await env.SLEEVEDPAGES_KV.put(`${UPCITEMDB_DAILY_COUNTER_PREFIX}${dayStamp()}`, '2')
    const fetchFn = vi.fn()
    const res = await lookupUpcitemdbUpc(env as any, '196214132474', fetchFn as any)
    expect(res).toEqual({ found: false, skipped: 'daily_cap' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('transport failure / non-OK → transient miss, never negative-cached', async () => {
    const env = baseEnv()
    const res = await lookupUpcitemdbUpc(env as any, '196214132474', vi.fn(async () => { throw new Error('net') }) as any)
    expect(res).toEqual({ found: false })
    expect(env.SLEEVEDPAGES_KV._store.has(`${UPCITEMDB_UPC_PREFIX}196214132474`)).toBe(false)

    const res2 = await lookupUpcitemdbUpc(env as any, '196214132474', vi.fn(async () => new Response('oops', { status: 500 })) as any)
    expect(res2).toEqual({ found: false })
    expect(env.SLEEVEDPAGES_KV._store.has(`${UPCITEMDB_UPC_PREFIX}196214132474`)).toBe(false)
  })
})
