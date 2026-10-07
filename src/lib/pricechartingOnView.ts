/**
 * pricechartingOnView.ts — the ON-VIEW PriceCharting refresh (session 16, 2026-10-07).
 *
 * WHY. PriceCharting's written reply (2026-10-06) licenses our use with attribution, caching
 * allowed. The daily CSV stays the all-users backbone for its four categories, but it carries
 * neither the premium buckets (`condition-19…22` = CGC 10 Pristine · BGS 10 Black Label · TAG 10 ·
 * ACE 10 — API-ONLY, PriceCharting confirmed) nor the games it has no CSV for (Lorcana, Gundam,
 * Riftbound, …). So when a card is opened, this pulls THAT product's full price set from
 * `GET /api/product`, writes it into canonical `prices` as ordinary `source='pricecharting'` rows,
 * and marks it fresh for 7 days. Content serves the rows to everyone through its existing readers.
 *
 * WHAT IT WRITES — exactly what the CSV writer writes, through the CSV writer's own decoder and
 * SQL: the penny fields are rendered as dollar strings and fed to `csvRowToPriceRows`
 * (`lib/pricechartingCsv.ts` — loose → the ungraded row with retail buy/sell; every graded bucket
 * → one row with the SAME label / company / is_perfect), then bound to `PRICE_UPSERT_SQL`
 * (`pricechartingIngest.ts`). `is_graded` comes from the bucket at write time. A successful fetch
 * REPLACES the product's PriceCharting GRADED rows as one batch (a bucket that disappeared is
 * removed); the loose row is upserted. The CSV PROCESS never DELETEs, so it never removes a row
 * this wrote; it re-upserts the buckets it carries (same values) and never touches 19–22 / 1–6.
 *
 * THE RATE LIMIT (PriceCharting revokes accounts for sustained excess of 1 call/second).
 *   • ONE serialized caller: an in-isolate promise chain + a KV slot reservation
 *     (`pc_onview_next_slot`, ms): each call reserves `max(now, lastSlot + interval)` BEFORE it
 *     waits, so concurrent callers queue behind each other across invocations. The interval is
 *     `PC_ONVIEW_MIN_INTERVAL_MS` (default 1,100; never below 1,100 whatever the var says).
 *   • A bounded queue: a slot more than `PC_ONVIEW_MAX_QUEUE` intervals away is refused —
 *     `capacity` (dropped and logged, never queued without bound).
 *   • A daily counter `pc_onview_calls:<UTC day>` refusing at `PC_ONVIEW_DAILY_CAP` −
 *     `PC_ONVIEW_RESERVE` (defaults 2,000 / 100 — the reserve is head-room for the admin
 *     on-demand path, which does not count here). An audit log line every 50 calls.
 *   • A 429 is never retried: it arms a 60 s cooldown (`pc_onview_cooldown`) during which every
 *     on-view call answers `capacity`.
 *   ⚠️ KV is eventually consistent across colos, so two invocations in DIFFERENT locations can
 *   still read the same slot; the in-isolate chain removes the same-isolate race. Filed: a
 *   Durable Object pacer if traffic ever makes that matter.
 *
 * THE ID. `pricecharting_products` first (exact; with several map rows for one product — PC's
 * twin rows — the CSV writer's own `twinRank` picks the owner). Else ONE validated search
 * (`pickBestPcMatch`) over candidates whose console LANGUAGE equals the product's (Japanese for
 * Pokémon Japan, else the set name's) — a weak match is a MISS, never a guess; the fetched
 * product's `tcg-id`, when present, must equal ours. A hit is persisted into
 * `pricecharting_products` (`match_method='api-search'`) so the next view is one call, not two,
 * and so Content can link the PriceCharting page (the licence's attribution). A miss marks the
 * negative freshness class for 24 h.
 *
 * FRESHNESS (`card_enrichment_freshness`, free-text `data_class` — no migration):
 * `pricecharting_product` 7 days; `force` (the user's Refresh) honours a 24 h floor whatever the
 * client sends; `pricecharting_product_miss` 24 h. The CSV run never touches these classes.
 */

import type { Env } from '../worker.js'
import { pcGet, pickBestPcMatch } from './pricechartingClient.js'
import {
  CATEGORY_FOREIGN_TCGPLAYER_IDS, csvRowToPriceRows, isSealedRow, norm, normalizeUpc,
  pcCategoryForTcgplayerCategoryId, stripCollectorNumberSuffix, textLanguage,
  type PcCsvRow, type PcDecodedPriceRow,
} from './pricechartingCsv.js'
import { PRICE_UPSERT_SQL, twinRank } from '../pricechartingIngest.js'
import { readSwitch } from '../justtcgIngest.js'
import { logger } from '../ingestion/logger.js'

export const PC_ONVIEW_SWITCH         = 'pricecharting_onview_enabled'
export const PC_ONVIEW_CLASS          = 'pricecharting_product'
export const PC_ONVIEW_MISS_CLASS     = 'pricecharting_product_miss'
export const PC_ONVIEW_FRESH_SECONDS  = 7 * 86_400
export const PC_ONVIEW_FORCE_FLOOR_SECONDS = 86_400
export const PC_ONVIEW_MISS_SECONDS   = 86_400
export const PC_API_SEARCH_METHOD     = 'api-search'

export const DEFAULT_DAILY_CAP       = 2_000
export const DEFAULT_RESERVE         = 100
export const MIN_INTERVAL_FLOOR_MS   = 1_100
export const DEFAULT_MAX_QUEUE       = 12
export const COOLDOWN_SECONDS        = 60
export const AUDIT_EVERY             = 50
export const NEXT_SLOT_KEY           = 'pc_onview_next_slot'
export const COOLDOWN_KEY            = 'pc_onview_cooldown'

/** `app_config.pricecharting_onview_enabled` — '1' on, anything else (absent, '0') off. */
export const pcOnViewEnabled = (db: D1Database) => readSwitch(db, PC_ONVIEW_SWITCH, false)

function intEnv(v: string | undefined, dflt: number): number {
  const n = v == null ? NaN : parseInt(v, 10)
  return Number.isFinite(n) && n >= 0 ? n : dflt
}

export function pcOnViewLimits(env: Pick<Env, 'PC_ONVIEW_DAILY_CAP' | 'PC_ONVIEW_RESERVE' | 'PC_ONVIEW_MIN_INTERVAL_MS' | 'PC_ONVIEW_MAX_QUEUE'>) {
  return {
    dailyCap:      intEnv(env.PC_ONVIEW_DAILY_CAP, DEFAULT_DAILY_CAP),
    reserve:       intEnv(env.PC_ONVIEW_RESERVE, DEFAULT_RESERVE),
    // Never faster than 1.1 s apart, whatever the var says (PriceCharting: 1 call/second).
    minIntervalMs: Math.max(MIN_INTERVAL_FLOOR_MS, intEnv(env.PC_ONVIEW_MIN_INTERVAL_MS, MIN_INTERVAL_FLOOR_MS)),
    maxQueue:      Math.max(1, intEnv(env.PC_ONVIEW_MAX_QUEUE, DEFAULT_MAX_QUEUE)),
  }
}

/** `pc_onview_calls:<YYYY-MM-DD>` (UTC). Content's Ingestion Jobs panel reads the same key. */
export function onViewCounterKey(now: Date = new Date()): string {
  return `pc_onview_calls:${now.toISOString().slice(0, 10)}`
}

/** Thrown (and caught by `enrichPcCard`) when a call must not be made now — the caller's "later". */
export class PcCapacityError extends Error {
  constructor(public why: 'daily_cap' | 'queue_full' | 'cooldown' | 'no_kv') {
    super(`pricecharting on-view capacity: ${why}`)
    this.name = 'PcCapacityError'
  }
}

// ── The paced, single-flight call ───────────────────────────────────────────────────────────────

let chain: Promise<unknown> = Promise.resolve()
/** Run `fn` after every earlier on-view call in THIS isolate has finished (no same-isolate burst). */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.catch(() => undefined)
  return run
}

const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export interface PaceDeps { now?: () => number; sleep?: (ms: number) => Promise<void> }

/**
 * Reserve the next call slot (KV, cross-invocation) and the day's budget, then wait for the slot.
 * Refuses — never waits unboundedly — on the daily cap, a full queue, a 429 cooldown or no KV.
 * Returns the ms waited.
 */
export async function reservePcSlot(env: Env, deps: PaceDeps = {}): Promise<number> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? defaultSleep
  const kv = env.SLEEVEDPAGES_KV
  if (!kv) throw new PcCapacityError('no_kv')
  const { dailyCap, reserve, minIntervalMs, maxQueue } = pcOnViewLimits(env)
  if (await kv.get(COOLDOWN_KEY)) throw new PcCapacityError('cooldown')

  const t0 = now()
  const counterKey = onViewCounterKey(new Date(t0))
  const used = parseInt((await kv.get(counterKey)) ?? '0', 10) || 0
  if (used >= Math.max(0, dailyCap - reserve)) {
    logger.warn('pricecharting_onview_capacity', { why: 'daily_cap', used, cap: dailyCap, reserve })
    throw new PcCapacityError('daily_cap')
  }
  const last = Number((await kv.get(NEXT_SLOT_KEY)) ?? 0) || 0
  const slot = Math.max(t0, last + minIntervalMs)
  if (slot - t0 > maxQueue * minIntervalMs) {
    logger.warn('pricecharting_onview_capacity', { why: 'queue_full', waitMs: slot - t0, maxQueue })
    throw new PcCapacityError('queue_full')
  }
  // Reserve BEFORE waiting, so the next caller queues behind this slot. KV's minimum TTL is 60 s.
  await kv.put(NEXT_SLOT_KEY, String(slot), { expirationTtl: 60 })
  const next = used + 1
  await kv.put(counterKey, String(next), { expirationTtl: 2 * 86_400 })
  if (next % AUDIT_EVERY === 0) logger.info('pricecharting_onview_calls', { day: counterKey.slice(-10), used: next, cap: dailyCap })
  const wait = slot - t0
  if (wait > 0) await sleep(wait)
  return wait
}

/**
 * ONE paced PriceCharting API GET for the on-view path (reuses `pcGet` — the token stays inside it).
 * A 429 arms the cooldown and becomes `capacity`; never retried.
 */
export async function pacedPcGet(env: Env, path: string, params: Record<string, string>, deps: PaceDeps = {}): Promise<{ status: number; body: any }> {
  return serialized(async () => {
    await reservePcSlot(env, deps)
    const res = await pcGet(env, path, params)
    if (res.status === 429) {
      await env.SLEEVEDPAGES_KV?.put(COOLDOWN_KEY, '1', { expirationTtl: COOLDOWN_SECONDS })
      logger.warn('pricecharting_onview_429', { path })
      throw new PcCapacityError('cooldown')
    }
    return res
  })
}

/** The paced product fetch (`GET /api/product?id=`). */
export function fetchPcProduct(env: Env, pcId: string, deps: PaceDeps = {}) {
  return pacedPcGet(env, '/api/product', { id: pcId }, deps)
}

// ── The PURE mapper ─────────────────────────────────────────────────────────────────────────────

const PRICE_FIELD = /^(?:.+-price|retail-loose-buy|retail-loose-sell)$/

/**
 * An `/api/product` response → the canonical `prices` rows to write for `canonicalProductId`. PURE.
 * Integer PENNIES → dollar strings → the CSV writer's own `csvRowToPriceRows`, so a bucket decodes
 * to the same label / company / is_perfect whichever path priced it (no second decode map).
 * A non-integer / zero / negative field is skipped (unpriced stays unpriced, never $0).
 */
export function pcProductToPriceRows(
  product: Record<string, unknown> | null | undefined,
  canonicalProductId: number,
  opts: { isSealed?: boolean } = {},
): Array<PcDecodedPriceRow & { productId: number }> {
  const row: PcCsvRow = {}
  for (const [k, v] of Object.entries(product ?? {})) {
    if (!PRICE_FIELD.test(k)) continue
    const pennies = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN)
    if (!Number.isInteger(pennies) || pennies <= 0) continue
    row[k] = (pennies / 100).toFixed(2)
  }
  const genre = typeof product?.genre === 'string' ? { genre: product.genre as string } : {}
  const isSealed = !!opts.isSealed || isSealedRow(genre as PcCsvRow)
  return csvRowToPriceRows(row, { isSealed }).map(r => ({ ...r, productId: canonicalProductId }))
}

// ── Resolving the PriceCharting id ──────────────────────────────────────────────────────────────

export interface PcProductMeta {
  id: number
  name: string
  number: string | null
  setName: string | null
  tcgplayerId: number | null
  categoryId: number | null
  productKind: string | null
}

/** The language a product's PriceCharting console must resolve to: a foreign sibling catalogue's
 *  own (Japanese for Pokémon Japan, category 85), else whatever the set name declares. PURE. */
export function expectedConsoleLanguage(categoryId: number | null, setName: string | null): string {
  for (const map of Object.values(CATEGORY_FOREIGN_TCGPLAYER_IDS)) {
    if (categoryId != null && map[categoryId]) return map[categoryId]
  }
  return textLanguage(norm(setName))
}

/** The `game_category` a persisted api-search row carries: the CSV category of the game (or of
 *  its foreign sibling catalogue), else 'api-only' (a game PriceCharting has no CSV for). PURE. */
export function gameCategoryFor(categoryId: number | null): string {
  const direct = pcCategoryForTcgplayerCategoryId(categoryId)
  if (direct) return direct
  for (const [cat, map] of Object.entries(CATEGORY_FOREIGN_TCGPLAYER_IDS)) {
    if (categoryId != null && map[categoryId]) return cat
  }
  return 'api-only'
}

interface MapRow { pc_id: string; product_name: string | null; console_name: string | null }

/** Several map rows for one product (PC twins) → the CSV writer's owner: lowest `twinRank`, then
 *  the lowest numeric pc id. PURE. */
export function pickMapOwner(rows: MapRow[], product: Pick<PcProductMeta, 'number' | 'setName'>): string | null {
  let best: { pcId: string; rank: number } | null = null
  for (const r of rows) {
    const rank = twinRank({ 'product-name': r.product_name ?? '', 'console-name': r.console_name ?? '' }, product)
    if (!best || rank < best.rank || (rank === best.rank && Number(r.pc_id) < Number(best.pcId))) best = { pcId: String(r.pc_id), rank }
  }
  return best?.pcId ?? null
}

export type ResolveResult =
  | { pcId: string; method: 'map' | typeof PC_API_SEARCH_METHOD; search?: { productName: string | null; console: string | null } }
  | { pcId: null; reason: 'no_match' | 'transient' }

export async function resolvePcId(env: Env, product: PcProductMeta, deps: PaceDeps = {}): Promise<ResolveResult> {
  const { results } = await env.DB.prepare(
    `SELECT pc_id, product_name, console_name FROM pricecharting_products WHERE canonical_product_id = ?`,
  ).bind(product.id).all<MapRow>()
  if (results?.length) {
    const owner = pickMapOwner(results, product)
    if (owner) return { pcId: owner, method: 'map' }
  }

  // ONE validated search. The query and the match both use the name with TCGplayer's
  // " - 021/087" stripped (Pokémon Japan carries it; PriceCharting writes "#21").
  const name = stripCollectorNumberSuffix(product.name)
  const q = `${name} ${product.setName ?? ''}`.trim()
  const { status, body } = await pacedPcGet(env, '/api/products', { q }, deps)
  if (status !== 200 || body?.status === 'error') return { pcId: null, reason: 'transient' }
  const lang = expectedConsoleLanguage(product.categoryId, product.setName)
  const candidates = (Array.isArray(body?.products) ? body.products : [])
    .filter((p: any) => textLanguage(norm(p?.['console-name'])) === lang)
  const match = pickBestPcMatch(candidates, { name, setName: product.setName, number: product.number })
  if (!match?.id) return { pcId: null, reason: 'no_match' }
  const pcId = String(match.id)
  // A PriceCharting product already stamped onto ANOTHER canonical product is not ours to take.
  const owner = await env.DB.prepare(`SELECT canonical_product_id FROM pricecharting_products WHERE pc_id = ?`)
    .bind(pcId).first<{ canonical_product_id: number | null }>()
  if (owner?.canonical_product_id != null && Number(owner.canonical_product_id) !== product.id) {
    return { pcId: null, reason: 'no_match' }
  }
  return { pcId, method: PC_API_SEARCH_METHOD, search: { productName: match['product-name'] ?? null, console: match['console-name'] ?? null } }
}

// ── SQL ─────────────────────────────────────────────────────────────────────────────────────────

export const PRODUCT_META_SQL = `
  SELECT p.id, p.name, p.number, p.tcgplayer_product_id, p.product_kind,
         s.name AS set_name, g.tcgplayer_category_id AS category_id
  FROM   products p JOIN sets s ON s.id = p.set_id JOIN canonical_games g ON g.id = s.game_id
  WHERE  p.id = ? LIMIT 1`

/** Per-product replace: the product's PriceCharting GRADED rows go, the fresh set lands (same batch). */
export const PC_GRADED_CLEAR_SQL =
  `DELETE FROM prices WHERE product_id = ? AND source = 'pricecharting' AND is_graded = 1`

export const FRESHNESS_MARK_SQL = `
  INSERT INTO card_enrichment_freshness (product_id, data_class, enriched_at) VALUES (?, ?, ?)
  ON CONFLICT (product_id, data_class) DO UPDATE SET enriched_at = excluded.enriched_at`

export const FRESHNESS_CLEAR_SQL =
  `DELETE FROM card_enrichment_freshness WHERE product_id = ? AND data_class = ?`

/** A search hit is persisted so the next view is one call. Never steals a stamped row (the
 *  pre-check above refuses that); fills an UNMATCHED row's product id; keeps every stamp. */
export const MAP_API_SEARCH_UPSERT_SQL = `
  INSERT INTO pricecharting_products
    (pc_id, game_category, canonical_product_id, match_method, tcg_id, console_name, product_name,
     is_sealed, sales_volume, upc, matched_at, last_seen_at)
  VALUES (?, ?, ?, '${PC_API_SEARCH_METHOD}', ?, ?, ?, ?, ?, ?, ?, unixepoch())
  ON CONFLICT (pc_id) DO UPDATE SET
    canonical_product_id = COALESCE(pricecharting_products.canonical_product_id, excluded.canonical_product_id),
    match_method = CASE WHEN pricecharting_products.canonical_product_id IS NULL THEN excluded.match_method ELSE pricecharting_products.match_method END,
    matched_at   = CASE WHEN pricecharting_products.canonical_product_id IS NULL THEN excluded.matched_at ELSE pricecharting_products.matched_at END,
    sales_volume = COALESCE(excluded.sales_volume, pricecharting_products.sales_volume),
    upc          = COALESCE(excluded.upc, pricecharting_products.upc)`

export const MAP_SALES_VOLUME_SQL =
  `UPDATE pricecharting_products SET sales_volume = COALESCE(?, sales_volume) WHERE pc_id = ?`

// ── The enrich ──────────────────────────────────────────────────────────────────────────────────

export interface PcEnrichResult {
  ok: boolean
  /** true only when THIS call fetched PriceCharting and wrote. */
  refreshed: boolean
  written: number
  pcId: string | null
  /** unix seconds of the data now held (the last successful fetch), or null when there is none. */
  fetchedAt: number | null
  reason?: 'fresh' | 'floor' | 'no_match' | 'no_product' | 'capacity' | 'transient'
  capacity?: PcCapacityError['why']
  method?: 'map' | typeof PC_API_SEARCH_METHOD
}

function salesVolumeOf(product: any): number | null {
  const raw = product?.['sales-volume']
  if (raw == null || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

/**
 * The on-view refresh for ONE product: freshness → resolve the id → ONE paced fetch → ONE batch.
 * Never throws for the expected outcomes — capacity / transient / no match come back as `reason`.
 */
export async function enrichPcCard(
  env: Env,
  canonicalProductId: number,
  opts: { force?: boolean; nowSec?: number } & PaceDeps = {},
): Promise<PcEnrichResult> {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000)
  const base: PcEnrichResult = { ok: true, refreshed: false, written: 0, pcId: null, fetchedAt: null }

  const row = await env.DB.prepare(PRODUCT_META_SQL).bind(canonicalProductId).first<any>()
  if (!row) return { ...base, reason: 'no_product' }
  const product: PcProductMeta = {
    id: Number(row.id), name: String(row.name ?? ''), number: row.number ?? null, setName: row.set_name ?? null,
    tcgplayerId: row.tcgplayer_product_id != null ? Number(row.tcgplayer_product_id) : null,
    categoryId: row.category_id != null ? Number(row.category_id) : null, productKind: row.product_kind ?? null,
  }

  const { results: freshRows } = await env.DB.prepare(
    `SELECT data_class, enriched_at FROM card_enrichment_freshness WHERE product_id = ? AND data_class IN (?, ?)`,
  ).bind(canonicalProductId, PC_ONVIEW_CLASS, PC_ONVIEW_MISS_CLASS).all<{ data_class: string; enriched_at: number | null }>()
  const at = (cls: string) => {
    const r = (freshRows ?? []).find(f => f.data_class === cls)
    return r?.enriched_at != null ? Number(r.enriched_at) : null
  }
  const hitAt = at(PC_ONVIEW_CLASS)
  const missAt = at(PC_ONVIEW_MISS_CLASS)
  const floor = opts.force ? PC_ONVIEW_FORCE_FLOOR_SECONDS : PC_ONVIEW_FRESH_SECONDS
  if (hitAt != null && nowSec - hitAt < floor) {
    const { results } = await env.DB.prepare(
      `SELECT pc_id, product_name, console_name FROM pricecharting_products WHERE canonical_product_id = ?`,
    ).bind(canonicalProductId).all<MapRow>()
    return { ...base, fetchedAt: hitAt, pcId: pickMapOwner(results ?? [], product), reason: opts.force ? 'floor' : 'fresh' }
  }
  if (missAt != null && nowSec - missAt < PC_ONVIEW_MISS_SECONDS) return { ...base, reason: 'no_match' }

  const deps: PaceDeps = { now: opts.now, sleep: opts.sleep }
  const markMiss = () => env.DB.batch([env.DB.prepare(FRESHNESS_MARK_SQL).bind(canonicalProductId, PC_ONVIEW_MISS_CLASS, nowSec)])
  try {
    const resolved = await resolvePcId(env, product, deps)
    if (resolved.pcId == null) {
      if (resolved.reason === 'transient') return { ...base, ok: false, reason: 'transient', fetchedAt: hitAt }
      await markMiss()
      return { ...base, reason: 'no_match' }
    }

    const { status, body } = await fetchPcProduct(env, resolved.pcId, deps)
    if (status !== 200 || body?.status !== 'success' || String(body?.id ?? resolved.pcId) !== resolved.pcId) {
      return { ...base, ok: false, reason: 'transient', pcId: resolved.pcId, fetchedAt: hitAt }
    }
    // A search hit whose own TCGplayer id names a DIFFERENT product is not ours (never a guess).
    const theirTcg = Number(String(body?.['tcg-id'] ?? '').trim())
    if (resolved.method === PC_API_SEARCH_METHOD && Number.isInteger(theirTcg) && theirTcg > 0
        && product.tcgplayerId != null && theirTcg !== product.tcgplayerId) {
      await markMiss()
      return { ...base, reason: 'no_match' }
    }

    const rows = pcProductToPriceRows(body, canonicalProductId, { isSealed: product.productKind === 'sealed' })
    const stmts: D1PreparedStatement[] = [env.DB.prepare(PC_GRADED_CLEAR_SQL).bind(canonicalProductId)]
    for (const pr of rows) {
      const finish = pr.grade == null ? 'normal' : null
      stmts.push(env.DB.prepare(PRICE_UPSERT_SQL).bind(
        canonicalProductId, null, finish, pr.grade, pr.company ?? null, pr.isPerfect ? 1 : 0,
        pr.grade == null ? 0 : 1, pr.valueDollars, pr.retailBuyDollars ?? null, pr.retailSellDollars ?? null,
      ))
    }
    const sales = salesVolumeOf(body)
    if (resolved.method === PC_API_SEARCH_METHOD) {
      stmts.push(env.DB.prepare(MAP_API_SEARCH_UPSERT_SQL).bind(
        resolved.pcId, gameCategoryFor(product.categoryId), canonicalProductId,
        String(body?.['tcg-id'] ?? '').trim() || null,
        (body?.['console-name'] ?? resolved.search?.console ?? null),
        (body?.['product-name'] ?? resolved.search?.productName ?? null),
        isSealedRow({ genre: String(body?.genre ?? '') }) ? 1 : 0, sales, normalizeUpc(body?.upc), nowSec,
      ))
    } else {
      stmts.push(env.DB.prepare(MAP_SALES_VOLUME_SQL).bind(sales, resolved.pcId))
    }
    stmts.push(env.DB.prepare(FRESHNESS_MARK_SQL).bind(canonicalProductId, PC_ONVIEW_CLASS, nowSec))
    stmts.push(env.DB.prepare(FRESHNESS_CLEAR_SQL).bind(canonicalProductId, PC_ONVIEW_MISS_CLASS))
    await env.DB.batch(stmts)
    return { ok: true, refreshed: true, written: rows.length, pcId: resolved.pcId, fetchedAt: nowSec, method: resolved.method }
  } catch (err) {
    if (err instanceof PcCapacityError) return { ...base, ok: false, reason: 'capacity', capacity: err.why, fetchedAt: hitAt }
    throw err
  }
}
