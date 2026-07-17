#!/usr/bin/env node
/**
 * mint-gem-packs.mjs
 *
 * Drives the worker's POST /admin/mint-pc-console for the five Chinese Pokémon
 * "Gem Pack" consoles (CBB1C–CBB5C) — the operator runbook for DIAGNOSTIC_DON_AND_GEMPACK
 * Phase 2 B, replacing the raw curl commands. Each call mints ONE canonical `sets` row +
 * `products` rows from that console's still-unmatched pricecharting_products rows and stamps
 * the map (match_method='minted') so the next PriceCharting PROCESS pass writes prices.
 * Idempotent: re-running mints nothing new and stamps nothing twice (safe to re-run).
 *
 * ⚠️ SAVE THIS SCRIPT'S OUTPUT. Each response's setId + productIds range is the ROLLBACK MAP
 * (delete minted products/set ids + NULL the stamped rows) — the script prints a consolidated
 * rollback block at the end; paste it into the session handoff.
 *
 * Usage:
 *   INGESTION_WORKER_SECRET=... node scripts/mint-gem-packs.mjs                  # mint all 5 on prod
 *   INGESTION_WORKER_SECRET=... node scripts/mint-gem-packs.mjs --url https://<uat-worker-url>   # UAT rehearsal (expect unmatchedRows: 0 — UAT has no PC rows by design)
 *   INGESTION_WORKER_SECRET=... node scripts/mint-gem-packs.mjs --process        # also enqueue the pokemon-cards + one-piece-cards re-PROCESS afterwards (cached R2 CSVs; no download)
 *   INGESTION_WORKER_SECRET=... node scripts/mint-gem-packs.mjs --console "Pokemon Chinese Gem Pack 3" --code CBB3C   # a single console
 *   INGESTION_WORKER_SECRET=... node scripts/mint-gem-packs.mjs --console "<any PC console>" --game one-piece-cards  # generalizable to future PC-only consoles
 */

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const has = (name) => args.includes(name)

const WORKER_URL = arg('--url', 'https://sleevedpages-ingestion.sleevedpages.workers.dev')
const WORKER_SECRET = 'process.env.INGESTION_WORKER_SECRET'
if (!WORKER_SECRET) {
  console.error("  ✗ INGESTION_WORKER_SECRET env var is required (matches the worker's secret; never hardcode it).")
  process.exit(1)
}

// The five Gem Pack consoles (diagnostic B3) with their operator-supplied set codes.
const GEM_PACK_CONSOLES = [
  { console_name: 'Pokemon Chinese Gem Pack', game: 'pokemon-cards', set_code: 'CBB1C' },
  { console_name: 'Pokemon Chinese Gem Pack 2', game: 'pokemon-cards', set_code: 'CBB2C' },
  { console_name: 'Pokemon Chinese Gem Pack 3', game: 'pokemon-cards', set_code: 'CBB3C' },
  { console_name: 'Pokemon Chinese Gem Pack 4', game: 'pokemon-cards', set_code: 'CBB4C' },
  { console_name: 'Pokemon Chinese Gem Pack 5', game: 'pokemon-cards', set_code: 'CBB5C' },
]

// --console overrides the default five (single arbitrary console; --code/--game optional).
const singleConsole = arg('--console', null)
const targets = singleConsole
  ? [{ console_name: singleConsole, game: arg('--game', 'pokemon-cards'), set_code: arg('--code', null) }]
  : GEM_PACK_CONSOLES

async function post(path, body) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-worker-secret': WORKER_SECRET },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) {
    throw new Error(`HTTP ${res.status} ${path}: ${data.error ?? JSON.stringify(data)}`)
  }
  return data
}

async function main() {
  console.log(`Minting ${targets.length} PC console(s) via ${WORKER_URL}\n`)
  const rollback = []

  for (const t of targets) {
    process.stdout.write(`  ${t.console_name} (${t.set_code ?? 'no code'}) … `)
    const r = await post('/admin/mint-pc-console', t)
    console.log(
      `setId ${r.setId ?? '—'}${r.setCreated ? ' (created)' : ' (existing)'} · ` +
      `unmatched ${r.unmatchedRows} · created ${r.productsCreated} (sealed ${r.sealed}) · ` +
      `existing ${r.productsExisting} · stamped ${r.stamped} · skipped ${r.skipped}` +
      (r.productIds ? ` · product ids ${r.productIds.min}–${r.productIds.max}` : ''),
    )
    rollback.push({ console: t.console_name, setId: r.setId ?? null, productIds: r.productIds ?? null })
  }

  console.log('\n── ROLLBACK MAP (save this in the handoff) ─────────────────────────')
  console.log(JSON.stringify(rollback, null, 2))
  console.log('Rollback = DELETE FROM products WHERE set_id IN (<setIds>); DELETE FROM sets WHERE id IN (<setIds>);')
  console.log("           UPDATE pricecharting_products SET canonical_product_id=NULL, match_method=NULL WHERE match_method='minted';")

  if (has('--process')) {
    console.log('\nEnqueuing re-PROCESS of the cached CSVs (no download, rate-limit-safe) …')
    for (const category of ['pokemon-cards', 'one-piece-cards']) {
      const r = await post('/pricecharting/ingest', { category })
      console.log(`  ${category}: ${r.mode} (key ${r.key}${r.stale ? ', STALE fallback' : ''})`)
    }
    console.log('  The queue chains to EOF on its own; prices land as the windows complete (~15 min/category).')
  } else {
    console.log('\nNext: re-run with --process (or wait for the daily rotation) so prices land:')
    console.log('  node scripts/mint-gem-packs.mjs --process   # skips re-minting (idempotent) + enqueues both categories')
  }

  console.log('\n✓ Done.')
}

main().catch((err) => {
  console.error('\n  ✗ mint failed:', err.message)
  process.exit(1)
})
