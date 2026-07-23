import { describe, it, expect, vi, afterEach } from 'vitest'

// The Card Watch priority-lane CRON case + its manual trigger, and the Session-3 alert hook they
// fire AFTER the drain. Three things matter and none is about pricing:
//   (1) after a watched-scope drain that refreshed ≥1 expansion, the alert hook is POSTed the
//       refreshed list;
//   (2) a drain failure means NO hook (and never rejects the invocation) — the drain's price writes
//       must never depend on alerting;
//   (3) a hook failure is caught and never rejects the invocation either.

const DRAIN_RESULT = {
  scope: 'watched' as const,
  expansionsFetched: 1,
  refreshedExpansions: [{ gameSlug: 'pokemon', expansion: 'sv08' }],
}

vi.mock('./scrydexProcessor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scrydexProcessor.js')>()
  return { ...actual, processPendingWebhooks: vi.fn(async () => DRAIN_RESULT) }
})

vi.mock('./watchAlerts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./watchAlerts.js')>()
  return { ...actual, runWatchAlerts: vi.fn(async () => ({ ok: true, alertsFired: 1 })) }
})

// Keep the daily TCG sync (default case) from doing real work if a cron test ever hits it.
vi.mock('./ingestion/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ingestion/index.js')>()
  return { ...actual, runIngestion: vi.fn(async () => ({})) }
})

import worker from './worker.js'
import { processPendingWebhooks } from './scrydexProcessor.js'
import { runWatchAlerts } from './watchAlerts.js'

const SECRET = 'test-secret'

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    DB: {} as any,               // bare {} — runStage's writeRunLog catches its own failure
    IMAGES_BUCKET: {} as any,
    INGESTION_WORKER_SECRET: SECRET,
    CONTENT_APP_URL: 'https://sleevedpages.com',
    SCRYDEX_API_KEY: 'k',
    SCRYDEX_TEAM_ID: 't',
    ...overrides,
  } as any
}

function collectingCtx() {
  const scheduled: Promise<unknown>[] = []
  return { scheduled, ctx: { waitUntil: (p: Promise<unknown>) => { scheduled.push(p) } } as any }
}

afterEach(() => { vi.clearAllMocks() })

describe('cron "0 10,16,22 * * *" — the priority lane + alert hook', () => {
  it('runs the WATCHED drain then POSTs the refreshed expansions to the alert hook', async () => {
    const { ctx, scheduled } = collectingCtx()
    await worker.scheduled({ cron: '0 10,16,22 * * *' } as any, makeEnv(), ctx)
    await Promise.all(scheduled)

    expect(processPendingWebhooks).toHaveBeenCalledTimes(1)
    expect(processPendingWebhooks).toHaveBeenCalledWith(expect.anything(), { scope: 'watched' })
    // Hook fired AFTER the drain, with exactly the list the drain returned.
    expect(runWatchAlerts).toHaveBeenCalledTimes(1)
    expect(runWatchAlerts).toHaveBeenCalledWith(expect.anything(), DRAIN_RESULT.refreshedExpansions)
  })

  it('does NOT run the lane (or the hook) without Scrydex keys', async () => {
    const { ctx, scheduled } = collectingCtx()
    await worker.scheduled({ cron: '0 10,16,22 * * *' } as any, makeEnv({ SCRYDEX_API_KEY: undefined }), ctx)
    await Promise.all(scheduled)
    expect(processPendingWebhooks).not.toHaveBeenCalled()
    expect(runWatchAlerts).not.toHaveBeenCalled()
  })

  it('a drain FAILURE fires no hook and never rejects the invocation', async () => {
    vi.mocked(processPendingWebhooks).mockRejectedValueOnce(new Error('drain boom'))
    const { ctx, scheduled } = collectingCtx()
    await worker.scheduled({ cron: '0 10,16,22 * * *' } as any, makeEnv(), ctx)

    await expect(Promise.all(scheduled)).resolves.toBeDefined()
    expect(runWatchAlerts).not.toHaveBeenCalled()
  })

  it('a hook FAILURE is caught — the drain (its price writes already committed) never fails on it', async () => {
    vi.mocked(runWatchAlerts).mockRejectedValueOnce(new Error('content app down'))
    const { ctx, scheduled } = collectingCtx()
    await worker.scheduled({ cron: '0 10,16,22 * * *' } as any, makeEnv(), ctx)

    await expect(Promise.all(scheduled)).resolves.toBeDefined()
    expect(processPendingWebhooks).toHaveBeenCalledTimes(1)   // the drain still ran to completion
  })

  it('fires no hook when the drain refreshed nothing (≥1 fetch is the trigger)', async () => {
    vi.mocked(processPendingWebhooks).mockResolvedValueOnce({ scope: 'watched', expansionsFetched: 0, refreshedExpansions: [] })
    const { ctx, scheduled } = collectingCtx()
    await worker.scheduled({ cron: '0 10,16,22 * * *' } as any, makeEnv(), ctx)
    await Promise.all(scheduled)
    expect(runWatchAlerts).not.toHaveBeenCalled()
  })
})

describe('POST /admin/run-job { job: "card-watch-drain" } — the manual lane also fires the hook', () => {
  const runJob = (env: any, body: unknown, headers: Record<string, string> = { 'x-worker-secret': SECRET }) =>
    worker.fetch(
      new Request('https://worker.test/admin/run-job', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
      env,
      collectingCtx().ctx,
    )

  it('501/401 guards aside — triggers the watched drain then the hook', async () => {
    const { ctx, scheduled } = collectingCtx()
    const res = await worker.fetch(
      new Request('https://worker.test/admin/run-job', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-worker-secret': SECRET },
        body: JSON.stringify({ job: 'card-watch-drain' }),
      }),
      makeEnv(),
      ctx,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, job: 'card-watch-drain', started: true })

    await Promise.all(scheduled)
    expect(processPendingWebhooks).toHaveBeenCalledWith(expect.anything(), { scope: 'watched' })
    expect(runWatchAlerts).toHaveBeenCalledWith(expect.anything(), DRAIN_RESULT.refreshedExpansions)
  })

  it('503s without Scrydex keys (the hook never runs)', async () => {
    const res = await runJob(makeEnv({ SCRYDEX_API_KEY: undefined }), { job: 'card-watch-drain' })
    expect(res.status).toBe(503)
    expect(runWatchAlerts).not.toHaveBeenCalled()
  })

  it('a hook failure on the manual run never rejects the invocation', async () => {
    vi.mocked(runWatchAlerts).mockRejectedValueOnce(new Error('boom'))
    const { ctx, scheduled } = collectingCtx()
    await worker.fetch(
      new Request('https://worker.test/admin/run-job', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-worker-secret': SECRET },
        body: JSON.stringify({ job: 'card-watch-drain' }),
      }),
      makeEnv(),
      ctx,
    )
    await expect(Promise.all(scheduled)).resolves.toBeDefined()
  })
})
