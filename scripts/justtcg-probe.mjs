#!/usr/bin/env node
/**
 * justtcg-probe.mjs — operator runbook for the worker's `POST /admin/justtcg-probe` (2026-10-05).
 *
 * The JustTCG EVALUATION probe. Measures JustTCG (justtcg.com, documented API + key only) against
 * the price rows we already hold and prints the per-game summary the audit doc pastes. It decides
 * nothing and switches nothing; the worker writes NOTHING to D1 and persists the raw payloads to
 * the private price-archive bucket (`probes/justtcg/<date>/<run-id>.json`).
 *
 * ⚠️ UAT ONLY while the account is on JustTCG's Free tier (non-commercial by its terms): the key is
 * set on the UAT worker alone (`wrangler secret put JUSTTCG_API_KEY --env preview`), so this script
 * defaults to `--uat`. Pointing it at the prod worker is the proof that prod holds no key: it must
 * answer 503 `justtcg_not_configured`.
 *
 * The Free plan allows 100 calls/day at 10/min and 20 cards per batch request. A full run is
 * ONE /games call + ONE raw batch per 20 products + ONE graded call PER PRODUCT (+ one search per
 * product without a TCGplayer id) — the worker paces 9 calls per invocation (≈ 1 min each) and
 * hands back a resumable `state`; this script loops until `done`, and stops cleanly on `capHit`
 * (re-run tomorrow with `--resume <file>`).
 *
 * Usage (from Ingestion/):
 *   node scripts/justtcg-probe.mjs --uat --per-game 10 --no-tcgplayer 50
 *   node scripts/justtcg-probe.mjs --uat --ids 123,456            # canonical products.id on THAT db
 *   node scripts/justtcg-probe.mjs --uat --tcg-ids 12345,67890     # TCGplayer product ids (any db)
 *   node scripts/justtcg-probe.mjs --uat --sample-from prod --per-game 10 --no-tcgplayer 50
 *       # picks the sample on PROD by READ-ONLY wrangler SELECTs (the UAT database holds no
 *       # Scrydex / PriceCharting rows — measured 2026-10-05), posts the TCGplayer ids to the UAT
 *       # worker, then re-runs the PURE comparison (src/justtcgCompare.ts) locally against prod's
 *       # rows for those products (read-only SELECTs again). Needs Node ≥ 22.18 (type stripping).
 *   node scripts/justtcg-probe.mjs --resume probe-state.json       # continue a capHit run
 *   --max-calls 9  --json  --out <file>  --url https://<worker-url>
 *
 * Secret: INGESTION_WORKER_SECRET from the environment or the gitignored `.dev.vars`
 * (scripts/lib/workerSecret.mjs). The JustTCG key never appears here — it lives on the worker.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolveWorkerSecret } from './lib/workerSecret.mjs'

const args = process.argv.slice(2)
const has = (name) => args.includes(name)
const arg = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] != null ? args[i + 1] : dflt }

const PROD_URL = 'https://sleevedpages-ingestion.sleevedpages.workers.dev'
const UAT_URL  = 'https://sleevedpages-ingestion-preview.sleevedpages.workers.dev'
const WORKER_URL = arg('--url', has('--prod') ? PROD_URL : UAT_URL)
const WORKER_SECRET = resolveWorkerSecret({ scriptName: 'justtcg-probe.mjs' })
const MAX_CALLS = Number(arg('--max-calls', 9))
const OUT = arg('--out', `justtcg-probe-${new Date().toISOString().slice(0, 10)}.json`)
const STATE_FILE = 'justtcg-probe-state.json'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const splitIds = (s) => String(s ?? '').split(',').map(x => Number(x.trim())).filter(n => Number.isInteger(n) && n > 0)

// ── read-only prod SQL (wrangler, SELECT only) ─────────────────────────────────────────────────
function prodSelect(sql) {
  const one = sql.trim().replace(/;\s*$/, '').replace(/\s+/g, ' ')
  if (!/^(SELECT|WITH)\b/i.test(one)) throw new Error('prodSelect: SELECT/WITH only')
  if (one.includes('"')) throw new Error('prodSelect: use single quotes')
  const r = spawnSync(`npx wrangler d1 execute sleevedpagesdb --remote --json --command "${one}"`,
    { encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024, timeout: 280_000, cwd: new URL('../../Content/', import.meta.url) })
  const out = r.stdout || ''
  const parsed = JSON.parse(out.slice(out.indexOf('[')))
  if (parsed.error) throw new Error(JSON.stringify(parsed.error))
  return parsed[0]?.results ?? []
}

const PROD_GAMES = ['Pokemon', 'Pokemon Japan', 'Magic', 'One Piece Card Game', 'Lorcana TCG', 'Gundam Card Game', 'Riftbound League of Legends Trading Card Game', 'YuGiOh']
const PRODUCT_SELECT = `SELECT pr.id, pr.tcgplayer_product_id, pr.name, pr.number, s.name AS set_name, cg.name AS game FROM products pr JOIN sets s ON s.id = pr.set_id JOIN canonical_games cg ON cg.id = s.game_id`
const TIER_EXISTS = `EXISTS (SELECT 1 FROM prices p WHERE p.product_id = pr.id AND p.source = 'scrydex' AND p.is_graded = 0 AND p.grade IS NULL AND p.condition IN ('NM','LP','MP','HP','DM'))`
const TCG_RAW_EXISTS = `EXISTS (SELECT 1 FROM prices p WHERE p.product_id = pr.id AND p.source = 'tcgplayer' AND p.is_graded = 0 AND p.grade IS NULL)`
const ANY_RAW_EXISTS = `EXISTS (SELECT 1 FROM prices p WHERE p.product_id = pr.id AND p.is_graded = 0 AND p.grade IS NULL)`

function sampleFromProd(perGame, noTcg) {
  const picked = []
  for (const g of PROD_GAMES) {
    let rows = prodSelect(`${PRODUCT_SELECT} WHERE cg.name = '${g}' AND pr.product_kind = 'card' AND ${TIER_EXISTS} ORDER BY RANDOM() LIMIT ${perGame}`)
    let pool = 'scrydex_tiers'
    if (!rows.length) { rows = prodSelect(`${PRODUCT_SELECT} WHERE cg.name = '${g}' AND pr.product_kind = 'card' AND ${TCG_RAW_EXISTS} ORDER BY RANDOM() LIMIT ${perGame}`); pool = 'tcgplayer_raw' }
    for (const r of rows) picked.push({ ...r, pool })
    console.error(`  sampled ${rows.length} ${g} (${pool})`)
  }
  if (noTcg) {
    const rows = prodSelect(`${PRODUCT_SELECT} WHERE pr.product_kind = 'card' AND NOT ${TCG_RAW_EXISTS} ORDER BY CASE WHEN ${ANY_RAW_EXISTS} THEN 0 ELSE 1 END, RANDOM() LIMIT ${noTcg}`)
    for (const r of rows) picked.push({ ...r, pool: 'no_tcgplayer' })
    console.error(`  sampled ${rows.length} products with no TCGplayer raw row`)
  }
  return picked
}

function prodRows(productIds) {
  const rows = []
  for (let i = 0; i < productIds.length; i += 90) {
    const c = productIds.slice(i, i + 90)
    rows.push(...prodSelect(`SELECT product_id, source, condition, finish, variant, grade, company, is_graded, is_perfect, is_signed, is_error, value, fetched_at FROM prices WHERE product_id IN (${c.join(',')})`))
  }
  return rows
}

// ── the worker loop ────────────────────────────────────────────────────────────────────────────
async function postProbe(body) {
  const res = await fetch(`${WORKER_URL.replace(/\/$/, '')}/admin/justtcg-probe`, {
    method: 'POST', headers: { 'x-worker-secret': WORKER_SECRET, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({ ok: false, error: `non-JSON response (HTTP ${res.status})` }))
  return { status: res.status, data }
}

async function runLoop(first) {
  let body = first
  for (let i = 1; ; i++) {
    const { status, data } = await postProbe({ ...body, maxCalls: MAX_CALLS })
    if (status === 503 && data.error === 'justtcg_not_configured') {
      console.error(`  ✗ ${WORKER_URL} has NO JustTCG key (503 justtcg_not_configured)${has('--prod') ? ' — as it must: the Free key is UAT-only.' : ' — set it: wrangler secret put JUSTTCG_API_KEY --env preview'}`)
      process.exit(has('--prod') ? 0 : 1)
    }
    if (!data.ok) { console.error(`  ✗ probe failed (HTTP ${status}): ${data.error ?? 'unknown'}`); process.exit(1) }
    console.error(`  [${i}] calls ${data.calls.thisInvocation} (run ${data.calls.total}, day ${data.calls.dailyUsed}/${data.calls.dailyAllowed}) · queue ${data.queueRemaining}${data.stopped ? ` · STOPPED ${data.stopped}` : ''}${data.errors?.length ? ` · errors ${data.errors.length}` : ''}`)
    if (data.done) return data
    writeFileSync(STATE_FILE, JSON.stringify(data.state), 'utf8')
    if (data.capHit || data.stopped) {
      console.error(`  ⏸ stopped on ${data.stopped} — state saved to ${STATE_FILE}; re-run with --resume ${STATE_FILE} after the cap resets (00:00 UTC)`)
      process.exit(2)
    }
    body = { state: data.state }
    await sleep(2_000)
  }
}

// ── local re-comparison against prod rows (pure module, Node type stripping) ───────────────────
async function compareAgainstProd(data, picked) {
  let cmp
  try { cmp = await import('../src/justtcgCompare.ts') }
  catch (e) { console.error(`  ! could not load src/justtcgCompare.ts (${e.message}) — Node ≥ 22.18 with type stripping is needed; skipping the prod re-comparison`); return null }
  const raw = data.raw ?? { v1: {}, v2: {}, search: {} }
  const rows = prodRows(picked.map(p => p.id))
  const byProduct = new Map()
  for (const r of rows) { const { product_id, ...rest } = r; (byProduct.get(product_id) ?? byProduct.set(product_id, []).get(product_id)).push(rest) }
  const comparisons = picked.map(p => {
    const ours = { productId: p.id, tcgplayerProductId: p.tcgplayer_product_id, game: p.game, name: p.name, number: p.number, setName: p.set_name, rows: byProduct.get(p.id) ?? [] }
    const byId = p.tcgplayer_product_id != null ? (raw.v1[String(p.tcgplayer_product_id)] ?? null) : null
    const graded = p.tcgplayer_product_id != null ? (raw.v2[String(p.tcgplayer_product_id)] ?? null) : null
    return cmp.compareProduct(ours, byId, graded, { resolvedBy: byId ? 'tcgplayerId' : null })
  })
  return { comparisons, summary: cmp.summarise(comparisons) }
}

// ── printing ───────────────────────────────────────────────────────────────────────────────────
const f = (v, w = 7) => String(v ?? '—').padStart(w)
function printSummary(title, s) {
  console.log(`\n  ${title}`)
  console.log(`  ${'game'.padEnd(34)}${f('n',4)}${f('resolved%')}${f('tiers≥3%',10)}${f('NMΔ%',7)}${f('LPΔ%',7)}${f('HPΔ%',7)}${f('graded%',9)}${f('match',6)}${f('gradΔ%',8)}${f('fresh d',8)}${f('hist d',7)}`)
  for (const g of [...s.games, s.totals]) {
    console.log(`  ${g.game.slice(0, 33).padEnd(34)}${f(g.sampled,4)}${f(g.resolvedPct)}${f(g.tierCoveragePct,10)}${f(g.nmDeltaMedianPct,7)}${f(g.lpDeltaMedianPct,7)}${f(g.hpDeltaMedianPct,7)}${f(g.gradedCoveragePct,9)}${f(g.gradedLabelsMatched,6)}${f(g.gradedDeltaMedianPct,8)}${f(g.freshnessMedianDays,8)}${f(g.historyDaysMedian,7)}`)
  }
  const t = s.totals
  if (t.unmappedPrintings.length) console.log(`  unmapped printings: ${t.unmappedPrintings.join(' · ')}`)
  if (t.gradeLabelsSeen.length)   console.log(`  grade_label values seen: ${t.gradeLabelsSeen.join(' · ')}`)
  if (t.qualifiersSeen.length)    console.log(`  qualifiers seen: ${t.qualifiersSeen.join(' · ')}`)
  if (t.companiesSeen.length)     console.log(`  graded companies seen: ${t.companiesSeen.join(' · ')}`)
  if (t.justtcgOnlyLabels.length) console.log(`  JustTCG-only labels: ${t.justtcgOnlyLabels.join(' · ')}`)
  if (t.oursOnlyLabels.length)    console.log(`  ours-only labels: ${t.oursOnlyLabels.join(' · ')}`)
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────
let first
let picked = null
if (has('--resume')) {
  first = { state: JSON.parse(readFileSync(arg('--resume', STATE_FILE), 'utf8')) }
} else if (arg('--sample-from') === 'prod') {
  console.error('  sampling on PROD (read-only SELECTs)…')
  picked = sampleFromProd(Number(arg('--per-game', 10)), Number(arg('--no-tcgplayer', 0)))
  const tcgIds = picked.map(p => p.tcgplayer_product_id).filter(n => n != null)
  writeFileSync('justtcg-probe-sample.json', JSON.stringify(picked, null, 2), 'utf8')
  console.error(`  ${picked.length} products picked (${tcgIds.length} with a TCGplayer id) → justtcg-probe-sample.json`)
  first = { tcgplayerProductIds: tcgIds, includeRaw: true }
} else if (has('--ids')) {
  first = { canonicalProductIds: splitIds(arg('--ids')), includeRaw: has('--json') }
} else if (has('--tcg-ids')) {
  first = { tcgplayerProductIds: splitIds(arg('--tcg-ids')), includeRaw: has('--json') }
} else {
  first = { sample: { perGame: Number(arg('--per-game', 10)) }, includeNoTcgplayer: Number(arg('--no-tcgplayer', 0)), includeRaw: has('--json') }
}

console.error(`  worker ${WORKER_URL}`)
const data = await runLoop(first)
writeFileSync(OUT, JSON.stringify(data, null, 2), 'utf8')
console.error(`  ✓ done — run ${data.runId}, ${data.calls.total} calls, JustTCG reports ${JSON.stringify(data.calls.justtcgReported ?? {})}`)
console.error(`    full response → ${OUT}${data.persisted ? ` · R2 ${data.persisted.key} (${data.persisted.bytes} B)` : ` · NOT persisted (${data.persistNote ?? 'no R2'})`}`)
if (data.errors?.length) console.error(`    errors: ${data.errors.map(e => `${e.kind}: ${e.message}`).join(' | ')}`)
if (has('--json')) { console.log(JSON.stringify(data, null, 2)); process.exit(0) }

console.log(`\n  JustTCG games (${(data.justtcgGames ?? []).length}): ${(data.justtcgGames ?? []).map(g => `${g.id}${g.cards != null ? ` (${g.cards})` : ''}`).join(' · ')}`)
console.log(`  game id map: ${JSON.stringify(data.gameIdMap)}`)
printSummary(`summary vs the WORKER's database (${has('--prod') ? 'prod' : 'UAT'} rows)`, data.summary)

if (picked) {
  console.error('\n  re-comparing against PROD rows (read-only)…')
  const prod = await compareAgainstProd(data, picked)
  if (prod) {
    writeFileSync(OUT.replace(/\.json$/, '') + '.prod-compare.json', JSON.stringify(prod, null, 2), 'utf8')
    printSummary('summary vs PROD rows (Scrydex tiers / graded + PriceCharting graded)', prod.summary)
  }
}
