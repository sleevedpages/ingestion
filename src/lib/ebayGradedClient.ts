/**
 * eBay sold-listing graded-price gap-filler (Apify eBay actor).
 *
 * This is the GAP-FILLER for slabs the chain can't price any other way: PriceCharting
 * has no TAG/ACE bucket and returns null below grade 7, so the Content source chain
 * falls here next. We fetch eBay SOLD/COMPLETED listings via an Apify eBay actor, then
 * filter to true matches, trim outliers, and take a median + sample size.
 *
 * Like the Scrydex / tcggo / PriceCharting keys, the Apify credentials live HERE in the
 * worker (APIFY_TOKEN + APIFY_EBAY_ACTOR_ID) and are proxied ADMIN-ONLY by the Content
 * app — they never reach the client and are never logged or returned.
 *
 * COST / RATE POSTURE: the actor costs Apify credits and hits eBay, so the Content
 * proxy fires it at most once per card/grade/day (24h KV cache, including cached nulls)
 * and only on a PriceCharting null, behind the admin gate + the `ebay_graded_enabled`
 * flag. Concurrency here is 1 (one actor run per request). `count` (results/keyword) is
 * the cost lever — capped at EBAY_RESULT_COUNT. On ANY actor error we circuit-break and
 * return a null result (mirrors the Scrydex 403 posture) — the caller then degrades to
 * the public "See sold listings on eBay" link.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * CONFIRMED ACTOR: caffein.dev/ebay-sold-listings  (id: oTtB3VgfuE9GtxQt2)
 *   Returns SOLD items only (not active / not unsold) → the "eBay sold" label is honest.
 *   INPUT (buildActorInput): `keywords` is a STRING ARRAY — we pass ONE bare keyword
 *     string `{name} {number} {company} {grade}` (search TERMS, not an eBay URL — this
 *     actor has no url input). Plus `count` (cap, cost lever), `daysToScrape` (adaptive
 *     60→90), `ebaySite`, `sortOrder: endedRecently`, `currencyMode: USD`,
 *     `itemCondition: any`, `detailedSearch: false` (faster, less proxy/cost — we only
 *     need price + date).
 *   OUTPUT (flat rows): `soldPrice` is a STRING DOLLAR value (e.g. "215") → parseFloat.
 *     ⚠️ NOT integer pennies — do NOT divide by 100 (unlike the PriceCharting path this
 *     was mirrored from; a /100 here makes every price 100× too low). `totalPrice`
 *     (incl. shipping) also exists — noted, but we median over `soldPrice` (sale price).
 *     Also: `soldCurrency`, `endedAt` (ISO sale date), `title`, `url`, `itemId`. There is
 *     NO grade/company field — the title-match filter is what enforces the right slab.
 * Because the proxy contract is source-agnostic, a later swap to eBay's official
 * Marketplace Insights API only changes runActor() — no client change. The
 * `source: 'ebay-apify'` field records provenance for that swap.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import type { Env } from '../worker.js'
import { buildEbaySoldQuery, type EbaySlab } from './ebaySoldSearch.js'

const APIFY_BASE = 'https://api.apify.com/v2'

/** Max results per keyword (actor `count`) — the cost lever. Start conservative. */
const EBAY_RESULT_COUNT = 30
/** Date window: start at 60 days, widen to 90 only when survivors are too few. */
const INITIAL_DAYS = 60
const WIDE_DAYS    = 90
/** Re-query the wider window when fewer than this many comps survive the filter. */
const ADAPTIVE_MIN = 5
/** Apply the statistical (MAD) fence only at/above this sample size — below it the
 *  structured title filters + median carry the weight (MAD/IQR is unreliable on thin
 *  buckets and can discard real high sales). */
const STAT_FENCE_MIN = 10
/** Floor out accessory / shipping-only / junk listings ($0.99 etc.) — a structured,
 *  sample-size-independent filter (graded slabs realistically clear this). */
const PRICE_FLOOR = 1
/** Range/median ratio above which a result is "wide" → downgraded to low-confidence
 *  even when n ≥ GRADED_MIN_SAMPLE (thin buckets can still disagree wildly). */
const WIDE_DISPERSION_RATIO = 1.5

/** A median backed by fewer than this many sold listings is low-confidence. Mirrors
 *  the Content GRADED_MIN_SAMPLE confidence gate — the client renders n≥3 confident,
 *  1–2 thin, 0 null. The worker also returns an authoritative `lowConfidence`. */
export const GRADED_MIN_SAMPLE = 3

/** min/max of the surviving comps — surfaced so the UI can show a range + judge spread. */
export interface PriceSpread { min: number; max: number }

export interface EbayGradedResult {
  canonicalProductId: number
  company:            string
  grade:              string
  price:              number | null      // median sold price (dollars), or null when no comps
  n:                  number             // sample size after match-filter (+ fence at n≥10)
  spread:             PriceSpread | null // min/max of the survivors
  lowConfidence:      boolean            // n < GRADED_MIN_SAMPLE OR wide dispersion
  source:             'ebay-apify'
}

function nullResult(canonicalProductId: number, company: string, grade: string): EbayGradedResult {
  return { canonicalProductId, company, grade, price: null, n: 0, spread: null, lowConfidence: true, source: 'ebay-apify' }
}

// ── Pure parsing / filtering / aggregation (unit-tested) ───────────────────────

const clean = (v: unknown): string => (v == null ? '' : String(v).trim())

/** Parse a price out of a number, a "$1,234.56" string, or a { value } object. */
export function parsePrice(raw: unknown): number | null {
  if (raw == null) return null
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    return parsePrice(o.value ?? o.amount ?? o.price ?? null)
  }
  // Strip currency symbols / thousands separators; keep the first decimal number.
  const m = String(raw).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)
  if (!m) return null
  const n = Number(m[0])
  return Number.isFinite(n) && n > 0 ? n : null
}

function norm(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim()
}
function compact(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/** Words that mark a listing as NOT a single graded slab of this exact card. */
const EXCLUDE_TERMS = [
  'lot', 'lots', 'bundle', 'bulk', 'playset', 'set of', 'joblot', 'job lot',
  'proxy', 'custom', 'reprint', 'reproduction', 'repack', 'fake', 'orica',
  'read description', 'parts', 'damaged', 'creased', 'choose', 'choice',
  'you pick', 'u pick', 'pick a card', 'digital', 'pdf', 'sticker', 'token',
]

/** True when the title looks like a lot / proxy / repack / damaged etc. */
export function isExcludedListing(title: string): boolean {
  const t = norm(title)
  if (!t) return true
  // Quantity multipliers like "x2" / "x 3" → not a single slab.
  if (/\bx\s?\d+\b/.test(t)) return true
  return EXCLUDE_TERMS.some(term => t.includes(term))
}

/**
 * True when a listing title is a genuine match for the exact slab. PURE.
 * Requires: every card-name token (≥3 chars) present; the card number present as an
 * alphanumeric-compact substring (when a number is known); the exact grading company
 * present; and the exact grade present as a standalone number token (so "9" does not
 * match "9.5", and "10" matches only "10"). This naturally rejects wrong-grade and
 * wrong-company listings, ungraded listings, and most art-variant mismatches.
 */
export function titleMatchesSlab(title: string, slab: EbaySlab): boolean {
  const t = norm(title)
  if (!t) return false
  const tCompact = compact(title)

  const nameTokens = norm(slab.name).split(' ').filter(tok => tok.length >= 3)
  if (nameTokens.length === 0) return false
  if (!nameTokens.every(tok => t.includes(tok))) return false

  const numCompact = compact(clean(slab.number).split('/')[0])
  if (numCompact && !tCompact.includes(numCompact)) return false

  const company = norm(slab.company)
  if (company && !t.includes(company)) return false

  const grade = clean(slab.grade)
  if (grade) {
    const esc = grade.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Grade as a standalone numeric token (not a fragment of a larger number).
    const re = new RegExp(`(?:^|[^0-9.])${esc}(?:$|[^0-9.])`)
    if (!re.test(t)) return false
  }
  return true
}

/** Median of a numeric array (empty → 0). */
export function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Drop price outliers using a robust MAD (median absolute deviation) band. PURE.
 * With < 4 points there isn't enough to estimate spread, so all are kept; with a
 * zero MAD (all-equal) all are kept. Otherwise points beyond a 3.5 robust-z band
 * are dropped (e.g. a graded-card "$0.99 shipping listing" or a mispriced lot).
 */
export function trimOutliers(prices: number[]): number[] {
  if (prices.length < 4) return [...prices]
  const m = median(prices)
  const mad = median(prices.map(p => Math.abs(p - m)))
  if (mad === 0) return [...prices]
  const THRESHOLD = 3.5
  return prices.filter(p => Math.abs(p - m) / (1.4826 * mad) <= THRESHOLD)
}

/**
 * Aggregate mapped listings into a median + sample size for the exact slab. PURE.
 *
 * Cleans by CAUSE before cleaning by STATISTICS (these buckets are thin by design):
 *   1. Structured title filters FIRST — high-precision + sample-size-independent:
 *      name+number+company+grade must match (titleMatchesSlab), lots/proxies/etc are
 *      excluded (isExcludedListing), and a PRICE_FLOOR drops accessory/junk listings.
 *   2. Median-led — the median of the survivors is outlier-resistant by construction.
 *   3. Statistical (MAD) fence ONLY at n ≥ STAT_FENCE_MIN, then re-median; skipped below
 *      (relying on the structured filters + median) so a real high sale in a 3-comp
 *      bucket isn't discarded.
 *
 * Returns { price, n, spread, lowConfidence }. n===0 → price null. lowConfidence is set
 * when n < GRADED_MIN_SAMPLE OR the surviving comps are widely dispersed (range/median
 * > WIDE_DISPERSION_RATIO) even at n ≥ 3.
 */
export function aggregateEbaySold(
  items: Array<{ title: string; price: number | null }>,
  slab: EbaySlab,
): { price: number | null; n: number; spread: PriceSpread | null; lowConfidence: boolean } {
  const matched = items
    .filter(it => it.price != null && it.price >= PRICE_FLOOR)
    .filter(it => titleMatchesSlab(it.title, slab) && !isExcludedListing(it.title))
    .map(it => it.price as number)
  if (matched.length === 0) return { price: null, n: 0, spread: null, lowConfidence: true }

  // Fence only when there are enough points; thin buckets keep every survivor.
  const cleaned = matched.length >= STAT_FENCE_MIN ? trimOutliers(matched) : matched
  const price = median(cleaned)
  const min = Math.min(...cleaned)
  const max = Math.max(...cleaned)
  const spread: PriceSpread = { min, max }
  const wideDispersion = price > 0 && (max - min) / price > WIDE_DISPERSION_RATIO
  return {
    price,
    n: cleaned.length,
    spread,
    lowConfidence: cleaned.length < GRADED_MIN_SAMPLE || wideDispersion,
  }
}

// ── Apify dataset mapping ──────────────────────────────────────────────────────

/** Extract the listing title from a dataset item (tolerant of field names). */
export function extractTitle(item: any): string {
  return clean(item?.title ?? item?.name ?? item?.itemTitle ?? item?.heading ?? '')
}

/**
 * Extract the sale price from a dataset item. Prefers `soldPrice` — the confirmed
 * caffein.dev/ebay-sold-listings field, a STRING DOLLAR value ("215"), parsed (NOT
 * divided by 100 — it is not pennies). `totalPrice` (incl. shipping) is available if a
 * shipping-inclusive comp is ever wanted, but we default to the item sale price. The
 * remaining fallbacks tolerate other actor shapes.
 */
export function extractPrice(item: any): number | null {
  const candidates = [
    item?.soldPrice,                              // confirmed actor field (string dollars)
    item?.salePrice, item?.price, item?.priceValue,
    item?.sellingStatus?.currentPrice?.value, item?.currentPrice, item?.value,
  ]
  for (const c of candidates) {
    const p = parsePrice(c)
    if (p != null) return p
  }
  return null
}

/** Map raw Apify dataset items → { title, price }[] (tolerant of the array shape). */
export function mapDatasetItems(payload: unknown): Array<{ title: string; price: number | null }> {
  const arr: unknown[] = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { items?: unknown[] })?.items)
      ? (payload as { items: unknown[] }).items
      : []
  return arr.map(it => ({ title: extractTitle(it), price: extractPrice(it) }))
}

/**
 * Build the confirmed caffein.dev/ebay-sold-listings input. `keywords` takes the BARE
 * search-term string (NOT an eBay URL — this actor has no url input); `count` caps
 * results (cost lever); `daysToScrape` is the adaptive window. `detailedSearch:false`
 * keeps it fast/cheap — we only need price + date.
 */
function buildActorInput(keyword: string, daysToScrape: number) {
  return {
    keywords:       [keyword],
    count:          EBAY_RESULT_COUNT,
    daysToScrape,
    ebaySite:       'ebay.com',
    sortOrder:      'endedRecently',
    currencyMode:   'USD',
    itemCondition:  'any',
    detailedSearch: false,
  }
}

/**
 * Run the Apify eBay actor for a bare keyword string + date window, returning mapped
 * listings. Uses the synchronous run-sync-get-dataset-items endpoint (concurrency 1 —
 * one run per request). Returns null on ANY failure (missing items, non-OK, thrown) so
 * the caller circuit-breaks to a null result. The token is sent only as the `token`
 * query param to api.apify.com and is NEVER logged or echoed.
 */
async function runActor(env: Env, keyword: string, daysToScrape: number): Promise<Array<{ title: string; price: number | null }> | null> {
  const actorId = env.APIFY_EBAY_ACTOR_ID as string
  const endpoint = `${APIFY_BASE}/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${encodeURIComponent(env.APIFY_TOKEN as string)}`
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildActorInput(keyword, daysToScrape)),
    })
    if (!res.ok) return null
    const payload = await res.json().catch(() => null)
    return mapDatasetItems(payload)
  } catch {
    return null
  }
}

interface CardRow { name: string; number: string | null; set_name: string | null }

/**
 * Resolve a canonical product → slab search terms, run the Apify eBay actor, and
 * aggregate the sold listings into a median + sample size for (company, grade).
 * Returns price:null / n:0 when the slab can't be resolved, the actor errors, or no
 * comps survive the match-filter — the Content proxy then degrades to the sold link.
 *
 * @throws Error only on missing credentials (caller maps to 503).
 */
export async function fetchEbayGraded(
  env: Env,
  args: { canonicalProductId: number; company: string; grade: string },
): Promise<EbayGradedResult> {
  if (!env.APIFY_TOKEN || !env.APIFY_EBAY_ACTOR_ID) throw new Error('APIFY_TOKEN / APIFY_EBAY_ACTOR_ID not configured')
  const { canonicalProductId, company, grade } = args

  const card = await env.DB.prepare(`
    SELECT p.name AS name, p.number AS number, s.name AS set_name
    FROM products p
    LEFT JOIN sets s ON s.id = p.set_id
    WHERE p.id = ? LIMIT 1
  `).bind(canonicalProductId).first<CardRow>()
  if (!card?.name) return nullResult(canonicalProductId, company, grade)

  const slab: EbaySlab = { name: card.name, number: card.number, company, grade }
  const keyword = buildEbaySoldQuery(slab)   // bare terms, NOT a URL
  if (!keyword) return nullResult(canonicalProductId, company, grade)

  // Start with the 60-day window; widen to 90 only when too few comps survive (don't
  // always pull the full 90 — each extra day is more rows = more cost).
  const items = await runActor(env, keyword, INITIAL_DAYS)
  if (items == null) return nullResult(canonicalProductId, company, grade)  // circuit-broke
  let agg = aggregateEbaySold(items, slab)

  if (agg.n < ADAPTIVE_MIN) {
    const wider = await runActor(env, keyword, WIDE_DAYS)
    if (wider != null) {
      const aggWider = aggregateEbaySold(wider, slab)
      if (aggWider.n > agg.n) agg = aggWider   // prefer the wider pull when it found more
    }
  }

  return {
    canonicalProductId, company, grade,
    price: agg.price, n: agg.n, spread: agg.spread, lowConfidence: agg.lowConfidence,
    source: 'ebay-apify',
  }
}
