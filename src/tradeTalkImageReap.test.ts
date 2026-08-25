import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// src/tradeTalkImageReap.ts — the daily trade-talk photo reaper trigger (Content mig 0137).
//
// The value-snapshots seam, again. What is pinned:
//   * the shared secret travels on `x-worker-secret`, the SAME header every inbound endpoint
//     checks, just pointed the other way,
//   * there is NO fallback origin — an unset CONTENT_APP_URL self-skips rather than guessing
//     the prod URL and having a UAT worker reap PRODUCTION photos,
//   * a real failure THROWS (so runStage records status='error'), while not-configured resolves,
//   * this worker deletes nothing: it reads counts off the response and nothing else.

import {
  runTradeTalkImageReap, tradeTalkImageReapUrl,
  TRADE_TALK_IMAGE_REAP_PATH, TRADE_TALK_IMAGE_REAP_TIMEOUT_MS,
} from './tradeTalkImageReap.js'

const SECRET = 'test-secret'
const BASE = 'https://sleevedpages.com'

const OK_BODY = { ok: true, rowsDeleted: 12, objectsDeleted: 12, remaining: 0 }

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    DB: {} as any,
    IMAGES_BUCKET: {} as any,
    INGESTION_WORKER_SECRET: SECRET,
    CONTENT_APP_URL: BASE,
    ...overrides,
  } as any
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse(OK_BODY))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('tradeTalkImageReapUrl', () => {
  it('joins the path onto the origin, with or without a trailing slash', () => {
    expect(tradeTalkImageReapUrl(BASE)).toBe(`${BASE}${TRADE_TALK_IMAGE_REAP_PATH}`)
    expect(tradeTalkImageReapUrl(`${BASE}/`)).toBe(`${BASE}${TRADE_TALK_IMAGE_REAP_PATH}`)
  })

  it('returns null for absent, blank, unparseable or non-http values', () => {
    for (const bad of [undefined, null, '', '   ', 'not a url', 'file:///etc/passwd', 'data:text/plain,x']) {
      expect(tradeTalkImageReapUrl(bad as any), String(bad)).toBeNull()
    }
  })
})

describe('runTradeTalkImageReap — configuration', () => {
  it('SELF-SKIPS when CONTENT_APP_URL is unset — it never guesses the prod origin', async () => {
    // The hazard this prevents: a UAT worker deleting PRODUCTION users' trade-talk photos.
    const res = await runTradeTalkImageReap(makeEnv({ CONTENT_APP_URL: undefined }))
    expect(res).toEqual({ ok: false, skipped: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('SELF-SKIPS when the shared secret is unset (Content would 401 it anyway)', async () => {
    const res = await runTradeTalkImageReap(makeEnv({ INGESTION_WORKER_SECRET: undefined }))
    expect(res).toEqual({ ok: false, skipped: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('runTradeTalkImageReap — the POST', () => {
  it('POSTs the Content endpoint with the shared secret and an empty JSON body', async () => {
    await runTradeTalkImageReap(makeEnv())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}${TRADE_TALK_IMAGE_REAP_PATH}`)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['x-worker-secret']).toBe(SECRET)
    expect(init.body).toBe('{}')
    expect(init.signal).toBeDefined()
    expect(TRADE_TALK_IMAGE_REAP_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it('reads the counts straight off the response — this worker computes nothing', async () => {
    const res = await runTradeTalkImageReap(makeEnv())
    expect(res).toMatchObject({ ok: true, status: 200, rowsDeleted: 12, objectsDeleted: 12, remaining: 0 })
  })

  it('surfaces a non-zero `remaining` so a batch falling behind is visible, not silent', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...OK_BODY, rowsDeleted: 500, remaining: 240 }))
    const res = await runTradeTalkImageReap(makeEnv())
    expect(res).toMatchObject({ rowsDeleted: 500, remaining: 240 })
  })
})

describe('runTradeTalkImageReap — failure is honest', () => {
  it('THROWS on a non-2xx (so runStage records status="error") and never leaks the body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'Unauthorized' }, 401))
    await expect(runTradeTalkImageReap(makeEnv())).rejects.toThrow('trade-talk image reap returned HTTP 401')
    await expect(runTradeTalkImageReap(makeEnv())).rejects.not.toThrow(/Unauthorized/)
  })

  it('THROWS on an ok:false or unparseable body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false }))
    await expect(runTradeTalkImageReap(makeEnv())).rejects.toThrow('unexpected body')
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }))
    await expect(runTradeTalkImageReap(makeEnv())).rejects.toThrow('unexpected body')
  })

  it('propagates a network failure (the cron call site is what makes it log-and-continue)', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))
    await expect(runTradeTalkImageReap(makeEnv())).rejects.toThrow('network down')
  })
})
