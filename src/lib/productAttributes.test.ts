import { describe, it, expect } from 'vitest'
import {
  ATTRIBUTE_COUNT_MAX,
  ATTRIBUTE_INSERT_ROWS_PER_STATEMENT,
  ATTRIBUTE_NAME_MAX,
  ATTRIBUTE_VALUE_MAX,
  EMPTY_ATTRIBUTES_HASH,
  attributeStatementsForProduct,
  attributesHash,
  extractProductAttributes,
  isProseAttributeKey,
  normalizeAttributeKey,
  sanitizeAttributeValue,
} from './productAttributes.js'

/**
 * The per-game fixtures below are VERBATIM `extendedData` shapes captured from the live TCGCSV
 * diagnostic on 2026-08-11 (Content/docs/audits/2026-08-11_tcgcsv-extended-data-diagnostic.md).
 * They are the regression guard for the findings that drove the schema: cross-game key spelling
 * drift, `;`-delimited multi-values, HTML confined to the prose fields, and the Pokemon `Stage`
 * field the mulligan rule depends on.
 */
const ed = (...pairs: [string, string][]) =>
  pairs.map(([name, value]) => ({ name, displayName: name, value }))

const FIXTURES = {
  // Note `Card Type` WITH a space, and `RetreatCost` WITHOUT one — Pokemon's own spelling.
  pokemon: ed(
    ['Rarity', 'Common'], ['Number', '58/102'], ['Card Type', 'Lightning'],
    ['HP', '60'], ['Stage', 'Basic'], ['Weakness', 'F'], ['RetreatCost', '1'],
    ['Attack 1', '[L] Gnaw (10)'],
    ['CardText', '<em>Put this card in play.</em>'],
  ),
  // Same publisher, different storefront: `CardType` without a space, `Retreat Cost` with one.
  pokemonJapan: ed(
    ['Rarity', 'Holo Rare'], ['CardType', 'Trainer - Item'], ['HP', '90'],
    ['Stage', 'Stage 1'], ['Retreat Cost', '2'],
  ),
  // Magic carries NO cost and NO colour — the whole type line lives in SubType.
  magic: ed(
    ['Rarity', 'R'], ['Number', '192'],
    ['SubType', 'Legendary Creature — Human Officer'],
    ['P', '2'], ['T', '2'],
    ['OracleText', 'Lifelink <em>(Damage dealt by this creature also gains you life.)</em>\r\n<br>Flying'],
    ['FlavorText', '<em>“We all joined Starfleet.”</em>'],
  ),
  // `;` with no space is the universal multi-value delimiter.
  digimon: ed(
    ['Rarity', 'Super Rare'], ['Number', 'BT14-041 R'], ['Color', 'Red;Yellow'],
    ['CardType', 'Digimon/Option'], ['PlayCost', '12'], ['LevelLv', '6'],
    ['Description', '<b>[On Play]</b> Draw 1 card.'],
    ['Inherited Effect', 'Gains +1000 DP.'],
  ),
  // DBS cost is "digit(colour letter)", not a number.
  dragonBall: ed(
    ['Rarity', 'Super Rare'], ['CardType', 'Battle'], ['Color', 'Yellow'],
    ['Cost', '2(Y)'], ['Character Traits', 'Earthling;Saiyan'], ['Power', '20000'],
  ),
  riftbound: ed(
    ['Rarity', 'Epic'], ['Card Type', 'Champion Unit'], ['Domain', 'Fury;Chaos'],
    ['Energy Cost', '4'], ['Power Cost', '1'], ['Tag', 'Ionia;Fae'], ['Might', '5'],
    ['Flavor Text', '<em>Nothing lasts.</em>'],
  ),
  lorcana: ed(
    ['Rarity', 'Legendary'], ['CardType', 'Character'], ['InkType', 'Amethyst'],
    ['Cost Ink', '5'], ['Classification', 'Storyborn;Hero;Princess'],
    ['InkwellIcononCard', 'Yes'], ['Lore Value', '2'],
  ),
  yugioh: ed(
    ['Number', 'LOB-012'], ['Rarity', 'Ultra Rare'], ['Attribute', 'DARK'],
    ['Card Type', 'Synchro/Effect Monster'], ['MonsterType', 'Dragon'],
    ['Attack', '3000'], ['Defense', '2500'],
    ['Description', 'Cannot be Normal Summoned.'],
  ),
  onePiece: ed(
    ['Rarity', 'SEC'], ['CardType', 'Character'], ['Color', 'Purple'],
    ['Subtypes', 'The Four Emperors;Whitebeard Pirates'], ['Attribute', 'Strike'],
    ['Cost', '10'], ['Power', '10000'], ['Counterplus', '1000'],
  ),
  gundam: ed(
    ['Rarity', 'Legend Rare'], ['CardType', 'Unit'], ['Color', 'Blue'],
    ['Level', '5'], ['Cost', '4'], ['Trait', '(Earth Federation) (White Base Team)'],
    ['Attack Points', '5'], ['Hit Points', '4'],
  ),
  fleshAndBlood: ed(
    ['Rarity', 'Majestic'], ['CardType', 'Action;Attack Reaction'], ['Class', 'Warrior;Thief'],
    ['CardSubType', 'Attack'], ['Cost', '1'], ['Pitch Value', '2'], ['Power', '4'],
  ),
}

describe('normalizeAttributeKey', () => {
  it('folds the cross-game spelling drift onto one form', () => {
    expect(normalizeAttributeKey('Card Type')).toBe('cardtype')
    expect(normalizeAttributeKey('CardType')).toBe('cardtype')
    expect(normalizeAttributeKey('Retreat Cost')).toBe('retreatcost')
    expect(normalizeAttributeKey('RetreatCost')).toBe('retreatcost')
    expect(normalizeAttributeKey('Digimon Power (DP)')).toBe('digimonpowerdp')
  })
})

describe('isProseAttributeKey', () => {
  it('matches both spellings of every prose field', () => {
    for (const k of ['Description', 'OracleText', 'CardText', 'Flavor Text', 'FlavorText',
                     'Inherited Effect', 'Security Effect', 'Disclaimer']) {
      expect(isProseAttributeKey(k)).toBe(true)
    }
  })
  it('matches Attack N for any N (the count varies by card)', () => {
    expect(isProseAttributeKey('Attack 1')).toBe(true)
    expect(isProseAttributeKey('Attack 2')).toBe(true)
    expect(isProseAttributeKey('Attack 4')).toBe(true)
  })
  it('does NOT match Yu-Gi-Oh! `Attack` — that is the numeric ATK stat', () => {
    expect(isProseAttributeKey('Attack')).toBe(false)
  })
  it('leaves every deck-relevant key alone', () => {
    for (const k of ['Card Type', 'CardType', 'Color', 'Cost', 'Cost Ink', 'Energy Cost',
                     'PlayCost', 'Stage', 'HP', 'Domain', 'InkType', 'Attribute', 'SubType']) {
      expect(isProseAttributeKey(k)).toBe(false)
    }
  })
})

describe('sanitizeAttributeValue', () => {
  it('strips tags to a space so words do not fuse', () => {
    expect(sanitizeAttributeValue('a<br>b')).toBe('a b')
    expect(sanitizeAttributeValue('<em>Flying</em>')).toBe('Flying')
  })
  it('decodes entities, including entity-encoded tags', () => {
    expect(sanitizeAttributeValue('Fire &amp; Ice')).toBe('Fire & Ice')
    expect(sanitizeAttributeValue('a&lt;br&gt;b')).toBe('a b')
    expect(sanitizeAttributeValue('&#39;X&#39;')).toBe("'X'")
    expect(sanitizeAttributeValue('a&nbsp;b')).toBe('a b')
  })
  it('collapses CR/LF and surrounding whitespace', () => {
    expect(sanitizeAttributeValue('Lifelink\r\n<br>Flying')).toBe('Lifelink Flying')
  })
  it('leaves everything else verbatim — delimiters, casing, "None", non-ASCII', () => {
    expect(sanitizeAttributeValue('Red;Yellow')).toBe('Red;Yellow')
    expect(sanitizeAttributeValue('None')).toBe('None')
    expect(sanitizeAttributeValue('Frieza’s Army')).toBe('Frieza’s Army')
    expect(sanitizeAttributeValue('Legendary Creature — Human Officer'))
      .toBe('Legendary Creature — Human Officer')
    expect(sanitizeAttributeValue('2(Y)')).toBe('2(Y)')
  })
  it('never throws on hostile input', () => {
    expect(sanitizeAttributeValue(null)).toBe('')
    expect(sanitizeAttributeValue(undefined)).toBe('')
    expect(sanitizeAttributeValue(42)).toBe('42')
    expect(sanitizeAttributeValue({ toString() { throw new Error('nope') } })).toBe('')
  })
})

describe('extractProductAttributes — per-game fixtures', () => {
  const names = (input: unknown) => extractProductAttributes(input).map(a => a.name)

  it('Pokemon: keeps Stage (the mulligan field) and drops the prose fields', () => {
    const out = extractProductAttributes(FIXTURES.pokemon)
    expect(names(FIXTURES.pokemon)).toEqual(
      ['Rarity', 'Number', 'Card Type', 'HP', 'Stage', 'Weakness', 'RetreatCost']
    )
    expect(out.find(a => a.name === 'Stage')?.value).toBe('Basic')
    expect(out.find(a => a.name === 'Card Type')?.value).toBe('Lightning')
  })

  it('Pokemon Japan: the same concepts under the other spelling, both kept raw', () => {
    expect(names(FIXTURES.pokemonJapan))
      .toEqual(['Rarity', 'CardType', 'HP', 'Stage', 'Retreat Cost'])
  })

  it('Magic: SubType survives as the full type line; OracleText/FlavorText do not', () => {
    const out = extractProductAttributes(FIXTURES.magic)
    expect(names(FIXTURES.magic)).toEqual(['Rarity', 'Number', 'SubType', 'P', 'T'])
    expect(out.find(a => a.name === 'SubType')?.value)
      .toBe('Legendary Creature — Human Officer')
    // The finding that constrains Session 2: there is no cost or colour key to keep.
    expect(names(FIXTURES.magic).some(n => /cost|color|colour/i.test(n))).toBe(false)
  })

  it('Digimon: `;` multi-values and `/` compounds are stored verbatim, unsplit', () => {
    const out = extractProductAttributes(FIXTURES.digimon)
    expect(out.find(a => a.name === 'Color')?.value).toBe('Red;Yellow')
    expect(out.find(a => a.name === 'CardType')?.value).toBe('Digimon/Option')
    expect(names(FIXTURES.digimon)).not.toContain('Description')
    expect(names(FIXTURES.digimon)).not.toContain('Inherited Effect')
  })

  it('Dragon Ball Super: the "2(Y)" cost is not coerced to a number', () => {
    expect(extractProductAttributes(FIXTURES.dragonBall).find(a => a.name === 'Cost')?.value)
      .toBe('2(Y)')
  })

  it('Riftbound: both cost axes are kept', () => {
    const n = names(FIXTURES.riftbound)
    expect(n).toContain('Energy Cost')
    expect(n).toContain('Power Cost')
    expect(n).not.toContain('Flavor Text')
  })

  it('Lorcana / Yu-Gi-Oh! / One Piece / Gundam / Flesh & Blood keep their deck fields', () => {
    expect(names(FIXTURES.lorcana)).toEqual(
      ['Rarity', 'CardType', 'InkType', 'Cost Ink', 'Classification', 'InkwellIcononCard', 'Lore Value']
    )
    expect(names(FIXTURES.yugioh)).toEqual(
      ['Number', 'Rarity', 'Attribute', 'Card Type', 'MonsterType', 'Attack', 'Defense']
    )
    expect(names(FIXTURES.onePiece)).toContain('Subtypes')
    expect(names(FIXTURES.gundam)).toContain('Trait')
    expect(names(FIXTURES.fleshAndBlood)).toContain('Pitch Value')
  })

  it('preserves the source position of every kept row', () => {
    const out = extractProductAttributes(FIXTURES.pokemon)
    // `Attack 1` sits at index 7 and is skipped — positions are source indices, not a dense range.
    expect(out.map(a => a.position)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(extractProductAttributes(FIXTURES.magic).map(a => a.position)).toEqual([0, 1, 2, 3, 4])
  })
})

describe('extractProductAttributes — malformed and missing input never throws', () => {
  it('returns [] for a missing or non-array block', () => {
    expect(extractProductAttributes(undefined)).toEqual([])
    expect(extractProductAttributes(null)).toEqual([])
    expect(extractProductAttributes('not an array')).toEqual([])
    expect(extractProductAttributes({ name: 'Rarity', value: 'R' })).toEqual([])
    expect(extractProductAttributes(42)).toEqual([])
  })

  it('returns [] for an EMPTY block — the normal shape for sealed product', () => {
    expect(extractProductAttributes([])).toEqual([])
  })

  it('skips broken entries but keeps the good ones in the same block', () => {
    const out = extractProductAttributes([
      null,
      'garbage',
      { value: 'no name' },
      { name: '   ', value: 'blank name' },
      { name: 'Rarity', value: 'R' },
      { name: 'Empty', value: '' },
      { name: 'NullValue', value: null },
      { name: 'Stage', value: 'Basic' },
    ])
    expect(out.map(a => a.name)).toEqual(['Rarity', 'Stage'])
  })

  it('skips an over-long value WHOLE rather than storing a truncated lie', () => {
    const out = extractProductAttributes([
      { name: 'Trait', value: 'x'.repeat(ATTRIBUTE_VALUE_MAX + 1) },
      { name: 'Rarity', value: 'R' },
    ])
    expect(out.map(a => a.name)).toEqual(['Rarity'])
  })

  it('skips an over-long key', () => {
    expect(extractProductAttributes([{ name: 'k'.repeat(ATTRIBUTE_NAME_MAX + 1), value: 'v' }]))
      .toEqual([])
  })

  it('keeps the FIRST occurrence of a duplicated key (the PK is product_id+name)', () => {
    const out = extractProductAttributes([
      { name: 'Color', value: 'Red' },
      { name: 'Color', value: 'Blue' },
    ])
    expect(out).toEqual([{ name: 'Color', value: 'Red', position: 0 }])
  })

  it('caps a runaway block', () => {
    const huge = Array.from({ length: ATTRIBUTE_COUNT_MAX + 20 }, (_, i) => ({
      name: `K${i}`, displayName: `K${i}`, value: 'v',
    }))
    expect(extractProductAttributes(huge)).toHaveLength(ATTRIBUTE_COUNT_MAX)
  })
})

describe('attributesHash — the change guard', () => {
  it('is stable for the same input and differs on any change', () => {
    const a = extractProductAttributes(FIXTURES.pokemon)
    expect(attributesHash(a)).toBe(attributesHash(extractProductAttributes(FIXTURES.pokemon)))

    const valueChanged = extractProductAttributes(
      FIXTURES.pokemon.map(f => (f.name === 'HP' ? { ...f, value: '70' } : f))
    )
    expect(attributesHash(valueChanged)).not.toBe(attributesHash(a))

    const keyRemoved = a.filter(x => x.name !== 'Stage')
    expect(attributesHash(keyRemoved)).not.toBe(attributesHash(a))

    const reordered = [a[1], a[0], ...a.slice(2)]
    expect(attributesHash(reordered)).not.toBe(attributesHash(a))
  })

  it('gives every game a distinct hash for its fixture', () => {
    const hashes = Object.values(FIXTURES).map(f => attributesHash(extractProductAttributes(f)))
    expect(new Set(hashes).size).toBe(hashes.length)
  })

  it('EMPTY_ATTRIBUTES_HASH is the hash of no attributes', () => {
    expect(attributesHash([])).toBe(EMPTY_ATTRIBUTES_HASH)
    expect(attributesHash(extractProductAttributes([]))).toBe(EMPTY_ATTRIBUTES_HASH)
    expect(attributesHash(extractProductAttributes(undefined))).toBe(EMPTY_ATTRIBUTES_HASH)
  })
})

// A prepare/bind recorder — the same shape ingestion/db.test.ts uses.
function fakeDb() {
  return {
    prepare(sql: string) {
      const stmt = { sql, args: [] as unknown[], bind(...a: unknown[]) { stmt.args = a; return stmt } }
      return stmt
    },
  } as any
}

describe('attributeStatementsForProduct', () => {
  it('emits delete -> insert -> stamp, in that order (crash-safety contract)', () => {
    const attrs = extractProductAttributes(FIXTURES.pokemon)
    const stmts = attributeStatementsForProduct(fakeDb(), 4242, attrs, 'deadbeef:1') as any[]

    expect(stmts).toHaveLength(3)
    expect(stmts[0].sql).toBe('DELETE FROM product_attributes WHERE product_id = ?')
    expect(stmts[0].args).toEqual([4242])
    expect(stmts[1].sql).toContain('INSERT INTO product_attributes')
    // 4 binds per row, all under the same product id.
    expect(stmts[1].args).toHaveLength(attrs.length * 4)
    expect(stmts[1].args.slice(0, 4)).toEqual([4242, 'Rarity', 'Common', 0])
    // The hash stamp is LAST — never hoisted ahead of the rows it vouches for.
    expect(stmts[2].sql).toBe('UPDATE products SET extended_data_hash = ? WHERE id = ?')
    expect(stmts[2].args).toEqual(['deadbeef:1', 4242])
  })

  it('chunks the multi-row INSERT so no statement exceeds D1\'s 100 bound-param cap', () => {
    const attrs = Array.from({ length: 45 }, (_, i) => ({ name: `K${i}`, value: 'v', position: i }))
    const stmts = attributeStatementsForProduct(fakeDb(), 7, attrs, 'h:1') as any[]
    const inserts = stmts.filter(s => s.sql.startsWith('INSERT'))
    expect(inserts).toHaveLength(Math.ceil(45 / ATTRIBUTE_INSERT_ROWS_PER_STATEMENT))
    for (const s of inserts) expect(s.args.length).toBeLessThanOrEqual(100)
  })

  it('a product with no attributes still deletes and stamps (so it stops being reprocessed)', () => {
    const stmts = attributeStatementsForProduct(fakeDb(), 9, [], EMPTY_ATTRIBUTES_HASH) as any[]
    expect(stmts.map(s => s.sql.split(' ')[0])).toEqual(['DELETE', 'UPDATE'])
  })
})
