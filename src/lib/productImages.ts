/**
 * productImages.ts — canonical product_images write helpers (Session D)
 *
 * The worker's image pipeline used to write tcg_products.image_url / image_source.
 * Canonical splits images into product_images:
 *   - r2_url      : the mirrored R2 url (https://images.sleevedpages.com/...)
 *   - source_url  : the original (non-R2) CDN url (TCGPlayer / Scrydex CDN, pre-mirror)
 *   - source      : 'scrydex' | 'tcgplayer' | NULL
 *   - mirrored_at : ISO timestamp set when an R2 url is written
 *
 * All writes key on the CANONICAL products.id, resolved by tcgplayer_product_id (or
 * group+number for the card-level/fallback paths). They use INSERT ... SELECT so an
 * unresolved product simply inserts zero rows (no NOT NULL violation) — and rely on
 * the UNIQUE(product_id) index from migration 0063 for ON CONFLICT merge-upserts.
 *
 * MERGE semantics: each write only touches its own columns; the other url column is
 * never clobbered (an R2 write preserves a previously-written source_url and vice
 * versa). `source` is COALESCE-preserved on the source_url paths so a NULL source
 * (the all-other-games card-level path) never nulls an existing source.
 */

// R2 write WITH an explicit source (mirror paths: 'scrydex' | 'tcgplayer').
const R2_WITH_SOURCE_SQL = `
  INSERT INTO product_images (product_id, source, r2_url, mirrored_at)
  SELECT id, ?, ?, ? FROM products WHERE tcgplayer_product_id = ?
  ON CONFLICT (product_id) DO UPDATE SET
    source      = excluded.source,
    r2_url      = excluded.r2_url,
    mirrored_at = excluded.mirrored_at`

// R2 write WITHOUT touching source (backfill path: original source is unknown).
const R2_PRESERVE_SOURCE_SQL = `
  INSERT INTO product_images (product_id, r2_url, mirrored_at)
  SELECT id, ?, ? FROM products WHERE tcgplayer_product_id = ?
  ON CONFLICT (product_id) DO UPDATE SET
    r2_url      = excluded.r2_url,
    mirrored_at = excluded.mirrored_at`

// Pre-mirror source_url write by TCGPlayer product id. `source` is COALESCE-preserved.
const SOURCE_URL_BY_PID_SQL = `
  INSERT INTO product_images (product_id, source, source_url)
  SELECT id, ?, ? FROM products WHERE tcgplayer_product_id = ?
  ON CONFLICT (product_id) DO UPDATE SET
    source_url = excluded.source_url,
    source     = COALESCE(excluded.source, product_images.source)`

// Pre-mirror source_url write by group + card number (card-level / fallback paths).
// May match multiple product rows (variants sharing a number) — each upserts its own
// product_images row. `source` is COALESCE-preserved.
const SOURCE_URL_BY_GROUP_NUMBER_SQL = `
  INSERT INTO product_images (product_id, source, source_url)
  SELECT p.id, ?, ?
  FROM   products p
  JOIN   sets s ON p.set_id = s.id
  WHERE  s.tcgplayer_group_id = ?
  AND    LOWER(p.number) = LOWER(?)
  ON CONFLICT (product_id) DO UPDATE SET
    source_url = excluded.source_url,
    source     = COALESCE(excluded.source, product_images.source)`

/** Build an R2 upsert statement keyed by TCGPlayer product id.
 *  Pass `source` to set it; pass null to preserve any existing source (backfill). */
export function r2ImageUpsert(
  db:           D1Database,
  tcgProductId: number,
  r2Url:        string,
  source:       'scrydex' | 'tcgplayer' | null,
  mirroredAt:   string = new Date().toISOString(),
): D1PreparedStatement {
  return source
    ? db.prepare(R2_WITH_SOURCE_SQL).bind(source, r2Url, mirroredAt, tcgProductId)
    : db.prepare(R2_PRESERVE_SOURCE_SQL).bind(r2Url, mirroredAt, tcgProductId)
}

/** Run an R2 upsert immediately (single-product mirror / upload paths). */
export async function writeR2Image(
  db:           D1Database,
  tcgProductId: number,
  r2Url:        string,
  source:       'scrydex' | 'tcgplayer' | null,
): Promise<void> {
  await r2ImageUpsert(db, tcgProductId, r2Url, source).run()
}

/** Build a pre-mirror source_url upsert keyed by TCGPlayer product id. */
export function sourceUrlUpsertByProductId(
  db:           D1Database,
  tcgProductId: number,
  sourceUrl:    string,
  source:       'scrydex' | 'tcgplayer' | null,
): D1PreparedStatement {
  return db.prepare(SOURCE_URL_BY_PID_SQL).bind(source, sourceUrl, tcgProductId)
}

/** Build a pre-mirror source_url upsert keyed by TCGPlayer group id + card number. */
export function sourceUrlUpsertByGroupNumber(
  db:        D1Database,
  groupId:   number,
  cardNumber:string,
  sourceUrl: string,
  source:    'scrydex' | 'tcgplayer' | null,
): D1PreparedStatement {
  return db.prepare(SOURCE_URL_BY_GROUP_NUMBER_SQL).bind(source, sourceUrl, groupId, cardNumber)
}
