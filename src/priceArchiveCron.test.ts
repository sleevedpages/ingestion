import { describe, it, expect, vi, afterEach } from 'vitest'

// The price-archive-capture CRON case + its manual trigger (the valueSnapshotsCron pattern).
//
// What matters here is not archiving: (1) a failure in this job is log-and-continue and can
// never reach the Scrydex / PriceCharting / TCG jobs, (2) the new cron case must not have
// stolen the default case from the daily TCG sync, and (3) the manual job runs the SAME
// function the cron runs, behind the same 503-when-unconfigured guard the other three
// Content-calling jobs share.

vi.mock('./priceArchive.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./priceArchive.js')>()
  return { ...actual, runPriceArchive: vi.fn(async () => ({ ok: true, done: true, partsWritten: 3 })) }
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

vi.mock('./valueSnapshots.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./valueSnapshots.js')>()
  return { ...actual, runValueSnapshots: vi.fn(async () => ({ ok: true })) }
})

import worker from './worker.js'
import { runPriceArchive } from './priceArchive.js'
import { runIngestion } from './ingestion/index.js'
import { processPendingWebhooks } from './scrydexProcessor.js'
import { runPriceChartingFetch } from './pricechartingIngest.js'
import { runValueSnapshots } from './valueSnapshots.js'

const SECRET = 'test-secret'

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    DB: {} as any, // the established bare-{} shape — writeRunLog absorbs its own failure
    IMAGES_BUCKET: {} as any,
    INGESTION_WORKER_SECRET: SECRET,
    CONTENT_APP_URL: 'https://sleevedpages.com',
    SCRYDEX_API_KEY: 'k',
    SCRYDEX_TEAM_ID: 't',
    PRICECHARTING_TOKEN: 'p',
    ...overrides,
  } as any
}

function collectingCtx() {
  const scheduled: Promise<unknown>[] = []
  return {
    scheduled,
    ctx: { waitUntil: (p: Promise<unknown>) => { scheduled.push(p) } } as any,
  }
}

afterEach(() => { vi.clearAllMocks() })

describe('cron "0 12 * * *" — the price archive capture', () => {
  it('runs the capture job and NOTHING else', async () => {
    const { ctx, scheduled } = collectingCtx()
    await worker.scheduled({ cron: '0 12 * * *' } as any, makeEnv(), ctx)
    await Promise.all(scheduled)

    expect(runPriceArchive).toHaveBeenCalledTimes(1)
    expect(runIngestion).not.toHaveBeenCalled()
    expect(processPendingWebhooks).not.toHaveBeenCalled()
    expect(runPriceChartingFetch).not.toHaveBeenCalled()
    expect(runValueSnapshots).not.toHaveBeenCalled()
  })

  it('LOG-AND-CONTINUE: a failing run never escapes into waitUntil', async () => {
    vi.mocked(runPriceArchive).mockRejectedValueOnce(new Error('content app is down'))
    const { ctx, scheduled } = collectingCtx()

    await worker.scheduled({ cron: '0 12 * * *' } as any, makeEnv(), ctx)

    await expect(Promise.all(scheduled)).resolves.toBeDefined()
  })

  it('the daily TCG sync still owns the DEFAULT case (a new case must not steal it)', async () => {
    const { ctx, scheduled } = collectingCtx()
    await worker.scheduled({ cron: '0 6 * * *' } as any, makeEnv(), ctx)
    await Promise.all(scheduled)

    expect(runIngestion).toHaveBeenCalledTimes(1)
    expect(runPriceArchive).not.toHaveBeenCalled()
  })
})

describe('POST /admin/run-job { job: "price-archive-capture" }', () => {
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
    const res = await post(makeEnv(), { job: 'price-archive-capture' }, {})
    expect(res.status).toBe(401)
  })

  it('503s when CONTENT_APP_URL is not configured, rather than silently self-skipping', async () => {
    const res = await post(makeEnv({ CONTENT_APP_URL: undefined }), { job: 'price-archive-capture' })
    expect(res.status).toBe(503)
    expect((await res.json() as any).error).toMatch(/CONTENT_APP_URL/)
  })

  it('starts the SAME function the cron runs, fire-and-forget', async () => {
    const { ctx, scheduled } = collectingCtx()
    const res = await worker.fetch(
      new Request('https://worker.test/admin/run-job', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-worker-secret': SECRET },
        body: JSON.stringify({ job: 'price-archive-capture' }),
      }),
      makeEnv(),
      ctx,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, job: 'price-archive-capture', started: true })

    await Promise.all(scheduled)
    expect(runPriceArchive).toHaveBeenCalledTimes(1)
  })

  it('a failing on-demand run does not reject the invocation either', async () => {
    vi.mocked(runPriceArchive).mockRejectedValueOnce(new Error('boom'))
    const { ctx, scheduled } = collectingCtx()
    await worker.fetch(
      new Request('https://worker.test/admin/run-job', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-worker-secret': SECRET },
        body: JSON.stringify({ job: 'price-archive-capture' }),
      }),
      makeEnv(),
      ctx,
    )
    await expect(Promise.all(scheduled)).resolves.toBeDefined()
  })
})
