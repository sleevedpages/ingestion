-- TCG ingestion schema for Cloudflare D1 (SQLite)
-- Apply with: npm run migrate:local  (local dev)
--             npm run migrate:remote (production)

CREATE TABLE IF NOT EXISTS tcg_categories (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  tcgplayer_category_id INTEGER UNIQUE NOT NULL,
  name                  TEXT NOT NULL,
  display_name          TEXT,
  modified_on           TEXT,  -- ISO 8601 from API
  image_url             TEXT,
  seo_text              TEXT,
  is_direct_brand       INTEGER,  -- 0/1
  synced_at             TEXT      -- ISO 8601
);

CREATE TABLE IF NOT EXISTS tcg_sets (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  tcgplayer_group_id    INTEGER UNIQUE NOT NULL,
  tcgplayer_category_id INTEGER,
  name                  TEXT NOT NULL,
  abbreviation          TEXT,
  published_on          TEXT,  -- ISO 8601
  modified_on           TEXT,  -- ISO 8601 from API
  is_supplemental       INTEGER NOT NULL DEFAULT 0,  -- 0/1
  synced_at             TEXT,
  FOREIGN KEY (tcgplayer_category_id) REFERENCES tcg_categories(tcgplayer_category_id)
);

-- Stores every product type: individual cards, sealed product, accessories, etc.
-- card_number and rarity are populated from extendedData when present (null for non-cards).
-- Use isCard() in the app layer to distinguish card products from sealed/accessories.
CREATE TABLE IF NOT EXISTS tcg_products (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  tcgplayer_product_id  INTEGER UNIQUE NOT NULL,
  tcgplayer_group_id    INTEGER,
  tcgplayer_category_id INTEGER,
  name                  TEXT NOT NULL,
  clean_name            TEXT,
  image_url             TEXT,
  tcgplayer_url         TEXT,
  modified_on           TEXT,     -- ISO 8601 from API
  image_count           INTEGER,
  presale_info          TEXT,     -- JSON: { isPresale, releasedOn, note }
  card_number           TEXT,     -- from extendedData "Number"  — null for non-cards
  rarity                TEXT,     -- from extendedData "Rarity"  — null for non-cards
  extended_data         TEXT,     -- JSON array of all extendedData fields
  synced_at             TEXT,
  FOREIGN KEY (tcgplayer_group_id) REFERENCES tcg_sets(tcgplayer_group_id)
);

CREATE TABLE IF NOT EXISTS tcg_prices (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  tcgplayer_product_id INTEGER NOT NULL,
  sub_type_name        TEXT NOT NULL,
  low_price            REAL,
  mid_price            REAL,
  high_price           REAL,
  market_price         REAL,
  direct_low_price     REAL,
  synced_at            TEXT,
  UNIQUE (tcgplayer_product_id, sub_type_name),
  FOREIGN KEY (tcgplayer_product_id) REFERENCES tcg_products(tcgplayer_product_id)
);

CREATE TABLE IF NOT EXISTS tcg_sync_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at        TEXT NOT NULL,
  completed_at      TEXT,
  status            TEXT CHECK (status IN ('running', 'success', 'failed')),
  tcgs_processed    TEXT,     -- JSON array e.g. '["Pokemon","Magic"]'
  sets_processed    INTEGER,
  products_upserted INTEGER,
  prices_upserted   INTEGER,
  error_message     TEXT
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_tcg_products_group_id
  ON tcg_products (tcgplayer_group_id);

CREATE INDEX IF NOT EXISTS idx_tcg_products_category_id
  ON tcg_products (tcgplayer_category_id);

-- Useful for app queries that want only cards: WHERE card_number IS NOT NULL OR rarity IS NOT NULL
CREATE INDEX IF NOT EXISTS idx_tcg_products_rarity
  ON tcg_products (rarity);

CREATE INDEX IF NOT EXISTS idx_tcg_prices_product_id
  ON tcg_prices (tcgplayer_product_id);

CREATE INDEX IF NOT EXISTS idx_tcg_sets_category_id
  ON tcg_sets (tcgplayer_category_id);

CREATE INDEX IF NOT EXISTS idx_tcg_sync_log_status
  ON tcg_sync_log (status, completed_at);
