/**
 * imagePreference.ts — per-game image source preference (Content migration 0104)
 *
 * Operator decision 2026-07-17: TCGPlayer/TCGCSV is the PREFERRED image source
 * platform-wide; the Bandai-published games (One Piece, Gundam — TCGPlayer art
 * carries a customer-facing SAMPLE watermark) are 'scrydex'-preferred. The flag
 * lives on tcg_supported_games.image_source_preference so a FUTURE Bandai title
 * is one admin config row, never a deploy.
 *
 * Consumers:
 *  - TCGCSV group consumer (ingestion/db.ts upsertProductSourceImages): resolves
 *    the preference by the message's tcgLabel (an exact tcg_supported_games.label)
 *    and passes it to the source_url writer.
 *  - syncScrydexImages / the scrydex image repair job: resolve by CANONICAL game
 *    name (canonical_games.name, e.g. 'One Piece Card Game') via label/term
 *    matching, and process ONLY 'scrydex'-preferred games.
 *
 * The 0104 migration is BLOCKING for the worker deploy — loadImagePreferences
 * deliberately does NOT catch a missing-column error (fail-closed: an unmigrated
 * DB should fail loudly, not silently fall back to overwriting Bandai art).
 */

import type { ImageSourcePreference } from './productImages.js'

export interface SupportedGamePreference {
  label: string
  terms: string[]
  preference: ImageSourcePreference
}

/** Load every ENABLED supported game's image preference (one small query). */
export async function loadImagePreferences(db: D1Database): Promise<SupportedGamePreference[]> {
  const { results } = await db
    .prepare(
      'SELECT label, terms, image_source_preference FROM tcg_supported_games WHERE enabled = 1'
    )
    .all<{ label: string; terms: string; image_source_preference: string }>()
  return results.map((r) => ({
    label: r.label,
    terms: safeTerms(r.terms),
    preference: r.image_source_preference === 'scrydex' ? 'scrydex' : 'tcgplayer',
  }))
}

function safeTerms(json: string): string[] {
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === 'string') : []
  } catch {
    return []
  }
}

/** Preference for an exact tcg_supported_games.label (the TCGCSV message key).
 *  Unknown label → 'tcgplayer' (the platform default). */
export function preferenceForLabel(
  rows: SupportedGamePreference[],
  label: string
): ImageSourcePreference {
  const row = rows.find((r) => r.label.toLowerCase() === label.toLowerCase())
  return row?.preference ?? 'tcgplayer'
}

/**
 * Preference for a CANONICAL game name (canonical_games.name). Exact label match
 * wins; otherwise the row with the LONGEST term that is a substring of the name
 * (so 'Pokemon Japan' resolves to the 'Pokemon Japan' row, not 'Pokemon').
 * No match → 'tcgplayer' (the platform default).
 */
export function preferenceForCanonicalGameName(
  rows: SupportedGamePreference[],
  canonicalName: string
): ImageSourcePreference {
  const nameLower = canonicalName.toLowerCase()

  const exact = rows.find((r) => r.label.toLowerCase() === nameLower)
  if (exact) return exact.preference

  let best: { preference: ImageSourcePreference; termLen: number } | null = null
  for (const row of rows) {
    for (const term of row.terms) {
      const t = term.toLowerCase()
      if (t && nameLower.includes(t) && (!best || t.length > best.termLen)) {
        best = { preference: row.preference, termLen: t.length }
      }
    }
  }
  return best?.preference ?? 'tcgplayer'
}
