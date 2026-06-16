/**
 * PriceCharting CSV bulk-ingest — the production graded+ungraded price backbone for the
 * four games we ingest (Pokémon, Magic, Yu-Gi-Oh, One Piece).
 *
 * Once daily (cron, one category per run — see worker.ts) we pull the operator-confirmed
 * per-category price-guide CSV, MATCH each row to a canonical product (tcg-id first, then
 * a validated fuzzy fallback), PERSIST the mapping (`pricecharting_products`, so re-ingests
 * are incremental and unmatched rows are counted not dropped), and UPSERT canonical `prices`
 * rows (source='pricecharting', value in dollars, idempotent). The Content app then serves
 * those persisted graded prices to ALL users for these 4 games — no admin gate, no per-call
 * API cost (that is the whole point of the CSV path; the on-demand API stays the fallback
 * for OTHER games).
 *
 * SECURITY: the PriceCharting token is the worker secret PRICECHARTING_TOKEN ONLY — it is
 * injected into the download URL here and never logged, returned, or persisted.
 *
 * SCALE / RESUMABILITY: each export is ~88k rows. We STREAM the CSV (never buffer the whole
 * file), process a bounded window of rows per run (KV cursor `pc_ingest_cursor:{category}`,
 * advanced each run and wrapped at EOF), batch the D1 upserts (≤90 statements/batch), and
 * skip the matching for rows already matched in a prior run (prices still re-upsert — that's
 * the daily refresh). Guarded like the other ingest jobs; logs matched/fuzzy/unmatched/sealed
 * counts per run.
 */

import type { Env } from './worker.js'
import { logger } from './ingestion/logger.js'
import {
  buildDownloadUrl,
  parseCsvLine,
  detectDelimiter,
  buildHeaderIndex,
  rowFromFields,
  isSealedRow,
  csvRowToPriceRows,
  validateTcgIdMatch,
  pickBestCanonicalMatch,
  cleanNumber,
  PRICECHARTING_CATEGORIES,
  type PcCsvRow,
  type PriceChartingCategory,
} from './lib/pricechartingCsv.js'

/** TCGPlayer category id(s) per PriceCharting category — scopes the fuzzy candidate query.
 * (tcg-id matching needs no scope: tcgplayer_product_id is globally unique.) */
const CATEGORY_TCGPLAYER_IDS: Record<string, number[]> = {
  'pokemon-cards':   [3],
  'magic-cards':     [1],
  'yugioh-cards':    [2],
  'one-piece-cards': [68],
}

const CURSOR_PREFIX = 'pc_ingest_cursor:'
const DEFAULT_MAX_ROWS  = 25000  // rows processed per run (window) — tune via PC_INGEST_MAX_ROWS
const DEFAULT_FUZZY_MAX = 400    // fuzzy lookups per run (bounded; tcg-id carries the bulk)
const DB_CHUNK = 90              // statements per DB.batch() (well under D1's 100-param/stmt cap)

export interface PcIngestCounts {
  category:        string
  rowsScanned:     number   // data rows seen this run (whole file streamed)
  rowsInWindow:    number   // rows actually processed this run
  matchedTcgId:    number
  matchedFuzzy:    number
  alreadyMatched:  number   // resolved from a prior run's persisted mapping
  unmatched:       number
  sealedRows:      number
  sealedMatched:   number
  pricesUpserted:  number
  fuzzyAttempts:   number
  windowStart:     number
  windowEnd:       number
  wrapped:         boolean   // window reached EOF → cursor reset to 0
  totalRows:       number
}

interface MatchResolution {
  pcId:      string
  productId: number | null
  method:    'tcg-id' | 'fuzzy' | null
  row:       PcCsvRow
  sealed:    boolean
}

/** Chunk an array into sub-arrays of at most `size`. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/**
 * Stream a CSV ReadableStream line-by-line, invoking `onRow(fields, dataRowIndex)` for each
 * DATA row (header consumed internally). Never buffers more than one line. Returns once EOF.
 */
async function streamCsv(
  body: ReadableStream<Uint8Array>,
  onHeader: (headerFields: string[]) => void,
  onRow: (fields: string[], dataRowIndex: number) => void,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let sawHeader = false
  let dataIdx = 0
  let delimiter = ','                   // detected from the header line (tab vs comma)
  let pending: string[] | null = null   // a partial quoted field spanning lines

  const handleLine = (line: string) => {
    // A field may contain an embedded newline inside quotes; if the parsed line has an
    // odd number of unescaped quotes, join with the next physical line. PriceCharting
    // exports rarely do this, but guard anyway.
    const combined = pending ? pending.join('\n') + '\n' + line : line
    const quoteCount = (combined.match(/"/g) ?? []).length
    if (quoteCount % 2 !== 0) { pending = pending ? [...pending, line] : [line]; return }
    pending = null
    if (!sawHeader) {
      delimiter = detectDelimiter(combined)
      sawHeader = true
      onHeader(parseCsvLine(combined, delimiter))
      return
    }
    onRow(parseCsvLine(combined, delimiter), dataIdx++)
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '')
      buf = buf.slice(nl + 1)
      handleLine(line)
    }
  }
  const tail = buf.replace(/\r$/, '')
  if (tail.length > 0 || pending) handleLine(tail)
}

/**
 * Resolve canonical product ids for a window of rows. tcg-id primary (batched + validated),
 * validated fuzzy fallback for the rest (bounded by `fuzzyMax`). Mutates nothing; returns one
 * MatchResolution per row.
 */
async function resolveMatches(
  env: Env,
  category: string,
  rows: Array<{ pcId: string; row: PcCsvRow; sealed: boolean }>,
  alreadyMatched: Map<string, number>,
  fuzzyMax: number,
): Promise<{ resolutions: MatchResolution[]; matchedTcgId: number; matchedFuzzy: number; fuzzyAttempts: number }> {
  const resolutions: MatchResolution[] = []
  let matchedTcgId = 0
  let matchedFuzzy = 0
  let fuzzyAttempts = 0

  // Rows that still need matching (not resolved from a prior run).
  const needMatch = rows.filter((r) => !alreadyMatched.has(r.pcId))

  // ── tcg-id primary (batched) ────────────────────────────────────────────────
  const byTcgId = new Map<number, { pcId: string; row: { pcId: string; row: PcCsvRow; sealed: boolean } }[]>()
  for (const r of needMatch) {
    const t = Number((r.row['tcg-id'] ?? '').trim())
    if (Number.isInteger(t) && t > 0) {
      if (!byTcgId.has(t)) byTcgId.set(t, [])
      byTcgId.get(t)!.push({ pcId: r.pcId, row: r })
    }
  }
  const tcgIdToProduct = new Map<number, { id: number; name: string | null }>()
  for (const ids of chunk([...byTcgId.keys()], DB_CHUNK)) {
    const placeholders = ids.map(() => '?').join(',')
    const { results } = await env.DB.prepare(
      `SELECT id, tcgplayer_product_id, name FROM products WHERE tcgplayer_product_id IN (${placeholders})`,
    ).bind(...ids).all<{ id: number; tcgplayer_product_id: number; name: string | null }>()
    for (const p of results ?? []) tcgIdToProduct.set(p.tcgplayer_product_id, { id: p.id, name: p.name })
  }

  const resolvedPcIds = new Set<string>()
  for (const [tcgId, entries] of byTcgId) {
    const prod = tcgIdToProduct.get(tcgId)
    for (const e of entries) {
      if (prod && validateTcgIdMatch(e.row.row, { name: prod.name })) {
        resolutions.push({ pcId: e.pcId, productId: prod.id, method: 'tcg-id', row: e.row.row, sealed: e.row.sealed })
        resolvedPcIds.add(e.pcId)
        matchedTcgId++
      }
    }
  }

  // ── validated fuzzy fallback (bounded) ──────────────────────────────────────
  const cats = CATEGORY_TCGPLAYER_IDS[category] ?? []
  for (const r of needMatch) {
    if (resolvedPcIds.has(r.pcId)) continue
    if (fuzzyAttempts >= fuzzyMax || cats.length === 0) break
    // Extract a number-like token from the CSV product-name for candidate scoping.
    const numToken = ((r.row['product-name'] ?? '').match(/[a-z]*\d[\w-]*/i)?.[0]) ?? ''
    const num = cleanNumber(numToken)
    if (!num) { continue }   // no number to corroborate → leave unmatched (counted)
    fuzzyAttempts++
    const ph = cats.map(() => '?').join(',')
    const { results } = await env.DB.prepare(
      `SELECT p.id, p.name, p.number
       FROM products p
       JOIN sets s ON s.id = p.set_id
       JOIN canonical_games g ON g.id = s.game_id
       WHERE g.tcgplayer_category_id IN (${ph})
         AND (LOWER(p.number) = ? OR LOWER(p.number) LIKE ?)
       LIMIT 25`,
    ).bind(...cats, num, `${num}/%`).all<{ id: number; name: string | null; number: string | null }>()
    const productId = pickBestCanonicalMatch(r.row, results ?? [])
    if (productId != null) {
      resolutions.push({ pcId: r.pcId, productId, method: 'fuzzy', row: r.row, sealed: r.sealed })
      resolvedPcIds.add(r.pcId)
      matchedFuzzy++
    }
  }

  // ── everything else: unmatched (recorded with productId=null) ───────────────
  for (const r of needMatch) {
    if (resolvedPcIds.has(r.pcId)) continue
    resolutions.push({ pcId: r.pcId, productId: null, method: null, row: r.row, sealed: r.sealed })
  }
  // Rows resolved from a prior run carry their persisted product id forward (prices refresh).
  for (const r of rows) {
    if (alreadyMatched.has(r.pcId)) {
      resolutions.push({ pcId: r.pcId, productId: alreadyMatched.get(r.pcId)!, method: null, row: r.row, sealed: r.sealed })
    }
  }

  return { resolutions, matchedTcgId, matchedFuzzy, fuzzyAttempts }
}

const PRICE_UPSERT_SQL = `
  INSERT INTO prices (product_id, source, condition, finish, grade, value, fetched_at)
  VALUES (?, 'pricecharting', ?, ?, ?, ?, unixepoch())
  ON CONFLICT (product_id, source, COALESCE(condition,''), COALESCE(finish,''), COALESCE(grade,''))
  DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at`

const MAP_UPSERT_SQL = `
  INSERT INTO pricecharting_products
    (pc_id, game_category, canonical_product_id, match_method, tcg_id,
     console_name, product_name, is_sealed, sales_volume, matched_at, last_seen_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
  ON CONFLICT (pc_id) DO UPDATE SET
    game_category        = excluded.game_category,
    canonical_product_id = COALESCE(excluded.canonical_product_id, pricecharting_products.canonical_product_id),
    match_method         = COALESCE(excluded.match_method, pricecharting_products.match_method),
    tcg_id               = excluded.tcg_id,
    console_name         = excluded.console_name,
    product_name         = excluded.product_name,
    is_sealed            = excluded.is_sealed,
    sales_volume         = excluded.sales_volume,
    matched_at           = COALESCE(pricecharting_products.matched_at, excluded.matched_at),
    last_seen_at         = unixepoch()`

/**
 * Ingest ONE PriceCharting category. Streams the CSV, processes a bounded window of rows
 * (resumable via the KV cursor), matches + persists + upserts prices, returns counts.
 *
 * @throws Error on a missing token (caller maps to 503) or a non-200 CSV download.
 */
export async function ingestPriceChartingCategory(
  env: Env,
  category: PriceChartingCategory,
  opts: { force?: boolean } = {},
): Promise<PcIngestCounts> {
  if (!env.PRICECHARTING_TOKEN) throw new Error('PRICECHARTING_TOKEN not configured')
  if (!PRICECHARTING_CATEGORIES.includes(category)) throw new Error(`Unknown category: ${category}`)

  const maxRows = env.PC_INGEST_MAX_ROWS ? parseInt(env.PC_INGEST_MAX_ROWS, 10) : DEFAULT_MAX_ROWS
  const fuzzyMax = env.PC_INGEST_FUZZY_MAX ? parseInt(env.PC_INGEST_FUZZY_MAX, 10) : DEFAULT_FUZZY_MAX
  const kv = env.SLEEVEDPAGES_KV

  // Resume cursor (row offset). `force` restarts from 0 and re-matches everything.
  const cursorKey = `${CURSOR_PREFIX}${category}`
  let windowStart = 0
  if (!opts.force && kv) {
    const raw = await kv.get(cursorKey)
    const n = raw ? parseInt(raw, 10) : 0
    if (Number.isFinite(n) && n > 0) windowStart = n
  }
  const windowEnd = windowStart + maxRows

  // ── Stream the CSV; collect only the rows inside [windowStart, windowEnd) ────
  const res = await fetch(buildDownloadUrl(category, env.PRICECHARTING_TOKEN), {
    headers: { Accept: 'text/csv' },
  })
  if (!res.ok || !res.body) {
    throw new Error(`PriceCharting CSV download failed (${category}): HTTP ${res.status}`)
  }

  let headerIdx: Record<string, number> = {}
  const window: Array<{ pcId: string; row: PcCsvRow; sealed: boolean }> = []
  let rowsScanned = 0

  await streamCsv(
    res.body,
    (h) => { headerIdx = buildHeaderIndex(h) },
    (fields, i) => {
      rowsScanned = i + 1
      if (i < windowStart || i >= windowEnd) return
      const row = rowFromFields(fields, headerIdx)
      const pcId = (row['id'] ?? '').trim()
      if (!pcId) return
      window.push({ pcId, row, sealed: isSealedRow(row) })
    },
  )

  const totalRows = rowsScanned
  const sealedRows = window.filter((w) => w.sealed).length

  // ── Incremental skip: which window pc_ids are already matched? ──────────────
  const alreadyMatched = new Map<string, number>()
  if (!opts.force && window.length > 0) {
    for (const ids of chunk(window.map((w) => w.pcId), DB_CHUNK)) {
      const ph = ids.map(() => '?').join(',')
      const { results } = await env.DB.prepare(
        `SELECT pc_id, canonical_product_id FROM pricecharting_products
         WHERE pc_id IN (${ph}) AND canonical_product_id IS NOT NULL`,
      ).bind(...ids).all<{ pc_id: string; canonical_product_id: number }>()
      for (const r of results ?? []) alreadyMatched.set(r.pc_id, r.canonical_product_id)
    }
  }

  const { resolutions, matchedTcgId, matchedFuzzy, fuzzyAttempts } =
    await resolveMatches(env, category, window, alreadyMatched, fuzzyMax)

  // ── Build map + price upserts ───────────────────────────────────────────────
  const now = Math.floor(Date.now() / 1000)
  const mapStmts: D1PreparedStatement[] = []
  const priceStmts: D1PreparedStatement[] = []
  let unmatched = 0
  let sealedMatched = 0

  for (const r of resolutions) {
    const sales = Number((r.row['sales-volume'] ?? '').trim())
    const salesVolume = Number.isFinite(sales) && sales > 0 ? Math.round(sales) : null
    mapStmts.push(
      env.DB.prepare(MAP_UPSERT_SQL).bind(
        r.pcId,
        category,
        r.productId,
        r.method,
        (r.row['tcg-id'] ?? '').trim() || null,
        (r.row['console-name'] ?? '').trim() || null,
        (r.row['product-name'] ?? '').trim() || null,
        r.sealed ? 1 : 0,
        salesVolume,
        r.productId != null ? now : null,
      ),
    )

    if (r.productId == null) { unmatched++; continue }
    if (r.sealed) sealedMatched++

    for (const pr of csvRowToPriceRows(r.row, { isSealed: r.sealed })) {
      // ungraded → (condition NULL, finish 'normal', grade NULL); graded → (NULL, NULL, label)
      const finish = pr.grade == null ? 'normal' : null
      priceStmts.push(
        env.DB.prepare(PRICE_UPSERT_SQL).bind(r.productId, null, finish, pr.grade, pr.valueDollars),
      )
    }
  }

  // Batch the writes (≤90 statements/batch).
  for (const batch of chunk(mapStmts, DB_CHUNK)) await env.DB.batch(batch)
  for (const batch of chunk(priceStmts, DB_CHUNK)) await env.DB.batch(batch)

  // ── Advance / wrap the cursor ───────────────────────────────────────────────
  const wrapped = windowEnd >= totalRows
  if (kv) await kv.put(cursorKey, String(wrapped ? 0 : windowEnd))

  const counts: PcIngestCounts = {
    category,
    rowsScanned,
    rowsInWindow: window.length,
    matchedTcgId,
    matchedFuzzy,
    alreadyMatched: alreadyMatched.size,
    unmatched,
    sealedRows,
    sealedMatched,
    pricesUpserted: priceStmts.length,
    fuzzyAttempts,
    windowStart,
    windowEnd: Math.min(windowEnd, totalRows),
    wrapped,
    totalRows,
  }
  logger.info('pricecharting_csv_ingest', counts as unknown as Record<string, unknown>)
  return counts
}
