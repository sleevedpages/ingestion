#!/usr/bin/env node
/**
 * update-prices.mjs
 *
 * Re-runs the PriceCharting price ingest on demand — the "make prices land NOW" runbook,
 * without waiting for the daily 05:00 UTC category rotation. By default it PROCESSes the
 * already-cached R2 CSV for each category (POST /pricecharting/ingest — no download, unlimited,
 * idempotent, zero rate-limit exposure); the queue then chains window-by-window to EOF on its
 * own (~15 min for a big category). Prices upsert on the standing conflict keys, so re-running
 * never duplicates. Newly minted products (mint-gem-packs.mjs) get priced via their map stamps;
 * DON!!s via the number-less matcher rung.
 *
 * Usage:
 *   INGESTION_WORKER_SECRET=... node scripts/update-prices.mjs                        # PROCESS all 4 categories from cached CSVs
 *   INGESTION_WORKER_SECRET=... node scripts/update-prices.mjs --category pokemon-cards          # one category
 *   INGESTION_WORKER_SECRET=... node scripts/update-prices.mjs --category pokemon-cards,one-piece-cards
 *   INGESTION_WORKER_SECRET=... node scripts/update-prices.mjs --sync --category pokemon-cards   # ONE inline window, prints its match counts (verification: matchedNumberless / matchedExisting should be non-zero after the DON/mint work)
 *   INGESTION_WORKER_SECRET=... node scripts/update-prices.mjs --fetch --category pokemon-cards  # ⚠️ fresh DOWNLOAD first (hard rate-limited ~1/10min — the endpoint 429s while cooling; never loop this)
 *   INGESTION_WORKER_SECRET=... node scripts/update-prices.mjs --url https://<uat-worker-url>
 */

const CATEGORIES = ['pokemon-cards', 'magic-cards', 'yugioh-cards', 'one-piece-cards']

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const has = (name) => args.includes(name)

const WORKER_URL = arg('--url', 'https://sleevedpages-ingestion.sleevedpages.workers.dev')
const WORKER_SECRET = '07187f62289de8634ddb384a1b466374ada4bc60ad0e6216cd90797a10c0cea7'
if (!WORKER_SECRET) {
  console.error("  ✗ INGESTION_WORKER_SECRET env var is required (matches the worker's secret).")
  process.exit(1)
}

const requested = arg('--category', CATEGORIES.join(','))
  .split(',').map((s) => s.trim()).filter(Boolean)
const bad = requested.filter((c) => !CATEGORIES.includes(c))
if (bad.length) {
  console.error(`  ✗ Unknown category: ${bad.join(', ')} (valid: ${CATEGORIES.join(', ')})`)
  process.exit(1)
}

async function post(path, body) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-worker-secret': WORKER_SECRET },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

async function main() {
  const mode = has('--fetch') ? 'FETCH (fresh download) + PROCESS' : has('--sync') ? 'PROCESS one inline window' : 'PROCESS cached CSV'
  console.log(`Price update via ${WORKER_URL} — ${mode}\n  categories: ${requested.join(', ')}\n`)

  for (const category of requested) {
    process.stdout.write(`  ${category} … `)

    if (has('--fetch')) {
      // Fresh download → R2 → auto-enqueues PROCESS. Cooldown-gated server-side (429) — on a
      // 429 we FALL BACK to processing the cached file rather than waiting/looping (the CSV
      // only regenerates ~once/24h anyway; abuse risks account revocation).
      const { status, data } = await post('/pricecharting/fetch', { category })
      if (status === 429) {
        console.log(`download cooling (${data.retryAfterSec ?? '?'}s left) → falling back to the cached CSV`)
      } else if (!data.ok) {
        console.log(`✗ ${data.error ?? `HTTP ${status}`}`)
        continue
      } else {
        console.log(`downloaded ${data.bytes?.toLocaleString?.() ?? '?'} bytes → ${data.key} · processing enqueued`)
        continue
      }
    }

    const body = has('--sync') ? { category, sync: true } : { category }
    const { status, data } = await post('/pricecharting/ingest', body)
    if (!data.ok) {
      // 409 = nothing ever fetched for this category (no cached CSV in R2).
      console.log(`✗ ${data.error ?? `HTTP ${status}`}`)
      continue
    }
    if (has('--sync')) {
      console.log(
        `window [${data.windowStart}..${data.windowStart + data.rowsProcessed}) of ${data.key}${data.stale ? ' (STALE)' : ''}: ` +
        `tcg-id ${data.matchedTcgId} · fuzzy ${data.matchedFuzzy} · numberless ${data.matchedNumberless} · ` +
        `pre-stamped ${data.matchedExisting} · unmatched ${data.unmatched} · prices ${data.pricesUpserted}` +
        (data.wrapped ? ' · EOF' : ` · cursorNext ${data.cursorNext} (run without --sync to finish via the queue)`),
      )
    } else {
      console.log(`enqueued (key ${data.key}${data.stale ? ', STALE fallback — yesterday\'s file' : ''})`)
    }
  }

  console.log('\n✓ Done. Enqueued categories chain to EOF in the background (~15 min each for the big ones).')
  console.log('  Verify afterwards (read-only): matched counts in pricecharting_products, prices rows for minted/DON products.')
}

main().catch((err) => {
  console.error('\n  ✗ price update failed:', err.message)
  process.exit(1)
})
