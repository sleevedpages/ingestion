/**
 * Scrydex expansion catalog sync
 *
 * Runs weekly alongside the image mirror job (Sunday 3 AM UTC).
 * Fetches Scrydex's expansion list for each supported game and updates
 * `tcg_sets.scrydex_set_id` for any sets not yet mapped.
 *
 * This enables:
 * - Price matching in scrydexProcessor (matches on scrydex_set_id OR abbreviation)
 * - Image mirroring for non-Pokémon games once Scrydex CDN support is added
 *
 * Cost: 1 credit per game (6 games = 6 credits per weekly run).
 *
 * Match strategy (in priority order):
 * 1. Scrydex `code` or `ptcgo_code` matches our `tcg_sets.abbreviation`
 * 2. Normalised name match (lowercase, alphanumeric only)
 */

import type { Env } from './worker.js'
import { scrydexFetch, ScrydexCreditLimitError } from './lib/scrydexClient.js'
import { GAME_SLUG_BY_CANONICAL_NAME } from './lib/gameNames.js'

// WP-3 (audit IMG-5/IMG-6b): configs derive from the ONE shared canonical-name map,
// so the category names here are always the exact canonical_games.name strings
// ('Lorcana TCG', 'Riftbound League of Legends Trading Card Game', …) and
// 'Pokemon Japan' can never be swept in (it has no entry in the map).
const GAME_CONFIGS = Object.entries(GAME_SLUG_BY_CANONICAL_NAME)
  .map(([categoryName, slug]) => ({ slug, categoryName }))

// Games where each TCGPlayer product is a distinct variant — audit these after mapping
const VARIANT_IMAGE_CATEGORY_NAMES = new Set(['One Piece Card Game', 'Gundam Card Game'])

interface SyncResult {
  mapped:      number   // sets newly mapped (were NULL)
  updated:     number   // sets with changed mapping
  notFound:    number   // our sets with no Scrydex match
  creditsUsed: number
}

export async function syncScrydexSetMappings(env: Env): Promise<SyncResult> {
  const result: SyncResult = { mapped: 0, updated: 0, notFound: 0, creditsUsed: 0 }

  for (const game of GAME_CONFIGS) {
    try {
      const res = await scrydexFetch(
        env,
        `/${game.slug}/v1/expansions`,
        'syncScrydexSetMappings',
        { params: { limit: '500' } },
      )
      result.creditsUsed++

      if (!res.ok) {
        console.warn(`[SetMapping] ${game.slug} expansions failed: ${res.status}`)
        continue
      }

      const data = await res.json() as { data?: unknown[] }
      const expansions = (data.data ?? []) as any[]

      console.log(`[SetMapping] ${game.slug}: ${expansions.length} expansions from Scrydex`)

      // Build lookup maps: code → scrydex_id, normalisedName → scrydex_id
      const byCode = new Map<string, string>()
      const byName = new Map<string, string>()

      for (const exp of expansions) {
        const id: string = exp.id ?? exp.code
        if (!id) continue
        if (exp.code)       byCode.set(exp.code.toLowerCase(), id)
        if (exp.ptcgo_code) byCode.set(exp.ptcgo_code.toLowerCase(), id)
        if (exp.name) {
          byName.set(
            (exp.name as string).toLowerCase().replace(/[^a-z0-9]/g, ''),
            id
          )
        }
      }

      // Fetch our canonical sets for this game (Session D: sets/canonical_games).
      // Aliases keep the downstream field names (abbreviation / scrydex_set_id) stable.
      // WP-3 (audit IMG-6b): match the game by EXACT canonical name — the old
      // `LIKE '%<first word>%'` matched 'Pokemon Japan' for the Pokemon config and
      // leaked ENGLISH Scrydex expansion ids onto 44 JP sets (wrong-art mirrors).
      const { results: ourSets } = await env.DB.prepare(`
        SELECT s.id, s.name, s.code AS abbreviation, s.scrydex_expansion_id AS scrydex_set_id
        FROM   sets s
        JOIN   canonical_games g ON g.id = s.game_id
        WHERE  g.name = ?
      `).bind(game.categoryName).all()

      const updates: D1PreparedStatement[] = []

      for (const set of ourSets as any[]) {
        const abbrev   = (set.abbreviation as string | null)?.toLowerCase()
        let scrydexId  = abbrev ? byCode.get(abbrev) : undefined

        // Fall back to normalised name match
        if (!scrydexId && set.name) {
          const norm = (set.name as string).toLowerCase().replace(/[^a-z0-9]/g, '')
          scrydexId = byName.get(norm)
        }

        if (scrydexId && scrydexId !== set.scrydex_set_id) {
          updates.push(
            env.DB.prepare('UPDATE sets SET scrydex_expansion_id = ? WHERE id = ?')
              .bind(scrydexId, set.id)
          )
          if (set.scrydex_set_id) {
            result.updated++
          } else {
            result.mapped++
          }
        } else if (!scrydexId) {
          result.notFound++
          console.debug(`[SetMapping] No match: ${set.name} (${set.abbreviation ?? '—'})`)
        }
      }

      if (updates.length) {
        // Chunk at 100 to respect D1 batch limits
        for (let i = 0; i < updates.length; i += 100) {
          await env.DB.batch(updates.slice(i, i + 100))
        }
        console.log(`[SetMapping] ${game.slug}: ${updates.length} sets mapped/updated`)
      }

      // For variant-image games, audit how many card_numbers have multiple products
      // so data gaps are visible in the logs without extra API calls.
      if (VARIANT_IMAGE_CATEGORY_NAMES.has(game.categoryName)) {
        try {
          const { results: variantRows } = await env.DB.prepare(`
            SELECT p.number AS card_number, COUNT(*) AS variant_count
            FROM   products p
            JOIN   sets            s ON s.id = p.set_id
            JOIN   canonical_games g ON g.id = s.game_id
            WHERE  g.name = ?
            AND    p.number IS NOT NULL
            GROUP  BY s.id, p.number
            HAVING COUNT(*) > 1
          `).bind(game.categoryName).all()

          const variantGroups        = variantRows?.length ?? 0
          const totalVariantProducts = (variantRows ?? []).reduce((sum: number, r: any) => sum + (r.variant_count as number), 0)

          console.log(
            `[SetMapping] ${game.categoryName} variant audit:`,
            `${variantGroups} card_numbers with multiple products`,
            `(${totalVariantProducts} total variant product rows)`,
            variantGroups > 0 ? '— run backfillVariantImages to correct image URLs' : '— no variant correction needed'
          )
        } catch (auditErr) {
          console.warn(`[SetMapping] ${game.categoryName} variant audit failed:`, auditErr)
        }
      }

      // Pace requests across games
      await new Promise(r => setTimeout(r, 200))
    } catch (err) {
      if (err instanceof ScrydexCreditLimitError) {
        console.warn('[SetMapping] Credit limit guard triggered — stopping game processing')
        break
      }
      console.error(`[SetMapping] Error on ${game.slug}:`, err)
    }
  }

  console.log(
    `[SetMapping] Complete — mapped:${result.mapped} updated:${result.updated}`,
    `notFound:${result.notFound} credits:${result.creditsUsed}`
  )
  return result
}
