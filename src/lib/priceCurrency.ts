/**
 * priceCurrency.ts — write-time currency classification for canonical `prices` (2026-08-17).
 *
 * ROOT CAUSE THIS CLOSES (the Mega Dragonite $32,000 incident, confirmed at population level by
 * the price anomaly sentinel's first prod run: 511 open anomalies, all Pokemon Japan, all
 * integer-round Scrydex raw values ~150× their cents-bearing graded references). Scrydex price
 * objects carry a per-entry `currency` field and serve Japanese raw prices in JPY, but BOTH
 * canonical `prices` writers (`buildPriceUpserts` drain-side, `parseCardPrices` enrich-side)
 * bound `price.market` verbatim — ¥32,000 became $32,000. The `prices` table has no currency
 * column: every stored value IS a USD claim, so currency must be resolved AT WRITE TIME — the
 * mig 0099 doctrine (classification from the source's own shape, never read-time inference),
 * applied to money.
 *
 * THE RULE (operator-approved 2026-08-17 — gate + convert):
 *   - absent/blank currency → USD (the historical assumption, correct for English payloads)
 *   - 'USD'                → write verbatim (factor 1)
 *   - 'JPY'                → convert with the operator-set `app_config.fx_jpy_per_usd` rate
 *                            (yen per dollar, the way USDJPY is quoted); NO in-code default —
 *                            an unset/insane rate means the row is SKIPPED, never written
 *                            unconverted (fail-closed: a ±10% stale rate beats a 15,000% bug,
 *                            but NO rate must never silently become factor 1)
 *   - anything else        → SKIPPED and counted (EUR is "in progress" upstream; when it
 *                            arrives it lands here as a counted skip, not a wrong dollar)
 *
 * The rate is read ONCE per run/job (not per row) and passed down. The sanity window [50, 1000]
 * exists because the likeliest misconfiguration is entering the rate inverted (0.0067 —
 * dollars-per-yen), which would INFLATE by ~150× the other way; out-of-window → treated as
 * unset (fail-closed skip) + logged, never clamped into a wrong-but-plausible number.
 */

import { logger } from '../ingestion/logger.js';

/** app_config key (shared D1; Content documents it in config-and-env.md). Direct
 *  `UPDATE app_config` retunes it, no redeploy — the drain reads it fresh each run. */
export const FX_JPY_PER_USD_KEY = 'fx_jpy_per_usd';

/** Sanity window for the stored rate (see header — inverted-entry guard, not a clamp). */
export const FX_JPY_PER_USD_MIN = 50;
export const FX_JPY_PER_USD_MAX = 1000;

/** Pure: raw app_config value → validated yen-per-dollar rate, or null (unset/blank/insane). */
export function resolveFxJpyPerUsd(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n < FX_JPY_PER_USD_MIN || n > FX_JPY_PER_USD_MAX) return null;
  return n;
}

/** Read + validate the rate. Degrades to null (→ JPY rows gate-skip) on any failure — the
 *  drain must run even if app_config is unreadable. */
export async function getFxJpyPerUsd(db: D1Database): Promise<number | null> {
  try {
    const row = await db.prepare('SELECT value FROM app_config WHERE key = ?')
      .bind(FX_JPY_PER_USD_KEY).first<{ value: unknown }>();
    const rate = resolveFxJpyPerUsd(row?.value);
    if (row?.value != null && rate === null) {
      logger.warn('fx_jpy_per_usd is set but outside the sane window — treating as unset (JPY rows will be skipped)', {
        key: FX_JPY_PER_USD_KEY, min: FX_JPY_PER_USD_MIN, max: FX_JPY_PER_USD_MAX,
      });
    }
    return rate;
  } catch (err) {
    logger.warn('fx_jpy_per_usd read failed — treating as unset (JPY rows will be skipped)', {
      error: String(err),
    });
    return null;
  }
}

export type CurrencyResolution =
  | { ok: true; factor: number; currency: string }
  | { ok: false; reason: 'no_rate' | 'unsupported'; currency: string };

/**
 * Pure: a price entry's `currency` field + the run's fx rate → the multiply-through factor,
 * or a typed skip. Absent/blank currency is USD (see header).
 */
export function resolveCurrencyFactor(rawCurrency: unknown, fxJpyPerUsd: number | null): CurrencyResolution {
  const currency = String(rawCurrency ?? 'USD').trim().toUpperCase() || 'USD';
  if (currency === 'USD') return { ok: true, factor: 1, currency };
  if (currency === 'JPY') {
    if (fxJpyPerUsd != null) return { ok: true, factor: 1 / fxJpyPerUsd, currency };
    return { ok: false, reason: 'no_rate', currency };
  }
  return { ok: false, reason: 'unsupported', currency };
}

/** Convert one money figure through a factor, rounded to cents. Null passes through. */
export function convertMoney(value: number | null | undefined, factor: number): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * factor * 100) / 100;
}

/** Mutable per-run skip counter both writers share (logged once per run, never per row). */
export interface CurrencySkips {
  noRate: number;        // JPY seen while fx_jpy_per_usd is unset/insane
  unsupported: number;   // any other non-USD currency
}

export function newCurrencySkips(): CurrencySkips {
  return { noRate: 0, unsupported: 0 };
}

export function countSkip(skips: CurrencySkips | undefined, reason: 'no_rate' | 'unsupported'): void {
  if (!skips) return;
  if (reason === 'no_rate') skips.noRate++;
  else skips.unsupported++;
}
