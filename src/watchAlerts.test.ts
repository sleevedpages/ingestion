import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// src/watchAlerts.ts — the Card Watch price-movement alert hook (Content migration 0117, Session 3).
//
// The whole hook is one authenticated POST of the just-refreshed (gameSlug, expansion) list. What is
// pinned mirrors the s40 snapshot seam exactly:
//   * nothing-to-do (empty list) and not-configured RESOLVE with a `skipped` reason (never throw),
//   * there is NO fallback origin — an unset CONTENT_APP_URL self-skips (the UAT worker log-skips),
//   * a real failure THROWS so the cron/job `.catch` logs it (the drain never fails on it),
//   * this worker diffs and sends nothing: it reads counts off the response and nothing else.

import {
  runWatchAlerts, watchAlertsRunUrl, WATCH_ALERTS_RUN_PATH, WATCH_ALERTS_REQUEST_TIMEOUT_MS,
} from './watchAlerts.js'

const SECRET = 'test-secret'
const BASE = 'https://sleevedpages.com'
const EXPANSIONS = [{ gameSlug: 'pokemon', expansion: 'sv08' }]

const OK_BODY = {
  ok: true, expansions: 1, watches_evaluated: 3, alerts_fired: 1,
  skipped_cooldown: 1, skipped_no_tokens: 1, send_failures: 0,
}

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

describe('watchAlertsRunUrl', () => {
  it('joins the path onto the origin, with or without a trailing slash', () => {
    expect(watchAlertsRunUrl(BASE)).toBe(`${BASE}${WATCH_ALERTS_RUN_PATH}`)
    expect(watchAlertsRunUrl(`${BASE}/`)).toBe(`${BASE}${WATCH_ALERTS_RUN_PATH}`)
  })
  it('returns null for absent, blank, unparseable or non-http values', () => {
    for (const bad of [undefined, null, '', '   ', 'not a url', 'file:///etc/passwd', 'data:text/plain,x']) {
      expect(watchAlertsRunUrl(bad as any), String(bad)).toBeNull()
    }
  })
})

describe('runWatchAlerts — nothing to do / configuration', () => {
  it('SKIPS with no fetch when the expansion list is empty', async () => {
    const res = await runWatchAlerts(makeEnv(), [])
    expect(res).toEqual({ ok: true, skipped: 'empty' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('SELF-SKIPS when CONTENT_APP_URL is unset — never guesses prod (the UAT self-skip)', async () => {
    // The hazard this prevents: a UAT worker POSTing alerts into the production app.
    const res = await runWatchAlerts(makeEnv({ CONTENT_APP_URL: undefined }), EXPANSIONS)
    expect(res).toEqual({ ok: false, skipped: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('SELF-SKIPS when the shared secret is unset (it would 401 anyway)', async () => {
    const res = await runWatchAlerts(makeEnv({ INGESTION_WORKER_SECRET: undefined }), EXPANSIONS)
    expect(res).toEqual({ ok: false, skipped: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does NOT throw on a missing config — not-configured is a state, not a failure', async () => {
    await expect(runWatchAlerts(makeEnv({ CONTENT_APP_URL: '' }), EXPANSIONS)).resolves.toBeTruthy()
  })
})

describe('runWatchAlerts — the request', () => {
  it('POSTs the internal endpoint with the shared secret + the refreshed expansion list', async () => {
    await runWatchAlerts(makeEnv(), EXPANSIONS)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}${WATCH_ALERTS_RUN_PATH}`)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['x-worker-secret']).toBe(SECRET)
    expect(JSON.parse(init.body as string)).toEqual({ expansions: EXPANSIONS })
    expect(init.signal).toBeTruthy() // aborts rather than hanging on the invocation
  })

  it('honours a UAT origin instead of hardcoding prod', async () => {
    await runWatchAlerts(makeEnv({ CONTENT_APP_URL: 'https://uat.pages.dev' }), EXPANSIONS)
    expect(fetchMock.mock.calls[0][0]).toBe(`https://uat.pages.dev${WATCH_ALERTS_RUN_PATH}`)
  })

  it('filters out malformed entries with no expansion id before sending', async () => {
    await runWatchAlerts(makeEnv(), [{ gameSlug: 'pokemon', expansion: 'sv08' }, { gameSlug: 'x' } as any, null as any])
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string))
      .toEqual({ expansions: [{ gameSlug: 'pokemon', expansion: 'sv08' }] })
  })

  it('reads the counts back and nothing else — this worker diffs/sends nothing', async () => {
    const res = await runWatchAlerts(makeEnv(), EXPANSIONS)
    expect(res).toMatchObject({
      ok: true, status: 200, expansions: 1, watchesEvaluated: 3, alertsFired: 1,
      skippedCooldown: 1, skippedNoTokens: 1, sendFailures: 0,
    })
  })

  it('has a request timeout so a hung connection cannot sit on the invocation', () => {
    expect(WATCH_ALERTS_REQUEST_TIMEOUT_MS).toBeGreaterThan(0)
    expect(WATCH_ALERTS_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(120_000)
  })
})

describe('runWatchAlerts — failure (the cron/job .catch logs it; the drain never fails on it)', () => {
  it('THROWS on a non-2xx (e.g. 503 = FCM not configured), body excluded from the message', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'Push notifications are not configured' }, 503))
    await expect(runWatchAlerts(makeEnv(), EXPANSIONS)).rejects.toThrow(/^watch-alerts run returned HTTP 503$/)
  })

  it('THROWS on a 200 that is not the expected shape', async () => {
    fetchMock.mockResolvedValue(new Response('<html>maintenance</html>', { status: 200 }))
    await expect(runWatchAlerts(makeEnv(), EXPANSIONS)).rejects.toThrow(/unexpected body/)

    fetchMock.mockResolvedValue(jsonResponse({ ok: false }))
    await expect(runWatchAlerts(makeEnv(), EXPANSIONS)).rejects.toThrow(/unexpected body/)
  })

  it('propagates a network error (the cron call site catches it — see worker.ts)', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'))
    await expect(runWatchAlerts(makeEnv(), EXPANSIONS)).rejects.toThrow(/connection refused/)
  })
})
