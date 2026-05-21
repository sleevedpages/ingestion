import type { TcgGroup, TcgProduct, TcgPrice } from '../types/tcgcsv.js';
import type { TcgCategoryRow, TcgSetRow, TcgProductRow, TcgPriceRow } from '../types/db.js';
import type { ResolvedCategory } from './categories.js';
import { getSkrydexSetId } from '../lib/skrydexSets.js';

function getExtendedValue(product: TcgProduct, fieldName: string): string | null {
  return (
    product.extendedData.find(
      (f) => f.name.toLowerCase() === fieldName.toLowerCase()
    )?.value ?? null
  );
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
    skrydex_set_id: getSkrydexSetId(group.name),
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
    image_url:     product.imageUrl ?? null,
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
