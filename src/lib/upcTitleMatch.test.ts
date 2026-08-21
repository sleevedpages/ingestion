import { describe, it, expect } from 'vitest'
import {
  titleTokens,
  foldDiacritics,
  aggregateTitles,
  distinctiveTokens,
  matchAggregateToCatalogue,
  readConfigInt,
  dailyCapExhausted,
  bumpDailyCount,
  dayStamp,
  DISCRIMINATOR_MIN,
  type MatchTrace,
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
  // 2026-08-21: norm() turns every non-[a-z0-9] byte into a space, so an accented brand used
  // to shatter into junk tokens that could win a discriminator slot and guarantee an empty
  // candidate pool. Measured on the real UPCitemdb title for 196214136144.
  it('FOLDS diacritics — "Pokémon" is one token "pokemon", never "pok" + "mon"', () => {
    expect(foldDiacritics('Pokémon Café')).toBe('Pokemon Cafe')
    const tokens = titleTokens('Pokémon Pokemon Tcg: Mega Evolution Enhanced Booster Box')
    expect(tokens).not.toContain('pok')
    expect(tokens).not.toContain('mon')
    expect(tokens.filter((t) => t === 'pokemon')).toHaveLength(2)
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
    expect(match).toEqual({ canonicalProductId: 10, productKind: 'sealed', discriminatorsUsed: 2 })
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

// ── Candidate-pool RELAXATION + the real prod cases (2026-08-21) ─────────────
//
// A DB fake that answers per discriminator SET, so the relaxation retry is observable.
// Key = the bound tokens joined by '|'.
function makeStagedDb(byTokens: Record<string, CandidateRow[]>) {
  const queries: string[][] = []
  return {
    _queries: queries,
    prepare() {
      return {
        bind(...args: any[]) {
          queries.push(args as string[])
          return { async all() { return { results: byTokens[(args as string[]).join('|')] ?? [] } } }
        },
      }
    },
  } as any
}

/** The REAL prod catalogue rows (queried 2026-08-21) — the sibling trio the ladder must
 * discriminate, all three in the same set. */
const ME_PLAIN    = { id: 1046, name: 'Mega Evolution Booster Box',          productKind: 'sealed', setName: 'ME01: Mega Evolution' }
const ME_ENHANCED = { id: 1047, name: 'Mega Evolution Enhanced Booster Box', productKind: 'sealed', setName: 'ME01: Mega Evolution' }
const ME_HALF     = { id: 1048, name: 'Mega Evolution Half Booster Box',     productKind: 'sealed', setName: 'ME01: Mega Evolution' }
const ME_CASE     = { id: 1064, name: 'Mega Evolution Enhanced Booster Case', productKind: 'sealed', setName: 'ME01: Mega Evolution' }
const ME_CODE     = { id: 1266, name: 'Code Card - Mega Evolution Enhanced Booster Display Box digital bundle', productKind: 'card', setName: 'ME01: Mega Evolution' }
const MTG_DECK    = { id: 81977, name: 'Commander 2020 Deck - Enhanced Evolution', productKind: 'sealed', setName: 'Commander 2020' }

/** The REAL UPCitemdb title for barcode 196214136144, verbatim (fetched 2026-08-21). */
const REAL_UPCITEMDB_TITLE =
  'Pokémon Pokemon Tcg: Mega Evolution Enhanced Booster Display Box - 36 Packs & Box Topper'

describe('candidate-pool relaxation (the 2026-08-21 zero-pool defect)', () => {
  it('the REAL UPCitemdb title yields [evolution, enhanced, topper] — "topper" is in no catalogue name', () => {
    const agg = aggregateTitles([REAL_UPCITEMDB_TITLE])!
    expect(distinctiveTokens(agg)).toEqual(['evolution', 'enhanced', 'topper'])
  })

  it('an EMPTY pool drops the weakest discriminator and retries ONCE — 196214136144 → product 1047', async () => {
    const agg = aggregateTitles([REAL_UPCITEMDB_TITLE])!
    // The real prod pools: 3 tokens → nothing; 2 tokens → the five rows measured on prod.
    const db = makeStagedDb({
      'evolution|enhanced|topper': [],
      'evolution|enhanced': [MTG_DECK, ME_CASE, ME_ENHANCED, ME_CODE],
    })
    const traces: MatchTrace[] = []
    const match = await matchAggregateToCatalogue(db, agg, { onTrace: (t) => traces.push(t) })
    expect(match).toEqual({ canonicalProductId: 1047, productKind: 'sealed', discriminatorsUsed: 2 })
    expect(db._queries).toEqual([['evolution', 'enhanced', 'topper'], ['evolution', 'enhanced']])
    expect(traces[0].relaxed).toBe(true)
    expect(traces[0].rejectStage).toBeUndefined()
  })

  it('relaxation NEVER goes below DISCRIMINATOR_MIN — a still-empty pool is a miss, not a 1-token scan', async () => {
    const agg = aggregateTitles([REAL_UPCITEMDB_TITLE])!
    const db = makeStagedDb({})   // every set is empty
    const traces: MatchTrace[] = []
    expect(await matchAggregateToCatalogue(db, agg, { onTrace: (t) => traces.push(t) })).toBeNull()
    expect(db._queries.map((q) => q.length)).toEqual([3, DISCRIMINATOR_MIN])
    expect(traces[0].rejectStage).toBe('no_candidates')
  })

  it('does NOT relax after the matcher REJECTS a non-empty pool (precision over recall)', async () => {
    const agg = aggregateTitles([REAL_UPCITEMDB_TITLE])!
    // 3 tokens finds a real-but-wrong candidate; widening could only add accepts.
    const db = makeStagedDb({ 'evolution|enhanced|topper': [MTG_DECK] })
    const traces: MatchTrace[] = []
    expect(await matchAggregateToCatalogue(db, agg, { onTrace: (t) => traces.push(t) })).toBeNull()
    expect(db._queries).toHaveLength(1)
    expect(traces[0]).toMatchObject({ rejectStage: 'no_confident_match', candidatePool: 1 })
  })

  it('a fully generic aggregate is never queried at all', async () => {
    const db = makeStagedDb({})
    const traces: MatchTrace[] = []
    expect(await matchAggregateToCatalogue(db, 'pokemon booster box tcg', { onTrace: (t) => traces.push(t) })).toBeNull()
    expect(db._queries).toHaveLength(0)
    expect(traces[0].rejectStage).toBe('no_discriminators')
  })
})

describe('THE SIBLING TRIO — 1046 / 1047 / 1048 (precision pin; must never guess)', () => {
  const agg = aggregateTitles([REAL_UPCITEMDB_TITLE])!

  it('the Enhanced title NEVER resolves to 1046 (plain) or 1048 (half)', async () => {
    // Whole trio in the pool: 1046's tokens are a strict SUBSET of 1047's, so BOTH accept.
    // Two accepts is an AMBIGUITY and the matcher must refuse — a wrong hit here would write a
    // permanent product_upcs row that silently adds the wrong box to every future scan.
    const db = makeStagedDb({ 'evolution|enhanced|topper': [ME_PLAIN, ME_ENHANCED, ME_HALF] })
    const match = await matchAggregateToCatalogue(db, agg)
    expect(match).toBeNull()
    expect(match?.canonicalProductId).not.toBe(1046)
    expect(match?.canonicalProductId).not.toBe(1048)
  })

  it('1048 (Half) is rejected outright — its "half" token is absent from the haystack', async () => {
    const db = makeStagedDb({ 'evolution|enhanced|topper': [ME_HALF] })
    expect(await matchAggregateToCatalogue(db, agg)).toBeNull()
  })

  it('the Enhanced title DOES resolve to 1047 once the plain box is out of the pool', async () => {
    const db = makeStagedDb({ 'evolution|enhanced|topper': [ME_ENHANCED, ME_HALF, ME_CASE] })
    expect((await matchAggregateToCatalogue(db, agg))?.canonicalProductId).toBe(1047)
  })

  it('a PLAIN-box title never reaches 1047 or 1048 (the reverse direction)', async () => {
    const plain = aggregateTitles(['Pokemon TCG Mega Evolution Booster Box Factory Sealed'])!
    const db = makeStagedDb({ 'evolution|mega': [ME_PLAIN, ME_ENHANCED, ME_HALF] })
    expect((await matchAggregateToCatalogue(db, plain))?.canonicalProductId).toBe(1046)
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
