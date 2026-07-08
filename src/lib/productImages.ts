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
 *
 * SOURCE_URL PRECEDENCE (WP-1, audit IMG-2 — the daily-TCGCSV-clobber fix):
 * source_url writes resolve through ONE precedence rule (scrydex > tcgplayer),
 * encoded once in SOURCE_URL_PRECEDENCE_CASE below and mirrored 1:1 by the pure
 * resolveSourceUrl() (the unit-tested spec). An incoming URL replaces the stored
 * one ONLY when it doesn't lose quality:
 *   1. an incoming Scrydex-CDN URL always wins (highest-quality per-variant art;
 *      a Scrydex→Scrydex refresh is also allowed through);
 *   2. an empty/NULL stored URL is always filled;
 *   3. a stored TCGPlayer-CDN URL may be replaced by anything (lowest rank);
 *   4. otherwise the stored URL is PRESERVED — the daily TCGCSV sync (which only
 *      ever carries tcgplayer-cdn URLs) can never clobber a Scrydex CDN URL again.
 * Do NOT re-inline `source_url = excluded.source_url` in any writer.
 */

// Host fragments used to rank a source_url. Kept as plain substrings so the SQL
// LIKE patterns and the JS mirror classify identically.
export const SCRYDEX_IMAGE_HOST  = 'images.scrydex.com/'
export const TCGPLAYER_CDN_HOST  = 'tcgplayer-cdn.tcgplayer.com/'

/** True when the url serves from the Scrydex image CDN (rank: highest). */
export function isScrydexImageUrl(url: string | null | undefined): boolean {
  return typeof url === 'string' && url.toLowerCase().includes(SCRYDEX_IMAGE_HOST)
}

/** True when the url serves from the TCGPlayer CDN (rank: lowest — replaceable). */
export function isTcgplayerCdnUrl(url: string | null | undefined): boolean {
  return typeof url === 'string' && url.toLowerCase().includes(TCGPLAYER_CDN_HOST)
}

/**
 * Pure JS mirror of SOURCE_URL_PRECEDENCE_CASE — the testable spec of the
 * precedence rule. Returns the url the row should hold after an upsert of
 * `incoming` over `existing`. Keep in exact step with the SQL fragment.
 */
export function resolveSourceUrl(existing: string | null | undefined, incoming: string): string {
  if (isScrydexImageUrl(incoming))       return incoming   // scrydex always wins
  if (!existing || existing === '')      return incoming   // fill an empty slot
  if (isTcgplayerCdnUrl(existing))       return incoming   // tcgplayer is replaceable
  return existing                                          // never downgrade
}

// The ONE SQL encoding of the precedence rule, interpolated into every
// source_url conflict clause (never hand-rolled per statement). Branch order
// matches resolveSourceUrl() exactly. LIKE is case-insensitive for ASCII in
// SQLite, matching the toLowerCase() in the JS mirror.
export const SOURCE_URL_PRECEDENCE_CASE = `CASE
      WHEN excluded.source_url LIKE '%${SCRYDEX_IMAGE_HOST}%'                 THEN excluded.source_url
      WHEN product_images.source_url IS NULL OR product_images.source_url = '' THEN excluded.source_url
      WHEN product_images.source_url LIKE '%${TCGPLAYER_CDN_HOST}%'           THEN excluded.source_url
      ELSE product_images.source_url
    END`

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

// Pre-mirror source_url write by TCGPlayer product id. `source` is COALESCE-preserved;
// source_url resolves through the WP-1 precedence rule (scrydex > tcgplayer).
const SOURCE_URL_BY_PID_SQL = `
  INSERT INTO product_images (product_id, source, source_url)
  SELECT id, ?, ? FROM products WHERE tcgplayer_product_id = ?
  ON CONFLICT (product_id) DO UPDATE SET
    source_url = ${SOURCE_URL_PRECEDENCE_CASE},
    source     = COALESCE(excluded.source, product_images.source)`

// Pre-mirror source_url write by group + card number (card-level / fallback paths).
// May match multiple product rows (variants sharing a number) — each upserts its own
// product_images row. `source` is COALESCE-preserved; source_url resolves through the
// WP-1 precedence rule (scrydex > tcgplayer).
const SOURCE_URL_BY_GROUP_NUMBER_SQL = `
  INSERT INTO product_images (product_id, source, source_url)
  SELECT p.id, ?, ?
  FROM   products p
  JOIN   sets s ON p.set_id = s.id
  WHERE  s.tcgplayer_group_id = ?
  AND    LOWER(p.number) = LOWER(?)
  ON CONFLICT (product_id) DO UPDATE SET
    source_url = ${SOURCE_URL_PRECEDENCE_CASE},
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

// Mirror-attempt bookkeeping (WP-2, audit IMG-4): every mirror attempt — success,
// failure, or skip — bumps the counter + timestamp so the candidate query can apply
// an attempt ceiling + exponential backoff instead of retrying the same poison rows
// forever. Requires Content migration 0086 (mirror_attempts / mirror_last_attempt_at).
const MIRROR_ATTEMPT_SQL = `
  INSERT INTO product_images (product_id, mirror_attempts, mirror_last_attempt_at)
  SELECT id, 1, ? FROM products WHERE tcgplayer_product_id = ?
  ON CONFLICT (product_id) DO UPDATE SET
    mirror_attempts        = product_images.mirror_attempts + 1,
    mirror_last_attempt_at = excluded.mirror_last_attempt_at`

/** Build a mirror-attempt bookkeeping upsert keyed by TCGPlayer product id. */
export function mirrorAttemptUpsert(
  db:           D1Database,
  tcgProductId: number,
  attemptedAt:  string = new Date().toISOString(),
): D1PreparedStatement {
  return db.prepare(MIRROR_ATTEMPT_SQL).bind(attemptedAt, tcgProductId)
}

// ── Placeholder repair (card-back guard: mirror-side + purge sweep) ───────────
// A Scrydex card-back placeholder was detected — either by the mirror before an R2
// write, or by the purge-placeholder-mirrors sweep over an existing R2 object. Point
// the row at the reconstructed TCGplayer CDN image and clear the mirror state so the
// app serves real art via the `r2_url ?? source_url` chain (end-user browsers load
// tcgplayer-cdn fine; only worker datacenter IPs 403). This FORCES source_url —
// unlike the precedence-guarded writers — because the stored value is a Scrydex-CDN
// placeholder URL that SOURCE_URL_PRECEDENCE_CASE would otherwise preserve. `source`
// is set NULL to match a plain TCGCSV-only source_url row (what the TCGCSV writer
// would leave). mirrored_at is NEVER stamped on a repair (standing rule).
const PLACEHOLDER_REPAIR_SQL = `
  INSERT INTO product_images (product_id, source, source_url, r2_url, mirrored_at)
  SELECT id, NULL, ?, NULL, NULL FROM products WHERE tcgplayer_product_id = ?
  ON CONFLICT (product_id) DO UPDATE SET
    source_url  = excluded.source_url,
    source      = NULL,
    r2_url      = NULL,
    mirrored_at = NULL`

/** Build a forced placeholder-repair upsert: source_url → the reconstructed
 *  TCGplayer URL, r2_url/mirrored_at/source cleared. Used by the mirror's
 *  placeholder fallback AND the purge-placeholder-mirrors sweep. */
export function placeholderRepairUpsert(
  db:           D1Database,
  tcgProductId: number,
  tcgplayerUrl: string,
): D1PreparedStatement {
  return db.prepare(PLACEHOLDER_REPAIR_SQL).bind(tcgplayerUrl, tcgProductId)
}

// Force source_url WITHOUT touching r2_url/source/mirrored_at — used after a
// SUCCESSFUL TCGplayer fallback mirror so the pre-mirror source_url no longer points
// at the Scrydex placeholder (r2_url already wins in serving; this keeps source_url
// honest too). Precedence-bypassing on purpose.
const FORCE_SOURCE_URL_SQL = `
  INSERT INTO product_images (product_id, source_url)
  SELECT id, ? FROM products WHERE tcgplayer_product_id = ?
  ON CONFLICT (product_id) DO UPDATE SET source_url = excluded.source_url`

/** Build a forced source_url upsert (bypasses the precedence rule). */
export function forceSourceUrlUpsert(
  db:           D1Database,
  tcgProductId: number,
  url:          string,
): D1PreparedStatement {
  return db.prepare(FORCE_SOURCE_URL_SQL).bind(url, tcgProductId)
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
