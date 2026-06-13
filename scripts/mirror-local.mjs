#!/usr/bin/env node
/**
 * mirror-local.mjs
 *
 * Mirrors card images to R2 by fetching from TCGPlayer/Scrydex using THIS
 * machine's IP address. The Cloudflare Worker's datacenter IPs are blocked
 * by tcgplayer-cdn.tcgplayer.com (403), so this script fetches locally and
 * hands the bytes to the Worker via POST /mirror/upload, which writes to R2.
 *
 * Scrydex is not IP-blocked, so this script also handles Pokémon cards with
 * a Scrydex mapping — giving you one command to finish the full mirror.
 *
 * Usage:
 *   node scripts/mirror-local.mjs
 *   node scripts/mirror-local.mjs --scrydex-only   # only Pokémon cards with a Scrydex mapping
 *   node scripts/mirror-local.mjs --batch 100       # cards per batch (default: 50)
 *   node scripts/mirror-local.mjs --concurrency 10
 */

import { Buffer } from 'node:buffer'

const WORKER_URL = 'https://sleevedpages-ingestion.sleevedpages.workers.dev'
const args = process.argv.slice(2)
const BATCH_SIZE = parseInt(args[args.indexOf('--batch') + 1] ?? '50', 10) || 50
const CONCURRENCY = parseInt(args[args.indexOf('--concurrency') + 1] ?? '5', 10) || 5
const SCRYDEX_ONLY = args.includes('--scrydex-only')

// ─── Scrydex URL construction (mirrors image-mirror.ts logic) ────────────────

function formatScrydexCardNumber(num) {
  // Split on "/" and take the base number (e.g. "RC2/RC32" → "RC2", "025/165" → "025")
  const base = num.split('/')[0].trim()
  // TG/GG gallery cards: pad numeric part to 2 digits (TG6 → TG06)
  const gallery = base.match(/^(TG|GG)(\d+)/i)
  if (gallery) return gallery[1].toUpperCase() + String(parseInt(gallery[2], 10)).padStart(2, '0')
  // Other letter-prefix cards (RC, SV, PR, …): keep raw number, no padding
  const alphaNum = base.match(/^([A-Za-z]+)(\d+)$/)
  if (alphaNum) return alphaNum[1].toUpperCase() + alphaNum[2]
  // Pure numeric: strip leading zeros
  const digits = base.match(/^(\d+)/)
  if (digits) return String(parseInt(digits[1], 10))
  return base
}

function buildScrydexUrl(setId, cardNumber) {
  return `https://images.scrydex.com/pokemon/${setId}-${formatScrydexCardNumber(cardNumber)}/large`
}

function isPokemon(categoryName) {
  if (!categoryName) return false
  return categoryName.toLowerCase().replace(/é/g, 'e').includes('pokemon')
}

// ─── Fetch image from local IP ───────────────────────────────────────────────

async function fetchImage(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://www.tcgplayer.com/',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
      },
    })
    if (!res.ok) return null
    const contentType = res.headers.get('content-type') ?? 'image/jpeg'
    const buffer = await res.arrayBuffer()
    // Guard against Scrydex placeholder images (card back returned for unknown URLs).
    // The placeholder is ~181 KB; real card scans should be larger.
    // Threshold set to 300 KB — placeholder is ~181 KB, real cards are ~400 KB+.
    //
    // Guard intentionally rejects small TCGPlayer images from R2 — TCGPlayer high-res
    // (`_in_1000x1000`) is watermarked on alts, so TCGPlayer cards render from
    // `source_url` (CDN), not R2. Do not scope this guard to 'fix' TCGPlayer
    // mirroring — it's deliberate.
    if (buffer.byteLength < 300_000) return null
    return { buffer, contentType }
  } catch {
    return null
  }
}

// ─── Upload bytes to Worker → R2 ────────────────────────────────────────────

async function uploadImage(productId, buffer, contentType, source) {
  const imageBase64 = Buffer.from(buffer).toString('base64')
  const res = await fetch(`${WORKER_URL}/mirror/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tcgplayer_product_id: productId, imageBase64, contentType, source }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Upload ${res.status}: ${text.slice(0, 120)}`)
  }
  return res.json()
}

// ─── Mirror one card ─────────────────────────────────────────────────────────

async function mirrorCard(card) {
  const poke = isPokemon(card.category_name)

  // Pokémon with Scrydex mapping: try Scrydex first (high-res)
  if (poke && card.card_number && card.scrydex_set_id) {
    const fetched = await fetchImage(buildScrydexUrl(card.scrydex_set_id, card.card_number))
    if (fetched) {
      await uploadImage(card.tcgplayer_product_id, fetched.buffer, fetched.contentType, 'scrydex')
      return 'scrydex'
    }
  }

  // TCGPlayer fallback
  if (card.image_url) {
    const fetched = await fetchImage(card.image_url)
    if (fetched) {
      await uploadImage(card.tcgplayer_product_id, fetched.buffer, fetched.contentType, 'tcgplayer')
      return 'tcgplayer'
    }
  }

  return 'failed'
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n) { return n.toLocaleString() }
function pad(s, w) { return String(s).padStart(w) }
function elapsed(ms) { return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s` }

function bar(done, total, width = 20) {
  if (!total) return '[' + '░'.repeat(width) + ']'
  const filled = Math.round((done / total) * width)
  return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']'
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n  SleevedPages — Local Image Mirror\n  ' + '─'.repeat(40))
  console.log(`  Batch: ${BATCH_SIZE}  Concurrency: ${CONCURRENCY}  Mode: ${SCRYDEX_ONLY ? 'Scrydex only' : 'all sources'}`)
  console.log('  Fetches images from this machine\'s IP — bypasses CDN datacenter blocks.\n')

  let batchNum = 0
  let totalProcessed = 0, totalMirrored = 0
  let totalScrydex = 0, totalTcg = 0, totalFailed = 0
  const jobStart = Date.now()

  while (true) {
    batchNum++
    const batchStart = Date.now()

    // Fetch next batch of pending cards from Worker
    let cards
    try {
      const pendingUrl = `${WORKER_URL}/mirror/pending?limit=${BATCH_SIZE}${SCRYDEX_ONLY ? '&scrydex_only=1' : ''}`
      const res = await fetch(pendingUrl)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (!data.ok) throw new Error(data.error ?? 'Unknown error')
      cards = data.cards
    } catch (e) {
      console.error(`\n  ✗ Batch ${batchNum}: Failed to fetch pending cards — ${e.message}`)
      console.error('  Waiting 5s before retrying…')
      await new Promise(r => setTimeout(r, 5000))
      batchNum--
      continue
    }

    if (!cards || cards.length === 0) break

    // Process in parallel chunks of CONCURRENCY
    let batchMirrored = 0, batchScrydex = 0, batchTcg = 0, batchFailed = 0
    for (let i = 0; i < cards.length; i += CONCURRENCY) {
      const chunk = cards.slice(i, i + CONCURRENCY)
      const results = await Promise.all(chunk.map(mirrorCard))
      for (const r of results) {
        totalProcessed++
        if (r === 'scrydex') { batchMirrored++; batchScrydex++; totalMirrored++; totalScrydex++ }
        else if (r === 'tcgplayer') { batchMirrored++; batchTcg++; totalMirrored++; totalTcg++ }
        else { batchFailed++; totalFailed++ }
      }
    }

    const batchMs = Date.now() - batchStart
    process.stdout.write(
      `  Batch ${pad(batchNum, 4)}  ` +
      `${pad(fmt(totalMirrored), 7)} mirrored  ` +
      `${bar(batchMirrored, cards.length)}  ` +
      `scrydex ${pad(batchScrydex, 2)} / tcg ${pad(batchTcg, 2)}` +
      `${batchFailed > 0 ? `  ⚠ ${batchFailed} failed` : ''}  ` +
      `${elapsed(batchMs)}\n`
    )

    if (cards.length < BATCH_SIZE) break  // last page — no more pending
  }

  const totalMs = Date.now() - jobStart
  const rate = totalMirrored > 0 ? Math.round(totalMirrored / (totalMs / 1000)) : 0

  console.log('\n  ' + '─'.repeat(40))
  console.log(`  ✓ Complete in ${elapsed(totalMs)}`)
  console.log(`\n  Batches processed : ${fmt(batchNum)}`)
  console.log(`  Cards processed   : ${fmt(totalProcessed)}`)
  console.log(`  Successfully mirrored`)
  console.log(`    Scrydex         : ${fmt(totalScrydex)}`)
  console.log(`    TCGPlayer       : ${fmt(totalTcg)}`)
  console.log(`    Total           : ${fmt(totalMirrored)}`)
  if (totalFailed > 0)
    console.log(`  Failed            : ${fmt(totalFailed)}  ← no image URL in DB`)
  console.log(`  Throughput        : ~${fmt(rate)} cards/sec\n`)
}

main().catch(err => {
  console.error('\n  Fatal:', err)
  process.exit(1)
})
