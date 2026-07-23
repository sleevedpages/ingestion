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
 *   4. RETRY SEMANTICS + ATOMIC ROW CLAIMS (WP-8, 2026-07-07)
 *      Row lifecycle: pending → processing (claimed) → complete | error | failed.
 *      - CLAIM: every candidate row is claimed with an atomic conditional UPDATE
 *        (status flips to 'processing', last_attempt_at stamped; the WHERE re-checks the
 *        observed state so exactly ONE run wins — meta.changes===1). Overlapping runs
 *        (cron + manual /scrydex/process + admin trigger) can never double-drain a row.
 *      - RECLAIM: a row stuck in 'processing' past PROCESSING_STALE_SECONDS (a run died
 *        mid-claim — waitUntil cutoff, crash) becomes a candidate again; the reclaim
 *        UPDATE re-checks staleness so two overlapping runs can't both take it.
 *      - ERROR RETRY: 'error' rows are retried with exponential backoff
 *        (ERROR_RETRY_BASE_SECONDS << attempts) while attempts < MAX_DRAIN_ATTEMPTS.
 *        A row-specific failure increments attempts; at the cap the row goes TERMINAL
 *        ('failed', never selected again) so a poison row can never loop forever.
 *        Malformed expansion_ids_json is deterministic poison → straight to 'failed'.
 *      - GUARD/403 failures do NOT burn an attempt (environmental, not poison): the row
 *        is marked 'error' (visible, the June-outage invariant) with attempts unchanged,
 *        and the run circuit-breaks — the credit guard remains the hard backstop that
 *        stops ALL retry spend (it throws BEFORE any API call is made).
 *      - RELEASE: rows claimed but not reached (maxFetches / circuit break) are released
 *        back to 'pending' at run end; a killed run's claims heal via the stale reclaim.
 *      - IDEMPOTENCY: re-processing a row is safe by construction — price writes are
 *        ON CONFLICT upserts on the superset identity key, and the freshness window
 *        makes a re-drain of an already-fetched expansion cost ZERO credits (<20h).
 *      - UNKNOWN CARDS (ING-3): webhook cards with no catalogue match are no longer
 *        dropped silently — recorded to scrydex_unmatched_cards (deduped per
 *        expansion+number+variant, first/last-seen + counter; migration 0089).
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
 * Canonical price field mapping (POSITIVE write-time classification, 2026-07-14):
 *   condition ← tier ('NM'|'LP'|'MP'|'HP'|'DM') for raw; NULL for graded
 *   finish    ← variant.name ('foil'|'altArt'|...) or 'normal'
 *   grade     ← `${company} ${grade}` built from the graded payload fields (the live shape is
 *               { type:'graded', company, grade } — there is NO combined condition string;
 *               price.condition is only a legacy fallback); NULL for raw
 *   company   ← normaliseCompany(price.company); is_signed/is_error/is_perfect ← payload flags
 *   is_graded ← 1 when price.type === 'graded', else 0 — graded-ness is an EXPLICIT STORED
 *               attribute from Scrydex's own data shape, NEVER inferred at read time. A graded
 *               row that resolves NO label is SKIPPED, never written as raw. (The pre-fix
 *               writer derived grade from price.condition, so EVERY drained graded price
 *               landed as condition=NULL/grade=NULL — an anonymous "untiered market" row that
 *               leaked slab prices into the ungraded chain: the ARS 10 leak, Content mig 0099.)
 *   value     ← price.market
 *   trend_*   ← price.trends.days_{1,7,14,30,90}.percent_change
 */

import type { Env } from './worker.js'
import { ScrydexCreditLimitError } from './lib/scrydexClient.js'
import { normaliseCompany } from './scrydexEnrich.js'
import { fetchAllExpansionCards, ScrydexCardsError } from './lib/scrydexCards.js'
// WP-3 (audit IMG-5): shared canonical-name → slug map. The local SLUG_TO_GAME here once
// keyed 'Lorcana'/'Riftbound' → the vendor single-card refresh (refreshCardPrices) could
// never resolve a slug for those two games. 'Pokemon Japan' is deliberately absent so a JP
// card never collides onto the English 'pokemon' slug. See lib/gameNames.ts (the drift anchor).
import { GAME_SLUG_BY_CANONICAL_NAME } from './lib/gameNames.js'

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

// ── Card-watch priority lane (Card Watch feature, Session 1) ──────────────────
// A second, intraday drain scope that refreshes ONLY the Scrydex expansions containing at least
// one WATCHED card (Content `card_watches`, mig 0116), leaving everything else to the daily 04:00
// drain. It shares the ENTIRE processPendingWebhooks machinery (dedup, the WP-8 claim/retry state
// machine, the credit guard/403 circuit break, incremental waitUntil completion) — the ONLY
// differences are: (a) the candidate/work set is filtered to watched expansions, and (b) it uses
// its OWN, shorter freshness window so an intraday run isn't no-op'd by the daily 20h bookkeeping.
//
// CRON CADENCE (Part-0 decision): the prod lane runs 3×/day at `0 10,16,22 * * *` — see
// wrangler.toml. Min gap between runs = 6h (10→16, 16→22; the 22→10 gap is 12h).
export const WATCH_LANE_INTERVAL_HOURS = 6
// Watch freshness default (hours). SHORTER than the daily 20h so a watched expansion the daily
// drain refreshed hours ago is re-fetched on the intraday lane. NO env var is required to function
// (do NOT make this fail-closed). Overridable via SCRYDEX_WATCH_FRESHNESS_HOURS.
export const DEFAULT_WATCH_FRESHNESS_HOURS = 4
/**
 * Watch-lane analogue of freshnessSafeForDrain: the watch freshness window MUST be strictly less
 * than the lane's cron interval, or every intraday run no-ops against its own prior run and
 * watched prices freeze (the same failure mode as the daily FRESHNESS↔DRAIN invariant). Default
 * 4h < 6h lane interval ⇒ safe.
 */
export function watchFreshnessSafeForLane(freshnessHours: number, laneIntervalHours = WATCH_LANE_INTERVAL_HOURS): boolean {
  return freshnessHours < laneIntervalHours
}

/**
 * The distinct Scrydex expansion keys (`${gameSlug}|${expansionId}`, price-type-AGNOSTIC) that
 * contain at least one watched card. Follows the canonical join map: card_watches →
 * products (products.id = canonical_product_id) → sets (sets.scrydex_expansion_id) →
 * canonical_games (name → slug via GAME_SLUG_BY_CANONICAL_NAME, the SAME slug the webhook
 * event_name carries as its first segment). Nothing is cached — the query is cheap and correctness
 * beats staleness here. Returns the key set + the raw distinct-expansion total for the audit line.
 */
export async function watchedExpansionKeys(db: D1Database): Promise<{ keys: Set<string>; total: number }> {
  const { results } = await db.prepare(`
    SELECT DISTINCT g.name AS game, s.scrydex_expansion_id AS expansion_id
    FROM   card_watches   w
    JOIN   products       p ON p.id = w.canonical_product_id
    JOIN   sets           s ON s.id = p.set_id
    JOIN   canonical_games g ON g.id = s.game_id
    WHERE  s.scrydex_expansion_id IS NOT NULL
    AND    s.scrydex_expansion_id <> ''
  `).all()
  const keys = new Set<string>()
  for (const r of (results as any[]) ?? []) {
    const slug = GAME_SLUG_BY_CANONICAL_NAME[r.game as string]
    if (!slug || !r.expansion_id) continue
    keys.add(`${slug}|${r.expansion_id}`)
  }
  return { keys, total: keys.size }
}

// ── WP-8 retry semantics (migration 0089: attempts + last_attempt_at) ─────────
// A row-specific failure increments `attempts`; at MAX_DRAIN_ATTEMPTS the row goes
// TERMINAL ('failed') and is never selected again — a poison row cannot loop forever.
export const MAX_DRAIN_ATTEMPTS = 5
// A 'processing' claim older than this is a dead run's leftover and is reclaimable.
// Well past any live invocation's lifetime (waitUntil is minutes), well under the
// daily drain interval so a crashed claim heals by the next scheduled run.
export const PROCESSING_STALE_SECONDS = 6 * 3600
// Error-retry backoff doubles per recorded attempt: 2h, 4h, 8h, 16h, 32h. On the
// daily cadence that means "next run" for early attempts and a skipped day near the
// cap. The SQL mirror uses SQLite's `<<` (the WP-2 bit-shift idiom).
export const ERROR_RETRY_BASE_SECONDS = 2 * 3600

/** JS spec for the candidate SQL's backoff term (kept in lockstep by unit tests). */
export function errorRetryBackoffSeconds(attempts: number): number {
  return ERROR_RETRY_BASE_SECONDS * (2 ** Math.max(0, attempts))
}

/** True when an 'error' row is due for a retry: under the attempt cap AND past its
 *  exponential backoff. `anchorSec` = last_attempt_at ?? completed_at ?? received_at
 *  (legacy rows predate the columns and are due immediately). */
export function isErrorRetryDue(attempts: number, anchorSec: number, nowSec: number): boolean {
  if (attempts >= MAX_DRAIN_ATTEMPTS) return false
  return anchorSec <= nowSec - errorRetryBackoffSeconds(attempts)
}

/** True when a 'processing' claim is stale (the claiming run died) and reclaimable. */
export function isProcessingStale(anchorSec: number, nowSec: number): boolean {
  return anchorSec <= nowSec - PROCESSING_STALE_SECONDS
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
  condition:  string | null
  finish:     string
  grade:      string | null
  company:    string | null
  is_signed:  number
  is_error:   number
  is_perfect: number
  is_graded:  number
}

/** 0/1 coercion for the payload's boolean-ish sub-variant flags (mirrors scrydexEnrich). */
function subVariantFlag(v: unknown): number {
  return v === true || v === 1 || v === '1' ? 1 : 0
}

/**
 * Maps a Scrydex variant price to canonical fields — POSITIVE write-time classification
 * (2026-07-14, the ARS-10-leak fix; Content migration 0099):
 *
 *   raw    → condition = the tier (price.condition, e.g. 'NM'); grade/company NULL; is_graded 0
 *   graded → condition = NULL; grade = `${normaliseCompany(company)} ${grade}` from the live
 *            payload shape { type:'graded', company, grade } (matches scrydexEnrich's
 *            parseCardPrices; the legacy combined price.condition string is the fallback);
 *            company + is_signed/is_error/is_perfect captured; is_graded 1. Unknown/new
 *            grading companies land on the graded side BY CONSTRUCTION (normaliseCompany
 *            passes any company through). A graded row that resolves NO label returns NULL —
 *            the caller must SKIP it; it must never fall through to the raw side (that
 *            fall-through wrote every drained graded price as condition=NULL/grade=NULL,
 *            leaking slab prices into the ungraded market).
 *   finish → variant.name when it is not 'normal' (e.g. 'foil','altArt'); else 'normal'
 */
export function deriveCanonicalPriceFields(
  price:       unknown,
  variantName: string | null | undefined,
  priceType:   string,
): CanonicalPriceFields | null {
  const p = price as any
  const finish = variantName && variantName !== 'normal' ? variantName : 'normal'
  if (priceType === 'graded') {
    const company  = normaliseCompany(p?.company)
    const gradeNum = p?.grade != null ? String(p.grade).trim() : null
    const label    = company && gradeNum ? `${company} ${gradeNum}` : (p?.condition ?? null)
    if (!label) return null   // unusable graded row — skip, never write as raw
    return {
      condition: null, finish, grade: label, company,
      is_signed:  subVariantFlag(p?.is_signed),
      is_error:   subVariantFlag(p?.is_error),
      is_perfect: subVariantFlag(p?.is_perfect),
      is_graded:  1,
    }
  }
  return {
    condition: p?.condition ?? null, finish, grade: null, company: null,
    is_signed: 0, is_error: 0, is_perfect: 0, is_graded: 0,
  }
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
// work-items resolve ok/fresh; any error marks it error; circuit-break/cap releases any
// unprocessed CLAIMED row back to pending at run end (WP-8).
interface RowState {
  id:        unknown
  attempts:  number        // attempts BEFORE this run (drives the terminal-state metric)
  remaining: Set<string>   // expansion keys not yet resolved
  errored:   boolean
  done:      boolean       // already written to the log (complete or error/failed)
  prices:    number        // metrics attributed to this row (owner of its work-items)
  credits:   number
}

/** A webhook card variant that resolved to NO canonical product (audit ING-3). */
export interface UnmatchedCardEntry {
  scrydexCardId:      string | null
  cardName:           string | null
  cardNumber:         string | null
  variantName:        string | null
  tcgplayerProductId: string | null
}

// Deduped record of unknown webhook cards (migration 0089). The conflict target must
// match uq_scrydex_unmatched_identity's COALESCE'd expression list exactly.
const UNMATCHED_UPSERT_SQL = `
  INSERT INTO scrydex_unmatched_cards
    (scrydex_card_id, card_name, card_number, game_slug, scrydex_expansion_id,
     tcgplayer_product_id, variant_name)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (COALESCE(scrydex_expansion_id,''), COALESCE(card_number,''), COALESCE(variant_name,''))
  DO UPDATE SET
    last_seen_at         = unixepoch(),
    seen_count           = seen_count + 1,
    scrydex_card_id      = COALESCE(excluded.scrydex_card_id,      scrydex_unmatched_cards.scrydex_card_id),
    card_name            = COALESCE(excluded.card_name,            scrydex_unmatched_cards.card_name),
    tcgplayer_product_id = COALESCE(excluded.tcgplayer_product_id, scrydex_unmatched_cards.tcgplayer_product_id)`

export async function processPendingWebhooks(
  env: Env,
  options: { scope?: 'daily' | 'watched' } = {},
): Promise<void> {
  const scope = options.scope === 'watched' ? 'watched' : 'daily'

  // ── Config ──────────────────────────────────────────────────────────────────
  // The watched (priority-lane) scope uses its OWN, shorter freshness window so an intraday run
  // isn't no-op'd by the daily drain's 20h bookkeeping. NEITHER window is fail-closed — both fall
  // back to a working in-code default when their env var is unset.
  const freshnessHours = scope === 'watched'
    ? (env.SCRYDEX_WATCH_FRESHNESS_HOURS ? parseInt(env.SCRYDEX_WATCH_FRESHNESS_HOURS, 10) : DEFAULT_WATCH_FRESHNESS_HOURS)
    : (env.SCRYDEX_PRICE_FRESHNESS_HOURS ? parseInt(env.SCRYDEX_PRICE_FRESHNESS_HOURS, 10) : DEFAULT_FRESHNESS_HOURS)
  const freshnessSeconds = freshnessHours * 3600
  const maxFetches = env.SCRYDEX_DRAIN_MAX_FETCHES
    ? parseInt(env.SCRYDEX_DRAIN_MAX_FETCHES, 10)
    : DEFAULT_MAX_FETCHES

  // INVARIANT: freshness must stay < the lane's re-run interval or prices silently freeze
  // (each run no-ops against its own prior run). Daily lane: freshness < 24h. Watch lane:
  // freshness < the intraday cron interval (WATCH_LANE_INTERVAL_HOURS).
  if (scope === 'watched') {
    if (!watchFreshnessSafeForLane(freshnessHours)) {
      console.error(
        `[ScrydexProcessor] ⚠️ SCRYDEX_WATCH_FRESHNESS_HOURS=${freshnessHours} ≥ ${WATCH_LANE_INTERVAL_HOURS}h watch-lane interval — ` +
        `every intraday watch run will no-op against its own prior run and WATCHED prices will FREEZE. Lower it below ${WATCH_LANE_INTERVAL_HOURS}h.`
      )
    }
  } else if (!freshnessSafeForDrain(freshnessHours)) {
    console.error(
      `[ScrydexProcessor] ⚠️ SCRYDEX_PRICE_FRESHNESS_HOURS=${freshnessHours} ≥ ${DRAIN_INTERVAL_HOURS}h drain interval — ` +
      `every daily run will no-op against its own prior run and prices will FREEZE. Lower it below 24h.`
    )
  }

  // Watched scope: resolve the watched-expansion set FIRST. An empty set = nothing to do (no
  // watches, or none map to a Scrydex expansion) → emit a zero audit and return before claiming
  // any row (the daily drain owns everything).
  let watchedKeys: Set<string> | null = null
  let watchedExpansionsTotal = 0
  if (scope === 'watched') {
    const w = await watchedExpansionKeys(env.DB)
    watchedKeys = w.keys
    watchedExpansionsTotal = w.total
    if (watchedKeys.size === 0) {
      console.log(JSON.stringify({
        log: 'scrydex_watch_drain_audit', watched_expansions_total: 0, rows_in: 0,
        distinct_expansions: 0, fetches_made: 0, fetches_skipped_fresh: 0, rows_completed: 0,
        rows_left_pending: 0, circuit_broken: false, credits_by_game: {},
      }))
      return
    }
  }
  // True when this expansion's (game, id) contains a watched card. Daily scope watches everything.
  const isExpansionInScope = (gameSlug: string, expansionId: string): boolean =>
    scope === 'daily' || watchedKeys!.has(`${gameSlug}|${expansionId}`)

  // Game filter — deliberately UNSET in prod (scoping only throttles Pokémon, the wrong
  // lever). Kept available for an operator to exclude a game in an emergency.
  const gameFilter: Set<string> | null = env.SCRYDEX_PRICE_GAMES
    ? new Set(env.SCRYDEX_PRICE_GAMES.split(',').map(s => s.trim()).filter(Boolean))
    : null

  // ── Load the day's candidate backlog (WP-8) ──────────────────────────────────
  // Three candidate classes in ONE scan, oldest first:
  //   1. status = 'pending' — normal backlog.
  //   2. stale 'processing' — a claim left by a run that died (reclaim).
  //   3. retry-due 'error' — under the attempt cap AND past the exponential backoff.
  // The `<<` backoff term mirrors errorRetryBackoffSeconds(); `attempts < MAX` bounds
  // the shift. COALESCE anchors legacy rows (columns predate mig 0089) as due now.
  const candidates = await env.DB.prepare(`
    SELECT id, event_name, expansion_ids_json, status, attempts
    FROM   scrydex_webhook_log
    WHERE  status = 'pending'
       OR (status = 'processing'
           AND COALESCE(last_attempt_at, received_at) <= unixepoch() - ${PROCESSING_STALE_SECONDS})
       OR (status = 'error'
           AND attempts < ${MAX_DRAIN_ATTEMPTS}
           AND COALESCE(last_attempt_at, completed_at, received_at)
               <= unixepoch() - (${ERROR_RETRY_BASE_SECONDS} << attempts))
    ORDER BY received_at ASC
    LIMIT ${PENDING_ROW_LIMIT}
  `).all()

  if (!candidates.results.length) return

  // ── CLAIM each candidate atomically (the double-drain guard) ──────────────────
  // One conditional UPDATE per row: the WHERE re-checks the observed state, so when
  // overlapping runs race (cron + manual /scrydex/process + admin trigger), exactly
  // one sees meta.changes === 1 and owns the row. A reclaim must re-check staleness —
  // status stays 'processing' either way, so the status check alone can't discriminate.
  const CLAIM_SQL: Record<string, string> = {
    pending: `UPDATE scrydex_webhook_log SET status = 'processing', last_attempt_at = unixepoch()
              WHERE id = ? AND status = 'pending'`,
    processing: `UPDATE scrydex_webhook_log SET last_attempt_at = unixepoch()
              WHERE id = ? AND status = 'processing'
                AND COALESCE(last_attempt_at, received_at) <= unixepoch() - ${PROCESSING_STALE_SECONDS}`,
    error: `UPDATE scrydex_webhook_log SET status = 'processing', last_attempt_at = unixepoch()
              WHERE id = ? AND status = 'error'`,
  }
  interface ClaimedRow { id: unknown; eventName: string; expansionIdsJson: string; attempts: number; fromStatus: string }
  const claimed: ClaimedRow[] = []
  let reclaimedProcessing = 0
  let retriedError = 0
  // Watched scope: only rows referencing at least one watched expansion are claimed — everything
  // else stays pending for the daily drain (the watch lane must NEVER complete a non-watched row).
  // A mixed row's non-watched expansions are still tracked in `remaining` below, so it never
  // completes here either: it fetches its watched expansions and is released back to pending.
  let candidateRows = candidates.results as any[]
  if (scope === 'watched') {
    candidateRows = candidateRows.filter((r) => {
      let exps: string[]
      try { exps = JSON.parse(r.expansion_ids_json as string) } catch { return false }
      const gameSlug = String(r.event_name).split('.')[0]
      return exps.some(e => isExpansionInScope(gameSlug, e))
    })
    if (!candidateRows.length) {
      console.log(JSON.stringify({
        log: 'scrydex_watch_drain_audit', watched_expansions_total: watchedExpansionsTotal, rows_in: 0,
        distinct_expansions: 0, fetches_made: 0, fetches_skipped_fresh: 0, rows_completed: 0,
        rows_left_pending: 0, circuit_broken: false, credits_by_game: {},
      }))
      return
    }
  }
  for (let i = 0; i < candidateRows.length; i += BATCH_SIZE) {
    const chunk = candidateRows.slice(i, i + BATCH_SIZE)
    const results = await env.DB.batch(chunk.map(r =>
      env.DB.prepare(CLAIM_SQL[r.status as string] ?? CLAIM_SQL.pending).bind(r.id)
    ))
    for (let j = 0; j < chunk.length; j++) {
      if ((results[j] as any)?.meta?.changes !== 1) continue   // lost the race — another run owns it
      const r = chunk[j]
      if (r.status === 'processing') reclaimedProcessing++
      else if (r.status === 'error') retriedError++
      claimed.push({
        id: r.id,
        eventName: r.event_name as string,
        expansionIdsJson: r.expansion_ids_json as string,
        attempts: typeof r.attempts === 'number' ? r.attempts : 0,
        fromStatus: r.status as string,
      })
    }
  }

  if (!claimed.length) return

  // ── Parse rows → build the DEDUPED work-item set (one per distinct expansion) ──
  const rowState = new Map<unknown, RowState>()
  const rowsByKey = new Map<string, unknown[]>()           // expansion key → row ids
  const workItems = new Map<string, { gameSlug: string; priceType: string; expansionId: string; ownerRowId: unknown }>()
  let failedTerminal = 0                                   // rows that reached the terminal 'failed' state this run
  const markComplete = async (id: unknown, prices: number, credits: number) =>
    env.DB.prepare(`UPDATE scrydex_webhook_log SET status='complete', prices_upserted=?, credits_used=?, completed_at=unixepoch() WHERE id=?`)
      .bind(prices, credits, id).run()
  // Row-specific failure: burns an attempt; at MAX_DRAIN_ATTEMPTS the row goes
  // TERMINAL ('failed') and is never selected again (poison rows can't loop forever).
  const markError = async (id: unknown, prices: number, credits: number, msg: string) =>
    env.DB.prepare(`UPDATE scrydex_webhook_log
      SET status = CASE WHEN attempts + 1 >= ${MAX_DRAIN_ATTEMPTS} THEN 'failed' ELSE 'error' END,
          attempts = attempts + 1,
          prices_upserted=?, credits_used=?, error_message=?, completed_at=unixepoch()
      WHERE id=?`)
      .bind(prices, credits, msg, id).run()
  // Environmental failure (credit guard trip / 403 cap): visible status='error' (the
  // June-outage invariant) but NO attempt burned — a capped month must never march
  // innocent rows to the terminal state. The guard itself stops all retry spend.
  const markErrorNoAttempt = async (id: unknown, prices: number, credits: number, msg: string) =>
    env.DB.prepare(`UPDATE scrydex_webhook_log SET status='error', prices_upserted=?, credits_used=?, error_message=?, completed_at=unixepoch() WHERE id=?`)
      .bind(prices, credits, msg, id).run()
  // Deterministic poison (unparseable payload): re-parsing can never succeed → TERMINAL.
  const markFailed = async (id: unknown, msg: string) =>
    env.DB.prepare(`UPDATE scrydex_webhook_log SET status='failed', attempts = attempts + 1, error_message=?, completed_at=unixepoch() WHERE id=?`)
      .bind(msg, id).run()

  for (const row of claimed) {
    const id = row.id
    let expansionIds: string[]
    try {
      expansionIds = JSON.parse(row.expansionIdsJson)
    } catch (err) {
      failedTerminal++
      await markFailed(id, `bad expansion_ids_json: ${(err as Error).message}`)
      continue
    }
    const eventName = row.eventName
    const gameSlug  = eventName.split('.')[0]
    const priceType = eventName.includes('graded') ? 'graded' : 'raw'

    // Game filter → immediately complete (no work).
    if (gameFilter && !gameFilter.has(gameSlug)) {
      await markComplete(id, 0, 0)
      continue
    }

    const keys = expansionIds.map(e => `${gameSlug}|${priceType}|${e}`)
    const st: RowState = { id, attempts: row.attempts, remaining: new Set(keys), errored: false, done: false, prices: 0, credits: 0 }
    rowState.set(id, st)
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      // In the WATCHED scope, only in-scope (watched) expansions become work-items — a mixed row's
      // non-watched keys stay in `remaining`/`rowsByKey` (so the row never completes here) but are
      // never fetched, and the row is released back to 'pending' for the daily drain. Daily scope
      // is in-scope for everything, so this is a no-op there.
      if (isExpansionInScope(gameSlug, expansionIds[i]) && !workItems.has(key)) {
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
    `[ScrydexProcessor] ${scope === 'watched' ? 'watch drain' : 'daily drain'} - ${claimed.length} claimed rows ` +
    `(${reclaimedProcessing} reclaimed-stale, ${retriedError} error-retries) -> ` +
    `${workItems.size} distinct expansions (scope=${scope}, freshness=${freshnessHours}h, maxFetches=${maxFetches}, ` +
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
  // Fail one expansion key: mark every referencing row error (once). `burnAttempt`
  // distinguishes a row-specific failure (counts toward the terminal cap) from an
  // environmental one (guard/403 — retried without limit once credits return).
  const failKey = async (key: string, msg: string, burnAttempt: boolean) => {
    for (const id of rowsByKey.get(key) ?? []) {
      const st = rowState.get(id)
      if (!st || st.done) continue
      st.remaining.delete(key)
      st.errored = true
      st.done = true
      if (burnAttempt) {
        if (st.attempts + 1 >= MAX_DRAIN_ATTEMPTS) failedTerminal++
        await markError(id, st.prices, st.credits, msg)
      } else {
        await markErrorNoAttempt(id, st.prices, st.credits, msg)
      }
    }
  }

  // ── Process distinct expansions (one fetch each) ──────────────────────────────
  let totalFetches = 0            // Scrydex page-calls (= credits) made this run
  let skippedFresh = 0            // expansions inside the freshness window (no API call)
  let expansionsFetched = 0       // distinct expansions we actually fetched live
  let totalUnmatched = 0          // webhook card variants with no catalogue match (ING-3)
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
      const unmatched: UnmatchedCardEntry[] = []
      for (const card of cards) {
        allUpserts.push(...await buildPriceUpserts(env.DB, card, wi.expansionId, wi.priceType, unmatched))
      }
      for (let i = 0; i < allUpserts.length; i += BATCH_SIZE) {
        await env.DB.batch(allUpserts.slice(i, i + BATCH_SIZE))
      }
      // Unknown cards (ING-3): record instead of dropping silently. Deduped per
      // (expansion, number, variant) — a daily re-encounter bumps seen_count, so
      // seen_count ≈ days observed and the table never balloons.
      if (unmatched.length) {
        totalUnmatched += unmatched.length
        const stmts = unmatched.map(u =>
          env.DB.prepare(UNMATCHED_UPSERT_SQL).bind(
            u.scrydexCardId, u.cardName, u.cardNumber,
            wi.gameSlug, wi.expansionId, u.tcgplayerProductId, u.variantName,
          ))
        for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
          await env.DB.batch(stmts.slice(i, i + BATCH_SIZE))
        }
      }
      await markExpansionFresh(env.DB, wi.expansionId, wi.priceType)
      await satisfyKey(key, allUpserts.length, requests)

      await new Promise(r => setTimeout(r, 100))
    } catch (err) {
      const msg = (err as Error).message
      if (err instanceof ScrydexCreditLimitError) {
        // The credit guard is the hard backstop for retries too: it throws BEFORE any
        // API call, so a retried row can never spend past the cap. No attempt burned —
        // a capped month must not march innocent rows to 'failed'.
        console.warn('[ScrydexProcessor] Credit limit guard triggered — stopping run')
        circuitBroken = true
        await failKey(key, msg, false)
        break
      }
      if (err instanceof ScrydexFetchError && err.status === 403) {
        console.error(`[ScrydexProcessor] 403 (CREDIT_CAP_HIT) on ${wi.gameSlug}/${wi.expansionId} — circuit breaker, stopping run`)
        circuitBroken = true
        await failKey(key, msg, false)
        break
      }
      // Transient/other error on a single expansion: mark its rows error (burns an
      // attempt — the capped-retry path to the terminal state), keep going.
      console.error(`[ScrydexProcessor] Expansion ${wi.gameSlug}/${wi.expansionId}:`, err)
      await failKey(key, msg, true)
    }
  }

  // ── RELEASE claimed-but-unreached rows back to 'pending' (WP-8) ───────────────
  // maxFetches / circuit break can leave claimed rows unprocessed; releasing them
  // restores the pre-claim semantics ("stays pending for the next run"). A run KILLED
  // before this point (waitUntil cutoff) heals via the stale-'processing' reclaim.
  // The status guard means we only touch rows still holding our claim.
  const unfinished = [...rowState.values()].filter(s => !s.done)
  for (let i = 0; i < unfinished.length; i += BATCH_SIZE) {
    await env.DB.batch(unfinished.slice(i, i + BATCH_SIZE).map(st =>
      env.DB.prepare(`UPDATE scrydex_webhook_log SET status = 'pending' WHERE id = ? AND status = 'processing'`)
        .bind(st.id)
    ))
  }

  const leftoverRows = unfinished.length
  const laneLabel = scope === 'watched' ? 'watch drain' : 'daily drain'
  console.log(
    `[ScrydexProcessor] ${laneLabel} complete — ${totalFetches} fetches, ${skippedFresh} fresh-skipped, ` +
    `${leftoverRows} rows released back to pending, ${failedTerminal} terminal` +
    (circuitBroken ? ' (circuit-broken)' : '')
  )

  // Structured audit line (Part B, §4 #8) — one machine-parseable JSON record per run so
  // credit consumption is measurable from `wrangler tail` / Logpush without scraping prose.
  // `rows_in` vs `distinct_expansions` quantifies the dedup collapse; `fetches_made`
  // (page-calls = credits) vs `fetches_skipped_fresh` shows the freshness savings;
  // `credits_by_game` confirms the measured Pokémon concentration. WP-8 adds the
  // reclaim/retry/terminal/unmatched counters. The watch lane emits its own `log` key +
  // `watched_expansions_total` so the two lanes are separable in Logpush.
  console.log(JSON.stringify({
    log:                        scope === 'watched' ? 'scrydex_watch_drain_audit' : 'scrydex_drain_audit',
    ...(scope === 'watched' ? { watched_expansions_total: watchedExpansionsTotal } : {}),
    rows_in:                    claimed.length,
    rows_reclaimed_processing:  reclaimedProcessing,
    rows_retried_error:         retriedError,
    rows_failed_terminal:       failedTerminal,
    distinct_expansions:        workItems.size,
    expansions_fetched:         expansionsFetched,
    fetches_made:               totalFetches,
    fetches_skipped_fresh:      skippedFresh,
    unmatched_cards:            totalUnmatched,
    rows_completed:             claimed.length - leftoverRows,
    rows_left_pending:          leftoverRows,
    circuit_broken:             circuitBroken,
    max_fetches:                maxFetches,
    freshness_hours:            freshnessHours,
    credits_by_game:            creditsByGame,
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
  const gameSlug = GAME_SLUG_BY_CANONICAL_NAME[product.game]
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

// company + the sub-variant flags are part of the uq_prices_identity conflict key; is_graded is
// NOT identity (Content mig 0099) but is always written so classification is explicit at write
// time. DO UPDATE keeps is_graded in step for rows the backfill couldn't classify.
const SCRYDEX_PRICE_SQL = `
  INSERT INTO prices
    (product_id, source, condition, finish, grade, company, is_signed, is_error, is_perfect, is_graded, value,
     trend_1d, trend_7d, trend_14d, trend_30d, trend_90d, fetched_at)
  VALUES (?, 'scrydex', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
  ON CONFLICT (product_id, source, COALESCE(condition,''), COALESCE(finish,''), COALESCE(grade,''),
               COALESCE(variant,''), COALESCE(company,''), is_signed, is_error, is_perfect)
  DO UPDATE SET
    value      = excluded.value,
    is_graded  = excluded.is_graded,
    trend_1d   = excluded.trend_1d,
    trend_7d   = excluded.trend_7d,
    trend_14d  = excluded.trend_14d,
    trend_30d  = excluded.trend_30d,
    trend_90d  = excluded.trend_90d,
    fetched_at = excluded.fetched_at`

/**
 * Builds canonical price upserts for one webhook card. When the optional `unmatched`
 * collector is passed (the daily drain does; sync-set / refresh-card do not), every
 * variant that resolves to NO canonical product is pushed onto it instead of being
 * dropped silently (audit ING-3) — the caller records them to scrydex_unmatched_cards.
 */
export async function buildPriceUpserts(
  db:          D1Database,
  card:        unknown,
  expansionId: string,
  priceType:   string,
  unmatched?:  UnmatchedCardEntry[],
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

    if (!product) {
      unmatched?.push({
        scrydexCardId:      c.id != null ? String(c.id) : null,
        cardName:           c.name != null ? String(c.name) : null,
        cardNumber:         c.number != null ? String(c.number) : null,
        variantName:        variant.name != null ? String(variant.name) : 'normal',
        tcgplayerProductId: tcgProductId != null ? String(tcgProductId) : null,
      })
      continue
    }

    const variantName: string  = variant.name ?? 'normal'
    const variantPrices: any[] = variant.prices ?? []

    for (const price of variantPrices) {
      if (price.type !== priceType) continue

      const fields = deriveCanonicalPriceFields(price, variantName, priceType)
      if (!fields) continue   // graded row with no resolvable label — never write it as raw
      const trends = extractTrends(price.trends)

      upserts.push(
        db.prepare(SCRYDEX_PRICE_SQL).bind(
          product.id,
          fields.condition,
          fields.finish,
          fields.grade,
          fields.company,
          fields.is_signed,
          fields.is_error,
          fields.is_perfect,
          fields.is_graded,
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
