import { describe, it, expect } from 'vitest'
import {
  variantFinish,
  frontImageLarge,
  tcgProductIdOf,
  joinPrintings,
  collectVariantEntries,
  contestedProductIds,
  conflictUpsert,
  captureUpdate,
  isCrossProduct,
  planVariantWrites,
  type VariantEntry,
} from './variantCapture.js'

// ── Minimal fake D1 — records prepared SQL + binds; routes first() via a callback. ──
interface FakeStmt { sql: string; args: unknown[]; bind: (...a: unknown[]) => FakeStmt; first: () => Promise<unknown>; run: () => Promise<unknown> }
function makeFakeDB(first?: (sql: string, args: unknown[]) => unknown) {
  const db = {
    prepare(sql: string): FakeStmt {
      const stmt: FakeStmt = {
        sql, args: [],
        bind(...a: unknown[]) { stmt.args = a; return stmt },
        async first() { return first ? first(sql, stmt.args) : null },
        async run() { return {} },
      }
      return stmt
    },
  }
  return db as any
}

// The captured OP09-004 shape (8 variants; two share product_id 657442).
const OP09_004 = {
  id: 'OP09-004',
  number: 'OP09-004',
  printings: [{ code: 'OP09' }, { code: 'OP13' }, { code: 'PRB02' }],
  variants: [
    { name: 'foil',              marketplaces: [{ name: 'tcgplayer', product_id: '111' }], images: [{ type: 'front', large: 'op09-004A.jpg' }], printings: ['OP09'] },
    { name: 'altArt',            marketplaces: [{ name: 'tcgplayer', product_id: '222' }], images: [{ type: 'front', large: 'op09-004C.jpg' }], printings: ['OP09'] },
    { name: 'wantedPoster',      marketplaces: [{ name: 'tcgplayer', product_id: '657442' }], images: [{ type: 'front', large: 'op09-004W.jpg' }], printings: ['OP13'] },
    { name: 'goldSpecialAltArt', marketplaces: [{ name: 'tcgplayer', product_id: '657442' }], images: [{ type: 'front', large: 'op09-004G.jpg' }], printings: ['PRB02'] },
  ],
}

describe('variantFinish', () => {
  it("maps 'normal'/missing -> 'normal' and others verbatim", () => {
    expect(variantFinish('normal')).toBe('normal')
    expect(variantFinish(null)).toBe('normal')
    expect(variantFinish(undefined)).toBe('normal')
    expect(variantFinish('foil')).toBe('foil')
    expect(variantFinish('altArt')).toBe('altArt')
  })
})

describe('payload field extraction', () => {
  it('frontImageLarge prefers the front/large image', () => {
    expect(frontImageLarge({ images: [{ type: 'front', large: 'L', medium: 'M' }] })).toBe('L')
    expect(frontImageLarge({ images: [{ type: 'front', medium: 'M' }] })).toBe('M')
    expect(frontImageLarge({ images: [] })).toBeNull()
  })
  it('tcgProductIdOf parses the tcgplayer marketplace product_id', () => {
    expect(tcgProductIdOf({ marketplaces: [{ name: 'tcgplayer', product_id: '657442' }] })).toBe(657442)
    expect(tcgProductIdOf({ marketplaces: [{ name: 'cardmarket', product_id: '5' }] })).toBeNull()
    expect(tcgProductIdOf({ marketplaces: [] })).toBeNull()
  })
  it('joinPrintings tolerates strings and objects', () => {
    expect(joinPrintings(['OP09', 'OP13'])).toBe('OP09, OP13')
    expect(joinPrintings([{ code: 'OP09' }, { name: 'Promo' }])).toBe('OP09, Promo')
    expect(joinPrintings([])).toBeNull()
    expect(joinPrintings(null)).toBeNull()
  })
})

describe('collectVariantEntries', () => {
  it('captures data.id, variant.name, distinct image + product_id per variant', () => {
    const entries = collectVariantEntries([OP09_004], 'OP09')
    expect(entries).toHaveLength(4)
    expect(entries[0]).toEqual<VariantEntry>({
      cardId: 'OP09-004', number: 'OP09-004', variantName: 'foil',
      tcgProductId: 111, imageUrl: 'op09-004A.jpg', printings: 'OP09', setCode: 'OP09',
    })
    // Distinct image per variant (the variant-image-pull fix).
    expect(entries.map(e => e.imageUrl)).toEqual(['op09-004A.jpg', 'op09-004C.jpg', 'op09-004W.jpg', 'op09-004G.jpg'])
  })
  it('skips variants without a tcgplayer product_id', () => {
    const card = { id: 'X-1', number: '1', variants: [{ name: 'foil', images: [{ type: 'front', large: 'x.jpg' }] }] }
    expect(collectVariantEntries([card], null)).toHaveLength(0)
  })
})

describe('contestedProductIds — intra-payload duplicate detection', () => {
  it('flags the product_id claimed by two variants (657442)', () => {
    const entries = collectVariantEntries([OP09_004], 'OP09')
    const contested = contestedProductIds(entries)
    expect([...contested]).toEqual([657442])
    expect(contested.has(111)).toBe(false)
  })
})

describe('captureUpdate', () => {
  it('binds data.id / variant.name / finish / product_id and uses COALESCE-preserve UPDATE', () => {
    const db = makeFakeDB()
    const entry: VariantEntry = { cardId: 'OP09-004', number: 'OP09-004', variantName: 'altArt', tcgProductId: 222, imageUrl: 'x', printings: null, setCode: null }
    const stmt = captureUpdate(db, entry) as unknown as FakeStmt
    expect(stmt.args).toEqual(['OP09-004', 'altArt', 'altArt', 222])
    expect(stmt.sql).toContain('UPDATE products')
    expect(stmt.sql).toContain('COALESCE(?, scrydex_card_id)')
    expect(stmt.sql).toContain('WHERE tcgplayer_product_id = ?')
  })
})

describe('conflictUpsert', () => {
  it('binds the conflict row and dedupes on the triple', () => {
    const db = makeFakeDB()
    const entry: VariantEntry = { cardId: 'OP09-004', number: 'OP09-004', variantName: 'wantedPoster', tcgProductId: 657442, imageUrl: 'op09-004W.jpg', printings: 'OP13', setCode: 'OP09' }
    const stmt = conflictUpsert(db, entry) as unknown as FakeStmt
    expect(stmt.args).toEqual(['OP09-004', '657442', 'wantedPoster', 'OP13', 'op09-004W.jpg', 'OP09'])
    expect(stmt.sql).toContain('INSERT INTO variant_ingest_conflicts')
    expect(stmt.sql).toContain('ON CONFLICT (scrydex_card_id, tcgplayer_product_id, variant_name)')
  })
})

describe('isCrossProduct', () => {
  it('flags a product_id owned by a different card, not a free or same-card one', () => {
    const existing = new Map<number, string | null>([
      [999, 'SOME-OTHER-CARD'],  // owned by a different card
      [222, 'OP09-004'],         // owned by the same card
      [333, null],               // exists but unclaimed
    ])
    expect(isCrossProduct(existing, 999, 'OP09-004')).toBe(true)
    expect(isCrossProduct(existing, 222, 'OP09-004')).toBe(false)
    expect(isCrossProduct(existing, 333, 'OP09-004')).toBe(false)
    expect(isCrossProduct(existing, 111, 'OP09-004')).toBe(false)  // no row yet
  })
})

describe('planVariantWrites', () => {
  it('routes intra-payload duplicates to conflicts and captures the clean ones', () => {
    const db = makeFakeDB()
    const entries = collectVariantEntries([OP09_004], 'OP09')

    // No existing products → no cross-product conflicts.
    const plan = planVariantWrites(db, entries, new Map(), (e: VariantEntry) => [captureUpdate(db, e)])

    // foil(111) + altArt(222) clean; wantedPoster + goldSpecialAltArt share 657442 → 2 conflicts.
    expect(plan.captured).toBe(2)
    expect(plan.conflicted).toBe(2)
    const conflictStmts = (plan.statements as unknown as FakeStmt[]).filter(s => s.sql.includes('variant_ingest_conflicts'))
    expect(conflictStmts).toHaveLength(2)
    expect(conflictStmts.every(s => s.args[1] === '657442')).toBe(true)
  })

  it('routes a cross-product collision (product_id owned by a different card) to conflicts', () => {
    const card = { id: 'OP01-001', number: 'OP01-001', variants: [
      { name: 'foil', marketplaces: [{ name: 'tcgplayer', product_id: '999' }], images: [{ type: 'front', large: 'a.jpg' }], printings: ['OP01'] },
    ] }
    const db = makeFakeDB()
    const entries = collectVariantEntries([card], 'OP01')
    const existing = new Map<number, string | null>([[999, 'SOME-OTHER-CARD']])
    const plan = planVariantWrites(db, entries, existing, () => [db.prepare('noop')])
    expect(plan.conflicted).toBe(1)
    expect(plan.captured).toBe(0)
  })

  it('counts an empty cleanWrite as skipped, not captured', () => {
    const db = makeFakeDB()
    const card = { id: 'C-1', number: '1', variants: [
      { name: 'foil', marketplaces: [{ name: 'tcgplayer', product_id: '5' }], images: [{ type: 'front', large: 'a.jpg' }] },
    ] }
    const plan = planVariantWrites(db, collectVariantEntries([card], null), new Map(), () => [])
    expect(plan.skipped).toBe(1)
    expect(plan.captured).toBe(0)
  })
})
