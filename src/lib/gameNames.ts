/**
 * gameNames.ts — the ONE canonical-game-name → Scrydex-slug map (WP-3, audit IMG-5).
 *
 * Keys MUST be the EXACT `canonical_games.name` strings. Verified against prod D1
 * (`SELECT name FROM canonical_games`, 2026-07-07):
 *   Pokemon · Magic · One Piece Card Game · Gundam Card Game · Pokemon Japan ·
 *   Lorcana TCG · Riftbound League of Legends Trading Card Game ·
 *   Digimon Card Game · Dragon Ball Z TCG · YuGiOh · Flesh & Blood TCG
 *
 * The pre-WP-3 keys 'Lorcana' / 'Riftbound' matched NOTHING (exact-key lookup →
 * `continue`), silently excluding both games from the Scrydex image sync forever
 * (IMG-5). 'Pokemon Japan' is DELIBERATELY absent: Scrydex's `pokemon` slug is the
 * ENGLISH catalogue — constructing English URLs for JP cards mirrors the wrong art
 * (IMG-6). A JP slug would need its own end-to-end wiring before being added here.
 *
 * Import this map — never re-declare canonical-name keys locally (that drift is
 * exactly what broke Lorcana/Riftbound).
 */
export const GAME_SLUG_BY_CANONICAL_NAME: Record<string, string> = {
  'Pokemon':                                        'pokemon',
  'Magic':                                          'magicthegathering',
  'One Piece Card Game':                            'onepiece',
  'Gundam Card Game':                               'gundam',
  'Lorcana TCG':                                    'lorcana',
  'Riftbound League of Legends Trading Card Game':  'riftbound',
}

/** Scrydex slug for a canonical game name; undefined = no Scrydex coverage. */
export function scrydexSlugForGame(canonicalName: string | null | undefined): string | undefined {
  if (!canonicalName) return undefined
  return GAME_SLUG_BY_CANONICAL_NAME[canonicalName]
}

/**
 * True when the canonical game is ENGLISH Pokémon — the only game the mirror may
 * construct Scrydex CDN URLs for. Accent-tolerant, and EXCLUDES 'Pokemon Japan'
 * (WP-3 / IMG-6: the JP catalogue must never ride the English URL scheme).
 * Keep in step with the SQL predicate in image-mirror.ts (mirrorCandidateWhere).
 */
export function isEnglishPokemon(categoryName: string | null | undefined): boolean {
  if (!categoryName) return false
  const n = categoryName.toLowerCase().replace(/é/g, 'e')
  return n.includes('pokemon') && !n.includes('japan')
}
