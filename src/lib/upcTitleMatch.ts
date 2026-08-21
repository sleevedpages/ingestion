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
 *
 * ── WHAT "CONFIDENT" MEANS (the word the ladder contract used without defining — 2026-08-21)
 *
 * A CONFIDENT external hit — the only kind that is ever returned, and therefore the only kind
 * Content ever WRITES BACK to `product_upcs` — is an aggregate that clears ALL FOUR of these
 * for EXACTLY ONE canonical product. It is a CONJUNCTION OF GATES, never a score or a
 * threshold, and every gate fails toward rejection:
 *   1. NAME CONTAINMENT — every ≥3-character, non-purely-numeric token of the CANONICAL
 *      product name appears in the provider haystack. (Direction matters: the catalogue name
 *      is the authority; extra provider tokens are free.)
 *   2. LANGUAGE AGREEMENT — the haystack and the product's SET name resolve to the same
 *      language (`textLanguage`).
 *   3. SET CORROBORATION — `consoleCorroboratesSet` between the haystack and the set name.
 *   4. UNIQUENESS — exactly one candidate clears 1–3. TWO accepts is an AMBIGUITY and returns
 *      a MISS, never a pick. This is deliberate and load-bearing: sibling sealed products
 *      nest by name ("Mega Evolution Booster Box" ⊂ "Mega Evolution Enhanced Booster Box",
 *      "… Booster Box" ⊂ "… Booster Box Case"), and a wrong confident hit writes a PERMANENT
 *      map row that silently adds the wrong product to every future scanner's inventory.
 *      The vendor-teach flow and `/api/admin/upc-mappings` are the designed backstops for the
 *      misses this costs.
 * Gates 1–3 are `pickNumberlessCanonicalMatch` (the ONE shared catalogue matcher — never a
 * second one); gate 4 is its unique-accept rule. Nothing here re-implements them.
 */

import { norm, pickNumberlessCanonicalMatch, type NumberlessCandidate } from './pricechartingCsv.js'
import { logger } from '../ingestion/logger.js'

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

/**
 * Strip combining diacritical marks so an accented brand folds to its ASCII spelling.
 * PURE. **Why this is not cosmetic:** `norm()` turns every non-`[a-z0-9]` byte into a
 * space, so "Pokémon" became the two junk tokens `pok` + `mon` — both ≥3 chars and both
 * absent from `GENERIC_CANDIDATE_TOKENS`, so on a short title one of them could win a
 * slot in `distinctiveTokens` and be required of every catalogue name, guaranteeing an
 * empty candidate pool. Folding first yields the single token `pokemon`, which is already
 * generic vocabulary and drops out of the discriminators harmlessly. Applied HERE (the UPC
 * rung's own tokenizer) and deliberately NOT inside the shared `norm()` — that function is
 * also the PriceCharting bulk-ingest matcher's, and this rung must not change its behaviour.
 */
export function foldDiacritics(s: unknown): string {
  return String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '')
}

/** Normalise ONE title to its identity tokens (fold → norm() → noise stripping). PURE. */
export function titleTokens(title: unknown): string[] {
  return norm(foldDiacritics(title))
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

/** How many discriminators the candidate query starts with, and the floor it relaxes to. */
export const DISCRIMINATOR_MAX = 3
export const DISCRIMINATOR_MIN = 2

export interface UpcTitleMatch {
  canonicalProductId: number
  productKind: string | null
  /** How many discriminators the accepting query used (observability; MAX = no relaxation). */
  discriminatorsUsed?: number
}

/** Why an aggregate did not resolve — the WP4 observability field. Never user-facing. */
export type UpcRejectStage =
  | 'no_discriminators'      // the aggregate was entirely generic vocabulary — never queried
  | 'no_candidates'          // every discriminator set (incl. the relaxed one) pulled 0 rows
  | 'no_confident_match'     // real candidates existed; none cleared the gates, or ≥2 did

export interface MatchTrace {
  rejectStage?: UpcRejectStage
  discriminators: string[]
  discriminatorsUsed: number
  candidatePool: number
  relaxed: boolean
}

/**
 * Resolve an aggregated title against the canonical catalogue: distinctive-token candidate
 * pull (every distinctive token must appear in the product's name+set text; sealed rows
 * first), then the shared pickNumberlessCanonicalMatch with the aggregate as BOTH the
 * product-name and console-name (a listing title carries name, set and game in one string —
 * it is its own corroboration text). Returns null on no/ambiguous match — see the
 * "WHAT CONFIDENT MEANS" block at the top of this file for the exact gate set.
 *
 * ⚠️ CANDIDATE-POOL RELAXATION (2026-08-21 — the fix for the measured zero-pool defect).
 * The pool query ANDs the distinctive tokens, i.e. it requires PROVIDER-derived tokens of the
 * CATALOGUE. That is backwards whenever the provider title carries a word our names never use,
 * and it was zeroing the pool before the matcher ever ran. Two real examples, both measured
 * against prod on 2026-08-21:
 *   - "… Enhanced Booster Display Box - 36 Packs & Box Topper" → discriminators
 *     [evolution, enhanced, TOPPER]; no catalogue name contains "topper" → 0 rows.
 *   - "… Scarlet & Violet Prismatic Evolutions Elite Trainer Box" → [evolutions, prismatic,
 *     SCARLET]; our set is spelled "SV: Prismatic Evolutions" → 0 rows.
 * So: on an EMPTY pool the weakest (shortest) discriminator is dropped and the query is retried
 * once, down to DISCRIMINATOR_MIN. Relaxation is deliberately NOT attempted after the matcher
 * REJECTS a non-empty pool — an empty pool means the pool was over-constrained (a pool-building
 * defect), whereas a rejection means the matcher saw real candidates and made its call; widening
 * the pool then could only add accepts, i.e. trade precision for recall. Bounded at ONE retry so
 * a miss costs at most two catalogue scans.
 */
export async function matchAggregateToCatalogue(
  db: D1Database,
  aggregate: string,
  opts: { onTrace?: (t: MatchTrace) => void } = {},
): Promise<UpcTitleMatch | null> {
  const trace = (t: MatchTrace) => { try { opts.onTrace?.(t) } catch { /* never break a lookup to log */ } }

  const discriminators = distinctiveTokens(aggregate, DISCRIMINATOR_MAX)
  if (discriminators.length === 0) {
    // nothing but generic vocabulary → unmatchable, and never worth a catalogue scan
    trace({ rejectStage: 'no_discriminators', discriminators, discriminatorsUsed: 0, candidatePool: 0, relaxed: false })
    return null
  }

  const floor = Math.min(DISCRIMINATOR_MIN, discriminators.length)
  for (let used = discriminators.length; used >= floor; used--) {
    // longest-first ordering means slicing from the front drops the WEAKEST token
    const active = discriminators.slice(0, used)
    const relaxed = used < discriminators.length
    const clause = active.map(() => `instr(lower(p.name) || ' ' || lower(s.name), ?) > 0`).join(' AND ')
    const { results } = await db.prepare(`
      SELECT p.id, p.name, p.product_kind AS productKind, s.name AS setName
      FROM products p
      JOIN sets s ON s.id = p.set_id
      WHERE ${clause}
      ORDER BY (CASE WHEN p.product_kind = 'sealed' THEN 0 ELSE 1 END), p.id DESC
      LIMIT ${CANDIDATE_LIMIT}
    `).bind(...active).all<{ id: number; name: string | null; productKind: string | null; setName: string | null }>()

    const rows = results ?? []
    if (rows.length === 0) continue   // over-constrained pool → relax once, else fall out below

    const candidates: NumberlessCandidate[] = rows.map((r) => ({ id: r.id, name: r.name, setName: r.setName }))
    const matchedId = pickNumberlessCanonicalMatch(
      { 'product-name': aggregate, 'console-name': aggregate },
      candidates,
    )
    if (matchedId == null) {
      trace({ rejectStage: 'no_confident_match', discriminators, discriminatorsUsed: used, candidatePool: rows.length, relaxed })
      return null
    }
    const row = rows.find((r) => r.id === matchedId)
    trace({ discriminators, discriminatorsUsed: used, candidatePool: rows.length, relaxed })
    return { canonicalProductId: matchedId, productKind: row?.productKind ?? null, discriminatorsUsed: used }
  }

  trace({ rejectStage: 'no_candidates', discriminators, discriminatorsUsed: floor, candidatePool: 0, relaxed: discriminators.length > floor })
  return null
}

// ── Shared rung observability (WP4, 2026-08-21) ──────────────────────────────
//
// THE POINT OF THIS: for a full week a completely non-functional external rung and a
// legitimate "this barcode isn't in the catalogue" miss produced byte-identical output —
// `{found:false}` and silence. Nothing in the tail could tell them apart, so nobody looked.
// Every external-rung resolution now emits ONE structured line naming the rung, the outcome
// and, on a near-miss, WHICH STAGE rejected it. A resolution is not a failure, so this is
// `info`, not `warn` — the handled-fallback severity rule (CLAUDE.md → observability) reserves
// `warn` for a fallback the caller absorbed, which is what the not-configured/cap/backoff
// gates below use.

export interface RungResolutionLog {
  rung: 'ebay' | 'upcitemdb'
  code: string
  outcome: 'hit' | 'miss' | 'skipped'
  /** How many provider titles the aggregation saw (0 = the provider knows nothing). */
  titles?: number
  aggregate?: string | null
  canonicalProductId?: number
  skipped?: string
  trace?: MatchTrace
}

/** ONE structured resolution line per external-rung lookup. Never throws. */
export function logRungResolution(entry: RungResolutionLog): void {
  try {
    logger.info('upc_rung_resolution', {
      rung: entry.rung,
      upc: entry.code,
      outcome: entry.outcome,
      titles: entry.titles ?? 0,
      aggregate: entry.aggregate ?? null,
      canonical_product_id: entry.canonicalProductId ?? null,
      skipped: entry.skipped ?? null,
      reject_stage: entry.trace?.rejectStage ?? null,
      discriminators: entry.trace?.discriminators ?? null,
      discriminators_used: entry.trace?.discriminatorsUsed ?? null,
      candidate_pool: entry.trace?.candidatePool ?? null,
      relaxed: entry.trace?.relaxed ?? null,
    })
  } catch { /* observability must never break a lookup */ }
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
