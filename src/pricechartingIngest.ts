/**
 * PriceCharting CSV bulk-ingest — FETCH / PROCESS split (rebuilt 2026-06-19).
 *
 * The source CSV download is HARD rate-limited to 1 per 10 MINUTES (abuse → the account's API
 * access is REVOKED) and each export is ~88k rows. The PREVIOUS design re-downloaded the WHOLE
 * CSV on every windowed call (the KV cursor was only a row offset into a *fresh re-download*), so
 * a big category NEVER finished on the daily cron and rapid-looping to finish tripped the limit.
 * This module splits the two concerns so completing a big category costs ONE download + N cheap
 * R2 reads — never N downloads:
 *
 *   FETCH   — once per day per category. Download the full CSV ONCE and store the RAW bytes in R2
 *             under a dated key `ingest-raw/pricecharting/{category}/{YYYY-MM-DD}.csv`. Arms the
 *             10-min download cooldown the moment a download is attempted; never retry-loops.
 *             (`fetchPriceChartingCsvToR2`)
 *   PROCESS — unlimited, from R2. Read the cached object and ingest the ENTIRE category across many
 *             Worker invocations driven by a DEDICATED queue (`PC_PROCESS_QUEUE`). The cursor is a
 *             row offset OVER THE R2 FILE carried IN the queue message — there is NO KV cursor, so
 *             the old eventual-consistency bounce is gone. Each window is bounded by a wall-time
 *             budget AND a D1-batch cap (to stay under the per-invocation sub-request limit), then
 *             enqueues the next offset until EOF. (`processPriceChartingWindow`)
 *
 * The matching (in-memory tcg-id-first + validated fuzzy `loadProductIndex`/`matchRows`), the
 * canonical `prices` upsert (incl. the mig-0075 `retail_buy`/`retail_sell` spread on the ungraded
 * row), and the `pricecharting_products` map are UNCHANGED from the prior design — only the
 * fetch/iterate mechanics changed. Re-processing the same R2 file is idempotent (upserts on the
 * same conflict keys), so a re-process / stale-fallback never double-writes.
 *
 * SECURITY: the PriceCharting token is the worker secret PRICECHARTING_TOKEN ONLY — it is injected
 * into the download URL here and never logged, returned, or persisted.
 */

import type { Env } from './worker.js'
import { logger } from './ingestion/logger.js'
import { startPriceChartingCooldown } from './adminJobs.js'
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

/** R2 key scheme for the cached raw downloads. Reuses the worker's existing IMAGES_BUCKET binding. */
export const R2_RAW_PREFIX = 'ingest-raw/pricecharting'

const DEFAULT_MAX_ROWS    = 25000  // rows COLLECTED into the in-memory window per invocation — tune via PC_INGEST_MAX_ROWS
const DEFAULT_FUZZY_MAX    = 400   // fuzzy lookups per window (bounded; tcg-id carries the bulk)
const DEFAULT_BUDGET_MS    = 20000 // wall-time budget per window (< the ~60s request cap) — tune via PC_INGEST_BUDGET_MS
const DEFAULT_MAX_BATCHES  = 300   // D1 DB.batch() calls per window — keeps each invocation well under the 1000 sub-request cap (PC_PROCESS_MAX_BATCHES)
const SUBBATCH  = 500              // rows matched + written per inner pass; budgets checked between passes
const DB_CHUNK  = 90               // statements per DB.batch() (well under D1's 100-param/stmt cap)

/** The continuation message the dedicated PriceCharting PROCESS queue carries. The row offset IS
 * the cursor (over the R2 file), so there is no KV cursor / eventual-consistency bounce. */
export interface PcProcessMessage {
  kind:     'pricecharting-process'
  category: PriceChartingCategory
  key:      string   // R2 object key of the cached CSV being processed
  offset:   number   // data-row offset to resume from
  stale?:   boolean  // true when processing an older R2 file because today's fetch was absent
}

/** Result of a single PROCESS window (one Worker invocation / one queue message). */
export interface PcWindowCounts {
  category:       string
  key:            string
  stale:          boolean
  windowStart:    number
  rowsCollected:  number    // data rows read into the window this invocation
  rowsProcessed:  number    // rows actually matched + written before a budget cut
  matchedTcgId:   number
  matchedFuzzy:   number
  unmatched:      number
  sealedRows:     number
  sealedMatched:  number
  pricesUpserted: number
  fuzzyAttempts:  number
  cursorNext:     number    // next offset to process (== windowStart+rowsProcessed; 0 once wrapped)
  wrapped:        boolean   // reached EOF and finished → the chain stops
  budgetHit:      boolean   // stopped early on the wall-time budget
  batchHit:       boolean   // stopped early on the per-window D1-batch cap
  durationMs:     number
}

/** Result of a FETCH (one download → R2). */
export interface PcFetchResult { category: string; key: string; date: string; bytes: number | null }

interface MatchResolution {
  pcId:      string
  productId: number | null
  method:    'tcg-id' | 'fuzzy' | null
  row:       PcCsvRow
  sealed:    boolean
}

interface WindowOpts { maxRows: number; fuzzyMax: number; budgetMs: number; maxBatches: number }

/** Chunk an array into sub-arrays of at most `size`. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** Today's UTC date as `YYYY-MM-DD` (the dated R2 key suffix). */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

/** The dated R2 key for a category's raw CSV. */
export function rawKeyFor(category: string, date: string): string {
  return `${R2_RAW_PREFIX}/${category}/${date}.csv`
}

function windowOptsFromEnv(env: Env): WindowOpts {
  return {
    maxRows:    env.PC_INGEST_MAX_ROWS    ? parseInt(env.PC_INGEST_MAX_ROWS, 10)    : DEFAULT_MAX_ROWS,
    fuzzyMax:   env.PC_INGEST_FUZZY_MAX   ? parseInt(env.PC_INGEST_FUZZY_MAX, 10)   : DEFAULT_FUZZY_MAX,
    budgetMs:   env.PC_INGEST_BUDGET_MS   ? parseInt(env.PC_INGEST_BUDGET_MS, 10)   : DEFAULT_BUDGET_MS,
    maxBatches: env.PC_PROCESS_MAX_BATCHES ? parseInt(env.PC_PROCESS_MAX_BATCHES, 10) : DEFAULT_MAX_BATCHES,
  }
}

/**
 * Stream a CSV ReadableStream line-by-line, invoking `onRow(fields, dataRowIndex)` for each
 * DATA row (header consumed internally). Never buffers more than one line. Returns once EOF.
 */
async function streamCsv(
  body: ReadableStream<Uint8Array>,
  onHeader: (headerFields: string[]) => void,
  onRow: (fields: string[], dataRowIndex: number) => boolean,   // return false to stop reading
): Promise<{ reachedEof: boolean }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let sawHeader = false
  let dataIdx = 0
  let delimiter = ','                   // detected from the header line (tab vs comma)
  let pending: string[] | null = null   // a partial quoted field spanning lines
  let stop = false

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
    if (onRow(parseCsvLine(combined, delimiter), dataIdx++) === false) stop = true
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      const tail = buf.replace(/\r$/, '')
      if (tail.length > 0 || pending) handleLine(tail)
      return { reachedEof: true }
    }
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '')
      buf = buf.slice(nl + 1)
      handleLine(line)
      if (stop) { await reader.cancel().catch(() => {}); return { reachedEof: false } }
    }
  }
}

interface Prod { id: number; tcgId: number | null; name: string | null; number: string | null }
export interface ProductIndex {
  byTcgId:  Map<number, Prod>
  byNumber: Map<string, Prod[]>   // keyed on cleanNumber(p.number)
  count:    number
}

/**
 * Load the game's canonical products into an in-memory index ONCE per window, so every row
 * matches against memory (pure CPU) instead of a per-row D1 query. This is the fix for the
 * fuzzy-fallback storm: the early (oldest) PriceCharting rows have no tcg-id and previously
 * fired one JOIN per row (~135ms each → 54s for 500 rows). Paginated reads keep it to a
 * handful of round trips regardless of catalogue size.
 */
async function loadProductIndex(env: Env, category: string): Promise<ProductIndex> {
  const cats = CATEGORY_TCGPLAYER_IDS[category] ?? []
  const byTcgId = new Map<number, Prod>()
  const byNumber = new Map<string, Prod[]>()
  let count = 0
  if (cats.length === 0) return { byTcgId, byNumber, count }

  const ph = cats.map(() => '?').join(',')
  const PAGE = 5000
  for (let offset = 0; ; offset += PAGE) {
    const { results } = await env.DB.prepare(
      `SELECT p.id, p.tcgplayer_product_id AS tcgId, p.name, p.number
       FROM products p
       JOIN sets s ON s.id = p.set_id
       JOIN canonical_games g ON g.id = s.game_id
       WHERE g.tcgplayer_category_id IN (${ph})
       ORDER BY p.id LIMIT ${PAGE} OFFSET ${offset}`,
    ).bind(...cats).all<Prod>()
    const rows = results ?? []
    for (const p of rows) {
      count++
      if (p.tcgId != null) byTcgId.set(Number(p.tcgId), p)
      const num = cleanNumber(p.number)
      if (num) {
        const arr = byNumber.get(num)
        if (arr) arr.push(p); else byNumber.set(num, [p])
      }
    }
    if (rows.length < PAGE) break
  }
  return { byTcgId, byNumber, count }
}

/**
 * Match a sub-batch of rows against the in-memory index. PURE (no IO). tcg-id primary
 * (validated), bounded validated fuzzy fallback for the rest. Returns one MatchResolution
 * per row plus counts.
 */
function matchRows(
  rows: Array<{ pcId: string; row: PcCsvRow; sealed: boolean }>,
  index: ProductIndex,
  fuzzyMax: number,
): { resolutions: MatchResolution[]; matchedTcgId: number; matchedFuzzy: number; fuzzyAttempts: number } {
  const resolutions: MatchResolution[] = []
  let matchedTcgId = 0, matchedFuzzy = 0, fuzzyAttempts = 0

  for (const r of rows) {
    // ── tcg-id primary (in-memory map lookup + name validation) ────────────────
    const t = Number((r.row['tcg-id'] ?? '').trim())
    if (Number.isInteger(t) && t > 0) {
      const prod = index.byTcgId.get(t)
      if (prod && validateTcgIdMatch(r.row, { name: prod.name })) {
        resolutions.push({ pcId: r.pcId, productId: prod.id, method: 'tcg-id', row: r.row, sealed: r.sealed })
        matchedTcgId++
        continue
      }
    }
    // ── validated fuzzy fallback (in-memory number index; bounded) ─────────────
    if (fuzzyAttempts < fuzzyMax) {
      const numToken = ((r.row['product-name'] ?? '').match(/[a-z]*\d[\w-]*/i)?.[0]) ?? ''
      const num = cleanNumber(numToken)
      if (num) {
        fuzzyAttempts++
        const candidates = index.byNumber.get(num) ?? []
        const productId = candidates.length
          ? pickBestCanonicalMatch(r.row, candidates.map((c) => ({ id: c.id, name: c.name, number: c.number })))
          : null
        if (productId != null) {
          resolutions.push({ pcId: r.pcId, productId, method: 'fuzzy', row: r.row, sealed: r.sealed })
          matchedFuzzy++
          continue
        }
      }
    }
    // ── unmatched (recorded with productId=null — the catalogue-gap signal) ─────
    resolutions.push({ pcId: r.pcId, productId: null, method: null, row: r.row, sealed: r.sealed })
  }
  return { resolutions, matchedTcgId, matchedFuzzy, fuzzyAttempts }
}

const PRICE_UPSERT_SQL = `
  INSERT INTO prices (product_id, source, condition, finish, grade, value, retail_buy, retail_sell, fetched_at)
  VALUES (?, 'pricecharting', ?, ?, ?, ?, ?, ?, unixepoch())
  ON CONFLICT (product_id, source, COALESCE(condition,''), COALESCE(finish,''), COALESCE(grade,''),
               COALESCE(variant,''), COALESCE(company,''), is_signed, is_error, is_perfect)
  DO UPDATE SET value = excluded.value, retail_buy = excluded.retail_buy,
                retail_sell = excluded.retail_sell, fetched_at = excluded.fetched_at`

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

// ── FETCH (download → R2, once/day/category) ────────────────────────────────────

/**
 * Download the FULL category CSV ONCE and store the raw bytes in R2 under a dated key. This is the
 * ONLY function that hits the rate-limited download. It arms the 10-min cooldown the moment a
 * download is attempted (so a failed/429 response still blocks the next attempt for the full
 * window — never retry-loop), streams the response straight into R2 (no whole-file buffering), and
 * returns the key for the PROCESS step. Throws on a missing token / non-200 (caller logs; MUST NOT
 * retry-loop into the rate limit).
 */
export async function fetchPriceChartingCsvToR2(env: Env, category: PriceChartingCategory): Promise<PcFetchResult> {
  if (!env.PRICECHARTING_TOKEN) throw new Error('PRICECHARTING_TOKEN not configured')
  if (!PRICECHARTING_CATEGORIES.includes(category)) throw new Error(`Unknown category: ${category}`)
  if (!env.IMAGES_BUCKET) throw new Error('IMAGES_BUCKET (R2) not configured')

  const date = todayUtc()
  const key = rawKeyFor(category, date)

  const res = await fetch(buildDownloadUrl(category, env.PRICECHARTING_TOKEN), { headers: { Accept: 'text/csv' } })
  // Arm the cooldown BEFORE inspecting the result so even a 429/5xx blocks the next download for
  // the full ~10-min window — the rate-limit safety must not depend on a successful response.
  await startPriceChartingCooldown(env)
  if (!res.ok || !res.body) {
    throw new Error(`PriceCharting CSV download failed (${category}): HTTP ${res.status}`)
  }

  const bytes = Number(res.headers.get('content-length')) || null
  await env.IMAGES_BUCKET.put(key, res.body, {
    httpMetadata: { contentType: 'text/csv' },
    customMetadata: { source: 'pricecharting', category, date },
  })
  logger.info('pricecharting_csv_fetch', { category, key, date, bytes })
  return { category, key, date, bytes }
}

/** Lexicographically-greatest (i.e. most recent dated) raw key for a category, or null. */
export async function latestRawKey(env: Env, category: string): Promise<string | null> {
  if (!env.IMAGES_BUCKET) return null
  const prefix = `${R2_RAW_PREFIX}/${category}/`
  let best: string | null = null
  let cursor: string | undefined
  do {
    const listing = await env.IMAGES_BUCKET.list({ prefix, cursor })
    for (const o of listing.objects) {
      if (o.key.endsWith('.csv') && (best === null || o.key > best)) best = o.key
    }
    cursor = listing.truncated ? listing.cursor : undefined
  } while (cursor)
  return best
}

/**
 * Resolve which cached R2 file to PROCESS: today's if present, else the most recent (stale
 * fallback — the data is backup-behind-Scrydex, so a 1-day-stale file is acceptable; we log it
 * clearly and NEVER re-download to compensate). Returns null only when nothing has ever been
 * fetched for this category.
 */
export async function resolveProcessKey(env: Env, category: string): Promise<{ key: string; stale: boolean } | null> {
  const today = rawKeyFor(category, todayUtc())
  const head = env.IMAGES_BUCKET ? await env.IMAGES_BUCKET.head(today) : null
  if (head) return { key: today, stale: false }
  const latest = await latestRawKey(env, category)
  if (latest) return { key: latest, stale: true }
  return null
}

// ── PROCESS (from R2, unlimited, across invocations) ────────────────────────────

/**
 * Core windowed ingest from an already-open CSV stream (the R2 object body). PURE of any source
 * download — the caller supplies the cached bytes. Collects rows [windowStart, windowStart+maxRows),
 * matches in memory, upserts canonical prices + the map, and stops on the wall-time budget OR the
 * D1-batch cap so a single invocation stays under the request-duration + sub-request limits.
 */
async function processWindowFromBody(
  env: Env,
  category: string,
  key: string,
  stale: boolean,
  body: ReadableStream<Uint8Array>,
  windowStart: number,
  opts: WindowOpts,
): Promise<PcWindowCounts> {
  const t0 = Date.now()
  const windowEnd = windowStart + opts.maxRows

  // ── Stream the cached CSV; collect only the rows inside [windowStart, windowEnd) ──
  let headerIdx: Record<string, number> = {}
  const window: Array<{ pcId: string; row: PcCsvRow; sealed: boolean }> = []
  const { reachedEof } = await streamCsv(
    body,
    (h) => { headerIdx = buildHeaderIndex(h) },
    (fields, i) => {
      if (i < windowStart) return true
      if (i >= windowEnd) return false            // window full → stop reading the tail
      const row = rowFromFields(fields, headerIdx)
      const pcId = (row['id'] ?? '').trim()
      if (pcId) window.push({ pcId, row, sealed: isSealedRow(row) })
      return true
    },
  )

  // Load the game's canonical products into memory ONCE per window, so matching is pure CPU.
  const index = await loadProductIndex(env, category)

  const now = Math.floor(Date.now() / 1000)
  let processed = 0
  let matchedTcgId = 0, matchedFuzzy = 0, fuzzyAttempts = 0
  let unmatched = 0, sealedMatched = 0, sealedRows = 0, pricesUpserted = 0
  let budgetHit = false, batchHit = false, batchesIssued = 0

  for (let off = 0; off < window.length; off += SUBBATCH) {
    const sub = window.slice(off, off + SUBBATCH)

    const remainingFuzzy = Math.max(0, opts.fuzzyMax - fuzzyAttempts)
    const r = matchRows(sub, index, remainingFuzzy)
    matchedTcgId += r.matchedTcgId; matchedFuzzy += r.matchedFuzzy; fuzzyAttempts += r.fuzzyAttempts

    const mapStmts: D1PreparedStatement[] = []
    const priceStmts: D1PreparedStatement[] = []
    for (const res2 of r.resolutions) {
      if (res2.sealed) sealedRows++
      const sales = Number((res2.row['sales-volume'] ?? '').trim())
      const salesVolume = Number.isFinite(sales) && sales > 0 ? Math.round(sales) : null
      mapStmts.push(
        env.DB.prepare(MAP_UPSERT_SQL).bind(
          res2.pcId, category, res2.productId, res2.method,
          (res2.row['tcg-id'] ?? '').trim() || null,
          (res2.row['console-name'] ?? '').trim() || null,
          (res2.row['product-name'] ?? '').trim() || null,
          res2.sealed ? 1 : 0, salesVolume,
          res2.productId != null ? now : null,
        ),
      )
      if (res2.productId == null) { unmatched++; continue }
      if (res2.sealed) sealedMatched++
      for (const pr of csvRowToPriceRows(res2.row, { isSealed: res2.sealed })) {
        // ungraded → (condition NULL, finish 'normal', grade NULL) + retail buy/sell spread;
        // graded → (NULL, NULL, label) value-only (retail buy/sell null).
        const finish = pr.grade == null ? 'normal' : null
        priceStmts.push(env.DB.prepare(PRICE_UPSERT_SQL).bind(
          res2.productId, null, finish, pr.grade, pr.valueDollars,
          pr.retailBuyDollars ?? null, pr.retailSellDollars ?? null,
        ))
      }
    }
    for (const b of chunk(mapStmts, DB_CHUNK))   { await env.DB.batch(b); batchesIssued++ }
    for (const b of chunk(priceStmts, DB_CHUNK)) { await env.DB.batch(b); batchesIssued++ }
    pricesUpserted += priceStmts.length

    processed += sub.length
    // Stop on EITHER budget so a single invocation never exceeds the request-duration or
    // sub-request cap; the cursor only advances over fully-written sub-batches (idempotent).
    if (Date.now() - t0 > opts.budgetMs) { budgetHit = true; break }
    if (batchesIssued >= opts.maxBatches)  { batchHit = true; break }
  }

  // Wrapped only when we read the file's tail (reachedEof, i.e. the window wasn't capped at
  // maxRows) AND processed every collected row within the budget. window non-empty ⟹ at least one
  // sub-batch ran ⟹ processed > 0 ⟹ cursorNext strictly advances (no infinite chain).
  const wrapped = reachedEof && processed >= window.length
  const cursorNext = wrapped ? 0 : windowStart + processed

  const counts: PcWindowCounts = {
    category, key, stale, windowStart,
    rowsCollected: window.length,
    rowsProcessed: processed,
    matchedTcgId, matchedFuzzy, unmatched, sealedRows, sealedMatched, pricesUpserted, fuzzyAttempts,
    cursorNext, wrapped, budgetHit, batchHit,
    durationMs: Date.now() - t0,
  }
  logger.info('pricecharting_csv_process', counts as unknown as Record<string, unknown>)
  return counts
}

/**
 * Process ONE window for a queue message: open the cached R2 object and ingest from `msg.offset`.
 * NO download. A missing R2 object is terminal (returns wrapped) so the chain stops instead of
 * looping on an absent file.
 */
export async function processPriceChartingWindow(env: Env, msg: PcProcessMessage): Promise<PcWindowCounts> {
  const obj = env.IMAGES_BUCKET ? await env.IMAGES_BUCKET.get(msg.key) : null
  if (!obj || !obj.body) {
    logger.error('pricecharting_process_missing_r2', { key: msg.key, category: msg.category, offset: msg.offset })
    return {
      category: msg.category, key: msg.key, stale: !!msg.stale, windowStart: msg.offset,
      rowsCollected: 0, rowsProcessed: 0, matchedTcgId: 0, matchedFuzzy: 0, unmatched: 0,
      sealedRows: 0, sealedMatched: 0, pricesUpserted: 0, fuzzyAttempts: 0,
      cursorNext: 0, wrapped: true, budgetHit: false, batchHit: false, durationMs: 0,
    }
  }
  return processWindowFromBody(env, msg.category, msg.key, !!msg.stale, obj.body, msg.offset, windowOptsFromEnv(env))
}

/**
 * Kick off PROCESSING of a cached R2 file. In prod the dedicated queue drives the windows across
 * invocations (enqueue the first window; the consumer self-perpetuates to EOF). With no queue
 * bound (local dev / dry-run / tests) it falls back to an inline window-by-window loop so the path
 * is still usable; bounded as a runaway backstop.
 */
export async function startPriceChartingProcessing(
  env: Env, category: PriceChartingCategory, key: string, stale = false,
): Promise<{ enqueued: boolean; counts?: PcWindowCounts[] }> {
  const first: PcProcessMessage = { kind: 'pricecharting-process', category, key, offset: 0, stale }
  if (env.PC_PROCESS_QUEUE) {
    await env.PC_PROCESS_QUEUE.send(first)
    return { enqueued: true }
  }
  const counts: PcWindowCounts[] = []
  let msg = first
  for (let i = 0; i < 2000; i++) {
    const c = await processPriceChartingWindow(env, msg)
    counts.push(c)
    if (c.wrapped) break
    msg = { ...msg, offset: c.cursorNext }
  }
  return { enqueued: false, counts }
}

// ── Job bodies (called by the cron, the admin trigger, and the HTTP endpoints) ──

/**
 * The DOWNLOAD job: fetch a fresh CSV → R2 (arms the cooldown) → start processing. The ONLY path
 * that hits the rate-limited download. Cooldown-gating is the caller's responsibility (the admin
 * trigger / HTTP endpoint refuse while cooling); this always attempts the (single) download.
 */
export async function runPriceChartingFetch(env: Env, category: PriceChartingCategory): Promise<PcFetchResult> {
  const result = await fetchPriceChartingCsvToR2(env, category)   // throws on download failure
  await startPriceChartingProcessing(env, category, result.key, false)
  return result
}

/**
 * The PROCESS job (no download): resolve the freshest cached R2 file (today, else the most recent
 * as a logged stale fallback) and start processing it. Never downloads, never blocked by the
 * cooldown — re-processing the cached file is unlimited and safe.
 */
export async function runPriceChartingProcess(env: Env, category: PriceChartingCategory): Promise<{ key: string; stale: boolean } | null> {
  const resolved = await resolveProcessKey(env, category)
  if (!resolved) {
    logger.error('pricecharting_process_no_r2_file', { category })
    return null
  }
  if (resolved.stale) logger.info('pricecharting_process_stale_fallback', { category, key: resolved.key })
  await startPriceChartingProcessing(env, category, resolved.key, resolved.stale)
  return resolved
}
