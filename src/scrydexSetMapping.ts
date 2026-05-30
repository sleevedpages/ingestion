/**
 * Scrydex expansion catalog sync
 *
 * Runs weekly alongside the image mirror job (Sunday 3 AM UTC).
 * Fetches Scrydex's expansion list for each supported game and updates
 * `tcg_sets.skrydex_set_id` for any sets not yet mapped.
 *
 * This enables:
 * - Price matching in scrydexProcessor (matches on skrydex_set_id OR abbreviation)
 * - Image mirroring for non-Pokémon games once Scrydex CDN support is added
 *
 * Cost: 1 credit per game (6 games = 6 credits per weekly run).
 *
 * Match strategy (in priority order):
 * 1. Scrydex `code` or `ptcgo_code` matches our `tcg_sets.abbreviation`
 * 2. Normalised name match (lowercase, alphanumeric only)
 */

import type { Env } from './worker.js'

const SCRYDEX_BASE = 'https://api.scrydex.com'

const GAME_CONFIGS = [
  { slug: 'pokemon',           categoryName: 'Pokemon'            },
  { slug: 'magicthegathering', categoryName: 'Magic'              },
  { slug: 'onepiece',          categoryName: 'One Piece Card Game' },
  { slug: 'gundam',            categoryName: 'Gundam Card Game'   },
  { slug: 'lorcana',           categoryName: 'Lorcana'            },
  { slug: 'riftbound',         categoryName: 'Riftbound'          },
] as const

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
      const res = await fetch(
        `${SCRYDEX_BASE}/${game.slug}/v1/expansions?limit=500`,
        {
          headers: {
            'X-Api-Key': env.SCRYDEX_API_KEY!,
            'X-Team-ID': env.SCRYDEX_TEAM_ID!,
            'Accept':    'application/json',
          },
        }
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

      // Fetch our tcg_sets for this game
      const gameWord = game.categoryName.split(' ')[0]
      const { results: ourSets } = await env.DB.prepare(`
        SELECT s.id, s.name, s.abbreviation, s.skrydex_set_id
        FROM   tcg_sets s
        JOIN   tcg_categories c ON s.tcgplayer_category_id = c.tcgplayer_category_id
        WHERE  LOWER(c.name) LIKE LOWER(?)
      `).bind(`%${gameWord}%`).all()

      const updates: D1PreparedStatement[] = []

      for (const set of ourSets as any[]) {
        const abbrev   = (set.abbreviation as string | null)?.toLowerCase()
        let scrydexId  = abbrev ? byCode.get(abbrev) : undefined

        // Fall back to normalised name match
        if (!scrydexId && set.name) {
          const norm = (set.name as string).toLowerCase().replace(/[^a-z0-9]/g, '')
          scrydexId = byName.get(norm)
        }

        if (scrydexId && scrydexId !== set.skrydex_set_id) {
          updates.push(
            env.DB.prepare('UPDATE tcg_sets SET skrydex_set_id = ? WHERE id = ?')
              .bind(scrydexId, set.id)
          )
          if (set.skrydex_set_id) {
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

      // Pace requests across games
      await new Promise(r => setTimeout(r, 200))
    } catch (err) {
      console.error(`[SetMapping] Error on ${game.slug}:`, err)
    }
  }

  console.log(
    `[SetMapping] Complete — mapped:${result.mapped} updated:${result.updated}`,
    `notFound:${result.notFound} credits:${result.creditsUsed}`
  )
  return result
}
