import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  decodeGradedKey,
  pickGradedPrice,
  pickBestPcMatch,
  fetchPriceChartingGraded,
} from './lib/pricechartingClient.js'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

// ── Pure decode map ──────────────────────────────────────────────────────────
describe('decodeGradedKey', () => {
  it('maps grade-10 per company', () => {
    expect(decodeGradedKey('PSA', '10')).toBe('manual-only-price')
    expect(decodeGradedKey('BGS', '10')).toBe('bgs-10-price')
    expect(decodeGradedKey('CGC', '10')).toBe('condition-17-price')
    expect(decodeGradedKey('SGC', '10')).toBe('condition-18-price')
  })
  it('maps sub-10 grades company-agnostically', () => {
    expect(decodeGradedKey('PSA', '9.5')).toBe('box-only-price')
    expect(decodeGradedKey('BGS', '9')).toBe('graded-price')
    expect(decodeGradedKey('CGC', '8.5')).toBe('new-price')
    expect(decodeGradedKey('SGC', '8')).toBe('new-price')
    expect(decodeGradedKey('PSA', '7.5')).toBe('cib-price')
    expect(decodeGradedKey('PSA', '7')).toBe('cib-price')
  })
  it('returns null for unsupported companies + grades < 7', () => {
    expect(decodeGradedKey('TAG', '10')).toBeNull()
    expect(decodeGradedKey('ACE', '9')).toBeNull()
    expect(decodeGradedKey('PSA', '6.5')).toBeNull()
    expect(decodeGradedKey('PSA', '5')).toBeNull()
    expect(decodeGradedKey('', '10')).toBeNull()
    expect(decodeGradedKey('PSA', '')).toBeNull()
  })
})

describe('pickGradedPrice (pennies ÷ 100)', () => {
  const product = { 'manual-only-price': 145050, 'graded-price': 8800, 'loose-price': 1200 }
  it('reads the decoded tier and converts pennies to dollars', () => {
    expect(pickGradedPrice(product, 'PSA', '10')).toEqual({ price: 1450.5, key: 'manual-only-price' })
    expect(pickGradedPrice(product, 'PSA', '9')).toEqual({ price: 88, key: 'graded-price' })
  })
  it('returns null for missing tier, zero, or unsupported', () => {
    expect(pickGradedPrice(product, 'PSA', '9.5')).toBeNull()   // box-only-price absent
    expect(pickGradedPrice({ 'manual-only-price': 0 }, 'PSA', '10')).toBeNull()
    expect(pickGradedPrice(product, 'TAG', '10')).toBeNull()
    expect(pickGradedPrice(null, 'PSA', '10')).toBeNull()
  })
})

// ── Search-result validation ───────────────────────────────────────────────
describe('pickBestPcMatch', () => {
  const card = { name: 'Charizard ex', setName: 'Obsidian Flames', number: '125/197' }
  it('accepts a name + number match', () => {
    const m = pickBestPcMatch(
      [{ id: '1', 'product-name': 'Charizard ex #125', 'console-name': 'Pokemon Obsidian Flames' }],
      card,
    )
    expect(m?.id).toBe('1')
  })
  it('rejects a weak (name-only, wrong set, no number) match', () => {
    const m = pickBestPcMatch(
      [{ id: '9', 'product-name': 'Charizard ex', 'console-name': 'Some Video Game' }],
      card,
    )
    expect(m).toBeNull()
  })
  it('rejects when the card name is absent from the product name', () => {
    const m = pickBestPcMatch(
      [{ id: '2', 'product-name': 'Pikachu #125', 'console-name': 'Pokemon Obsidian Flames' }],
      card,
    )
    expect(m).toBeNull()
  })
  it('picks the highest-scoring candidate (name+number+set)', () => {
    const m = pickBestPcMatch([
      { id: 'a', 'product-name': 'Charizard ex', 'console-name': 'Pokemon Obsidian Flames' }, // name+set = 4
      { id: 'b', 'product-name': 'Charizard ex #125', 'console-name': 'Pokemon Obsidian Flames' }, // name+num+set = 7
    ], card)
    expect(m?.id).toBe('b')
  })

  // Regression: One Piece card whose franchise words ("ONE PIECE") live in the
  // console-name, with a hyphenated set-prefixed number (was rejected → price null).
  const opCard = {
    name: 'Monkey.D.Luffy (010) (Dodgers x ONE PIECE)',
    setName: 'One Piece Extra Booster Anime 25th Collection',
    number: 'EB02-010',
  }
  it('matches an OP card via the combined product+console haystack + compact number', () => {
    const m = pickBestPcMatch([
      { id: '183900', 'product-name': 'Monkey.D.Luffy [Dodgers] EB02-010', 'console-name': 'One Piece Extra Booster Anime 25th Collection' },
    ], opCard)
    expect(m?.id).toBe('183900')
  })
  it('discriminates art variants — rejects a non-"Dodgers" print of the same number', () => {
    const m = pickBestPcMatch([
      { id: 'x', 'product-name': 'Monkey.D.Luffy EB02-010', 'console-name': 'One Piece Extra Booster Anime 25th Collection' },
    ], opCard)
    expect(m).toBeNull() // 'dodgers' token absent from the haystack → nameHit fails
  })
})

// ── Integration: resolve → fetch → decode ───────────────────────────────────
function makeKV() {
  const store = new Map<string, string>()
  return {
    _store: store,
    async get(k: string) { return store.has(k) ? store.get(k)! : null },
    async put(k: string, v: string) { store.set(k, v) },
  }
}
function makeDb(card: any) {
  return { prepare() { return { bind() { return this }, async first() { return card } } } }
}
const baseEnv = (over: any = {}) => ({
  PRICECHARTING_TOKEN: 'tok',
  DB: makeDb({ name: 'Charizard ex', number: '125/197', set_name: 'Obsidian Flames' }),
  SLEEVEDPAGES_KV: makeKV(),
  ...over,
})

describe('fetchPriceChartingGraded', () => {
  it('throws when the token is missing', async () => {
    await expect(fetchPriceChartingGraded({} as any, { canonicalProductId: 1, company: 'PSA', grade: '10' }))
      .rejects.toThrow('PRICECHARTING_TOKEN')
  })

  it('short-circuits an unsupported tier with no API call', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const res = await fetchPriceChartingGraded(baseEnv() as any, { canonicalProductId: 1, company: 'TAG', grade: '10' })
    expect(res.price).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resolves an id (search → validate → cache), fetches, and decodes the price', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/api/products')) {
        return new Response(JSON.stringify({ status: 'success', products: [
          { id: '6910', 'product-name': 'Charizard ex #125', 'console-name': 'Pokemon Obsidian Flames' },
        ] }), { status: 200 })
      }
      return new Response(JSON.stringify({ status: 'success', 'product-name': 'Charizard ex #125', 'console-name': 'Pokemon Obsidian Flames', 'manual-only-price': 145050, 'sales-volume': 33 }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const env = baseEnv()

    const p = fetchPriceChartingGraded(env as any, { canonicalProductId: 7, company: 'PSA', grade: '10' })
    await vi.runAllTimersAsync()
    const res = await p

    expect(res.price).toBe(1450.5)
    expect(res.key).toBe('manual-only-price')
    expect(res.productName).toBe('Charizard ex #125')
    expect(res.console).toBe('Pokemon Obsidian Flames')
    expect(res.salesVolume).toBe(33)
    expect(res.pcId).toBe('6910')
    expect(await env.SLEEVEDPAGES_KV.get('pc_id_v2:7')).toBe('6910')   // id cached
    expect(fetchMock).toHaveBeenCalledTimes(2)                       // search + product
  })

  it('uses a cached id + cached product without any API call', async () => {
    const env = baseEnv()
    await env.SLEEVEDPAGES_KV.put('pc_id_v2:7', '6910')
    await env.SLEEVEDPAGES_KV.put('pc_product:6910', JSON.stringify({ 'manual-only-price': 50000, 'product-name': 'X' }))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const res = await fetchPriceChartingGraded(env as any, { canonicalProductId: 7, company: 'PSA', grade: '10' })
    expect(res.price).toBe(500)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('honours the negative-cache sentinel (no validated match) without re-searching', async () => {
    const env = baseEnv()
    await env.SLEEVEDPAGES_KV.put('pc_id_v2:7', 'none')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const res = await fetchPriceChartingGraded(env as any, { canonicalProductId: 7, company: 'PSA', grade: '10' })
    expect(res.price).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
