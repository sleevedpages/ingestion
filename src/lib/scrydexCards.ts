/**
 * scrydexCards.ts — correct, paginated /{game}/v1/cards fetch.
 *
 * Scrydex's cards endpoint filters via a Lucene `q` query and paginates with
 * `page`/`pageSize` — NOT the `expansion`/`limit` params the worker historically sent
 * (which Scrydex silently ignores, returning only the default first page of ~100 cards
 * for the WHOLE game). That bug capped every per-expansion pull at ~100 cards.
 *
 *   filter     q=expansion.id:<expansionId>
 *   page size  pageSize=<N>   (server may cap below the requested value)
 *   paging     page=1..       (authoritative stop is response.totalCount)
 *
 * Returns every card across all pages. Pagination is driven by `totalCount` (not by
 * `batch.length < pageSize`), so a server-capped page size still pages to completion.
 */

import type { Env } from '../worker.js'
import { scrydexFetch } from './scrydexClient.js'

const PAGE_SIZE  = 250   // requested; Scrydex returns its own max if lower
const MAX_PAGES  = 100   // safety valve against a missing/!0 totalCount

export interface ExpansionCardsResult {
  cards:    any[]
  requests: number   // Scrydex calls made (= credits used)
}

/** Throws on a non-OK Scrydex response; carries the HTTP status for circuit-breaking. */
export class ScrydexCardsError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ScrydexCardsError'
    this.status = status
  }
}

export async function fetchAllExpansionCards(
  env:           Env,
  gameSlug:      string,
  expansionId:   string,
  jobName:       string,
  includePrices = false,
): Promise<ExpansionCardsResult> {
  const cards: any[] = []
  let requests = 0
  let page = 1
  let total = Infinity

  while (cards.length < total && page <= MAX_PAGES) {
    const params: Record<string, string> = {
      q:        `expansion.id:${expansionId}`,
      pageSize: String(PAGE_SIZE),
      page:     String(page),
    }
    if (includePrices) params.include = 'prices'

    const res = await scrydexFetch(env, `/${gameSlug}/v1/cards`, jobName, { params })
    requests++
    if (!res.ok) {
      throw new ScrydexCardsError(res.status, `Scrydex ${res.status} for ${gameSlug}/${expansionId}`)
    }

    const data  = await res.json() as { data?: unknown[]; totalCount?: number; total_count?: number }
    const batch = (data.data ?? []) as any[]
    cards.push(...batch)

    total = data.totalCount ?? data.total_count ?? cards.length   // absent → stop after this page
    if (batch.length === 0) break
    page++
  }

  return { cards, requests }
}
