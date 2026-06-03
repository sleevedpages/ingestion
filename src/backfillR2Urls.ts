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

const R2_PUBLIC_BASE = 'https://images.sleevedpages.com'
const EXTENSIONS     = ['jpg', 'png', 'webp'] as const
const CONCURRENCY    = 20

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
