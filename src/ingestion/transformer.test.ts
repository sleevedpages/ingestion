import { describe, it, expect } from 'vitest';
import {
  isCard,
  transformCategory,
  transformGroup,
  transformProduct,
  transformPrice,
  transformGroupData,
  bumpTcgplayerImageRes,
} from './transformer.js';
import type { TcgGroup, TcgProduct, TcgPrice } from '../types/tcgcsv.js';
import type { ResolvedCategory } from './categories.js';

const NOW = new Date('2024-01-15T06:00:00Z');

const makeProduct = (overrides: Partial<TcgProduct> = {}): TcgProduct => ({
  productId: 1,
  name: 'Pikachu',
  cleanName: 'pikachu',
  imageUrl: 'https://example.com/pikachu.jpg',
  categoryId: 3,
  groupId: 100,
  url: 'https://tcgplayer.com/pikachu',
  modifiedOn: NOW.toISOString(),
  imageCount: 1,
  presaleInfo: null,
  extendedData: [
    { name: 'Number', displayName: 'Card Number', value: '58/102' },
    { name: 'Rarity', displayName: 'Rarity', value: 'Common' },
  ],
  ...overrides,
});

// ---------------------------------------------------------------------------
// isCard
// ---------------------------------------------------------------------------

describe('isCard', () => {
  it('returns true when extendedData has Number', () => {
    expect(isCard(makeProduct({
      extendedData: [{ name: 'Number', displayName: 'Card Number', value: '1' }],
    }))).toBe(true);
  });

  it('returns true when extendedData has Rarity', () => {
    expect(isCard(makeProduct({
      extendedData: [{ name: 'Rarity', displayName: 'Rarity', value: 'Rare' }],
    }))).toBe(true);
  });

  it('returns false for sealed product with no Number or Rarity', () => {
    expect(isCard(makeProduct({
      extendedData: [{ name: 'SetCode', displayName: 'Set Code', value: 'BASE' }],
    }))).toBe(false);
  });

  it('returns false for empty extendedData', () => {
    expect(isCard(makeProduct({ extendedData: [] }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// transformCategory
// ---------------------------------------------------------------------------

describe('transformCategory', () => {
  it('maps all category fields', () => {
    const cat: ResolvedCategory = {
      categoryId: 3,
      name: 'Pokemon',
      displayName: 'Pokémon',
      modifiedOn: NOW.toISOString(),
      imageUrl: 'https://example.com/pokemon.jpg',
      seoText: 'Pokemon TCG',
      isDirectBrand: false,
    };
    const row = transformCategory(cat, NOW);
    expect(row.tcgplayer_category_id).toBe(3);
    expect(row.name).toBe('Pokemon');
    expect(row.display_name).toBe('Pokémon');
    expect(row.modified_on).toBe(NOW.toISOString());
    expect(row.image_url).toBe('https://example.com/pokemon.jpg');
    expect(row.seo_text).toBe('Pokemon TCG');
    expect(row.is_direct_brand).toBe(0);
    expect(row.synced_at).toBe(NOW);
  });
});

// ---------------------------------------------------------------------------
// transformGroup
// ---------------------------------------------------------------------------

describe('transformGroup', () => {
  it('maps all group fields including modified_on', () => {
    const group: TcgGroup = {
      groupId: 100,
      name: 'Base Set',
      abbreviation: 'BS',
      isSupplemental: false,
      publishedOn: '1999-01-09T00:00:00',
      modifiedOn: NOW.toISOString(),
      categoryId: 3,
    };
    const row = transformGroup(group, NOW);
    expect(row.tcgplayer_group_id).toBe(100);
    expect(row.name).toBe('Base Set');
    expect(row.abbreviation).toBe('BS');
    expect(row.is_supplemental).toBe(false);
    expect(row.published_on).toBeInstanceOf(Date);
    expect(row.modified_on).toBe(NOW.toISOString());
  });

  it('handles null publishedOn and abbreviation', () => {
    const group: TcgGroup = {
      groupId: 200,
      name: 'Promo Set',
      abbreviation: null,
      isSupplemental: true,
      publishedOn: null,
      modifiedOn: NOW.toISOString(),
      categoryId: 3,
    };
    const row = transformGroup(group, NOW);
    expect(row.published_on).toBeNull();
    expect(row.abbreviation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// transformProduct
// ---------------------------------------------------------------------------

describe('transformProduct', () => {
  it('extracts card_number and rarity for card products', () => {
    const row = transformProduct(makeProduct(), NOW);
    expect(row.card_number).toBe('58/102');
    expect(row.rarity).toBe('Common');
    expect(row.tcgplayer_product_id).toBe(1);
    expect(row.name).toBe('Pikachu');
    expect(row.modified_on).toBe(NOW.toISOString());
    expect(row.image_count).toBe(1);
    expect(row.presale_info).toBeNull();
  });

  it('returns null card_number and rarity for non-card products', () => {
    const row = transformProduct(makeProduct({ extendedData: [] }), NOW);
    expect(row.card_number).toBeNull();
    expect(row.rarity).toBeNull();
  });

  it('serialises presaleInfo to JSON when present', () => {
    const presale = { isPresale: true, releasedOn: '2025-06-01', note: 'Coming soon' };
    const row = transformProduct(makeProduct({ presaleInfo: presale }), NOW);
    expect(row.presale_info).toBe(JSON.stringify(presale));
  });

  it('preserves the full extendedData array', () => {
    const product = makeProduct();
    const row = transformProduct(product, NOW);
    expect(row.extended_data).toEqual(product.extendedData);
  });

  it('bumps a TCGPlayer CDN _200w image url to _in_1000x1000', () => {
    const row = transformProduct(makeProduct({
      imageUrl: 'https://tcgplayer-cdn.tcgplayer.com/product/243522_200w.jpg',
    }), NOW);
    expect(row.image_url).toBe(
      'https://tcgplayer-cdn.tcgplayer.com/product/243522_in_1000x1000.jpg'
    );
  });

  it('leaves a non-TCGPlayer image url untouched', () => {
    const row = transformProduct(makeProduct({
      imageUrl: 'https://images.scrydex.com/pokemon/base1-58/large',
    }), NOW);
    expect(row.image_url).toBe('https://images.scrydex.com/pokemon/base1-58/large');
  });

  it('stores null image_url when the product has no image', () => {
    const row = transformProduct(makeProduct({ imageUrl: undefined as unknown as string }), NOW);
    expect(row.image_url).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// bumpTcgplayerImageRes
// ---------------------------------------------------------------------------

describe('bumpTcgplayerImageRes', () => {
  it('rewrites the _200w token to _in_1000x1000 on tcgplayer-cdn urls', () => {
    expect(
      bumpTcgplayerImageRes('https://tcgplayer-cdn.tcgplayer.com/product/100_200w.jpg')
    ).toBe('https://tcgplayer-cdn.tcgplayer.com/product/100_in_1000x1000.jpg');
  });

  it('preserves a query string after the extension', () => {
    expect(
      bumpTcgplayerImageRes('https://tcgplayer-cdn.tcgplayer.com/product/100_200w.jpg?v=2')
    ).toBe('https://tcgplayer-cdn.tcgplayer.com/product/100_in_1000x1000.jpg?v=2');
  });

  it('returns non-tcgplayer hosts unchanged', () => {
    expect(bumpTcgplayerImageRes('https://images.scrydex.com/x_200w.jpg'))
      .toBe('https://images.scrydex.com/x_200w.jpg');
  });

  it('returns null/empty input as null', () => {
    expect(bumpTcgplayerImageRes(null)).toBeNull();
    expect(bumpTcgplayerImageRes(undefined)).toBeNull();
    expect(bumpTcgplayerImageRes('')).toBeNull();
  });

  it('is idempotent — an already-bumped url is left unchanged', () => {
    const url = 'https://tcgplayer-cdn.tcgplayer.com/product/100_in_1000x1000.jpg';
    expect(bumpTcgplayerImageRes(url)).toBe(url);
  });
});

// ---------------------------------------------------------------------------
// transformPrice
// ---------------------------------------------------------------------------

describe('transformPrice', () => {
  it('maps all price fields', () => {
    const price: TcgPrice = {
      productId: 1,
      lowPrice: 0.5,
      midPrice: 1.0,
      highPrice: 2.0,
      marketPrice: 0.9,
      directLowPrice: null,
      subTypeName: 'Normal',
    };
    const row = transformPrice(price, NOW);
    expect(row.tcgplayer_product_id).toBe(1);
    expect(row.sub_type_name).toBe('Normal');
    expect(row.market_price).toBe(0.9);
    expect(row.direct_low_price).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// transformGroupData
// ---------------------------------------------------------------------------

describe('transformGroupData', () => {
  it('stores ALL products — cards AND sealed product', () => {
    const cardProduct = makeProduct({ productId: 1 });
    const sealedProduct = makeProduct({
      productId: 2,
      name: 'Base Set Booster Box',
      extendedData: [],
    });
    const prices: TcgPrice[] = [
      { productId: 1, subTypeName: 'Normal', lowPrice: 0.5, midPrice: 1.0, highPrice: 2.0, marketPrice: 0.9, directLowPrice: null },
      { productId: 2, subTypeName: 'Normal', lowPrice: 80.0, midPrice: 100.0, highPrice: 120.0, marketPrice: 95.0, directLowPrice: null },
    ];

    const result = transformGroupData([cardProduct, sealedProduct], prices, NOW);

    // Both products stored
    expect(result.products).toHaveLength(2);
    expect(result.products.map((p) => p.tcgplayer_product_id)).toContain(1);
    expect(result.products.map((p) => p.tcgplayer_product_id)).toContain(2);

    // Prices for both products stored
    expect(result.prices).toHaveLength(2);
  });

  it('card products have card_number/rarity; sealed products have nulls', () => {
    const cardProduct = makeProduct({ productId: 1 });
    const sealedProduct = makeProduct({ productId: 2, extendedData: [] });

    const { products } = transformGroupData([cardProduct, sealedProduct], [], NOW);

    const card = products.find((p) => p.tcgplayer_product_id === 1)!;
    const sealed = products.find((p) => p.tcgplayer_product_id === 2)!;

    expect(card.rarity).toBe('Common');
    expect(card.card_number).toBe('58/102');
    expect(sealed.rarity).toBeNull();
    expect(sealed.card_number).toBeNull();
  });

  it('handles empty input', () => {
    const result = transformGroupData([], [], NOW);
    expect(result.products).toHaveLength(0);
    expect(result.prices).toHaveLength(0);
  });

  it('handles products with no matching prices', () => {
    const result = transformGroupData([makeProduct({ productId: 5 })], [], NOW);
    expect(result.products).toHaveLength(1);
    expect(result.prices).toHaveLength(0);
  });
});
