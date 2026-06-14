import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  fetchTcggoGradedPrices,
  normalizeGraded,
  extractGradedFromPayload,
} from './lib/tcggoClient.js'

const ENV = { TCGGO_RAPIDAPI_KEY: 'rk' }

// The operator-supplied spec sample shape: prices.ebay.graded[company][grade].
const SAMPLE = {
  prices: {
    ebay: {
      graded: {
        psa: { '10': { median_price: 412.5, sample_size: 7 }, '9': { median_price: 180, sample_size: 2 } },
        bgs: { '9.5': { median_price: 350.25, sample_size: 4 } },
        cgc: { '10': { median_price: 300, sample_size: 1 } },
      },
    },
  },
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('normalizeGraded', () => {
  it('lowercases companies and keeps numeric medians + sample sizes', () => {
    const g = normalizeGraded(SAMPLE.prices.ebay.graded)!
    expect(g.psa['10']).toEqual({ median_price: 412.5, sample_size: 7 })
    expect(g.bgs['9.5'].median_price).toBe(350.25)
    expect(g.cgc['10'].sample_size).toBe(1)
  })

  it('returns null for empty / non-object input', () => {
    expect(normalizeGraded(null)).toBeNull()
    expect(normalizeGraded({})).toBeNull()
    expect(normalizeGraded({ psa: { '10': { median_price: 'x' } } })).toBeNull()
  })
})

describe('extractGradedFromPayload', () => {
  it('handles single object, array, and { data: [] } shapes', () => {
    expect(extractGradedFromPayload(SAMPLE)?.psa['10'].median_price).toBe(412.5)
    expect(extractGradedFromPayload([SAMPLE])?.bgs['9.5'].median_price).toBe(350.25)
    expect(extractGradedFromPayload({ data: [SAMPLE] })?.cgc['10'].median_price).toBe(300)
  })

  it('returns null when no card carries graded data', () => {
    expect(extractGradedFromPayload([{ prices: { ebay: {} } }])).toBeNull()
  })
})

describe('fetchTcggoGradedPrices', () => {
  it('maps a tcgplayerId to the compact graded shape', async () => {
    const fetchMock = vi.fn(async (url: string, opts: any) => {
      expect(String(url)).toContain('pokemon-tcg-api.p.rapidapi.com/cards')
      expect(String(url)).toContain('tcgplayer_id=12345')
      expect(opts.headers['x-rapidapi-key']).toBe('rk')
      expect(opts.headers['x-rapidapi-host']).toBe('pokemon-tcg-api.p.rapidapi.com')
      return new Response(JSON.stringify(SAMPLE), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const res = await fetchTcggoGradedPrices(ENV as any, '12345')
    expect(res.tcgplayerId).toBe('12345')
    expect(res.source).toBe('tcggo')
    expect(res.graded?.psa['10'].median_price).toBe(412.5)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns null graded on a 404 (no match / non-covered game)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })))
    const res = await fetchTcggoGradedPrices(ENV as any, '999')
    expect(res.graded).toBeNull()
  })

  it('throws on a non-OK (non-404) HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('err', { status: 500 })))
    await expect(fetchTcggoGradedPrices(ENV as any, '1')).rejects.toThrow('tcggo HTTP 500')
  })

  it('throws when the key is not configured', async () => {
    await expect(fetchTcggoGradedPrices({} as any, '1')).rejects.toThrow('TCGGO_RAPIDAPI_KEY')
  })
})
