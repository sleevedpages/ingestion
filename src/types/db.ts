import type { TcgExtendedData } from './tcgcsv.js';

export interface TcgCategoryRow {
  tcgplayer_category_id: number;
  name: string;
  display_name: string | null;
  modified_on: string | null;
  image_url: string | null;
  seo_text: string | null;
  is_direct_brand: number | null; // 0/1 — SQLite has no boolean
  synced_at: Date;
}

export interface TcgSetRow {
  tcgplayer_group_id: number;
  tcgplayer_category_id: number;
  name: string;
  abbreviation: string | null;
  published_on: Date | null;
  modified_on: string | null;
  is_supplemental: boolean;
  skrydex_set_id: string | null;
  synced_at: Date;
}

export interface TcgProductRow {
  tcgplayer_product_id: number;
  tcgplayer_group_id: number;
  tcgplayer_category_id: number;
  name: string;
  clean_name: string | null;
  image_url: string | null;
  tcgplayer_url: string | null;
  modified_on: string | null;
  image_count: number | null;
  presale_info: string | null; // JSON — { isPresale, releasedOn, note }
  card_number: string | null;  // from extendedData "Number" — null for non-card products
  rarity: string | null;       // from extendedData "Rarity"  — null for non-card products
  extended_data: TcgExtendedData[];
  synced_at: Date;
}

export interface TcgPriceRow {
  tcgplayer_product_id: number;
  sub_type_name: string;
  low_price: number | null;
  mid_price: number | null;
  high_price: number | null;
  market_price: number | null;
  direct_low_price: number | null;
  synced_at: Date;
}

export interface ImageMirrorLogRow {
  id: number;
  processed: number;
  mirrored: number;
  failed: number;
  skrydex_hits: number;
  tcgplayer_hits: number;
  duration_ms: number | null;
  created_at: string;
}

export type SyncStatus = 'running' | 'success' | 'failed';

export interface SyncLogRow {
  id: number;
  started_at: Date;
  completed_at: Date | null;
  status: SyncStatus;
  tcgs_processed: string[] | null;
  sets_processed: number | null;
  products_upserted: number | null;
  prices_upserted: number | null;
  error_message: string | null;
}

export interface SyncStats {
  setsProcessed: number;
  setsFailed: number;
  productsUpserted: number;
  pricesUpserted: number;
  tcgsProcessed: string[];
}
