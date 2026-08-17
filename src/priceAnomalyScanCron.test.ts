import { describe, it, expect, vi, afterEach } from 'vitest'

// The price-anomaly-scan CRON case ("0 8 * * *") + its manual trigger — mirrors
// valueSnapshotsCron.test.ts. Two things matter and neither is about anomalies: (1) a failure
// in this job must be log-and-continue and must never reach the Scrydex / PriceCharting / TCG
// jobs, and (2) adding a cron case must not have stolen the default case from the daily
// TCG sync.

vi.mock('./priceAnomalyScan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./priceAnomalyScan.js')>()
  return { ...actual, runPriceAnomalyScan: vi.fn(async () => ({ ok: true, detected: 1 })) }
})

vi.mock('./ingestion/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ingestion/index.js')>()
  return { ...actual, runIngestion: vi.fn(async () => ({})) }
})

vi.mock('./scrydexProcessor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scrydexProcessor.js')>()
  return { ...actual, processPendingWebhooks: vi.fn(async () => ({})) }
})

vi.mock('./pricechartingIngest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pricechartingIngest.js')>()
  return { ...actual, runPriceChartingFetch: vi.fn(async () => ({})) }
})

vi.mock('./newsPoll.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./newsPoll.js')>()
  return { ...actual, runNewsPoll: vi.fn(async () => ({})) }
})

import worker from './worker.js'
import { runPriceAnomalyScan } from './priceAnomalyScan.js'
import { runIngestion } from './ingestion/index.js'
import { processPendingWebhooks } from './scrydexProcessor.js'
import { runPriceChartingFetch } from './pricechartingIngest.js'
import { runNewsPoll } from './newsPoll.js'

const SECRET = 'test-secret'

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    DB: {} as any,
    IMAGES_BUCKET: {} as any,
    INGESTION_WORKER_SECRET: SECRET,
    CONTENT_APP_URL: 'https://sleevedpages.com',
    SCRYDEX_API_KEY: 'k',
    SCRYDEX_TEAM_ID: 't',
    PRICECHARTING_TOKEN: 'p',
    ...overrides,
  } as any
}

/** Collects the scheduled promises so a test can await them and assert they never reject. */
function collectingCtx() {
  const scheduled: Promise<unknown>[] = []
  return {
    scheduled,
    ctx: { waitUntil: (p: Promise<unknown>) => { scheduled.push(p) } } as any,
  }
}

afterEach(() => { vi.clearAllMocks() })

describe('cron "0 8 * * *" — the price anomaly scan', () => {
  it('runs the scan and NOTHING else', async () => {
    const { ctx, scheduled } = collectingCtx()
    await worker.scheduled({ cron: '0 8 * * *' } as any, makeEnv(), ctx)
    await Promise.all(scheduled)

    expect(runPriceAnomalyScan).toHaveBeenCalledTimes(1)
    // The jobs this must never disturb.
    expect(runIngestion).not.toHaveBeenCalled()
    expect(processPendingWebhooks).not.toHaveBeenCalled()
    expect(runPriceChartingFetch).not.toHaveBeenCalled()
    expect(runNewsPoll).not.toHaveBeenCalled()
  })

  it('LOG-AND-CONTINUE: a failing run never escapes into waitUntil', async () => {
    vi.mocked(runPriceAnomalyScan).mockRejectedValueOnce(new Error('content app is down'))
    const { ctx, scheduled } = collectingCtx()

    await worker.scheduled({ cron: '0 8 * * *' } as any, makeEnv(), ctx)

    // An unhandled rejection here would mark the whole scheduled invocation as failed.
    await expect(Promise.all(scheduled)).resolves.toBeDefined()
  })

  it('the daily TCG sync still owns the DEFAULT case (a new case must not steal it)', async () => {
    const { ctx, scheduled } = collectingCtx()
    await worker.scheduled({ cron: '0 6 * * *' } as any, makeEnv(), ctx)
    await Promise.all(scheduled)

    expect(runIngestion).toHaveBeenCalledTimes(1)
    expect(runPriceAnomalyScan).not.toHaveBeenCalled()
  })

  it('the 07:00 news-poll slot was NOT stolen either (adjacent case)', async () => {
    const { ctx, scheduled } = collectingCtx()
    await worker.scheduled({ cron: '0 7 * * *' } as any, makeEnv(), ctx)
    await Promise.all(scheduled)

    expect(runNewsPoll).toHaveBeenCalledTimes(1)
    expect(runPriceAnomalyScan).not.toHaveBeenCalled()
  })
})

describe('POST /admin/run-job { job: "price-anomaly-scan" }', () => {
  const post = (env: any, body: unknown, headers: Record<string, string> = { 'x-worker-secret': SECRET }) =>
    worker.fetch(
      new Request('https://worker.test/admin/run-job', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
      env,
      collectingCtx().ctx,
    )

  it('401s without the shared secret', async () => {
    const res = await post(makeEnv(), { job: 'price-anomaly-scan' }, {})
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, error: 'Unauthorized' })
  })

  it('503s when CONTENT_APP_URL is not configured, rather than silently self-skipping', async () => {
    const res = await post(makeEnv({ CONTENT_APP_URL: undefined }), { job: 'price-anomaly-scan' })
    expect(res.status).toBe(503)
    expect((await res.json() as any).error).toMatch(/CONTENT_APP_URL/)
  })

  it('starts the SAME function the cron runs, fire-and-forget', async () => {
    const { ctx, scheduled } = collectingCtx()
    const res = await worker.fetch(
      new Request('https://worker.test/admin/run-job', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-worker-secret': SECRET },
        body: JSON.stringify({ job: 'price-anomaly-scan' }),
      }),
      makeEnv(),
      ctx,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, job: 'price-anomaly-scan', started: true })

    await Promise.all(scheduled)
    expect(runPriceAnomalyScan).toHaveBeenCalledTimes(1)
  })

  it('a failing on-demand run does not reject the invocation either', async () => {
    vi.mocked(runPriceAnomalyScan).mockRejectedValueOnce(new Error('boom'))
    const { ctx, scheduled } = collectingCtx()
    await worker.fetch(
      new Request('https://worker.test/admin/run-job', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-worker-secret': SECRET },
        body: JSON.stringify({ job: 'price-anomaly-scan' }),
      }),
      makeEnv(),
      ctx,
    )
    await expect(Promise.all(scheduled)).resolves.toBeDefined()
  })
})
