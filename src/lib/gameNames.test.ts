import { describe, it, expect } from 'vitest'
import { GAME_SLUG_BY_CANONICAL_NAME, scrydexSlugForGame, isEnglishPokemon } from './gameNames.js'

// Drift anchor: these are the EXACT canonical_games.name strings, verified against
// prod D1 on 2026-07-07 (WP-3, audit IMG-5). If a canonical game is ever renamed,
// this test forces the map (and this list) to be re-verified together.
const VERIFIED_CANONICAL_NAMES = [
  'Pokemon',
  'Magic',
  'One Piece Card Game',
  'Gundam Card Game',
  'Pokemon Japan',
  'Lorcana TCG',
  'Riftbound League of Legends Trading Card Game',
  'Digimon Card Game',
  'Dragon Ball Z TCG',
  'YuGiOh',
  'Flesh & Blood TCG',
]

describe('GAME_SLUG_BY_CANONICAL_NAME — WP-3 canonical keys', () => {
  it('keys the six Scrydex-covered games by their EXACT canonical names', () => {
    expect(GAME_SLUG_BY_CANONICAL_NAME).toEqual({
      'Pokemon':                                       'pokemon',
      'Magic':                                         'magicthegathering',
      'One Piece Card Game':                           'onepiece',
      'Gundam Card Game':                              'gundam',
      'Lorcana TCG':                                   'lorcana',
      'Riftbound League of Legends Trading Card Game': 'riftbound',
    })
  })

  it('every map key is a real canonical game name (no orphan keys like the old "Lorcana")', () => {
    for (const key of Object.keys(GAME_SLUG_BY_CANONICAL_NAME)) {
      expect(VERIFIED_CANONICAL_NAMES).toContain(key)
    }
  })

  it('the IMG-5 regression keys are gone and resolve to nothing', () => {
    expect(scrydexSlugForGame('Lorcana')).toBeUndefined()
    expect(scrydexSlugForGame('Riftbound')).toBeUndefined()
    expect(scrydexSlugForGame('Lorcana TCG')).toBe('lorcana')
    expect(scrydexSlugForGame('Riftbound League of Legends Trading Card Game')).toBe('riftbound')
  })

  it('Pokemon Japan is DELIBERATELY unmapped (IMG-6 — no English-slug JP fetches)', () => {
    expect(scrydexSlugForGame('Pokemon Japan')).toBeUndefined()
  })

  it('null/undefined/unknown are safe', () => {
    expect(scrydexSlugForGame(null)).toBeUndefined()
    expect(scrydexSlugForGame(undefined)).toBeUndefined()
    expect(scrydexSlugForGame('YuGiOh')).toBeUndefined()
  })
})

describe('isEnglishPokemon — WP-3 / IMG-6 JP exclusion', () => {
  it('matches English Pokémon incl. accented spellings', () => {
    expect(isEnglishPokemon('Pokemon')).toBe(true)
    expect(isEnglishPokemon('Pokémon')).toBe(true)
    expect(isEnglishPokemon('POKEMON')).toBe(true)
  })
  it('excludes Pokemon Japan in any casing', () => {
    expect(isEnglishPokemon('Pokemon Japan')).toBe(false)
    expect(isEnglishPokemon('Pokémon Japan')).toBe(false)
    expect(isEnglishPokemon('pokemon japan')).toBe(false)
  })
  it('rejects other games and null', () => {
    expect(isEnglishPokemon('Magic')).toBe(false)
    expect(isEnglishPokemon(null)).toBe(false)
    expect(isEnglishPokemon(undefined)).toBe(false)
    expect(isEnglishPokemon('')).toBe(false)
  })
})
