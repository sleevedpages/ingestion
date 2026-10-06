/**
 * justtcgIngest.ts — JustTCG as a `prices` source: the condition tiers (NM/LP/MP/HP/DM) and the
 * NM rung of the raw ladder (session 2026-10-06, "the JustTCG switch").
 *
 * WHAT IT WRITES. Canonical `prices` rows with `source='justtcg'`, `is_graded=0`, `grade/company/
 * variant NULL`, the five tier codes in `condition`, the product's CANONICAL printing token in
 * `finish` (the same `finishKey()` vocabulary the read-side ladder compares through), JustTCG's
 * `price` in `value` and its `lastUpdated` in `fetched_at`. Nothing else: no spread (JustTCG gives
 * none per variant), no trends (our own `price_daily` series carries the headline's trend; a
 * re-anchored tier carries none anyway), no `priceHistory` (filed), no graded variants (the probe
 * measured them too thin to serve — 17 of 64 owned-slab products; filed as a possible supplement
 * behind the same client). `is_graded` is set at write time from the call's own shape: this writer
 * only ever makes the RAW call (`POST /v1/cards`, which never returns graded variants).
 *
 * TWO SWITCHES, BOTH IN CONTENT'S `app_config` (read through this worker's D1 binding — never an
 * env var, so a flip is an UPDATE, not a deploy): `justtcg_ingest_enabled` (code default '0') gates
 * this whole file — the nightly lane and the on-view enrich; `justtcg_serve_enabled` is Content's
 * (the read side) and is never read here. Dual-run = ingest ON, serve OFF.
 *
 * THE LANGUAGE RULE (the probe pinned the shape, 2026-10-05). A JustTCG card lists every language
 * it trades in; a non-English listing carries `language` AND a " - <Language>" suffix on its
 * printing ("Holofoil - Japanese"). A product is written ONLY its own language's variants: Japanese
 * for the Pokémon Japan catalogue (whose cards have their own TCGplayer ids, so the batch lookup by
 * id lands them on the Pokémon Japan product), English for everything else. A Japanese variant
 * returned for an English product is SKIPPED and counted — it is never written to the English
 * product, and it cannot be "routed" anywhere else (we hold no English→Japanese product bridge).
 *
 * THE LANE (`justtcg-refresh`, shares the `0 7 * * *` slot with the news poll as a separate promise
 * — the 09:00 precedent; 07:00 sits after the 06:00 TCGCSV fan-out and before the 08:00 anomaly
 * scan). Population = DISTINCT canonical products in `user_inventory` ∪ `vendor_card_prices` (via its
 * inventory row) ∪ `card_watches` that carry a TCGplayer id and are not fresh under the
 * `card_enrichment_freshness` class `justtcg_tiers` (24 h), oldest first. ONE raw batch per 100
 * products. Bounded by the KV daily counter (`justtcg_calls:<UTC day>`, resynced from JustTCG's own
 * meter) with `JUSTTCG_LANE_ONVIEW_RESERVE` (default 200) calls left for on-view enrich, and by
 * `JUSTTCG_LANE_MAX_CALLS` (default 30) per run as `waitUntil` safety. Idempotent: a product's
 * JustTCG raw rows are REPLACED as one atomic group (DELETE + INSERT in one batch) when, and only
 * when, its card came back in the response — a card JustTCG did not return keeps its rows.
 */

import type { Env } from './worker.js'
import {
  JustTcgError, justtcgBatchByTcgplayerIds, justtcgConfigured, justtcgLimits, readDailyCounter,
  type JtV1Card, type JtV1Variant,
} from './lib/justtcgClient.js'
import { logger } from './ingestion/logger.js'

export const JUSTTCG_SOURCE = 'justtcg'
/** `card_enrichment_freshness.data_class` for the JustTCG tiers (free-text column; no migration). */
export const JUSTTCG_FRESHNESS_CLASS = 'justtcg_tiers'
export const JUSTTCG_FRESHNESS_SECONDS = 24 * 3600
export const DEFAULT_LANE_ONVIEW_RESERVE = 200
export const DEFAULT_LANE_MAX_CALLS = 30
/** D1 caps bound parameters at 100 per statement — every IN(...) here chunks at 90. */
const CHUNK = 90
/** Statements per `db.batch()` — a product's group is never split across two batches. */
const BATCH_STATEMENTS = 90

// ── The switches (Content's app_config, code defaults when the row or the table is absent) ─────

export const SWITCH_KEYS = {
  ingest: 'justtcg_ingest_enabled',
  scrydexDrain: 'scrydex_drain_enabled',
} as const

/**
 * Read one `app_config` on/off switch: '1' → true, '0' → false, anything else (row absent, blank,
 * table missing, D1 error) → the code default. Never throws — a switch read must never be the
 * thing that fails a cron.
 */
export async function readSwitch(db: D1Database, key: string, dflt: boolean): Promise<boolean> {
  try {
    const row = await db.prepare('SELECT value FROM app_config WHERE key = ?').bind(key).first<{ value: string | null }>()
    const v = String(row?.value ?? '').trim()
    if (v === '1') return true
    if (v === '0') return false
    return dflt
  } catch {
    return dflt
  }
}

export const justtcgIngestEnabled = (db: D1Database) => readSwitch(db, SWITCH_KEYS.ingest, false)
export const scrydexDrainEnabled  = (db: D1Database) => readSwitch(db, SWITCH_KEYS.scrydexDrain, true)

// ── The pure mapping (JustTCG v1 card → our rows) ───────────────────────────────────────────────

export const TIER_CODES = ['NM', 'LP', 'MP', 'HP', 'DM'] as const
export type TierCode = (typeof TIER_CODES)[number]

/** JustTCG's condition names → our tier codes. Anything else ('Sealed', …) → null (skipped, counted). */
export function justtcgConditionCode(condition: unknown): TierCode | null {
  const c = String(condition ?? '').trim().toLowerCase()
  if (c === 'near mint' || c === 'nm') return 'NM'
  if (c === 'lightly played' || c === 'lp') return 'LP'
  if (c === 'moderately played' || c === 'mp') return 'MP'
  if (c === 'heavily played' || c === 'hp') return 'HP'
  if (c === 'damaged' || c === 'dm') return 'DM'
  return null
}

/** Twin of Content `finishKey()` (functions/lib/pricing.js) — pinned by justtcgIngest.test.ts. */
export function finishKey(finish: unknown): string | null {
  if (finish == null) return null
  const s = String(finish)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/\b1st\b/g, 'first')
    .replace(/\bedition\b/g, '')
    .replace(/[^a-z0-9]/g, '')
  return s || null
}

/** The language a product is written in: Japanese for the Pokémon Japan catalogue, else English. */
export function productLanguage(game: string | null | undefined): 'english' | 'japanese' {
  return /japan/i.test(String(game ?? '')) ? 'japanese' : 'english'
}

function variantLanguage(v: JtV1Variant): string {
  const l = String(v.language ?? '').trim().toLowerCase()
  if (!l || l === 'en' || l === 'english') return 'english'
  if (l === 'ja' || l === 'jp' || l === 'japanese') return 'japanese'
  return l
}

/** JustTCG suffixes a non-English printing with " - <Language>" ("Holofoil - Japanese"). */
export function stripLanguageSuffix(printing: unknown): string {
  return String(printing ?? '').replace(/\s+-\s+[A-Za-z() ]+$/, '').trim()
}

export interface PrintingRow { variant: string | null; finish: string | null; source: string | null; is_graded: number | null }

/**
 * The product's canonical printing token per `finishKey` — the twin of Content's
 * `unifiedPrintings()` ranking (TCGplayer spelling first, then a `variant`, then the Scrydex
 * token). PriceCharting / JustTCG rows are not evidence of a printing. Returns key → token.
 */
export function canonicalPrintingTokens(rows: PrintingRow[]): Map<string, string> {
  const RANK: Record<string, number> = { tcgplayer: 0, variant: 1, scrydex: 2 }
  const best = new Map<string, { token: string; rank: number }>()
  const offer = (token: string | null, origin: string) => {
    const key = finishKey(token)
    if (!key || token == null) return
    const cur = best.get(key)
    if (!cur || RANK[origin] < cur.rank) best.set(key, { token, rank: RANK[origin] })
  }
  for (const r of rows ?? []) {
    if (r.is_graded === 1) continue
    if (r.variant != null) offer(r.variant, 'variant')
    if (r.finish == null) continue
    if (r.source === 'tcgplayer') offer(r.finish, 'tcgplayer')
    else if (r.source === 'scrydex') offer(r.finish, 'scrydex')
  }
  return new Map([...best.entries()].map(([k, v]) => [k, v.token]))
}

export interface JtRow { condition: TierCode; finish: string; value: number; fetchedAt: number }

export interface MapCounts {
  variants: number
  written: number
  skippedLanguage: number
  skippedCondition: number
  skippedNoPrice: number
  skippedNoPrinting: number
  duplicates: number
  unmappedFinish: number
}

export const emptyMapCounts = (): MapCounts => ({
  variants: 0, written: 0, skippedLanguage: 0, skippedCondition: 0, skippedNoPrice: 0,
  skippedNoPrinting: 0, duplicates: 0, unmappedFinish: 0,
})

/**
 * Map ONE JustTCG v1 card to the rows this writer stores for ONE of our products. PURE.
 * Per variant: own language only → a known tier code → a numeric price → the printing (language
 * suffix stripped) mapped to the product's canonical token by `finishKey`, else JustTCG's own
 * spelling (counted as `unmappedFinish` — the compare endpoint lists these). One row per
 * (condition, printing key): a duplicate keeps the most recently updated listing.
 *
 * ⚠️ An unmapped printing is NEVER folded into the product's only stored printing (decided
 * 2026-10-06, the fix-ups session). The case: One Piece "Charlotte Daifuku (Pandaman Art)"
 * (TCGplayer 712655) — our printings `['normal']`, JustTCG sends `Foil`. JustTCG lists that card
 * with BOTH `Normal` (NM 5.09) and `Foil` (NM 6.29), and TCGCSV's One Piece vocabulary carries
 * `Foil` as a real printing (3,400 products; 108 carry Normal AND Foil, prod read-only), so folding
 * `Foil` onto `normal` would overwrite a real Normal tier with a foil price. Kept unmapped — the
 * row is stored as `Foil`, never adds a printing to the selector, and the compare tab lists it.
 */
export function mapJustTcgCard(
  card: JtV1Card,
  product: { game: string | null; printings: Map<string, string> },
  nowSec: number = Math.floor(Date.now() / 1000),
): { rows: JtRow[]; counts: MapCounts } {
  const counts = emptyMapCounts()
  const lang = productLanguage(product.game)
  const byKey = new Map<string, JtRow>()
  for (const v of card.variants ?? []) {
    counts.variants++
    if (variantLanguage(v) !== lang) { counts.skippedLanguage++; continue }
    const condition = justtcgConditionCode(v.condition)
    if (!condition) { counts.skippedCondition++; continue }
    const price = typeof v.price === 'number' && Number.isFinite(v.price) ? v.price : null
    if (price == null) { counts.skippedNoPrice++; continue }
    const printing = stripLanguageSuffix(v.printing)
    const key = finishKey(printing)
    if (!key) { counts.skippedNoPrinting++; continue }
    const canonical = product.printings.get(key)
    const finish = canonical ?? printing
    const fetchedAt = typeof v.lastUpdated === 'number' && Number.isFinite(v.lastUpdated) && v.lastUpdated > 0
      ? Math.floor(v.lastUpdated) : nowSec
    const id = `${condition}|${key}`
    const prev = byKey.get(id)
    if (prev) {
      counts.duplicates++
      if (fetchedAt <= prev.fetchedAt) continue
    } else if (!canonical) {
      counts.unmappedFinish++
    }
    byKey.set(id, { condition, finish, value: price, fetchedAt })
  }
  const rows = [...byKey.values()]
  counts.written = rows.length
  return { rows, counts }
}

// ── The writer ─────────────────────────────────────────────────────────────────────────────────

/** The ONE insert — its ON CONFLICT is the mig-0073 SUPERSET identity key, like every prices writer. */
export const JUSTTCG_PRICE_UPSERT_SQL = `
  INSERT INTO prices (product_id, source, condition, finish, grade, variant, company, is_graded, value, fetched_at)
  VALUES (?, 'justtcg', ?, ?, NULL, NULL, NULL, 0, ?, ?)
  ON CONFLICT (product_id, source, COALESCE(condition,''), COALESCE(finish,''), COALESCE(grade,''),
               COALESCE(variant,''), COALESCE(company,''), is_signed, is_error, is_perfect)
  DO UPDATE SET value = excluded.value, is_graded = excluded.is_graded, fetched_at = excluded.fetched_at`

/** Clears ONE product's JustTCG RAW rows before its fresh set lands (same batch — atomic). */
export const JUSTTCG_PRICE_CLEAR_SQL =
  `DELETE FROM prices WHERE product_id = ? AND source = 'justtcg' AND is_graded = 0`

export const FRESHNESS_UPSERT_SQL = `
  INSERT INTO card_enrichment_freshness (product_id, data_class, enriched_at)
  VALUES (?, '${JUSTTCG_FRESHNESS_CLASS}', ?)
  ON CONFLICT (product_id, data_class) DO UPDATE SET enriched_at = excluded.enriched_at`

export interface LaneProduct { id: number; tcgplayerId: number; game: string | null }

async function chunkedAll<T>(db: D1Database, ids: number[], sql: (ph: string) => string): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const { results } = await db.prepare(sql(chunk.map(() => '?').join(','))).bind(...chunk).all<T>()
    out.push(...(results ?? []))
  }
  return out
}

/** Product identity for a set of canonical ids (TCGplayer id + game), chunked ≤90. */
export async function loadProducts(db: D1Database, productIds: number[]): Promise<LaneProduct[]> {
  const rows = await chunkedAll<{ id: number; tcgplayer_product_id: number | null; game: string | null }>(db, productIds, ph => `
    SELECT p.id, p.tcgplayer_product_id, cg.name AS game
    FROM   products p JOIN sets s ON s.id = p.set_id JOIN canonical_games cg ON cg.id = s.game_id
    WHERE  p.id IN (${ph})`)
  return rows
    .filter(r => r.tcgplayer_product_id != null && Number(r.tcgplayer_product_id) > 0)
    .map(r => ({ id: Number(r.id), tcgplayerId: Number(r.tcgplayer_product_id), game: r.game ?? null }))
}

/** Each product's canonical printing tokens, from its TCGplayer / Scrydex price rows (chunked ≤90). */
export async function loadPrintings(db: D1Database, productIds: number[]): Promise<Map<number, Map<string, string>>> {
  const rows = await chunkedAll<PrintingRow & { product_id: number }>(db, productIds, ph => `
    SELECT DISTINCT product_id, variant, finish, source, is_graded
    FROM   prices
    WHERE  product_id IN (${ph}) AND source IN ('tcgplayer', 'scrydex')`)
  const grouped = new Map<number, PrintingRow[]>()
  for (const r of rows) {
    const pid = Number(r.product_id)
    if (!grouped.has(pid)) grouped.set(pid, [])
    grouped.get(pid)!.push(r)
  }
  const out = new Map<number, Map<string, string>>()
  for (const pid of productIds) out.set(pid, canonicalPrintingTokens(grouped.get(pid) ?? []))
  return out
}

export interface UpsertCounts extends MapCounts {
  requested: number
  resolved: number
  notReturned: number
  productsWritten: number
  rowsWritten: number
  calls: number
  /** Returned by JustTCG, but every listing was skipped → no row (2026-10-06 fix-ups). */
  resolvedNothingWritten: number
}

export const emptyUpsertCounts = (): UpsertCounts => ({
  ...emptyMapCounts(), requested: 0, resolved: 0, notReturned: 0, productsWritten: 0, rowsWritten: 0, calls: 0,
  resolvedNothingWritten: 0,
})

// ── "Resolved, nothing written" (the JustTCG switch fix-ups, 2026-10-06) ───────────────────────
// The first prod lane run resolved 951 products and wrote rows for 876; the run log carried only
// the AGGREGATE skip counts, so the 75 could not be found — and every asked product is marked fresh
// for 24 h, so the on-view enrich will not retry them. Each such product is now counted and (up to
// 20 per run) named with the skip reason that dominated it. The freshness rule is unchanged on
// purpose: a product JustTCG has nothing writable for must not be refetched on every view.

export type NothingWrittenReason = 'condition' | 'language' | 'no_price' | 'no_printing' | 'no_variants'
export interface NothingWrittenExample { productId: number; tcgplayerId: number; reason: NothingWrittenReason; variants: number }
export const NOTHING_WRITTEN_EXAMPLES_MAX = 20

/** The skip that accounts for most of a product's listings (ties: the order below). PURE. */
export function dominantSkipReason(c: MapCounts): NothingWrittenReason {
  if (!c.variants) return 'no_variants'
  const ranked: Array<[NothingWrittenReason, number]> = [
    ['condition', c.skippedCondition], ['language', c.skippedLanguage],
    ['no_price', c.skippedNoPrice], ['no_printing', c.skippedNoPrinting],
  ]
  return ranked.reduce((best, x) => (x[1] > best[1] ? x : best))[0]
}

/** One batch's counts plus the products it resolved but wrote nothing for (≤ 20). */
export interface UpsertResult extends UpsertCounts { resolvedNothingWrittenExamples: NothingWrittenExample[] }

function addMapCounts(into: MapCounts, c: MapCounts) {
  for (const k of Object.keys(c) as Array<keyof MapCounts>) into[k] += c[k]
}

/**
 * ONE raw batch (≤ the plan's batch size) → `prices`. Writes every returned product's rows as one
 * atomic group, then marks EVERY requested product fresh (a product JustTCG does not list is asked
 * again tomorrow, not every run). A JustTcgError propagates — the caller decides stop vs continue.
 */
export async function upsertJustTcgBatch(env: Env, products: LaneProduct[], nowSec: number = Math.floor(Date.now() / 1000)): Promise<UpsertResult> {
  const counts: UpsertResult = { ...emptyUpsertCounts(), resolvedNothingWrittenExamples: [] }
  counts.requested = products.length
  if (!products.length) return counts
  const db = env.DB
  const res = await justtcgBatchByTcgplayerIds(env, products.map(p => p.tcgplayerId))
  counts.calls = 1
  const cards = res.body?.data ?? []
  const cardByTcg = new Map<string, JtV1Card>()
  for (const c of cards) {
    const id = c?.tcgplayerId != null ? String(c.tcgplayerId).trim() : ''
    if (id && !cardByTcg.has(id)) cardByTcg.set(id, c)
  }
  const printings = await loadPrintings(db, products.map(p => p.id))

  const groups: D1PreparedStatement[][] = []
  for (const p of products) {
    const card = cardByTcg.get(String(p.tcgplayerId))
    if (!card) { counts.notReturned++; continue }
    counts.resolved++
    const { rows, counts: mc } = mapJustTcgCard(card, { game: p.game, printings: printings.get(p.id) ?? new Map() }, nowSec)
    addMapCounts(counts, mc)
    const group: D1PreparedStatement[] = [db.prepare(JUSTTCG_PRICE_CLEAR_SQL).bind(p.id)]
    for (const r of rows) group.push(db.prepare(JUSTTCG_PRICE_UPSERT_SQL).bind(p.id, r.condition, r.finish, r.value, r.fetchedAt))
    groups.push(group)
    if (rows.length) { counts.productsWritten++; counts.rowsWritten += rows.length }
    else {
      counts.resolvedNothingWritten++
      if (counts.resolvedNothingWrittenExamples.length < NOTHING_WRITTEN_EXAMPLES_MAX) {
        counts.resolvedNothingWrittenExamples.push({ productId: p.id, tcgplayerId: p.tcgplayerId, reason: dominantSkipReason(mc), variants: mc.variants })
      }
    }
  }
  // Freshness for EVERY requested product, in the same batches as the rows (a killed invocation
  // leaves the product stale → it is redone next run, never silently skipped).
  for (const p of products) groups.push([db.prepare(FRESHNESS_UPSERT_SQL).bind(p.id, nowSec)])

  let batch: D1PreparedStatement[] = []
  for (const g of groups) {
    if (batch.length && batch.length + g.length > BATCH_STATEMENTS) { await db.batch(batch); batch = [] }
    batch.push(...g)
  }
  if (batch.length) await db.batch(batch)
  return counts
}

// ── The lane ───────────────────────────────────────────────────────────────────────────────────

/** The refresh population: owned ∪ vendor-binder ∪ watched products that are stale, oldest first. */
export const LANE_POPULATION_SQL = `
  WITH pop AS (
    SELECT canonical_product_id AS pid FROM user_inventory WHERE canonical_product_id IS NOT NULL
    UNION SELECT ui.canonical_product_id FROM vendor_card_prices v
          JOIN user_inventory ui ON ui.id = v.inventory_card_id WHERE ui.canonical_product_id IS NOT NULL
    UNION SELECT canonical_product_id FROM card_watches
  )
  SELECT pop.pid AS id, f.enriched_at
  FROM   pop
  JOIN   products p ON p.id = pop.pid AND p.tcgplayer_product_id IS NOT NULL
  LEFT JOIN card_enrichment_freshness f ON f.product_id = pop.pid AND f.data_class = '${JUSTTCG_FRESHNESS_CLASS}'
  WHERE  f.enriched_at IS NULL OR f.enriched_at < ?
  ORDER BY COALESCE(f.enriched_at, 0) ASC, pop.pid ASC`

function intEnv(v: string | undefined, dflt: number): number {
  const n = v == null ? NaN : parseInt(v, 10)
  return Number.isFinite(n) && n >= 0 ? n : dflt
}

export interface LaneResult extends UpsertCounts {
  ok: boolean
  skipped?: 'switch_off' | 'not_configured'
  population: number
  stale: number
  batchesRun: number
  batchesFailed: number
  stoppedReason: string | null
  dailyUsedBefore: number | null
  dailyUsedAfter: number | null
  laneAllowed: number | null
  errors: string[]
  /** Up to 20 products the run resolved but wrote nothing for, each with its dominant skip reason. */
  resolvedNothingWrittenExamples: NothingWrittenExample[]
}

/**
 * The nightly `justtcg-refresh` lane. Never throws for a switched-off or unconfigured worker (the
 * run-log row says why); a refused plan (auth / quota / abuse / the counter) STOPS the run with a
 * recorded reason; a transient batch failure (http / network / timeout) skips that batch — its
 * products stay stale and are retried next run.
 */
export async function runJustTcgRefresh(env: Env, opts: { nowSec?: number; maxCalls?: number } = {}): Promise<LaneResult> {
  const out: LaneResult = {
    ok: true, ...emptyUpsertCounts(), population: 0, stale: 0, batchesRun: 0, batchesFailed: 0,
    stoppedReason: null, dailyUsedBefore: null, dailyUsedAfter: null, laneAllowed: null, errors: [],
    resolvedNothingWrittenExamples: [],
  }
  if (!(await justtcgIngestEnabled(env.DB))) return { ...out, skipped: 'switch_off' }
  if (!justtcgConfigured(env)) return { ...out, skipped: 'not_configured' }

  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000)
  const { batchSize, dailyCap } = justtcgLimits(env)
  const onViewReserve = intEnv(env.JUSTTCG_LANE_ONVIEW_RESERVE, DEFAULT_LANE_ONVIEW_RESERVE)
  const maxCalls = opts.maxCalls ?? intEnv(env.JUSTTCG_LANE_MAX_CALLS, DEFAULT_LANE_MAX_CALLS)
  out.laneAllowed = Math.max(0, dailyCap - onViewReserve)

  const { results } = await env.DB.prepare(LANE_POPULATION_SQL).bind(nowSec - JUSTTCG_FRESHNESS_SECONDS).all<{ id: number }>()
  const staleIds = (results ?? []).map(r => Number(r.id))
  out.stale = staleIds.length
  const { results: popRows } = await env.DB.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT canonical_product_id FROM user_inventory WHERE canonical_product_id IS NOT NULL
      UNION SELECT ui.canonical_product_id FROM vendor_card_prices v JOIN user_inventory ui ON ui.id = v.inventory_card_id WHERE ui.canonical_product_id IS NOT NULL
      UNION SELECT canonical_product_id FROM card_watches)`).all<{ n: number }>()
  out.population = Number(popRows?.[0]?.n ?? 0)
  if (!staleIds.length) return out

  const products = await loadProducts(env.DB, staleIds)
  const order = new Map(staleIds.map((id, i) => [id, i]))
  products.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))

  const before = await readDailyCounter(env).catch(() => null)
  out.dailyUsedBefore = before?.used ?? null
  for (let i = 0; i < products.length; i += batchSize) {
    if (out.batchesRun >= maxCalls) { out.stoppedReason = 'max_calls'; break }
    const counter = await readDailyCounter(env).catch(() => null)
    if (!counter || counter.used >= out.laneAllowed) { out.stoppedReason = 'lane_budget'; break }
    const slice = products.slice(i, i + batchSize)
    out.batchesRun++
    try {
      const c = await upsertJustTcgBatch(env, slice, nowSec)
      // Sum the NUMERIC counts only (the batch result also carries the examples list).
      for (const k of Object.keys(emptyUpsertCounts()) as Array<keyof UpsertCounts>) out[k] += c[k]
      for (const e of c.resolvedNothingWrittenExamples) {
        if (out.resolvedNothingWrittenExamples.length >= NOTHING_WRITTEN_EXAMPLES_MAX) break
        out.resolvedNothingWrittenExamples.push(e)
      }
    } catch (err) {
      out.batchesFailed++
      const e = err as JustTcgError
      out.errors.push(String(e?.message ?? err).slice(0, 300))
      if (e instanceof JustTcgError && ['auth', 'quota', 'abuse', 'cap', 'not_configured', 'rate_limit'].includes(e.kind)) {
        out.stoppedReason = e.kind
        out.ok = e.kind === 'rate_limit' || e.kind === 'cap'   // plan refusals are failures; a busy minute / our own cap is not
        break
      }
      if (!(e instanceof JustTcgError)) throw err             // a D1 / code error is a real failure → the run-log row says error
    }
  }
  const after = await readDailyCounter(env).catch(() => null)
  out.dailyUsedAfter = after?.used ?? null
  logger.info('justtcg_refresh', { ...out, errors: out.errors.length })
  return out
}

// ── On-view enrich (one product) ───────────────────────────────────────────────────────────────

export interface EnrichResult extends UpsertCounts { ok: boolean; skipped?: string; productId: number }

/**
 * The on-view refresh Content proxies from `POST /api/cards/enrich` (class `core`) when the ingest
 * switch is ON: one product, one raw call, the same writer + freshness mark. Uses the plan's full
 * daily allowance (the lane leaves `JUSTTCG_LANE_ONVIEW_RESERVE` calls for exactly this).
 */
export async function enrichJustTcgCard(env: Env, canonicalProductId: number, nowSec: number = Math.floor(Date.now() / 1000)): Promise<EnrichResult> {
  const base: EnrichResult = { ok: true, productId: canonicalProductId, ...emptyUpsertCounts() }
  const [product] = await loadProducts(env.DB, [canonicalProductId])
  if (!product) return { ...base, skipped: 'no_tcgplayer_id' }
  const c = await upsertJustTcgBatch(env, [product], nowSec)
  return { ...base, ...c }
}
