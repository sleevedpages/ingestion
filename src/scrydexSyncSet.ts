/**
 * scrydexSyncSet.ts — Per-set Scrydex sync, one set at a time, driven from local/admin.
 *
 * Lets the operator bulk-update a SINGLE set (cards + prices + images for that set's
 * Scrydex expansion) on demand, without running a whole-game sync. It reuses the exact
 * Session-D / D-bis machinery the scheduled jobs use:
 *   - fetchAllExpansionCards()  (q=expansion.id + page/pageSize pagination)         — one fetch
 *   - buildPriceUpserts()       (canonical `prices`, source='scrydex', R1→R2 match)
 *   - variantCapture + productImages helpers (canonical `products` capture + `product_images`)
 * It writes CANONICAL ONLY — the legacy tcg_* tables were DROPPED (migration 0066);
 * there is nothing to write there.
 *
 * Credit-guarded (via scrydexFetch's monthly guard), respects the 403 circuit breaker,
 * and uses `scrydex_expansion_freshness` for resumability: a set already refreshed inside
 * the freshness window is skipped unless `force` is set, and a successful run marks the
 * expansion fresh for BOTH price types so the next daily drain dedups it away.
 */

import type { Env } from './worker.js'
import { ScrydexCreditLimitError } from './lib/scrydexClient.js'
import { fetchAllExpansionCards, ScrydexCardsError } from './lib/scrydexCards.js'
import {
  buildPriceUpserts,
  isExpansionFresh,
  markExpansionFresh,
  DEFAULT_FRESHNESS_HOURS,
} from './scrydexProcessor.js'
import { sourceUrlUpsertByProductId, sourceUrlUpsertByGroupNumber } from './lib/productImages.js'
import {
  collectVariantEntries,
  fetchExistingProducts,
  planVariantWrites,
  captureUpdate,
  frontImageLarge,
  tcgProductIdOf,
} from './lib/variantCapture.js'

const BATCH_SIZE = 100
const VARIANT_IMAGE_GAMES = new Set(['onepiece', 'gundam'])

// WP-3 (audit IMG-5): shared canonical-name → slug map (the local copy here keyed
// 'Lorcana'/'Riftbound' and skipped both games; see lib/gameNames.ts).
import { GAME_SLUG_BY_CANONICAL_NAME } from './lib/gameNames.js'

export interface SyncSetOptions {
  setId?:              number       // canonical sets.id
  scrydexExpansionId?: string       // sets.scrydex_expansion_id (e.g. 'OP09')
  force?:              boolean       // bypass the freshness skip
}

export interface SyncSetResult {
  ok:                  boolean
  error?:              string
  skipped?:            boolean       // fresh + not forced (no API call made)
  setId?:              number
  setName?:            string
  scrydexExpansionId?: string
  game?:               string
  cardsFetched?:       number
  pricesUpserted?:     number        // canonical `prices` rows written (raw + graded)
  imagesUpdated?:      number        // product_images statements
  variantsMatched?:    number        // OP/Gundam variants captured
  variantsConflicted?: number        // variants routed to variant_ingest_conflicts
  variantsUnmatched?:  number        // no-marketplace fallbacks imaged by number
  requests?:           number        // Scrydex page-calls = credits used
}

interface SetRow {
  id:                   number
  name:                 string
  set_code:             string | null
  scrydex_expansion_id: string | null
  tcgplayer_group_id:   number | null
  game:                 string
}

/** Resolve a single set by canonical id or by its Scrydex expansion id. */
async function resolveSet(env: Env, opts: SyncSetOptions): Promise<SetRow | null> {
  const select = `
    SELECT s.id, s.name, s.code AS set_code, s.scrydex_expansion_id,
           s.tcgplayer_group_id, g.name AS game
    FROM   sets s
    JOIN   canonical_games g ON g.id = s.game_id`
  if (opts.setId != null) {
    return env.DB.prepare(`${select} WHERE s.id = ? LIMIT 1`).bind(opts.setId).first<SetRow>()
  }
  // Multiple canonical sets can share one scrydex_expansion_id (non-unique) — pick the
  // lowest id deterministically; the expansion fetch covers them all anyway.
  return env.DB.prepare(`${select} WHERE s.scrydex_expansion_id = ? ORDER BY s.id ASC LIMIT 1`)
    .bind(opts.scrydexExpansionId).first<SetRow>()
}

export async function syncSingleSet(env: Env, opts: SyncSetOptions): Promise<SyncSetResult> {
  if (opts.setId == null && !opts.scrydexExpansionId) {
    return { ok: false, error: 'setId or scrydexExpansionId is required' }
  }

  const set = await resolveSet(env, opts)
  if (!set)                        return { ok: false, error: 'set not found' }
  if (!set.scrydex_expansion_id)   return { ok: false, error: 'set has no Scrydex expansion mapping' }
  const gameSlug = GAME_SLUG_BY_CANONICAL_NAME[set.game]
  if (!gameSlug)                   return { ok: false, error: `unsupported game: ${set.game}` }
  const expansionId = set.scrydex_expansion_id

  const base: SyncSetResult = {
    ok: true, setId: set.id, setName: set.name, scrydexExpansionId: expansionId, game: set.game,
  }

  // ── Freshness / resumability: skip when both price types are already fresh ──────
  const freshnessHours = env.SCRYDEX_PRICE_FRESHNESS_HOURS
    ? parseInt(env.SCRYDEX_PRICE_FRESHNESS_HOURS, 10)
    : DEFAULT_FRESHNESS_HOURS
  const freshnessSeconds = freshnessHours * 3600
  if (!opts.force) {
    const [rawFresh, gradedFresh] = await Promise.all([
      isExpansionFresh(env.DB, expansionId, 'raw', freshnessSeconds),
      isExpansionFresh(env.DB, expansionId, 'graded', freshnessSeconds),
    ])
    if (rawFresh && gradedFresh) {
      return { ...base, skipped: true, cardsFetched: 0, pricesUpserted: 0, imagesUpdated: 0, requests: 0 }
    }
  }

  try {
    // ONE paginated fetch for the whole expansion (cards + prices).
    const { cards, requests } = await fetchAllExpansionCards(env, gameSlug, expansionId, 'syncSingleSet', true)

    // ── Prices (canonical, raw + graded) ──────────────────────────────────────────
    const priceStmts: D1PreparedStatement[] = []
    for (const card of cards) {
      priceStmts.push(...await buildPriceUpserts(env.DB, card, expansionId, 'raw'))
      priceStmts.push(...await buildPriceUpserts(env.DB, card, expansionId, 'graded'))
    }
    for (let i = 0; i < priceStmts.length; i += BATCH_SIZE) {
      await env.DB.batch(priceStmts.slice(i, i + BATCH_SIZE))
    }

    // ── Images + variant capture (canonical product_images / products) ────────────
    const imgStmts: D1PreparedStatement[] = []
    let variantsMatched = 0, variantsConflicted = 0, variantsUnmatched = 0
    const groupId = set.tcgplayer_group_id   // number | null — group-number writes need it

    if (VARIANT_IMAGE_GAMES.has(gameSlug)) {
      const entries  = collectVariantEntries(cards, set.set_code ?? null)
      const existing = await fetchExistingProducts(env.DB, entries.map(e => e.tcgProductId))
      const plan = planVariantWrites(env.DB, entries, existing, (entry) => {
        const stmts: D1PreparedStatement[] = [captureUpdate(env.DB, entry)]
        if (entry.imageUrl) {
          stmts.push(sourceUrlUpsertByProductId(env.DB, entry.tcgProductId, entry.imageUrl, 'scrydex'))
        }
        return stmts
      })
      imgStmts.push(...plan.statements)
      variantsMatched    = plan.captured
      variantsConflicted = plan.conflicted

      // Variants with no marketplace product_id: keep imaged by card number (image only).
      if (groupId != null) {
        for (const card of cards) {
          for (const variant of (card.variants ?? []) as any[]) {
            if (tcgProductIdOf(variant) !== null) continue
            const imageUrl = frontImageLarge(variant)
            if (!imageUrl || !card.number) continue
            variantsUnmatched++
            imgStmts.push(sourceUrlUpsertByGroupNumber(env.DB, groupId, card.number, imageUrl, 'scrydex'))
          }
        }
      }
    } else if (groupId != null) {
      // All other games: card-level image, shared across variants, matched by group+number.
      for (const card of cards) {
        const frontImage = (card.images ?? []).find((i: any) => i.type === 'front')
        const imageUrl = frontImage?.large ?? null
        if (!imageUrl || !card.number) continue
        imgStmts.push(sourceUrlUpsertByGroupNumber(env.DB, groupId, card.number, imageUrl, null))
      }
    }
    for (let i = 0; i < imgStmts.length; i += BATCH_SIZE) {
      await env.DB.batch(imgStmts.slice(i, i + BATCH_SIZE))
    }

    // ── Mark the expansion fresh (both price types) on success ─────────────────────
    await markExpansionFresh(env.DB, expansionId, 'raw')
    await markExpansionFresh(env.DB, expansionId, 'graded')

    const result: SyncSetResult = {
      ...base,
      cardsFetched:       cards.length,
      pricesUpserted:     priceStmts.length,
      imagesUpdated:      imgStmts.length,
      variantsMatched,
      variantsConflicted,
      variantsUnmatched,
      requests,
    }
    console.log(JSON.stringify({ log: 'scrydex_sync_set', ...result }))
    return result
  } catch (err) {
    if (err instanceof ScrydexCreditLimitError) return { ...base, ok: false, error: 'Scrydex credit guard triggered' }
    if (err instanceof ScrydexCardsError)       return { ...base, ok: false, error: `Scrydex ${err.status}` }
    return { ...base, ok: false, error: (err as Error).message }
  }
}
