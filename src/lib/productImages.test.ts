import { describe, it, expect } from 'vitest'
import {
  resolveSourceUrl,
  isScrydexImageUrl,
  isTcgplayerCdnUrl,
  SOURCE_URL_PRECEDENCE_CASE,
  sourceUrlUpsertByProductId,
  sourceUrlUpsertByGroupNumber,
  mirrorAttemptUpsert,
  r2ImageUpsert,
} from './productImages.js'

// Fake D1 that records prepared SQL + binds (same shape as ingestion/db.test.ts).
function makeFakeDB() {
  const prepared: { sql: string; args: unknown[] }[] = []
  return {
    prepared,
    prepare(sql: string) {
      const stmt = { sql, args: [] as unknown[], bind(...a: unknown[]) { stmt.args = a; prepared.push(stmt); return stmt } }
      return stmt
    },
  } as any
}

const SCRYDEX_URL   = 'https://images.scrydex.com/pokemon/sv1-25/large'
const SCRYDEX_URL_2 = 'https://images.scrydex.com/onepiece/OP09-004-alt/large'
const TCG_URL       = 'https://tcgplayer-cdn.tcgplayer.com/product/610228_in_1000x1000.jpg'
const TCG_URL_2     = 'https://tcgplayer-cdn.tcgplayer.com/product/999_in_1000x1000.jpg'
const OTHER_URL     = 'https://example.com/some-image.jpg'

describe('URL host classifiers', () => {
  it('recognises Scrydex CDN urls (case-insensitive)', () => {
    expect(isScrydexImageUrl(SCRYDEX_URL)).toBe(true)
    expect(isScrydexImageUrl(SCRYDEX_URL.toUpperCase())).toBe(true)
    expect(isScrydexImageUrl(TCG_URL)).toBe(false)
    expect(isScrydexImageUrl(null)).toBe(false)
    expect(isScrydexImageUrl(undefined)).toBe(false)
    expect(isScrydexImageUrl('')).toBe(false)
  })
  it('recognises TCGPlayer CDN urls', () => {
    expect(isTcgplayerCdnUrl(TCG_URL)).toBe(true)
    expect(isTcgplayerCdnUrl(SCRYDEX_URL)).toBe(false)
    expect(isTcgplayerCdnUrl(null)).toBe(false)
    // the plain marketplace host is NOT the CDN host
    expect(isTcgplayerCdnUrl('https://www.tcgplayer.com/product/610228')).toBe(false)
  })
})

describe('resolveSourceUrl — the WP-1 precedence rule (scrydex > tcgplayer)', () => {
  it('an incoming Scrydex url always wins', () => {
    expect(resolveSourceUrl(null, SCRYDEX_URL)).toBe(SCRYDEX_URL)
    expect(resolveSourceUrl(TCG_URL, SCRYDEX_URL)).toBe(SCRYDEX_URL)
    expect(resolveSourceUrl(OTHER_URL, SCRYDEX_URL)).toBe(SCRYDEX_URL)
    // scrydex → scrydex refresh is allowed (weekly sync can update variant art)
    expect(resolveSourceUrl(SCRYDEX_URL, SCRYDEX_URL_2)).toBe(SCRYDEX_URL_2)
  })

  it('fills an empty slot with anything', () => {
    expect(resolveSourceUrl(null, TCG_URL)).toBe(TCG_URL)
    expect(resolveSourceUrl(undefined, TCG_URL)).toBe(TCG_URL)
    expect(resolveSourceUrl('', TCG_URL)).toBe(TCG_URL)
    expect(resolveSourceUrl(null, OTHER_URL)).toBe(OTHER_URL)
  })

  it('lets a TCGPlayer url be replaced by a fresher TCGPlayer url (the daily sync refresh)', () => {
    expect(resolveSourceUrl(TCG_URL, TCG_URL_2)).toBe(TCG_URL_2)
  })

  it('NEVER lets the TCGCSV path clobber a Scrydex url (the IMG-2 regression)', () => {
    expect(resolveSourceUrl(SCRYDEX_URL, TCG_URL)).toBe(SCRYDEX_URL)
    expect(resolveSourceUrl(SCRYDEX_URL, OTHER_URL)).toBe(SCRYDEX_URL)
  })

  it('preserves an unknown-host url against a non-Scrydex incoming url', () => {
    expect(resolveSourceUrl(OTHER_URL, TCG_URL)).toBe(OTHER_URL)
    expect(resolveSourceUrl(OTHER_URL, 'https://example.org/other.png')).toBe(OTHER_URL)
  })
})

describe('resolveSourceUrl — per-game preference (mig 0104, operator decision 2026-07-17)', () => {
  it("'scrydex'-preferred (Bandai): a stored Scrydex url is PRESERVED against TCGCSV", () => {
    expect(resolveSourceUrl(SCRYDEX_URL, TCG_URL, 'scrydex')).toBe(SCRYDEX_URL)
  })

  it("'tcgplayer'-preferred: the incoming url plainly overwrites — even a stored Scrydex url", () => {
    expect(resolveSourceUrl(SCRYDEX_URL, TCG_URL, 'tcgplayer')).toBe(TCG_URL)
    expect(resolveSourceUrl(OTHER_URL, TCG_URL, 'tcgplayer')).toBe(TCG_URL)
    expect(resolveSourceUrl(TCG_URL, TCG_URL_2, 'tcgplayer')).toBe(TCG_URL_2)
  })

  it('a NULL/empty slot is filled under BOTH preferences (a watermarked image beats no image)', () => {
    expect(resolveSourceUrl(null, TCG_URL, 'scrydex')).toBe(TCG_URL)
    expect(resolveSourceUrl(null, TCG_URL, 'tcgplayer')).toBe(TCG_URL)
    expect(resolveSourceUrl('', TCG_URL, 'scrydex')).toBe(TCG_URL)
    expect(resolveSourceUrl('', TCG_URL, 'tcgplayer')).toBe(TCG_URL)
  })

  it("the default preference is 'scrydex' (the protective CASE) for all Scrydex-side writers", () => {
    expect(resolveSourceUrl(SCRYDEX_URL, TCG_URL)).toBe(SCRYDEX_URL)
  })
})

describe('SQL statements carry the right conflict expression per preference', () => {
  it("both source_url writers default to SOURCE_URL_PRECEDENCE_CASE (the 'scrydex' rule)", () => {
    const db = makeFakeDB()
    sourceUrlUpsertByProductId(db, 1, TCG_URL, null)
    sourceUrlUpsertByGroupNumber(db, 100, '58/102', SCRYDEX_URL, 'scrydex')
    for (const stmt of db.prepared) {
      expect(stmt.sql).toContain(SOURCE_URL_PRECEDENCE_CASE)
      // no unconditional overwrite under the protective rule
      expect(stmt.sql).not.toMatch(/source_url\s*=\s*excluded\.source_url\s*,/)
    }
  })

  it("an explicit 'scrydex' preference keeps the protective CASE (the Bandai TCGCSV path)", () => {
    const db = makeFakeDB()
    sourceUrlUpsertByProductId(db, 1, TCG_URL, null, 'scrydex')
    expect(db.prepared[0].sql).toContain(SOURCE_URL_PRECEDENCE_CASE)
  })

  it("a 'tcgplayer' preference produces the plain overwrite (TCGCSV wins by policy)", () => {
    const db = makeFakeDB()
    sourceUrlUpsertByProductId(db, 1, TCG_URL, null, 'tcgplayer')
    const { sql, args } = db.prepared[0]
    expect(sql).not.toContain(SOURCE_URL_PRECEDENCE_CASE)
    expect(sql).toMatch(/source_url\s*=\s*excluded\.source_url\s*,/)
    // still never touches r2_url, and source stays COALESCE-preserved (0063 guarantee)
    expect(sql).not.toContain('r2_url')
    expect(sql).toContain('source     = COALESCE(excluded.source, product_images.source)')
    expect(args).toEqual([null, TCG_URL, 1])
  })

  it('the CASE branches mirror resolveSourceUrl exactly (order + hosts)', () => {
    // Branch 1: incoming scrydex wins; 2: NULL/empty filled; 3: stored tcgplayer replaceable; else preserve.
    const idxScrydex   = SOURCE_URL_PRECEDENCE_CASE.indexOf("excluded.source_url LIKE '%images.scrydex.com/%'")
    const idxEmpty     = SOURCE_URL_PRECEDENCE_CASE.indexOf('product_images.source_url IS NULL')
    const idxTcgplayer = SOURCE_URL_PRECEDENCE_CASE.indexOf("product_images.source_url LIKE '%tcgplayer-cdn.tcgplayer.com/%'")
    const idxElse      = SOURCE_URL_PRECEDENCE_CASE.indexOf('ELSE product_images.source_url')
    expect(idxScrydex).toBeGreaterThanOrEqual(0)
    expect(idxEmpty).toBeGreaterThan(idxScrydex)
    expect(idxTcgplayer).toBeGreaterThan(idxEmpty)
    expect(idxElse).toBeGreaterThan(idxTcgplayer)
  })

  it('bind order is unchanged: (source, sourceUrl, tcgProductId) / (source, sourceUrl, groupId, number)', () => {
    const db = makeFakeDB()
    sourceUrlUpsertByProductId(db, 42, TCG_URL, null)
    expect(db.prepared[0].args).toEqual([null, TCG_URL, 42])
    sourceUrlUpsertByGroupNumber(db, 100, '58/102', SCRYDEX_URL, 'scrydex')
    expect(db.prepared[1].args).toEqual(['scrydex', SCRYDEX_URL, 100, '58/102'])
  })

  it('R2 writers do not touch source_url (merge semantics preserved)', () => {
    const db = makeFakeDB()
    r2ImageUpsert(db, 1, 'https://images.sleevedpages.com/cards/1.png', 'scrydex', '2026-07-07T00:00:00Z')
    expect(db.prepared[0].sql).not.toContain('source_url')
  })
})

describe('mirrorAttemptUpsert — WP-2 bookkeeping', () => {
  it('inserts attempt 1 for a new row and increments on conflict', () => {
    const db = makeFakeDB()
    mirrorAttemptUpsert(db, 777, '2026-07-07T03:00:00Z')
    const { sql, args } = db.prepared[0]
    expect(sql).toContain('INSERT INTO product_images (product_id, mirror_attempts, mirror_last_attempt_at)')
    expect(sql).toContain('SELECT id, 1, ? FROM products WHERE tcgplayer_product_id = ?')
    expect(sql).toContain('mirror_attempts        = product_images.mirror_attempts + 1')
    expect(sql).toContain('mirror_last_attempt_at = excluded.mirror_last_attempt_at')
    // never touches the url columns — a failed attempt must not disturb r2_url/source_url
    expect(sql).not.toContain('r2_url')
    expect(sql).not.toContain('source_url')
    expect(args).toEqual(['2026-07-07T03:00:00Z', 777])
  })
})
