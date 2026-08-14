/**
 * UPC resolver title matching — SHARED by the eBay Browse resolver (lib/ebayUpc.ts) and the
 * UPCitemdb resolver (lib/upcitemdbUpc.ts). One aggregation + ONE matcher path.
 *
 * External UPC providers return LISTING/RETAIL TITLES, not catalogue identities. The flow:
 *   1. Normalise every title and strip listing noise ("NEW", "SEALED", "IN HAND", "x2", emoji
 *      — norm() drops non-alphanumerics, the noise list drops seller vocabulary).
 *   2. MAJORITY-SIGNAL aggregation: keep the tokens present in at least half the titles —
 *      the stable core across sellers IS the product identity; per-listing embellishments
 *      wash out. (One title → its tokens verbatim; UPCitemdb usually returns one.)
 *   3. Candidate pool from the canonical catalogue (distinctive-token SQL below), then the
 *      EXISTING catalogue matcher — pickNumberlessCanonicalMatch, the pickBestPcMatch-family
 *      rung built for name+set matching without a card number (sealed product has none).
 *      NEVER a second matcher: all-name-tokens ⊆ haystack, language agreement, console↔set
 *      corroboration, UNIQUE accept — every gate fails toward rejection, so the worst case
 *      is a miss, never a wrong product on a vendor's scanner.
 *
 * Why this works on our catalogue: canonical sealed names EMBED their set ("Stardust Trails
 * Booster Box" in set "Stardust Trails" — verified on prod 2026-08-14), so the all-tokens
 * rule discriminates siblings and the unique-accept rule turns residual ambiguity (e.g. a
 * "… Booster Box" vs its "… Booster Box Case" when scanning the CASE, whose titles carry
 * every box token too) into an honest miss. The vendor-teach flow is the designed backstop
 * for those misses.
 *
 * Also here: the shared per-provider DAILY CALL CAP (app_config-with-code-default read +
 * a KV day counter) both resolvers use to respect their quotas.
 */

import { norm, pickNumberlessCanonicalMatch, type NumberlessCandidate } from './pricechartingCsv.js'

/** Seller vocabulary stripped BEFORE aggregation — these describe the LISTING, not the
 * product. Kept conservative: never strip a token that could be product identity (numbers
 * like "151" are set names; language markers like "japanese" feed the matcher's language
 * gate). Compared against norm()ed tokens. */
export const LISTING_NOISE_TOKENS = new Set([
  'new', 'sealed', 'unopened', 'nib', 'mint', 'authentic', 'genuine', 'official', 'oem',
  'brand', 'hand', 'stock', 'ready', 'fast', 'free', 'ship', 'ships', 'shipped', 'shipping',
  'presale', 'preorder', 'sale', 'hot', 'rare', 'htf', 'qty', 'pcs', 'count', 'usa',
  'english', 'eng', 'edition', 'from', 'with', 'the', 'and', 'for', 'in', 'on', 'of', 'to',
])

/** Quantity-shaped tokens ("x2", "2x") are listing noise too — but a BARE number is kept
 * (Pokémon "151" is a real set). */
const QUANTITY_TOKEN = /^(x\d{1,3}|\d{1,3}x)$/

/** Normalise ONE title to its identity tokens (norm() + noise stripping). PURE. */
export function titleTokens(title: unknown): string[] {
  return norm(title)
    .split(' ')
    .filter((t) => t.length > 0 && !LISTING_NOISE_TOKENS.has(t) && !QUANTITY_TOKEN.test(t))
}

/** Cap on aggregate size — bounds the matcher haystack and the candidate SQL. */
const MAX_AGGREGATE_TOKENS = 24

/**
 * MAJORITY-SIGNAL aggregation across listing titles: a token survives when it appears in
 * at least HALF the titles (document frequency, not raw count — a spammy repeated token in
 * one title is still one vote). Tokens keep first-seen order. Returns the aggregate string
 * for the matcher haystack, or null when nothing survives. PURE.
 */
export function aggregateTitles(titles: unknown[]): string | null {
  const tokenised = (Array.isArray(titles) ? titles : [])
    .map((t) => titleTokens(t))
    .filter((tokens) => tokens.length > 0)
  if (tokenised.length === 0) return null

  const docFreq = new Map<string, number>()
  const firstSeen: string[] = []
  for (const tokens of tokenised) {
    for (const t of new Set(tokens)) {
      if (!docFreq.has(t)) firstSeen.push(t)
      docFreq.set(t, (docFreq.get(t) ?? 0) + 1)
    }
  }
  const need = Math.ceil(tokenised.length / 2)
  const kept = firstSeen.filter((t) => (docFreq.get(t) ?? 0) >= need).slice(0, MAX_AGGREGATE_TOKENS)
  return kept.length > 0 ? kept.join(' ') : null
}

/** Generic sealed-product vocabulary — poor CANDIDATE-POOL discriminators (they'd pull
 * thousands of rows), though they still count in the matcher itself. */
const GENERIC_CANDIDATE_TOKENS = new Set([
  'box', 'pack', 'packs', 'booster', 'bundle', 'case', 'card', 'cards', 'tcg', 'trading',
  'game', 'games', 'collection', 'premium', 'deck', 'tin', 'blister', 'display', 'factory',
  'elite', 'trainer', 'starter', 'set', 'mini', 'japanese', 'japan',
  'pokemon', 'magic', 'gathering', 'yugioh', 'yu', 'gi', 'oh', 'one', 'piece', 'lorcana',
])

/** The candidate-pool discriminator tokens: longest first, generic vocabulary excluded. PURE. */
export function distinctiveTokens(aggregate: string, max = 3): string[] {
  const tokens = String(aggregate ?? '').split(' ').filter((t) => t.length >= 3 && !GENERIC_CANDIDATE_TOKENS.has(t))
  return [...new Set(tokens)].sort((a, b) => b.length - a.length).slice(0, max)
}

/** Bounded candidate pool — big enough that truncation is rare, small enough for one query. */
const CANDIDATE_LIMIT = 250

export interface UpcTitleMatch {
  canonicalProductId: number
  productKind: string | null
}

/**
 * Resolve an aggregated title against the canonical catalogue: distinctive-token candidate
 * pull (every distinctive token must appear in the product's name+set text; sealed rows
 * first), then the shared pickNumberlessCanonicalMatch with the aggregate as BOTH the
 * product-name and console-name (a listing title carries name, set and game in one string —
 * it is its own corroboration text). Returns null on no/ambiguous match.
 */
export async function matchAggregateToCatalogue(db: D1Database, aggregate: string): Promise<UpcTitleMatch | null> {
  const discriminators = distinctiveTokens(aggregate)
  if (discriminators.length === 0) return null   // nothing but generic vocabulary → unmatchable

  const clause = discriminators.map(() => `instr(lower(p.name) || ' ' || lower(s.name), ?) > 0`).join(' AND ')
  const { results } = await db.prepare(`
    SELECT p.id, p.name, p.product_kind AS productKind, s.name AS setName
    FROM products p
    JOIN sets s ON s.id = p.set_id
    WHERE ${clause}
    ORDER BY (CASE WHEN p.product_kind = 'sealed' THEN 0 ELSE 1 END), p.id DESC
    LIMIT ${CANDIDATE_LIMIT}
  `).bind(...discriminators).all<{ id: number; name: string | null; productKind: string | null; setName: string | null }>()

  const rows = results ?? []
  if (rows.length === 0) return null

  const candidates: NumberlessCandidate[] = rows.map((r) => ({ id: r.id, name: r.name, setName: r.setName }))
  const matchedId = pickNumberlessCanonicalMatch(
    { 'product-name': aggregate, 'console-name': aggregate },
    candidates,
  )
  if (matchedId == null) return null
  const row = rows.find((r) => r.id === matchedId)
  return { canonicalProductId: matchedId, productKind: row?.productKind ?? null }
}

// ── Shared daily call cap (per provider) ─────────────────────────────────────

/** Read an app_config integer with an in-code default (the standing runtime-flag pattern:
 * code never depends on the row existing). A missing/broken read falls back to the default. */
export async function readConfigInt(db: D1Database, key: string, fallback: number): Promise<number> {
  try {
    const row = await db.prepare('SELECT value FROM app_config WHERE key = ?').bind(key).first<{ value: string }>()
    const n = Number(row?.value)
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
  } catch {
    return fallback
  }
}

/** UTC day stamp for the daily counter keys. */
export const dayStamp = (now = new Date()) => now.toISOString().slice(0, 10)

/**
 * Has the provider's daily call budget run out? Reads the KV counter for today. A missing
 * KV binding disables capping (fail-open — the cap is a quota nicety, not a security gate).
 */
export async function dailyCapExhausted(kv: KVNamespace | undefined, counterPrefix: string, cap: number, now = new Date()): Promise<boolean> {
  if (!kv || cap <= 0) return cap <= 0
  const raw = await kv.get(`${counterPrefix}${dayStamp(now)}`)
  return (Number(raw) || 0) >= cap
}

/** Count one outbound provider call against today's budget (best-effort — KV increments
 * are not atomic; this is a SOFT cap). Counter keys expire after two days. */
export async function bumpDailyCount(kv: KVNamespace | undefined, counterPrefix: string, now = new Date()): Promise<void> {
  if (!kv) return
  const key = `${counterPrefix}${dayStamp(now)}`
  const raw = await kv.get(key)
  await kv.put(key, String((Number(raw) || 0) + 1), { expirationTtl: 60 * 60 * 48 })
}
