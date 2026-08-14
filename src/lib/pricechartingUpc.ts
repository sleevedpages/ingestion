/**
 * PriceCharting UPC → canonical product lookup — the LIVE fallback behind Content's
 * GET /api/products/upc-lookup (sealed barcode scanning, Phase 1).
 *
 * The primary resolution path is the persisted `pricecharting_products` map, which the daily
 * CSV ingest back-fills with UPCs (mig 0127) — Content reads that in one indexed D1 query and
 * only proxies here on a miss. This module handles the miss: PriceCharting's /api/product
 * endpoint supports direct ?upc= lookup, so we ask it, VALIDATE the returned product against
 * our catalogue before trusting it, stamp the map row (upc + mapping) so the NEXT scan is a
 * D1 hit, and KV-cache the outcome INCLUDING negatives so repeated scans of an unknown code
 * never hammer the API.
 *
 * WHY the live path is the workhorse (2026-08-13 audit of the cached CSV exports): the CSV
 * `upc` column is only sparsely populated — pokemon 79/91,668 rows (recent SEALED products
 * only), yugioh 0/77,426 — so most first-ever scans of a real barcode will land here.
 *
 * MATCHING POSTURE — never return a weak fuzzy match. A wrong product added to inventory is
 * worse than a miss. Rungs, all fail-toward-rejection:
 *   1. The returned pc_id is already stamped in `pricecharting_products` → reuse the stored
 *      canonical id (the CSV ingest's rung-0 semantics; the matcher never fights a stamp).
 *   2. The response carries a numeric `tcg-id` → resolve products.tcgplayer_product_id and
 *      validate with the SAME validateTcgIdMatch the CSV ingest uses.
 *   3. Anything else → found:false. (No name-only fuzzy: the CSV path only accepts fuzzy with
 *      number/set corroboration, and a UPC-scanned product — usually sealed — has neither.)
 *
 * RATE LIMIT: 1 req/sec. A lookup makes at most TWO /api/product calls (the scanned form and
 * its UPC-A ↔ EAN-13 sibling) with the same sleep pattern the graded lookup uses between its
 * search + product calls.
 *
 * SECURITY: PRICECHARTING_TOKEN stays worker-side only (injected by pcGet) — never logged,
 * returned, or persisted. Content authenticates with x-worker-secret like every other route.
 */

import type { Env } from '../worker.js'
import { pcGet } from './pricechartingClient.js'
import { normalizeUpc, validateTcgIdMatch, pcCategoryForTcgplayerCategoryId, SEALED_GENRE } from './pricechartingCsv.js'

/** KV cache — one entry per normalized scanned code. Negatives expire sooner so a product
 * PriceCharting adds later (or a catalogue gap we close) recovers within hours. */
export const PC_UPC_PREFIX = 'pc_upc:'
export const PC_UPC_TTL = 60 * 60 * 24 // 24h — positive hits (the D1 map stamp is the durable record)
export const PC_UPC_NEGATIVE_TTL = 60 * 60 * 6 // 6h — negatives (mirrors the eBay gap-filler's null TTL)

/** Sleep between the (at most two) API calls — the graded lookup's 1 req/sec pattern. */
const RATE_LIMIT_SLEEP_MS = 1100
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * The barcode forms to try for a normalized digits-only code. A scanned EAN-13 with a
 * leading 0 is the same product as its 12-digit UPC-A, so both directions are queried:
 * 13-with-leading-0 → also the 12-digit form; 12 → also the 0-prefixed 13. PURE.
 * Mirror of Content's functions/lib/upcLookup.js upcQueryForms (cross-repo, kept in step).
 */
export function upcQueryForms(code: string): string[] {
  const forms = [code]
  if (code.length === 13 && code.startsWith('0')) forms.push(code.slice(1))
  else if (code.length === 12) forms.push(`0${code}`)
  return forms
}

export interface PcUpcLookupResult {
  found: boolean
  /** True when served from the pc_upc KV cache (no API call). */
  cached?: boolean
  pcId?: string
  canonicalProductId?: number
  productName?: string | null
  consoleName?: string | null
}

interface LookupOpts {
  /** Test seam for the rate-limit sleep — defaults to the real 1.1s pause. */
  sleepFn?: (ms: number) => Promise<void>
}

/** The cached shape (positive or negative) stored under pc_upc:{code}. */
type CachedUpc =
  | { found: false }
  | { found: true; pcId: string; canonicalProductId: number; productName: string | null; consoleName: string | null }

/**
 * Look up a scanned barcode against PriceCharting and resolve it to a canonical product.
 * Returns found:false for every kind of miss (unknown code, unvalidated match, catalogue
 * gap) — the caller treats a miss as a 200, never an error.
 * @throws Error only on a missing token (caller maps to 503).
 */
export async function lookupPriceChartingUpc(env: Env, rawCode: string, opts: LookupOpts = {}): Promise<PcUpcLookupResult> {
  if (!env.PRICECHARTING_TOKEN) throw new Error('PRICECHARTING_TOKEN not configured')
  const doSleep = opts.sleepFn ?? sleep

  const code = normalizeUpc(rawCode)
  if (!code) return { found: false }

  const kv = env.SLEEVEDPAGES_KV
  const cacheKey = `${PC_UPC_PREFIX}${code}`
  if (kv) {
    const raw = await kv.get(cacheKey)
    if (raw != null) {
      try { return { ...(JSON.parse(raw) as CachedUpc), cached: true } } catch { /* fall through to a live lookup */ }
    }
  }

  // ── Live PriceCharting lookup: at most two forms, 1 req/sec apart ────────────
  let product: any = null
  let transient = false
  const forms = upcQueryForms(code)
  for (let i = 0; i < forms.length; i++) {
    if (i > 0) await doSleep(RATE_LIMIT_SLEEP_MS)
    const { status, body } = await pcGet(env, '/api/product', { upc: forms[i] })
    if (status !== 200) { transient = true; continue }  // transient (5xx/429/network-shaped) — never negative-cache
    if (body?.status === 'error' || body?.id == null) continue  // definitive miss for this form
    product = body
    break
  }

  if (!product) {
    // Only cache a DEFINITIVE miss — a transient API failure must not suppress retries for 6h.
    if (!transient && kv) {
      await kv.put(cacheKey, JSON.stringify({ found: false } satisfies CachedUpc), { expirationTtl: PC_UPC_NEGATIVE_TTL })
    }
    return { found: false }
  }

  const pcId = String(product.id)
  const productName: string | null = product['product-name'] ?? null
  const consoleName: string | null = product['console-name'] ?? null

  // ── Rung 1: the pc_id is already stamped in the map → reuse the stored canonical id ──
  const stamped = await env.DB.prepare(
    'SELECT canonical_product_id AS productId FROM pricecharting_products WHERE pc_id = ? LIMIT 1',
  ).bind(pcId).first<{ productId: number | null }>()
  let canonicalProductId: number | null = stamped?.productId ?? null

  if (canonicalProductId != null) {
    // Stamp the UPC onto the existing row so the next scan resolves in D1 without this proxy.
    await env.DB.prepare(
      'UPDATE pricecharting_products SET upc = COALESCE(?, upc), last_seen_at = unixepoch() WHERE pc_id = ?',
    ).bind(code, pcId).run()
  } else {
    // ── Rung 2: numeric tcg-id, validated with the CSV ingest's own guard ────────
    const tcgId = Number(String(product['tcg-id'] ?? '').trim())
    if (Number.isInteger(tcgId) && tcgId > 0) {
      const candidate = await env.DB.prepare(`
        SELECT p.id, p.name, g.tcgplayer_category_id AS categoryId
        FROM products p
        JOIN sets s ON s.id = p.set_id
        JOIN canonical_games g ON g.id = s.game_id
        WHERE p.tcgplayer_product_id = ? LIMIT 1
      `).bind(tcgId).first<{ id: number; name: string | null; categoryId: number | null }>()
      if (candidate && validateTcgIdMatch({ 'product-name': productName ?? '', 'console-name': consoleName ?? '' }, { name: candidate.name })) {
        canonicalProductId = candidate.id
        // Persist the mapping so the next scan is a D1 hit. game_category is NOT NULL, so a
        // match outside the 4 ingested categories is returned but not persisted (rare; the
        // KV positive still short-circuits repeat scans for 24h).
        const category = pcCategoryForTcgplayerCategoryId(candidate.categoryId)
        if (category) {
          await env.DB.prepare(`
            INSERT INTO pricecharting_products
              (pc_id, game_category, canonical_product_id, match_method, tcg_id,
               console_name, product_name, is_sealed, sales_volume, upc, matched_at, last_seen_at)
            VALUES (?, ?, ?, 'tcg-id', ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
            ON CONFLICT (pc_id) DO UPDATE SET
              canonical_product_id = COALESCE(pricecharting_products.canonical_product_id, excluded.canonical_product_id),
              match_method         = COALESCE(pricecharting_products.match_method, excluded.match_method),
              upc                  = COALESCE(excluded.upc, pricecharting_products.upc),
              matched_at           = COALESCE(pricecharting_products.matched_at, excluded.matched_at),
              last_seen_at         = unixepoch()
          `).bind(
            pcId, category, canonicalProductId, String(tcgId),
            consoleName, productName,
            product['genre'] === SEALED_GENRE ? 1 : 0,
            (() => { const n = Number(String(product['sales-volume'] ?? '').trim()); return Number.isFinite(n) && n > 0 ? Math.round(n) : null })(),
            code,
          ).run()
        }
      }
    }
  }

  if (canonicalProductId == null) {
    // The PC product exists but nothing confident maps it to our catalogue — an honest miss.
    if (kv) await kv.put(cacheKey, JSON.stringify({ found: false } satisfies CachedUpc), { expirationTtl: PC_UPC_NEGATIVE_TTL })
    return { found: false }
  }

  const positive: CachedUpc = { found: true, pcId, canonicalProductId, productName, consoleName }
  if (kv) await kv.put(cacheKey, JSON.stringify(positive), { expirationTtl: PC_UPC_TTL })
  return positive
}
