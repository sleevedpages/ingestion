import type { RateLimitedClient } from './http.js';
import type { TcgApiResponse, TcgProduct, TcgPrice } from '../types/tcgcsv.js';

export interface GroupData {
  products: TcgProduct[];
  prices: TcgPrice[];
}

export async function fetchGroupData(
  httpClient: RateLimitedClient,
  categoryId: number,
  groupId: number
): Promise<GroupData> {
  // Sequential — must respect the 100ms rate limit between requests
  const productData = await httpClient.get<TcgApiResponse<TcgProduct>>(
    `/tcgplayer/${categoryId}/${groupId}/products`
  );
  const priceData = await httpClient.get<TcgApiResponse<TcgPrice>>(
    `/tcgplayer/${categoryId}/${groupId}/prices`
  );
  return {
    products: productData.results,
    prices: priceData.results,
  };
}
