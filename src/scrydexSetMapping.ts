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
 * Cost: 1 credit per PAGE per game (see the pagination note below) — a handful per weekly run.
 *
 * ⚠️ PAGINATION (fixed 2026-08-12). This used to send `limit: '500'`, and Scrydex **silently
 * ignores unknown params** — the exact defect that capped `/cards` at ~100 rows until 2026-06-12
 * and was carried in Ingestion/CLAUDE.md as an open risk ever since. So only the FIRST page of each
 * game's expansions was ever seen, and any game with more expansions than one page could never be
 * fully mapped. Measured consequence on prod (2026-08-12): **70 of 454 Magic sets carried a
 * `scrydex_expansion_id`** — 15% — which in turn capped every expansion-scoped Scrydex job for
 * Magic (prices, images, and the Session-3A attribute fill) at ~21.7% of its products. It now
 * paginates with `page`/`pageSize` and stops on `totalCount`, the same contract
 * `fetchAllExpansionCards` uses.
 *
 * Match strategy (in priority order):
 * 1. Scrydex `code` or `ptcgo_code` matches our `tcg_sets.abbreviation`
 * 2. Normalised name match (lowercase, alphanumeric only)
 */

import type { Env } from './worker.js'
import { scrydexFetch, ScrydexCreditLimitError, isScrydexRefusal } from './lib/scrydexClient.js'
import { GAME_SLUG_BY_CANONICAL_NAME } from './lib/gameNames.js'

/** Requested page size; Scrydex may cap lower, which `totalCount` paging handles. */
const EXPANSION_PAGE_SIZE = 250
/** Safety valve against a missing/zero `totalCount` — never an unbounded loop. */
const EXPANSION_MAX_PAGES = 20

/**
 * Every expansion for one game, across all pages. Returns what it managed to read: a page that
 * fails mid-way yields the pages already collected (`complete: false`) rather than throwing away
 * the run's work — but a REFUSAL (402/403) rethrows so the caller's circuit breaker stops the whole
 * sync instead of writing mappings from a partial catalogue.
 */
export async function fetchAllExpansions(
  env:      Env,
  gameSlug: string,
): Promise<{ expansions: any[]; requests: number; complete: boolean }> {
  const expansions: any[] = []
  let requests = 0
  let page = 1
  let total = Infinity

  while (expansions.length < total && page <= EXPANSION_MAX_PAGES) {
    const res = await scrydexFetch(env, `/${gameSlug}/v1/expansions`, 'syncScrydexSetMappings', {
      params: { pageSize: String(EXPANSION_PAGE_SIZE), page: String(page) },
    })
    requests++

    if (!res.ok) {
      if (isScrydexRefusal(res.status)) {
        throw new ScrydexExpansionsError(res.status, `Scrydex ${res.status} for ${gameSlug}/expansions`)
      }
      console.warn(`[SetMapping] ${gameSlug} expansions page ${page} failed: ${res.status}`)
      return { expansions, requests, complete: false }
    }

    const data  = await res.json() as { data?: unknown[]; totalCount?: number; total_count?: number }
    const batch = (data.data ?? []) as any[]
    expansions.push(...batch)

    total = data.totalCount ?? data.total_count ?? expansions.length   // absent → stop after this page
    if (batch.length === 0) break
    page++
  }

  return { expansions, requests, complete: expansions.length >= total }
}

/** Carries the HTTP status so the caller can circuit-break on an account-level refusal. */
export class ScrydexExpansionsError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ScrydexExpansionsError'
    this.status = status
  }
}

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
      const { expansions, requests, complete } = await fetchAllExpansions(env, game.slug)
      result.creditsUsed += requests

      if (!expansions.length) {
        console.warn(`[SetMapping] ${game.slug}: no expansions returned — nothing to map`)
        continue
      }

      console.log(
        `[SetMapping] ${game.slug}: ${expansions.length} expansions from Scrydex`,
        `(${requests} page-call${requests === 1 ? '' : 's'}${complete ? '' : ', PARTIAL — some sets may stay unmapped'})`
      )

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
      if (err instanceof ScrydexExpansionsError && isScrydexRefusal(err.status)) {
        // Account-level refusal (403 cap / 402 plan): every remaining game would fail the same way.
        console.error(`[SetMapping] ${err.status} (Scrydex refusal) — circuit breaker, stopping run`)
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
