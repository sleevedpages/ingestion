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
 * Cost: 1 credit per set (only sets with skrydex_set_id populated).
 */

import type { Env } from './worker.js'
import { scrydexFetch, ScrydexCreditLimitError } from './lib/scrydexClient.js'

// Games where each variant has a unique product_id + its own image
const VARIANT_IMAGE_GAMES = new Set(['onepiece', 'gundam'])

const GAME_SLUG_BY_CATEGORY: Record<string, string> = {
  'Pokemon':             'pokemon',
  'Magic':               'magicthegathering',
  'One Piece Card Game': 'onepiece',
  'Gundam Card Game':    'gundam',
  'Lorcana':             'lorcana',
  'Riftbound':           'riftbound',
}

interface SyncResult {
  setsProcessed: number
  imagesUpdated: number
  creditsUsed:   number
}

export async function syncScrydexImages(env: Env): Promise<SyncResult> {
  const result: SyncResult = { setsProcessed: 0, imagesUpdated: 0, creditsUsed: 0 }

  // Select tcgplayer_group_id so we can use it directly in the UPDATE
  // (tcg_products joins to tcg_sets via tcgplayer_group_id, NOT an internal set_id)
  const { results: sets } = await env.DB.prepare(`
    SELECT s.id, s.name, s.abbreviation, s.skrydex_set_id,
           s.tcgplayer_group_id, c.name AS game
    FROM   tcg_sets s
    JOIN   tcg_categories c ON s.tcgplayer_category_id = c.tcgplayer_category_id
    WHERE  s.skrydex_set_id IS NOT NULL
    ORDER BY s.id ASC
  `).all()

  for (const set of sets as any[]) {
    const gameName = set.game as string
    const gameSlug = GAME_SLUG_BY_CATEGORY[gameName]
    if (!gameSlug) continue

    try {
      const res = await scrydexFetch(
        env,
        `/${gameSlug}/v1/cards`,
        'syncScrydexImages',
        { params: { expansion: set.skrydex_set_id, limit: '500' } },
      )
      result.creditsUsed++

      if (!res.ok) {
        console.warn(`[ImageSync] ${set.name} failed: ${res.status}`)
        continue
      }

      const data  = await res.json() as { data?: unknown[] }
      const cards = (data.data ?? []) as any[]
      const updates: D1PreparedStatement[] = []

      if (VARIANT_IMAGE_GAMES.has(gameSlug)) {
        // ── One Piece / Gundam: match each variant by unique TCGPlayer product_id ──
        for (const card of cards) {
          for (const variant of (card.variants ?? []) as any[]) {
            const variantImages: any[] = variant.images ?? []
            if (!variantImages.length) continue

            const frontImage = variantImages.find((i: any) => i.type === 'front')
            const imageUrl   = frontImage?.large ?? null
            if (!imageUrl) continue

            const tcgMarket    = (variant.marketplaces ?? []).find((m: any) => m.name === 'tcgplayer')
            const tcgProductId = tcgMarket?.product_id ? parseInt(tcgMarket.product_id, 10) : null
            if (!tcgProductId) continue

            updates.push(
              env.DB.prepare(`
                UPDATE tcg_products
                SET    image_url = ?
                WHERE  tcgplayer_product_id = ?
                AND   (image_url IS NULL
                       OR image_url NOT LIKE 'https://images.sleevedpages.com%')
              `).bind(imageUrl, tcgProductId)
            )
          }
        }
      } else {
        // ── All other games: card-level images, match by card_number + group_id ──
        // tcg_products.tcgplayer_group_id links to tcg_sets.tcgplayer_group_id
        for (const card of cards) {
          const cardImages: any[] = card.images ?? []
          const frontImage = cardImages.find((i: any) => i.type === 'front')
          const imageUrl   = frontImage?.large ?? null
          if (!imageUrl || !card.number) continue

          updates.push(
            env.DB.prepare(`
              UPDATE tcg_products
              SET    image_url = ?
              WHERE  tcgplayer_group_id = ?
              AND    LOWER(card_number) = LOWER(?)
              AND   (image_url IS NULL
                     OR image_url NOT LIKE 'https://images.sleevedpages.com%')
            `).bind(imageUrl, set.tcgplayer_group_id, card.number)
          )
        }
      }

      // Chunk at 100 to respect D1 batch limits
      for (let i = 0; i < updates.length; i += 100) {
        await env.DB.batch(updates.slice(i, i + 100))
      }

      result.imagesUpdated += updates.length
      result.setsProcessed++

      console.log(`[ImageSync] ${set.name}: ${updates.length} image URLs updated`)
      await new Promise(r => setTimeout(r, 100))
    } catch (err) {
      if (err instanceof ScrydexCreditLimitError) {
        console.warn('[ImageSync] Credit limit guard triggered — stopping set processing')
        break
      }
      console.error(`[ImageSync] Error on ${set.name}:`, err)
    }
  }

  console.log(
    `[ImageSync] Complete — sets:${result.setsProcessed}`,
    `images:${result.imagesUpdated} credits:${result.creditsUsed}`
  )
  return result
}
