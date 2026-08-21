/**
 * UPC resolver cache invalidation — the ONE place that knows every external rung's KV key
 * shape (worker route `POST /upc/cache/invalidate`, x-worker-secret).
 *
 * WHY THIS EXISTS (2026-08-21). Both external rungs NEGATIVE-cache a definitive miss for 24h
 * (`EBAY_UPC_NEGATIVE_TTL` / `UPCITEMDB_UPC_NEGATIVE_TTL`). That is correct for quota, and
 * corrosive for operations: after a matcher fix, or after a product is newly listed, every
 * already-scanned barcode keeps replaying yesterday's `found:false` for a day — so the fix
 * cannot be verified against any code the operator has already tried, which is precisely the
 * set of codes they will try first.
 *
 * ⚠️ WHY A WORKER ROUTE AND NOT A DIRECT KV WRITE FROM CONTENT. `SLEEVEDPAGES_KV` is shared,
 * so Content *could* delete `ebay_upc:{code}` itself — and that is exactly the coupling that
 * rots. The key prefixes, the both-barcode-forms rule and the TTL policy are WORKER-PRIVATE
 * and live in the resolver modules beside the code that writes them; a Content copy would be
 * a second, unlinked source of truth that a rename in this repo silently breaks (the repo
 * already carries one such cross-repo mirror, `GRADE_KEY_LABEL`, and it is documented as a
 * hazard). Content already holds `INGESTION_WORKER_URL` + `INGESTION_WORKER_SECRET` and
 * already calls `/ebay/upc` and `/upcitemdb/upc` over exactly this seam, so the route adds
 * one call to an existing channel rather than a new dependency direction.
 *
 * Deleting a cache entry is IDEMPOTENT and non-destructive: the durable record is the
 * `product_upcs` map, never KV. A delete at worst costs one extra provider call.
 */

import { EBAY_UPC_PREFIX } from './ebayUpc.js'
import { UPCITEMDB_UPC_PREFIX } from './upcitemdbUpc.js'
import { logger } from '../ingestion/logger.js'

/** Every KV key the external rungs may hold for one normalized barcode. PURE. */
export function upcCacheKeys(code: string): string[] {
  return [`${EBAY_UPC_PREFIX}${code}`, `${UPCITEMDB_UPC_PREFIX}${code}`]
}

/**
 * Both barcode forms of a normalized code — a 13-digit EAN-13 with a leading zero IS its
 * 12-digit UPC-A, and the rungs cache under whatever form the scanner sent. Mirrors
 * Content's `functions/lib/upcLookup.js upcQueryForms` and the worker's
 * `pricechartingUpc.ts upcQueryForms`. PURE.
 */
export function upcCacheForms(code: string): string[] {
  const forms = [code]
  if (code.length === 13 && code.startsWith('0')) forms.push(code.slice(1))
  else if (code.length === 12) forms.push(`0${code}`)
  return forms
}

export interface UpcCacheInvalidation {
  ok: boolean
  upc: string
  /** Every key considered (both barcode forms × both rungs) — the operator's receipt. */
  keys: string[]
  deleted: number
  /** True when there is no KV binding at all; nothing to invalidate, not an error. */
  skipped?: 'no_kv'
}

/**
 * Delete every external-rung cache entry for a barcode, in BOTH forms. Never throws — a KV
 * failure is logged and reported as a smaller `deleted` count, because the caller is an
 * operator action whose worst case is "the next scan costs one provider call".
 */
export async function invalidateUpcCache(kv: KVNamespace | undefined, code: string): Promise<UpcCacheInvalidation> {
  const keys = upcCacheForms(code).flatMap(upcCacheKeys)
  if (!kv) return { ok: true, upc: code, keys, deleted: 0, skipped: 'no_kv' }

  let deleted = 0
  for (const key of keys) {
    try {
      // KV delete is unconditional, so read first purely to report a truthful count.
      const existed = await kv.get(key)
      await kv.delete(key)
      if (existed != null) deleted++
    } catch (err) {
      logger.warn('upc cache invalidation failed for one key — continuing', { key, error: String(err) })
    }
  }
  logger.info('upc_cache_invalidated', { upc: code, keys: keys.length, deleted })
  return { ok: true, upc: code, keys, deleted }
}
