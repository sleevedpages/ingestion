/**
 * scrydexDrainGate.ts — the `scrydex_drain_enabled` switch in front of the Scrydex webhook drain
 * (session 2026-10-06, the JustTCG switch, Phase 3).
 *
 * Content's `app_config.scrydex_drain_enabled` (code default '1' = today) gates BOTH callers of
 * `processPendingWebhooks`: the daily 04:00 drain and the Card Watch priority lane (10/16/22, + the
 * two admin jobs + `POST /scrydex/process`). The operator flips it to '0' only AFTER the JustTCG serve
 * switch is ON and walked; the drain code stays dormant one release (deletion is a later cleanup).
 *
 * Switched OFF, the drain makes NO Scrydex call and returns `skipped: 'scrydex_drain_disabled'` —
 * which `runStage` records in the run-log row's counts, so the no-op is visible, never silent.
 *
 * ⚠️ CARD WATCH ALERTS MUST KEEP FIRING. The alert hook (Content `/api/internal/watch-alerts/run`)
 * evaluates the watches in whatever expansions the lane hands it, against the CURRENT raw ladder
 * headline (TCGplayer first — refreshed by the 06:00 TCGCSV sync, not by Scrydex). With the drain
 * off nothing is "refreshed" by Scrydex, so an empty list would silence every alert forever. The
 * watched scope therefore hands back EVERY watched expansion: Content compares current vs baseline,
 * a card that did not move compares equal and never fires (the endpoint's own documented rule).
 */

import type { Env } from './worker.js'
import { processPendingWebhooks, watchedExpansionKeys, type DrainResult } from './scrydexProcessor.js'
import { scrydexDrainEnabled } from './justtcgIngest.js'

export interface GatedDrainResult extends DrainResult { skipped?: 'scrydex_drain_disabled' }

export async function runScrydexDrainGated(env: Env, scope: 'daily' | 'watched' = 'daily'): Promise<GatedDrainResult> {
  // ON (the default): exactly the calls that shipped before the gate existed.
  if (await scrydexDrainEnabled(env.DB)) return scope === 'watched' ? processPendingWebhooks(env, { scope: 'watched' }) : processPendingWebhooks(env)
  if (scope !== 'watched') return { scope, expansionsFetched: 0, refreshedExpansions: [], skipped: 'scrydex_drain_disabled' }
  const { keys } = await watchedExpansionKeys(env.DB)
  const refreshedExpansions = [...keys].map(k => {
    const i = k.indexOf('|')
    return { gameSlug: k.slice(0, i), expansion: k.slice(i + 1) }
  })
  return { scope, expansionsFetched: 0, refreshedExpansions, skipped: 'scrydex_drain_disabled' }
}
