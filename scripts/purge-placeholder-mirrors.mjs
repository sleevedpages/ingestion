#!/usr/bin/env node
/**
 * purge-placeholder-mirrors.mjs
 *
 * Drives the worker's POST /admin/purge-placeholder-mirrors cleanup sweep in a
 * loop until it's done. The sweep hashes each existing R2 card image and, on a
 * known card-back placeholder (Scrydex-had-no-scan cases like Celebrations:
 * Classic Collection), deletes the R2 object and repairs the row to the correct
 * TCGplayer image. See Ingestion/src/purgePlaceholderMirrors.ts + CLAUDE.md.
 *
 * The endpoint runs ONE bounded batch per call and returns a keyset cursor; this
 * script passes it back until { hasMore:false } — the same loop the (optional)
 * admin panel would drive. Idempotent and re-runnable; rows self-repair on the
 * next mirror cron, so this is regenerable, never destructive.
 *
 * Usage:
 *   INGESTION_WORKER_SECRET=... node scripts/purge-placeholder-mirrors.mjs
 *   INGESTION_WORKER_SECRET=... node scripts/purge-placeholder-mirrors.mjs --limit 200
 *   INGESTION_WORKER_SECRET=... node scripts/purge-placeholder-mirrors.mjs --url https://<uat-worker-url>
 */

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}

const WORKER_URL = arg('--url', 'https://sleevedpages-ingestion.sleevedpages.workers.dev')
const LIMIT = parseInt(arg('--limit', '100'), 10) || 100
const WORKER_SECRET = ''
if (!WORKER_SECRET) {
  console.error("  ✗ INGESTION_WORKER_SECRET env var is required (matches the worker's secret).")
  process.exit(1)
}

async function runBatch(cursor) {
  const res = await fetch(`${WORKER_URL}/admin/purge-placeholder-mirrors`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-worker-secret': WORKER_SECRET },
    body: JSON.stringify({ cursor, limit: LIMIT }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.ok === false) {
    throw new Error(`HTTP ${res.status}: ${body.error ?? JSON.stringify(body)}`)
  }
  return body
}

async function main() {
  console.log(`Purging placeholder mirrors via ${WORKER_URL} (limit ${LIMIT})\n`)
  let cursor = 0
  let totalScanned = 0
  let totalPurged = 0
  let batches = 0
  for (; ;) {
    const r = await runBatch(cursor)
    batches++
    totalScanned += r.scanned
    totalPurged += r.purged
    console.log(
      `  batch ${batches}: scanned ${r.scanned}, purged ${r.purged}, ` +
      `remaining ${r.remaining}, cursor → ${r.cursorNext}`,
    )
    cursor = r.cursorNext
    if (!r.hasMore) break
  }
  console.log(`\n✓ Done. ${batches} batches · scanned ${totalScanned} · purged/repaired ${totalPurged}`)
}

main().catch((err) => {
  console.error('  ✗ purge failed:', err.message)
  process.exit(1)
})
