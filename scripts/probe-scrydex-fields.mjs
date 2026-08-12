#!/usr/bin/env node
/**
 * probe-scrydex-fields.mjs
 *
 * Operator runbook for the worker's READ-ONLY `POST /admin/scrydex-probe` (card attribute metadata,
 * Session 3A). Fetches ONE page of ONE expansion — **≈1 Scrydex credit, zero writes** — and prints:
 *
 *   1. the FIELD CENSUS of the card payload, so the fill job's stored key names are pinned to
 *      observed data rather than to Scrydex's documentation (`mana_cost`, `colors`, … are what the
 *      docs promise; this is what the API actually sends), and
 *   2. the MATCH RUNG rates against our canonical catalogue, which decide how the fill resolves a
 *      Scrydex card to a `products.id`. Magic has **no** `scrydex_card_id` anywhere in the
 *      catalogue (measured 2026-08-12), so this is not a formality.
 *
 * ⚠️ As of 2026-08-04 every Scrydex call from production returns **HTTP 402**. Until that is
 * resolved this probe will report `{ ok:false, status:402 }` — which is the point: it is the
 * cheapest, safest way to confirm the account is live again before any bulk job is triggered.
 *
 * Usage:
 *   INGESTION_WORKER_SECRET=... node scripts/probe-scrydex-fields.mjs
 *   INGESTION_WORKER_SECRET=... node scripts/probe-scrydex-fields.mjs --expansion FDN
 *   INGESTION_WORKER_SECRET=... node scripts/probe-scrydex-fields.mjs --game "One Piece Card Game"
 *   INGESTION_WORKER_SECRET=... node scripts/probe-scrydex-fields.mjs --url https://<uat-worker-url>
 *   INGESTION_WORKER_SECRET=... node scripts/probe-scrydex-fields.mjs --json    # raw response
 */

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}

const WORKER_URL = arg('--url', 'https://sleevedpages-ingestion.sleevedpages.workers.dev')
const WORKER_SECRET = 'L+d3of6mYvXOb7zh5zXVVPtGqwPlnu2WdTMeQq3mEaVkUVbM1j0Suln4+W7Phf3vKAfBZiOulqv3fmXjNqcWRw=='
if (!WORKER_SECRET) {
  console.error("  ✗ INGESTION_WORKER_SECRET env var is required (matches the worker's secret; never hardcode it).")
  process.exit(1)
}

const body = {
  game: arg('--game', 'Magic'),
  expansionId: arg('--expansion', undefined),
  limit: arg('--limit') ? Number(arg('--limit')) : undefined,
}

const res = await fetch(`${WORKER_URL.replace(/\/$/, '')}/admin/scrydex-probe`, {
  method: 'POST',
  headers: { 'x-worker-secret': WORKER_SECRET, 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const data = await res.json().catch(() => ({ ok: false, error: `non-JSON response (HTTP ${res.status})` }))

if (args.includes('--json')) {
  console.log(JSON.stringify(data, null, 2))
  process.exit(data.ok ? 0 : 1)
}

if (!data.ok) {
  console.error(`  ✗ probe failed (HTTP ${res.status})${data.status ? ` — Scrydex returned ${data.status}` : ''}`)
  console.error(`    ${data.error ?? 'unknown error'}`)
  if (data.status === 402) {
    console.error('    402 = the Scrydex plan is not currently serving this key. This is a billing/account')
    console.error('    matter, not a code path — no ingest job can succeed until it clears.')
  }
  process.exit(1)
}

const pct = (n) => `${((n / (data.cardsSampled || 1)) * 100).toFixed(1)}%`
console.log(`\n  ${data.game} · expansion ${data.expansionId} (${data.setName})`)
console.log(`  ${data.cardsSampled} cards sampled · ${data.requests} credit(s) spent\n`)

console.log('  CARD FIELDS')
for (const f of data.cardFields ?? []) {
  console.log(`    ${f.field.padEnd(22)} ${String(f.present).padStart(4)} (${pct(f.present).padStart(6)})  ${f.kind.padEnd(14)} ${f.sample}`)
}
if ((data.variantFields ?? []).length) {
  console.log('\n  VARIANT FIELDS')
  for (const f of data.variantFields) {
    console.log(`    ${f.field.padEnd(22)} ${String(f.present).padStart(4)}  ${f.kind.padEnd(14)} ${f.sample}`)
  }
}

const m = data.matchRungs ?? {}
console.log('\n  MATCH RUNGS (cards resolving to a canonical product)')
console.log(`    R1 tcgplayer product_id   ${String(m.r1_tcgplayerProductId).padStart(4)} (${pct(m.r1_tcgplayerProductId)})`)
console.log(`    R2 card.id  vs number     ${String(m.r2_cardIdVsNumber).padStart(4)} (${pct(m.r2_cardIdVsNumber)})`)
console.log(`    R3 card.number in set     ${String(m.r3_numberInExpansion).padStart(4)} (${pct(m.r3_numberInExpansion)})`)
console.log(`    ANY rung                  ${String(m.anyRung).padStart(4)} (${pct(m.anyRung)})`)
console.log(`    unmatched                 ${String(m.unmatched).padStart(4)} (${pct(m.unmatched)})`)
for (const u of data.unmatchedSample ?? []) {
  console.log(`      · ${u.id ?? '—'}  ${u.name ?? '—'}  #${u.number ?? '—'}`)
}
console.log('')
