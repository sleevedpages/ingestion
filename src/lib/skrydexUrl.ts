import { getSkrydexSetId } from './skrydexSets.js';

// ─── Pokémon ─────────────────────────────────────────────────────────────────

/**
 * Formats a TCGPlayer card_number for use in a Pokémon Skrydex URL.
 *
 * Rules:
 *  - Strip "/total" suffix  (e.g. "025/165" → "025")
 *  - TG / GG gallery cards: keep prefix uppercase, pad numeric part to 2 digits
 *      e.g. "TG6" → "TG06",  "GG1" → "GG01",  "TG15" → "TG15"
 *  - All other alpha prefixes (RC, SV, PR, …): keep prefix uppercase, use
 *      the raw digit string — no zero-padding
 *      e.g. "RC3/RC32" → "RC3",  "RC10" → "RC10"
 *  - Pure numeric cards: strip leading zeros
 *      e.g. "025" → "25",  "001" → "1"
 */
export function formatSkrydexCardNumber(cardNumber: string): string {
  if (!cardNumber) return cardNumber

  const base = cardNumber.split('/')[0].trim()
  if (!base) return cardNumber

  // Letter-prefix pattern: "TG06", "RC3", "GG01", etc.
  const galleryMatch = base.match(/^([A-Za-z]+)(\d+)$/)
  if (galleryMatch) {
    const prefix = galleryMatch[1].toUpperCase()
    const digits = galleryMatch[2]
    // Only TG and GG use 2-digit padding on Skrydex.
    // RC (Radiant Collection), SV, PR and others use the raw number.
    const padded = (prefix === 'TG' || prefix === 'GG') && digits.length < 2
      ? digits.padStart(2, '0')
      : digits
    return `${prefix}${padded}`
  }

  // Pure numeric: strip leading zeros
  if (/^\d+$/.test(base)) {
    return String(parseInt(base, 10))
  }

  return base
}

/**
 * Builds the Skrydex image URL for a Pokémon card.
 * Returns null if either argument is falsy.
 */
export function buildSkrydexImageUrl(
  skrydexSetId: string,
  cardNumber: string
): string | null {
  if (!skrydexSetId || !cardNumber) return null
  const num = formatSkrydexCardNumber(cardNumber)
  return `https://images.scrydex.com/pokemon/${skrydexSetId}-${num}/large`
}

/**
 * Convenience: resolves skrydexSetId from the TCGPlayer set name first.
 * Returns null if the set name is not in our map.
 */
export function buildSkrydexImageUrlFromSetName(
  setName: string,
  cardNumber: string
): string | null {
  const setId = getSkrydexSetId(setName)
  if (!setId) return null
  return buildSkrydexImageUrl(setId, cardNumber)
}

// One Piece Scrydex support is pending — alternate card versions use unique
// identifiers that don't map cleanly to TCGPlayer card numbers.
