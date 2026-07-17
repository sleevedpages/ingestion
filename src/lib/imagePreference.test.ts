import { describe, it, expect } from 'vitest'
import {
  loadImagePreferences,
  preferenceForLabel,
  preferenceForCanonicalGameName,
  type SupportedGamePreference,
} from './imagePreference.js'

// Mirrors the prod tcg_supported_games rows (labels + terms) after mig 0104 seeding.
const ROWS: SupportedGamePreference[] = [
  { label: 'Pokemon',       terms: ['Pokemon'],                       preference: 'tcgplayer' },
  { label: 'Magic',         terms: ['Magic'],                         preference: 'tcgplayer' },
  { label: 'One Piece',     terms: ['One Piece'],                     preference: 'scrydex' },
  { label: 'Gundam',        terms: ['Gundam Card Game', 'Gundam'],    preference: 'scrydex' },
  { label: 'Pokemon Japan', terms: ['Pokemon Japan'],                 preference: 'tcgplayer' },
]

describe('preferenceForLabel (the TCGCSV message key)', () => {
  it('resolves the seeded Bandai games to scrydex', () => {
    expect(preferenceForLabel(ROWS, 'One Piece')).toBe('scrydex')
    expect(preferenceForLabel(ROWS, 'Gundam')).toBe('scrydex')
  })
  it('resolves every other game to tcgplayer', () => {
    expect(preferenceForLabel(ROWS, 'Pokemon')).toBe('tcgplayer')
    expect(preferenceForLabel(ROWS, 'Magic')).toBe('tcgplayer')
  })
  it('defaults an unknown label to tcgplayer (the platform default)', () => {
    expect(preferenceForLabel(ROWS, 'Some Future Game')).toBe('tcgplayer')
  })
  it('is case-insensitive', () => {
    expect(preferenceForLabel(ROWS, 'one piece')).toBe('scrydex')
  })
})

describe('preferenceForCanonicalGameName (canonical_games.name)', () => {
  it('resolves the Bandai canonical names via term match', () => {
    expect(preferenceForCanonicalGameName(ROWS, 'One Piece Card Game')).toBe('scrydex')
    expect(preferenceForCanonicalGameName(ROWS, 'Gundam Card Game')).toBe('scrydex')
  })
  it("resolves 'Pokemon Japan' to its OWN row, not the shorter 'Pokemon' term", () => {
    expect(preferenceForCanonicalGameName(ROWS, 'Pokemon Japan')).toBe('tcgplayer')
  })
  it('exact label match wins over term matching', () => {
    expect(preferenceForCanonicalGameName(ROWS, 'Pokemon')).toBe('tcgplayer')
  })
  it('defaults an unmatched canonical name to tcgplayer', () => {
    expect(preferenceForCanonicalGameName(ROWS, 'Riftbound League of Legends Trading Card Game')).toBe('tcgplayer')
  })
})

describe('loadImagePreferences', () => {
  it('reads enabled rows and normalises the preference column', async () => {
    const db = {
      prepare: (sql: string) => ({
        all: async () => {
          expect(sql).toContain('image_source_preference')
          expect(sql).toContain('enabled = 1')
          return {
            results: [
              { label: 'One Piece', terms: '["One Piece"]', image_source_preference: 'scrydex' },
              { label: 'Pokemon',   terms: '["Pokemon"]',   image_source_preference: 'tcgplayer' },
              { label: 'Broken',    terms: 'not-json',      image_source_preference: 'weird' },
            ],
          }
        },
      }),
    } as any
    const rows = await loadImagePreferences(db)
    expect(rows).toEqual([
      { label: 'One Piece', terms: ['One Piece'], preference: 'scrydex' },
      { label: 'Pokemon',   terms: ['Pokemon'],   preference: 'tcgplayer' },
      { label: 'Broken',    terms: [],            preference: 'tcgplayer' },
    ])
  })
})
