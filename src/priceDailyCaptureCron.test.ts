import { describe, it, expect, vi, afterEach } from 'vitest'

// The price-daily-capture CRON case (`0 13 * * *`) + its manual trigger (the priceArchiveCron
// pattern). What matters here: (1) a failure is log-and-continue and can never reach another job,
// (2) the new case has not stolen the default case from the daily TCG sync nor the 12:00 capture,
// (3) the manual job runs the SAME function the cron runs, behind the same 503-when-unconfigured
// guard the other Content-calling jobs share, and (4) the trigger is registered in wrangler.toml.

vi.mock('./priceDailyCapture.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./priceDailyCapture.js')>()
  return { ...actual, runPriceDailyCapture: vi.fn(async () => ({ ok: true, done: true, calls: 1 })) }
})

vi.mock('./priceArchive.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./priceArchive.js')>()
  return { ...actual, runPriceArchive: vi.fn(async () => ({ ok: true, done: true })) }
})

vi.mock('./ingestion/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ingestion/index.js')>()
  return { ...actual, runIngestion: vi.fn(async () => ({})) }
})

vi.mock('./scrydexProcessor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scrydexProcessor.js')>()
  return { ...actual, processPendingWebhooks: vi.fn(async () => ({})) }
})

import { readFileSync } from 'node:fs'
import worker from './worker.js'
import { runPriceDailyCapture } from './priceDailyCapture.js'
import { runPriceArchive } from './priceArchive.js'
import { runIngestion } from './ingestion/index.js'
import { processPendingWebhooks } from './scrydexProcessor.js'

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

function collectingCtx() {
  const scheduled: Promise<unknown>[] = []
  return {
    scheduled,
    ctx: { waitUntil: (p: Promise<unknown>) => { scheduled.push(p) } } as any,
  }
}

afterEach(() => { vi.clearAllMocks() })

describe('cron "0 13 * * *" — the price_daily projection', () => {
  it('runs the projection job and NOTHING else', async () => {
    const { ctx, scheduled } = collectingCtx()
    await worker.scheduled({ cron: '0 13 * * *' } as any, makeEnv(), ctx)
    await Promise.all(scheduled)

    expect(runPriceDailyCapture).toHaveBeenCalledTimes(1)
    expect(runPriceArchive).not.toHaveBeenCalled()
    expect(runIngestion).not.toHaveBeenCalled()
    expect(processPendingWebhooks).not.toHaveBeenCalled()
  })

  it('LOG-AND-CONTINUE: a failing run never escapes into waitUntil', async () => {
    vi.mocked(runPriceDailyCapture).mockRejectedValueOnce(new Error('content app is down'))
    const { ctx, scheduled } = collectingCtx()
    await worker.scheduled({ cron: '0 13 * * *' } as any, makeEnv(), ctx)
    await expect(Promise.all(scheduled)).resolves.toBeDefined()
  })

  it('the 12:00 capture and the 06:00 sync keep their own cases', async () => {
    const a = collectingCtx()
    await worker.scheduled({ cron: '0 12 * * *' } as any, makeEnv(), a.ctx)
    await Promise.all(a.scheduled)
    expect(runPriceArchive).toHaveBeenCalledTimes(1)
    expect(runPriceDailyCapture).not.toHaveBeenCalled()

    const b = collectingCtx()
    await worker.scheduled({ cron: '0 6 * * *' } as any, makeEnv(), b.ctx)
    await Promise.all(b.scheduled)
    expect(runIngestion).toHaveBeenCalledTimes(1)
    expect(runPriceDailyCapture).not.toHaveBeenCalled()
  })

  it('is registered in the PROD triggers, one hour after the 12:00 capture, and NOT in preview', () => {
    const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8')
    // Two `crons = [...]` lines: the first is [triggers] (prod), the last [env.preview.triggers].
    const cronLines = [...toml.matchAll(/^crons = \[(.*)\]/gm)].map((m) => m[1])
    expect(cronLines.length).toBeGreaterThanOrEqual(2)
    expect(cronLines[0]).toContain('"0 12 * * *"')
    expect(cronLines[0]).toContain('"0 13 * * *"')
    expect(cronLines[cronLines.length - 1]).not.toContain('0 13 * * *')
  })
})

describe('POST /admin/run-job { job: "price-daily-capture" }', () => {
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
    const res = await post(makeEnv(), { job: 'price-daily-capture' }, {})
    expect(res.status).toBe(401)
  })

  it('503s when CONTENT_APP_URL is not configured, rather than silently self-skipping', async () => {
    const res = await post(makeEnv({ CONTENT_APP_URL: undefined }), { job: 'price-daily-capture' })
    expect(res.status).toBe(503)
    expect((await res.json() as any).error).toMatch(/CONTENT_APP_URL/)
  })

  it('starts the SAME function the cron runs, fire-and-forget', async () => {
    const { ctx, scheduled } = collectingCtx()
    const res = await worker.fetch(
      new Request('https://worker.test/admin/run-job', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-worker-secret': SECRET },
        body: JSON.stringify({ job: 'price-daily-capture' }),
      }),
      makeEnv(),
      ctx,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, job: 'price-daily-capture', started: true })

    await Promise.all(scheduled)
    expect(runPriceDailyCapture).toHaveBeenCalledTimes(1)
  })
})
