import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// src/valueSnapshots.ts — the daily inventory-value snapshot trigger (Content migration 0115).
//
// The whole job is one authenticated POST. What is pinned:
//   * the shared secret travels on `x-worker-secret`, the SAME header every inbound endpoint
//     checks, just pointed the other way,
//   * there is NO fallback origin — an unset CONTENT_APP_URL self-skips rather than guessing the
//     prod URL and having a UAT worker write into the production database,
//   * a real failure THROWS (so runStage records status='error'), while not-configured resolves,
//   * this worker never prices anything: it reads counts off the response and nothing else.

import {
  runValueSnapshots, snapshotRunUrl, SNAPSHOT_RUN_PATH, SNAPSHOT_REQUEST_TIMEOUT_MS,
} from './valueSnapshots.js'

const SECRET = 'test-secret'
const BASE = 'https://sleevedpages.com'

const OK_BODY = {
  ok: true, dayStart: 1_784_000_000, tzOffsetMinutes: -420,
  profiles: 3, written: 3, skipped: 0, errors: 0, truncated: false,
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

describe('snapshotRunUrl', () => {
  it('joins the path onto the origin, with or without a trailing slash', () => {
    expect(snapshotRunUrl(BASE)).toBe(`${BASE}${SNAPSHOT_RUN_PATH}`)
    expect(snapshotRunUrl(`${BASE}/`)).toBe(`${BASE}${SNAPSHOT_RUN_PATH}`)
  })

  it('returns null for absent, blank, unparseable or non-http values', () => {
    for (const bad of [undefined, null, '', '   ', 'not a url', 'file:///etc/passwd', 'data:text/plain,x']) {
      expect(snapshotRunUrl(bad as any), String(bad)).toBeNull()
    }
  })
})

describe('runValueSnapshots — configuration', () => {
  it('SELF-SKIPS when CONTENT_APP_URL is unset — it never guesses the prod origin', async () => {
    // The hazard this prevents: a UAT worker writing snapshots into the production database.
    const res = await runValueSnapshots(makeEnv({ CONTENT_APP_URL: undefined }))
    expect(res).toEqual({ ok: false, skipped: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('SELF-SKIPS when the shared secret is unset (it would 401 anyway)', async () => {
    const res = await runValueSnapshots(makeEnv({ INGESTION_WORKER_SECRET: undefined }))
    expect(res).toEqual({ ok: false, skipped: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not THROW on a missing config — not-configured is a state, not a failure', async () => {
    await expect(runValueSnapshots(makeEnv({ CONTENT_APP_URL: '' }))).resolves.toBeTruthy()
  })
})

describe('runValueSnapshots — the request', () => {
  it('POSTs the internal endpoint with the shared secret header', async () => {
    await runValueSnapshots(makeEnv())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}${SNAPSHOT_RUN_PATH}`)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['x-worker-secret']).toBe(SECRET)
    expect(init.signal).toBeTruthy() // aborts rather than hanging on the invocation
  })

  it('honours a UAT origin instead of hardcoding prod', async () => {
    await runValueSnapshots(makeEnv({ CONTENT_APP_URL: 'https://uat.pages.dev' }))
    expect(fetchMock.mock.calls[0][0]).toBe(`https://uat.pages.dev${SNAPSHOT_RUN_PATH}`)
  })

  it('reads the counts back and nothing else — this worker prices nothing', async () => {
    const res = await runValueSnapshots(makeEnv())
    expect(res).toMatchObject({
      ok: true, status: 200, profiles: 3, written: 3, skippedProfiles: 0, errors: 0,
      dayStart: OK_BODY.dayStart, tzOffsetMinutes: -420, truncated: false,
    })
  })

  it('reports a PARTIAL run truthfully rather than as a failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...OK_BODY, written: 2, errors: 1, failedProfileIds: [2] }))
    const res = await runValueSnapshots(makeEnv())
    expect(res.ok).toBe(true)
    expect(res.written).toBe(2)
    expect(res.errors).toBe(1)
  })

  it('has a request timeout so a hung connection cannot sit on the invocation', () => {
    expect(SNAPSHOT_REQUEST_TIMEOUT_MS).toBeGreaterThan(0)
    expect(SNAPSHOT_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(120_000)
  })
})

describe('runValueSnapshots — failure', () => {
  it('THROWS on a non-2xx so runStage records an honest error row', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'Unauthorized' }, 401))
    await expect(runValueSnapshots(makeEnv())).rejects.toThrow(/HTTP 401/)
  })

  it('never puts the response BODY in the thrown message (app internals stay out of our logs)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'SQLITE: no such column secret_thing' }, 500))
    await expect(runValueSnapshots(makeEnv())).rejects.toThrow(/^snapshot run returned HTTP 500$/)
  })

  it('THROWS on a 200 that is not the expected shape', async () => {
    fetchMock.mockResolvedValue(new Response('<html>maintenance</html>', { status: 200 }))
    await expect(runValueSnapshots(makeEnv())).rejects.toThrow(/unexpected body/)

    fetchMock.mockResolvedValue(jsonResponse({ ok: false }))
    await expect(runValueSnapshots(makeEnv())).rejects.toThrow(/unexpected body/)
  })

  it('propagates a network error (the cron call site catches it — see worker.ts)', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'))
    await expect(runValueSnapshots(makeEnv())).rejects.toThrow(/connection refused/)
  })
})
