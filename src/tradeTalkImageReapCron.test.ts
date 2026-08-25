import { describe, it, expect, vi, afterEach } from 'vitest'

// The trade-talk-image-reap CRON case ("0 9 * * *") + its manual trigger — mirrors
// priceAnomalyScanCron.test.ts. Three things matter and none of them is about photos:
//   (1) a failure in this job must be log-and-continue and must never reach the Scrydex /
//       PriceCharting / TCG jobs,
//   (2) adding a cron case must not have stolen the DEFAULT case from the daily TCG sync, and
//   (3) ⚠️ it must not have stolen the ADJACENT slots either — the session brief proposed
//       `0 7 * * *` believing it was free, and 07:00 is the news-poll.

vi.mock('./tradeTalkImageReap.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tradeTalkImageReap.js')>()
  return { ...actual, runTradeTalkImageReap: vi.fn(async () => ({ ok: true, rowsDeleted: 3, objectsDeleted: 3, remaining: 0 })) }
})

vi.mock('./priceAnomalyScan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./priceAnomalyScan.js')>()
  return { ...actual, runPriceAnomalyScan: vi.fn(async () => ({ ok: true })) }
})

vi.mock('./valueSnapshots.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./valueSnapshots.js')>()
  return { ...actual, runValueSnapshots: vi.fn(async () => ({ ok: true })) }
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
import { runTradeTalkImageReap } from './tradeTalkImageReap.js'
import { runPriceAnomalyScan } from './priceAnomalyScan.js'
import { runValueSnapshots } from './valueSnapshots.js'
import { runIngestion } from './ingestion/index.js'
import { processPendingWebhooks } from './scrydexProcessor.js'
import { runPriceChartingFetch } from './pricechartingIngest.js'
import { runNewsPoll } from './newsPoll.js'
import { ADMIN_JOB_IDS } from './adminJobs.js'

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

describe('cron "0 9 * * *" — the trade-talk photo reap', () => {
  it('runs the reap and NOTHING else', async () => {
    const { ctx, scheduled } = collectingCtx()
    await worker.scheduled({ cron: '0 9 * * *' } as any, makeEnv(), ctx)
    await Promise.all(scheduled)

    expect(runTradeTalkImageReap).toHaveBeenCalledTimes(1)
    expect(runIngestion).not.toHaveBeenCalled()
    expect(processPendingWebhooks).not.toHaveBeenCalled()
    expect(runPriceChartingFetch).not.toHaveBeenCalled()
    expect(runNewsPoll).not.toHaveBeenCalled()
    expect(runPriceAnomalyScan).not.toHaveBeenCalled()
    expect(runValueSnapshots).not.toHaveBeenCalled()
  })

  it('LOG-AND-CONTINUE: a failing run never escapes into waitUntil', async () => {
    vi.mocked(runTradeTalkImageReap).mockRejectedValueOnce(new Error('content app is down'))
    const { ctx, scheduled } = collectingCtx()
    await worker.scheduled({ cron: '0 9 * * *' } as any, makeEnv(), ctx)
    await expect(Promise.all(scheduled)).resolves.toBeDefined()
  })

  it('the daily TCG sync still owns the DEFAULT case (a new case must not steal it)', async () => {
    const { ctx, scheduled } = collectingCtx()
    await worker.scheduled({ cron: '0 6 * * *' } as any, makeEnv(), ctx)
    await Promise.all(scheduled)
    expect(runIngestion).toHaveBeenCalledTimes(1)
    expect(runTradeTalkImageReap).not.toHaveBeenCalled()
  })

  it('⚠️ the ADJACENT slots are untouched — 07:00 is still the news-poll, 08:00 the anomaly scan, 10:00 the snapshot', async () => {
    for (const [cron, fn] of [
      ['0 7 * * *', runNewsPoll],
      ['0 8 * * *', runPriceAnomalyScan],
      ['0 10 * * *', runValueSnapshots],
    ] as const) {
      vi.clearAllMocks()
      const { ctx, scheduled } = collectingCtx()
      await worker.scheduled({ cron } as any, makeEnv(), ctx)
      await Promise.all(scheduled)
      expect(fn, cron).toHaveBeenCalledTimes(1)
      expect(runTradeTalkImageReap, cron).not.toHaveBeenCalled()
    }
  })
})

describe('POST /admin/run-job { job: "trade-talk-image-reap" }', () => {
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

  it('is a registered admin job id (so it appears in Admin → Catalog → Ingestion Jobs)', () => {
    expect(ADMIN_JOB_IDS).toContain('trade-talk-image-reap')
  })

  it('401s without the shared secret', async () => {
    const res = await post(makeEnv(), { job: 'trade-talk-image-reap' }, {})
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, error: 'Unauthorized' })
  })

  it('503s when CONTENT_APP_URL is not configured, rather than silently self-skipping', async () => {
    const res = await post(makeEnv({ CONTENT_APP_URL: undefined }), { job: 'trade-talk-image-reap' })
    expect(res.status).toBe(503)
    expect((await res.json() as any).error).toMatch(/CONTENT_APP_URL/)
  })

  it('starts the SAME function the cron runs, fire-and-forget', async () => {
    const { ctx, scheduled } = collectingCtx()
    const res = await worker.fetch(
      new Request('https://worker.test/admin/run-job', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-worker-secret': SECRET },
        body: JSON.stringify({ job: 'trade-talk-image-reap' }),
      }),
      makeEnv(),
      ctx,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, job: 'trade-talk-image-reap', started: true })
    await Promise.all(scheduled)
    expect(runTradeTalkImageReap).toHaveBeenCalledTimes(1)
  })

  it('a failing on-demand run does not reject the invocation either', async () => {
    vi.mocked(runTradeTalkImageReap).mockRejectedValueOnce(new Error('boom'))
    const { ctx, scheduled } = collectingCtx()
    await worker.fetch(
      new Request('https://worker.test/admin/run-job', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-worker-secret': SECRET },
        body: JSON.stringify({ job: 'trade-talk-image-reap' }),
      }),
      makeEnv(),
      ctx,
    )
    await expect(Promise.all(scheduled)).resolves.toBeDefined()
  })
})
