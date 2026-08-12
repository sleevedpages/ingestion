/**
 * scrydexFieldProbe.ts — READ-ONLY shape + match probe for the Scrydex `/cards` payload.
 *
 * WHY THIS EXISTS (Card attribute metadata, Session 3A, 2026-08-12).
 * Session 1's live TCGCSV diagnostic proved Magic carries NO mana cost and NO colour in
 * `extendedData`, in any era. Filling that gap from Scrydex needs two facts nobody has measured on
 * live data yet, and BOTH are load-bearing for the fill job's design:
 *
 *   1. WHICH FIELDS the Magic card payload actually carries, and under what names. Scrydex's public
 *      docs describe `mana_cost` ("{2}{R}{W}{B}"), `mana_value`, `colors`, `color_identity`,
 *      `types`/`supertypes`/`subtypes` — documentation is not evidence, and the attribute store
 *      keeps source field names VERBATIM, so a wrong guess bakes a wrong key into the read-side
 *      facet map that Session 3B ships.
 *   2. WHICH MATCH RUNG resolves a Scrydex card to a canonical product. `products.scrydex_card_id`
 *      is NULL for all 117,278 Magic products (measured 2026-08-12) — variant capture only ever ran
 *      for One Piece / Gundam — so the fill must rely on the drain's R1 (`variants[].marketplaces`
 *      tcgplayer `product_id`) or the seed's `card.id` / `card.number` rungs. Which of those works
 *      for Magic is unknown until someone looks.
 *
 * It is a PROBE, not a job: ONE page of ONE expansion (1 credit), NO writes of any kind, no
 * freshness marks, no run-log row. Safe to fire at any time — including right now, while the
 * Scrydex account is returning HTTP 402 on every call, in which case it reports that cleanly
 * instead of pretending to measure something.
 *
 * The DB reads it performs are the SAME chunked `IN (…)` lookups the fill will use, so the match
 * rates it reports are the rates the fill would achieve — not an estimate.
 */

import type { Env } from './worker.js'
import { ScrydexCreditLimitError } from './lib/scrydexClient.js'
import { fetchAllExpansionCards, ScrydexCardsError } from './lib/scrydexCards.js'
import { GAME_SLUG_BY_CANONICAL_NAME } from './lib/gameNames.js'

/** D1 caps bound params at 100/statement; the shared repo ceiling is 90. */
const IN_CHUNK = 90

// Local, like every other module's copy (ingestion/db.ts, pricechartingIngest.ts).
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}
/** Sample cap — the probe reports on at most this many cards from the single fetched page. */
const SAMPLE_MAX = 250

export interface FieldCensusEntry {
  field:   string
  present: number          // cards carrying a non-empty value
  kind:    string          // 'string' | 'number' | 'array<string>' | 'object' | mixed, as observed
  sample:  string          // first non-empty value, stringified + trimmed to 120 chars
}

export interface ProbeResult {
  ok:            boolean
  error?:        string
  status?:       number    // Scrydex HTTP status when the call failed (402/403/…)
  game?:         string
  gameSlug?:     string
  expansionId?:  string
  setName?:      string
  cardsSampled?: number
  totalCount?:   number    // cards Scrydex reports for the whole expansion (pages = ceil/pageSize)
  requests?:     number    // credits spent by this probe
  /** Top-level card fields, most-present first. */
  cardFields?:   FieldCensusEntry[]
  /** Fields seen inside `variants[]`. */
  variantFields?: FieldCensusEntry[]
  /** Cards whose variants expose a tcgplayer marketplace product_id (the R1 rung). */
  withTcgplayerProductId?: number
  /** How many sampled cards each match rung resolves to a canonical product. */
  matchRungs?: {
    r1_tcgplayerProductId: number
    r2_cardIdVsNumber:     number
    r3_numberInExpansion:  number
    anyRung:               number
    unmatched:             number
  }
  /** A few unmatched cards, so a catalogue gap is inspectable rather than a bare count. */
  unmatchedSample?: { id: string | null; name: string | null; number: string | null }[]
}

const str = (v: unknown): string => {
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(';')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

const kindOf = (v: unknown): string => {
  if (Array.isArray(v)) return `array<${v.length ? typeof v[0] : 'empty'}>`
  return v === null ? 'null' : typeof v
}

/** Count presence + capture one sample value for every key seen across a list of objects. */
export function censusFields(objects: readonly unknown[]): FieldCensusEntry[] {
  const acc = new Map<string, { present: number; kinds: Set<string>; sample: string }>()
  for (const obj of objects) {
    if (!obj || typeof obj !== 'object') continue
    for (const [field, value] of Object.entries(obj as Record<string, unknown>)) {
      const text = str(value)
      const entry = acc.get(field) ?? { present: 0, kinds: new Set<string>(), sample: '' }
      if (text !== '' && text !== '[]' && text !== '{}') {
        entry.present++
        entry.kinds.add(kindOf(value))
        if (!entry.sample) entry.sample = text.slice(0, 120)
      }
      acc.set(field, entry)
    }
  }
  return [...acc.entries()]
    .map(([field, e]) => ({ field, present: e.present, kind: [...e.kinds].join('|') || 'empty', sample: e.sample }))
    .sort((a, b) => b.present - a.present || a.field.localeCompare(b.field))
}

/** The tcgplayer marketplace product id on one variant, or null (the drain's R1 bridge). */
export function tcgplayerProductIdOf(variant: unknown): number | null {
  const marketplaces = (variant as any)?.marketplaces
  if (!Array.isArray(marketplaces)) return null
  const tcg = marketplaces.find((m: any) => m?.name === 'tcgplayer')
  const raw = tcg?.product_id
  const n = raw == null ? NaN : parseInt(String(raw), 10)
  return Number.isFinite(n) ? n : null
}

interface ProbeOptions {
  game?:        string    // canonical games.name (default 'Magic')
  expansionId?: string    // sets.scrydex_expansion_id; default = the newest mapped set for the game
  limit?:       number
}

/**
 * Fetch ONE page of one expansion and report what it contains + how well it matches our catalogue.
 * Makes no writes. Returns `{ ok:false, status }` on a Scrydex error rather than throwing, so the
 * caller (and the operator) sees the provider's status instead of a stack trace.
 */
export async function probeScrydexFields(env: Env, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const game = opts.game ?? 'Magic'
  const gameSlug = GAME_SLUG_BY_CANONICAL_NAME[game]
  if (!gameSlug) return { ok: false, error: `no Scrydex slug for game: ${game}` }

  // Resolve the expansion: the caller's, else the newest mapped set for this game — the most
  // representative of what the fill would mostly be reading.
  let expansionId = opts.expansionId ?? null
  let setName: string | undefined
  const setRow = await env.DB.prepare(`
    SELECT s.name, s.scrydex_expansion_id
    FROM   sets s
    JOIN   canonical_games g ON g.id = s.game_id
    WHERE  g.name = ?
      AND  s.scrydex_expansion_id IS NOT NULL AND TRIM(s.scrydex_expansion_id) <> ''
      ${expansionId ? 'AND s.scrydex_expansion_id = ?' : ''}
    ORDER BY s.release_date DESC, s.id DESC
    LIMIT 1
  `).bind(...(expansionId ? [game, expansionId] : [game])).first<{ name: string; scrydex_expansion_id: string }>()

  if (!setRow) return { ok: false, error: `no mapped set found for ${game}${expansionId ? ` / ${expansionId}` : ''}` }
  expansionId = setRow.scrydex_expansion_id
  setName = setRow.name

  const base: ProbeResult = { ok: true, game, gameSlug, expansionId, setName }

  let cards: any[]
  let requests: number
  try {
    ;({ cards, requests } = await fetchAllExpansionCards(env, gameSlug, expansionId, 'fieldProbe'))
  } catch (err) {
    if (err instanceof ScrydexCreditLimitError) {
      return { ...base, ok: false, error: 'Scrydex monthly credit guard triggered' }
    }
    if (err instanceof ScrydexCardsError) {
      // 402 (payment required / plan exhausted) and 403 (credit cap) both land here.
      return { ...base, ok: false, error: err.message, status: err.status }
    }
    return { ...base, ok: false, error: String(err) }
  }

  const sample = cards.slice(0, opts.limit ?? SAMPLE_MAX)
  const variants = sample.flatMap(c => (Array.isArray(c?.variants) ? c.variants : []))

  // ── Match rungs, measured with the SAME chunked reads the fill will use ──────────
  const tcgIds = [...new Set(sample.flatMap(c =>
    (Array.isArray(c?.variants) ? c.variants : []).map(tcgplayerProductIdOf).filter((n: number | null): n is number => n !== null)))]
  const knownTcgIds = new Set<number>()
  for (const ids of chunk(tcgIds, IN_CHUNK)) {
    const { results } = await env.DB.prepare(
      `SELECT tcgplayer_product_id FROM products WHERE tcgplayer_product_id IN (${ids.map(() => '?').join(',')})`
    ).bind(...ids).all<{ tcgplayer_product_id: number }>()
    for (const r of results ?? []) knownTcgIds.add(r.tcgplayer_product_id)
  }

  // `products.number` holds the FULL printed code for code-style games (the seed's lesson), so both
  // `card.id` (e.g. 'KTK-214') and the bare `card.number` are tried, scoped to this expansion.
  const numbers = [...new Set(sample.flatMap(c => [c?.id, c?.number].filter(Boolean).map(String)))]
  const knownNumbers = new Set<string>()
  for (const ns of chunk(numbers, IN_CHUNK - 1)) {
    const { results } = await env.DB.prepare(`
      SELECT LOWER(p.number) AS number
      FROM   products p
      JOIN   sets s ON s.id = p.set_id
      WHERE  LOWER(s.scrydex_expansion_id) = LOWER(?)
        AND  LOWER(p.number) IN (${ns.map(() => '?').join(',')})
    `).bind(expansionId, ...ns.map(n => n.toLowerCase())).all<{ number: string }>()
    for (const r of results ?? []) knownNumbers.add(r.number)
  }

  const rungs = { r1_tcgplayerProductId: 0, r2_cardIdVsNumber: 0, r3_numberInExpansion: 0, anyRung: 0, unmatched: 0 }
  const unmatchedSample: ProbeResult['unmatchedSample'] = []
  for (const c of sample) {
    const r1 = (Array.isArray(c?.variants) ? c.variants : [])
      .some((v: unknown) => { const id = tcgplayerProductIdOf(v); return id !== null && knownTcgIds.has(id) })
    const r2 = c?.id != null && knownNumbers.has(String(c.id).toLowerCase())
    const r3 = c?.number != null && knownNumbers.has(String(c.number).toLowerCase())
    if (r1) rungs.r1_tcgplayerProductId++
    if (r2) rungs.r2_cardIdVsNumber++
    if (r3) rungs.r3_numberInExpansion++
    if (r1 || r2 || r3) rungs.anyRung++
    else {
      rungs.unmatched++
      if (unmatchedSample.length < 5) {
        unmatchedSample.push({
          id:     c?.id != null ? String(c.id) : null,
          name:   c?.name != null ? String(c.name) : null,
          number: c?.number != null ? String(c.number) : null,
        })
      }
    }
  }

  const result: ProbeResult = {
    ...base,
    cardsSampled:  sample.length,
    totalCount:    cards.length,
    requests,
    cardFields:    censusFields(sample),
    variantFields: censusFields(variants),
    withTcgplayerProductId: sample.filter(c =>
      (Array.isArray(c?.variants) ? c.variants : []).some((v: unknown) => tcgplayerProductIdOf(v) !== null)).length,
    matchRungs: rungs,
    unmatchedSample,
  }
  console.log(JSON.stringify({ log: 'scrydex_field_probe', game, expansionId, ...rungs, requests }))
  return result
}
