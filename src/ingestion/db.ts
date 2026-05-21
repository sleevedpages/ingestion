import type {
  TcgCategoryRow,
  TcgSetRow,
  TcgProductRow,
  TcgPriceRow,
  SyncStatus,
} from '../types/db.js';

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

// ---------------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------------

export async function upsertCategory(
  db: D1Database,
  row: TcgCategoryRow
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tcg_categories
         (tcgplayer_category_id, name, display_name, modified_on,
          image_url, seo_text, is_direct_brand, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tcgplayer_category_id) DO UPDATE SET
         name           = excluded.name,
         display_name   = excluded.display_name,
         modified_on    = excluded.modified_on,
         image_url      = excluded.image_url,
         seo_text       = excluded.seo_text,
         is_direct_brand = excluded.is_direct_brand,
         synced_at      = excluded.synced_at`
    )
    .bind(
      row.tcgplayer_category_id,
      row.name,
      row.display_name,
      row.modified_on,
      row.image_url,
      row.seo_text,
      row.is_direct_brand,
      iso(row.synced_at)
    )
    .run();
}

// ---------------------------------------------------------------------------
// Set
// ---------------------------------------------------------------------------

const SET_SQL = `
  INSERT INTO tcg_sets
    (tcgplayer_group_id, tcgplayer_category_id, name, abbreviation,
     published_on, modified_on, is_supplemental, skrydex_set_id, synced_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (tcgplayer_group_id) DO UPDATE SET
    tcgplayer_category_id = excluded.tcgplayer_category_id,
    name                  = excluded.name,
    abbreviation          = excluded.abbreviation,
    published_on          = excluded.published_on,
    modified_on           = excluded.modified_on,
    is_supplemental       = excluded.is_supplemental,
    skrydex_set_id        = COALESCE(tcg_sets.skrydex_set_id, excluded.skrydex_set_id),
    synced_at             = excluded.synced_at`;

function bindSet(db: D1Database, row: TcgSetRow) {
  return db.prepare(SET_SQL).bind(
    row.tcgplayer_group_id,
    row.tcgplayer_category_id,
    row.name,
    row.abbreviation,
    row.published_on ? iso(row.published_on) : null,
    row.modified_on,
    row.is_supplemental ? 1 : 0,
    row.skrydex_set_id ?? null,
    iso(row.synced_at)
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

const PRODUCT_SQL = `
  INSERT INTO tcg_products
    (tcgplayer_product_id, tcgplayer_group_id, tcgplayer_category_id,
     name, clean_name, image_url, tcgplayer_url, modified_on, image_count,
     presale_info, card_number, rarity, extended_data, synced_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (tcgplayer_product_id) DO UPDATE SET
    tcgplayer_group_id    = excluded.tcgplayer_group_id,
    tcgplayer_category_id = excluded.tcgplayer_category_id,
    name                  = excluded.name,
    clean_name            = excluded.clean_name,
    -- Preserve the R2-mirrored URL if one has been stored; only update from
    -- TCGPlayer when the image has never been mirrored (image_source IS NULL).
    image_url             = CASE
                              WHEN tcg_products.image_source IS NOT NULL
                              THEN tcg_products.image_url
                              ELSE excluded.image_url
                            END,
    tcgplayer_url         = excluded.tcgplayer_url,
    modified_on           = excluded.modified_on,
    image_count           = excluded.image_count,
    presale_info          = excluded.presale_info,
    card_number           = excluded.card_number,
    rarity                = excluded.rarity,
    extended_data         = excluded.extended_data,
    synced_at             = excluded.synced_at`;

export async function upsertProducts(
  db: D1Database,
  rows: TcgProductRow[]
): Promise<number> {
  if (rows.length === 0) return 0;
  for (const batch of chunk(rows, BATCH_SIZE)) {
    await db.batch(
      batch.map((r) =>
        db.prepare(PRODUCT_SQL).bind(
          r.tcgplayer_product_id,
          r.tcgplayer_group_id,
          r.tcgplayer_category_id,
          r.name,
          r.clean_name,
          r.image_url,
          r.tcgplayer_url,
          r.modified_on,
          r.image_count,
          r.presale_info,
          r.card_number,
          r.rarity,
          JSON.stringify(r.extended_data),
          iso(r.synced_at)
        )
      )
    );
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Prices — bulk upsert via batch()
// ---------------------------------------------------------------------------

const PRICE_SQL = `
  INSERT INTO tcg_prices
    (tcgplayer_product_id, sub_type_name, low_price, mid_price,
     high_price, market_price, direct_low_price, synced_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (tcgplayer_product_id, sub_type_name) DO UPDATE SET
    low_price        = excluded.low_price,
    mid_price        = excluded.mid_price,
    high_price       = excluded.high_price,
    market_price     = excluded.market_price,
    direct_low_price = excluded.direct_low_price,
    synced_at        = excluded.synced_at`;

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
          r.low_price,
          r.mid_price,
          r.high_price,
          r.market_price,
          r.direct_low_price,
          iso(r.synced_at)
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
