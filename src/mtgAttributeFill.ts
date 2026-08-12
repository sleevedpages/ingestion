/**
 * mtgAttributeFill.ts — Magic mana cost + colour into `product_attributes`, from Scrydex.
 *
 * THE GAP THIS CLOSES. Session 1's live TCGCSV survey proved Magic carries NO mana cost and NO
 * colour in `extendedData`, in any era (its whole key set is Rarity/Number/SubType/OracleText/P/T/
 * FlavorText/UPC). That is the one deck-building facet the attribute store cannot fill from its own
 * source, so Content's facet map marks Magic `cost`/`color` as `ABSENT_NO_SOURCE` and shows an
 * honest note instead of a chart. This job fills them from the game's OTHER catalogue.
 *
 * EVERY CONSTANT BELOW COMES FROM THE LIVE PROBE (`POST /admin/scrydex-probe`, expansion SPG,
 * 166 cards, 2026-08-12) — not from Scrydex's documentation:
 *
 *   field presence   mana_value 99.4% · mana_cost 89.8% (`{U}{U}`) · color_identity 77.1% ·
 *                    colors 76.5% · type 99.4%
 *   match rungs      R1 `variants[].marketplaces[tcgplayer].product_id` → 98.8%
 *                    R3 `card.number` within the expansion            → 99.4%
 *                    R2 `card.id` vs `products.number`                → 0.0%, DROPPED
 *   page size        the server caps at 100 regardless of the 250 we request (166 cards = 2 calls),
 *                    so an expansion costs ceil(cards / 100) credits — budget on 100, not 250.
 *
 * R2 is dropped deliberately: for Magic, `card.id` is the printed code (`SPG-1`) while
 * `products.number` holds the bare number (`1`), so the seed's code-first rung — correct for One
 * Piece / Gundam — matches NOTHING here. Keeping a rung that never fires would only add reads.
 *
 * ⚠️ COLOURLESS IS NOT UNKNOWN. A land or artifact legitimately has `colors: []`, which stores no
 * `@scrydex.colors` row. The read side distinguishes the two by PRESENCE OF THE GROUP: a product
 * carrying ANY `@scrydex.*` row was filled, so no colours row on a filled product means COLOURLESS,
 * while no rows at all means not-yet-filled. That works because a product's rows are written as one
 * atomic all-or-nothing group.
 *
 * Writes go through the shared coexistence layer (`externalAttributeStatements`), so this job can
 * never touch a TCGCSV row and the daily sync can never wipe one of ours. It also never stamps
 * `products.extended_data_hash` — that column vouches for the TCGCSV rows alone.
 */

import type { Env } from './worker.js'
import { ScrydexCreditLimitError, isScrydexRefusal } from './lib/scrydexClient.js'
import { fetchAllExpansionCards, ScrydexCardsError } from './lib/scrydexCards.js'
import { markExpansionFresh } from './scrydexProcessor.js'
import { UNMATCHED_UPSERT_SQL } from './scrydexProcessor.js'
import {
  buildExternalAttributes,
  externalAttributeStatements,
  type ProductAttribute,
} from './lib/productAttributes.js'

/** Canonical game name (`canonical_games.name`) and its Scrydex slug. MTG ONLY — see the header. */
const GAME = 'Magic'
const GAME_SLUG = 'magicthegathering'

/** The attribute-store source id. Keys land as `@scrydex.<field>`. */
export const FILL_SOURCE = 'scrydex'

/**
 * Freshness marker class. `scrydex_expansion_freshness` is keyed (expansion, price_type); using our
 * own class means the fill's progress is independent of the price drain's `raw`/`graded` marks — it
 * can never fresh-skip a price fetch, and a price fetch can never fresh-skip the fill.
 */
export const FILL_FRESHNESS_CLASS = 'mtg_attrs'

/** Scrydex fields persisted, VERBATIM. Order is the stored `position` order. */
export const FILL_FIELDS = ['mana_cost', 'mana_value', 'colors', 'color_identity'] as const

const IN_CHUNK    = 90    // D1 caps bound params at 100/statement
const BATCH_SIZE  = 100   // statements per db.batch()
/**
 * Expansions per invocation. **ONE**, matching `scrydex-image-repair` (one set per call) and
 * `purge-placeholder-mirrors` (one batch per call) — this endpoint is SYNCHRONOUS, so the whole
 * batch has to finish inside a single client-facing request.
 *
 * ⚠️ Measured 2026-08-12: a default of 15 killed the connection outright — `fetch failed /
 * UND_ERR_SOCKET, other side closed` with `bytesRead: 0`, i.e. the edge gave up long before the
 * worker could answer. A big Magic expansion is several page fetches plus dozens of D1 batches; a
 * dozen of them in one request is minutes of work. The driver script loops, so throughput is
 * unchanged and every completed expansion is durably marked. Raise it with `maxExpansions` only for
 * a run of known-small expansions.
 */
const DEFAULT_MAX_EXPANSIONS = 1

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export interface FillOptions {
  /** Bound the invocation (the loop driver re-calls until `hasMore` is false). */
  maxExpansions?: number
  /** Re-fill expansions already marked done. */
  force?: boolean
  /** Fill exactly one expansion (verification / spot repair). */
  expansionId?: string
}

export interface FillResult {
  ok:                   boolean
  expansionsProcessed:  number
  expansionsRemaining:  number
  hasMore:              boolean
  cardsFetched:         number
  productsWritten:      number
  attributeRowsWritten: number
  cardsUnmatched:       number
  requests:             number      // Scrydex page-calls = credits
  /** Set when the run stopped early: 'credit_guard' | 'scrydex_402' | 'scrydex_403' | 'error'. */
  stoppedReason?:       string
  error?:               string
}

interface ExpansionRow { scrydex_expansion_id: string }

/** Mapped Magic expansions still needing a fill, newest set first (the ones people build with). */
async function pendingExpansions(env: Env, opts: FillOptions): Promise<ExpansionRow[]> {
  if (opts.expansionId) return [{ scrydex_expansion_id: opts.expansionId }]

  // DISTINCT expansions, never per-set: many canonical sets share one scrydex_expansion_id, and
  // per-set iteration is what wasted credits + died under waitUntil during the D-bis seed.
  const freshnessClause = opts.force ? '' : `
      AND NOT EXISTS (
        SELECT 1 FROM scrydex_expansion_freshness f
         WHERE f.scrydex_expansion_id = s.scrydex_expansion_id
           AND f.price_type           = ?
      )`
  const binds: unknown[] = opts.force ? [GAME] : [GAME, FILL_FRESHNESS_CLASS]

  const { results } = await env.DB.prepare(`
    SELECT s.scrydex_expansion_id, MAX(s.release_date) AS newest
    FROM   sets s
    JOIN   canonical_games g ON g.id = s.game_id
    WHERE  g.name = ?
      AND  s.scrydex_expansion_id IS NOT NULL AND TRIM(s.scrydex_expansion_id) <> ''
      ${freshnessClause}
    GROUP BY s.scrydex_expansion_id
    ORDER BY newest DESC, s.scrydex_expansion_id
  `).bind(...binds).all<ExpansionRow>()
  return results ?? []
}

/** The tcgplayer marketplace product id on one variant, or null (rung R1). */
export function tcgplayerProductIdOf(variant: unknown): number | null {
  const marketplaces = (variant as any)?.marketplaces
  if (!Array.isArray(marketplaces)) return null
  const tcg = marketplaces.find((m: any) => m?.name === 'tcgplayer')
  const n = tcg?.product_id == null ? NaN : parseInt(String(tcg.product_id), 10)
  return Number.isFinite(n) ? n : null
}

/**
 * The rows to store for one card. Tier-resilient by construction: a card missing `mana_cost` (a
 * land) still persists its `mana_value`, and a card missing everything yields `[]` — the caller
 * then skips it rather than clearing rows it never wrote.
 */
export function attributesForCard(card: unknown): ProductAttribute[] {
  const c = card as Record<string, unknown> | null
  if (!c || typeof c !== 'object') return []
  const fields: Record<string, unknown> = {}
  for (const field of FILL_FIELDS) fields[field] = c[field]
  return buildExternalAttributes(FILL_SOURCE, fields)
}

/**
 * Fill one bounded batch of expansions. Synchronous + resumable: each completed expansion is marked
 * in `scrydex_expansion_freshness`, so a killed invocation loses at most the expansion in flight and
 * a re-trigger picks up exactly where it stopped. Returns counts; never throws on a Scrydex refusal.
 */
export async function runMtgAttributeFill(env: Env, opts: FillOptions = {}): Promise<FillResult> {
  const result: FillResult = {
    ok: true, expansionsProcessed: 0, expansionsRemaining: 0, hasMore: false,
    cardsFetched: 0, productsWritten: 0, attributeRowsWritten: 0, cardsUnmatched: 0, requests: 0,
  }

  const pending = await pendingExpansions(env, opts)
  const limit   = Math.max(1, opts.maxExpansions ?? DEFAULT_MAX_EXPANSIONS)
  const todo    = pending.slice(0, limit)
  result.expansionsRemaining = pending.length

  for (const { scrydex_expansion_id: expansionId } of todo) {
    try {
      // Prices are NOT requested: this job wants card data only, and `include=prices` would bloat
      // every page for nothing. Price refresh remains the drain's job.
      const { cards, requests } = await fetchAllExpansionCards(env, GAME_SLUG, expansionId, 'mtgAttributeFill')
      result.requests     += requests
      result.cardsFetched += cards.length

      // ── Resolve every card to canonical products, in chunked reads (never per-card queries) ──
      const tcgIds  = [...new Set(cards.flatMap(c =>
        (Array.isArray(c?.variants) ? c.variants : [])
          .map(tcgplayerProductIdOf)
          .filter((n: number | null): n is number => n !== null)))]
      const numbers = [...new Set(cards.map(c => c?.number).filter(Boolean).map(n => String(n).toLowerCase()))]

      // R1: tcgplayer product id → products.id. Globally unique, so no game scoping needed.
      const productIdByTcgId = new Map<number, number>()
      for (const ids of chunk(tcgIds, IN_CHUNK)) {
        const { results } = await env.DB.prepare(
          `SELECT id, tcgplayer_product_id FROM products
            WHERE tcgplayer_product_id IN (${ids.map(() => '?').join(',')})`
        ).bind(...ids).all<{ id: number; tcgplayer_product_id: number }>()
        for (const r of results ?? []) productIdByTcgId.set(r.tcgplayer_product_id, r.id)
      }

      // R3: number within THIS expansion. One number can legitimately map to SEVERAL products (the
      // same card in different treatments/finishes) — cost and colour are identical across them, so
      // every match is written. That is safe for ATTRIBUTES in a way it would not be for prices.
      const productIdsByNumber = new Map<string, number[]>()
      for (const ns of chunk(numbers, IN_CHUNK - 1) as string[][]) {
        const { results } = await env.DB.prepare(`
          SELECT p.id, LOWER(p.number) AS number
          FROM   products p
          JOIN   sets s ON s.id = p.set_id
          WHERE  LOWER(s.scrydex_expansion_id) = LOWER(?)
            AND  LOWER(p.number) IN (${ns.map(() => '?').join(',')})
        `).bind(expansionId, ...ns).all<{ id: number; number: string }>()
        for (const r of results ?? []) {
          const list = productIdsByNumber.get(r.number) ?? []
          list.push(r.id)
          productIdsByNumber.set(r.number, list)
        }
      }

      // ── Build the write groups ────────────────────────────────────────────────────
      const groups: D1PreparedStatement[][] = []
      const unmatchedStmts: D1PreparedStatement[] = []
      const writtenProductIds = new Set<number>()

      for (const card of cards) {
        const attrs = attributesForCard(card)

        const productIds = new Set<number>()
        for (const variant of (Array.isArray(card?.variants) ? card.variants : [])) {
          const tcgId = tcgplayerProductIdOf(variant)
          const pid = tcgId === null ? undefined : productIdByTcgId.get(tcgId)
          if (pid !== undefined) productIds.add(pid)
        }
        if (productIds.size === 0 && card?.number != null) {
          for (const pid of productIdsByNumber.get(String(card.number).toLowerCase()) ?? []) {
            productIds.add(pid)
          }
        }

        if (productIds.size === 0) {
          // A recorded catalogue gap, never a forced match (the ING-3 doctrine). Reuses the drain's
          // ONE upsert so the admin's unmatched feed stays a single surface.
          result.cardsUnmatched++
          unmatchedStmts.push(env.DB.prepare(UNMATCHED_UPSERT_SQL).bind(
            card?.id != null ? String(card.id) : null,
            card?.name != null ? String(card.name) : null,
            card?.number != null ? String(card.number) : null,
            GAME_SLUG, expansionId, null, 'attributes',
          ))
          continue
        }

        // Nothing to store (a card carrying none of the four fields): leave whatever is there
        // alone rather than emitting a bare DELETE that would clear a previous good fill.
        if (attrs.length === 0) continue

        for (const productId of productIds) {
          groups.push(externalAttributeStatements(env.DB, productId, FILL_SOURCE, attrs))
          writtenProductIds.add(productId)
          result.attributeRowsWritten += attrs.length
        }
      }

      // ── Write: batched, and a product's group is NEVER split across two batches ───
      let batch: D1PreparedStatement[] = []
      for (const group of groups) {
        if (batch.length > 0 && batch.length + group.length > BATCH_SIZE) {
          await env.DB.batch(batch)
          batch = []
        }
        batch.push(...group)
      }
      if (batch.length > 0) await env.DB.batch(batch)

      for (const stmts of chunk(unmatchedStmts, BATCH_SIZE)) await env.DB.batch(stmts)

      // Marked only after every write for this expansion committed, so a crash re-does it.
      await markExpansionFresh(env.DB, expansionId, FILL_FRESHNESS_CLASS)
      result.expansionsProcessed++
      result.productsWritten += writtenProductIds.size
      console.log(JSON.stringify({
        log: 'mtg_attribute_fill_expansion', expansionId,
        cards: cards.length, products: writtenProductIds.size, unmatched: result.cardsUnmatched, requests,
      }))
    } catch (err) {
      // A refusal or guard trip stops the RUN — every remaining expansion would fail identically.
      // The in-flight expansion is left unmarked, so the next trigger redoes it.
      if (err instanceof ScrydexCreditLimitError) {
        result.stoppedReason = 'credit_guard'
      } else if (err instanceof ScrydexCardsError && isScrydexRefusal(err.status)) {
        result.stoppedReason = err.status === 402 ? 'scrydex_402' : 'scrydex_403'
      } else {
        result.stoppedReason = 'error'
        result.error = (err as Error).message
      }
      result.ok = false
      break
    }
  }

  result.expansionsRemaining = Math.max(0, result.expansionsRemaining - result.expansionsProcessed)
  result.hasMore = result.ok && result.expansionsRemaining > 0
  console.log(JSON.stringify({ log: 'mtg_attribute_fill', ...result }))
  return result
}
