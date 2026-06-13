import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchAllExpansionCards, ScrydexCardsError } from './scrydexCards.js'

// Minimal env: DB only needs to answer the credit-guard SUM query (returns 0 used).
function makeEnv() {
  return {
    DB: {
      prepare() {
        return {
          bind() { return this },
          async first() { return { total: 0 } },   // credit guard: unused
          async run() { return {} },
        }
      },
    },
    SCRYDEX_API_KEY: 'k',
    SCRYDEX_TEAM_ID: 't',
  } as any
}

afterEach(() => { vi.unstubAllGlobals() })

describe('fetchAllExpansionCards', () => {
  it('filters with q=expansion.id:<id> and page/pageSize (not expansion/limit)', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      return new Response(JSON.stringify({ data: [{ id: 'A' }], totalCount: 1 }),
        { status: 200, headers: { 'content-type': 'application/json' } })
    }))

    const { cards, requests } = await fetchAllExpansionCards(makeEnv(), 'onepiece', 'OP09', 'test')
    expect(cards).toHaveLength(1)
    expect(requests).toBe(1)

    const u = new URL(urls[0])
    expect(u.pathname).toBe('/onepiece/v1/cards')
    expect(u.searchParams.get('q')).toBe('expansion.id:OP09')
    expect(u.searchParams.get('pageSize')).toBe('250')
    expect(u.searchParams.get('page')).toBe('1')
    // The broken legacy params must NOT be sent.
    expect(u.searchParams.get('expansion')).toBeNull()
    expect(u.searchParams.get('limit')).toBeNull()
  })

  it('paginates until totalCount is reached and concatenates all pages', async () => {
    // 3 cards total, server caps pages at 2 items → expect 2 requests (page 1: 2, page 2: 1).
    const pages: Record<string, any[]> = {
      '1': [{ id: 'A' }, { id: 'B' }],
      '2': [{ id: 'C' }],
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const page = new URL(url).searchParams.get('page')!
      return new Response(JSON.stringify({ data: pages[page] ?? [], totalCount: 3 }),
        { status: 200, headers: { 'content-type': 'application/json' } })
    }))

    const { cards, requests } = await fetchAllExpansionCards(makeEnv(), 'gundam', 'GD04', 'test')
    expect(cards.map(c => c.id)).toEqual(['A', 'B', 'C'])
    expect(requests).toBe(2)
  })

  it('stops after one page when totalCount is absent', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 'A' }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const { cards, requests } = await fetchAllExpansionCards(makeEnv(), 'onepiece', 'OP01', 'test')
    expect(cards).toHaveLength(1)
    expect(requests).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws ScrydexCardsError carrying the HTTP status on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"code":"CREDIT_CAP_HIT"}', { status: 403 })))
    await expect(fetchAllExpansionCards(makeEnv(), 'onepiece', 'OP09', 'test'))
      .rejects.toMatchObject({ name: 'ScrydexCardsError', status: 403 })
  })
})
