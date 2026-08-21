import { describe, it, expect, vi } from 'vitest'
import {
  lookupEbayUpc,
  missingEbayCredentials,
  getEbayAppToken,
  EBAY_TOKEN_URL,
  EBAY_BROWSE_SEARCH_URL,
  EBAY_TOKEN_KV_KEY,
  EBAY_UPC_PREFIX,
  EBAY_UPC_TTL,
  EBAY_UPC_NEGATIVE_TTL,
  EBAY_DAILY_COUNTER_PREFIX,
} from './ebayUpc.js'
import { dayStamp } from './upcTitleMatch.js'

// ── In-memory fakes ──────────────────────────────────────────────────────────
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

/** DB fake: app_config reads (the daily cap) + the candidate-pool query. */
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
const TITLES = [
  'Pokemon TCG Stardust Trails Booster Box NEW SEALED',
  'Stardust Trails Booster Box Factory Sealed Pokemon',
  'Stardust Trails Booster Box In Hand',
]

const tokenResponse = (token = 'tok-1', expiresIn = 7200) =>
  new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), { status: 200 })
const browseResponse = (titles: string[] = TITLES, status = 200) =>
  new Response(JSON.stringify({ itemSummaries: titles.map((t) => ({ title: t })) }), { status })

/** fetch fake routing on URL; records calls. */
function makeFetch(handlers: { token?: () => Response; browse?: () => Response }) {
  const calls: string[] = []
  const fn = vi.fn(async (url: any) => {
    const u = String(url)
    calls.push(u)
    if (u.startsWith(EBAY_TOKEN_URL)) return (handlers.token ?? (() => tokenResponse()))()
    if (u.startsWith(EBAY_BROWSE_SEARCH_URL)) return (handlers.browse ?? (() => browseResponse()))()
    throw new Error(`unexpected fetch ${u}`)
  })
  return Object.assign(fn, { calls })
}

const baseEnv = (over: any = {}) => ({
  EBAY_CLIENT_ID: 'client',
  EBAY_CLIENT_SECRET: 'secret',
  DB: makeDb({ candidates: [BOX_CANDIDATE] }),
  SLEEVEDPAGES_KV: makeKV(),
  ...over,
})

describe('getEbayAppToken', () => {
  it('fetches with client-credentials Basic auth + the api_scope, caches in KV', async () => {
    const env = baseEnv()
    const fetchFn = makeFetch({})
    const token = await getEbayAppToken(env as any, fetchFn as any)
    expect(token).toBe('tok-1')
    const [, init] = fetchFn.mock.calls[0] as any[]
    expect(init.headers.Authorization).toBe(`Basic ${btoa('client:secret')}`)
    expect(init.body).toContain('grant_type=client_credentials')
    expect(init.body).toContain(encodeURIComponent('https://api.ebay.com/oauth/api_scope'))
    expect(env.SLEEVEDPAGES_KV._store.has(EBAY_TOKEN_KV_KEY)).toBe(true)
  })

  it('serves the cached token — NEVER a token fetch per lookup', async () => {
    const env = baseEnv()
    const fetchFn = makeFetch({})
    await getEbayAppToken(env as any, fetchFn as any)
    await getEbayAppToken(env as any, fetchFn as any)
    expect(fetchFn.calls.filter((u) => u.startsWith(EBAY_TOKEN_URL)).length).toBe(1)
  })

  it('a token inside the 5-min refresh margin is NOT served — a fresh one is fetched', async () => {
    const env = baseEnv()
    await env.SLEEVEDPAGES_KV.put(EBAY_TOKEN_KV_KEY, JSON.stringify({ token: 'stale', expiresAt: Date.now() + 60_000 }))
    const fetchFn = makeFetch({ token: () => tokenResponse('fresh') })
    expect(await getEbayAppToken(env as any, fetchFn as any)).toBe('fresh')
  })

  it('throws without credentials / on a failed token request', async () => {
    await expect(getEbayAppToken(baseEnv({ EBAY_CLIENT_ID: undefined }) as any, makeFetch({}) as any)).rejects.toThrow()
    const fetchFn = makeFetch({ token: () => new Response('nope', { status: 500 }) })
    await expect(getEbayAppToken(baseEnv() as any, fetchFn as any)).rejects.toThrow(/token request failed/)
  })
})

// ── The credential guard (WP1, 2026-08-21) ───────────────────────────────────
//
// This guard ran in PRODUCTION for a week reporting `not_configured` while
// `wrangler secret list` showed both secrets present — because on Workers a secret belongs to
// a VERSION and `secret list` reports the LATEST version while traffic is served by the
// DEPLOYED one. Nothing in the response or the tail said which value was missing, or that
// anything was wrong at all. The guard is UNCHANGED (loosening it would have shipped a rung
// that 500s instead of one that falls through); what changed is that it now says so.
describe('missingEbayCredentials', () => {
  it('reports each unusable value by NAME with absent-vs-blank, and never a value', () => {
    expect(missingEbayCredentials({ EBAY_CLIENT_ID: 'id', EBAY_CLIENT_SECRET: 'sec' })).toEqual([])
    expect(missingEbayCredentials({ EBAY_CLIENT_ID: undefined, EBAY_CLIENT_SECRET: 'sec' }))
      .toEqual([{ name: 'EBAY_CLIENT_ID', reason: 'absent' }])
    // A `[vars]` entry shadowing the secret, or a shell pipe that swallowed it, lands here.
    expect(missingEbayCredentials({ EBAY_CLIENT_ID: '', EBAY_CLIENT_SECRET: '   ' })).toEqual([
      { name: 'EBAY_CLIENT_ID', reason: 'blank' },
      { name: 'EBAY_CLIENT_SECRET', reason: 'blank' },
    ])
  })
  it('the report can never leak a credential — it carries names and reasons only', () => {
    const report = missingEbayCredentials({ EBAY_CLIENT_ID: '', EBAY_CLIENT_SECRET: undefined })
    expect(JSON.stringify(report)).not.toContain('EBAY_CLIENT_ID=')
    for (const entry of report) expect(Object.keys(entry).sort()).toEqual(['name', 'reason'])
  })
})

describe('lookupEbayUpc', () => {
  it('missing credentials → CLEAN miss (skipped not_configured), no network call', async () => {
    const fetchFn = makeFetch({})
    const res = await lookupEbayUpc(baseEnv({ EBAY_CLIENT_ID: undefined }) as any, '196214132474', fetchFn as any)
    expect(res).toEqual({ found: false, skipped: 'not_configured' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('a BLANK credential is treated exactly like an absent one (an empty string is falsy)', async () => {
    const fetchFn = makeFetch({})
    const res = await lookupEbayUpc(baseEnv({ EBAY_CLIENT_SECRET: '  ' }) as any, '196214132474', fetchFn as any)
    expect(res).toEqual({ found: false, skipped: 'not_configured' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('the not-configured fallback logs at WARN, never ERROR, and names the missing value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await lookupEbayUpc(baseEnv({ EBAY_CLIENT_ID: undefined }) as any, '196214132474', makeFetch({}) as any)
    const line = warn.mock.calls.map((c) => String(c[0])).join('\n')
    expect(line).toContain('EBAY_CLIENT_ID')
    expect(line).toContain('absent')
    expect(error).not.toHaveBeenCalled()   // a handled fallback is never an error
    warn.mockRestore(); error.mockRestore()
  })

  it('confident title-aggregate match → canonical id; positive cached long', async () => {
    const env = baseEnv()
    const fetchFn = makeFetch({})
    const res = await lookupEbayUpc(env as any, '196214132474', fetchFn as any)
    expect(res.found).toBe(true)
    expect(res.canonicalProductId).toBe(10)
    expect(res.productKind).toBe('sealed')
    const cached = env.SLEEVEDPAGES_KV._store.get(`${EBAY_UPC_PREFIX}196214132474`)
    expect(cached.ttl).toBe(EBAY_UPC_TTL)
    // Browse carried the app token + the US marketplace header.
    const browseCall = fetchFn.mock.calls.find(([u]: any[]) => String(u).startsWith(EBAY_BROWSE_SEARCH_URL)) as any[]
    expect(browseCall[1].headers.Authorization).toBe('Bearer tok-1')
    expect(browseCall[1].headers['X-EBAY-C-MARKETPLACE-ID']).toBe('EBAY_US')
    expect(String(browseCall[0])).toContain('gtin=196214132474')
    expect(String(browseCall[0])).toContain('limit=20')
  })

  it('two lookups → ONE token fetch (KV-cached), two Browse calls', async () => {
    const env = baseEnv()
    const fetchFn = makeFetch({})
    await lookupEbayUpc(env as any, '196214132474', fetchFn as any)
    await lookupEbayUpc(env as any, '842776106230', fetchFn as any)
    expect(fetchFn.calls.filter((u) => u.startsWith(EBAY_TOKEN_URL)).length).toBe(1)
    expect(fetchFn.calls.filter((u) => u.startsWith(EBAY_BROWSE_SEARCH_URL)).length).toBe(2)
  })

  it('a cached result (positive or negative) short-circuits — no network at all', async () => {
    const env = baseEnv()
    await env.SLEEVEDPAGES_KV.put(`${EBAY_UPC_PREFIX}196214132474`, JSON.stringify({ found: true, canonicalProductId: 10 }))
    const fetchFn = makeFetch({})
    const res = await lookupEbayUpc(env as any, '196214132474', fetchFn as any)
    expect(res).toMatchObject({ found: true, canonicalProductId: 10, cached: true })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('DAILY CAP: at the app_config cap the lookup stops calling and misses', async () => {
    const env = baseEnv({ DB: makeDb({ config: { upc_ebay_daily_cap: '1' }, candidates: [BOX_CANDIDATE] }) })
    await env.SLEEVEDPAGES_KV.put(`${EBAY_DAILY_COUNTER_PREFIX}${dayStamp()}`, '1')
    const fetchFn = makeFetch({})
    const res = await lookupEbayUpc(env as any, '196214132474', fetchFn as any)
    expect(res).toEqual({ found: false, skipped: 'daily_cap' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('no listings / no confident match → DEFINITIVE miss, negative-cached ~24h', async () => {
    const env = baseEnv()
    const fetchFn = makeFetch({ browse: () => browseResponse([]) })
    const res = await lookupEbayUpc(env as any, '196214132474', fetchFn as any)
    expect(res.found).toBe(false)
    const cached = env.SLEEVEDPAGES_KV._store.get(`${EBAY_UPC_PREFIX}196214132474`)
    expect(JSON.parse(cached.value)).toEqual({ found: false })
    expect(cached.ttl).toBe(EBAY_UPC_NEGATIVE_TTL)
  })

  it('a Browse failure (500) is a TRANSIENT miss — never negative-cached', async () => {
    const env = baseEnv()
    const fetchFn = makeFetch({ browse: () => new Response('boom', { status: 500 }) })
    const res = await lookupEbayUpc(env as any, '196214132474', fetchFn as any)
    expect(res).toEqual({ found: false })
    expect(env.SLEEVEDPAGES_KV._store.has(`${EBAY_UPC_PREFIX}196214132474`)).toBe(false)
  })

  it('a 401 from Browse busts the token cache ONCE and retries with a fresh token', async () => {
    const env = baseEnv()
    await env.SLEEVEDPAGES_KV.put(EBAY_TOKEN_KV_KEY, JSON.stringify({ token: 'revoked', expiresAt: Date.now() + 3_600_000 }))
    let browseCalls = 0
    const fetchFn = makeFetch({
      token: () => tokenResponse('fresh'),
      browse: () => (++browseCalls === 1 ? new Response('unauthorized', { status: 401 }) : browseResponse()),
    })
    const res = await lookupEbayUpc(env as any, '196214132474', fetchFn as any)
    expect(res.found).toBe(true)
    expect(browseCalls).toBe(2)
    expect(fetchFn.calls.filter((u) => u.startsWith(EBAY_TOKEN_URL)).length).toBe(1)  // the forced refresh
  })
})
