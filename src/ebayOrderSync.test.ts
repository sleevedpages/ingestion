import { describe, it, expect, vi, afterEach } from 'vitest'
import { runEbayOrderSync, ebayOrderSyncUrl, EBAY_ORDER_SYNC_PATH } from './ebayOrderSync.js'

// The eBay order-sync seam (eBay Sell Phase 3, Content mig 0133) — the valueSnapshots.ts
// contract, exactly: one authenticated POST into Content, CONTENT_APP_URL required with
// no default, self-skip (never throw) when not configured, throw on genuine failure so
// runStage records an honest error row, and a Content-side config skip is a STATE, not
// an error.

const ENV = (over: Record<string, unknown> = {}) => ({
  CONTENT_APP_URL: 'https://sleevedpages.com',
  INGESTION_WORKER_SECRET: 'shhh',
  ...over,
}) as any

afterEach(() => vi.unstubAllGlobals())

describe('ebayOrderSyncUrl', () => {
  it('resolves the endpoint against the configured origin, http(s) only', () => {
    expect(ebayOrderSyncUrl('https://sleevedpages.com')).toBe(`https://sleevedpages.com${EBAY_ORDER_SYNC_PATH}`)
    expect(ebayOrderSyncUrl('')).toBe(null)
    expect(ebayOrderSyncUrl(undefined)).toBe(null)
    expect(ebayOrderSyncUrl('file:///etc/passwd')).toBe(null)
    expect(ebayOrderSyncUrl('not a url')).toBe(null)
  })
})

describe('runEbayOrderSync', () => {
  it('self-skips (never throws) when CONTENT_APP_URL or the secret is unset', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(await runEbayOrderSync(ENV({ CONTENT_APP_URL: undefined }))).toEqual({ ok: false, skipped: 'not_configured' })
    expect(await runEbayOrderSync(ENV({ INGESTION_WORKER_SECRET: undefined }))).toEqual({ ok: false, skipped: 'not_configured' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('POSTs the shared secret to the sync endpoint and returns the counts', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      ok: true, accounts: 1, synced: 1, skippedRecent: 0,
      decremented: 2, needsAttention: 1, errors: 0, truncated: false,
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    const res = await runEbayOrderSync(ENV())
    expect(res.ok).toBe(true)
    expect(res.decremented).toBe(2)
    expect(res.needsAttention).toBe(1)

    const [url, init] = fetchSpy.mock.calls[0] as any
    expect(String(url)).toBe(`https://sleevedpages.com${EBAY_ORDER_SYNC_PATH}`)
    expect(init.method).toBe('POST')
    expect(init.headers['x-worker-secret']).toBe('shhh')
  })

  it('a Content-side config skip (feature dark / sync disabled) is a state, not a failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, skipped: 'feature_dark', accounts: 0 }), { status: 200 })))
    const res = await runEbayOrderSync(ENV())
    expect(res.ok).toBe(true)
    expect(res.skipped).toBe('feature_dark')
  })

  it('THROWS on a non-2xx / unexpected body so runStage records an honest error row', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })))
    await expect(runEbayOrderSync(ENV())).rejects.toThrow(/HTTP 401/)

    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(runEbayOrderSync(ENV())).rejects.toThrow(/unexpected body/)
  })
})
