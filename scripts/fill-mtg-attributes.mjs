#!/usr/bin/env node
/**
 * fill-mtg-attributes.mjs
 *
 * Loop driver for `POST /admin/mtg-attribute-fill` — fills Magic mana cost + colour into
 * `product_attributes` from Scrydex, one bounded batch of expansions per call, until the worker
 * reports `hasMore: false`. Resumable by construction: each completed expansion is marked in
 * `scrydex_expansion_freshness` (`price_type='mtg_attrs'`), so re-running after a stop costs
 * nothing for what already landed. Safe to re-run at any time.
 *
 * ⚠️ THIS SPENDS SCRYDEX CREDITS: one page-call per 100 cards per expansion (the server caps the
 * page size at 100 — measured). Check the monthly figure in Admin → Scrydex first, and remember
 * `SUM(credits_used)` is spend while `COUNT(*)` is attempts. The run stops itself on a credit-guard
 * trip or a 402/403 and reports `stoppedReason`; re-run once the account is healthy.
 *
 * Usage:
 *   INGESTION_WORKER_SECRET=... node scripts/fill-mtg-attributes.mjs
 *   INGESTION_WORKER_SECRET=... node scripts/fill-mtg-attributes.mjs --batch 8      # expansions per call
 *   INGESTION_WORKER_SECRET=... node scripts/fill-mtg-attributes.mjs --max-calls 5  # stop after N calls
 *   INGESTION_WORKER_SECRET=... node scripts/fill-mtg-attributes.mjs --expansion FDN --force
 *   INGESTION_WORKER_SECRET=... node scripts/fill-mtg-attributes.mjs --url https://<uat-worker-url>
 */

import { resolveWorkerSecret } from './lib/workerSecret.mjs'

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}

const WORKER_URL = arg('--url', 'https://sleevedpages-ingestion.sleevedpages.workers.dev')
// Resolved from the environment, else from the gitignored `.dev.vars` — never hardcoded here.
const WORKER_SECRET = resolveWorkerSecret({ scriptName: 'fill-mtg-attributes.mjs' })

const body = {
  maxExpansions: arg('--batch') ? Number(arg('--batch')) : undefined,
  expansionId:   arg('--expansion', undefined),
  force:         args.includes('--force') || undefined,
}
const maxCalls = arg('--max-calls') ? Number(arg('--max-calls')) : Infinity

const totals = { calls: 0, expansions: 0, cards: 0, products: 0, rows: 0, unmatched: 0, credits: 0 }

while (totals.calls < maxCalls) {
  const res = await fetch(`${WORKER_URL.replace(/\/$/, '')}/admin/mtg-attribute-fill`, {
    method: 'POST',
    headers: { 'x-worker-secret': WORKER_SECRET, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({ ok: false, error: `non-JSON response (HTTP ${res.status})` }))
  totals.calls++

  totals.expansions += data.expansionsProcessed ?? 0
  totals.cards      += data.cardsFetched ?? 0
  totals.products   += data.productsWritten ?? 0
  totals.rows       += data.attributeRowsWritten ?? 0
  totals.unmatched  += data.cardsUnmatched ?? 0
  totals.credits    += data.requests ?? 0

  console.log(
    `  call ${totals.calls}: +${data.expansionsProcessed ?? 0} expansions · ` +
    `${data.productsWritten ?? 0} products · ${data.attributeRowsWritten ?? 0} rows · ` +
    `${data.requests ?? 0} credits · ${data.expansionsRemaining ?? '?'} left` +
    (data.stoppedReason ? `  ⚠️ STOPPED: ${data.stoppedReason}${data.error ? ` (${data.error})` : ''}` : '')
  )

  if (data.stoppedReason) {
    console.error('\n  Run stopped early — nothing in flight was marked done, so a re-run resumes cleanly.')
    if (data.stoppedReason === 'scrydex_402') {
      console.error('  402 = the Scrydex plan is not serving this key. Account matter, not code.')
    }
    if (data.stoppedReason === 'credit_guard') {
      console.error('  The monthly credit guard tripped. Check Admin → Scrydex before re-running.')
    }
    break
  }
  if (!data.hasMore) break
}

console.log(
  `\n  DONE — ${totals.expansions} expansions · ${totals.cards} cards · ${totals.products} products · ` +
  `${totals.rows} attribute rows · ${totals.unmatched} unmatched · ${totals.credits} credits over ${totals.calls} call(s)\n`
)
