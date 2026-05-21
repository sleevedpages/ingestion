/**
 * Preferred price subtype priority per TCG.
 *
 * TCGCSV returns one price row per (productId, subTypeName) pair, so cards
 * like a Pokemon Holofoil have separate Normal, Holofoil, and Reverse Holofoil
 * rows. When the app layer needs to surface a single "default" price per card
 * (e.g. search results, binder value totals), use this priority list to pick
 * the most representative variant.
 *
 * Usage in the app (PostgreSQL example):
 *
 *   SELECT DISTINCT ON (p.tcgplayer_product_id)
 *     c.name, p.market_price, p.sub_type_name
 *   FROM tcg_prices p
 *   JOIN tcg_products c ON c.tcgplayer_product_id = p.tcgplayer_product_id
 *   JOIN tcg_categories cat ON cat.tcgplayer_category_id = c.tcgplayer_category_id
 *   ORDER BY
 *     p.tcgplayer_product_id,
 *     CASE cat.name
 *       WHEN 'Pokemon' THEN
 *         CASE p.sub_type_name
 *           WHEN 'Holofoil'              THEN 1
 *           WHEN 'Normal'               THEN 2
 *           WHEN '1st Edition Holofoil' THEN 3
 *           WHEN 'Reverse Holofoil'     THEN 4
 *           ELSE 99
 *         END
 *       ELSE
 *         CASE p.sub_type_name WHEN 'Normal' THEN 1 ELSE 99 END
 *     END;
 */

export type PriceSubTypePriority = Record<string, readonly string[]>;

export async function loadPriceConfig(db: D1Database): Promise<PriceSubTypePriority> {
  const { results } = await db
    .prepare('SELECT label, price_priority FROM tcg_supported_games WHERE enabled = 1')
    .all<{ label: string; price_priority: string }>();
  const config: PriceSubTypePriority = {};
  for (const row of results) {
    config[row.label] = JSON.parse(row.price_priority) as string[];
  }
  return config;
}

export const PRICE_SUB_TYPE_PRIORITY: PriceSubTypePriority = {
  // Holofoil is the collectible version; Normal is the fallback for non-holo cards.
  Pokemon:    ['Holofoil', 'Normal', '1st Edition Holofoil', 'Reverse Holofoil'],
  // Magic cards are almost always just "Normal"; foil is a distinct product.
  Magic:      ['Normal', 'Foil'],
  'One Piece': ['Normal'],
  Gundam:     ['Normal'],
};

/**
 * Returns the first sub_type_name from the priority list that exists in
 * `available`, or falls back to the first available subtype, or null.
 */
export function pickPreferredSubType(
  tcgLabel: string,
  available: string[]
): string | null {
  if (available.length === 0) return null;
  const priority = PRICE_SUB_TYPE_PRIORITY[tcgLabel] ?? ['Normal'];
  for (const subType of priority) {
    if (available.includes(subType)) return subType;
  }
  return available[0];
}
