import { describe, it, expect } from 'vitest'
import {
  ADMIN_JOB_IDS,
  isAdminJobId,
  priceChartingCategoryForDay,
  acquireJobLock,
  releaseJobLock,
  isJobRunning,
  JOB_LOCK_PREFIX,
  PC_CSV_COOLDOWN_KEY,
  priceChartingCooldownRemaining,
  startPriceChartingCooldown,
} from './adminJobs.js'
import { PRICECHARTING_CATEGORIES } from './lib/pricechartingCsv.js'

// Minimal Map-backed KV double (get/put/delete), mirroring the KVNamespace shape used.
function fakeKV() {
  const store = new Map<string, string>()
  return {
    store,
    get: async (k: string) => (store.has(k) ? store.get(k)! : null),
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
  }
}

describe('ADMIN_JOB_IDS / isAdminJobId', () => {
  it('lists exactly the four cron jobs', () => {
    expect(ADMIN_JOB_IDS).toEqual(['tcg-sync', 'image-mirror', 'scrydex-drain', 'pricecharting-csv'])
  })
  it('accepts known ids and rejects everything else', () => {
    expect(isAdminJobId('tcg-sync')).toBe(true)
    expect(isAdminJobId('pricecharting-csv')).toBe(true)
    expect(isAdminJobId('mirror')).toBe(false)
    expect(isAdminJobId('')).toBe(false)
    expect(isAdminJobId(undefined)).toBe(false)
    expect(isAdminJobId(42)).toBe(false)
  })
})

describe('priceChartingCategoryForDay', () => {
  it('rotates one category per day across the 4-day cycle (matches the cron formula)', () => {
    const n = PRICECHARTING_CATEGORIES.length
    expect(priceChartingCategoryForDay(0)).toBe(PRICECHARTING_CATEGORIES[0])
    expect(priceChartingCategoryForDay(86_400_000)).toBe(PRICECHARTING_CATEGORIES[1])
    expect(priceChartingCategoryForDay(86_400_000 * 2)).toBe(PRICECHARTING_CATEGORIES[2])
    // wraps after a full cycle
    expect(priceChartingCategoryForDay(86_400_000 * n)).toBe(PRICECHARTING_CATEGORIES[0])
  })
  it('returns a valid category for the current day (default arg)', () => {
    expect(PRICECHARTING_CATEGORIES).toContain(priceChartingCategoryForDay())
  })
})

describe('job lock (double-fire guard)', () => {
  it('acquires once, blocks a second acquire, then frees on release', async () => {
    const kv = fakeKV()
    const env = { SLEEVEDPAGES_KV: kv } as any

    expect(await acquireJobLock(env, 'tcg-sync')).toBe(true)
    expect(kv.store.has(`${JOB_LOCK_PREFIX}tcg-sync`)).toBe(true)
    expect(await isJobRunning(env, 'tcg-sync')).toBe(true)

    // second acquire while held → blocked
    expect(await acquireJobLock(env, 'tcg-sync')).toBe(false)

    // a different job is independent
    expect(await acquireJobLock(env, 'scrydex-drain')).toBe(true)

    await releaseJobLock(env, 'tcg-sync')
    expect(await isJobRunning(env, 'tcg-sync')).toBe(false)
    expect(await acquireJobLock(env, 'tcg-sync')).toBe(true)
  })

  it('is best-effort with no KV bound: allows the run and reports not-running', async () => {
    const env = {} as any
    expect(await acquireJobLock(env, 'image-mirror')).toBe(true)
    expect(await isJobRunning(env, 'image-mirror')).toBe(false)
    await expect(releaseJobLock(env, 'image-mirror')).resolves.toBeUndefined()
  })
})

describe('PriceCharting CSV download cooldown', () => {
  it('starts a positive cooldown and reads it back (≈ 10 min)', async () => {
    const kv = fakeKV()
    const env = { SLEEVEDPAGES_KV: kv } as any

    expect(await priceChartingCooldownRemaining(env)).toBe(0)
    await startPriceChartingCooldown(env)
    expect(kv.store.has(PC_CSV_COOLDOWN_KEY)).toBe(true)

    const rem = await priceChartingCooldownRemaining(env)
    expect(rem).toBeGreaterThan(0)
    expect(rem).toBeLessThanOrEqual(660)
  })

  it('reports 0 once the stored expiry is in the past, and treats garbage as still cooling', async () => {
    const kv = fakeKV()
    const env = { SLEEVEDPAGES_KV: kv } as any

    await kv.put(PC_CSV_COOLDOWN_KEY, String(Date.now() - 1000))
    expect(await priceChartingCooldownRemaining(env)).toBe(0)

    await kv.put(PC_CSV_COOLDOWN_KEY, 'not-a-number')
    expect(await priceChartingCooldownRemaining(env)).toBeGreaterThan(0)
  })

  it('is a no-op with no KV bound', async () => {
    const env = {} as any
    expect(await priceChartingCooldownRemaining(env)).toBe(0)
    await expect(startPriceChartingCooldown(env)).resolves.toBeUndefined()
  })
})
