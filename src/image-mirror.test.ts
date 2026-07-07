import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  mirrorCandidateWhere,
  isMirrorRetryDue,
  MAX_MIRROR_ATTEMPTS,
  MIRROR_BACKOFF_BASE_DAYS,
  MIN_IMAGE_BYTES,
  PLACEHOLDER_PROBE_URL,
  sha256Hex,
  fetchImage,
  fetchPlaceholderHash,
  getPendingCards,
  runMirrorJob,
} from './image-mirror.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

// ─── helpers ─────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000

function okImageResponse(bytes: Uint8Array, contentType = 'image/png') {
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => bytes.buffer.slice(0),
  } as any
}

function notFoundResponse() {
  return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) } as any
}

function bigBytes(fill: number, len = 4096): Uint8Array {
  return new Uint8Array(len).fill(fill)
}

// Fake D1: .all() feeds successive candidate batches; .run()/.batch() are recorded.
function makeMirrorDB(batches: unknown[][]) {
  let selectCount = 0
  const db: any = {
    allCalls: [] as { sql: string; args: unknown[] }[],
    runCalls: [] as { sql: string; args: unknown[] }[],
    batchCalls: [] as { sql: string; args: unknown[] }[][],
    prepare(sql: string) {
      const stmt: any = {
        sql,
        args: [] as unknown[],
        bind(...a: unknown[]) { stmt.args = a; return stmt },
        async all() {
          db.allCalls.push({ sql, args: stmt.args })
          const r = batches[selectCount] ?? []
          selectCount++
          return { results: r }
        },
        async run() { db.runCalls.push({ sql, args: stmt.args }); return { meta: {} } },
      }
      return stmt
    },
    async batch(stmts: any[]) {
      db.batchCalls.push(stmts.map((s) => ({ sql: s.sql, args: s.args })))
      return stmts.map(() => ({}))
    },
  }
  return db
}

function makeBucket() {
  const puts: { key: string }[] = []
  return { puts, put: async (key: string) => { puts.push({ key }) } } as any
}

const pokemonCard = (over: Record<string, unknown> = {}) => ({
  product_row_id: 10,
  tcgplayer_product_id: 42,
  image_url: 'https://tcgplayer-cdn.tcgplayer.com/product/42_in_1000x1000.jpg',
  image_source: null,
  card_number: '25/165',
  set_name: 'Scarlet & Violet',
  scrydex_set_id: 'sv1',
  category_name: 'Pokemon',
  ...over,
})

// ─── candidate-selection query (WP-2: exclusion / backoff / keyset) ──────────

describe('mirrorCandidateWhere — the shared candidate predicate', () => {
  const where = mirrorCandidateWhere()

  it('keeps the original eligibility clause (never-mirrored OR tcgplayer-upgrade)', () => {
    expect(where).toContain('pi.r2_url IS NULL AND (pi.product_id IS NULL OR pi.source IS NULL)')
    expect(where).toContain("pi.source = 'tcgplayer' AND s.scrydex_expansion_id IS NOT NULL")
  })

  it('requires a mirrorable source: Scrydex source_url OR English-Pokémon construction', () => {
    expect(where).toContain("pi.source_url LIKE '%images.scrydex.com/%'")
    expect(where).toContain("LOWER(REPLACE(g.name, 'é', 'e')) LIKE '%pokemon%'")
  })

  it('excludes Pokemon Japan from URL construction (IMG-6)', () => {
    expect(where).toContain("LOWER(g.name) NOT LIKE '%japan%'")
  })

  it('never selects tcgplayer-cdn-only rows (no tcgplayer host anywhere in the predicate)', () => {
    expect(where).not.toContain('tcgplayer-cdn')
  })

  it('applies the attempt ceiling and the exponential (bit-shift) backoff', () => {
    expect(where).toContain(`COALESCE(pi.mirror_attempts, 0) < ${MAX_MIRROR_ATTEMPTS}`)
    expect(where).toContain('pi.mirror_last_attempt_at IS NULL')
    expect(where).toContain(
      `julianday('now') - julianday(pi.mirror_last_attempt_at)`
    )
    expect(where).toContain(`${MIRROR_BACKOFF_BASE_DAYS} * (1 << COALESCE(pi.mirror_attempts, 0))`)
  })
})

describe('isMirrorRetryDue — JS mirror of the SQL backoff', () => {
  const now = Date.parse('2026-07-07T00:00:00Z')
  const daysAgo = (d: number) => new Date(now - d * DAY_MS).toISOString()

  it('a never-attempted row is always due', () => {
    expect(isMirrorRetryDue(0, null, now)).toBe(true)
  })
  it('a row at/over the ceiling is never due', () => {
    expect(isMirrorRetryDue(MAX_MIRROR_ATTEMPTS, null, now)).toBe(false)
    expect(isMirrorRetryDue(MAX_MIRROR_ATTEMPTS + 3, daysAgo(999), now)).toBe(false)
  })
  it('backs off 3·2^attempts days: attempt 1 → 6d, 2 → 12d, 3 → 24d', () => {
    expect(isMirrorRetryDue(1, daysAgo(5), now)).toBe(false)
    expect(isMirrorRetryDue(1, daysAgo(6), now)).toBe(true)
    expect(isMirrorRetryDue(2, daysAgo(11), now)).toBe(false)
    expect(isMirrorRetryDue(2, daysAgo(12), now)).toBe(true)
    expect(isMirrorRetryDue(3, daysAgo(23), now)).toBe(false)
    expect(isMirrorRetryDue(3, daysAgo(24), now)).toBe(true)
  })
  it('an unparseable timestamp is treated as due (never wedges a row)', () => {
    expect(isMirrorRetryDue(1, 'garbage', now)).toBe(true)
  })
})

describe('keyset pagination — never OFFSET', () => {
  it('runMirrorJob selects with p.id > ? ORDER BY p.id and no OFFSET', async () => {
    const db = makeMirrorDB([[]])
    vi.stubGlobal('fetch', vi.fn(async () => notFoundResponse()))
    await runMirrorJob({ DB: db, IMAGES_BUCKET: makeBucket() }, 1)
    const candidateSql = db.allCalls[0].sql
    expect(candidateSql).toContain('p.id > ?')
    expect(candidateSql).toContain('ORDER BY p.id')
    expect(candidateSql).not.toMatch(/OFFSET/i)
    expect(db.allCalls[0].args).toEqual([0])
  })

  it('getPendingCards shares the candidate predicate and takes no OFFSET', async () => {
    const db = makeMirrorDB([[]])
    await getPendingCards(db, 25)
    const sql = db.allCalls[0].sql
    expect(sql).toContain("pi.source_url LIKE '%images.scrydex.com/%'")
    expect(sql).toContain(`COALESCE(pi.mirror_attempts, 0) < ${MAX_MIRROR_ATTEMPTS}`)
    expect(sql).not.toMatch(/OFFSET/i)
  })

  it('advances the keyset cursor to the last row id of each batch', async () => {
    // Two full batches would need BATCH_SIZE rows; instead: one under-full batch ends the loop,
    // so drive two selects by returning a full first batch of 100.
    const first = Array.from({ length: 100 }, (_, i) => pokemonCard({ product_row_id: i + 1, tcgplayer_product_id: 1000 + i }))
    const db = makeMirrorDB([first, []])
    vi.stubGlobal('fetch', vi.fn(async () => notFoundResponse()))
    await runMirrorJob({ DB: db, IMAGES_BUCKET: makeBucket() }, Infinity)
    expect(db.allCalls.length).toBe(2)
    expect(db.allCalls[0].args).toEqual([0])
    expect(db.allCalls[1].args).toEqual([100]) // last product_row_id of batch 1
  })
})

// ─── placeholder fingerprint (WP-2 / IMG-10) ─────────────────────────────────

describe('sha256Hex', () => {
  it('matches known SHA-256 vectors', async () => {
    expect(await sha256Hex(new ArrayBuffer(0)))
      .toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(await sha256Hex(new TextEncoder().encode('abc').buffer as ArrayBuffer))
      .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('fetchImage — fingerprint check replaces the <300 KB guard', () => {
  it('accepts a small (but real) image the old 300 KB guard would have rejected', async () => {
    const realSmall = bigBytes(7, 150_000) // 150 KB "low-complexity card scan"
    vi.stubGlobal('fetch', vi.fn(async () => okImageResponse(realSmall)))
    const placeholderHash = await sha256Hex(bigBytes(1, 181_000).buffer as ArrayBuffer)
    const res = await fetchImage('https://images.scrydex.com/pokemon/sv1-25/large', placeholderHash)
    expect(res).not.toBeNull()
    expect(res!.buffer.byteLength).toBe(150_000)
  })

  it('rejects bytes that hash to the placeholder fingerprint, whatever their size', async () => {
    const placeholderBytes = bigBytes(1, 181_000)
    vi.stubGlobal('fetch', vi.fn(async () => okImageResponse(placeholderBytes)))
    const placeholderHash = await sha256Hex(placeholderBytes.buffer.slice(0) as ArrayBuffer)
    const res = await fetchImage('https://images.scrydex.com/pokemon/sv1-9999/large', placeholderHash)
    expect(res).toBeNull()
  })

  it('passes everything through when no fingerprint was calibrated (probe failed)', async () => {
    const placeholderBytes = bigBytes(1, 181_000)
    vi.stubGlobal('fetch', vi.fn(async () => okImageResponse(placeholderBytes)))
    const res = await fetchImage('https://images.scrydex.com/pokemon/sv1-9999/large', null)
    expect(res).not.toBeNull()
  })

  it('still rejects sub-floor bodies (error pages, empty responses)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okImageResponse(bigBytes(0, MIN_IMAGE_BYTES - 1))))
    expect(await fetchImage('https://images.scrydex.com/pokemon/sv1-25/large', null)).toBeNull()
  })
})

describe('fetchPlaceholderHash', () => {
  it('hashes the probe response and hits the impossible-card URL', async () => {
    const placeholderBytes = bigBytes(1, 2048)
    const fetchMock = vi.fn(async () => okImageResponse(placeholderBytes))
    vi.stubGlobal('fetch', fetchMock)
    const hash = await fetchPlaceholderHash()
    expect(fetchMock).toHaveBeenCalledWith(PLACEHOLDER_PROBE_URL, expect.anything())
    expect(hash).toBe(await sha256Hex(placeholderBytes.buffer.slice(0) as ArrayBuffer))
  })
  it('returns null (detection disabled) when the probe 404s or throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => notFoundResponse()))
    expect(await fetchPlaceholderHash()).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    expect(await fetchPlaceholderHash()).toBeNull()
  })
})

// ─── per-run summary row: written even on early death (try/finally) ──────────

describe('runMirrorJob — image_mirror_log summary row', () => {
  it('writes the summary row with skipped + first_error columns on a clean empty run', async () => {
    const db = makeMirrorDB([[]])
    vi.stubGlobal('fetch', vi.fn(async () => notFoundResponse())) // probe 404 → hash null
    const result = await runMirrorJob({ DB: db, IMAGES_BUCKET: makeBucket() }, 1)
    const log = db.runCalls.find((c: any) => c.sql.includes('INSERT INTO image_mirror_log'))
    expect(log).toBeTruthy()
    expect(log.sql).toContain('skipped')
    expect(log.sql).toContain('first_error')
    // binds: processed, mirrored, failed, skipped, scrydex_hits, tcgplayer_hits, duration, first_error
    expect(log.args.slice(0, 6)).toEqual([0, 0, 0, 0, 0, 0])
    expect(log.args[7]).toBeNull()
    expect(result.first_error).toBeNull()
  })

  it('STILL writes the summary row when the candidate SELECT throws (the 2026-07-05 death mode)', async () => {
    const db = makeMirrorDB([[]])
    const origPrepare = db.prepare.bind(db)
    db.prepare = (sql: string) => {
      if (sql.includes('FROM  products')) {
        return { bind: () => ({ all: async () => { throw new Error('D1 exploded') } }) }
      }
      return origPrepare(sql)
    }
    vi.stubGlobal('fetch', vi.fn(async () => notFoundResponse()))
    const result = await runMirrorJob({ DB: db, IMAGES_BUCKET: makeBucket() }, 1)
    const log = db.runCalls.find((c: any) => c.sql.includes('INSERT INTO image_mirror_log'))
    expect(log).toBeTruthy()
    expect(String(log.args[7])).toContain('D1 exploded')
    expect(result.first_error).toContain('D1 exploded')
  })

  it('counts a failed card, records its error, and books the attempt', async () => {
    const db = makeMirrorDB([[pokemonCard()], []])
    // probe 404; scrydex constructed URL 404; card's source_url is tcgplayer-cdn → never fetched
    vi.stubGlobal('fetch', vi.fn(async () => notFoundResponse()))
    const result = await runMirrorJob({ DB: db, IMAGES_BUCKET: makeBucket() }, Infinity)

    expect(result.processed).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.mirrored).toBe(0)
    expect(result.first_error).toContain('scrydex fetch failed')

    // attempt bookkeeping was batched for the processed card
    const bookkeeping = db.batchCalls.flat().filter((s: any) => s.sql.includes('mirror_attempts'))
    expect(bookkeeping).toHaveLength(1)
    expect(bookkeeping[0].args[1]).toBe(42) // tcgplayer_product_id

    const log = db.runCalls.find((c: any) => c.sql.includes('INSERT INTO image_mirror_log'))
    expect(log.args.slice(0, 6)).toEqual([1, 0, 1, 0, 0, 0])
    expect(String(log.args[7])).toContain('scrydex fetch failed')
  })

  it('mirrors a Pokémon card from the constructed Scrydex URL and books the attempt too', async () => {
    const db = makeMirrorDB([[pokemonCard()], []])
    const art = bigBytes(9, 400_000)
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url === PLACEHOLDER_PROBE_URL ? notFoundResponse() : okImageResponse(art)))
    const bucket = makeBucket()
    const result = await runMirrorJob({ DB: db, IMAGES_BUCKET: bucket }, Infinity)

    expect(result.mirrored).toBe(1)
    expect(result.scrydex_hits).toBe(1)
    expect(bucket.puts).toEqual([{ key: 'cards/42.png' }])
    // r2 write + attempt bookkeeping both happened
    expect(db.runCalls.some((c: any) => c.sql.includes('r2_url'))).toBe(true)
    expect(db.batchCalls.flat().some((s: any) => s.sql.includes('mirror_attempts'))).toBe(true)
    const log = db.runCalls.find((c: any) => c.sql.includes('INSERT INTO image_mirror_log'))
    expect(log.args.slice(0, 6)).toEqual([1, 1, 0, 0, 1, 0])
  })

  it('never fetches a tcgplayer-cdn source_url from the worker (skipped, not attempted)', async () => {
    // Non-Pokémon card whose only URL is tcgplayer-cdn: predicate would normally
    // exclude it; if one slips through it must be SKIPPED without a fetch.
    const card = pokemonCard({ category_name: 'YuGiOh', scrydex_set_id: null, set_name: 'Some Set' })
    const db = makeMirrorDB([[card], []])
    const fetchMock = vi.fn(async (url: string) =>
      url === PLACEHOLDER_PROBE_URL ? notFoundResponse() : okImageResponse(bigBytes(2, 400_000)))
    vi.stubGlobal('fetch', fetchMock)
    const result = await runMirrorJob({ DB: db, IMAGES_BUCKET: makeBucket() }, Infinity)
    expect(result.skipped).toBe(1)
    expect(result.failed).toBe(0)
    // only the placeholder probe was fetched — never the tcgplayer-cdn url
    const fetchedUrls = fetchMock.mock.calls.map((c) => c[0])
    expect(fetchedUrls).toEqual([PLACEHOLDER_PROBE_URL])
  })
})
