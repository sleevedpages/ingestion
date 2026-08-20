import { describe, it, expect, vi, afterEach } from 'vitest'

// The eBay order-sync CRON case (`*/15 * * * *`, eBay Sell Phase 3, Content mig 0133).
//
// Two things matter here and neither is about orders: (1) a failure in this job must be
// log-and-continue and must never reach the Scrydex / PriceCharting / TCG jobs, and
// (2) adding a cron case must not have stolen the default case from the daily TCG sync.

vi.mock('./ebayOrderSync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ebayOrderSync.js')>()
  return { ...actual, runEbayOrderSync: vi.fn(async () => ({ ok: true, decremented: 1 })) }
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
import { runEbayOrderSync } from './ebayOrderSync.js'
import { runIngestion } from './ingestion/index.js'
import { processPendingWebhooks } from './scrydexProcessor.js'
import { runPriceChartingFetch } from './pricechartingIngest.js'

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    DB: {} as any,
    IMAGES_BUCKET: {} as any,
    INGESTION_WORKER_SECRET: 'test-secret',
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

describe('cron "*/15 * * * *" — the eBay order sync', () => {
  it('runs the order-sync job and NOTHING else', async () => {
    const { ctx, scheduled } = collectingCtx()
    await worker.scheduled({ cron: '*/15 * * * *' } as any, makeEnv(), ctx)
    await Promise.all(scheduled)

    expect(runEbayOrderSync).toHaveBeenCalledTimes(1)
    // The jobs this must never disturb.
    expect(runIngestion).not.toHaveBeenCalled()
    expect(processPendingWebhooks).not.toHaveBeenCalled()
    expect(runPriceChartingFetch).not.toHaveBeenCalled()
  })

  it('LOG-AND-CONTINUE: a failing run never escapes into waitUntil', async () => {
    vi.mocked(runEbayOrderSync).mockRejectedValueOnce(new Error('content app is down'))
    const { ctx, scheduled } = collectingCtx()

    await worker.scheduled({ cron: '*/15 * * * *' } as any, makeEnv(), ctx)

    // An unhandled rejection here would mark the whole scheduled invocation as failed.
    await expect(Promise.all(scheduled)).resolves.toBeDefined()
  })

  it('the daily TCG sync still owns the DEFAULT case (a new case must not steal it)', async () => {
    const { ctx, scheduled } = collectingCtx()
    await worker.scheduled({ cron: '0 6 * * *' } as any, makeEnv(), ctx)
    await Promise.all(scheduled)

    expect(runIngestion).toHaveBeenCalledTimes(1)
    expect(runEbayOrderSync).not.toHaveBeenCalled()
  })
})
