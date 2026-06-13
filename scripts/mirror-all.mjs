#!/usr/bin/env node
/**
 * mirror-all.mjs
 *
 * Runs the image mirror job to completion by repeatedly calling the ingestion
 * worker until has_more is false. Each request processes one batch of 100 cards
 * (~3-5 seconds per batch).
 *
 * Usage:
 *   node scripts/mirror-all.mjs
 *   node scripts/mirror-all.mjs --delay 1000   # ms between batches (default: 500)
 *   node scripts/mirror-all.mjs --dry           # just prints what it would do
 */

const WORKER_URL  = 'https://sleevedpages-ingestion.sleevedpages.workers.dev'
const args        = process.argv.slice(2)
const DELAY_MS    = parseInt(args[args.indexOf('--delay') + 1] ?? '500', 10) || 500
const DRY_RUN     = args.includes('--dry')

// ─── helpers ────────────────────────────────────────────────────────────────

function fmt(n) { return n.toLocaleString() }
function pad(s, w) { return String(s).padStart(w) }

function bar(mirrored, processed, width = 30) {
  if (!processed) return '[' + '░'.repeat(width) + ']'
  const filled = Math.round((mirrored / processed) * width)
  return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']'
}

function elapsed(ms) {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n  SleevedPages — Image Mirror\n  ' + '─'.repeat(40))

  if (DRY_RUN) {
    console.log('  DRY RUN — no requests will be made\n')
    return
  }

  let batchNum       = 0
  let totalProcessed = 0
  let totalMirrored  = 0
  let totalScrydex   = 0
  let totalTcgplayer = 0
  let totalFailed    = 0
  const jobStart     = Date.now()

  while (true) {
    batchNum++
    const batchStart = Date.now()

    let res
    try {
      const response = await fetch(`${WORKER_URL}/mirror`, { method: 'POST' })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        console.error(`\n  ✗ Batch ${batchNum}: HTTP ${response.status} — ${text.slice(0, 120)}`)
        break
      }

      res = await response.json()
    } catch (e) {
      console.error(`\n  ✗ Batch ${batchNum}: Network error — ${e.message}`)
      console.error('    Waiting 5s before retrying…')
      await new Promise(r => setTimeout(r, 5000))
      batchNum-- // retry same batch number
      continue
    }

    if (!res.ok) {
      console.error(`\n  ✗ Batch ${batchNum}: Worker error — ${res.error}`)
      break
    }

    totalProcessed += res.processed    ?? 0
    totalMirrored  += res.mirrored     ?? 0
    totalScrydex   += res.scrydex_hits ?? 0
    totalTcgplayer += res.tcgplayer_hits ?? 0
    totalFailed    += res.failed       ?? 0

    const batchElapsed = Date.now() - batchStart
    const scrydexPct   = res.mirrored > 0
      ? Math.round((res.scrydex_hits / res.mirrored) * 100)
      : 0

    process.stdout.write(
      `  Batch ${pad(batchNum, 4)}  ` +
      `${pad(fmt(totalMirrored), 7)} mirrored  ` +
      `${bar(res.mirrored, res.processed, 20)}  ` +
      `scrydex ${pad(scrydexPct, 3)}%  ` +
      `${res.failed > 0 ? `⚠ ${res.failed} failed  ` : ''}` +
      `${elapsed(batchElapsed)}\n`
    )

    if (!res.has_more) {
      break
    }

    await new Promise(r => setTimeout(r, DELAY_MS))
  }

  const totalElapsed = Date.now() - jobStart
  const rate = totalMirrored > 0
    ? Math.round(totalMirrored / (totalElapsed / 1000))
    : 0

  console.log('\n  ' + '─'.repeat(40))
  console.log(`  ✓ Complete in ${elapsed(totalElapsed)}`)
  console.log(`\n  Batches processed : ${fmt(batchNum)}`)
  console.log(`  Cards processed   : ${fmt(totalProcessed)}`)
  console.log(`  Successfully mirrored`)
  console.log(`    Scrydex         : ${fmt(totalScrydex)}`)
  console.log(`    TCGPlayer       : ${fmt(totalTcgplayer)}`)
  console.log(`    Total           : ${fmt(totalMirrored)}`)
  if (totalFailed > 0)
    console.log(`  Failed            : ${fmt(totalFailed)}  ← re-run to retry`)
  console.log(`  Throughput        : ~${fmt(rate)} cards/sec\n`)
}

main().catch(err => {
  console.error('\n  Fatal:', err)
  process.exit(1)
})
