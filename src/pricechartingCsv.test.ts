import { describe, it, expect } from 'vitest'
import {
  parseDollarsToCents,
  parseCsvLine,
  detectDelimiter,
  buildHeaderIndex,
  rowFromFields,
  isSealedRow,
  csvRowToPriceRows,
  validateTcgIdMatch,
  pickBestCanonicalMatch,
  pickNumberlessCanonicalMatch,
  PC_PRICE_COLUMNS,
  PC_GRADED_COLUMNS,
  PRICECHARTING_CATEGORIES,
  buildDownloadUrl,
} from './lib/pricechartingCsv.js'

// ── Dollar parsing → cents ─────────────────────────────────────────────────────
describe('parseDollarsToCents', () => {
  it('parses dollar strings to integer cents', () => {
    expect(parseDollarsToCents('$46.47')).toBe(4647)
    expect(parseDollarsToCents('$1,234.56')).toBe(123456)
    expect(parseDollarsToCents('12')).toBe(1200)
    expect(parseDollarsToCents('$0.05')).toBe(5)
  })
  it('returns null for blank / zero / non-positive / garbage', () => {
    expect(parseDollarsToCents('')).toBeNull()
    expect(parseDollarsToCents('  ')).toBeNull()
    expect(parseDollarsToCents('$0.00')).toBeNull()
    expect(parseDollarsToCents('0')).toBeNull()
    expect(parseDollarsToCents('abc')).toBeNull()
    expect(parseDollarsToCents(null)).toBeNull()
    expect(parseDollarsToCents(undefined)).toBeNull()
  })
})

// ── CSV line parsing (quotes + commas) ──────────────────────────────────────────
describe('parseCsvLine', () => {
  it('splits simple fields', () => {
    expect(parseCsvLine('1,Pokemon,Charizard')).toEqual(['1', 'Pokemon', 'Charizard'])
  })
  it('honours quoted fields containing commas', () => {
    expect(parseCsvLine('1,"Charizard ex, #125",Pokemon'))
      .toEqual(['1', 'Charizard ex, #125', 'Pokemon'])
  })
  it('honours "" escaped quotes inside a quoted field', () => {
    expect(parseCsvLine('1,"He said ""hi""",x')).toEqual(['1', 'He said "hi"', 'x'])
  })
  it('keeps trailing empty fields', () => {
    expect(parseCsvLine('a,,c,')).toEqual(['a', '', 'c', ''])
  })
})

// ── delimiter detection (real export is TAB-separated) ──────────────────────────
describe('detectDelimiter', () => {
  it('detects tabs in the real PriceCharting header', () => {
    expect(detectDelimiter('id\tconsole-name\tproduct-name\tloose-price')).toBe('\t')
  })
  it('falls back to comma for a genuine CSV header', () => {
    expect(detectDelimiter('id,console-name,product-name,loose-price')).toBe(',')
  })
})

describe('parseCsvLine with a tab delimiter (unquoted commas in price fields)', () => {
  it('keeps "$2,200.00" intact as one field — comma-split would shred it', () => {
    const line = '9972159\tOne Piece Extra Booster\tMonkey.D.Luffy [Dodgers] EB02-010\t$2,200.00 \t$890.97 '
    const f = parseCsvLine(line, '\t')
    expect(f[0]).toBe('9972159')
    expect(f[2]).toBe('Monkey.D.Luffy [Dodgers] EB02-010')
    expect(f[3]).toBe('$2,200.00 ')
    expect(parseDollarsToCents(f[3])).toBe(220000) // $2,200.00 → cents
  })
})

// ── real operator-supplied row (tab-separated, $1,000s with commas) ──────────────
describe('real PriceCharting row (One Piece EB02-010)', () => {
  const HEADER = 'id\tconsole-name\tproduct-name\tloose-price\tcib-price\tnew-price\tgraded-price\tbox-only-price\tmanual-only-price\tbgs-10-price\tcondition-17-price\tcondition-18-price\tgamestop-price\tgamestop-trade-price\tretail-loose-buy\tretail-loose-sell\tretail-cib-buy\tretail-cib-sell\tretail-new-buy\tretail-new-sell\tupc\tsales-volume\tgenre\ttcg-id\tasin\tepid\trelease-date'
  const DATA   = '9972159\tOne Piece Extra Booster Anime 25th Collection\tMonkey.D.Luffy [Dodgers] EB02-010\t$2,200.00 \t$890.97 \t$1,300.00 \t$2,121.75 \t$2,334.00 \t$4,462.06 \t$3,607.97 \t$1,775.00 \t$2,677.00 \t\t\t$1,452.00 \t$2,420.00 \t$588.00 \t$980.00 \t$858.00 \t$1,430.00 \t\t628\tOne Piece Card\t641620\t\t\t7/3/2025'
  const delim = detectDelimiter(HEADER)
  const idx = buildHeaderIndex(parseCsvLine(HEADER, delim))
  const row = rowFromFields(parseCsvLine(DATA, delim), idx)

  it('aligns every column correctly', () => {
    expect(delim).toBe('\t')
    expect(row['id']).toBe('9972159')
    expect(row['product-name']).toBe('Monkey.D.Luffy [Dodgers] EB02-010')
    expect(row['tcg-id']).toBe('641620')
    expect(row['sales-volume']).toBe('628')
    expect(row['genre']).toBe('One Piece Card')
    expect(isSealedRow(row)).toBe(false)
  })
  it('decodes the price rows: loose→ungraded, manual-only→PSA 10, etc. (dollars)', () => {
    const byGrade = Object.fromEntries(
      csvRowToPriceRows(row).map((r) => [r.grade ?? 'ungraded', r.valueDollars]),
    )
    expect(byGrade['ungraded']).toBe(2200)        // loose-price $2,200.00
    expect(byGrade['PSA 10']).toBe(4462.06)       // manual-only-price
    expect(byGrade['BGS 10']).toBe(3607.97)       // bgs-10-price
    expect(byGrade['CGC 10']).toBe(1775)          // condition-17-price
    expect(byGrade['SGC 10']).toBe(2677)          // condition-18-price
    expect(byGrade['Grade 9']).toBe(2121.75)      // graded-price
    expect(byGrade['Grade 9.5']).toBe(2334)       // box-only-price
    expect(byGrade['Grade 8 / 8.5']).toBe(1300)   // new-price
    expect(byGrade['Grade 7 / 7.5']).toBe(890.97) // cib-price
  })
  it('captures the ungraded retail buy/sell spread on the loose row (mig 0075)', () => {
    const out = csvRowToPriceRows(row)
    const ungraded = out.find((r) => r.grade === null)!
    expect(ungraded.retailBuyDollars).toBe(1452)   // retail-loose-buy  $1,452.00
    expect(ungraded.retailSellDollars).toBe(2420)  // retail-loose-sell $2,420.00
    // Graded rows carry value only — no retail buy/sell.
    const psa10 = out.find((r) => r.grade === 'PSA 10')!
    expect(psa10.retailBuyDollars).toBeUndefined()
    expect(psa10.retailSellDollars).toBeUndefined()
  })
})

// ── header index + row mapping ──────────────────────────────────────────────────
describe('buildHeaderIndex / rowFromFields', () => {
  const header = ['id', 'console-name', 'product-name', 'loose-price', 'genre', 'tcg-id']
  const idx = buildHeaderIndex(header)
  it('maps lowercased headers to positions', () => {
    expect(idx['tcg-id']).toBe(5)
    expect(idx['loose-price']).toBe(3)
  })
  it('reads a data line by header name', () => {
    const row = rowFromFields(['9', 'Pokemon Base', 'Charizard #4', '$50.00', 'NES', '12345'], idx)
    expect(row['id']).toBe('9')
    expect(row['loose-price']).toBe('$50.00')
    expect(row['tcg-id']).toBe('12345')
  })
})

// ── decode map: column → grade label (shared with API path) ─────────────────────
describe('PC_PRICE_COLUMNS decode map', () => {
  it('maps each CSV column to the expected grade label', () => {
    const m = Object.fromEntries(PC_PRICE_COLUMNS.map((c) => [c.col, c.grade]))
    expect(m['loose-price']).toBeNull()           // ungraded / market
    expect(m['cib-price']).toBe('Grade 7 / 7.5')
    expect(m['new-price']).toBe('Grade 8 / 8.5')
    expect(m['graded-price']).toBe('Grade 9')
    expect(m['box-only-price']).toBe('Grade 9.5')
    expect(m['manual-only-price']).toBe('PSA 10')
    expect(m['bgs-10-price']).toBe('BGS 10')
    expect(m['condition-17-price']).toBe('CGC 10')
    expect(m['condition-18-price']).toBe('SGC 10')
  })
  it('graded columns exclude the ungraded loose row', () => {
    expect(PC_GRADED_COLUMNS.find((c) => c.col === 'loose-price')).toBeUndefined()
    expect(PC_GRADED_COLUMNS).toHaveLength(8)
  })
})

describe('csvRowToPriceRows', () => {
  const row = {
    'loose-price': '$10.00', 'cib-price': '$20.00', 'new-price': '',
    'manual-only-price': '$1,450.50', 'bgs-10-price': '$0.00', 'graded-price': '$88.00',
  }
  it('emits the ungraded + each positive graded bucket with the right label + dollars', () => {
    const rows = csvRowToPriceRows(row)
    const byGrade = Object.fromEntries(rows.map((r) => [r.grade ?? 'ungraded', r.valueDollars]))
    expect(byGrade['ungraded']).toBe(10)
    expect(byGrade['Grade 7 / 7.5']).toBe(20)
    expect(byGrade['PSA 10']).toBe(1450.5)
    expect(byGrade['Grade 9']).toBe(88)
    expect(byGrade['Grade 8 / 8.5']).toBeUndefined()  // blank
    expect(byGrade['BGS 10']).toBeUndefined()         // $0.00 skipped
  })
  it('sealed rows emit ONLY the ungraded/market row (no graded tiers)', () => {
    const rows = csvRowToPriceRows(row, { isSealed: true })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({ grade: null, valueDollars: 10 })
  })
})

describe('isSealedRow', () => {
  it('detects the Sealed Product genre', () => {
    expect(isSealedRow({ genre: 'Sealed Product' })).toBe(true)
    expect(isSealedRow({ genre: 'Pokemon Scarlet & Violet' })).toBe(false)
    expect(isSealedRow({})).toBe(false)
  })
})

// ── tcg-id join validation ──────────────────────────────────────────────────────
describe('validateTcgIdMatch', () => {
  it('accepts when canonical name tokens appear in the CSV product/console haystack', () => {
    expect(validateTcgIdMatch(
      { 'product-name': 'Charizard ex #125', 'console-name': 'Pokemon Obsidian Flames' },
      { name: 'Charizard ex' },
    )).toBe(true)
  })
  it('rejects when the canonical name is absent from the CSV row (wrong join)', () => {
    expect(validateTcgIdMatch(
      { 'product-name': 'Pikachu #25', 'console-name': 'Pokemon Base' },
      { name: 'Charizard ex' },
    )).toBe(false)
  })

  // Parenthetical-aware softening (2026-07-15) — the 33-row DON shape: PriceCharting omits
  // our parenthetical qualifiers, so a CORRECT tcg-id used to be rejected on one missing token.
  it('accepts the real Gol.D.Roger case (correct id; PC omits `roger`, majority of qualifiers hit)', () => {
    // pc 11018417 → canonical 118759 "DON!! Card (Gol.D.Roger) (Gold)": qualifiers
    // {gol, roger, gold} — gol + gold present (gol ⊂ gold), roger absent → 2/3 majority → accept.
    expect(validateTcgIdMatch(
      { 'product-name': 'DON!! Card [Gold Alternate Art]', 'console-name': 'One Piece Carrying on His Will' },
      { name: 'DON!! Card (Gol.D.Roger) (Gold)' },
    )).toBe(true)
  })
  it('still rejects a WRONG tcg-id (different card entirely — base name absent)', () => {
    expect(validateTcgIdMatch(
      { 'product-name': 'Pikachu #25', 'console-name': 'Pokemon Base' },
      { name: 'DON!! Card (Gol.D.Roger) (Gold)' },
    )).toBe(false)
  })
  it('still rejects a wrong DON VARIANT (base matches but qualifiers mostly absent)', () => {
    expect(validateTcgIdMatch(
      { 'product-name': 'DON!! Card [Gold Alternate Art]', 'console-name': 'One Piece Carrying on His Will' },
      { name: 'DON!! Card (Monkey.D.Luffy) (Vol. 7)' },   // qualifiers {monkey, luffy, vol}: 0/3
    )).toBe(false)
  })
  it('names WITHOUT parentheses keep the original all-tokens rule', () => {
    expect(validateTcgIdMatch(
      { 'product-name': 'Charizard #4', 'console-name': 'Pokemon Base' },
      { name: 'Dark Charizard' },   // `dark` missing → still a full-strictness reject
    )).toBe(false)
  })
})

// ── number-less set-corroborated matcher (2026-07-15, DON!! rung) ────────────────
describe('pickNumberlessCanonicalMatch', () => {
  // The highest-velocity unmatched DON on PriceCharting (pc 13256449, sales 4,920/yr).
  const dodgersRow = { 'product-name': 'DON!! Card [Dodgers]', 'console-name': 'One Piece Promo' }
  const dodgersCand = { id: 30, name: 'DON!! Card (Dodgers)', setName: 'One Piece Promotion Cards' }

  it('accepts on all-name-tokens + console↔set corroboration (Dodgers DON)', () => {
    expect(pickNumberlessCanonicalMatch(dodgersRow, [dodgersCand])).toBe(30)
  })
  it('accepts the REAL prod canonical row (pure-numeric tokens excluded, like the numeric matcher)', () => {
    // Verified in prod 2026-07-15: canonical 6650780 "DON!! Card (LA Dodgers 2026 Promo)"
    // (number NULL, rarity DON!!, set "One Piece Promotion Cards") IS present — pc 13256449
    // must match it. `la` (<3 chars) and `2026` (pure-numeric) are excluded from the token set.
    expect(pickNumberlessCanonicalMatch(dodgersRow, [
      { id: 6650780, name: 'DON!! Card (LA Dodgers 2026 Promo)', setName: 'One Piece Promotion Cards' },
    ])).toBe(6650780)
  })
  it('rejects when a canonical name token is missing from the haystack (variant discrimination)', () => {
    // A plain "DON!! Card" PC row must not capture the Dodgers variant (`dodgers` absent).
    expect(pickNumberlessCanonicalMatch(
      { 'product-name': 'DON!! Card', 'console-name': 'One Piece Promo' },
      [dodgersCand],
    )).toBeNull()
  })
  it('rejects on name alone — console↔set corroboration is mandatory', () => {
    expect(pickNumberlessCanonicalMatch(dodgersRow, [
      { id: 31, name: 'DON!! Card (Dodgers)', setName: 'Starter Deck 01' },   // wrong set
    ])).toBeNull()
  })
  it('returns null when TWO candidates both accept (ambiguity → unmatched, never a guess)', () => {
    expect(pickNumberlessCanonicalMatch(dodgersRow, [
      dodgersCand,
      { id: 99, name: 'DON!! Card (Dodgers)', setName: 'One Piece Promotion Cards' },
    ])).toBeNull()
  })
  it('returns null for empty candidate pools', () => {
    expect(pickNumberlessCanonicalMatch(dodgersRow, [])).toBeNull()
  })
})

// ── fuzzy fallback matcher ──────────────────────────────────────────────────────
describe('pickBestCanonicalMatch', () => {
  const csvRow = { 'product-name': 'Charizard ex #125', 'console-name': 'Pokemon Obsidian Flames' }
  it('accepts a name + number match', () => {
    const id = pickBestCanonicalMatch(csvRow, [
      { id: 7, name: 'Charizard ex', number: '125/197' },
    ])
    expect(id).toBe(7)
  })
  it('rejects a name-only (no number corroboration) match', () => {
    const id = pickBestCanonicalMatch(csvRow, [
      { id: 9, name: 'Charizard ex', number: '004/197' },  // different number
    ])
    expect(id).toBeNull()
  })
  it('rejects when the name does not match at all', () => {
    const id = pickBestCanonicalMatch(csvRow, [
      { id: 3, name: 'Pikachu', number: '125/197' },
    ])
    expect(id).toBeNull()
  })
  it('returns null for empty candidate lists', () => {
    expect(pickBestCanonicalMatch(csvRow, [])).toBeNull()
  })
})

// ── misc ────────────────────────────────────────────────────────────────────────
describe('categories + download URL', () => {
  it('exposes the four operator-confirmed categories', () => {
    expect(PRICECHARTING_CATEGORIES).toEqual([
      'pokemon-cards', 'magic-cards', 'yugioh-cards', 'one-piece-cards',
    ])
  })
  it('builds the download URL with the token + category', () => {
    const u = new URL(buildDownloadUrl('pokemon-cards', 'SECRET'))
    expect(u.pathname).toBe('/price-guide/download-custom')
    expect(u.searchParams.get('t')).toBe('SECRET')
    expect(u.searchParams.get('category')).toBe('pokemon-cards')
  })
})
