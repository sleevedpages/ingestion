/**
 * scrydexImageRepair.ts — Bandai image repair (WP-1 re-scoped, 2026-07-17)
 *
 * One-shot-per-call, cursor-based repair of the pre-WP-1 source_url damage in the
 * 'scrydex'-preferred games (One Piece + Gundam; mig 0104): the daily TCGCSV sync
 * clobbered every Scrydex-CDN source_url until 2026-07-07, and the weekly image
 * sync has died before reaching the Bandai sets on every run since — so all
 * mapped-set Bandai products still point at TCGPlayer's watermarked "SAMPLE" art.
 *
 * Each call processes ONE mapped set of a scrydex-preferred game through the
 * EXISTING per-set sync machinery (`syncSingleSet`, force:true — the daily price
 * drain keeps expansions price-fresh, which would otherwise skip the image
 * writes), then returns { hasMore, cursorNext, remaining } so the Content admin
 * panel can loop it (the purge-placeholder-mirrors / dead-url-sweep pattern).
 *
 * IDEMPOTENT: re-running re-fetches and re-upserts the same Scrydex urls (merge-
 * upserts on UNIQUE(product_id)); worst case is re-spent credits (~1–3/set).
 * Credit-guarded via syncSingleSet → scrydexFetch's monthly guard; a guard trip
 * returns creditLimited:true WITHOUT advancing the cursor, so the loop can stop
 * and resume next month from the same spot.
 *
 * Unmapped sets (no scrydex_expansion_id) are OUT of scope by design — they are
 * the documented manual-image residual (admin per-product upload).
 */

import type { Env } from './worker.js'
import { syncSingleSet, type SyncSetResult } from './scrydexSyncSet.js'
import { loadImagePreferences, preferenceForCanonicalGameName } from './lib/imagePreference.js'

export interface RepairBatchResult {
  ok:             boolean
  error?:         string
  creditLimited?: boolean
  set?: {
    setId:              number
    setName:            string
    game:               string
    scrydexExpansionId: string | undefined
    cardsFetched:       number
    imagesUpdated:      number
    variantsConflicted: number
    requests:           number
  }
  // Flattened per-batch metrics for the admin CursorLoopCard accumulator
  // (it sums top-level numeric keys across batches).
  setsRepaired:   number
  imagesUpdated:  number
  requests:       number
  hasMore:    boolean
  cursorNext: number
  remaining:  number   // mapped scrydex-preferred sets still AFTER this one
}

interface RepairSetRow { id: number; name: string; game: string }

/** All mapped sets of scrydex-preferred games with id > cursor, ascending. */
async function pendingRepairSets(env: Env, cursor: number): Promise<RepairSetRow[]> {
  const { results } = await env.DB.prepare(`
    SELECT s.id, s.name, g.name AS game
    FROM   sets s
    JOIN   canonical_games g ON g.id = s.game_id
    WHERE  s.scrydex_expansion_id IS NOT NULL
    AND    s.id > ?
    ORDER BY s.id ASC
  `).bind(cursor).all<RepairSetRow>()
  const prefs = await loadImagePreferences(env.DB)
  return (results ?? []).filter(
    (r) => preferenceForCanonicalGameName(prefs, r.game) === 'scrydex'
  )
}

export async function runScrydexImageRepairBatch(env: Env, cursor = 0): Promise<RepairBatchResult> {
  const pending = await pendingRepairSets(env, cursor)
  if (pending.length === 0) {
    return {
      ok: true, setsRepaired: 0, imagesUpdated: 0, requests: 0,
      hasMore: false, cursorNext: cursor, remaining: 0,
    }
  }

  const target = pending[0]
  const result: SyncSetResult = await syncSingleSet(env, { setId: target.id, force: true })

  if (!result.ok) {
    const creditLimited = /credit guard|Scrydex 403/i.test(result.error ?? '')
    // Do NOT advance the cursor on failure — the set stays next in line.
    return {
      ok: false,
      error: result.error,
      creditLimited,
      setsRepaired: 0, imagesUpdated: 0, requests: result.requests ?? 0,
      hasMore: true,
      cursorNext: cursor,
      remaining: pending.length,
    }
  }

  const remaining = pending.length - 1
  const out: RepairBatchResult = {
    ok: true,
    set: {
      setId:              target.id,
      setName:            target.name,
      game:               target.game,
      scrydexExpansionId: result.scrydexExpansionId,
      cardsFetched:       result.cardsFetched ?? 0,
      imagesUpdated:      result.imagesUpdated ?? 0,
      variantsConflicted: result.variantsConflicted ?? 0,
      requests:           result.requests ?? 0,
    },
    setsRepaired:  1,
    imagesUpdated: result.imagesUpdated ?? 0,
    requests:      result.requests ?? 0,
    hasMore: remaining > 0,
    cursorNext: target.id,
    remaining,
  }
  console.log(JSON.stringify({ log: 'scrydex_image_repair', ...out.set, remaining }))
  return out
}
