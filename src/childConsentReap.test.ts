import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// src/childConsentReap.ts — the daily trigger for Content's unconfirmed-consent reaper
// (Content child-accounts S2). The tradeTalkImageReap seam, pinned the same way:
//   * the shared secret travels on `x-worker-secret`,
//   * NO fallback origin — an unset CONTENT_APP_URL self-skips (a UAT worker must never delete
//     PRODUCTION children),
//   * a real failure THROWS (runStage records status='error'); not-configured resolves,
//   * this worker deletes nothing and logs counts only — never an id.

import { runChildConsentReap, childConsentReapUrl, CHILD_CONSENT_REAP_PATH } from './childConsentReap.js'
import worker from './worker.js'
import { ADMIN_JOB_IDS } from './adminJobs.js'

const SECRET = 'test-secret'
const BASE = 'https://sleevedpages.com'
const OK_BODY = { ok: true, deleted: 2, failed: 0, remaining: 0 }

const makeEnv = (overrides: Record<string, unknown> = {}) =>
  ({ DB: {} as any, INGESTION_WORKER_SECRET: SECRET, CONTENT_APP_URL: BASE, ...overrides }) as any
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => { fetchMock = vi.fn(async () => jsonResponse(OK_BODY)); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('childConsentReapUrl', () => {
  it('joins the path onto the origin; refuses empty and non-http(s)', () => {
    expect(childConsentReapUrl(BASE)).toBe(`${BASE}${CHILD_CONSENT_REAP_PATH}`)
    expect(childConsentReapUrl(`${BASE}/`)).toBe(`${BASE}${CHILD_CONSENT_REAP_PATH}`)
    expect(childConsentReapUrl('')).toBeNull()
    expect(childConsentReapUrl(undefined)).toBeNull()
    expect(childConsentReapUrl('file:///etc/passwd')).toBeNull()
  })
  it('the path is the one Content serves', () => {
    expect(CHILD_CONSENT_REAP_PATH).toBe('/api/internal/child-consents/reap')
  })
})

describe('runChildConsentReap', () => {
  it('POSTs once with the shared secret and returns the counts', async () => {
    const r = await runChildConsentReap(makeEnv())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}${CHILD_CONSENT_REAP_PATH}`)
    expect(init.method).toBe('POST')
    expect(init.headers['x-worker-secret']).toBe(SECRET)
    expect(r).toEqual({ ok: true, status: 200, deleted: 2, failed: 0, remaining: 0 })
  })
  it('self-skips (resolves, no fetch) without CONTENT_APP_URL or the secret — never a fallback origin', async () => {
    expect(await runChildConsentReap(makeEnv({ CONTENT_APP_URL: undefined }))).toEqual({ ok: false, skipped: 'not_configured' })
    expect(await runChildConsentReap(makeEnv({ INGESTION_WORKER_SECRET: undefined }))).toEqual({ ok: false, skipped: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('THROWS on a non-2xx or an unexpected body (so runStage records the error)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, error: 'Unauthorized' }, 401))
    await expect(runChildConsentReap(makeEnv())).rejects.toThrow(/HTTP 401/)
    fetchMock.mockResolvedValueOnce(jsonResponse({ nope: true }))
    await expect(runChildConsentReap(makeEnv())).rejects.toThrow(/unexpected body/)
  })
})

describe('POST /admin/run-job { job: "child-consent-reap" } — how UAT drives it', () => {
  const post = (env: any, headers: Record<string, string> = { 'x-worker-secret': SECRET }) => {
    const scheduled: Promise<unknown>[] = []
    const ctx = { waitUntil: (p: Promise<unknown>) => { scheduled.push(p) } } as any
    return worker.fetch(new Request('https://worker.test/admin/run-job', {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ job: 'child-consent-reap' }),
    }), env, ctx).then(res => ({ res, scheduled }))
  }
  it('is a registered admin job id', () => { expect(ADMIN_JOB_IDS).toContain('child-consent-reap') })
  it('401 without the secret; 503 without CONTENT_APP_URL; otherwise starts the job', async () => {
    expect((await post(makeEnv(), {})).res.status).toBe(401)
    expect((await post(makeEnv({ CONTENT_APP_URL: undefined }))).res.status).toBe(503)
    const { res, scheduled } = await post(makeEnv({ DB: { prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => null }) }) } }))
    expect(res.status).toBe(200)
    await Promise.allSettled(scheduled)
    expect(fetchMock.mock.calls.some(c => String(c[0]).endsWith(CHILD_CONSENT_REAP_PATH))).toBe(true)
  })
})
