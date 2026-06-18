/**
 * scrydexEnrich.ts — Scrydex detail enrichment (tier-aware, lazy, on-view).
 *
 * The Content app fires `POST /scrydex/enrich-card` when an authed Collector+ viewer opens a
 * card-detail surface (Content resolves the tier + per-data-class freshness and only requests
 * the STALE classes the viewer is entitled to). This file does the credit-guarded Scrydex
 * fetches and the canonical upserts, in THREE independent data classes:
 *
 *   core    — GET /{slug}/v1/cards/{scrydexId}?include=prices,pop_reports
 *             → canonical `prices` rows (per variant: raw NM..DM ranges low/mid/high/market +
 *               6-window trends; the graded matrix with company/grade + signed/error/perfect
 *               sub-variants) + `card_pop_reports`.
 *   comps   — GET /{slug}/v1/cards/{scrydexId}/listings        → `card_listings` (sold comps)
 *   history — GET /{slug}/v1/cards/{scrydexId}/price_history   → `card_price_history` (chart)
 *
 * The daily TCGCSV/PriceCharting bulk path is the source for grid market numbers and is
 * UNCHANGED — these rows are ADDITIVE detail (the new `variant`/`company`/flag/`low/mid/high`
 * columns), distinct from the bulk rows under the superset uniqueness key (migration 0073).
 *
 * TIER-RESILIENT: every parser tolerates a missing block (a lower Scrydex plan, or a card with
 * no graded/pop/history) — it persists what's present and never throws. CREDIT-GUARDED: every
 * call goes through scrydexFetch's monthly guard; a guard trip (or a 403 credit cap) stops the
 * run and the caller serves the last-persisted rows rather than overage.
 *
 * ⚠️ The /listings and /price_history response shapes (and pop_reports) are written as TOLERANT
 * readers against the documented Scrydex structure — confirm with one operator probe at deploy
 * (mirrors the PriceCharting / Apify "documented assumption" pattern in this repo).
 */

import type { Env } from './worker.js'
import { scrydexFetch, ScrydexCreditLimitError } from './lib/scrydexClient.js'
import { variantFinish, tcgProductIdOf } from './lib/variantCapture.js'

// Game name (canonical_games.name) → Scrydex slug. Mirrors scrydexProcessor's SLUG_TO_GAME.
const GAME_NAME_TO_SLUG: Record<string, string> = {
  'Pokemon':              'pokemon',
  'Magic':                'magicthegathering',
  'One Piece Card Game':  'onepiece',
  'Gundam Card Game':     'gundam',
  'Lorcana':              'lorcana',
  'Riftbound':            'riftbound',
}

const RAW_CONDITIONS = new Set(['NM', 'LP', 'MP', 'HP', 'DM'])
const BATCH_SIZE          = 90    // D1 binds <= 100 params/statement; the prices upsert binds 21, batch by statement count
const LISTINGS_RETENTION_DAYS = 180
const HISTORY_RETENTION_DAYS  = 365

// ─── small tolerant coercers ──────────────────────────────────────────────────
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    // Tolerate currency-formatted strings ("$2,100.00") some sources emit.
    const n = Number(v.replace(/[$,\s]/g, ''))
    return Number.isFinite(n) ? n : null
  }
  return null
}
function flag(v: unknown): number {
  return v === true || v === 1 || v === '1' ? 1 : 0
}
function toUnix(v: unknown): number | null {
  if (typeof v === 'number') return Math.trunc(v > 1e12 ? v / 1000 : v)  // ms vs s
  if (typeof v === 'string' && v.trim() !== '') {
    const asNum = Number(v)
    if (Number.isFinite(asNum)) return Math.trunc(asNum > 1e12 ? asNum / 1000 : asNum)
    const t = Date.parse(v)
    return Number.isFinite(t) ? Math.trunc(t / 1000) : null
  }
  return null
}
/** Normalise a graded company to the app's canonical set (PSA/BGS/CGC/SGC/TAG/ACE). */
export function normaliseCompany(raw: unknown): string | null {
  if (!raw) return null
  const c = String(raw).trim().toUpperCase()
  if (!c) return null
  if (c === 'CGS') return 'CGC'   // legacy typo guard (mirrors migration 0069)
  return c
}
/** Best-effort Scrydex card id when the canonical row doesn't store one: `{expansion}-{number}`. */
export function deriveScrydexCardId(expansionId: string | null, number: string | null): string | null {
  if (!expansionId || !number) return null
  const bare = String(number).split('/')[0].trim()
  if (!bare) return null
  const noPad = /^\d+$/.test(bare) ? String(parseInt(bare, 10)) : bare
  return `${String(expansionId).toLowerCase()}-${noPad}`
}

// ─── trends (6 windows + full JSON) ─────────────────────────────────────────────
export interface Trends6 {
  trend_1d: number | null; trend_7d: number | null; trend_14d: number | null
  trend_30d: number | null; trend_90d: number | null; trend_180d: number | null
  trends_json: string | null
}
/** Extract the 6 percent-change windows + the full per-window JSON from a Scrydex trends object. */
export function parseTrends6(trends: unknown): Trends6 {
  const t = (trends ?? {}) as Record<string, { percent_change?: number } | undefined>
  const pc = (k: string): number | null => {
    const v = t[k]?.percent_change
    return typeof v === 'number' ? v : null
  }
  return {
    trend_1d:  pc('days_1'),  trend_7d:  pc('days_7'),  trend_14d: pc('days_14'),
    trend_30d: pc('days_30'), trend_90d: pc('days_90'), trend_180d: pc('days_180'),
    trends_json: trends && Object.keys(t).length ? JSON.stringify(trends) : null,
  }
}

// ─── price rows (raw conditions + graded matrix), per variant ───────────────────
export interface ParsedPriceRow {
  tcgProductId: number | null   // from the variant's tcgplayer marketplace (R1 product resolution)
  variant:      string          // the variant key (e.g. 'firstEditionHolofoil'); never collapsed
  finish:       string          // variantFinish(name) — kept in step with the price-side vocabulary
  condition:    string | null   // raw tier (NM..DM); NULL for graded
  grade:        string | null   // combined label 'PSA 10' for graded; NULL for raw (back-compat)
  company:      string | null   // graded company; NULL for raw
  is_signed:    number
  is_error:     number
  is_perfect:   number
  value:        number | null   // market
  low:          number | null
  mid:          number | null
  high:         number | null
  trends:       Trends6
}

/**
 * Parse every variant's price set from a Scrydex card object (include=prices). Tolerant:
 * a card with no variants/prices yields []. Each variant becomes its own keyed price set
 * (firstEditionHolofoil vs unlimitedHolofoil are NOT collapsed even when they share a
 * TCGPlayer product id — `variant` is the disambiguator). Graded sub-variants
 * (signed/error/perfect) are captured with their flags so the serving layer can keep them
 * out of the default grid.
 */
export function parseCardPrices(card: unknown): ParsedPriceRow[] {
  const c = card as any
  const out: ParsedPriceRow[] = []
  for (const variant of (c?.variants ?? []) as any[]) {
    const variantName  = variant?.name ?? 'normal'
    const tcgProductId = tcgProductIdOf(variant)
    const finish       = variantFinish(variantName)
    for (const price of (variant?.prices ?? []) as any[]) {
      const trends = parseTrends6(price?.trends)
      const base = {
        tcgProductId, variant: variantName, finish,
        value: num(price?.market), low: num(price?.low), mid: num(price?.mid), high: num(price?.high),
        trends,
      }
      if (price?.type === 'graded') {
        const company  = normaliseCompany(price?.company)
        const gradeNum = price?.grade != null ? String(price.grade).trim() : null
        const label    = company && gradeNum ? `${company} ${gradeNum}` : (price?.condition ?? null)
        if (!label) continue   // a graded row with no resolvable grade label is unusable
        out.push({
          ...base, condition: null, grade: label, company,
          is_signed: flag(price?.is_signed), is_error: flag(price?.is_error), is_perfect: flag(price?.is_perfect),
        })
      } else {
        // raw (ungraded) tier
        const cond = price?.condition ? String(price.condition).trim().toUpperCase() : null
        out.push({
          ...base, condition: cond, grade: null, company: null,
          is_signed: 0, is_error: 0, is_perfect: 0,
        })
      }
    }
  }
  return out
}

// ─── pop reports ────────────────────────────────────────────────────────────────
export interface ParsedPopReport {
  variant: string | null
  company: string
  grade:   string          // combined label e.g. 'PSA 10'
  count:   number | null
  total:   number | null
  grade_total:           number | null
  qualified_grade_total: number | null
  half_grade_total:      number | null
}

/**
 * Parse pop reports from a Scrydex card (include=pop_reports). Tolerant of two shapes:
 *   (a) array of entries  [{ company, grade, count, total, grade_total, ... , variant? }]
 *   (b) nested by company { PSA: { total, grades: { '10': { count, ... } } } }
 * Missing/empty → [].
 */
export function parsePopReports(card: unknown): ParsedPopReport[] {
  const c = card as any
  const raw = c?.pop_reports ?? c?.pop_report ?? c?.population ?? null
  if (!raw) return []
  const out: ParsedPopReport[] = []

  const pushEntry = (company: string | null, gradeNum: string | null, label: string | null, e: any, variant: string | null) => {
    const comp = normaliseCompany(company)
    const grade = label ?? (comp && gradeNum ? `${comp} ${gradeNum}` : null)
    if (!comp || !grade) return
    out.push({
      variant, company: comp, grade,
      count:                 num(e?.count ?? e?.population),
      total:                 num(e?.total),
      grade_total:           num(e?.grade_total),
      qualified_grade_total: num(e?.qualified_grade_total),
      half_grade_total:      num(e?.half_grade_total),
    })
  }

  if (Array.isArray(raw)) {
    for (const e of raw) {
      pushEntry(e?.company, e?.grade != null ? String(e.grade) : null, e?.label ?? null, e, e?.variant ?? null)
    }
    return out
  }
  // nested-by-company form
  if (typeof raw === 'object') {
    for (const [company, body] of Object.entries(raw as Record<string, any>)) {
      const total = num((body as any)?.total)
      const grades = (body as any)?.grades ?? body
      if (grades && typeof grades === 'object') {
        for (const [gradeNum, e] of Object.entries(grades as Record<string, any>)) {
          if (e && typeof e === 'object') {
            pushEntry(company, String(gradeNum), null, { ...e, total: (e as any)?.total ?? total }, null)
          }
        }
      }
    }
  }
  return out
}

// ─── sold listings ──────────────────────────────────────────────────────────────
export interface ParsedListing {
  listing_id: string
  title:      string | null
  variant:    string | null
  company:    string | null
  grade:      string | null
  is_perfect: number
  is_error:   number
  is_signed:  number
  url:        string | null
  price:      number | null
  currency:   string | null
  sold_at:    number | null
}

/** Parse sold listings from `/listings`. Tolerant: { data: [...] } | { listings: [...] } | [...]. */
export function parseListings(resp: unknown, productId: number): ParsedListing[] {
  const r = resp as any
  const arr: any[] = Array.isArray(r) ? r : (r?.data ?? r?.listings ?? [])
  const out: ParsedListing[] = []
  for (let i = 0; i < arr.length; i++) {
    const l = arr[i]
    const company  = normaliseCompany(l?.company)
    const gradeNum = l?.grade != null ? String(l.grade).trim() : null
    const grade    = l?.grade_label ?? (company && gradeNum ? `${company} ${gradeNum}` : (gradeNum ?? null))
    const soldAt   = toUnix(l?.sold_at ?? l?.sold_date ?? l?.date ?? l?.end_time)
    const price    = num(l?.price ?? l?.sale_price ?? l?.amount)
    // Stable id so re-pulls upsert; fall back to a deterministic synthetic when Scrydex omits it.
    const listing_id = String(l?.id ?? l?.listing_id ?? `${productId}:${grade ?? ''}:${soldAt ?? ''}:${price ?? ''}:${i}`)
    out.push({
      listing_id,
      title:    l?.title ?? l?.name ?? null,
      variant:  l?.variant ?? null,
      company,  grade,
      is_perfect: flag(l?.is_perfect), is_error: flag(l?.is_error), is_signed: flag(l?.is_signed),
      url:      l?.url ?? l?.link ?? null,
      price,
      currency: l?.currency ?? 'USD',
      sold_at:  soldAt,
    })
  }
  return out
}

// ─── price history ────────────────────────────────────────────────────────────────
export interface ParsedHistoryPoint {
  variant:   string | null
  condition: string | null
  grade:     string | null
  company:   string | null
  date:      string
  low:       number | null
  market:    number | null
  currency:  string | null
}

/**
 * Parse the daily price-history series from `/price_history`. Tolerant of two shapes:
 *   (a) flat points  { data: [{ date, low, market, variant?, condition?, grade?, company? }] }
 *   (b) series       { data: [{ variant, condition, grade, company, points: [{ date, low, market }] }] }
 */
export function parsePriceHistory(resp: unknown): ParsedHistoryPoint[] {
  const r = resp as any
  const arr: any[] = Array.isArray(r) ? r : (r?.data ?? r?.history ?? [])
  const out: ParsedHistoryPoint[] = []

  const pushPoint = (p: any, ctx: { variant?: any; condition?: any; grade?: any; company?: any }) => {
    const date = p?.date ?? p?.day ?? null
    if (!date) return
    const company  = normaliseCompany(ctx.company ?? p?.company)
    const gradeNum = (ctx.grade ?? p?.grade)
    const grade    = p?.grade_label ?? (company && gradeNum != null ? `${company} ${String(gradeNum).trim()}` : (gradeNum != null ? String(gradeNum) : null))
    const condRaw  = ctx.condition ?? p?.condition
    const cond     = condRaw ? String(condRaw).trim().toUpperCase() : null
    out.push({
      variant:   ctx.variant ?? p?.variant ?? null,
      condition: RAW_CONDITIONS.has(cond ?? '') ? cond : (grade ? null : cond),
      grade,     company,
      date:      String(date).slice(0, 10),
      low:       num(p?.low),
      market:    num(p?.market ?? p?.price ?? p?.value),
      currency:  p?.currency ?? 'USD',
    })
  }

  for (const entry of arr) {
    if (Array.isArray(entry?.points)) {
      for (const p of entry.points) pushPoint(p, { variant: entry?.variant, condition: entry?.condition, grade: entry?.grade, company: entry?.company })
    } else {
      pushPoint(entry, {})
    }
  }
  return out
}

// ─── SQL builders ────────────────────────────────────────────────────────────────
const ENRICH_PRICE_SQL = `
  INSERT INTO prices
    (product_id, source, condition, finish, grade, value, low, mid, high, variant, company,
     is_signed, is_error, is_perfect, trend_1d, trend_7d, trend_14d, trend_30d, trend_90d, trend_180d, trends_json, fetched_at)
  VALUES (?, 'scrydex', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
  ON CONFLICT (product_id, source, COALESCE(condition,''), COALESCE(finish,''), COALESCE(grade,''),
               COALESCE(variant,''), COALESCE(company,''), is_signed, is_error, is_perfect)
  DO UPDATE SET
    value = excluded.value, low = excluded.low, mid = excluded.mid, high = excluded.high,
    trend_1d = excluded.trend_1d, trend_7d = excluded.trend_7d, trend_14d = excluded.trend_14d,
    trend_30d = excluded.trend_30d, trend_90d = excluded.trend_90d, trend_180d = excluded.trend_180d,
    trends_json = excluded.trends_json, fetched_at = excluded.fetched_at`

const POP_UPSERT_SQL = `
  INSERT INTO card_pop_reports
    (product_id, variant, company, grade, count, total, grade_total, qualified_grade_total, half_grade_total, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
  ON CONFLICT (product_id, COALESCE(variant,''), company, grade) DO UPDATE SET
    count = excluded.count, total = excluded.total, grade_total = excluded.grade_total,
    qualified_grade_total = excluded.qualified_grade_total, half_grade_total = excluded.half_grade_total,
    fetched_at = excluded.fetched_at`

const LISTING_UPSERT_SQL = `
  INSERT INTO card_listings
    (product_id, source, listing_id, title, variant, company, grade, is_perfect, is_error, is_signed,
     url, price, currency, sold_at, fetched_at)
  VALUES (?, 'scrydex', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
  ON CONFLICT (listing_id) DO UPDATE SET
    title = excluded.title, variant = excluded.variant, company = excluded.company, grade = excluded.grade,
    is_perfect = excluded.is_perfect, is_error = excluded.is_error, is_signed = excluded.is_signed,
    url = excluded.url, price = excluded.price, currency = excluded.currency, sold_at = excluded.sold_at,
    fetched_at = excluded.fetched_at`

const HISTORY_UPSERT_SQL = `
  INSERT INTO card_price_history
    (product_id, variant, condition, grade, company, date, low, market, currency)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (product_id, COALESCE(variant,''), COALESCE(condition,''), COALESCE(grade,''), COALESCE(company,''), date)
  DO UPDATE SET low = excluded.low, market = excluded.market, currency = excluded.currency`

function priceUpsert(db: D1Database, productId: number, r: ParsedPriceRow): D1PreparedStatement {
  return db.prepare(ENRICH_PRICE_SQL).bind(
    productId, r.condition, r.finish, r.grade, r.value, r.low, r.mid, r.high, r.variant, r.company,
    r.is_signed, r.is_error, r.is_perfect,
    r.trends.trend_1d, r.trends.trend_7d, r.trends.trend_14d, r.trends.trend_30d, r.trends.trend_90d, r.trends.trend_180d,
    r.trends.trends_json,
  )
}

// ─── product resolution ──────────────────────────────────────────────────────────
async function mapTcgToProductId(db: D1Database, ids: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>()
  const uniq = [...new Set(ids.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)))]
  for (let i = 0; i < uniq.length; i += 90) {
    const chunk = uniq.slice(i, i + 90)
    const ph = chunk.map(() => '?').join(',')
    const { results } = await db.prepare(
      `SELECT id, tcgplayer_product_id AS pid FROM products WHERE tcgplayer_product_id IN (${ph})`
    ).bind(...chunk).all<{ id: number; pid: number }>()
    for (const r of results ?? []) map.set(Number(r.pid), Number(r.id))
  }
  return map
}

async function batchRun(db: D1Database, stmts: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
    await db.batch(stmts.slice(i, i + BATCH_SIZE))
  }
}

async function markFresh(db: D1Database, productId: number, dataClass: string): Promise<void> {
  await db.prepare(
    `INSERT INTO card_enrichment_freshness (product_id, data_class, enriched_at)
     VALUES (?, ?, unixepoch())
     ON CONFLICT (product_id, data_class) DO UPDATE SET enriched_at = excluded.enriched_at`
  ).bind(productId, dataClass).run()
}

// ─── main enrichment entry point ──────────────────────────────────────────────────
export type EnrichClass = 'core' | 'comps' | 'history'

export interface EnrichResult {
  ok:            boolean
  skipped?:      string
  scrydexCardId?: string
  core?:    { pricesUpserted: number; popUpserted: number; requests: number }
  comps?:   { listingsUpserted: number; requests: number }
  history?: { historyUpserted: number; requests: number }
  error?:   string
}

/**
 * Enrich ONE canonical product with the requested data classes. Resolves the Scrydex card id
 * via products.scrydex_card_id (falling back to `{expansion}-{number}` for Pokémon), fetches
 * each requested class through the credit-guarded scrydexFetch, and upserts the canonical rows.
 * Best-effort + tier-resilient: a per-class fetch/parse error is recorded and the run continues;
 * a credit-guard trip / 403 cap stops the run so the caller serves last-persisted rows.
 */
export async function enrichCard(
  env:  Env,
  opts: { canonicalProductId: number; classes: EnrichClass[] },
): Promise<EnrichResult> {
  const { canonicalProductId } = opts
  const classes = new Set(opts.classes)

  const product = await env.DB.prepare(`
    SELECT p.id, p.scrydex_card_id, p.number,
           s.scrydex_expansion_id AS expansion_id, g.name AS game
    FROM   products        p
    JOIN   sets            s ON s.id = p.set_id
    JOIN   canonical_games g ON g.id = s.game_id
    WHERE  p.id = ?
    LIMIT  1
  `).bind(canonicalProductId).first<{ id: number; scrydex_card_id: string | null; number: string | null; expansion_id: string | null; game: string }>()

  if (!product) return { ok: false, error: 'product not found' }
  const gameSlug = GAME_NAME_TO_SLUG[product.game]
  if (!gameSlug) return { ok: true, skipped: 'unsupported_game' }

  const scrydexCardId = product.scrydex_card_id || deriveScrydexCardId(product.expansion_id, product.number)
  if (!scrydexCardId) return { ok: true, skipped: 'no_scrydex_id' }

  const result: EnrichResult = { ok: true, scrydexCardId }
  const idPath = encodeURIComponent(scrydexCardId)

  // ── core: prices + pop_reports (single-card fetch) ──────────────────────────────
  if (classes.has('core')) {
    try {
      const res = await scrydexFetch(env, `/${gameSlug}/v1/cards/${idPath}`, 'enrichCard:core', {
        params: { include: 'prices,pop_reports' },
      })
      if (res.status === 403) return { ...result, skipped: 'credit_cap' }
      if (res.ok) {
        const body = await res.json().catch(() => ({})) as { data?: unknown }
        const card = (body?.data ?? body) as unknown

        const priceRows = parseCardPrices(card)
        const tcgIds = priceRows.map(r => r.tcgProductId).filter((n): n is number => n != null)
        const tcgToProduct = await mapTcgToProductId(env.DB, tcgIds)
        const priceStmts = priceRows.map(r => {
          const pid = (r.tcgProductId != null ? tcgToProduct.get(r.tcgProductId) : undefined) ?? canonicalProductId
          return priceUpsert(env.DB, pid, r)
        })

        const popRows = parsePopReports(card)
        const popStmts = popRows.map(p => env.DB.prepare(POP_UPSERT_SQL).bind(
          canonicalProductId, p.variant, p.company, p.grade,
          p.count, p.total, p.grade_total, p.qualified_grade_total, p.half_grade_total,
        ))

        await batchRun(env.DB, [...priceStmts, ...popStmts])
        await markFresh(env.DB, canonicalProductId, 'core')
        result.core = { pricesUpserted: priceStmts.length, popUpserted: popStmts.length, requests: 1 }
      } else {
        result.core = { pricesUpserted: 0, popUpserted: 0, requests: 1 }
      }
    } catch (err) {
      if (err instanceof ScrydexCreditLimitError) return { ...result, skipped: 'credit_guard' }
      result.core = { pricesUpserted: 0, popUpserted: 0, requests: 0 }
      result.error = `core: ${(err as Error).message}`
    }
  }

  // ── comps: sold listings ────────────────────────────────────────────────────────
  if (classes.has('comps')) {
    try {
      const res = await scrydexFetch(env, `/${gameSlug}/v1/cards/${idPath}/listings`, 'enrichCard:comps')
      if (res.status === 403) return { ...result, skipped: 'credit_cap' }
      if (res.ok) {
        const body = await res.json().catch(() => ({}))
        const listings = parseListings(body, canonicalProductId)
        // Retention: prune sold comps older than 180 days for this product before re-inserting.
        await env.DB.prepare(
          `DELETE FROM card_listings WHERE product_id = ? AND sold_at IS NOT NULL AND sold_at < unixepoch() - ?`
        ).bind(canonicalProductId, LISTINGS_RETENTION_DAYS * 86400).run()
        const stmts = listings.map(l => env.DB.prepare(LISTING_UPSERT_SQL).bind(
          canonicalProductId, l.listing_id, l.title, l.variant, l.company, l.grade,
          l.is_perfect, l.is_error, l.is_signed, l.url, l.price, l.currency, l.sold_at,
        ))
        await batchRun(env.DB, stmts)
        await markFresh(env.DB, canonicalProductId, 'comps')
        result.comps = { listingsUpserted: stmts.length, requests: 1 }
      } else {
        result.comps = { listingsUpserted: 0, requests: 1 }
      }
    } catch (err) {
      if (err instanceof ScrydexCreditLimitError) return { ...result, skipped: 'credit_guard' }
      result.comps = { listingsUpserted: 0, requests: 0 }
      result.error = `${result.error ? result.error + '; ' : ''}comps: ${(err as Error).message}`
    }
  }

  // ── history: daily price-history series ───────────────────────────────────────────
  if (classes.has('history')) {
    try {
      const res = await scrydexFetch(env, `/${gameSlug}/v1/cards/${idPath}/price_history`, 'enrichCard:history')
      if (res.status === 403) return { ...result, skipped: 'credit_cap' }
      if (res.ok) {
        const body = await res.json().catch(() => ({}))
        const points = parsePriceHistory(body)
        // Retention: prune history older than ~365 days (ISO date string compares lexicographically).
        await env.DB.prepare(
          `DELETE FROM card_price_history WHERE product_id = ? AND date < date('now', ?)`
        ).bind(canonicalProductId, `-${HISTORY_RETENTION_DAYS} days`).run()
        const stmts = points.map(p => env.DB.prepare(HISTORY_UPSERT_SQL).bind(
          canonicalProductId, p.variant, p.condition, p.grade, p.company, p.date, p.low, p.market, p.currency,
        ))
        await batchRun(env.DB, stmts)
        await markFresh(env.DB, canonicalProductId, 'history')
        result.history = { historyUpserted: stmts.length, requests: 1 }
      } else {
        result.history = { historyUpserted: 0, requests: 1 }
      }
    } catch (err) {
      if (err instanceof ScrydexCreditLimitError) return { ...result, skipped: 'credit_guard' }
      result.history = { historyUpserted: 0, requests: 0 }
      result.error = `${result.error ? result.error + '; ' : ''}history: ${(err as Error).message}`
    }
  }

  return result
}
