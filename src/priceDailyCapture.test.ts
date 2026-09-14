import { describe, it, expect, vi, afterEach } from 'vitest';

// runPriceDailyCapture — the looping trigger for the price_daily projection (Phase 2).
//
// The priceArchive.ts seam, exactly. What is pinned here:
//   * the loop POSTs the bounded Content endpoint until it reports done (or hasMore:false),
//     aggregating counts and the days that completed,
//   * a missing CONTENT_APP_URL / secret self-skips with a named reason — never a guessed
//     prod origin (a fallback would let a UAT worker drive PROD projections),
//   * a genuine failure THROWS (runStage records an honest error row); progress persists
//     Content-side (price_daily_days), so nothing is retried or rolled back here,
//   * the call cap stops a runaway loop and reports done:false honestly.

import {
  runPriceDailyCapture,
  priceDailyRunUrl,
  PRICE_DAILY_RUN_PATH,
  PRICE_DAILY_MAX_CALLS,
} from './priceDailyCapture.js';

const SECRET = 'shared-secret';
const env = (overrides: Record<string, unknown> = {}) => ({
  CONTENT_APP_URL: 'https://sleevedpages.com',
  INGESTION_WORKER_SECRET: SECRET,
  ...overrides,
}) as any;

const okBody = (extra: Record<string, unknown> = {}) => ({
  ok: true, day: '2026-09-01', dayDone: false, done: false, hasMore: true,
  partsProcessed: 12, rowsWritten: 5000, rowsUnchanged: 40000, rowsPruned: 0,
  ...extra,
});

function mockFetchSequence(bodies: Array<Record<string, unknown> | { status: number }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const b = bodies[Math.min(i, bodies.length - 1)];
    i += 1;
    if ('status' in b && typeof b.status === 'number' && !('ok' in b)) {
      return new Response('nope', { status: b.status });
    }
    return new Response(JSON.stringify(b), { status: 200 });
  }));
  return calls;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('priceDailyRunUrl', () => {
  it('joins the run path onto the configured origin', () => {
    expect(priceDailyRunUrl('https://sleevedpages.com')).toBe(`https://sleevedpages.com${PRICE_DAILY_RUN_PATH}`);
    expect(PRICE_DAILY_RUN_PATH).toBe('/api/internal/price-daily/run');
  });
  it('rejects blank / junk / non-http values', () => {
    expect(priceDailyRunUrl('')).toBeNull();
    expect(priceDailyRunUrl(undefined)).toBeNull();
    expect(priceDailyRunUrl('file:///etc/passwd')).toBeNull();
  });
});

describe('runPriceDailyCapture — the loop', () => {
  it('POSTs with the shared secret and loops until done, aggregating counts and completed days', async () => {
    const calls = mockFetchSequence([
      okBody({ day: '2026-09-01', dayDone: false, rowsWritten: 5000, rowsUnchanged: 1 }),
      okBody({ day: '2026-09-01', dayDone: true, rowsWritten: 3000, rowsUnchanged: 2, rowsPruned: 10 }),
      okBody({ day: '2026-09-02', dayDone: true, rowsWritten: 100, rowsUnchanged: 3 }),
      { ok: true, done: true, hasMore: false, skipped: 'caught_up' },
    ]);

    const res = await runPriceDailyCapture(env());

    expect(calls).toHaveLength(4);
    expect(calls[0].url).toBe(`https://sleevedpages.com${PRICE_DAILY_RUN_PATH}`);
    expect((calls[0].init.headers as Record<string, string>)['x-worker-secret']).toBe(SECRET);
    expect(res).toMatchObject({
      ok: true, calls: 4, done: true, reason: 'caught_up',
      daysCompleted: ['2026-09-01', '2026-09-02'], lastDay: '2026-09-02',
      rowsWritten: 8100, rowsUnchanged: 6, rowsPruned: 10,
    });
  });

  it('one call suffices when already caught up', async () => {
    const calls = mockFetchSequence([{ ok: true, done: true, hasMore: false, skipped: 'caught_up' }]);
    const res = await runPriceDailyCapture(env());
    expect(calls).toHaveLength(1);
    expect(res).toMatchObject({ done: true, lastDay: null, daysCompleted: [] });
  });

  it('a disabled kill switch is a terminal state, not a loop', async () => {
    const calls = mockFetchSequence([{ ok: true, done: true, hasMore: false, skipped: 'disabled' }]);
    const res = await runPriceDailyCapture(env());
    expect(calls).toHaveLength(1);
    expect(res.reason).toBe('disabled');
  });

  it('stops at the call cap and reports done:false honestly — never a silent runaway', async () => {
    const calls = mockFetchSequence([okBody({ done: false, hasMore: true })]);
    const res = await runPriceDailyCapture(env());
    expect(calls).toHaveLength(PRICE_DAILY_MAX_CALLS);
    expect(res.done).toBe(false);
  });

  it('self-skips (never fetches) when CONTENT_APP_URL is unset', async () => {
    const calls = mockFetchSequence([okBody()]);
    expect(await runPriceDailyCapture(env({ CONTENT_APP_URL: undefined }))).toEqual({ ok: false, skipped: 'not_configured' });
    expect(calls).toHaveLength(0);
  });

  it('self-skips when the shared secret is unset', async () => {
    const calls = mockFetchSequence([okBody()]);
    expect(await runPriceDailyCapture(env({ INGESTION_WORKER_SECRET: undefined }))).toEqual({ ok: false, skipped: 'not_configured' });
    expect(calls).toHaveLength(0);
  });

  it('THROWS on a non-2xx (a 503 not_configured from Content included) so runStage records an error row', async () => {
    mockFetchSequence([{ status: 503 }]);
    await expect(runPriceDailyCapture(env())).rejects.toThrow(/HTTP 503/);
  });

  it('THROWS on an unexpected body', async () => {
    mockFetchSequence([{ ok: false } as any]);
    await expect(runPriceDailyCapture(env())).rejects.toThrow(/unexpected body/);
  });
});
