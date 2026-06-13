import type { TcgGroup, TcgProduct, TcgPrice } from '../types/tcgcsv.js';
import type { TcgCategoryRow, TcgSetRow, TcgProductRow, TcgPriceRow } from '../types/db.js';
import type { ResolvedCategory } from './categories.js';
import { getScrydexSetId } from '../lib/scrydexSets.js';

function getExtendedValue(product: TcgProduct, fieldName: string): string | null {
  return (
    product.extendedData.find(
      (f) => f.name.toLowerCase() === fieldName.toLowerCase()
    )?.value ?? null
  );
}

/**
 * Bump a TCGPlayer CDN card-image url from the low-res `_200w` thumbnail to the
 * operator-verified `_in_1000x1000` high-res form, e.g.
 *   https://tcgplayer-cdn.tcgplayer.com/product/243522_200w.jpg
 *     -> https://tcgplayer-cdn.tcgplayer.com/product/243522_in_1000x1000.jpg
 *
 * This is the *fallback* image (product_images.source_url) — the only image source
 * for TCGPlayer-only games (One Piece, Gundam) that have no Scrydex coverage. The
 * `_in_1000x1000` variant returns HTTP 200 with a real image; `_1000x1000` (without
 * the `_in_` infix) is access-denied — do NOT use it. TCGPlayer's high-res alt-art /
 * variant images carry a "SAMPLE" watermark; that is a TCGPlayer artifact, not a bug,
 * and a watermarked 1000x1000 still beats a clean 200px thumbnail. These images are
 * deliberately NOT mirrored into R2 (see the size-guard comment in image-mirror.ts).
 *
 * Only rewrites tcgplayer-cdn.tcgplayer.com urls; any other host (e.g. the Scrydex
 * CDN) and any non-`_200w` form is returned unchanged.
 */
export function bumpTcgplayerImageRes(url: string | null | undefined): string | null {
  if (!url) return null;
  if (!url.includes('tcgplayer-cdn.tcgplayer.com')) return url;
  return url.replace(/_200w(\.[A-Za-z0-9]+)/, '_in_1000x1000$1');
}

/**
 * Returns true for products that are individual cards (have a Number or Rarity
 * in extendedData). Exported so the app layer can filter tcg_products rows
 * without re-implementing this logic — but the ingestion service stores ALL
 * products regardless.
 */
export function isCard(product: TcgProduct): boolean {
  return product.extendedData.some(
    (f) => f.name === 'Rarity' || f.name === 'Number'
  );
}

export function transformCategory(
  cat: ResolvedCategory,
  now: Date = new Date()
): TcgCategoryRow {
  return {
    tcgplayer_category_id: cat.categoryId,
    name:           cat.name,
    display_name:   cat.displayName ?? null,
    modified_on:    cat.modifiedOn ?? null,
    image_url:      cat.imageUrl ?? null,
    seo_text:       cat.seoText ?? null,
    is_direct_brand: cat.isDirectBrand ? 1 : 0,
    synced_at:      now,
  };
}

export function transformGroup(
  group: TcgGroup,
  now: Date = new Date()
): TcgSetRow {
  return {
    tcgplayer_group_id:    group.groupId,
    tcgplayer_category_id: group.categoryId,
    name:          group.name,
    abbreviation:  group.abbreviation ?? null,
    published_on:  group.publishedOn ? new Date(group.publishedOn) : null,
    modified_on:   group.modifiedOn ?? null,
    is_supplemental: group.isSupplemental,
    scrydex_set_id: getScrydexSetId(group.name),
    synced_at:     now,
  };
}

export function transformProduct(
  product: TcgProduct,
  now: Date = new Date()
): TcgProductRow {
  return {
    tcgplayer_product_id:  product.productId,
    tcgplayer_group_id:    product.groupId,
    tcgplayer_category_id: product.categoryId,
    name:          product.name,
    clean_name:    product.cleanName ?? null,
    image_url:     bumpTcgplayerImageRes(product.imageUrl),
    tcgplayer_url: product.url ?? null,
    modified_on:   product.modifiedOn ?? null,
    image_count:   product.imageCount ?? null,
    presale_info:  product.presaleInfo ? JSON.stringify(product.presaleInfo) : null,
    card_number:   getExtendedValue(product, 'Number'),
    rarity:        getExtendedValue(product, 'Rarity'),
    extended_data: product.extendedData,
    synced_at:     now,
  };
}

export function transformPrice(
  price: TcgPrice,
  now: Date = new Date()
): TcgPriceRow {
  return {
    tcgplayer_product_id: price.productId,
    sub_type_name:    price.subTypeName,
    low_price:        price.lowPrice,
    mid_price:        price.midPrice,
    high_price:       price.highPrice,
    market_price:     price.marketPrice,
    direct_low_price: price.directLowPrice,
    synced_at:        now,
  };
}

export interface TransformResult {
  products: TcgProductRow[];
  prices: TcgPriceRow[];
}

export function transformGroupData(
  products: TcgProduct[],
  prices: TcgPrice[],
  now: Date = new Date()
): TransformResult {
  // Store every product — cards, sealed product, accessories, etc.
  // Use isCard() in the app layer when you want to show only individual cards.
  const productRows = products.map((p) => transformProduct(p, now));
  const productIds = new Set(productRows.map((p) => p.tcgplayer_product_id));
  const priceRows = prices
    .filter((p) => productIds.has(p.productId))
    .map((p) => transformPrice(p, now));
  return { products: productRows, prices: priceRows };
}
