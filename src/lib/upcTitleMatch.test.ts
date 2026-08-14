import { describe, it, expect } from 'vitest'
import {
  titleTokens,
  aggregateTitles,
  distinctiveTokens,
  matchAggregateToCatalogue,
  readConfigInt,
  dailyCapExhausted,
  bumpDailyCount,
  dayStamp,
} from './upcTitleMatch.js'

// ── Title normalization + noise stripping ────────────────────────────────────
describe('titleTokens', () => {
  it('strips listing noise ("NEW", "SEALED", "IN HAND", quantities, emoji) but keeps identity', () => {
    expect(titleTokens('Pokemon TCG Stardust Trails Booster Box NEW SEALED In Hand! 🔥 x2'))
      .toEqual(['pokemon', 'tcg', 'stardust', 'trails', 'booster', 'box'])
  })
  it('keeps BARE numbers — "151" is a real set, not a quantity', () => {
    expect(titleTokens('Pokemon 151 Booster Bundle x3 NEW')).toEqual(['pokemon', '151', 'booster', 'bundle'])
  })
  it('keeps language markers — the matcher needs them for the language gate', () => {
    expect(titleTokens('Pokemon Japanese Booster Box Sealed')).toEqual(['pokemon', 'japanese', 'booster', 'box'])
  })
  it('empty / noise-only titles yield no tokens', () => {
    expect(titleTokens('')).toEqual([])
    expect(titleTokens('NEW SEALED ✨')).toEqual([])
    expect(titleTokens(null)).toEqual([])
  })
})

// ── Majority-signal aggregation ──────────────────────────────────────────────
describe('aggregateTitles', () => {
  it('keeps tokens present in at least HALF the titles; embellishments wash out', () => {
    const agg = aggregateTitles([
      'Pokemon TCG Stardust Trails Booster Box NEW SEALED',
      'Stardust Trails Booster Box Factory Sealed Pokemon',
      'Stardust Trails Booster Box x2 In Hand',
    ])
    expect(agg).toContain('stardust')
    expect(agg).toContain('trails')
    expect(agg).toContain('booster')
    expect(agg).toContain('box')
    expect(agg).toContain('pokemon')   // 2 of 3 → survives
    expect(agg).not.toContain('factory')  // 1 of 3 → washes out
    expect(agg).not.toContain('tcg')      // 1 of 3 → washes out
  })
  it('document frequency, not raw count — a token spammed inside ONE title is one vote', () => {
    const agg = aggregateTitles([
      'Gengar Gengar Gengar Box',
      'Stardust Box',
      'Stardust Box',
    ])
    expect(agg).not.toContain('gengar')
    expect(agg).toContain('stardust')
  })
  it('one title → its tokens verbatim (the UPCitemdb single-title case)', () => {
    expect(aggregateTitles(['Stardust Trails Booster Box'])).toBe('stardust trails booster box')
  })
  it('empty/noise-only input → null', () => {
    expect(aggregateTitles([])).toBeNull()
    expect(aggregateTitles(['NEW SEALED'])).toBeNull()
  })
})

// ── Candidate-pool discriminators ────────────────────────────────────────────
describe('distinctiveTokens', () => {
  it('excludes generic sealed vocabulary and game names, longest first, capped', () => {
    expect(distinctiveTokens('pokemon stardust trails booster box')).toEqual(['stardust', 'trails'])
  })
  it('deduplicates and respects the max', () => {
    expect(distinctiveTokens('emeralda emeralda storm shiny', 2)).toEqual(['emeralda', 'storm'])
  })
  it('nothing but generic vocabulary → empty (the caller gives up → miss)', () => {
    expect(distinctiveTokens('pokemon booster box tcg')).toEqual([])
  })
})

// ── Catalogue matching (the SHARED pickNumberlessCanonicalMatch path) ────────
type CandidateRow = { id: number; name: string; productKind: string; setName: string }
function makeDb(candidates: CandidateRow[]) {
  const queries: Array<{ sql: string; args: any[] }> = []
  return {
    _queries: queries,
    prepare(sql: string) {
      return {
        bind(...args: any[]) {
          queries.push({ sql, args })
          return { async all() { return { results: candidates } } }
        },
      }
    },
  } as any
}

const BOX  = { id: 10, name: 'Stardust Trails Booster Box',      productKind: 'sealed', setName: 'Stardust Trails' }
const CASE = { id: 11, name: 'Stardust Trails Booster Box Case', productKind: 'sealed', setName: 'Stardust Trails' }

describe('matchAggregateToCatalogue', () => {
  it('unique confident match → the canonical id (the sibling with extra tokens rejects)', async () => {
    const db = makeDb([BOX, CASE])
    const match = await matchAggregateToCatalogue(db, 'pokemon stardust trails booster box')
    expect(match).toEqual({ canonicalProductId: 10, productKind: 'sealed' })
  })
  it('ambiguity fails toward rejection — a CASE scan (its titles carry every box token too) is a miss', async () => {
    const db = makeDb([BOX, CASE])
    // Both candidates' name tokens ⊆ the haystack → two accepts → null, never a guess.
    expect(await matchAggregateToCatalogue(db, 'pokemon stardust trails booster box case')).toBeNull()
  })
  it('language gate: a Japanese-marked aggregate never matches an English set', async () => {
    const db = makeDb([BOX])
    expect(await matchAggregateToCatalogue(db, 'pokemon japanese stardust trails booster box')).toBeNull()
  })
  it('an aggregate with only generic vocabulary never even queries', async () => {
    const db = makeDb([BOX])
    expect(await matchAggregateToCatalogue(db, 'pokemon booster box')).toBeNull()
    expect(db._queries.length).toBe(0)
  })
  it('empty candidate pool → miss', async () => {
    expect(await matchAggregateToCatalogue(makeDb([]), 'stardust trails booster box')).toBeNull()
  })
  it('binds every distinctive token to the candidate query', async () => {
    const db = makeDb([BOX])
    await matchAggregateToCatalogue(db, 'pokemon stardust trails booster box')
    expect(db._queries[0].args).toEqual(['stardust', 'trails'])
  })
})

// ── Config + daily cap plumbing ──────────────────────────────────────────────
function makeConfigDb(value: string | null) {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async first() {
              if (sql.includes('app_config')) return value == null ? null : { value }
              return null
            },
          }
        },
      }
    },
  } as any
}

function makeKV() {
  const store = new Map<string, { value: string; ttl?: number }>()
  return {
    _store: store,
    async get(k: string) { return store.has(k) ? store.get(k)!.value : null },
    async put(k: string, v: string, opts?: { expirationTtl?: number }) {
      store.set(k, { value: v, ttl: opts?.expirationTtl })
    },
  } as any
}

describe('readConfigInt', () => {
  it('reads the app_config value', async () => {
    expect(await readConfigInt(makeConfigDb('120'), 'k', 60)).toBe(120)
  })
  it('missing row / broken value / throwing read → the in-code default', async () => {
    expect(await readConfigInt(makeConfigDb(null), 'k', 60)).toBe(60)
    expect(await readConfigInt(makeConfigDb('nope'), 'k', 60)).toBe(60)
    const throwing = { prepare() { throw new Error('no table') } } as any
    expect(await readConfigInt(throwing, 'k', 60)).toBe(60)
  })
})

describe('daily call cap', () => {
  const NOW = new Date('2026-08-14T12:00:00Z')
  it('exhausted exactly at the cap; bumping counts calls', async () => {
    const kv = makeKV()
    expect(await dailyCapExhausted(kv, 'p:', 2, NOW)).toBe(false)
    await bumpDailyCount(kv, 'p:', NOW)
    await bumpDailyCount(kv, 'p:', NOW)
    expect(await dailyCapExhausted(kv, 'p:', 2, NOW)).toBe(true)
    expect(kv._store.get(`p:${dayStamp(NOW)}`)?.value).toBe('2')
  })
  it('a new day starts a fresh counter', async () => {
    const kv = makeKV()
    await bumpDailyCount(kv, 'p:', NOW)
    expect(await dailyCapExhausted(kv, 'p:', 1, new Date('2026-08-15T00:01:00Z'))).toBe(false)
  })
  it('cap 0 always exhausted; missing KV never blocks', async () => {
    expect(await dailyCapExhausted(makeKV(), 'p:', 0, NOW)).toBe(true)
    expect(await dailyCapExhausted(undefined, 'p:', 5, NOW)).toBe(false)
  })
})
