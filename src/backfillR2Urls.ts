/**
 * backfillR2Urls.ts
 *
 * One-time admin-triggered backfill: for every tcg_products row whose image_url
 * still points at a non-R2 source (TCGPlayer, Scrydex CDN, etc.), checks whether
 * a mirrored copy already exists in the R2 bucket and, if so, updates image_url
 * to the canonical R2 public URL.
 *
 * Records with no matching R2 object are left unchanged — TCGPlayer remains the
 * de-facto fallback for those cards until a future mirror run covers them.
 *
 * Called by: POST /admin/backfill-r2-urls (x-worker-secret required)
 */

import type { Env } from './worker.js'
import { uploadCardImage } from './image-mirror.js'
import { scrydexFetch, ScrydexCreditLimitError } from './lib/scrydexClient.js'

const R2_PUBLIC_BASE = 'https://images.sleevedpages.com'
const EXTENSIONS     = ['jpg', 'png', 'webp'] as const
const CONCURRENCY    = 20

// Games where each TCGPlayer product row is a distinct variant with its own image
const VARIANT_IMAGE_CATEGORY_NAMES = ['One Piece Card Game', 'Gundam Card Game']

const GAME_SLUG_BY_CATEGORY_NAME: Record<string, string> = {
  'One Piece Card Game': 'onepiece',
  'Gundam Card Game':    'gundam',
}

interface ProductRow {
  id:                   number
  tcgplayer_product_id: number
  category_name:        string
}

export interface GameSummary {
  game:    string
  checked: number
  updated: number
  skipped: number
}

export interface BackfillResult {
  totalChecked: number
  totalUpdated: number
  totalSkipped: number
  games:        GameSummary[]
}

export async function backfillR2ImageUrls(env: Env): Promise<BackfillResult> {
  const { results } = await env.DB.prepare(`
    SELECT
      p.id,
      p.tcgplayer_product_id,
      c.name AS category_name
    FROM  tcg_products    p
    JOIN  tcg_sets        s ON s.tcgplayer_group_id    = p.tcgplayer_group_id
    JOIN  tcg_categories  c ON c.tcgplayer_category_id = s.tcgplayer_category_id
    WHERE p.image_url IS NOT NULL
      AND p.image_url != ''
      AND p.image_url NOT LIKE 'https://images.sleevedpages.com%'
  `).all<ProductRow>()

  const rows      = results ?? []
  const gameStats = new Map<string, GameSummary>()
  const toUpdate: { id: number; url: string }[] = []

  // Check R2 existence concurrently in chunks of CONCURRENCY
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const chunk = rows.slice(i, i + CONCURRENCY)

    const resolved = await Promise.all(chunk.map(async (row) => {
      for (const ext of EXTENSIONS) {
        const key = `cards/${row.tcgplayer_product_id}.${ext}`
        const obj = await env.IMAGES_BUCKET.head(key)
        if (obj) {
          return { row, url: `${R2_PUBLIC_BASE}/${key}` }
        }
      }
      return { row, url: null }
    }))

    for (const { row, url } of resolved) {
      const game = row.category_name
      if (!gameStats.has(game)) {
        gameStats.set(game, { game, checked: 0, updated: 0, skipped: 0 })
      }
      const stats = gameStats.get(game)!
      stats.checked++
      if (url) {
        toUpdate.push({ id: row.id, url })
        stats.updated++
      } else {
        stats.skipped++
      }
    }
  }

  // Batch-write DB updates (100 statements per D1 batch to stay within limits)
  if (toUpdate.length > 0) {
    const statements = toUpdate.map(({ id, url }) =>
      env.DB.prepare(`UPDATE tcg_products SET image_url = ? WHERE id = ?`).bind(url, id)
    )
    for (let i = 0; i < statements.length; i += 100) {
      await env.DB.batch(statements.slice(i, i + 100))
    }
  }

  const games = [...gameStats.values()].sort((a, b) => b.updated - a.updated)

  console.log('[BackfillR2] Complete')
  console.log(`  Total checked : ${rows.length}`)
  console.log(`  Total updated : ${toUpdate.length}`)
  console.log(`  Total skipped : ${rows.length - toUpdate.length}  (no R2 copy found)`)
  for (const g of games) {
    console.log(`  ${g.game}: checked=${g.checked} updated=${g.updated} skipped=${g.skipped}`)
  }

  return {
    totalChecked: rows.length,
    totalUpdated: toUpdate.length,
    totalSkipped: rows.length - toUpdate.length,
    games,
  }
}

// ─── Variant image backfill ───────────────────────────────────────────────────

export interface VariantGameSummary {
  game:      string
  processed: number
  corrected: number
  skipped:   number
  failed:    number
}

export interface VariantBackfillResult {
  processed: number
  corrected: number
  skipped:   number
  failed:    number
  byGame:    VariantGameSummary[]
}

/** Fetch image bytes from a URL; returns null on failure or if the result is a placeholder. */
async function fetchVariantImageBytes(url: string): Promise<{ buffer: ArrayBuffer; contentType: string } | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'Referer':    'https://www.tcgplayer.com/',
        'User-Agent': 'Mozilla/5.0 (compatible; SleevedPages/1.0)',
      },
    })
    if (!res.ok) return null
    const contentType = res.headers.get('content-type') ?? 'image/jpeg'
    const buffer = await res.arrayBuffer()
    // Guard against Scrydex placeholder card-back images (~181 KB)
    if (buffer.byteLength < 300_000) return null
    return { buffer, contentType }
  } catch {
    return null
  }
}

/**
 * Re-mirrors variant images for games where each TCGPlayer product has its own image.
 *
 * Queries tcg_products for card_numbers with more than one product row (confirmed variant sets),
 * fetches fresh Scrydex variant data for each expansion, matches each variant to the correct
 * tcg_products row via tcgplayer_product_id, and mirrors the correct image to R2.
 *
 * All Scrydex API calls go through scrydexFetch() — the monthly credit guard is respected.
 *
 * @param env  Worker bindings (DB, IMAGES_BUCKET, SCRYDEX_API_KEY required)
 * @param game Optional tcg_categories.name filter (e.g. 'One Piece Card Game').
 *             When omitted, all VARIANT_IMAGE_CATEGORY_NAMES games are processed.
 */
export async function backfillVariantImages(env: Env, game?: string): Promise<VariantBackfillResult> {
  const result: VariantBackfillResult = { processed: 0, corrected: 0, skipped: 0, failed: 0, byGame: [] }

  // Determine which category names to query
  const categoryNames = game ? [game] : VARIANT_IMAGE_CATEGORY_NAMES

  // Build IN clause — parameterized with individual ? placeholders
  const inClause = categoryNames.map(() => '?').join(', ')

  const { results: sets } = await env.DB.prepare(`
    SELECT s.id, s.name, s.skrydex_set_id, s.tcgplayer_group_id, c.name AS game
    FROM   tcg_sets        s
    JOIN   tcg_categories  c ON c.tcgplayer_category_id = s.tcgplayer_category_id
    WHERE  s.skrydex_set_id IS NOT NULL
    AND    c.name IN (${inClause})
    ORDER  BY c.name, s.id ASC
  `).bind(...categoryNames).all()

  const gameStats = new Map<string, VariantGameSummary>()

  outer: for (const set of (sets ?? []) as any[]) {
    const gameName = set.game as string
    const gameSlug = GAME_SLUG_BY_CATEGORY_NAME[gameName]
    if (!gameSlug) continue

    if (!gameStats.has(gameName)) {
      gameStats.set(gameName, { game: gameName, processed: 0, corrected: 0, skipped: 0, failed: 0 })
    }
    const stats = gameStats.get(gameName)!

    // Only process sets that have card_numbers with more than one product (confirmed variant groups)
    const { results: variantCheck } = await env.DB.prepare(`
      SELECT card_number
      FROM   tcg_products
      WHERE  tcgplayer_group_id = ?
      AND    card_number IS NOT NULL
      GROUP  BY card_number
      HAVING COUNT(*) > 1
      LIMIT  1
    `).bind(set.tcgplayer_group_id).all()

    if (!variantCheck || variantCheck.length === 0) continue

    try {
      const res = await scrydexFetch(
        env,
        `/${gameSlug}/v1/cards`,
        'backfillVariantImages',
        { params: { expansion: set.skrydex_set_id, limit: '500' } },
      )

      if (!res.ok) {
        console.warn(`[VariantBackfill] ${set.name} fetch failed: ${res.status}`)
        continue
      }

      const data  = await res.json() as { data?: unknown[] }
      const cards = (data.data ?? []) as any[]

      let setProcessed = 0, setCorrected = 0, setSkipped = 0, setFailed = 0

      for (const card of cards) {
        for (const variant of (card.variants ?? []) as any[]) {
          const variantImages: any[] = variant.images ?? []
          const frontImage = variantImages.find((i: any) => i.type === 'front')
          const imageUrl   = frontImage?.large ?? frontImage?.medium ?? null
          if (!imageUrl) continue

          const tcgMarket    = (variant.marketplaces ?? []).find((m: any) => m.name === 'tcgplayer')
          const tcgProductId = tcgMarket?.product_id ? parseInt(tcgMarket.product_id, 10) : null
          if (!tcgProductId) {
            setSkipped++
            continue
          }

          // Verify this product_id exists in our DB before fetching bytes
          const exists = await env.DB.prepare(
            `SELECT tcgplayer_product_id FROM tcg_products WHERE tcgplayer_product_id = ?`
          ).bind(tcgProductId).first<{ tcgplayer_product_id: number }>()

          if (!exists) {
            setSkipped++
            continue
          }

          setProcessed++

          const fetched = await fetchVariantImageBytes(imageUrl)
          if (!fetched) {
            setFailed++
            console.warn(`[VariantBackfill] Image fetch failed — product ${tcgProductId}: ${imageUrl}`)
            continue
          }

          try {
            await uploadCardImage(
              { DB: env.DB, IMAGES_BUCKET: env.IMAGES_BUCKET },
              tcgProductId,
              fetched.buffer,
              fetched.contentType,
              'skrydex',
            )
            setCorrected++
          } catch (e) {
            setFailed++
            console.warn(`[VariantBackfill] Upload failed — product ${tcgProductId}:`, e)
          }
        }
      }

      stats.processed += setProcessed
      stats.corrected += setCorrected
      stats.skipped   += setSkipped
      stats.failed    += setFailed
      result.processed += setProcessed
      result.corrected += setCorrected
      result.skipped   += setSkipped
      result.failed    += setFailed

      console.log(
        `[VariantBackfill] ${set.name}:`,
        `processed=${setProcessed} corrected=${setCorrected}`,
        `skipped=${setSkipped} failed=${setFailed}`,
      )

      await new Promise(r => setTimeout(r, 100))
    } catch (err) {
      if (err instanceof ScrydexCreditLimitError) {
        console.warn('[VariantBackfill] Credit limit guard triggered — stopping')
        break outer
      }
      console.error(`[VariantBackfill] Error on ${set.name}:`, err)
    }
  }

  result.byGame = [...gameStats.values()].sort((a, b) => b.corrected - a.corrected)

  console.log('[VariantBackfill] Complete:', JSON.stringify({
    processed: result.processed,
    corrected: result.corrected,
    skipped:   result.skipped,
    failed:    result.failed,
  }))
  for (const g of result.byGame) {
    console.log(`  ${g.game}: processed=${g.processed} corrected=${g.corrected} skipped=${g.skipped} failed=${g.failed}`)
  }

  return result
}
