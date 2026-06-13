/**
 * Scrydex Image URL Sync
 *
 * Runs weekly before the R2 mirror job so the mirror has fresh image URLs to work with.
 * Fetches card images from Scrydex's CDN catalog and writes them to tcg_products.image_url.
 * Never overwrites URLs that already point to our R2 (https://images.sleevedpages.com).
 *
 * Image source strategy per game:
 *
 *   ONE PIECE + GUNDAM — variant-level images (each alt art is its own TCGPlayer product):
 *     Match by variant.marketplaces[tcgplayer].product_id → tcg_products.tcgplayer_product_id
 *     Use variant.images[front].large
 *
 *   ALL OTHER GAMES — card-level images (all variants share the same product):
 *     Match by card.number + set via tcgplayer_group_id
 *     NOTE: tcg_products has NO set_id column — must join via tcgplayer_group_id
 *     Use card.images[front].large — same image for normal, foil, reverse holo variants
 *
 * Cost: 1 credit per set (only sets with scrydex_set_id populated).
 */

import type { Env } from './worker.js'
import { ScrydexCreditLimitError } from './lib/scrydexClient.js'
import { fetchAllExpansionCards, ScrydexCardsError } from './lib/scrydexCards.js'
import { sourceUrlUpsertByProductId, sourceUrlUpsertByGroupNumber } from './lib/productImages.js'
import {
  collectVariantEntries,
  fetchExistingProducts,
  planVariantWrites,
  captureUpdate,
  frontImageLarge,
  tcgProductIdOf,
} from './lib/variantCapture.js'

// Games where each variant has a unique product_id + its own image
const VARIANT_IMAGE_GAMES = new Set(['onepiece', 'gundam'])

const GAME_SLUG_BY_CATEGORY: Record<string, string> = {
  'Pokemon': 'pokemon',
  'Magic': 'magicthegathering',
  'One Piece Card Game': 'onepiece',
  'Gundam Card Game': 'gundam',
  'Lorcana': 'lorcana',
  'Riftbound': 'riftbound',
}

interface SyncResult {
  setsProcessed: number
  imagesUpdated: number
  creditsUsed: number
  variantsMatched: number
  variantsUnmatched: number
  variantsCaptured: number    // variant rows that got scrydex_card_id/variant_kind/finish + image
  variantsConflicted: number  // variants routed to variant_ingest_conflicts (not written)
}

/**
 * Sync Scrydex image URLs into tcg_products.image_url.
 *
 * @param env  Worker bindings
 * @param game Optional tcg_categories.name filter (e.g. 'One Piece Card Game').
 *             When omitted, all games with scrydex_set_id mappings are processed.
 */
export async function syncScrydexImages(env: Env, game?: string): Promise<SyncResult> {
  const result: SyncResult = { setsProcessed: 0, imagesUpdated: 0, creditsUsed: 0, variantsMatched: 0, variantsUnmatched: 0, variantsCaptured: 0, variantsConflicted: 0 }

  // Select tcgplayer_group_id so we can use it directly in the UPDATE
  // (tcg_products joins to tcg_sets via tcgplayer_group_id, NOT an internal set_id)
  // Only process sets that still have at least one product needing an image URL.
  // Once a set is fully R2-mirrored, this EXISTS check returns nothing and the
  // set is skipped — saving 1 credit per already-synced set per weekly run.
  // With 352 mapped sets in production, this drops the weekly cost from ~352
  // credits to near-zero once the initial sync + R2 backfill are complete.
  // Canonical (Session D): sets/canonical_games; the "set still has products needing
  // an image URL" pre-filter checks product_images.r2_url (a product with no R2 image).
  // `s.scrydex_expansion_id AS scrydex_set_id` keeps the downstream field name stable.
  const setsStmt = game
    ? env.DB.prepare(`
        SELECT s.id, s.name, s.code AS set_code, s.scrydex_expansion_id AS scrydex_set_id,
               s.tcgplayer_group_id, g.name AS game
        FROM   sets s
        JOIN   canonical_games g ON g.id = s.game_id
        WHERE  s.scrydex_expansion_id IS NOT NULL
        AND    g.name = ?
        AND (
          g.name IN ('One Piece Card Game', 'Gundam Card Game')
          OR EXISTS (
            SELECT 1 FROM products p2
            LEFT JOIN product_images pi2 ON pi2.product_id = p2.id
            WHERE  p2.set_id = s.id
            AND    pi2.r2_url IS NULL
          )
        )
        ORDER BY s.id ASC
      `).bind(game)
    : env.DB.prepare(`
        SELECT s.id, s.name, s.code AS set_code, s.scrydex_expansion_id AS scrydex_set_id,
               s.tcgplayer_group_id, g.name AS game
        FROM   sets s
        JOIN   canonical_games g ON g.id = s.game_id
        WHERE  s.scrydex_expansion_id IS NOT NULL
        AND (
          g.name IN ('One Piece Card Game', 'Gundam Card Game')
          OR EXISTS (
            SELECT 1 FROM products p2
            LEFT JOIN product_images pi2 ON pi2.product_id = p2.id
            WHERE  p2.set_id = s.id
            AND    pi2.r2_url IS NULL
          )
        )
        ORDER BY s.id ASC
      `)

  const { results: sets } = await setsStmt.all()

  // Many canonical sets share one scrydex_expansion_id — cache each expansion's /cards
  // response by scrydex_set_id so it is fetched at most once per run (saves credits +
  // avoids the waitUntil budget blowout from re-fetching the same data dozens of times).
  const cardsCache = new Map<string, any[]>()
  // Variant capture keys on the GLOBAL tcgplayer_product_id, so an expansion only needs
  // to be captured once even if many sets share it — track which we've already done to
  // avoid re-writing the same products 40× (and blowing the waitUntil budget).
  const capturedExpansions = new Set<string>()

  for (const set of sets as any[]) {
    const gameName = set.game as string
    const gameSlug = GAME_SLUG_BY_CATEGORY[gameName]
    if (!gameSlug) continue

    try {
      const cacheKey = String(set.scrydex_set_id)
      let cards = cardsCache.get(cacheKey)
      if (!cards) {
        const { cards: fetched, requests } = await fetchAllExpansionCards(
          env, gameSlug, set.scrydex_set_id, 'syncScrydexImages',
        )
        result.creditsUsed += requests
        cards = fetched
        cardsCache.set(cacheKey, cards)
        await new Promise(r => setTimeout(r, 100))   // pace Scrydex only on a real fetch
      }

      const updates: D1PreparedStatement[] = []

      if (VARIANT_IMAGE_GAMES.has(gameSlug)) {
        // Skip if another set already captured this (shared) expansion — capture is
        // global by product_id, so re-doing it writes the same rows again for nothing.
        if (capturedExpansions.has(cacheKey)) continue
        capturedExpansions.add(cacheKey)
        // ── One Piece / Gundam: per-variant capture + conflict routing ──
        // Each variant is its own TCGPlayer product. For every NON-colliding variant
        // we (a) capture scrydex_card_id (data.id) / variant_kind (variant.name) /
        // finish onto its product, and (b) write its DISTINCT front image keyed on the
        // product_id bridge (the variant-image-pull fix — was keyed on shared
        // card_number). Colliding variants (intra-payload dup product_id OR
        // cross-product) route to variant_ingest_conflicts and write nothing.
        const entries = collectVariantEntries(cards, set.set_code ?? null)
        const existing = await fetchExistingProducts(env.DB, entries.map(e => e.tcgProductId))

        const plan = planVariantWrites(env.DB, entries, existing, (entry) => {
          const stmts: D1PreparedStatement[] = [captureUpdate(env.DB, entry)]
          if (entry.imageUrl) {
            stmts.push(sourceUrlUpsertByProductId(env.DB, entry.tcgProductId, entry.imageUrl, 'scrydex'))
          }
          return stmts
        })
        updates.push(...plan.statements)

        // Fallback: variants with NO marketplace entry (no product_id) can't be
        // captured or conflict-checked — keep them imaged by card_number so they
        // aren't left blank. (Image only; no structured capture.)
        let setUnmatched = 0
        for (const card of cards) {
          for (const variant of (card.variants ?? []) as any[]) {
            if (tcgProductIdOf(variant) !== null) continue
            const imageUrl = frontImageLarge(variant)
            if (!imageUrl || !card.number) continue
            setUnmatched++
            updates.push(
              sourceUrlUpsertByGroupNumber(env.DB, set.tcgplayer_group_id, card.number, imageUrl, 'scrydex')
            )
          }
        }

        result.variantsMatched    += plan.captured
        result.variantsCaptured   += plan.captured
        result.variantsConflicted += plan.conflicted
        result.variantsUnmatched  += setUnmatched
        if (plan.conflicted > 0 || setUnmatched > 0) {
          console.log(
            `[ImageSync] ${set.name}: ${plan.captured} captured,`,
            `${plan.conflicted} conflicts logged, ${setUnmatched} no-marketplace fallbacks`
          )
        }
      } else {
        // ── All other games: card-level images, match by card_number + group_id ──
        // tcg_products.tcgplayer_group_id links to tcg_sets.tcgplayer_group_id
        for (const card of cards) {
          const cardImages: any[] = card.images ?? []
          const frontImage = cardImages.find((i: any) => i.type === 'front')
          const imageUrl = frontImage?.large ?? null
          if (!imageUrl || !card.number) continue

          // Card-level (all other games): write the Scrydex CDN url as source_url for
          // every product sharing this group+number. source is left untouched (NULL on
          // first write) — only the R2 mirror sets a definitive source.
          updates.push(
            sourceUrlUpsertByGroupNumber(env.DB, set.tcgplayer_group_id, card.number, imageUrl, null)
          )
        }
      }

      // Chunk at 100 to respect D1 batch limits
      for (let i = 0; i < updates.length; i += 100) {
        await env.DB.batch(updates.slice(i, i + 100))
      }

      result.imagesUpdated += updates.length
      result.setsProcessed++

      if (updates.length > 0) {
        console.log(`[ImageSync] ${set.name}: ${updates.length} image URLs updated`)
      }
    } catch (err) {
      if (err instanceof ScrydexCreditLimitError) {
        console.warn('[ImageSync] Credit limit guard triggered — stopping set processing')
        break
      }
      if (err instanceof ScrydexCardsError && err.status === 403) {
        console.error('[ImageSync] 403 (CREDIT_CAP_HIT) — circuit breaker, stopping run')
        break
      }
      console.error(`[ImageSync] Error on ${set.name}:`, err)
    }
  }

  console.log(
    `[ImageSync] Complete — sets:${result.setsProcessed}`,
    `images:${result.imagesUpdated} credits:${result.creditsUsed}`,
    `variantsCaptured:${result.variantsCaptured} variantsConflicted:${result.variantsConflicted}`,
    `variantsUnmatched:${result.variantsUnmatched}`
  )
  return result
}
