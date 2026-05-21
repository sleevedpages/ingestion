import { getSkrydexSetId } from './skrydexSets.js';

/**
 * Formats a TCGPlayer card_number for use in a Skrydex URL.
 *
 * Rules:
 *  - Strip the "/total" suffix first (e.g. "025/165" → "025")
 *  - Gallery prefixes (TG, GG, SV, PR, etc. — any letters followed by digits):
 *      Keep prefix uppercase, pad the numeric part to 2 digits minimum
 *      e.g. "TG6" → "TG06", "GG001" → "GG001" (already padded), "TG15" → "TG15"
 *  - Normal numeric cards: strip leading zeros
 *      e.g. "025" → "25", "001" → "1", "4" → "4"
 *  - Non-standard strings (already contain letters mid-word, etc.) returned as-is
 */
export function formatSkrydexCardNumber(cardNumber: string): string {
  if (!cardNumber) return cardNumber

  // Strip "/total" suffix
  const base = cardNumber.split('/')[0].trim()
  if (!base) return cardNumber

  // Gallery / special prefix pattern: leading letters followed by digits
  const galleryMatch = base.match(/^([A-Za-z]+)(\d+)$/)
  if (galleryMatch) {
    const prefix = galleryMatch[1].toUpperCase()
    const digits = galleryMatch[2]
    // Pad to at least 2 digits
    const padded = digits.length < 2 ? digits.padStart(2, '0') : digits
    return `${prefix}${padded}`
  }

  // Pure numeric: strip leading zeros, keep at least "0" for "000"
  const numericMatch = base.match(/^(\d+)$/)
  if (numericMatch) {
    return String(parseInt(base, 10))
  }

  // Anything else (already complex): return as-is
  return base
}

/**
 * Builds the Skrydex image URL for a card.
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
