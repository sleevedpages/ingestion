/**
 * PriceCharting per-game price-guide CSV — pure parse + decode helpers (no IO).
 *
 * The operator's PriceCharting plan can export a full per-category price guide as CSV:
 *   GET https://www.pricecharting.com/price-guide/download-custom?t=TOKEN&category=CAT
 * for CAT ∈ { pokemon-cards, magic-cards, yugioh-cards, one-piece-cards }. Each export
 * is ~88k rows. This is the production backbone that supersedes the on-demand API path
 * FOR THESE 4 GAMES (the API path stays the fallback for other games).
 *
 * CSV SHAPE (verified against a real 88k-row Pokémon export):
 *   id, console-name, product-name, loose-price, cib-price, new-price, graded-price,
 *   box-only-price, manual-only-price, bgs-10-price, condition-17-price,
 *   condition-18-price, gamestop-*, retail-*, upc, sales-volume, genre, tcg-id, asin,
 *   epid, release-date.
 * Prices are DOLLAR strings ("$46.47") in the CSV (note: the /api JSON returns pennies —
 * the CSV is formatted dollars). Rows tagged genre = "Sealed Product" are sealed product.
 *
 * DECODE MAP — reuses the SAME price-guide keys as the on-demand API path
 * (pricechartingClient.ts GRADE_KEY_LABEL + LOOSE_KEY), so a card decodes identically
 * whichever path priced it:
 *   loose-price        → ungraded / market    (condition NULL, finish 'normal', grade NULL)
 *   cib-price          → grade 'Grade 7 / 7.5'
 *   new-price          → grade 'Grade 8 / 8.5'
 *   graded-price       → grade 'Grade 9'
 *   box-only-price     → grade 'Grade 9.5'
 *   manual-only-price  → grade 'PSA 10'
 *   bgs-10-price       → grade 'BGS 10'
 *   condition-17-price → grade 'CGC 10'
 *   condition-18-price → grade 'SGC 10'
 * (No TAG/ACE bucket; sub-10 grades are company-agnostic — same caveats as the API path.)
 */

import { GRADE_KEY_LABEL, LOOSE_KEY } from './pricechartingClient.js'

/** The four PriceCharting categories we bulk-ingest (operator-confirmed download URLs). */
export const PRICECHARTING_CATEGORIES = [
  'pokemon-cards',
  'magic-cards',
  'yugioh-cards',
  'one-piece-cards',
] as const
export type PriceChartingCategory = (typeof PRICECHARTING_CATEGORIES)[number]

/** Build the operator-confirmed download URL. The token is injected by the caller and
 * NEVER logged/returned — it lives only in the worker secret PRICECHARTING_TOKEN. */
export function buildDownloadUrl(category: string, token: string): string {
  const u = new URL('https://www.pricecharting.com/price-guide/download-custom')
  u.searchParams.set('t', token)
  u.searchParams.set('category', category)
  return u.toString()
}

/** Genre value that flags a sealed-product row. */
export const SEALED_GENRE = 'Sealed Product'

/**
 * One write-path price column: a CSV column → the canonical `prices.grade` label it
 * decodes to (null for the ungraded/market row). Derived from the shared API decode map
 * so the two paths can never drift. The ungraded row is first.
 */
export interface PcPriceColumn { col: string; grade: string | null }
export const PC_PRICE_COLUMNS: PcPriceColumn[] = [
  { col: LOOSE_KEY, grade: null }, // ungraded / market
  ...Object.entries(GRADE_KEY_LABEL).map(([col, grade]) => ({ col, grade })),
]
/** Just the graded columns (sealed product skips these — it has no graded tiers). */
export const PC_GRADED_COLUMNS = PC_PRICE_COLUMNS.filter((c) => c.grade !== null)

/**
 * Ungraded buy/sell spread columns (the retail price-guide pair for the loose/market row).
 * Captured ONLY on the ungraded row (grade === null) → canonical `prices.retail_buy`/
 * `retail_sell` (mig 0075). They are the negotiating spread surfaced in the fallback display
 * for cards Scrydex doesn't cover; graded tiers keep value-only.
 */
export const RETAIL_BUY_KEY = 'retail-loose-buy'
export const RETAIL_SELL_KEY = 'retail-loose-sell'

// ── Dollar parsing ────────────────────────────────────────────────────────────

/**
 * Parse a CSV dollar string ("$46.47", "$1,234.56", "") to INTEGER CENTS, or null when
 * blank / non-positive / unparseable. Cents is the exact intermediate (no float drift);
 * the write path divides by 100 to store DOLLARS in canonical `prices.value` — matching
 * the scrydex/tcgplayer rows the serving already reads (it does `value.toFixed(2)`).
 */
export function parseDollarsToCents(raw: unknown): number | null {
  if (raw == null) return null
  const s = String(raw).trim()
  if (!s) return null
  // Strip currency symbol, thousands separators, and surrounding space.
  const cleaned = s.replace(/[$,\s]/g, '')
  if (!cleaned || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null
  const dollars = Number(cleaned)
  if (!Number.isFinite(dollars) || dollars <= 0) return null
  return Math.round(dollars * 100)
}

// ── CSV line parsing ──────────────────────────────────────────────────────────

/**
 * Detect the field delimiter from the header line. The real PriceCharting export is
 * TAB-separated and leaves the dollar fields' thousands commas UNQUOTED ("$2,200.00"),
 * so a comma split would shred every priced row — detect tabs first. Falls back to comma
 * for a genuine CSV. PURE.
 */
export function detectDelimiter(headerLine: string): '\t' | ',' {
  const tabs = (headerLine.match(/\t/g) ?? []).length
  const commas = (headerLine.match(/,/g) ?? []).length
  return tabs >= commas && tabs > 0 ? '\t' : ','
}

/**
 * Parse a single delimited line into its fields, honouring double-quoted fields (which may
 * contain the delimiter and "" escaped quotes). Pure. Default delimiter is comma; pass '\t'
 * for the tab-separated PriceCharting export. Product/console names and (in CSV mode) dollar
 * fields carry the delimiter, so a naive split() would corrupt the column alignment.
 */
export function parseCsvLine(line: string, delimiter: string = ','): string[] {
  const out: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++ } // escaped quote
        else inQuotes = false
      } else field += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delimiter) {
      out.push(field); field = ''
    } else {
      field += ch
    }
  }
  out.push(field)
  return out
}

/** A parsed CSV row keyed by lowercased column header. */
export type PcCsvRow = Record<string, string>

/** Build a header→index map from the parsed header line (lowercased, trimmed). */
export function buildHeaderIndex(headerFields: string[]): Record<string, number> {
  const idx: Record<string, number> = {}
  headerFields.forEach((h, i) => { idx[h.trim().toLowerCase()] = i })
  return idx
}

/** Map a parsed data line to a row object using the header index. */
export function rowFromFields(fields: string[], headerIdx: Record<string, number>): PcCsvRow {
  const row: PcCsvRow = {}
  for (const [name, i] of Object.entries(headerIdx)) row[name] = fields[i] ?? ''
  return row
}

/** True when a parsed row is a sealed-product row (genre = "Sealed Product"). */
export function isSealedRow(row: PcCsvRow): boolean {
  return (row['genre'] ?? '').trim() === SEALED_GENRE
}

/** One decoded canonical `prices` row from a CSV row. The ungraded/market row (grade null)
 * may also carry the retail buy/sell spread (mig 0075); graded rows are value-only. */
export interface PcDecodedPriceRow {
  grade: string | null
  valueDollars: number
  retailBuyDollars?: number
  retailSellDollars?: number
}

/**
 * Decode a parsed CSV row to the canonical `prices` rows it should write. Sealed rows
 * get ONLY the ungraded/market row (sealed product has no graded tiers); card rows get
 * the ungraded row plus every graded bucket that carries a positive value. `valueDollars`
 * is ready for `prices.value` (dollars). The ungraded row additionally carries the retail
 * buy/sell spread when present (→ `prices.retail_buy`/`retail_sell`). PURE.
 */
export function csvRowToPriceRows(
  row: PcCsvRow,
  opts: { isSealed?: boolean } = {},
): PcDecodedPriceRow[] {
  const cols = opts.isSealed ? PC_PRICE_COLUMNS.filter((c) => c.grade === null) : PC_PRICE_COLUMNS
  const rows: PcDecodedPriceRow[] = []
  for (const { col, grade } of cols) {
    const cents = parseDollarsToCents(row[col])
    if (cents == null) continue
    const out: PcDecodedPriceRow = { grade, valueDollars: cents / 100 }
    if (grade === null) {
      // The ungraded/market row carries the retail buy/sell negotiating spread.
      const buy = parseDollarsToCents(row[RETAIL_BUY_KEY])
      const sell = parseDollarsToCents(row[RETAIL_SELL_KEY])
      if (buy != null) out.retailBuyDollars = buy / 100
      if (sell != null) out.retailSellDollars = sell / 100
    }
    rows.push(out)
  }
  return rows
}

// ── Matching helpers ──────────────────────────────────────────────────────────

/** Normalise to lowercase alphanumeric tokens separated by single spaces. */
export function norm(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}
/** Lowercase, alphanumeric-only (no separators): "EB02-010" → "eb02010". */
export function compact(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}
/** Strip a "NNN/TTT" set-size suffix and leading zeros: "004/198" → "4". */
export function cleanNumber(n: unknown): string {
  return String(n ?? '').split('/')[0].replace(/^0+/, '').toLowerCase().trim()
}

/**
 * VALIDATE a tcg-id join: the CSV `product-name` (name + number) must share enough with
 * the canonical product to confirm the TCGPlayer-id join is the right card — a guard
 * against a tcg-id that means something other than the TCGPlayer product id, or stale
 * id reuse. PURE.
 *
 * Parenthetical-aware (2026-07-15, DIAGNOSTIC_DON_AND_GEMPACK A3): PriceCharting
 * routinely omits our parenthetical qualifiers (canonical "DON!! Card (Gol.D.Roger)
 * (Gold)" appears on PC as "DON!! Card [Gold Alternate Art]" — `roger` never in the
 * haystack), so requiring EVERY canonical token rejected 33 rows whose tcg-id was
 * CORRECT. The rule now splits the canonical name:
 *   - BASE tokens (outside parentheses) — ALL must appear in the PC product-name +
 *     console-name haystack (unchanged strictness: this is what discriminates a
 *     wrong join — a different card's name never matches).
 *   - PARENTHETICAL qualifier tokens — a MAJORITY (≥ half) must appear. Losing one
 *     omitted qualifier no longer kills a correct id, but a candidate whose
 *     qualifiers are mostly absent (a different variant / wrong card) still fails.
 * Names without parentheses behave exactly as before (all tokens required).
 * (Chosen over plain reverse containment, which fails the motivating case: PC's own
 * bracket qualifiers — "alternate art" — are absent from the canonical name.)
 */
export function validateTcgIdMatch(
  csvRow: { 'product-name'?: string; 'console-name'?: string },
  canonical: { name?: string | null },
): boolean {
  const rawName = String(canonical?.name ?? '')
  if (!norm(rawName)) return false
  const baseTokens = norm(rawName.replace(/\([^)]*\)/g, ' ')).split(' ').filter((t) => t.length >= 3)
  const qualTokens = norm((rawName.match(/\(([^)]*)\)/g) ?? []).join(' ')).split(' ').filter((t) => t.length >= 3)
  if (baseTokens.length === 0 && qualTokens.length === 0) {
    // Pure short/numeric name (rare) — accept; the tcg-id itself is strong evidence.
    return true
  }
  const hay = `${norm(csvRow?.['product-name'])} ${norm(csvRow?.['console-name'])}`.trim()
  if (!baseTokens.every((t) => hay.includes(t))) return false
  if (qualTokens.length > 0) {
    const hits = qualTokens.filter((t) => hay.includes(t)).length
    return hits * 2 >= qualTokens.length
  }
  return true
}

export interface FuzzyCandidate { id: number; name: string | null; number: string | null }

/**
 * Pick + VALIDATE the best canonical product for a CSV row with no usable tcg-id, by
 * matching CSV product-name (name + number) + console-name (set) against candidate
 * canonical products. Mirror of the API path's pickBestPcMatch, reversed (canonical is
 * the candidate set here). Rejects weak matches rather than mispricing. PURE.
 *
 * Score: all CSV name tokens present in the candidate name (+2); compact number present
 * in the candidate (number or name) (+3). Accept at ≥ 5 (name + number) — name alone
 * never settles it (the candidates are already number/set-scoped by the SQL caller, so a
 * name-only tie among same-number cards would be ambiguous). Returns the candidate id or null.
 */
export function pickBestCanonicalMatch(
  csvRow: { 'product-name'?: string; 'console-name'?: string },
  candidates: FuzzyCandidate[],
): number | null {
  if (!Array.isArray(candidates) || candidates.length === 0) return null
  const csvName = norm(csvRow?.['product-name'])
  if (!csvName) return null
  // Name tokens for the name check EXCLUDE pure-numeric tokens — the embedded card number
  // is corroborated separately (numHit), and the canonical NAME doesn't carry it (it lives
  // in the candidate's number field).
  const nameTokens = csvName.split(' ').filter((t) => t.length >= 3 && !/^\d+$/.test(t))
  if (nameTokens.length === 0) return null
  // The CSV product-name embeds the number; pull it as a compact token for corroboration.
  const numCompact = compact(csvName.split(' ').filter((t) => /\d/.test(t)).join(''))

  let best: { id: number; score: number } | null = null
  for (const c of candidates) {
    const candName = norm(c?.name)
    if (!candName) continue
    const nameHit = nameTokens.every((t) => candName.includes(t))
    if (!nameHit) continue
    const candCompact = compact(`${candName} ${compact(cleanNumber(c?.number))}`)
    const numHit = numCompact ? candCompact.includes(numCompact) : false
    let score = 2
    if (numHit) score += 3
    if (best == null || score > best.score) best = { id: c.id, score }
  }
  return best && best.score >= 5 ? best.id : null
}

// ── Number-less matching (2026-07-15, DIAGNOSTIC_DON_AND_GEMPACK A2) ─────────────

/** A number-less canonical candidate (products.number NULL/empty, product_kind='card'),
 * carrying its set name for console↔set corroboration. */
export interface NumberlessCandidate { id: number; name: string | null; setName: string | null }

/**
 * Match a PC CSV row that carries NO digit token in its product-name (so the numeric
 * fuzzy rung structurally can't fire) against the number-less canonical candidate pool
 * (One Piece DON!!s are the archetype: 239/242 have `number` NULL by Bandai design). PURE.
 *
 * Mirrors the on-demand API path's set-corroboration rung (pricechartingClient.ts
 * pickBestPcMatch `setHit`), tightened for the bulk path:
 *   - ALL canonical name tokens (≥3 chars, pure-numeric excluded — the same definition
 *     pickBestCanonicalMatch uses; the real Dodgers canonical is "DON!! Card (LA Dodgers
 *     2026 Promo)" and PC never carries the `2026`) must appear in the PC product-name +
 *     console-name haystack (discriminates variants: a non-"Dodgers" print lacks the
 *     `dodgers` token), AND
 *   - console↔set corroboration: at least one canonical set-name token appears in the
 *     PC console-name, or vice versa (bidirectional so "Promo" ⊂ "Promotion Cards"
 *     corroborates either way), AND
 *   - the accepting candidate is UNIQUE — two candidates passing both gates is
 *     ambiguous and returns null. Name alone never settles anything; the worst case
 *     stays "unmatched", never "wrong price".
 */
export function pickNumberlessCanonicalMatch(
  csvRow: { 'product-name'?: string; 'console-name'?: string },
  candidates: NumberlessCandidate[],
): number | null {
  if (!Array.isArray(candidates) || candidates.length === 0) return null
  const pcName = norm(csvRow?.['product-name'])
  const pcConsole = norm(csvRow?.['console-name'])
  if (!pcName) return null
  const hay = `${pcName} ${pcConsole}`.trim()
  const consoleTokens = pcConsole.split(' ').filter((t) => t.length >= 3)

  let acceptedId: number | null = null
  for (const c of candidates) {
    const candName = norm(c?.name)
    if (!candName) continue
    const nameTokens = candName.split(' ').filter((t) => t.length >= 3 && !/^\d+$/.test(t))
    if (nameTokens.length === 0) continue
    if (!nameTokens.every((t) => hay.includes(t))) continue
    const setNorm = norm(c?.setName)
    const setTokens = setNorm.split(' ').filter((t) => t.length >= 3)
    const setHit =
      (setTokens.length > 0 && setTokens.some((t) => pcConsole.includes(t))) ||
      (consoleTokens.length > 0 && setNorm.length > 0 && consoleTokens.some((t) => setNorm.includes(t)))
    if (!setHit) continue
    if (acceptedId != null && acceptedId !== c.id) return null   // ambiguous → unmatched
    acceptedId = c.id
  }
  return acceptedId
}
