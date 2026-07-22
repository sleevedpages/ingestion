import { describe, it, expect, vi, afterEach } from 'vitest'

// The value-snapshot CRON case + its manual trigger.
//
// Two things matter here and neither is about snapshots: (1) a failure in this job must be
// log-and-continue and must never reach the Scrydex / PriceCharting / TCG jobs, and (2) adding a
// cron case must not have stolen the default case from the daily TCG sync.

vi.mock('./valueSnapshots.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./valueSnapshots.js')>()
  return { ...actual, runValueSnapshots: vi.fn(async () => ({ ok: true, written: 2 })) }
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

import worker from './worker.js'
import { runValueSnapshots } from './valueSnapshots.js'
import { runIngestion } from './ingestion/index.js'
import { processPendingWebhooks } from './scrydexProcessor.js'
import { runPriceChartingFetch } from './pricechartingIngest.js'

const SECRET = 'test-secret'

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    // A bare {} DB is the established shape here — writeRunLog catches its own failure and can
    // never mask (or replace) the stage's outcome.
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

describe('cron "0 10 * * *" — the value snapshot run', () => {
  it('runs the snapshot job and NOTHING else', async () => {
    const { ctx, scheduled } = collectingCtx()
    await worker.scheduled({ cron: '0 10 * * *' } as any, makeEnv(), ctx)
    await Promise.all(scheduled)

    expect(runValueSnapshots).toHaveBeenCalledTimes(1)
    // The jobs this must never disturb.
    expect(runIngestion).not.toHaveBeenCalled()
    expect(processPendingWebhooks).not.toHaveBeenCalled()
    expect(runPriceChartingFetch).not.toHaveBeenCalled()
  })

  it('LOG-AND-CONTINUE: a failing run never escapes into waitUntil', async () => {
    vi.mocked(runValueSnapshots).mockRejectedValueOnce(new Error('content app is down'))
    const { ctx, scheduled } = collectingCtx()

    await worker.scheduled({ cron: '0 10 * * *' } as any, makeEnv(), ctx)

    // An unhandled rejection here would mark the whole scheduled invocation as failed.
    await expect(Promise.all(scheduled)).resolves.toBeDefined()
  })

  it('the daily TCG sync still owns the DEFAULT case (a new case must not steal it)', async () => {
    const { ctx, scheduled } = collectingCtx()
    await worker.scheduled({ cron: '0 6 * * *' } as any, makeEnv(), ctx)
    await Promise.all(scheduled)

    expect(runIngestion).toHaveBeenCalledTimes(1)
    expect(runValueSnapshots).not.toHaveBeenCalled()
  })
})

describe('POST /admin/run-job { job: "value-snapshots" }', () => {
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
    const res = await post(makeEnv(), { job: 'value-snapshots' }, {})
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, error: 'Unauthorized' })
  })

  it('503s when CONTENT_APP_URL is not configured, rather than silently self-skipping', async () => {
    const res = await post(makeEnv({ CONTENT_APP_URL: undefined }), { job: 'value-snapshots' })
    expect(res.status).toBe(503)
    expect((await res.json() as any).error).toMatch(/CONTENT_APP_URL/)
  })

  it('starts the SAME function the cron runs, fire-and-forget', async () => {
    const { ctx, scheduled } = collectingCtx()
    const res = await worker.fetch(
      new Request('https://worker.test/admin/run-job', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-worker-secret': SECRET },
        body: JSON.stringify({ job: 'value-snapshots' }),
      }),
      makeEnv(),
      ctx,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, job: 'value-snapshots', started: true })

    await Promise.all(scheduled)
    expect(runValueSnapshots).toHaveBeenCalledTimes(1)
  })

  it('a failing on-demand run does not reject the invocation either', async () => {
    vi.mocked(runValueSnapshots).mockRejectedValueOnce(new Error('boom'))
    const { ctx, scheduled } = collectingCtx()
    await worker.fetch(
      new Request('https://worker.test/admin/run-job', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-worker-secret': SECRET },
        body: JSON.stringify({ job: 'value-snapshots' }),
      }),
      makeEnv(),
      ctx,
    )
    await expect(Promise.all(scheduled)).resolves.toBeDefined()
  })
})
