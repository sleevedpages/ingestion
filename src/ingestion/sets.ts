import type { RateLimitedClient } from './http.js';
import type { TcgApiResponse, TcgGroup } from '../types/tcgcsv.js';

export async function fetchGroups(
  httpClient: RateLimitedClient,
  categoryId: number
): Promise<TcgGroup[]> {
  const data = await httpClient.get<TcgApiResponse<TcgGroup>>(
    `/tcgplayer/${categoryId}/groups`
  );
  return data.results;
}
