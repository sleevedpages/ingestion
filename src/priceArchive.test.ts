import { describe, it, expect, vi, afterEach } from 'vitest';

// runPriceArchive — the looping trigger for the daily R2 price-archive capture.
//
// What is pinned here:
//   * the seam LOOPS the bounded Content endpoint until the day reports done (the one
//     difference from the single-POST snapshot/anomaly/reap seams), and aggregates counts,
//   * a missing CONTENT_APP_URL / secret self-skips with a named reason — never a guessed
//     prod origin (a fallback would let a UAT worker drive PROD captures),
//   * a genuine failure THROWS (so runStage records an honest error row) and already-made
//     progress is simply left in R2 for the next fire to resume,
//   * the call cap stops a runaway loop and reports done:false honestly.

import {
  runPriceArchive,
  priceArchiveRunUrl,
  PRICE_ARCHIVE_RUN_PATH,
  PRICE_ARCHIVE_MAX_CALLS,
} from './priceArchive.js';

const SECRET = 'shared-secret';
const env = (overrides: Record<string, unknown> = {}) => ({
  CONTENT_APP_URL: 'https://sleevedpages.com',
  INGESTION_WORKER_SECRET: SECRET,
  ...overrides,
}) as any;

const okBody = (extra: Record<string, unknown> = {}) => ({
  ok: true, day: '2026-08-31', partsWritten: 2, partsSkipped: 0,
  rowsScanned: 40000, rowsWritten: 40000, bytesWritten: 1000, done: false, hasMore: true,
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

describe('priceArchiveRunUrl', () => {
  it('joins the run path onto the configured origin', () => {
    expect(priceArchiveRunUrl('https://sleevedpages.com'))
      .toBe(`https://sleevedpages.com${PRICE_ARCHIVE_RUN_PATH}`);
  });
  it('rejects blank / junk / non-http values', () => {
    expect(priceArchiveRunUrl('')).toBeNull();
    expect(priceArchiveRunUrl('   ')).toBeNull();
    expect(priceArchiveRunUrl(undefined)).toBeNull();
    expect(priceArchiveRunUrl('file:///etc/passwd')).toBeNull();
  });
});

describe('runPriceArchive — the loop', () => {
  it('POSTs with the shared secret and loops until done, aggregating counts', async () => {
    const calls = mockFetchSequence([
      okBody({ partsWritten: 3, rowsWritten: 60000, bytesWritten: 5, done: false }),
      okBody({ partsWritten: 2, rowsWritten: 40000, bytesWritten: 7, done: true, hasMore: false }),
    ]);

    const res = await runPriceArchive(env());

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(`https://sleevedpages.com${PRICE_ARCHIVE_RUN_PATH}`);
    expect((calls[0].init.headers as Record<string, string>)['x-worker-secret']).toBe(SECRET);
    expect(res).toMatchObject({
      ok: true, day: '2026-08-31', calls: 2, done: true,
      partsWritten: 5, rowsWritten: 100000, bytesWritten: 12,
    });
  });

  it('one call suffices when the day is already complete (manifest short-circuit)', async () => {
    const calls = mockFetchSequence([okBody({ done: true, skipped: 'complete', partsWritten: 0, rowsWritten: 0 })]);
    const res = await runPriceArchive(env());
    expect(calls).toHaveLength(1);
    expect(res.done).toBe(true);
  });

  it('stops at the call cap and reports done:false honestly — never a silent runaway', async () => {
    const calls = mockFetchSequence([okBody({ done: false })]);
    const res = await runPriceArchive(env());
    expect(calls).toHaveLength(PRICE_ARCHIVE_MAX_CALLS);
    expect(res.done).toBe(false);
    expect(res.calls).toBe(PRICE_ARCHIVE_MAX_CALLS);
  });

  it('self-skips (never fetches) when CONTENT_APP_URL is unset', async () => {
    const calls = mockFetchSequence([okBody()]);
    const res = await runPriceArchive(env({ CONTENT_APP_URL: undefined }));
    expect(res).toEqual({ ok: false, skipped: 'not_configured' });
    expect(calls).toHaveLength(0);
  });

  it('self-skips when the shared secret is unset', async () => {
    const calls = mockFetchSequence([okBody()]);
    const res = await runPriceArchive(env({ INGESTION_WORKER_SECRET: undefined }));
    expect(res).toEqual({ ok: false, skipped: 'not_configured' });
    expect(calls).toHaveLength(0);
  });

  it('THROWS on a non-2xx (so runStage records an honest error row)', async () => {
    mockFetchSequence([{ status: 503 }]);
    await expect(runPriceArchive(env())).rejects.toThrow(/HTTP 503/);
  });

  it('THROWS on an unexpected body', async () => {
    mockFetchSequence([{ ok: false } as any]);
    await expect(runPriceArchive(env())).rejects.toThrow(/unexpected body/);
  });

  it('a mid-loop failure throws AFTER progress landed — nothing is retried or rolled back here', async () => {
    mockFetchSequence([okBody({ done: false }), { status: 500 }]);
    await expect(runPriceArchive(env())).rejects.toThrow(/HTTP 500/);
    // The resume machinery lives Content-side (R2 part metadata); this trigger holds no state.
  });
});
