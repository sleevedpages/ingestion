/**
 * Scrydex Webhook Processor
 *
 * Runs ONCE DAILY via cron (`0 4 * * *` — moved off the old 10-minute drain for cost control, 2026-06)
 * — drains pending scrydex_webhook_log rows and fetches updated prices from the Scrydex
 * API, writing them to the CANONICAL `prices` table (source='scrydex'). (Session D:
 * repointed off the old scrydex_prices table.)
 *
 * Credit-control measures:
 *
 *   0. DAILY BATCH + DEDUP-BY-EXPANSION (2026-06, the primary cost lever)
 *      Over 24h, scrydex_webhook_log accumulates many pending rows — often dozens for
 *      one volatile Pokémon expansion. The daily drain collapses them to **one fetch per
 *      distinct (gameSlug, priceType, expansion)**, then marks ALL rows referencing that
 *      expansion complete. This attacks the measured cost concentration directly:
 *      Pokémon was 3,426 /cards calls (~80% of usage), driven by volatility × the old
 *      10-min re-fetch frequency — NOT set count. (SCRYDEX_PRICE_GAMES scoping is the
 *      WRONG lever — the only game with savings is Pokémon, which must never be throttled.)
 *
 *   ⚠️ FRESHNESS↔DRAIN COUPLING (correctness invariant): the freshness window
 *      (SCRYDEX_PRICE_FRESHNESS_HOURS, default 20h) MUST stay < the 24h drain interval
 *      (DRAIN_INTERVAL_HOURS). If it ever reaches ≥24h, every daily run no-ops against its
 *      own prior run and prices silently freeze. `freshnessSafeForDrain()` guards/warns.
 *
 *   1. FRESHNESS WINDOW (SCRYDEX_PRICE_FRESHNESS_HOURS, default 20h)
 *      Before fetching an expansion, checks the dedicated `scrydex_expansion_freshness`
 *      side table (migration 0063) for a recent successful upsert of that expansion+
 *      priceType. If fresh, it's skipped without an API call. This also provides
 *      RESUMABILITY: a waitUntil-cut-off run leaves fetched expansions marked fresh, so a
 *      re-trigger (`POST /scrydex/process`) fetches only what's left.
 *
 *   2. GAME FILTER (SCRYDEX_PRICE_GAMES env var, optional — deliberately NOT applied)
 *      Comma-separated slug allowlist. Left available + documented but UNSET in prod: it
 *      would only save credits by throttling Pokémon (the high-volatility primary game),
 *      which is unacceptable. The daily batch is the lever instead.
 *
 *   3. 403 / CREDIT_CAP_HIT circuit breaker (Session D)
 *      A hard fetch failure marks the row status='error' (visible/retryable) instead of
 *      silent 'complete'; a 403 additionally breaks the run so the batch stops burning
 *      calls on guaranteed-403 expansions.
 *
 * Price matching strategy (in priority order):
 *   1. variant.marketplaces[tcgplayer].product_id → products.tcgplayer_product_id (canonical)
 *   2. Fallback: card.number + expansion scrydex_expansion_id join
 *      (products JOIN sets ON products.set_id = sets.id — canonical `products`
 *       carries set_id, so the join is product→its own set; the 17 non-unique
 *       scrydex_expansion_id dupes resolve naturally, ORDER BY id for determinism)
 *
 * Variant handling:
 *   One Piece + Gundam: each variant has a unique TCGPlayer product_id + own images
 *   All others (Pokemon, MTG, Lorcana, Riftbound): variants share a product_id
 *
 * Canonical price field mapping (mirrors migration 0060):
 *   condition ← tier ('NM'|'LP'|'MP'|'HP'|'DM') for raw; NULL for graded
 *   finish    ← variant.name ('foil'|'altArt'|...) or 'normal'
 *   grade     ← the price condition string for graded rows; NULL otherwise
 *   value     ← price.market
 *   trend_*   ← price.trends.days_{1,7,14,30,90}.percent_change
 */

import type { Env } from './worker.js'
import { ScrydexCreditLimitError } from './lib/scrydexClient.js'
import { fetchAllExpansionCards, ScrydexCardsError } from './lib/scrydexCards.js'

const SLUG_TO_GAME: Record<string, string> = {
  pokemon:           'Pokemon',
  magicthegathering: 'Magic',
  onepiece:          'One Piece Card Game',
  gundam:            'Gundam Card Game',
  lorcana:           'Lorcana',
  riftbound:         'Riftbound',
}

const BATCH_SIZE          = 100
// Daily batch: a full day's backlog is larger than a 10-min one. Cap rows loaded per run
// (deduped to far fewer fetches); leftover rows stay pending for the next run / a manual
// /scrydex/process. The fetch count (not row count) is what's bounded by MAX_FETCHES below.
const PENDING_ROW_LIMIT   = 5000
const DEFAULT_MAX_FETCHES = 1500  // Scrydex page-calls per invocation (waitUntil safety valve)

// ── Freshness↔drain coupling invariant ───────────────────────────────────────
// The daily drain re-fetches an expansion only if it's OUTSIDE the freshness window.
// freshness (20h) < drain interval (24h) ⇒ each daily run is past the prior run's window
// ⇒ prices advance daily. If freshness ≥ 24h, daily runs no-op forever (silent freeze).
export const DRAIN_INTERVAL_HOURS   = 24
export const DEFAULT_FRESHNESS_HOURS = 20
/** True when the freshness window is short enough that the daily drain won't no-op. */
export function freshnessSafeForDrain(freshnessHours: number, drainHours = DRAIN_INTERVAL_HOURS): boolean {
  return freshnessHours < drainHours
}

/** Thrown by fetchExpansionCards on a non-OK Scrydex response. Carries the HTTP
 *  status so the processor can distinguish a 403 CREDIT_CAP_HIT (circuit breaker)
 *  from a transient error. */
export class ScrydexFetchError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ScrydexFetchError'
    this.status = status
  }
}

// ─── Pure helpers (exported for unit testing) ────────────────────────────────

export interface CanonicalPriceFields {
  condition: string | null
  finish:    string
  grade:     string | null
}

/**
 * Maps a Scrydex variant price to canonical (condition, finish, grade), matching
 * the values migration 0060 produced from the old scrydex_prices.condition string.
 *
 *   raw    → condition = the tier (price.condition, e.g. 'NM'); grade = NULL
 *   graded → condition = NULL; grade = the price condition string (e.g. 'PSA 10')
 *   finish → variant.name when it is not 'normal' (e.g. 'foil','altArt'); else 'normal'
 */
export function deriveCanonicalPriceFields(
  priceCondition: string | null | undefined,
  variantName:    string | null | undefined,
  priceType:      string,
): CanonicalPriceFields {
  const finish = variantName && variantName !== 'normal' ? variantName : 'normal'
  if (priceType === 'graded') {
    return { condition: null, finish, grade: priceCondition ?? null }
  }
  return { condition: priceCondition ?? null, finish, grade: null }
}

export interface CanonicalTrends {
  trend_1d:  number | null
  trend_7d:  number | null
  trend_14d: number | null
  trend_30d: number | null
  trend_90d: number | null
}

/** Extracts canonical trend_* columns from a Scrydex price.trends object
 *  ({ days_1: { percent_change }, days_7: {...}, ... }). Tolerant of nulls. */
export function extractTrends(trends: unknown): CanonicalTrends {
  const t = (trends ?? {}) as Record<string, { percent_change?: number } | undefined>
  const pc = (k: string): number | null => {
    const v = t[k]?.percent_change
    return typeof v === 'number' ? v : null
  }
  return {
    trend_1d:  pc('days_1'),
    trend_7d:  pc('days_7'),
    trend_14d: pc('days_14'),
    trend_30d: pc('days_30'),
    trend_90d: pc('days_90'),
  }
}

// ─── Freshness check (canonical side table) ──────────────────────────────────

/**
 * Returns true when scrydex_expansion_freshness has a row for this
 * expansion + priceType written within maxAgeSeconds. (Session D: reads the
 * dedicated side table instead of the dropped scrydex_prices columns.)
 */
export async function isExpansionFresh(
  db:            D1Database,
  expansionId:   string,
  priceType:     string,
  maxAgeSeconds: number,
): Promise<boolean> {
  const row = await db.prepare(`
    SELECT 1 FROM scrydex_expansion_freshness
    WHERE  scrydex_expansion_id = ?
    AND    price_type           = ?
    AND    last_updated         > unixepoch() - ?
    LIMIT 1
  `).bind(expansionId, priceType, maxAgeSeconds).first<{ 1: number }>()
  return row !== null
}

/** Records a successful expansion upsert in the freshness side table. */
export async function markExpansionFresh(
  db:          D1Database,
  expansionId: string,
  priceType:   string,
): Promise<void> {
  await db.prepare(`
    INSERT INTO scrydex_expansion_freshness (scrydex_expansion_id, price_type, last_updated)
    VALUES (?, ?, unixepoch())
    ON CONFLICT (scrydex_expansion_id, price_type)
    DO UPDATE SET last_updated = excluded.last_updated
  `).bind(expansionId, priceType).run()
}

// ─── Main processor ───────────────────────────────────────────────────────────

// Per-row drain state. A row is complete only when ALL its (deduped) expansion
// work-items resolve ok/fresh; any error marks it error; circuit-break/cap leaves any
// unprocessed row pending for the next run.
interface RowState {
  id:        unknown
  remaining: Set<string>   // expansion keys not yet resolved
  errored:   boolean
  done:      boolean       // already written to the log (complete or error)
  prices:    number        // metrics attributed to this row (owner of its work-items)
  credits:   number
}

export async function processPendingWebhooks(env: Env): Promise<void> {
  // ── Config ──────────────────────────────────────────────────────────────────
  const freshnessHours = env.SCRYDEX_PRICE_FRESHNESS_HOURS
    ? parseInt(env.SCRYDEX_PRICE_FRESHNESS_HOURS, 10)
    : DEFAULT_FRESHNESS_HOURS
  const freshnessSeconds = freshnessHours * 3600
  const maxFetches = env.SCRYDEX_DRAIN_MAX_FETCHES
    ? parseInt(env.SCRYDEX_DRAIN_MAX_FETCHES, 10)
    : DEFAULT_MAX_FETCHES

  // INVARIANT: freshness must stay < the daily drain interval or prices silently freeze.
  if (!freshnessSafeForDrain(freshnessHours)) {
    console.error(
      `[ScrydexProcessor] ⚠️ SCRYDEX_PRICE_FRESHNESS_HOURS=${freshnessHours} ≥ ${DRAIN_INTERVAL_HOURS}h drain interval — ` +
      `every daily run will no-op against its own prior run and prices will FREEZE. Lower it below 24h.`
    )
  }

  // Game filter — deliberately UNSET in prod (scoping only throttles Pokémon, the wrong
  // lever). Kept available for an operator to exclude a game in an emergency.
  const gameFilter: Set<string> | null = env.SCRYDEX_PRICE_GAMES
    ? new Set(env.SCRYDEX_PRICE_GAMES.split(',').map(s => s.trim()).filter(Boolean))
    : null

  // ── Load the day's pending backlog ────────────────────────────────────────────
  const pending = await env.DB.prepare(`
    SELECT id, event_name, expansion_ids_json
    FROM   scrydex_webhook_log
    WHERE  status = 'pending'
    ORDER BY received_at ASC
    LIMIT ${PENDING_ROW_LIMIT}
  `).all()

  if (!pending.results.length) return

  // ── Parse rows → build the DEDUPED work-item set (one per distinct expansion) ──
  const rowState = new Map<unknown, RowState>()
  const rowsByKey = new Map<string, unknown[]>()           // expansion key → row ids
  const workItems = new Map<string, { gameSlug: string; priceType: string; expansionId: string; ownerRowId: unknown }>()
  const markComplete = async (id: unknown, prices: number, credits: number) =>
    env.DB.prepare(`UPDATE scrydex_webhook_log SET status='complete', prices_upserted=?, credits_used=?, completed_at=unixepoch() WHERE id=?`)
      .bind(prices, credits, id).run()
  const markError = async (id: unknown, prices: number, credits: number, msg: string) =>
    env.DB.prepare(`UPDATE scrydex_webhook_log SET status='error', prices_upserted=?, credits_used=?, error_message=?, completed_at=unixepoch() WHERE id=?`)
      .bind(prices, credits, msg, id).run()

  for (const row of pending.results) {
    const id = (row as any).id
    let expansionIds: string[]
    try {
      expansionIds = JSON.parse((row as any).expansion_ids_json as string)
    } catch (err) {
      await markError(id, 0, 0, `bad expansion_ids_json: ${(err as Error).message}`)
      continue
    }
    const eventName = (row as any).event_name as string
    const gameSlug  = eventName.split('.')[0]
    const priceType = eventName.includes('graded') ? 'graded' : 'raw'

    // Game filter → immediately complete (no work).
    if (gameFilter && !gameFilter.has(gameSlug)) {
      await markComplete(id, 0, 0)
      continue
    }

    const keys = expansionIds.map(e => `${gameSlug}|${priceType}|${e}`)
    const st: RowState = { id, remaining: new Set(keys), errored: false, done: false, prices: 0, credits: 0 }
    rowState.set(id, st)
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      if (!workItems.has(key)) {
        workItems.set(key, { gameSlug, priceType, expansionId: expansionIds[i], ownerRowId: id })
      }
      const arr = rowsByKey.get(key) ?? []
      arr.push(id)
      rowsByKey.set(key, arr)
    }
    // A row with zero expansions is trivially complete.
    if (keys.length === 0) { st.done = true; await markComplete(id, 0, 0) }
  }

  const gameFilterLabel = gameFilter ? [...gameFilter].join(',') : 'none'
  console.log(
    `[ScrydexProcessor] daily drain - ${pending.results.length} pending rows -> ` +
    `${workItems.size} distinct expansions (freshness=${freshnessHours}h, maxFetches=${maxFetches}, ` +
    `gameFilter=${gameFilterLabel})`
  )

  // Resolve one expansion key for all its rows: drop it from each row's `remaining`,
  // attribute metrics to the owner row, and complete any row whose set is now empty.
  const satisfyKey = async (key: string, prices: number, credits: number) => {
    const wi = workItems.get(key)!
    const owner = rowState.get(wi.ownerRowId)
    if (owner) { owner.prices += prices; owner.credits += credits }
    for (const id of rowsByKey.get(key) ?? []) {
      const st = rowState.get(id)
      if (!st || st.done) continue
      st.remaining.delete(key)
      if (!st.errored && st.remaining.size === 0) {
        st.done = true
        await markComplete(id, st.prices, st.credits)
      }
    }
  }
  // Fail one expansion key: mark every referencing row error (once).
  const failKey = async (key: string, msg: string) => {
    for (const id of rowsByKey.get(key) ?? []) {
      const st = rowState.get(id)
      if (!st || st.done) continue
      st.remaining.delete(key)
      st.errored = true
      st.done = true
      await markError(id, st.prices, st.credits, msg)
    }
  }

  // ── Process distinct expansions (one fetch each) ──────────────────────────────
  let totalFetches = 0            // Scrydex page-calls (= credits) made this run
  let skippedFresh = 0            // expansions inside the freshness window (no API call)
  let expansionsFetched = 0       // distinct expansions we actually fetched live
  let circuitBroken = false
  // Per-game credit velocity (page-calls) — confirms which game dominates a run.
  const creditsByGame: Record<string, number> = {}

  for (const [key, wi] of workItems) {
    if (circuitBroken) break
    if (totalFetches >= maxFetches) {
      console.warn(`[ScrydexProcessor] maxFetches=${maxFetches} reached — leaving remaining expansions pending for the next run`)
      break
    }

    if (await isExpansionFresh(env.DB, wi.expansionId, wi.priceType, freshnessSeconds)) {
      skippedFresh++
      await satisfyKey(key, 0, 0)
      continue
    }

    try {
      const { cards, requests } = await fetchExpansionCards(env, wi.gameSlug, wi.expansionId, true)
      totalFetches += requests
      expansionsFetched++
      creditsByGame[wi.gameSlug] = (creditsByGame[wi.gameSlug] ?? 0) + requests

      const allUpserts: D1PreparedStatement[] = []
      for (const card of cards) {
        allUpserts.push(...await buildPriceUpserts(env.DB, card, wi.expansionId, wi.priceType))
      }
      for (let i = 0; i < allUpserts.length; i += BATCH_SIZE) {
        await env.DB.batch(allUpserts.slice(i, i + BATCH_SIZE))
      }
      await markExpansionFresh(env.DB, wi.expansionId, wi.priceType)
      await satisfyKey(key, allUpserts.length, requests)

      await new Promise(r => setTimeout(r, 100))
    } catch (err) {
      const msg = (err as Error).message
      if (err instanceof ScrydexCreditLimitError) {
        console.warn('[ScrydexProcessor] Credit limit guard triggered — stopping run')
        circuitBroken = true
        await failKey(key, msg)
        break
      }
      if (err instanceof ScrydexFetchError && err.status === 403) {
        console.error(`[ScrydexProcessor] 403 (CREDIT_CAP_HIT) on ${wi.gameSlug}/${wi.expansionId} — circuit breaker, stopping run`)
        circuitBroken = true
        await failKey(key, msg)
        break
      }
      // Transient/other error on a single expansion: mark its rows error, keep going.
      console.error(`[ScrydexProcessor] Expansion ${wi.gameSlug}/${wi.expansionId}:`, err)
      await failKey(key, msg)
    }
  }

  const leftoverRows = [...rowState.values()].filter(s => !s.done).length
  console.log(
    `[ScrydexProcessor] daily drain complete — ${totalFetches} fetches, ${skippedFresh} fresh-skipped, ` +
    `${leftoverRows} rows left pending` + (circuitBroken ? ' (circuit-broken)' : '')
  )

  // Structured audit line (Part B, §4 #8) — one machine-parseable JSON record per run so
  // credit consumption is measurable from `wrangler tail` / Logpush without scraping prose.
  // `rows_in` vs `distinct_expansions` quantifies the dedup collapse; `fetches_made`
  // (page-calls = credits) vs `fetches_skipped_fresh` shows the freshness savings;
  // `credits_by_game` confirms the measured Pokémon concentration.
  console.log(JSON.stringify({
    log:                   'scrydex_drain_audit',
    rows_in:               pending.results.length,
    distinct_expansions:   workItems.size,
    expansions_fetched:    expansionsFetched,
    fetches_made:          totalFetches,
    fetches_skipped_fresh: skippedFresh,
    rows_completed:        pending.results.length - leftoverRows,
    rows_left_pending:     leftoverRows,
    circuit_broken:        circuitBroken,
    max_fetches:           maxFetches,
    freshness_hours:       freshnessHours,
    credits_by_game:       creditsByGame,
  }))
}

// ─── Scrydex API ──────────────────────────────────────────────────────────────

async function fetchExpansionCards(
  env:           Env,
  gameSlug:      string,
  expansionId:   string,
  includePrices: boolean,
): Promise<{ cards: unknown[]; requests: number }> {
  // Correct, paginated /cards fetch (q=expansion.id:<id> + page/pageSize). Re-throw the
  // shared helper's ScrydexCardsError as ScrydexFetchError to preserve this file's
  // existing 403/429 circuit-breaker control flow. `requests` = real Scrydex page-calls
  // (credits), used to bound the daily drain (maxFetches).
  try {
    return await fetchAllExpansionCards(env, gameSlug, expansionId, 'processPendingWebhooks', includePrices)
  } catch (err) {
    if (err instanceof ScrydexCardsError) {
      throw new ScrydexFetchError(err.status, err.message)
    }
    throw err
  }
}

// ─── Vendor on-demand single-card refresh ────────────────────────────────────

const GAME_NAME_TO_SLUG: Record<string, string> = Object.fromEntries(
  Object.entries(SLUG_TO_GAME).map(([slug, name]) => [name, slug])
)

export interface RefreshResult {
  ok:              boolean
  error?:          string
  pricesUpserted?: number
  requests?:       number
}

/**
 * Vendor on-demand price refresh (the daily-batch freshness release valve). Resolves a
 * canonical product to its Scrydex expansion + game, fetches that expansion live (q-syntax,
 * credit-guarded), and upserts raw + graded prices for **only the target card** (matched by
 * its tcgplayer_product_id, then card number). Called from `POST /scrydex/refresh-card`;
 * the Content app gates it (vendor access + ownership + 1/hour rate limit) before proxying.
 *
 * NOTE: scoped to ONE card on purpose — upserting the whole expansion (every card × variant ×
 * raw/graded) is ~1000 sequential D1 reads and took ~2min synchronously while the vendor waited.
 * It also does NOT mark the expansion fresh: that would suppress the daily full-expansion refresh
 * for every OTHER card in the set.
 */
export async function refreshCardPrices(env: Env, productId: number): Promise<RefreshResult> {
  const product = await env.DB.prepare(`
    SELECT p.id, p.tcgplayer_product_id, p.number,
           s.scrydex_expansion_id AS expansion_id, g.name AS game
    FROM   products        p
    JOIN   sets            s ON s.id = p.set_id
    JOIN   canonical_games g ON g.id = s.game_id
    WHERE  p.id = ?
    LIMIT  1
  `).bind(productId).first<{ id: number; tcgplayer_product_id: number | null; number: string | null; expansion_id: string | null; game: string }>()

  if (!product)              return { ok: false, error: 'product not found' }
  if (!product.expansion_id) return { ok: false, error: 'no Scrydex expansion mapping for this product' }
  const gameSlug = GAME_NAME_TO_SLUG[product.game]
  if (!gameSlug)             return { ok: false, error: `unsupported game: ${product.game}` }
  const expansionId = product.expansion_id   // captured (narrowed) before awaits
  const targetPid   = product.tcgplayer_product_id
  const targetNum   = product.number ? String(product.number).toLowerCase() : null

  try {
    const { cards, requests } = await fetchExpansionCards(env, gameSlug, expansionId, true) as { cards: any[]; requests: number }

    // Find ONLY the target card: by a variant's tcgplayer marketplace product_id, else number.
    const targetCard = cards.find(c =>
      (targetPid != null && (c.variants ?? []).some((v: any) =>
        (v.marketplaces ?? []).some((m: any) => m?.name === 'tcgplayer' && parseInt(String(m.product_id), 10) === targetPid))) ||
      (targetNum != null && String(c.number ?? '').toLowerCase() === targetNum)
    )
    if (!targetCard) return { ok: true, pricesUpserted: 0, requests }   // card not present / not priced

    let pricesUpserted = 0
    for (const priceType of ['raw', 'graded']) {
      const upserts = await buildPriceUpserts(env.DB, targetCard, expansionId, priceType)
      for (let i = 0; i < upserts.length; i += BATCH_SIZE) {
        await env.DB.batch(upserts.slice(i, i + BATCH_SIZE))
      }
      pricesUpserted += upserts.length
    }
    return { ok: true, pricesUpserted, requests }
  } catch (err) {
    if (err instanceof ScrydexCreditLimitError) return { ok: false, error: 'Scrydex credit guard triggered' }
    if (err instanceof ScrydexFetchError)       return { ok: false, error: `Scrydex ${err.status}` }
    return { ok: false, error: (err as Error).message }
  }
}

// ─── Price upsert building ────────────────────────────────────────────────────

const SCRYDEX_PRICE_SQL = `
  INSERT INTO prices
    (product_id, source, condition, finish, grade, value,
     trend_1d, trend_7d, trend_14d, trend_30d, trend_90d, fetched_at)
  VALUES (?, 'scrydex', ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
  ON CONFLICT (product_id, source, COALESCE(condition,''), COALESCE(finish,''), COALESCE(grade,''),
               COALESCE(variant,''), COALESCE(company,''), is_signed, is_error, is_perfect)
  DO UPDATE SET
    value      = excluded.value,
    trend_1d   = excluded.trend_1d,
    trend_7d   = excluded.trend_7d,
    trend_14d  = excluded.trend_14d,
    trend_30d  = excluded.trend_30d,
    trend_90d  = excluded.trend_90d,
    fetched_at = excluded.fetched_at`

export async function buildPriceUpserts(
  db:          D1Database,
  card:        unknown,
  expansionId: string,
  priceType:   string,
): Promise<D1PreparedStatement[]> {
  const c = card as any
  const upserts: D1PreparedStatement[] = []
  const variants: any[] = c.variants ?? []

  for (const variant of variants) {
    // Primary match (R1): canonical products.id by TCGPlayer product_id.
    const tcgMarket    = (variant.marketplaces ?? []).find((m: any) => m.name === 'tcgplayer')
    const tcgProductId = tcgMarket?.product_id ? parseInt(tcgMarket.product_id, 10) : null

    let product: { id: number } | null = null

    if (tcgProductId) {
      product = await db.prepare(
        'SELECT id FROM products WHERE tcgplayer_product_id = ? LIMIT 1'
      ).bind(tcgProductId).first() as { id: number } | null
    }

    // Fallback (R2): card number + expansion scrydex_expansion_id.
    // Canonical products carries set_id, so we join product→its own set; the 17
    // non-unique scrydex_expansion_id dupes (RC/sub-sets share a parent) resolve
    // naturally because a product belongs to exactly one set. ORDER BY p.id makes
    // the pick deterministic if a number somehow matches in more than one set.
    if (!product) {
      product = await db.prepare(`
        SELECT p.id
        FROM   products p
        JOIN   sets s ON p.set_id = s.id
        WHERE  LOWER(p.number) = LOWER(?)
        AND    LOWER(s.scrydex_expansion_id) = LOWER(?)
        ORDER BY p.id
        LIMIT 1
      `).bind(c.number ?? '', expansionId).first() as { id: number } | null
    }

    if (!product) continue

    const variantName: string  = variant.name ?? 'normal'
    const variantPrices: any[] = variant.prices ?? []

    for (const price of variantPrices) {
      if (price.type !== priceType) continue

      const { condition, finish, grade } = deriveCanonicalPriceFields(
        price.condition, variantName, priceType
      )
      const trends = extractTrends(price.trends)

      upserts.push(
        db.prepare(SCRYDEX_PRICE_SQL).bind(
          product.id,
          condition,
          finish,
          grade,
          price.market ?? null,
          trends.trend_1d,
          trends.trend_7d,
          trends.trend_14d,
          trends.trend_30d,
          trends.trend_90d,
        )
      )
    }
  }

  return upserts
}
