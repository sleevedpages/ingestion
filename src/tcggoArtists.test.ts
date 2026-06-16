import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  normalizeArtist,
  normalizeArtistCard,
  searchTcggoArtists,
  fetchAllArtistCards,
} from './lib/tcggoClient.js'

const ENV = { TCGGO_RAPIDAPI_KEY: 'rk' } as any

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('normalizeArtist', () => {
  it('keeps id/name/slug/cards_count and drops incomplete rows', () => {
    expect(normalizeArtist({ id: 'a1', name: 'Mitsuhiro Arita', slug: 'arita', cards_count: 312 }))
      .toEqual({ id: 'a1', name: 'Mitsuhiro Arita', slug: 'arita', cards_count: 312 })
    expect(normalizeArtist({ name: 'no id' })).toBeNull()
    expect(normalizeArtist({ id: 'x' })).toBeNull()
  })
})

describe('normalizeArtistCard', () => {
  it('handles string and object episode/image and a null tcgplayer_id', () => {
    const a = normalizeArtistCard({ name: 'Pikachu', card_number: '58', rarity: 'Rare', episode: 'Base Set', image: 'http://img/x.png', tcgplayer_id: '999', tcgid: 'p-1' })
    expect(a).toEqual({ name: 'Pikachu', card_number: '58', rarity: 'Rare', episode: 'Base Set', image: 'http://img/x.png', tcgplayer_id: '999', tcgid: 'p-1' })

    const b = normalizeArtistCard({ name: 'Char', number: 4, episode: { name: 'Jungle' }, image: { large: 'http://img/c.png' }, tcgplayer_id: null })
    expect(b.card_number).toBe('4')
    expect(b.episode).toBe('Jungle')
    expect(b.image).toBe('http://img/c.png')
    expect(b.tcgplayer_id).toBeNull()
  })
})

describe('searchTcggoArtists', () => {
  it('sends search + page and normalises the list', async () => {
    const fetchMock = vi.fn(async (url: string, opts: any) => {
      expect(String(url)).toContain('/artists')
      expect(String(url)).toContain('search=arita')
      expect(opts.headers['x-rapidapi-key']).toBe('rk')
      return new Response(JSON.stringify({ data: [{ id: 'a1', name: 'Arita', cards_count: 10 }] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const res = await searchTcggoArtists(ENV, 'arita', 1)
    expect(res.artists).toHaveLength(1)
    expect(res.artists[0].id).toBe('a1')
  })

  it('throws when the key is missing', async () => {
    await expect(searchTcggoArtists({} as any, 'x')).rejects.toThrow('TCGGO_RAPIDAPI_KEY')
  })
})

describe('fetchAllArtistCards', () => {
  it('paginates until a short final page', async () => {
    const pages: Record<string, any[]> = {
      '1': [{ name: 'A', card_number: '1' }, { name: 'B', card_number: '2' }],
      '2': [{ name: 'C', card_number: '3' }], // short → last
    }
    const fetchMock = vi.fn(async (url: string) => {
      const page = new URL(String(url)).searchParams.get('page')!
      return new Response(JSON.stringify({ cards: pages[page] ?? [] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { cards, requests } = await fetchAllArtistCards(ENV, 'a1')
    expect(cards.map(c => c.name)).toEqual(['A', 'B', 'C'])
    expect(requests).toBe(2)
  })

  it('stops at cards_count even when pages stay full', async () => {
    const full = [{ name: 'A', card_number: '1' }, { name: 'B', card_number: '2' }]
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ cards: full }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { cards, requests } = await fetchAllArtistCards(ENV, 'a1', { cardsCount: 2 })
    expect(cards).toHaveLength(2)
    expect(requests).toBe(1)
  })

  it('stops on a 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nf', { status: 404 })))
    const { cards, requests } = await fetchAllArtistCards(ENV, 'missing')
    expect(cards).toHaveLength(0)
    expect(requests).toBe(1)
  })
})
