import { describe, it, expect, vi, afterEach } from 'vitest'

// src/lib/priceCurrency.ts — write-time currency classification for canonical `prices`
// (the Mega Dragonite ¥32,000→$32,000 fix, 2026-08-17). What is pinned:
//   * absent/blank currency is USD (the historical assumption — English payloads),
//   * JPY converts ONLY through an operator-set, sanity-windowed fx_jpy_per_usd rate;
//     no rate → typed skip, NEVER factor 1 (fail-closed: skipped beats 150×-wrong),
//   * an INVERTED rate entry (dollars-per-yen, 0.0067) is rejected, not clamped — clamping
//     would convert through a wrong-but-plausible number,
//   * any other currency (EUR is "in progress" upstream) is a counted 'unsupported' skip.

import {
  resolveFxJpyPerUsd, getFxJpyPerUsd, resolveCurrencyFactor, convertMoney,
  newCurrencySkips, countSkip,
  FX_JPY_PER_USD_KEY, FX_JPY_PER_USD_MIN, FX_JPY_PER_USD_MAX,
} from './priceCurrency.js'

afterEach(() => vi.restoreAllMocks())

describe('resolveFxJpyPerUsd', () => {
  it('accepts a sane yen-per-dollar rate', () => {
    expect(resolveFxJpyPerUsd('149')).toBe(149)
    expect(resolveFxJpyPerUsd(150.5)).toBe(150.5)
    expect(resolveFxJpyPerUsd(String(FX_JPY_PER_USD_MIN))).toBe(FX_JPY_PER_USD_MIN)
    expect(resolveFxJpyPerUsd(String(FX_JPY_PER_USD_MAX))).toBe(FX_JPY_PER_USD_MAX)
  })

  it('absent/blank/nonsense → null (unset)', () => {
    for (const bad of [null, undefined, '', 'banana', {}, NaN]) {
      expect(resolveFxJpyPerUsd(bad)).toBeNull()
    }
  })

  it('REJECTS an inverted (dollars-per-yen) entry rather than clamping it', () => {
    // The likeliest misconfiguration: 0.0067 would inflate ~150× the other way if honoured,
    // and clamping it to 50 would convert through a wrong-but-plausible number.
    expect(resolveFxJpyPerUsd('0.0067')).toBeNull()
    expect(resolveFxJpyPerUsd(FX_JPY_PER_USD_MIN - 1)).toBeNull()
    expect(resolveFxJpyPerUsd(FX_JPY_PER_USD_MAX + 1)).toBeNull()
    expect(resolveFxJpyPerUsd(-149)).toBeNull()
  })
})

describe('getFxJpyPerUsd', () => {
  const dbWith = (value: unknown, throws = false) => ({
    prepare: () => ({
      bind: (key: string) => ({
        first: async () => {
          if (throws) throw new Error('no such table')
          expect(key).toBe(FX_JPY_PER_USD_KEY)
          return value === undefined ? null : { value }
        },
      }),
    }),
  }) as any

  it('reads and validates the stored rate', async () => {
    expect(await getFxJpyPerUsd(dbWith('149'))).toBe(149)
  })

  it('unset row → null; out-of-window row → null (fail-closed), with a warning', async () => {
    expect(await getFxJpyPerUsd(dbWith(undefined))).toBeNull()
    expect(await getFxJpyPerUsd(dbWith('0.0067'))).toBeNull()
  })

  it('a DB failure degrades to null — the drain must still run', async () => {
    expect(await getFxJpyPerUsd(dbWith(null, true))).toBeNull()
  })
})

describe('resolveCurrencyFactor', () => {
  it('absent/blank → USD, factor 1 (the historical assumption for English payloads)', () => {
    expect(resolveCurrencyFactor(undefined, null)).toEqual({ ok: true, factor: 1, currency: 'USD' })
    expect(resolveCurrencyFactor('', 150)).toEqual({ ok: true, factor: 1, currency: 'USD' })
    expect(resolveCurrencyFactor('usd', null)).toEqual({ ok: true, factor: 1, currency: 'USD' })
  })

  it('JPY with a rate → 1/rate; JPY without → typed no_rate skip, NEVER factor 1', () => {
    const withRate = resolveCurrencyFactor('JPY', 150)
    expect(withRate).toEqual({ ok: true, factor: 1 / 150, currency: 'JPY' })
    expect(resolveCurrencyFactor('jpy', null)).toEqual({ ok: false, reason: 'no_rate', currency: 'JPY' })
  })

  it('any other currency → unsupported skip (EUR arrives as a counted skip, not a wrong dollar)', () => {
    expect(resolveCurrencyFactor('EUR', 150)).toEqual({ ok: false, reason: 'unsupported', currency: 'EUR' })
  })
})

describe('convertMoney', () => {
  it('the incident numbers: ¥32,000 at 150 → $213.33 (condition-consistent under the ARS 10)', () => {
    expect(convertMoney(32000, 1 / 150)).toBe(213.33)
    expect(convertMoney(550000, 1 / 150)).toBe(3666.67)   // the Umbreon VMAX sentinel row
  })
  it('factor 1 passes through; null/NaN stay null', () => {
    expect(convertMoney(1.5, 1)).toBe(1.5)
    expect(convertMoney(null, 1)).toBeNull()
    expect(convertMoney(undefined, 1 / 150)).toBeNull()
    expect(convertMoney(NaN, 1)).toBeNull()
  })
})

describe('currency skip counters', () => {
  it('counts per reason and tolerates an absent collector', () => {
    const skips = newCurrencySkips()
    countSkip(skips, 'no_rate')
    countSkip(skips, 'no_rate')
    countSkip(skips, 'unsupported')
    expect(skips).toEqual({ noRate: 2, unsupported: 1 })
    expect(() => countSkip(undefined, 'no_rate')).not.toThrow()
  })
})
