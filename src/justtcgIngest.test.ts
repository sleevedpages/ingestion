// The JustTCG switch (2026-10-06) — the worker half. Pins:
//   1. the PURE mapping: condition names → tier codes (anything else skipped + counted); the
//      language rule (a product is written ONLY its own language — Japanese for Pokémon Japan,
//      English otherwise; a foreign listing on an English product is never written to it); the
//      " - <Language>" printing suffix stripped; the printing mapped to the product's CANONICAL
//      token by finishKey (unmapped → JustTCG's own spelling, counted); one row per
//      (condition, printing), the freshest listing winning; the finishKey twin of Content's;
//   2. the writer: ONE raw batch per call (POST /v1/cards, never graded), rows land as
//      source='justtcg' / is_graded=0 / grade+company+variant NULL on the mig-0073 SUPERSET conflict
//      key, a returned product's JustTCG rows are REPLACED as one group (a product JustTCG did not
//      return keeps its rows), EVERY requested product is marked fresh (`justtcg_tiers`);
//   3. the lane: the switch (off → skipped:'switch_off', no call), the key (absent →
//      skipped:'not_configured'), the population + 24 h freshness, batches of the plan size, the
//      on-view reserve, the per-run max, a plan refusal STOPS the run;
//   4. the routes: POST /justtcg/enrich-card (401 → 503 → 409 → 400 → the write), the
//      `justtcg-refresh` admin job, the 07:00 cron promise beside the news poll, the Scrydex
//      enrich `core` retirement, and the `scrydex_drain_enabled` gate (incl. Card Watch alerts
//      still receiving every watched expansion with the drain off);
//   5. the Scrydex `/price_history` credit weight (billed 3, logged 3).
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('./newsPoll.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./newsPoll.js')>()
  return { ...actual, runNewsPoll: vi.fn(async () => ({ ok: true })) }
})
vi.mock('./scrydexProcessor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scrydexProcessor.js')>()
  return {
    ...actual,
    processPendingWebhooks: vi.fn(async () => ({ scope: 'daily', expansionsFetched: 0, refreshedExpansions: [] })),
    watchedExpansionKeys: vi.fn(async () => ({ keys: new Set(['pokemon|sv08', 'onepiece|OP09']), total: 2 })),
  }
})
vi.mock('./watchAlerts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./watchAlerts.js')>()
  return { ...actual, runWatchAlerts: vi.fn(async () => ({ ok: true })) }
})
vi.mock('./scrydexEnrich.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scrydexEnrich.js')>()
  return { ...actual, enrichCard: vi.fn(async (_env: unknown, a: { classes: string[] }) => ({ ok: true, classes: a.classes })) }
})

import {
  justtcgConditionCode, finishKey, productLanguage, stripLanguageSuffix, canonicalPrintingTokens,
  mapJustTcgCard, upsertJustTcgBatch, runJustTcgRefresh, readSwitch, JUSTTCG_PRICE_UPSERT_SQL,
  JUSTTCG_FRESHNESS_CLASS,
} from './justtcgIngest.js'
import { runScrydexDrainGated } from './scrydexDrainGate.js'
import { scrydexCreditsFor } from './lib/scrydexClient.js'
import { processPendingWebhooks } from './scrydexProcessor.js'
import { runWatchAlerts } from './watchAlerts.js'
import { enrichCard } from './scrydexEnrich.js'
import { runNewsPoll } from './newsPoll.js'
import { ADMIN_JOB_IDS } from './adminJobs.js'
import worker from './worker.js'

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

// ── A small functional D1: app_config, the population sources, products, prices, freshness ──

interface PriceRow { product_id: number; source: string; condition: string | null; finish: string | null; variant: string | null; grade: string | null; company: string | null; is_graded: number; value: number | null; fetched_at: number | null }

function fakeDb(seed: {
  config?: Record<string, string>
  products?: Array<{ id: number; tcgplayer_product_id: number | null; game: string }>
  inventory?: number[]
  watches?: number[]
  prices?: PriceRow[]
  freshness?: Array<{ product_id: number; enriched_at: number }>
} = {}) {
  const config = new Map(Object.entries(seed.config ?? {}))
  const products = seed.products ?? []
  const prices: PriceRow[] = [...(seed.prices ?? [])]
  const fresh = new Map<number, number>((seed.freshness ?? []).map(f => [f.product_id, f.enriched_at]))
  const sql: string[] = []
  const exec = (q: string, a: any[]) => {
    if (q.startsWith('DELETE FROM prices')) {
      for (let i = prices.length - 1; i >= 0; i--) if (prices[i].product_id === a[0] && prices[i].source === 'justtcg' && prices[i].is_graded === 0) prices.splice(i, 1)
    } else if (q.includes('INSERT INTO prices')) {
      const [pid, condition, finish, value, fetched_at] = a
      const hit = prices.find(p => p.product_id === pid && p.source === 'justtcg' && p.condition === condition && p.finish === finish)
      if (hit) { hit.value = value; hit.fetched_at = fetched_at } else prices.push({ product_id: pid, source: 'justtcg', condition, finish, variant: null, grade: null, company: null, is_graded: 0, value, fetched_at })
    } else if (q.includes('INSERT INTO card_enrichment_freshness')) {
      fresh.set(a[0], a[1])
    } else throw new Error('unhandled write: ' + q.slice(0, 80))
  }
  return {
    sql, prices, fresh,
    prepare(q: string) {
      sql.push(q)
      let a: any[] = []
      const stmt: any = {
        _q: q,
        bind(...b: any[]) { a = b; stmt._a = b; return stmt },
        async first() {
          if (q.includes('FROM app_config')) { const v = config.get(a[0]); return v == null ? null : { value: v } }
          return null
        },
        async all() {
          if (q.includes('WITH pop AS')) {
            const pop = [...new Set([...(seed.inventory ?? []), ...(seed.watches ?? [])])]
            const cutoff = a[0]
            const rows = pop
              .filter(pid => products.find(p => p.id === pid && p.tcgplayer_product_id != null))
              .filter(pid => !fresh.has(pid) || fresh.get(pid)! < cutoff)
              .map(pid => ({ id: pid, enriched_at: fresh.get(pid) ?? null }))
              .sort((x, y) => (x.enriched_at ?? 0) - (y.enriched_at ?? 0) || x.id - y.id)
            return { results: rows }
          }
          if (q.includes('SELECT COUNT(*) AS n FROM')) return { results: [{ n: new Set([...(seed.inventory ?? []), ...(seed.watches ?? [])]).size }] }
          if (q.includes('FROM   products p JOIN sets')) return { results: products.filter(p => a.includes(p.id)) }
          if (q.includes('SELECT DISTINCT product_id, variant, finish, source, is_graded')) {
            return { results: prices.filter(p => a.includes(p.product_id) && (p.source === 'tcgplayer' || p.source === 'scrydex')) }
          }
          return { results: [] }
        },
        async run() { exec(q, a); return {} },
      }
      return stmt
    },
    async batch(stmts: any[]) { for (const s of stmts) exec(s._q, s._a ?? []); return stmts.map(() => ({})) },
  }
}

function fakeKV(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return { store, get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => { store.set(k, v) }, delete: async (k: string) => { store.delete(k) } }
}

const card = (tcgplayerId: string, variants: any[]) => ({ uuid: `u${tcgplayerId}`, tcgplayerId, variants })
const v = (condition: string, printing: string, price: number | null, extra: Record<string, unknown> = {}) => ({ condition, printing, price, lastUpdated: 1_759_000_000, ...extra })

// ── 1. Pure mapping ──────────────────────────────────────────────────────────────────────────

describe('the pure mapping', () => {
  it('condition names → tier codes; anything else is not a tier', () => {
    expect(justtcgConditionCode('Near Mint')).toBe('NM')
    expect(justtcgConditionCode('Lightly Played')).toBe('LP')
    expect(justtcgConditionCode('Moderately Played')).toBe('MP')
    expect(justtcgConditionCode('Heavily Played')).toBe('HP')
    expect(justtcgConditionCode('Damaged')).toBe('DM')
    expect(justtcgConditionCode('Sealed')).toBeNull()
    expect(justtcgConditionCode(undefined)).toBeNull()
  })
  it('finishKey is the twin of Content\'s (the two printing vocabularies compare equal)', () => {
    expect(finishKey('1st Edition Holofoil')).toBe(finishKey('firstEditionHolofoil'))
    expect(finishKey('Reverse Holofoil')).toBe(finishKey('reverseHolofoil'))
    expect(finishKey('Unlimited Edition Normal')).toBe('unlimitednormal')
    expect(finishKey(null)).toBeNull()
  })
  it('a product\'s language: Japanese for Pokémon Japan only', () => {
    expect(productLanguage('Pokemon Japan')).toBe('japanese')
    expect(productLanguage('Pokemon')).toBe('english')
    expect(productLanguage('One Piece Card Game')).toBe('english')
    expect(stripLanguageSuffix('Holofoil - Japanese')).toBe('Holofoil')
    expect(stripLanguageSuffix('1st Edition Holofoil')).toBe('1st Edition Holofoil')
  })
  it('canonical printing tokens follow unifiedPrintings: TCGplayer spelling, then variant, then Scrydex; graded ignored', () => {
    const m = canonicalPrintingTokens([
      { variant: null, finish: 'reverseHolofoil', source: 'scrydex', is_graded: 0 },
      { variant: null, finish: 'Reverse Holofoil', source: 'tcgplayer', is_graded: 0 },
      { variant: null, finish: 'normal', source: 'scrydex', is_graded: 0 },
      { variant: null, finish: 'Holofoil', source: 'scrydex', is_graded: 1 },
    ])
    expect(m.get('reverseholofoil')).toBe('Reverse Holofoil')
    expect(m.get('normal')).toBe('normal')
    expect(m.has('holofoil')).toBe(false)
  })
  it('maps one card: own language only, tier codes, canonical tokens, unmapped counted, freshest duplicate wins', () => {
    const printings = new Map([['normal', 'Normal'], ['reverseholofoil', 'Reverse Holofoil']])
    const { rows, counts } = mapJustTcgCard(card('11', [
      v('Near Mint', 'Normal', 4.5),
      v('Lightly Played', 'Normal', 3.9),
      v('Near Mint', 'Reverse Holofoil', 7),
      v('Near Mint', 'Normal', 4.4, { lastUpdated: 1_758_000_000 }),        // older duplicate → dropped
      v('Near Mint', 'Holofoil - Japanese', 50, { language: 'Japanese' }),  // foreign listing on an English product
      v('Sealed', 'Normal', 99),                                           // not a tier
      v('Damaged', 'Normal', null),                                        // no price
      v('Near Mint', 'Cosmos Holofoil', 12),                               // printing we do not hold → JustTCG's spelling
    ]), { game: 'Pokemon', printings })
    expect(rows).toEqual([
      { condition: 'NM', finish: 'Normal', value: 4.5, fetchedAt: 1_759_000_000 },
      { condition: 'LP', finish: 'Normal', value: 3.9, fetchedAt: 1_759_000_000 },
      { condition: 'NM', finish: 'Reverse Holofoil', value: 7, fetchedAt: 1_759_000_000 },
      { condition: 'NM', finish: 'Cosmos Holofoil', value: 12, fetchedAt: 1_759_000_000 },
    ])
    expect(counts).toMatchObject({ variants: 8, written: 4, skippedLanguage: 1, skippedCondition: 1, skippedNoPrice: 1, duplicates: 1, unmappedFinish: 1 })
  })
  it('a Pokémon Japan product takes ONLY its Japanese listings, suffix stripped', () => {
    const { rows, counts } = mapJustTcgCard(card('628274', [
      v('Near Mint', 'Holofoil - Japanese', 20, { language: 'Japanese' }),
      v('Near Mint', 'Holofoil', 30),                                      // English listing → never the JP product's
    ]), { game: 'Pokemon Japan', printings: new Map([['holofoil', 'Holofoil']]) })
    expect(rows).toEqual([{ condition: 'NM', finish: 'Holofoil', value: 20, fetchedAt: 1_759_000_000 }])
    expect(counts.skippedLanguage).toBe(1)
  })
})

// ── 2. The writer ────────────────────────────────────────────────────────────────────────────

describe('upsertJustTcgBatch', () => {
  it('its ON CONFLICT is the mig-0073 superset identity key', () => {
    expect(JUSTTCG_PRICE_UPSERT_SQL.replace(/\s+/g, ' ')).toContain(
      "ON CONFLICT (product_id, source, COALESCE(condition,''), COALESCE(finish,''), COALESCE(grade,''), COALESCE(variant,''), COALESCE(company,''), is_signed, is_error, is_perfect)")
    expect(JUSTTCG_PRICE_UPSERT_SQL).toContain("VALUES (?, 'justtcg', ?, ?, NULL, NULL, NULL, 0, ?, ?)")
  })

  it('ONE raw POST for the batch; replaces a returned product\'s rows; keeps an unreturned product\'s; marks every requested product fresh', async () => {
    const calls: Array<{ url: string; body: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return new Response(JSON.stringify({ data: [card('11', [v('Near Mint', 'Normal', 5), v('Lightly Played', 'Normal', 4)])], _metadata: { apiDailyRequestsUsed: 1 } }))
    }))
    const db = fakeDb({
      products: [{ id: 1, tcgplayer_product_id: 11, game: 'Pokemon' }, { id: 2, tcgplayer_product_id: 22, game: 'Pokemon' }],
      prices: [
        { product_id: 1, source: 'tcgplayer', condition: null, finish: 'Normal', variant: null, grade: null, company: null, is_graded: 0, value: 5.2, fetched_at: 1 },
        { product_id: 1, source: 'justtcg', condition: 'DM', finish: 'Normal', variant: null, grade: null, company: null, is_graded: 0, value: 1, fetched_at: 1 },   // stale tier → replaced away
        { product_id: 2, source: 'justtcg', condition: 'NM', finish: 'Normal', variant: null, grade: null, company: null, is_graded: 0, value: 9, fetched_at: 1 },   // not returned → kept
      ],
    })
    const env = { DB: db, SLEEVEDPAGES_KV: fakeKV(), JUSTTCG_API_KEY: 'k', JUSTTCG_MIN_INTERVAL_MS: '0' } as any
    const c = await upsertJustTcgBatch(env, [{ id: 1, tcgplayerId: 11, game: 'Pokemon' }, { id: 2, tcgplayerId: 22, game: 'Pokemon' }], 1_760_000_000)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('https://api.justtcg.com/v1/cards')
    expect(calls[0].url).not.toContain('graded')
    expect(calls[0].body).toEqual([{ tcgplayerId: '11' }, { tcgplayerId: '22' }])
    expect(c).toMatchObject({ requested: 2, resolved: 1, notReturned: 1, productsWritten: 1, rowsWritten: 2, calls: 1 })
    const jt = db.prices.filter(p => p.source === 'justtcg').map(p => `${p.product_id}|${p.condition}|${p.finish}|${p.value}|${p.is_graded}|${p.grade}`)
    expect(jt.sort()).toEqual(['1|LP|Normal|4|0|null', '1|NM|Normal|5|0|null', '2|NM|Normal|9|0|null'])
    expect(db.fresh.get(1)).toBe(1_760_000_000)
    expect(db.fresh.get(2)).toBe(1_760_000_000)
    expect(db.prices.find(p => p.source === 'tcgplayer')).toBeTruthy()      // other sources are never touched
  })
})

// ── 3. The lane ──────────────────────────────────────────────────────────────────────────────

describe('runJustTcgRefresh (the nightly lane)', () => {
  const products = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, tcgplayer_product_id: 100 + i + 1, game: 'Pokemon' }))
  const okFetch = () => vi.fn(async (_url: string, init: any) => {
    const ids: string[] = JSON.parse(init.body).map((x: any) => x.tcgplayerId)
    return new Response(JSON.stringify({ data: ids.map(id => card(id, [v('Near Mint', 'Normal', 2)])), _metadata: { apiDailyRequestsUsed: 1 } }))
  })

  it('switch OFF (the default) → skipped, no call, no write', async () => {
    const f = vi.fn(); vi.stubGlobal('fetch', f)
    const db = fakeDb({ products, inventory: [1, 2] })
    const r = await runJustTcgRefresh({ DB: db, SLEEVEDPAGES_KV: fakeKV(), JUSTTCG_API_KEY: 'k' } as any)
    expect(r).toMatchObject({ ok: true, skipped: 'switch_off' })
    expect(f).not.toHaveBeenCalled()
    expect(db.fresh.size).toBe(0)
  })

  it('switch ON without a key → skipped:not_configured', async () => {
    const r = await runJustTcgRefresh({ DB: fakeDb({ config: { justtcg_ingest_enabled: '1' } }), SLEEVEDPAGES_KV: fakeKV() } as any)
    expect(r.skipped).toBe('not_configured')
  })

  it('refreshes the stale population in plan-size batches, skips fresh products, marks them fresh', async () => {
    const f = okFetch(); vi.stubGlobal('fetch', f)
    const now = 1_760_000_000
    const db = fakeDb({
      config: { justtcg_ingest_enabled: '1' }, products, inventory: [1, 2, 3, 4], watches: [5],
      freshness: [{ product_id: 4, enriched_at: now - 3600 }],             // fresh → skipped
    })
    const env = { DB: db, SLEEVEDPAGES_KV: fakeKV(), JUSTTCG_API_KEY: 'k', JUSTTCG_MIN_INTERVAL_MS: '0', JUSTTCG_BATCH_SIZE: '2', JUSTTCG_DAILY_CAP: '1000' } as any
    const r = await runJustTcgRefresh(env, { nowSec: now })
    expect(r).toMatchObject({ ok: true, population: 5, stale: 4, batchesRun: 2, requested: 4, resolved: 4, rowsWritten: 4, stoppedReason: null })
    expect(f).toHaveBeenCalledTimes(2)
    expect([...db.fresh.entries()].filter(([, t]) => t === now).map(([pid]) => pid).sort()).toEqual([1, 2, 3, 5])
  })

  it('stops at the lane budget (cap − the on-view reserve) and at the per-run max', async () => {
    vi.stubGlobal('fetch', okFetch())
    const kv = fakeKV({ [`justtcg_calls:${new Date().toISOString().slice(0, 10)}`]: '800' })
    const env = { DB: fakeDb({ config: { justtcg_ingest_enabled: '1' }, products, inventory: [1, 2, 3] }), SLEEVEDPAGES_KV: kv, JUSTTCG_API_KEY: 'k', JUSTTCG_MIN_INTERVAL_MS: '0', JUSTTCG_DAILY_CAP: '1000' } as any
    const r = await runJustTcgRefresh(env)
    expect(r).toMatchObject({ batchesRun: 0, stoppedReason: 'lane_budget', laneAllowed: 800 })
    const env2 = { DB: fakeDb({ config: { justtcg_ingest_enabled: '1' }, products, inventory: [1, 2, 3] }), SLEEVEDPAGES_KV: fakeKV(), JUSTTCG_API_KEY: 'k', JUSTTCG_MIN_INTERVAL_MS: '0', JUSTTCG_BATCH_SIZE: '1', JUSTTCG_DAILY_CAP: '1000' } as any
    const r2 = await runJustTcgRefresh(env2, { maxCalls: 2 })
    expect(r2).toMatchObject({ batchesRun: 2, stoppedReason: 'max_calls' })
  })

  it('a plan refusal (401) STOPS the run and reports a failure; nothing is marked fresh', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'bad', code: 'INVALID_API_KEY' }), { status: 401 })))
    const db = fakeDb({ config: { justtcg_ingest_enabled: '1' }, products, inventory: [1, 2, 3] })
    const r = await runJustTcgRefresh({ DB: db, SLEEVEDPAGES_KV: fakeKV(), JUSTTCG_API_KEY: 'k', JUSTTCG_MIN_INTERVAL_MS: '0', JUSTTCG_BATCH_SIZE: '1', JUSTTCG_DAILY_CAP: '1000' } as any)
    expect(r).toMatchObject({ ok: false, stoppedReason: 'auth', batchesRun: 1, batchesFailed: 1 })
    expect(db.fresh.size).toBe(0)
  })

  it('readSwitch: "1"/"0" exact, anything else or a broken DB → the code default', async () => {
    expect(await readSwitch(fakeDb({ config: { k: '1' } }) as any, 'k', false)).toBe(true)
    expect(await readSwitch(fakeDb({ config: { k: '0' } }) as any, 'k', true)).toBe(false)
    expect(await readSwitch(fakeDb({ config: { k: 'yes' } }) as any, 'k', false)).toBe(false)
    expect(await readSwitch({} as any, 'k', true)).toBe(true)
  })
})

// ── 4. The routes / crons ────────────────────────────────────────────────────────────────────

const SECRET = 's3'
const postTo = (path: string, env: any, body: unknown, secret: string | null = SECRET, ctx: any = { waitUntil() {} }) => worker.fetch(new Request(`https://worker.test${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'x-worker-secret': secret } : {}) }, body: JSON.stringify(body),
}), env, ctx)

describe('POST /justtcg/enrich-card', () => {
  const products = [{ id: 7, tcgplayer_product_id: 77, game: 'Pokemon' }]
  it('refuses in order: 401 secret → 503 key → 409 switch → 400 body', async () => {
    const f = vi.fn(); vi.stubGlobal('fetch', f)
    const on = { justtcg_ingest_enabled: '1' }
    expect((await postTo('/justtcg/enrich-card', { DB: fakeDb({ config: on }), INGESTION_WORKER_SECRET: SECRET, JUSTTCG_API_KEY: 'k' }, { canonicalProductId: 7 }, null)).status).toBe(401)
    const r503 = await postTo('/justtcg/enrich-card', { DB: fakeDb({ config: on }), INGESTION_WORKER_SECRET: SECRET }, { canonicalProductId: 7 })
    expect(r503.status).toBe(503)
    expect(await r503.json()).toEqual({ ok: false, error: 'justtcg_not_configured' })
    const r409 = await postTo('/justtcg/enrich-card', { DB: fakeDb(), INGESTION_WORKER_SECRET: SECRET, JUSTTCG_API_KEY: 'k' }, { canonicalProductId: 7 })
    expect(r409.status).toBe(409)
    expect(await r409.json()).toEqual({ ok: false, error: 'justtcg_ingest_disabled' })
    expect((await postTo('/justtcg/enrich-card', { DB: fakeDb({ config: on }), INGESTION_WORKER_SECRET: SECRET, JUSTTCG_API_KEY: 'k' }, { canonicalProductId: 'x' })).status).toBe(400)
    expect(f).not.toHaveBeenCalled()
  })
  it('writes one product\'s tiers and marks it fresh', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [card('77', [v('Near Mint', 'Normal', 3)])], _metadata: { apiDailyRequestsUsed: 1 } }))))
    const db = fakeDb({ config: { justtcg_ingest_enabled: '1' }, products })
    const res = await postTo('/justtcg/enrich-card', { DB: db, SLEEVEDPAGES_KV: fakeKV(), INGESTION_WORKER_SECRET: SECRET, JUSTTCG_API_KEY: 'k', JUSTTCG_MIN_INTERVAL_MS: '0' }, { canonicalProductId: 7 })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, productId: 7, resolved: 1, rowsWritten: 1 })
    expect(db.fresh.has(7)).toBe(true)
  })
  it('a product with no TCGplayer id is a clean skip (no call)', async () => {
    const f = vi.fn(); vi.stubGlobal('fetch', f)
    const res = await postTo('/justtcg/enrich-card', { DB: fakeDb({ config: { justtcg_ingest_enabled: '1' }, products: [{ id: 8, tcgplayer_product_id: null, game: 'Pokemon' }] }), SLEEVEDPAGES_KV: fakeKV(), INGESTION_WORKER_SECRET: SECRET, JUSTTCG_API_KEY: 'k' }, { canonicalProductId: 8 })
    expect(await res.json()).toMatchObject({ ok: true, skipped: 'no_tcgplayer_id' })
    expect(f).not.toHaveBeenCalled()
  })
})

describe('the justtcg-refresh admin job + the 07:00 cron promise', () => {
  it('is an admin job id; 503 without a key; runs the lane fire-and-forget', async () => {
    expect(ADMIN_JOB_IDS).toContain('justtcg-refresh')
    const noKey = await postTo('/admin/run-job', { DB: fakeDb(), INGESTION_WORKER_SECRET: SECRET, SLEEVEDPAGES_KV: fakeKV() }, { job: 'justtcg-refresh' })
    expect(noKey.status).toBe(503)
    const waits: Promise<unknown>[] = []
    const db = fakeDb()   // switch off → the lane no-ops, but it RAN (the run-log path)
    const res = await postTo('/admin/run-job', { DB: db, INGESTION_WORKER_SECRET: SECRET, SLEEVEDPAGES_KV: fakeKV(), JUSTTCG_API_KEY: 'k' }, { job: 'justtcg-refresh' }, SECRET, { waitUntil: (p: Promise<unknown>) => waits.push(p) })
    expect(res.status).toBe(200)
    await Promise.all(waits)
    expect(db.sql.some(q => q.includes("key = ?") && q.includes('app_config'))).toBe(true)
  })
  it('07:00 runs the news poll AND the JustTCG lane as separate promises', async () => {
    const waits: Promise<unknown>[] = []
    const db = fakeDb()
    await worker.scheduled({ cron: '0 7 * * *' } as any, { DB: db, SLEEVEDPAGES_KV: fakeKV(), JUSTTCG_API_KEY: 'k' } as any, { waitUntil: (p: Promise<unknown>) => waits.push(p) } as any)
    expect(waits).toHaveLength(2)
    await Promise.all(waits)
    expect(runNewsPoll).toHaveBeenCalledTimes(1)
    expect(db.sql.some(q => q.includes('FROM app_config'))).toBe(true)
  })
})

describe('the Scrydex retirement switches', () => {
  it('POST /scrydex/enrich-card drops `core` when the JustTCG ingest switch is ON (comps/history untouched)', async () => {
    const env = (cfg: Record<string, string>) => ({ DB: fakeDb({ config: cfg }), INGESTION_WORKER_SECRET: SECRET, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' })
    const only = await postTo('/scrydex/enrich-card', env({ justtcg_ingest_enabled: '1' }), { canonicalProductId: 5, classes: ['core'] })
    expect(await only.json()).toEqual({ ok: true, skipped: 'core_retired', canonicalProductId: 5 })
    expect(enrichCard).not.toHaveBeenCalled()
    await postTo('/scrydex/enrich-card', env({ justtcg_ingest_enabled: '1' }), { canonicalProductId: 5, classes: ['core', 'history'] })
    expect(enrichCard).toHaveBeenLastCalledWith(expect.anything(), { canonicalProductId: 5, classes: ['history'] })
    await postTo('/scrydex/enrich-card', env({}), { canonicalProductId: 5, classes: ['core'] })
    expect(enrichCard).toHaveBeenLastCalledWith(expect.anything(), { canonicalProductId: 5, classes: ['core'] })
  })

  it('scrydex_drain_enabled ON (default) = exactly the calls that shipped', async () => {
    await runScrydexDrainGated({ DB: fakeDb() } as any, 'daily')
    expect(processPendingWebhooks).toHaveBeenLastCalledWith(expect.anything())
    expect(vi.mocked(processPendingWebhooks).mock.calls.at(-1)).toHaveLength(1)
    await runScrydexDrainGated({ DB: fakeDb() } as any, 'watched')
    expect(processPendingWebhooks).toHaveBeenLastCalledWith(expect.anything(), { scope: 'watched' })
  })

  it('OFF → no Scrydex call; the daily drain reports the no-op; the watch lane hands back EVERY watched expansion', async () => {
    const db = fakeDb({ config: { scrydex_drain_enabled: '0' } })
    expect(await runScrydexDrainGated({ DB: db } as any, 'daily')).toEqual({ scope: 'daily', expansionsFetched: 0, refreshedExpansions: [], skipped: 'scrydex_drain_disabled' })
    const w = await runScrydexDrainGated({ DB: db } as any, 'watched')
    expect(w.skipped).toBe('scrydex_drain_disabled')
    expect(w.refreshedExpansions).toEqual([{ gameSlug: 'pokemon', expansion: 'sv08' }, { gameSlug: 'onepiece', expansion: 'OP09' }])
    expect(processPendingWebhooks).not.toHaveBeenCalled()
  })

  it('the 10/16/22 lane with the drain OFF still fires the alert hook with every watched expansion', async () => {
    const waits: Promise<unknown>[] = []
    await worker.scheduled({ cron: '0 10,16,22 * * *' } as any, { DB: fakeDb({ config: { scrydex_drain_enabled: '0' } }), SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't', CONTENT_APP_URL: 'https://x' } as any, { waitUntil: (p: Promise<unknown>) => waits.push(p) } as any)
    await Promise.all(waits)
    expect(processPendingWebhooks).not.toHaveBeenCalled()
    expect(runWatchAlerts).toHaveBeenCalledWith(expect.anything(), [{ gameSlug: 'pokemon', expansion: 'sv08' }, { gameSlug: 'onepiece', expansion: 'OP09' }])
  })
})

// ── 5. The Scrydex credit weight ─────────────────────────────────────────────────────────────

describe('scrydexCreditsFor', () => {
  it('books /price_history at 3 (what Scrydex bills) and every other read at 1', () => {
    expect(scrydexCreditsFor('/pokemon/v1/cards/sv8-1/price_history')).toBe(3)
    expect(scrydexCreditsFor('/pokemon/v1/cards/sv8-1/price_history?days=30')).toBe(3)
    expect(scrydexCreditsFor('/pokemon/v1/cards/sv8-1/listings')).toBe(1)
    expect(scrydexCreditsFor('/pokemon/v1/cards')).toBe(1)
    expect(scrydexCreditsFor('/pokemon/v1/expansions')).toBe(1)
  })
})

it('the freshness class is its own (never the Scrydex core/comps/history classes)', () => {
  expect(JUSTTCG_FRESHNESS_CLASS).toBe('justtcg_tiers')
})
