// JustTCG evaluation probe (2026-10-05) — pins:
//   1. the PURE comparison (justtcgCompare.ts): finishKey twin, the raw ladder twin, the Scrydex
//      tier pick, the graded relabel/skip rules on BOTH sides (ours: is_perfect → premium label,
//      signed/error dropped; JustTCG: qualifier → skipped, Black Label/Pristine → our premium label,
//      Authentic → skipped), the per-product deltas, the summary medians;
//   2. the client (lib/justtcgClient.ts): fail-closed without a key, the KV daily counter refusing
//      at cap − reserve, the x-api-key header + never-logged key, typed 401/429 errors;
//   3. the route (worker.ts): 401 without the secret, 503 `justtcg_not_configured` without a key
//      (the check that proves prod holds no key), and a resumable run: done:false carries state,
//      a cap stop reports capHit, a finished run compares against this database's rows and
//      persists to PRICE_ARCHIVE when bound.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

import {
  finishKey, conditionCode, resolveRawLadder, scrydexTiers, ourGradedLabels, justtcgGradedEntry,
  pickPrinting, justtcgTiers, compareProduct, summarise, median, type OurPriceRow,
} from './justtcgCompare.js'
import {
  justtcgConfigured, dailyCounterKey, reserveDailyCall, justtcgFetch, JustTcgError, justtcgLimits,
} from './lib/justtcgClient.js'
import { matchJustTcgGameId, buildQueue, selectProducts, runJustTcgProbe } from './justtcgProbe.js'
import worker from './worker.js'

const row = (o: Partial<OurPriceRow>): OurPriceRow => ({
  source: 'tcgplayer', condition: null, finish: null, variant: null, grade: null, company: null,
  is_graded: 0, is_perfect: 0, is_signed: 0, is_error: 0, value: null, fetched_at: 1_700_000_000, ...o,
})

// ── 1. The pure comparison ────────────────────────────────────────────────────────────────────

describe('finishKey / conditionCode twins', () => {
  it('makes the two printing vocabularies compare equal', () => {
    expect(finishKey('1st Edition Holofoil')).toBe(finishKey('firstEditionHolofoil'))
    expect(finishKey('Reverse Holofoil')).toBe(finishKey('reverseHolofoil'))
    expect(finishKey('Unlimited Edition Normal')).toBe('unlimitednormal')
    expect(finishKey(null)).toBeNull()
  })
  it('maps JustTCG condition names to our tier codes', () => {
    expect(conditionCode('Near Mint')).toBe('NM')
    expect(conditionCode('Lightly Played')).toBe('LP')
    expect(conditionCode('Damaged')).toBe('DM')
    expect(conditionCode('Sealed')).toBeNull()
  })
})

describe('resolveRawLadder twin', () => {
  it('TCGplayer finish-matched → Normal → highest, then PriceCharting loose, then Scrydex NM', () => {
    const rows = [
      row({ source: 'tcgplayer', finish: 'Holofoil', value: 9 }),
      row({ source: 'tcgplayer', finish: 'Normal', value: 4 }),
      row({ source: 'pricecharting', value: 7 }),
      row({ source: 'scrydex', condition: 'NM', finish: 'normal', value: 5 }),
    ]
    expect(resolveRawLadder(rows)).toEqual({ value: 4, source: 'tcgplayer', finish: 'Normal' })
    expect(resolveRawLadder(rows, 'holofoil')).toEqual({ value: 9, source: 'tcgplayer', finish: 'Holofoil' })
    expect(resolveRawLadder(rows.slice(2))).toEqual({ value: 7, source: 'pricecharting', finish: null })
    expect(resolveRawLadder(rows.slice(3))).toEqual({ value: 5, source: 'scrydex', finish: 'normal' })
    expect(resolveRawLadder([])).toEqual({ value: null, source: null, finish: null })
  })
  it('never lets a graded row into the raw ladder', () => {
    expect(resolveRawLadder([row({ source: 'scrydex', grade: 'PSA 10', is_graded: 1, value: 500 })]).value).toBeNull()
  })
})

describe('scrydexTiers', () => {
  it('prefers finish normal, else the highest-value finish, per tier', () => {
    const rows = [
      row({ source: 'scrydex', condition: 'NM', finish: 'holofoil', value: 10 }),
      row({ source: 'scrydex', condition: 'NM', finish: 'normal', value: 6 }),
      row({ source: 'scrydex', condition: 'LP', finish: 'holofoil', value: 8 }),
      row({ source: 'scrydex', condition: 'LP', finish: 'reverseHolofoil', value: 9 }),
      row({ source: 'tcgplayer', condition: 'NM', value: 99 }),   // not scrydex → ignored
    ]
    expect(scrydexTiers(rows)).toEqual({ NM: 6, LP: 9 })
  })
})

describe('ourGradedLabels (selectGradedRows twin)', () => {
  it('relabels is_perfect to the premium tier, drops signed/error and PSA perfect rows, one per label', () => {
    const rows = [
      row({ source: 'scrydex', is_graded: 1, grade: 'CGC 10', company: 'CGC', value: 100 }),
      row({ source: 'scrydex', is_graded: 1, grade: 'CGC 10', company: 'CGC', is_perfect: 1, value: 460 }),
      row({ source: 'scrydex', is_graded: 1, grade: 'BGS 10', company: 'BGS', is_perfect: 1, value: 900 }),
      row({ source: 'scrydex', is_graded: 1, grade: 'PSA 10', company: 'PSA', is_perfect: 1, value: 999 }),  // dropped
      row({ source: 'scrydex', is_graded: 1, grade: 'PSA 10', company: 'PSA', is_signed: 1, value: 1 }),    // dropped
      row({ source: 'pricecharting', is_graded: 1, grade: 'PSA 10', value: 120 }),
      row({ source: 'pricecharting', is_graded: 1, grade: 'Grade 9.5', value: 60 }),
    ]
    const labels = ourGradedLabels(rows).map(g => `${g.label}|${g.company}|${g.source}|${g.isPerfect}`)
    expect(labels).toEqual([
      'CGC 10|CGC|scrydex|false', 'CGC Pristine 10|CGC|scrydex|true', 'BGS Black Label 10|BGS|scrydex|true',
      'PSA 10|PSA|pricecharting|false', 'Grade 9.5|null|pricecharting|false',
    ])
  })
  it('prefers the scrydex row on a label tie', () => {
    const rows = [
      row({ source: 'pricecharting', is_graded: 1, grade: 'PSA 10', value: 120 }),
      row({ source: 'scrydex', is_graded: 1, grade: 'PSA 10', company: 'PSA', value: 110 }),
    ]
    expect(ourGradedLabels(rows)).toHaveLength(1)
    expect(ourGradedLabels(rows)[0].source).toBe('scrydex')
  })
})

describe('justtcgGradedEntry (the future writer\'s label / skip rules, pinned from observation)', () => {
  const v = (grading: Record<string, unknown>, price = 50) => ({ type: 'graded' as const, grading, markets: [{ region: 'NA', currency: 'USD', price, updated_at: 1_759_000_000, price_history: [{ p: 1, t: 1 }] }] })
  it('maps a plain grade to our combined label, half grades included', () => {
    expect(justtcgGradedEntry(v({ company: 'PSA', grade: 10, canonical: 'PSA 10' })).ourLabel).toBe('PSA 10')
    expect(justtcgGradedEntry(v({ company: 'CGC', grade: 9.5, canonical: 'CGC 9.5' })).ourLabel).toBe('CGC 9.5')
  })
  it('maps Black Label / Pristine to our premium labels', () => {
    expect(justtcgGradedEntry(v({ company: 'BGS', grade: 10, grade_label: 'Black Label' })).ourLabel).toBe('BGS Black Label 10')
    expect(justtcgGradedEntry(v({ company: 'CGC', grade: 10, grade_label: 'Pristine' })).ourLabel).toBe('CGC Pristine 10')
    expect(justtcgGradedEntry(v({ company: 'BGS', grade: 10, grade_label: 'Pristine' })).ourLabel).toBe('BGS Pristine 10')
  })
  it('skips qualified, Authentic and unknown-label slabs with a stated reason', () => {
    expect(justtcgGradedEntry(v({ company: 'PSA', grade: 9, qualifier: 'OC' })).skipReason).toBe('qualifier:OC')
    expect(justtcgGradedEntry(v({ company: 'PSA', grade: null, canonical: 'PSA Authentic' })).skipReason).toBe('authentic_or_no_grade')
    expect(justtcgGradedEntry(v({ company: 'SGC', grade: 10, grade_label: 'Gold Label' })).skipReason).toBe('grade_label:Gold Label')
    expect(justtcgGradedEntry({ type: 'graded', grading: { grade: 10 } }).skipReason).toBe('no_company')
  })
})

describe('pickPrinting / justtcgTiers', () => {
  const variants = [
    { condition: 'Near Mint', printing: 'Normal', price: 1.0, language: 'English' },
    { condition: 'Lightly Played', printing: 'Normal', price: 0.8 },
    { condition: 'Near Mint', printing: 'Holofoil', price: 5.0 },
    { condition: 'Near Mint', printing: 'Holofoil', price: 9.0, language: 'Japanese' },  // non-English, ignored
    { condition: 'Moderately Played', printing: 'Holofoil', price: 3.0 },
  ]
  it('matches our ladder finish by key, else Normal, else the priciest NM', () => {
    expect(pickPrinting(variants, 'holofoil')).toBe('Holofoil')
    expect(pickPrinting(variants, null)).toBe('Normal')
    expect(pickPrinting(variants.filter(v => v.printing !== 'Normal'), 'reverseHolofoil')).toBe('Holofoil')
    expect(pickPrinting([], null)).toBeNull()
  })
  it('reads the tiers of one printing, English only', () => {
    expect(justtcgTiers(variants, 'Holofoil')).toEqual({ NM: 5, MP: 3 })
    expect(justtcgTiers(variants, 'Normal')).toEqual({ NM: 1, LP: 0.8 })
  })
})

describe('compareProduct', () => {
  const ours = {
    productId: 7, tcgplayerProductId: 123, game: 'Pokemon', name: 'Pikachu', number: '25', setName: 'Base',
    rows: [
      row({ source: 'tcgplayer', finish: 'Holofoil', value: 10, fetched_at: 1_759_000_000 }),
      row({ source: 'scrydex', condition: 'NM', finish: 'holofoil', value: 10 }),
      row({ source: 'scrydex', condition: 'LP', finish: 'holofoil', value: 8 }),
      row({ source: 'scrydex', condition: 'MP', finish: 'holofoil', value: 6 }),
      row({ source: 'scrydex', is_graded: 1, grade: 'PSA 10', company: 'PSA', value: 100 }),
      row({ source: 'scrydex', is_graded: 1, grade: 'TAG 10', company: 'TAG', value: 90 }),
      row({ source: 'pricecharting', is_graded: 1, grade: 'Grade 9.5', value: 40 }),
    ],
  }
  const jtRaw = {
    uuid: 'u1', name: 'Pikachu', game: 'Pokemon', set_name: 'Base', tcgplayerId: '123',
    variants: [
      { condition: 'Near Mint', printing: 'Holofoil', price: 11, lastUpdated: 1_759_000_000 - 86_400, priceChange24hr: 1.5, priceChange7d: -2, priceHistory: [{ p: 10, t: 1_758_000_000 }, { p: 11, t: 1_759_000_000 }] },
      { condition: 'Lightly Played', printing: 'Holofoil', price: 8.8 },
      { condition: 'Moderately Played', printing: 'Holofoil', price: 6.6 },
      { condition: 'Heavily Played', printing: 'Holofoil', price: 4.4 },
      { condition: 'Near Mint', printing: 'Reverse Holofoil', price: 12 },
      { condition: 'Near Mint', printing: 'Prerelease Stamp', price: 20 },
    ],
  }
  const jtGraded = {
    id: 'u1', variants: [
      { type: 'graded' as const, grading: { company: 'PSA', grade: 10, canonical: 'PSA 10' }, markets: [{ price: 110, updated_at: 1_759_000_000 }] },
      { type: 'graded' as const, grading: { company: 'PSA', grade: 9, qualifier: 'OC', canonical: 'PSA 9 (OC)' }, markets: [{ price: 20 }] },
      { type: 'graded' as const, grading: { company: 'CGC', grade: 9.5, canonical: 'CGC 9.5' }, markets: [{ price: 45 }] },
      { type: 'graded' as const, grading: { company: 'BGS', grade: 10, grade_label: 'Black Label', canonical: 'BGS 10 Black Label' }, markets: [{ price: 700 }] },
    ],
  }
  it('compares headline, tiers, spread, trends, graded labels and freshness like-for-like', () => {
    const c = compareProduct(ours, jtRaw, jtGraded, { nowSeconds: 1_759_000_000 })
    expect(c.resolved).toBe(true)
    expect(c.printings.compared).toBe('Holofoil')
    expect(c.printings.unmapped).toEqual(['Reverse Holofoil', 'Prerelease Stamp'])
    expect(c.raw).toEqual({ ours: { value: 10, source: 'tcgplayer', finish: 'Holofoil' }, justtcgNm: 11, justtcgUpdatedAt: 1_759_000_000 - 86_400, deltaPct: 10 })
    expect(c.tiers.ours).toEqual({ NM: 10, LP: 8, MP: 6 })
    expect(c.tiers.justtcg).toEqual({ NM: 11, LP: 8.8, MP: 6.6, HP: 4.4 })
    expect(c.tiers.deltaPct).toEqual({ NM: 10, LP: 10, MP: 10, HP: null })
    expect(c.tiers.spread.ours.LP_NM).toBe(0.8)
    expect(c.tiers.spread.justtcg.HP_NM).toBe(0.4)
    expect(c.trends).toMatchObject({ priceChange24hr: 1.5, priceChange7d: -2, historyPoints: 2, historyDays: 11.6 })
    expect(c.graded.matched).toEqual([{ label: 'PSA 10', ourValue: 100, ourSource: 'scrydex', jtPrice: 110, deltaPct: 10 }])
    expect(c.graded.justtcgOnly).toEqual(['CGC 9.5', 'BGS Black Label 10'])
    expect(c.graded.oursOnly).toEqual([{ label: 'TAG 10', source: 'scrydex' }, { label: 'Grade 9.5', source: 'pricecharting' }])
    expect(c.graded.skipped).toEqual([{ canonical: 'PSA 9 (OC)', reason: 'qualifier:OC' }])
    expect(c.graded.qualifiersSeen).toEqual(['OC'])
    expect(c.graded.gradeLabelsSeen).toEqual(['Black Label'])
    expect(c.freshness.justtcgRawAgeDays).toBe(1)
    expect(c.freshness.ourLadderAgeDays).toBe(0)
  })
  it('an unresolved product keeps our side and reports nothing from JustTCG', () => {
    const c = compareProduct(ours, null, null)
    expect(c.resolved).toBe(false)
    expect(c.raw.justtcgNm).toBeNull()
    expect(c.tiers.justtcgTierCount).toBe(0)
    expect(c.graded.oursOnly.map(o => o.label)).toEqual(['PSA 10', 'TAG 10', 'Grade 9.5'])
  })
  it('summarises per game with medians and coverage percentages', () => {
    const a = compareProduct(ours, jtRaw, jtGraded, { nowSeconds: 1_759_000_000 })
    const b = compareProduct({ ...ours, productId: 8, game: 'YuGiOh', rows: [row({ source: 'tcgplayer', finish: 'Normal', value: 2 })] }, null, null)
    const s = summarise([a, b])
    expect(s.games.map(g => g.game)).toEqual(['Pokemon', 'YuGiOh'])
    const pk = s.games[0]
    expect(pk).toMatchObject({ sampled: 1, resolved: 1, resolvedPct: 100, justtcg3PlusTiers: 1, tierCoveragePct: 100, nmDeltaMedianPct: 10, gradedCoveragePct: 100, gradedLabelsMatched: 1, gradedDeltaMedianPct: 10 })
    expect(pk.oursOnlyLabels).toEqual(['Grade 9.5 (pricecharting)', 'TAG 10 (scrydex)'])
    expect(s.games[1]).toMatchObject({ sampled: 1, resolved: 0, resolvedPct: 0, tierCoveragePct: 0, gradedCoveragePct: 0 })
    expect(s.totals).toMatchObject({ game: 'ALL', sampled: 2, resolvedPct: 50 })
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([null, undefined])).toBeNull()
  })
})

// ── 2. The client ─────────────────────────────────────────────────────────────────────────────

function fakeKV(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
  }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('justtcgClient', () => {
  it('is unconfigured without a key and the counter key is the UTC day', () => {
    expect(justtcgConfigured({})).toBe(false)
    expect(justtcgConfigured({ JUSTTCG_API_KEY: '  ' })).toBe(false)
    expect(justtcgConfigured({ JUSTTCG_API_KEY: 'tcg_x' })).toBe(true)
    expect(dailyCounterKey(new Date('2026-10-05T23:59:00Z'))).toBe('justtcg_calls:2026-10-05')
    expect(justtcgLimits({})).toEqual({ dailyCap: 100, dailyReserve: 10, batchSize: 20, minIntervalMs: 6500 })
    expect(justtcgLimits({ JUSTTCG_DAILY_CAP: '1000', JUSTTCG_BATCH_SIZE: '100' }).batchSize).toBe(100)
  })
  it('refuses at cap − reserve and increments before the call', async () => {
    const kv = fakeKV({ 'justtcg_calls:2026-10-05': '89' })
    const env = { SLEEVEDPAGES_KV: kv, JUSTTCG_API_KEY: 'k' } as any
    const day = new Date('2026-10-05T10:00:00Z')
    const c = await reserveDailyCall(env, day)
    expect(c.used).toBe(90)
    await expect(reserveDailyCall(env, day)).rejects.toMatchObject({ kind: 'cap' })
    expect(kv.store.get('justtcg_calls:2026-10-05')).toBe('90')
  })
  it('fails closed without the key or without KV, before any HTTP call', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    await expect(justtcgFetch({ SLEEVEDPAGES_KV: fakeKV() } as any, '/v1/games', { jobName: 't' })).rejects.toMatchObject({ kind: 'not_configured' })
    await expect(justtcgFetch({ JUSTTCG_API_KEY: 'k' } as any, '/v1/games', { jobName: 't' })).rejects.toMatchObject({ kind: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('sends x-api-key only, parses v1 usage, and types 401 / 429 errors', async () => {
    const calls: Array<{ url: string; init: any }> = []
    let status = 200
    let body: unknown = { data: [], _metadata: { apiPlan: 'free', apiDailyRequestsUsed: 3 } }
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status }) }))
    const env = { SLEEVEDPAGES_KV: fakeKV(), JUSTTCG_API_KEY: 'tcg_secret' } as any
    const ok = await justtcgFetch(env, '/v1/cards', { method: 'POST', body: [{ tcgplayerId: '1' }], query: { priceHistoryDuration: '30d' }, jobName: 'b' })
    expect(ok.usage).toEqual({ apiPlan: 'free', apiDailyRequestsUsed: 3 })
    expect(calls[0].url).toBe('https://api.justtcg.com/v1/cards?priceHistoryDuration=30d')
    expect(calls[0].init.headers['x-api-key']).toBe('tcg_secret')
    expect(calls[0].init.method).toBe('POST')
    status = 401; body = { error: 'bad', code: 'INVALID_API_KEY' }
    await expect(justtcgFetch(env, '/v1/games', { jobName: 'g' })).rejects.toMatchObject({ kind: 'auth', status: 401, code: 'INVALID_API_KEY' })
    status = 429; body = { error: 'daily', code: 'DAILY_LIMIT_EXCEEDED' }
    await expect(justtcgFetch(env, '/v1/games', { jobName: 'g' })).rejects.toMatchObject({ kind: 'quota', code: 'DAILY_LIMIT_EXCEEDED' })
    status = 429; body = { error: 'slow', code: 'RATE_LIMIT_EXCEEDED' }
    await expect(justtcgFetch(env, '/v1/games', { jobName: 'g' })).rejects.toMatchObject({ kind: 'rate_limit' })
    const err = await justtcgFetch(env, '/v1/games', { jobName: 'g' }).catch(e => e as JustTcgError)
    expect(String(err.message)).not.toContain('tcg_secret')
  })
})

// ── 3. The probe + route ──────────────────────────────────────────────────────────────────────

describe('matchJustTcgGameId / buildQueue', () => {
  const games = [{ id: 'pokemon', name: 'Pokemon' }, { id: 'pokemon-japan', name: 'Pokemon Japan' }, { id: 'magic-the-gathering', name: 'Magic: The Gathering' }, { id: 'disney-lorcana', name: 'Disney Lorcana' }, { id: 'one-piece-card-game', name: 'One Piece Card Game' }, { id: 'gundam-card-game', name: 'Gundam Card Game' }, { id: 'riftbound', name: 'Riftbound' }, { id: 'yugioh', name: 'Yu-Gi-Oh!' }]
  it('maps our canonical game names to JustTCG ids, Pokemon never to Pokemon Japan', () => {
    expect(matchJustTcgGameId('Pokemon', games)).toBe('pokemon')
    expect(matchJustTcgGameId('Pokemon Japan', games)).toBe('pokemon-japan')
    expect(matchJustTcgGameId('Magic', games)).toBe('magic-the-gathering')
    expect(matchJustTcgGameId('Lorcana TCG', games)).toBe('disney-lorcana')
    expect(matchJustTcgGameId('Riftbound League of Legends Trading Card Game', games)).toBe('riftbound')
    expect(matchJustTcgGameId('YuGiOh', games)).toBe('yugioh')
    expect(matchJustTcgGameId('Cyberpunk TCG', games)).toBeNull()
  })
  it('queues one games call, raw batches of the plan size, one graded call per id, one search per id-less product', () => {
    const products = [
      { productId: 1, tcgplayerProductId: 11, game: 'Pokemon', name: 'a', number: null, setName: null, pool: 'explicit' as const },
      { productId: 2, tcgplayerProductId: 12, game: 'Pokemon', name: 'b', number: null, setName: null, pool: 'explicit' as const },
      { productId: 3, tcgplayerProductId: 13, game: 'Pokemon', name: 'c', number: null, setName: null, pool: 'explicit' as const },
      { productId: 4, tcgplayerProductId: null, game: 'Pokemon', name: 'd', number: '4', setName: null, pool: 'no_tcgplayer' as const },
    ]
    const q = buildQueue(products, 2)
    expect(q.map(i => i.kind)).toEqual(['games', 'raw-batch', 'raw-batch', 'graded', 'graded', 'graded', 'search'])
    expect((q[1] as any).tcgplayerIds).toEqual([11, 12])
  })
})

// A fake D1 that answers the probe's SELECTs from a tiny catalogue.
function probeDb(opts: { tiered?: boolean } = {}) {
  const products = [
    { id: 1, tcgplayer_product_id: 11, name: 'Pikachu', number: '25', set_name: 'Base', game: 'Pokemon' },
    { id: 2, tcgplayer_product_id: null, name: 'Promo', number: '1', set_name: 'Promos', game: 'Pokemon' },
  ]
  const prices = [
    { product_id: 1, source: 'tcgplayer', condition: null, finish: 'Normal', variant: null, grade: null, company: null, is_graded: 0, is_perfect: 0, is_signed: 0, is_error: 0, value: 10, fetched_at: 1 },
    { product_id: 1, source: 'scrydex', condition: 'NM', finish: 'normal', variant: null, grade: null, company: null, is_graded: 0, is_perfect: 0, is_signed: 0, is_error: 0, value: 9, fetched_at: 1 },
    { product_id: 1, source: 'scrydex', condition: null, finish: null, variant: null, grade: 'PSA 10', company: 'PSA', is_graded: 1, is_perfect: 0, is_signed: 0, is_error: 0, value: 100, fetched_at: 1 },
  ]
  const sql: string[] = []
  return {
    sql,
    prepare(q: string) {
      sql.push(q)
      let binds: unknown[] = []
      const stmt = {
        bind(...a: unknown[]) { binds = a; return stmt },
        async all() {
          if (/FROM prices WHERE product_id IN/.test(q)) return { results: prices.filter(p => binds.includes(p.product_id)) }
          if (/pr\.id IN/.test(q)) return { results: products.filter(p => binds.includes(p.id)) }
          if (/pr\.tcgplayer_product_id IN/.test(q)) return { results: products.filter(p => binds.includes(p.tcgplayer_product_id)) }
          if (/condition IN \('NM'/.test(q)) return { results: opts.tiered === false ? [] : products.filter(p => p.game === binds[0] && p.id === 1) }
          if (/NOT EXISTS/.test(q)) return { results: products.filter(p => p.id === 2) }
          if (/source = 'tcgplayer'/.test(q)) return { results: products.filter(p => p.game === binds[0] && p.id === 1) }
          return { results: [] }
        },
        async first() { return null },
        async run() { throw new Error('the probe must never write to D1') },
      }
      return stmt
    },
  }
}

const SECRET = 's3'
function routeEnv(extra: Record<string, unknown> = {}) {
  return { DB: probeDb(), INGESTION_WORKER_SECRET: SECRET, SLEEVEDPAGES_KV: fakeKV(), ...extra } as any
}
const post = (env: any, body: unknown, secret: string | null = SECRET) => worker.fetch(new Request('https://worker.test/admin/justtcg-probe', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'x-worker-secret': secret } : {}) }, body: JSON.stringify(body),
}), env, { waitUntil() {} } as any)

describe('POST /admin/justtcg-probe', () => {
  it('401 without the secret; 503 justtcg_not_configured without a key — before any D1 read or HTTP call', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const env = routeEnv({ JUSTTCG_API_KEY: 'k' })
    expect((await post(env, { sample: { perGame: 1 } }, null)).status).toBe(401)
    const noKey = routeEnv()
    const res = await post(noKey, { sample: { perGame: 1 } })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, error: 'justtcg_not_configured' })
    expect(noKey.DB.sql).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('selects products from the tiered pool (+ the no-TCGplayer set), runs paced calls, resumes from state, compares, persists', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      seen.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.endsWith('/v1/games')) return new Response(JSON.stringify({ data: [{ id: 'pokemon', name: 'Pokemon', cards_count: 5 }], _metadata: { apiPlan: 'free', apiDailyRequestsUsed: 1 } }))
      if (url.includes('/v1/cards?priceHistoryDuration')) return new Response(JSON.stringify({ data: [{ uuid: 'u', name: 'Pikachu', tcgplayerId: '11', variants: [{ condition: 'Near Mint', printing: 'Normal', price: 11, lastUpdated: 1 }, { condition: 'Lightly Played', printing: 'Normal', price: 9 }, { condition: 'Moderately Played', printing: 'Normal', price: 7 }] }], _metadata: { apiDailyRequestsUsed: 2 } }))
      if (url.includes('/v2/cards')) return new Response(JSON.stringify({ data: [{ id: 'u', variants: [{ type: 'graded', grading: { company: 'PSA', grade: 10, canonical: 'PSA 10' }, markets: [{ price: 105, updated_at: 2 }] }] }] }))
      if (url.includes('/v1/cards?q=')) return new Response(JSON.stringify({ data: [{ uuid: 'p', name: 'Promo', number: '1', variants: [{ condition: 'Near Mint', printing: 'Normal', price: 3 }] }], _metadata: { apiDailyRequestsUsed: 4 } }))
      return new Response('{}', { status: 404 })
    }))
    const puts: Array<{ key: string; body: string }> = []
    const bucket = { put: async (key: string, body: string) => { puts.push({ key, body }) } }
    const env = routeEnv({ JUSTTCG_API_KEY: 'k', JUSTTCG_MIN_INTERVAL_MS: '0', PRICE_ARCHIVE: bucket })

    // Invocation 1: maxCalls 2 → games + raw batch, not done, state returned.
    const r1 = await post(env, { sample: { perGame: 1, games: ['Pokemon'] }, includeNoTcgplayer: 1, maxCalls: 2 })
    const b1 = await r1.json() as any
    expect(r1.status).toBe(200)
    expect(b1).toMatchObject({ ok: true, done: false, capHit: false, products: 2, queueRemaining: 2, calls: { thisInvocation: 2, total: 2, dailyUsed: 2, dailyAllowed: 90 } })
    expect(b1.state.products.map((p: any) => p.pool)).toEqual(['scrydex_tiers', 'no_tcgplayer'])
    expect(b1.state.gameIdMap).toEqual({ Pokemon: 'pokemon' })
    expect(b1.summary).toBeUndefined()

    // Invocation 2: resume → graded + search → done, compared against THIS database's rows, persisted.
    const r2 = await post(env, { state: b1.state, maxCalls: 9 })
    const b2 = await r2.json() as any
    expect(b2).toMatchObject({ ok: true, done: true, capHit: false, calls: { thisInvocation: 2, total: 4 }, queueRemaining: 0 })
    expect(seen.map(s => s.split('?')[0])).toEqual(['GET https://api.justtcg.com/v1/games', 'POST https://api.justtcg.com/v1/cards', 'GET https://api.justtcg.com/v2/cards', 'GET https://api.justtcg.com/v1/cards'])
    expect(seen[2]).toContain('tcgplayer_id=11'); expect(seen[2]).toContain('graded=only'); expect(seen[2]).not.toContain('graded=include')
    expect(seen[3]).toContain('q=Promo'); expect(seen[3]).toContain('game=pokemon'); expect(seen[3]).toContain('number=1')
    const pika = b2.comparisons.find((c: any) => c.productId === 1)
    expect(pika).toMatchObject({ resolved: true, resolvedBy: 'tcgplayerId', raw: { ours: { value: 10, source: 'tcgplayer' }, justtcgNm: 11, deltaPct: 10 }, tiers: { justtcgTierCount: 3 } })
    expect(pika.graded.matched).toEqual([{ label: 'PSA 10', ourValue: 100, ourSource: 'scrydex', jtPrice: 105, deltaPct: 5 }])
    const promo = b2.comparisons.find((c: any) => c.productId === 2)
    expect(promo).toMatchObject({ resolved: true, resolvedBy: 'search', raw: { justtcgNm: 3 } })
    expect(b2.summary.totals).toMatchObject({ sampled: 2, resolved: 2, resolvedPct: 100 })
    expect(b2.justtcgGames).toEqual([{ id: 'pokemon', name: 'Pokemon', cards: 5 }])
    expect(b2.persisted.key).toMatch(/^probes\/justtcg\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{8}\.json$/)
    expect(puts).toHaveLength(1)
    expect(JSON.parse(puts[0].body).raw.v1['11'].name).toBe('Pikachu')
    expect(b2.raw).toBeUndefined()   // includeRaw not requested → the response stays small
  })

  it('stops with capHit when the daily counter is at cap − reserve, carrying the partial state', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const env = routeEnv({ JUSTTCG_API_KEY: 'k', SLEEVEDPAGES_KV: fakeKV({ [dailyCounterKey()]: '90' }) })
    const res = await post(env, { canonicalProductIds: [1], maxCalls: 5 })
    const b = await res.json() as any
    expect(res.status).toBe(200)
    expect(b).toMatchObject({ ok: true, done: false, capHit: true, stopped: 'cap', calls: { thisInvocation: 0, dailyUsed: 90, dailyAllowed: 90 } })
    expect(b.errors[0].kind).toBe('cap')
    expect(fetchMock).not.toHaveBeenCalled()
    // Resumable: the state comes back with the stopping item still queued and `stopped` cleared,
    // so the caller re-posts it after the cap resets (00:00 UTC) and the run continues.
    expect(b.state.queue[0]).toEqual({ kind: 'games' })
    expect(b.state.stopped).toBeNull()
    expect(b.queueRemaining).toBe(3)
  })

  it('a graded-only 404 (problem+json) is "no graded variants": counted, graded null, raw still compared, not an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/v1/games')) return new Response(JSON.stringify({ data: [{ id: 'pokemon', name: 'Pokemon' }] }))
      if (url.includes('/v1/cards?priceHistoryDuration')) return new Response(JSON.stringify({ data: [{ uuid: 'u', name: 'Pikachu', tcgplayerId: '11', variants: [{ condition: 'Near Mint', printing: 'Normal', price: 11 }] }] }))
      if (url.includes('/v2/cards')) return new Response(JSON.stringify({ type: 'https://justtcg.com/docs/errors#not-found', title: 'Card not found', status: 404, detail: 'No graded variants' }), { status: 404, headers: { 'content-type': 'application/problem+json' } })
      return new Response('{}', { status: 404 })
    }))
    const env = routeEnv({ JUSTTCG_API_KEY: 'k', JUSTTCG_MIN_INTERVAL_MS: '0' })
    const r = await runJustTcgProbe(env, { canonicalProductIds: [1], maxCalls: 10 })
    expect(r.done).toBe(true)
    expect(r.errors).toEqual([])
    expect(r.gradedNotFound404).toBe(1)
    expect(r.gradedNotFoundDetail).toContain('Card not found: No graded variants')
    expect(r.calls.total).toBe(3)                     // games + raw batch + the 404'd graded call (a spent request)
    expect(r.comparisons?.[0]).toMatchObject({ resolved: true, raw: { justtcgNm: 11 } })
    expect(r.comparisons?.[0].graded.justtcg).toEqual([])
  })

  it('selectProducts falls back to the TCGplayer-raw pool when a game has no Scrydex tiers (UAT)', async () => {
    const db = probeDb({ tiered: false }) as any
    const products = await selectProducts(db, { sample: { perGame: 1, games: ['Pokemon'] } })
    expect(products).toHaveLength(1)
    expect(products[0].pool).toBe('tcgplayer_raw')
    expect(products[0].tcgplayerProductId).toBe(11)
  })

  it('runJustTcgProbe never writes to D1 and reports an unbound PRICE_ARCHIVE', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }))))
    const env = routeEnv({ JUSTTCG_API_KEY: 'k', JUSTTCG_MIN_INTERVAL_MS: '0' })
    const r = await runJustTcgProbe(env, { canonicalProductIds: [1], maxCalls: 10 })
    expect(r.done).toBe(true)
    expect(r.persisted).toBeNull()
    expect(r.persistNote).toMatch(/PRICE_ARCHIVE/)
    expect(r.comparisons?.[0].resolved).toBe(false)
  })
})
