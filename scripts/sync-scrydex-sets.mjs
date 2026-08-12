#!/usr/bin/env node
/**
 * sync-scrydex-sets.mjs
 *
 * Operator runbook for the Scrydex set-mapping re-run — the step that decides whether the Magic
 * cost/colour fill is worth running at all.
 *
 * `POST /scrydex/sync-sets` maps our `sets` rows onto Scrydex expansion ids by code, then by
 * normalised name. Until 2026-08-12 it read only the FIRST page of each game's expansions (it sent
 * an ignored `limit:'500'`), so **70 of 454 Magic sets** were mapped and every expansion-scoped
 * Magic job was capped at ~21.7% of the game's products. The pagination fix is deployed; this
 * script runs the mapping and MEASURES what changed, because the endpoint itself is
 * fire-and-forget — it returns "started" and reports nothing.
 *
 * What it does:
 *   1. measures mapped-vs-total sets per game (and Magic's product-level coverage) BEFORE,
 *   2. fires the mapping,
 *   3. polls until the numbers stop moving,
 *   4. prints the delta + the new Magic ceiling, which is the number that decides the fill.
 *
 * Costs a handful of Scrydex credits (one page-call per 100 expansions per game). Idempotent —
 * re-running re-maps the same sets to the same ids.
 *
 * Usage:
 *   INGESTION_WORKER_SECRET=... node scripts/sync-scrydex-sets.mjs
 *   node scripts/sync-scrydex-sets.mjs --measure-only     # read-only; no secret, no credits
 *   INGESTION_WORKER_SECRET=... node scripts/sync-scrydex-sets.mjs --db sleevedpagesdb-uat --url https://<uat-worker>
 */

import { spawnSync } from 'node:child_process'
import { resolveWorkerSecret } from './lib/workerSecret.mjs'

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const has = (name) => args.includes(name)

const WORKER_URL = arg('--url', 'https://sleevedpages-ingestion.sleevedpages.workers.dev')
const DB_NAME = arg('--db', 'sleevedpagesdb')
const MEASURE_ONLY = has('--measure-only')

// Resolved from the environment, else from the gitignored `.dev.vars` — never hardcoded here.
const WORKER_SECRET = resolveWorkerSecret({
  required: !MEASURE_ONLY,
  scriptName: 'sync-scrydex-sets.mjs (--measure-only needs no secret)',
})

/**
 * One read-only D1 query through wrangler (uses your existing wrangler login).
 *
 * Two platform facts are baked in here, both learned the hard way:
 *   · `--file` is NOT usable for reads — wrangler returns an execution SUMMARY ("Total queries
 *     executed", "Rows read") for a file, not the rows. Only `--command` returns results.
 *   · On Windows, Node refuses to spawn `npx.cmd` without a shell (EINVAL — the CVE-2024-27980
 *     hardening), so Windows goes through a shell with the SQL double-quoted, while POSIX passes
 *     the SQL as a plain argv entry and needs no quoting at all.
 * The SQL below therefore uses single quotes only, and is flattened to one line for the shell.
 */
function query(sql) {
  const oneLine = sql.replace(/\s+/g, ' ').trim()
  if (oneLine.includes('"')) {
    console.error('  ✗ internal: query SQL must not contain double quotes (Windows shell quoting).')
    process.exit(1)
  }
  const res = process.platform === 'win32'
    ? spawnSync(
      `npx wrangler d1 execute ${DB_NAME} --remote --json --command "${oneLine}"`,
      { encoding: 'utf8', shell: true, maxBuffer: 32 * 1024 * 1024 },
    )
    : spawnSync(
      'npx',
      ['wrangler', 'd1', 'execute', DB_NAME, '--remote', '--json', '--command', oneLine],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    )
  const out = `${res.stdout ?? ''}`
  const start = out.indexOf('[')          // wrangler prints banners before the JSON
  if (start < 0) {
    console.error('  ✗ could not read D1 — is wrangler logged in?')
    console.error((res.stderr || out || '').trim().split('\n').slice(-5).join('\n'))
    process.exit(1)
  }
  try {
    return JSON.parse(out.slice(start))[0]?.results ?? []
  } catch (e) {
    console.error(`  ✗ could not parse the D1 response: ${e.message}`)
    process.exit(1)
  }
}

const PER_GAME_SQL = `
  SELECT g.name AS game,
         COUNT(*) AS sets,
         SUM(CASE WHEN s.scrydex_expansion_id IS NOT NULL AND TRIM(s.scrydex_expansion_id) <> ''
                  THEN 1 ELSE 0 END) AS mapped
  FROM   sets s
  JOIN   canonical_games g ON g.id = s.game_id
  GROUP BY g.name
  HAVING mapped > 0 OR g.name IN ('Magic','Pokemon','One Piece Card Game','Gundam Card Game','Lorcana TCG')
  ORDER BY g.name`

// Magic's PRODUCT-level ceiling: the share of cards an expansion-scoped job can reach at all.
const MAGIC_PRODUCTS_SQL = `
  SELECT COUNT(*) AS products,
         SUM(CASE WHEN s.scrydex_expansion_id IS NOT NULL AND TRIM(s.scrydex_expansion_id) <> ''
                  THEN 1 ELSE 0 END) AS in_mapped_set
  FROM   products p
  JOIN   sets s ON s.id = p.set_id
  JOIN   canonical_games g ON g.id = s.game_id
  WHERE  g.name = 'Magic'`

const snapshot = () => ({
  perGame: query(PER_GAME_SQL),
  magic: query(MAGIC_PRODUCTS_SQL)[0] ?? { products: 0, in_mapped_set: 0 },
})
const totalMapped = (s) => s.perGame.reduce((n, r) => n + Number(r.mapped ?? 0), 0)

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—')
function printTable(before, after) {
  console.log('\n  game                                    mapped / sets      change')
  for (const row of after.perGame) {
    const was = before?.perGame.find(r => r.game === row.game)
    const delta = was ? Number(row.mapped) - Number(was.mapped) : 0
    console.log(
      `    ${String(row.game).padEnd(38)} ${String(row.mapped).padStart(4)} / ${String(row.sets).padEnd(5)}` +
      ` ${pct(row.mapped, row.sets).padStart(7)}   ${delta > 0 ? `+${delta}` : delta < 0 ? String(delta) : '·'}`
    )
  }
  const m = after.magic
  console.log(
    `\n  Magic product ceiling: ${m.in_mapped_set} / ${m.products} products in a mapped set ` +
    `(${pct(m.in_mapped_set, m.products)})`
  )
}

const before = snapshot()

if (MEASURE_ONLY) {
  printTable(null, before)
  console.log('\n  (read-only — nothing was mapped and no credits were spent)\n')
  process.exit(0)
}

console.log(`  mapped sets before: ${totalMapped(before)} · firing the mapping…`)

const res = await fetch(`${WORKER_URL.replace(/\/$/, '')}/scrydex/sync-sets`, {
  method: 'POST',
  headers: { 'x-worker-secret': WORKER_SECRET },
})
const data = await res.json().catch(() => ({ ok: false, error: `non-JSON response (HTTP ${res.status})` }))
if (!data.ok) {
  console.error(`  ✗ the worker refused the trigger (HTTP ${res.status}): ${data.error ?? 'unknown error'}`)
  if (res.status === 401) console.error('    401 = wrong or missing INGESTION_WORKER_SECRET.')
  if (res.status === 503) console.error('    503 = the worker has no Scrydex keys configured.')
  process.exit(1)
}

// The endpoint is fire-and-forget (waitUntil), so progress is only visible in the data. Poll until
// the count holds steady — but ALWAYS poll a few times first: the count sitting at its starting
// value simply means the mapping has not written yet, and treating that as "steady" would report
// "no change" on a run that had not begun.
const MIN_POLLS = 3          // ≥30s before an unchanged count is allowed to mean "finished"
const STEADY_POLLS = 2
let steady = 0
let last = totalMapped(before)
let after = before
for (let i = 0; i < 18; i++) {
  await new Promise(r => setTimeout(r, 10_000))
  after = snapshot()
  const now = totalMapped(after)
  steady = now === last ? steady + 1 : 0
  process.stdout.write(`  …${now} mapped${now === last ? ' (steady)' : ` (+${now - last})`}\n`)
  last = now
  if (i + 1 >= MIN_POLLS && steady >= STEADY_POLLS) break
}

printTable(before, after)

const gained = totalMapped(after) - totalMapped(before)
const ceiling = after.magic.products ? after.magic.in_mapped_set / after.magic.products : 0
console.log(
  `\n  ${gained > 0 ? `+${gained} sets newly mapped.` : 'No new mappings — the catalogue was already complete for what Scrydex exposes.'}`
)
console.log(
  ceiling >= 0.8
    ? '  Magic coverage looks good — the cost/colour fill is worth running:\n' +
    '    INGESTION_WORKER_SECRET=... node scripts/fill-mtg-attributes.mjs\n'
    : '  ⚠️ Magic coverage is still partial. Session 2 puts an unresolved cost in the "Unknown" bucket,\n' +
    '     so filling now would give 3B a mana curve that is mostly absence. Decide deliberately\n' +
    '     before running the fill — see docs/audits/2026-08-12_scrydex-mtg-attribute-fill-diagnostic.md §3.2.\n'
)
