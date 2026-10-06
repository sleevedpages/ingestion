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
 * NO SCRYDEX KEYS behaves exactly like OFF, reported as `skipped: 'scrydex_not_configured'`
 * (2026-10-06, the operator's decision to drop Scrydex completely: once the plan is cancelled the
 * worker's `SCRYDEX_API_KEY` / `SCRYDEX_TEAM_ID` secrets get deleted, and the Card Watch lane must not
 * die with them). Callers therefore no longer need their own key check to stay safe.
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

export interface GatedDrainResult extends DrainResult { skipped?: 'scrydex_drain_disabled' | 'scrydex_not_configured' }

export async function runScrydexDrainGated(env: Env, scope: 'daily' | 'watched' = 'daily'): Promise<GatedDrainResult> {
  const configured = !!(env.SCRYDEX_API_KEY && env.SCRYDEX_TEAM_ID)
  // ON with keys (the default): exactly the calls that shipped before the gate existed.
  if (configured && await scrydexDrainEnabled(env.DB)) return scope === 'watched' ? processPendingWebhooks(env, { scope: 'watched' }) : processPendingWebhooks(env)
  const skipped = configured ? 'scrydex_drain_disabled' : 'scrydex_not_configured'
  if (scope !== 'watched') return { scope, expansionsFetched: 0, refreshedExpansions: [], skipped }
  const { keys } = await watchedExpansionKeys(env.DB)
  const refreshedExpansions = [...keys].map(k => {
    const i = k.indexOf('|')
    return { gameSlug: k.slice(0, i), expansion: k.slice(i + 1) }
  })
  return { scope, expansionsFetched: 0, refreshedExpansions, skipped }
}
