/**
 * PriceCharting (pricecharting.com) graded-price client — PRIMARY admin graded source.
 *
 * PriceCharting is now the primary admin graded-price source (tcggo is the secondary
 * fallback). Like the Scrydex / tcggo keys, the PRICECHARTING_TOKEN lives here in the
 * worker and is proxied ADMIN-ONLY by the Content app — it never reaches the client.
 *
 * PriceCharting does NOT take a tcgplayer_id, so we resolve a card to a PriceCharting
 * product id via full-text search, VALIDATE the best match (reject weak matches rather
 * than misprice), and CACHE the resolved id per canonical product in KV
 * (`pc_id:{canonicalProductId}`, long TTL) so each card is searched once. The raw
 * /api/product response is briefly cached too (`pc_product:{pcId}`, 24h) so different
 * grades of one card don't each re-fetch.
 *
 * Endpoints (base https://www.pricecharting.com):
 *   GET /api/products?t=TOKEN&q=QUERY   → { status, products: [{id, product-name, console-name}] } (≤20)
 *   GET /api/product?t=TOKEN&id=ID      → { status, <price-guide keys...>, product-name, console-name, sales-volume }
 * Prices are INTEGER PENNIES (÷100). `status` = success | error. Rate limit 1 req/sec.
 *
 * GRADE DECODE MAP — see decodeGradedKey(). Mirror of Content's
 * functions/lib/pricecharting.js / src/lib/pricecharting.js (cross-repo, kept in step).
 */

import type { Env } from '../worker.js'

const PC_BASE = 'https://www.pricecharting.com'

/** KV key prefixes + TTLs. */
// v2: matcher fix (combined product+console haystack, compact number) abandons stale
// v1 negative-cache 'none' entries so previously-rejected cards re-resolve on deploy.
const PC_ID_PREFIX       = 'pc_id_v2:'       // resolved PriceCharting id per canonical product
const PC_ID_TTL          = 60 * 60 * 24 * 30 // 30 days
const PC_ID_NONE         = 'none'            // negative-cache sentinel (no validated match)
const PC_ID_NONE_TTL     = 60 * 60 * 24 * 7  // 7 days — recover if catalogue improves
const PC_PRODUCT_PREFIX  = 'pc_product:'     // raw /api/product response per pc id
const PC_PRODUCT_TTL     = 60 * 60 * 24      // 24h

/** Grading companies PriceCharting has no graded bucket for → always null. */
export const UNSUPPORTED_COMPANIES = ['TAG', 'ACE']

/** Company-specific grade-10 keys. */
export const GRADE_TEN_KEY_BY_COMPANY: Record<string, string> = {
  PSA: 'manual-only-price',
  BGS: 'bgs-10-price',
  CGC: 'condition-17-price',
  SGC: 'condition-18-price',
}

function subTenKey(g: number): string | null {
  if (g === 9.5) return 'box-only-price'
  if (g === 9)   return 'graded-price'
  if (g === 8 || g === 8.5) return 'new-price'
  if (g === 7 || g === 7.5) return 'cib-price'
  return null
}

/**
 * Decode a slab's (company, grade) → the PriceCharting price-guide key holding that
 * tier's value, or null when PriceCharting does not cover it (TAG/ACE, grade < 7). PURE.
 */
export function decodeGradedKey(company: string | null | undefined, grade: string | number | null | undefined): string | null {
  const co = String(company ?? '').toUpperCase().trim()
  if (!co || UNSUPPORTED_COMPANIES.includes(co)) return null
  const g = Number(grade)
  if (!Number.isFinite(g)) return null
  if (g === 10) return GRADE_TEN_KEY_BY_COMPANY[co] ?? null
  return subTenKey(g)
}

/** Read the dollar price for a (company, grade) out of an /api/product response. PURE. */
export function pickGradedPrice(prices: Record<string, unknown> | null, company: string | null, grade: string | number | null): { price: number; key: string } | null {
  const key = decodeGradedKey(company, grade)
  if (!key || !prices || typeof prices !== 'object') return null
  const raw = prices[key]
  const pennies = typeof raw === 'number' ? raw : Number(raw)
  if (raw == null || raw === '' || Number.isNaN(pennies) || pennies <= 0) return null
  return { price: pennies / 100, key }
}

// ── Search-result validation ─────────────────────────────────────────────────

function norm(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}
function compact(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}
function cleanNumber(n: unknown): string {
  return String(n ?? '').split('/')[0].replace(/^0+/, '').toLowerCase().trim()
}

interface PcSearchProduct { id?: string; 'product-name'?: string; 'console-name'?: string }
interface CardMeta { name?: string | null; setName?: string | null; number?: string | number | null }

/**
 * Pick + VALIDATE the best PriceCharting search match for a canonical card. PURE.
 *
 * Matches name + number against the COMBINED product-name + console-name "haystack"
 * (PriceCharting keeps franchise/set words like "One Piece" in the console-name while
 * our canonical name may carry them inline, e.g. "Monkey.D.Luffy (010) (Dodgers x ONE
 * PIECE)"). All name tokens must appear in the haystack (this also discriminates art
 * variants — a non-"Dodgers" print lacks the "dodgers" token); corroboration (number
 * OR set) is required so a name-only hit never misprices. Numbers match as an
 * alphanumeric-compact substring so hyphenated set-prefixed numbers ("EB02-010") match.
 * Score: name (+2), compact number (+3), set token in console (+2); accept at ≥ 4.
 */
export function pickBestPcMatch(products: PcSearchProduct[] | undefined, card: CardMeta): (PcSearchProduct & { _score: number }) | null {
  if (!Array.isArray(products) || products.length === 0) return null
  const cardName = norm(card?.name)
  if (!cardName) return null
  const setName    = norm(card?.setName)
  const numCompact = compact(cleanNumber(card?.number))

  const nameTokens = cardName.split(' ').filter(t => t.length >= 3)
  const setTokens  = setName.split(' ').filter(t => t.length >= 3)
  if (nameTokens.length === 0) return null

  let best: { product: PcSearchProduct; score: number } | null = null
  for (const p of products) {
    const pName = norm(p?.['product-name'])
    if (!pName) continue
    const pConsole   = norm(p?.['console-name'])
    const hay        = `${pName} ${pConsole}`.trim()
    const hayCompact = compact(hay)

    if (!nameTokens.every(t => hay.includes(t))) continue
    const numHit = numCompact ? hayCompact.includes(numCompact) : false
    const setHit = setTokens.length > 0 && setTokens.some(t => pConsole.includes(t))
    if (!numHit && !setHit) continue

    let score = 2
    if (numHit) score += 3
    if (setHit) score += 2
    if (best == null || score > best.score) best = { product: p, score }
  }
  if (!best || best.score < 4) return null
  return { ...best.product, _score: best.score }
}

// ── Fetch + resolve ──────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export interface PriceChartingGradedResult {
  canonicalProductId: number
  company:            string
  grade:              string
  price:              number | null   // dollars (pennies ÷ 100)
  key:                string | null   // the decoded price-guide key
  productName:        string | null   // matched PriceCharting product-name (sanity check)
  console:            string | null   // matched PriceCharting console-name (sanity check)
  salesVolume:        number | null   // PriceCharting yearly units sold
  pcId:               string | null
  source:             'pricecharting'
}

function nullResult(canonicalProductId: number, company: string, grade: string, pcId: string | null = null): PriceChartingGradedResult {
  return { canonicalProductId, company, grade, price: null, key: null, productName: null, console: null, salesVolume: null, pcId, source: 'pricecharting' }
}

interface CardRow { name: string; number: string | null; set_name: string | null }

async function pcGet(env: Env, path: string, params: Record<string, string>): Promise<{ status: number; body: any }> {
  const url = new URL(`${PC_BASE}${path}`)
  url.searchParams.set('t', env.PRICECHARTING_TOKEN as string)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

/**
 * Resolve (caching) the PriceCharting product id for a canonical product, then fetch
 * + decode its graded price for (company, grade). Returns price:null when the tier is
 * unsupported, the card can't be resolved, or PriceCharting has no value for it — the
 * caller falls back to tcggo, then the "no graded sales data yet" state.
 *
 * @throws Error only on a missing token (caller maps to 503).
 */
export async function fetchPriceChartingGraded(
  env: Env,
  args: { canonicalProductId: number; company: string; grade: string },
): Promise<PriceChartingGradedResult> {
  if (!env.PRICECHARTING_TOKEN) throw new Error('PRICECHARTING_TOKEN not configured')
  const { canonicalProductId, company, grade } = args

  // Short-circuit a tier PriceCharting can't cover — no API call, no misprice.
  if (!decodeGradedKey(company, grade)) return nullResult(canonicalProductId, company, grade)

  // Look up the canonical card (name / number / set) to drive search + validation.
  const card = await env.DB.prepare(`
    SELECT p.name AS name, p.number AS number, s.name AS set_name
    FROM products p
    LEFT JOIN sets s ON s.id = p.set_id
    WHERE p.id = ? LIMIT 1
  `).bind(canonicalProductId).first<CardRow>()
  if (!card?.name) return nullResult(canonicalProductId, company, grade)

  const kv = env.SLEEVEDPAGES_KV
  const idKey = `${PC_ID_PREFIX}${canonicalProductId}`

  // ── Resolve the PriceCharting id (KV-cached per canonical product) ───────────
  let searched = false
  let pcId: string | null = null
  const cachedId = kv ? await kv.get(idKey) : null
  if (cachedId === PC_ID_NONE) return nullResult(canonicalProductId, company, grade)
  if (cachedId) {
    pcId = cachedId
  } else {
    searched = true
    const q = `${card.name} ${card.set_name ?? ''}`.trim()
    const { status, body } = await pcGet(env, '/api/products', { q })
    if (status !== 200 || body?.status === 'error') {
      // Transient search failure — do NOT negative-cache; let the next call retry.
      return nullResult(canonicalProductId, company, grade)
    }
    const match = pickBestPcMatch(body?.products, { name: card.name, setName: card.set_name, number: card.number })
    pcId = match?.id != null ? String(match.id) : null
    if (kv) {
      if (pcId) await kv.put(idKey, pcId, { expirationTtl: PC_ID_TTL })
      else      await kv.put(idKey, PC_ID_NONE, { expirationTtl: PC_ID_NONE_TTL })
    }
    if (!pcId) return nullResult(canonicalProductId, company, grade)
  }

  // ── Fetch the product price guide (KV-cached 24h) ───────────────────────────
  const productKey = `${PC_PRODUCT_PREFIX}${pcId}`
  let product: any = null
  const cachedProduct = kv ? await kv.get(productKey) : null
  if (cachedProduct) {
    product = JSON.parse(cachedProduct)
  } else {
    // Respect the 1 req/sec limit when we just made a search call in this request.
    if (searched) await sleep(1100)
    const { status, body } = await pcGet(env, '/api/product', { id: pcId })
    if (status !== 200 || body?.status === 'error') return nullResult(canonicalProductId, company, grade, pcId)
    product = body
    if (kv) await kv.put(productKey, JSON.stringify(product), { expirationTtl: PC_PRODUCT_TTL })
  }

  const picked = pickGradedPrice(product, company, grade)
  const salesRaw = product?.['sales-volume']
  const salesVolume = salesRaw == null || salesRaw === '' || Number.isNaN(Number(salesRaw)) ? null : Number(salesRaw)
  return {
    canonicalProductId,
    company,
    grade,
    price:       picked?.price ?? null,
    key:         picked?.key ?? null,
    productName: product?.['product-name'] ?? null,
    console:     product?.['console-name'] ?? null,
    salesVolume,
    pcId,
    source: 'pricecharting',
  }
}
