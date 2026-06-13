import type {
  TcgCategoryRow,
  TcgSetRow,
  TcgProductRow,
  TcgPriceRow,
  SyncStatus,
} from '../types/db.js';
import { sourceUrlUpsertByProductId } from '../lib/productImages.js';

// D1 batch() is limited to 100 statements per call
const BATCH_SIZE = 100;

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function iso(d: Date): string {
  return d.toISOString();
}

// Canonical prices.fetched_at is unix epoch seconds (the old tcg_prices.synced_at was ISO text).
function unix(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

// ===========================================================================
// CANONICAL WRITERS (Session D)
// ---------------------------------------------------------------------------
// The worker now writes the canonical model (canonical_games / sets / products /
// prices) instead of the old tcg_* tables. Each canonical table mints its own
// AUTOINCREMENT `id`; FKs are resolved by sub-select on the external UNIQUE keys
// (tcgplayer_category_id / tcgplayer_group_id / tcgplayer_product_id). The old
// tcg_* tables are intentionally left in place (rollback path; dropped in the
// final rebuild session). See Ingestion/INGESTION_AUDIT.md §2 / §8a.
// ===========================================================================

// ---------------------------------------------------------------------------
// Category -> canonical_games  (W1; resolve/mint by tcgplayer_category_id)
// ---------------------------------------------------------------------------
// Drops display_name/modified_on/image_url/seo_text/is_direct_brand (no canonical
// home). Does NOT write card_back_url — that column is owned by the app `games`
// table, not TCGCSV. is_active uses the table default (1) on insert and is
// preserved on conflict.

export async function upsertCategory(
  db: D1Database,
  row: TcgCategoryRow
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO canonical_games (name, tcgplayer_category_id)
       VALUES (?, ?)
       ON CONFLICT (tcgplayer_category_id) DO UPDATE SET
         name = excluded.name`
    )
    .bind(row.name, row.tcgplayer_category_id)
    .run();
}

// ---------------------------------------------------------------------------
// Set
// ---------------------------------------------------------------------------

// Set -> sets  (W2; resolve/mint by tcgplayer_group_id)
// game_id resolves canonical_games.id from the category (the orchestrator upserts
// canonical_games before any set, so the sub-select always resolves).
// code<-abbreviation, release_date<-published_on, scrydex_expansion_id<-scrydex_set_id.
// Replicates the preserve-on-conflict COALESCE for scrydex_expansion_id so a
// manually/weekly-set mapping (W12) is never clobbered by a null from TCGCSV.
// Drops modified_on / is_supplemental (no canonical home).
const SET_SQL = `
  INSERT INTO sets
    (game_id, name, code, release_date, tcgplayer_group_id, scrydex_expansion_id)
  VALUES (
    (SELECT id FROM canonical_games WHERE tcgplayer_category_id = ?),
    ?, ?, ?, ?, ?)
  ON CONFLICT (tcgplayer_group_id) DO UPDATE SET
    game_id              = excluded.game_id,
    name                 = excluded.name,
    code                 = excluded.code,
    release_date         = excluded.release_date,
    scrydex_expansion_id = COALESCE(sets.scrydex_expansion_id, excluded.scrydex_expansion_id)`;

function bindSet(db: D1Database, row: TcgSetRow) {
  return db.prepare(SET_SQL).bind(
    row.tcgplayer_category_id,
    row.name,
    row.abbreviation,
    row.published_on ? iso(row.published_on) : null,
    row.tcgplayer_group_id,
    row.scrydex_set_id ?? null
  );
}

export async function upsertSet(db: D1Database, row: TcgSetRow): Promise<void> {
  await bindSet(db, row).run();
}

export async function upsertSetsBatch(
  db: D1Database,
  rows: TcgSetRow[]
): Promise<void> {
  if (rows.length === 0) return;
  for (const batch of chunk(rows, BATCH_SIZE)) {
    await db.batch(batch.map((r) => bindSet(db, r)));
  }
}

// ---------------------------------------------------------------------------
// Products — bulk upsert via batch()
// ---------------------------------------------------------------------------

// Product -> products  (W3; resolve/mint by tcgplayer_product_id)
// set_id resolves sets.id from the group (sets are batch-upserted before any
// group's products run). number<-card_number; product_kind derived from isCard()
// (a card has a Number or Rarity -> here: card_number or rarity present).
// Leaves variant_kind / finish / scrydex_card_id untouched (NULL — Session D-bis).
// products carries no image column: the TCGPlayer original image url is relocated to
// product_images.source_url by upsertProductSourceImages() (called right after this in
// processGroupInline). Drops clean_name / tcgplayer_url / modified_on / image_count /
// presale_info / extended_data (no canonical home).
const PRODUCT_SQL = `
  INSERT INTO products
    (set_id, name, number, rarity, product_kind, tcgplayer_product_id)
  VALUES (
    (SELECT id FROM sets WHERE tcgplayer_group_id = ?),
    ?, ?, ?, ?, ?)
  ON CONFLICT (tcgplayer_product_id) DO UPDATE SET
    set_id       = excluded.set_id,
    name         = excluded.name,
    number       = excluded.number,
    rarity       = excluded.rarity,
    product_kind = excluded.product_kind`;

// Derive product_kind without re-reading extendedData: transformProduct already
// extracted card_number (extendedData "Number") and rarity (extendedData "Rarity"),
// and isCard() == (has Number OR Rarity). So a row with either field present is a
// 'card'; everything else (sealed product, accessories) is 'sealed'.
function productKind(row: TcgProductRow): 'card' | 'sealed' {
  return row.card_number != null || row.rarity != null ? 'card' : 'sealed';
}

export async function upsertProducts(
  db: D1Database,
  rows: TcgProductRow[]
): Promise<number> {
  if (rows.length === 0) return 0;
  for (const batch of chunk(rows, BATCH_SIZE)) {
    await db.batch(
      batch.map((r) =>
        db.prepare(PRODUCT_SQL).bind(
          r.tcgplayer_group_id,
          r.name,
          r.card_number,
          r.rarity,
          productKind(r),
          r.tcgplayer_product_id
        )
      )
    );
  }
  return rows.length;
}

// TCGCSV product image -> product_images.source_url  (relocates the old
// tcg_products.image_url write — canonical `products` has no image column).
// This is the TCGPlayer ORIGINAL CDN url; the R2 mirror later fetches it and writes
// product_images.r2_url. `source` is left NULL here (pre-mirror) so the row stays
// mirror-eligible (the re-mirror predicate treats r2_url NULL + source NULL as
// "never mirrored"). The merge-upsert never touches r2_url, so an already-mirrored
// row keeps its R2 url + source. MUST run AFTER upsertProducts (resolves products.id
// by tcgplayer_product_id via INSERT ... SELECT — an unresolved product writes 0 rows).
export async function upsertProductSourceImages(
  db: D1Database,
  rows: TcgProductRow[]
): Promise<void> {
  const withImage = rows.filter((r) => r.image_url);
  if (withImage.length === 0) return;
  for (const batch of chunk(withImage, BATCH_SIZE)) {
    await db.batch(
      batch.map((r) =>
        sourceUrlUpsertByProductId(db, r.tcgplayer_product_id, r.image_url as string, null)
      )
    );
  }
}

// ---------------------------------------------------------------------------
// Prices — bulk upsert via batch()
// ---------------------------------------------------------------------------

// Price -> prices  (W4; source='tcgplayer'; resolve product_id by tcgplayer_product_id)
// finish<-sub_type_name; condition/grade NULL (TCGPlayer market prices are not
// per-condition); value<-market_price (canonical value is market-only — low/mid/
// high/direct_low are dropped). fetched_at<-synced_at as unix epoch.
// Conflict target is the uq_prices_identity expression index
// (product_id, source, COALESCE(condition,''), COALESCE(finish,''), COALESCE(grade,'')).
// REQUIRES products for these rows to already exist (the orchestrator/consumer now
// upserts products BEFORE prices — see processGroupInline). A NULL product_id from
// an unresolved sub-select would violate the NOT NULL FK; the sequencing guarantees it.
const PRICE_SQL = `
  INSERT INTO prices
    (product_id, source, condition, finish, grade, value, fetched_at)
  VALUES (
    (SELECT id FROM products WHERE tcgplayer_product_id = ?),
    'tcgplayer', NULL, ?, NULL, ?, ?)
  ON CONFLICT (product_id, source, COALESCE(condition,''), COALESCE(finish,''), COALESCE(grade,''))
  DO UPDATE SET
    value      = excluded.value,
    fetched_at = excluded.fetched_at`;

export async function upsertPrices(
  db: D1Database,
  rows: TcgPriceRow[]
): Promise<number> {
  if (rows.length === 0) return 0;
  for (const batch of chunk(rows, BATCH_SIZE)) {
    await db.batch(
      batch.map((r) =>
        db.prepare(PRICE_SQL).bind(
          r.tcgplayer_product_id,
          r.sub_type_name,
          r.market_price,
          unix(r.synced_at)
        )
      )
    );
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Sync log
// ---------------------------------------------------------------------------

export async function createSyncLog(db: D1Database): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO tcg_sync_log (started_at, status) VALUES (?, 'running')`
    )
    .bind(new Date().toISOString())
    .run();
  return result.meta.last_row_id as number;
}

export async function updateSyncLog(
  db: D1Database,
  id: number,
  status: SyncStatus,
  fields: {
    tcgsProcessed?: string[];
    setsProcessed?: number;
    productsUpserted?: number;
    pricesUpserted?: number;
    errorMessage?: string;
  }
): Promise<void> {
  await db
    .prepare(
      `UPDATE tcg_sync_log SET
         completed_at      = ?,
         status            = ?,
         tcgs_processed    = ?,
         sets_processed    = ?,
         products_upserted = ?,
         prices_upserted   = ?,
         error_message     = ?
       WHERE id = ?`
    )
    .bind(
      new Date().toISOString(),
      status,
      fields.tcgsProcessed ? JSON.stringify(fields.tcgsProcessed) : null,
      fields.setsProcessed ?? null,
      fields.productsUpserted ?? null,
      fields.pricesUpserted ?? null,
      fields.errorMessage ?? null,
      id
    )
    .run();
}

export async function getLastSuccessfulSync(
  db: D1Database
): Promise<Date | null> {
  const row = await db
    .prepare(
      `SELECT completed_at FROM tcg_sync_log
       WHERE status = 'success'
       ORDER BY completed_at DESC
       LIMIT 1`
    )
    .first<{ completed_at: string }>();
  return row?.completed_at ? new Date(row.completed_at) : null;
}

// Called by the orchestrator after all group messages are enqueued.
export async function setGroupsEnqueued(
  db: D1Database,
  id: number,
  groupsEnqueued: number,
  tcgsProcessed: string[]
): Promise<void> {
  await db
    .prepare(
      `UPDATE tcg_sync_log SET
         tcgs_processed    = ?,
         groups_enqueued   = ?,
         sets_processed    = 0,
         products_upserted = 0,
         prices_upserted   = 0
       WHERE id = ?`
    )
    .bind(JSON.stringify(tcgsProcessed), groupsEnqueued, id)
    .run();
}

// Called atomically by each queue consumer after processing one group.
// Increments running totals; marks the sync complete when the last group finishes.
export async function updateSyncLogProgress(
  db: D1Database,
  id: number,
  delta: { productsUpserted: number; pricesUpserted: number; failed?: boolean }
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE tcg_sync_log SET
         groups_completed  = groups_completed + 1,
         sets_processed    = sets_processed + ?,
         products_upserted = products_upserted + ?,
         prices_upserted   = prices_upserted + ?,
         completed_at = CASE
           WHEN groups_completed + 1 >= groups_enqueued THEN ?
           ELSE completed_at
         END,
         status = CASE
           WHEN groups_completed + 1 >= groups_enqueued THEN 'success'
           ELSE status
         END
       WHERE id = ?`
    )
    .bind(
      delta.failed ? 0 : 1,
      delta.productsUpserted,
      delta.pricesUpserted,
      now,
      id
    )
    .run();
}
