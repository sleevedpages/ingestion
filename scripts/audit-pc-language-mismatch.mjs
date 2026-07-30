#!/usr/bin/env node
/**
 * audit-pc-language-mismatch.mjs — OPERATOR-GATED sweep for PriceCharting rows that were
 * matched ACROSS LANGUAGES before the 2026-07-30 console-scoping fix.
 *
 * THE BUG. `pickBestCanonicalMatch` (src/lib/pricechartingCsv.ts) accepted a `console-name`
 * argument and never read it, so a row was matched on card NAME + NUMBER alone. The
 * canonical candidate pool is scoped to the ENGLISH TCGplayer category, so a foreign
 * -language PriceCharting row — console "Pokemon Chinese Gem Pack", product-name
 * "Gengar #307" — matched the English Gengar #307 and wrote CHINESE pricing onto an
 * ENGLISH product. The number-less rung had the same hole (its console↔set corroboration
 * tests the SET, not the language). Both rungs now require language AGREEMENT between the
 * PC console-name and the canonical set name.
 *
 * WHY A SWEEP IS NEEDED — these rows do NOT self-heal. `pricecharting_products` persists
 * `pc_id → canonical_product_id`, and the PROCESS pass's rung 0 (`loadExistingMatches`)
 * SKIPS the matcher entirely for any already-stamped row and reuses the stored id. So a
 * historical cross-language match keeps re-writing the foreign price on every daily run,
 * forever, no matter how correct the matcher becomes. The stamp has to be cleared.
 *
 * WHAT --apply DOES (two statements, both regenerable):
 *   1. NULLs `canonical_product_id` + `match_method` on the offending map rows, so the
 *      next PROCESS re-matches them — and the fixed matcher now REJECTS them, leaving
 *      them recorded as the catalogue gap they always were.
 *   2. DELETEs `prices` rows with `source='pricecharting'` for the affected products, so
 *      the wrong figure is gone immediately rather than lingering until the next run.
 *      Correct PriceCharting prices for those products are re-written by the next PROCESS
 *      from their own (correctly-matched) pc_id; Scrydex/TCGCSV rows are untouched, and
 *      the Content price chain falls back to them meanwhile.
 * Idempotent: a second run finds nothing, because the matcher can no longer re-stamp
 * these rows.
 *
 * ⚠️ NEVER WIRED TO A CRON, never run automatically. Dry-run is the default and is
 * strictly read-only; `--apply` is the ONLY write path. Standing order applies: run
 * against sleevedpagesdb-uat first, then sleevedpagesdb.
 *
 * USAGE (from Ingestion/):
 *   node scripts/audit-pc-language-mismatch.mjs                          # UAT, dry-run
 *   node scripts/audit-pc-language-mismatch.mjs --db sleevedpagesdb      # PROD, dry-run
 *   node scripts/audit-pc-language-mismatch.mjs --db sleevedpagesdb --apply   # writes!
 *
 * The dry run IS the count: it prints the real number of affected map rows and distinct
 * affected products. (The "213 affected products" figure in the backlog was never
 * verified against a database — take the number this prints, not that one.)
 */

import { execFileSync } from 'node:child_process'
import process from 'node:process'

// Mirrors PC_LANGUAGE_MARKERS in src/lib/pricechartingCsv.ts — keep the two in step.
const LANGUAGE_MARKERS = [
  'japanese', 'japan', 'chinese', 'korean', 'german', 'french', 'italian',
  'spanish', 'portuguese', 'dutch', 'russian', 'polish', 'thai', 'indonesian',
]

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const dbFlag = args.indexOf('--db')
const DB = dbFlag !== -1 ? args[dbFlag + 1] : 'sleevedpagesdb-uat'

if (!DB || DB.startsWith('--')) {
  console.error('Bad --db value. Use --db sleevedpagesdb-uat or --db sleevedpagesdb')
  process.exit(1)
}

/** Same normalisation the matcher uses (norm() in pricechartingCsv.ts). */
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
/** Same whole-token language read as textLanguage(). */
function textLanguage(raw) {
  const tokens = norm(raw).split(' ')
  for (const m of LANGUAGE_MARKERS) if (tokens.includes(m)) return m
  return 'english'
}

function d1(sql) {
  const out = execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' },
  )
  const parsed = JSON.parse(out)
  return parsed[0] ?? parsed
}

// Candidate pull: every FUZZY / NUMBERLESS map row whose console-name carries any language
// marker. The final language comparison is done in JS with the SAME token logic the
// matcher uses, so the audit and production can never disagree about what "Japanese" means.
// (No bind params: `wrangler d1 execute --command` takes none. Every literal here is a
// hard-coded constant from this file — no user input reaches the statement.)
const MARKER_LIKES = LANGUAGE_MARKERS
  .map((m) => `' ' || LOWER(pp.console_name) || ' ' LIKE '% ${m} %'`)
  .join(' OR ')

const CANDIDATE_SQL = `
  SELECT pp.pc_id, pp.console_name, pp.product_name, pp.match_method,
         pp.canonical_product_id, p.name AS product, s.name AS set_name
  FROM   pricecharting_products pp
  JOIN   products p ON p.id = pp.canonical_product_id
  JOIN   sets     s ON s.id = p.set_id
  WHERE  pp.canonical_product_id IS NOT NULL
    AND  pp.match_method IN ('fuzzy', 'numberless')
    AND  (${MARKER_LIKES})
  ORDER  BY pp.pc_id`.replace(/\s+/g, ' ').trim()

console.log(`[pc-language-audit] database: ${DB}  mode: ${APPLY ? 'APPLY (will write!)' : 'dry-run (read-only)'}`)

const rows = d1(CANDIDATE_SQL).results ?? []
const bad = rows.filter((r) => textLanguage(r.console_name) !== textLanguage(r.set_name))

const productIds = [...new Set(bad.map((r) => Number(r.canonical_product_id)))]
console.log(`[pc-language-audit] map rows scanned (marked console, fuzzy/numberless): ${rows.length}`)
console.log(`[pc-language-audit] CROSS-LANGUAGE matches: ${bad.length} map row(s) → ${productIds.length} distinct product(s)`)

if (bad.length === 0) {
  console.log('[pc-language-audit] nothing to do.')
  process.exit(0)
}

for (const r of bad.slice(0, 200)) {
  console.log(
    `  pc ${r.pc_id} [${r.match_method}] "${r.product_name}" · ${r.console_name} (${textLanguage(r.console_name)})\n` +
    `      → canonical ${r.canonical_product_id} "${r.product}" · ${r.set_name} (${textLanguage(r.set_name)})`,
  )
}
if (bad.length > 200) console.log(`  … and ${bad.length - 200} more`)

// A tcg-id-matched foreign row is a DIFFERENT (and much rarer) shape — PC's tcg-id is the
// TCGplayer product id, which a foreign-language print does not have — so it is reported
// for the operator's eyes only and never touched by --apply.
const tcgIdForeign = d1(`
  SELECT COUNT(*) AS n FROM pricecharting_products pp
  WHERE pp.canonical_product_id IS NOT NULL AND pp.match_method = 'tcg-id'
    AND (${MARKER_LIKES})`.replace(/\s+/g, ' ').trim()).results?.[0]?.n ?? 0
console.log(`[pc-language-audit] FYI — tcg-id-matched rows with a marked console: ${tcgIdForeign} (NOT touched by --apply; inspect manually if non-zero)`)

if (!APPLY) {
  console.log('[pc-language-audit] DRY RUN — no writes. Re-run with --apply to clear the stamps + the stale prices.')
  process.exit(0)
}

const pcIdList = bad.map((r) => `'${String(r.pc_id).replace(/'/g, "''")}'`).join(',')
const productList = productIds.join(',')

// 2) Drop the stale PriceCharting prices FIRST, then clear the stamps. In that order a
// crash between the two leaves rows that are still stamped but have no wrong price —
// the next PROCESS simply re-writes them; the reverse order could leave a wrong price
// with nothing left pointing at it to explain where it came from.
const delRes = d1(
  `DELETE FROM prices WHERE source = 'pricecharting' AND product_id IN (${productList})`,
)
console.log(`[pc-language-audit] deleted ${delRes.meta?.changes ?? '?'} stale pricecharting price row(s).`)

const updRes = d1(
  `UPDATE pricecharting_products SET canonical_product_id = NULL, match_method = NULL WHERE pc_id IN (${pcIdList})`,
)
console.log(`[pc-language-audit] cleared ${updRes.meta?.changes ?? '?'} map stamp(s) — they re-match (and are now rejected) on the next PROCESS.`)
console.log('[pc-language-audit] done. Re-run in dry-run mode to confirm 0 remaining.')
