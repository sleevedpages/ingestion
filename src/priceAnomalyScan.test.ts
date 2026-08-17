import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// src/priceAnomalyScan.ts — the nightly pricing anomaly sentinel trigger (Content mig 0129).
//
// The whole job is one authenticated POST — the value-snapshots seam, exactly. What is pinned:
//   * the shared secret travels on `x-worker-secret`, the SAME header every inbound endpoint
//     checks, just pointed the other way,
//   * there is NO fallback origin — an unset CONTENT_APP_URL self-skips rather than guessing the
//     prod URL and having a UAT worker scan the production database,
//   * a real failure THROWS (so runStage records status='error'), while not-configured resolves,
//   * this worker never prices anything: it reads counts off the response and nothing else.

import {
  runPriceAnomalyScan, anomalyScanRunUrl, ANOMALY_SCAN_RUN_PATH, ANOMALY_SCAN_REQUEST_TIMEOUT_MS,
} from './priceAnomalyScan.js'

const SECRET = 'test-secret'
const BASE = 'https://sleevedpages.com'

const OK_BODY = {
  ok: true, scanRun: 1_784_000_000, scanned: 1234, detected: 3, new: 2, resolved: 1, open: 5,
  by_rule: { graded_ceiling: 1, spike: 1, abs_ceiling: 1 },
  truncated: { ceilings: false, spike: false },
  baseline: { written: 10, truncated: false },
  ruleErrors: [],
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

describe('anomalyScanRunUrl', () => {
  it('joins the path onto the origin, with or without a trailing slash', () => {
    expect(anomalyScanRunUrl(BASE)).toBe(`${BASE}${ANOMALY_SCAN_RUN_PATH}`)
    expect(anomalyScanRunUrl(`${BASE}/`)).toBe(`${BASE}${ANOMALY_SCAN_RUN_PATH}`)
  })

  it('returns null for absent, blank, unparseable or non-http values', () => {
    for (const bad of [undefined, null, '', '   ', 'not a url', 'file:///etc/passwd', 'data:text/plain,x']) {
      expect(anomalyScanRunUrl(bad as any), String(bad)).toBeNull()
    }
  })
})

describe('runPriceAnomalyScan — configuration', () => {
  it('SELF-SKIPS when CONTENT_APP_URL is unset — it never guesses the prod origin', async () => {
    // The hazard this prevents: a UAT worker scanning (and writing anomaly rows into) prod.
    const res = await runPriceAnomalyScan(makeEnv({ CONTENT_APP_URL: undefined }))
    expect(res).toEqual({ ok: false, skipped: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('SELF-SKIPS when the shared secret is unset (it would 401 anyway)', async () => {
    const res = await runPriceAnomalyScan(makeEnv({ INGESTION_WORKER_SECRET: undefined }))
    expect(res).toEqual({ ok: false, skipped: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not THROW on a missing config — not-configured is a state, not a failure', async () => {
    await expect(runPriceAnomalyScan(makeEnv({ CONTENT_APP_URL: '' }))).resolves.toBeTruthy()
  })
})

describe('runPriceAnomalyScan — the request', () => {
  it('POSTs the internal endpoint with the shared secret header', async () => {
    await runPriceAnomalyScan(makeEnv())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}${ANOMALY_SCAN_RUN_PATH}`)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['x-worker-secret']).toBe(SECRET)
    expect(init.signal).toBeTruthy() // aborts rather than hanging on the invocation
  })

  it('honours a UAT origin instead of hardcoding prod', async () => {
    await runPriceAnomalyScan(makeEnv({ CONTENT_APP_URL: 'https://uat.pages.dev' }))
    expect(fetchMock.mock.calls[0][0]).toBe(`https://uat.pages.dev${ANOMALY_SCAN_RUN_PATH}`)
  })

  it('reads the counts back and nothing else — this worker prices nothing', async () => {
    const res = await runPriceAnomalyScan(makeEnv())
    expect(res).toMatchObject({
      ok: true, status: 200, scanRun: OK_BODY.scanRun, scanned: 1234, detected: 3,
      newAnomalies: 2, resolved: 1, open: 5,
      byRule: { graded_ceiling: 1, spike: 1, abs_ceiling: 1 },
      ruleErrors: [],
    })
  })

  it('reports a PARTIAL run (some rules failed) truthfully rather than as a failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...OK_BODY, ruleErrors: ['spike'] }))
    const res = await runPriceAnomalyScan(makeEnv())
    expect(res.ok).toBe(true)
    expect(res.ruleErrors).toEqual(['spike'])
  })

  it('has a request timeout so a hung connection cannot sit on the invocation', () => {
    expect(ANOMALY_SCAN_REQUEST_TIMEOUT_MS).toBeGreaterThan(0)
    expect(ANOMALY_SCAN_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(300_000)
  })
})

describe('runPriceAnomalyScan — failure', () => {
  it('THROWS on a non-2xx so runStage records an honest error row', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'Unauthorized' }, 401))
    await expect(runPriceAnomalyScan(makeEnv())).rejects.toThrow(/HTTP 401/)
  })

  it('never puts the response BODY in the thrown message (app internals stay out of our logs)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'SQLITE: no such table price_anomalies' }, 500))
    await expect(runPriceAnomalyScan(makeEnv())).rejects.toThrow(/^price anomaly scan returned HTTP 500$/)
  })

  it('THROWS on a 200 that is not the expected shape', async () => {
    fetchMock.mockResolvedValue(new Response('<html>maintenance</html>', { status: 200 }))
    await expect(runPriceAnomalyScan(makeEnv())).rejects.toThrow(/unexpected body/)

    fetchMock.mockResolvedValue(jsonResponse({ ok: false }))
    await expect(runPriceAnomalyScan(makeEnv())).rejects.toThrow(/unexpected body/)
  })

  it('propagates a network error (the cron call site catches it — see worker.ts)', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'))
    await expect(runPriceAnomalyScan(makeEnv())).rejects.toThrow(/connection refused/)
  })
})
