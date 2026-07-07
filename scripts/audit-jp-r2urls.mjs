#!/usr/bin/env node
/**
 * audit-jp-r2urls.mjs — OPERATOR-GATED ad-hoc audit of the suspect Pokemon Japan r2_urls.
 *
 * WP-3 (audit IMG-6): before the 2026-07 fixes, the mirror's isPokemon() matched
 * 'Pokemon Japan' and constructed ENGLISH-set Scrydex URLs for Japanese cards, and the
 * set-mapping `%pokemon%` LIKE leaked English scrydex_expansion_ids onto 44 JP sets.
 * ~313 JP products carry an r2_url that very likely mirrored the ENGLISH printing's art
 * (wrong image — worse than none: the app serves r2_url over source_url).
 *
 * This script LISTS those rows so the operator can eyeball a sample, and can OPTIONALLY
 * clear their r2_url/mirrored_at/source pointers so the rows fall back to their
 * TCGPlayer source_url (correct JP art via the client fallback chain).
 *
 * It never deletes R2 objects (the cards/{id}.{ext} keys stay, unreferenced — a JP
 * product's key would be REUSED with correct art only if a JP mirror path ever ships).
 *
 * USAGE (from Ingestion/ — wrangler resolves the shared D1 by name; DRY-RUN IS DEFAULT):
 *   node scripts/audit-jp-r2urls.mjs                      # list suspect rows (UAT db, dry-run)
 *   node scripts/audit-jp-r2urls.mjs --db sleevedpagesdb  # list against PROD (dry-run)
 *   node scripts/audit-jp-r2urls.mjs --db sleevedpagesdb --apply   # CLEAR the pointers (writes!)
 *
 * --apply is the ONLY write path; without it the script issues read-only SELECTs.
 * Standing order applies: run against sleevedpagesdb-uat first, then sleevedpagesdb.
 * (UAT has no Pokemon Japan catalogue, so the UAT pass just proves the query shape.)
 */

import { execFileSync } from 'node:child_process'
import process from 'node:process'

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const dbFlag = args.indexOf('--db')
const DB = dbFlag !== -1 ? args[dbFlag + 1] : 'sleevedpagesdb-uat'

if (!DB || DB.startsWith('--')) {
  console.error('Bad --db value. Use --db sleevedpagesdb-uat or --db sleevedpagesdb')
  process.exit(1)
}

// The suspect set: Pokemon Japan products whose product_images row points at R2.
// (Everything mirrored for JP before the WP-3 fix rode the English URL scheme.)
const SUSPECT_WHERE = `
  product_images.product_id IN (
    SELECT p.id
    FROM   products p
    JOIN   sets            s ON s.id = p.set_id
    JOIN   canonical_games g ON g.id = s.game_id
    WHERE  g.name = 'Pokemon Japan'
  )
  AND product_images.r2_url IS NOT NULL`.replace(/\s+/g, ' ').trim()

function d1(sql) {
  const out = execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' },
  )
  const parsed = JSON.parse(out)
  return parsed[0] ?? parsed
}

console.log(`[audit-jp-r2urls] database: ${DB}  mode: ${APPLY ? 'APPLY (will write!)' : 'dry-run (read-only)'}`)

// 1) Count + list the suspect rows (always — both modes lead with the evidence).
const countRes = d1(`SELECT COUNT(*) AS suspect FROM product_images WHERE ${SUSPECT_WHERE}`)
const suspect = countRes.results?.[0]?.suspect ?? 0
console.log(`[audit-jp-r2urls] suspect Pokemon Japan r2_url rows: ${suspect}`)

if (suspect === 0) {
  console.log('[audit-jp-r2urls] nothing to do.')
  process.exit(0)
}

const listRes = d1(`
  SELECT p.tcgplayer_product_id, p.name, p.number, s.name AS set_name,
         product_images.r2_url, product_images.source_url, product_images.mirrored_at
  FROM   product_images
  JOIN   products p ON p.id = product_images.product_id
  JOIN   sets     s ON s.id = p.set_id
  WHERE  ${SUSPECT_WHERE}
  ORDER  BY p.tcgplayer_product_id
  LIMIT  1000`.replace(/\s+/g, ' ').trim())

for (const row of listRes.results ?? []) {
  console.log(
    `  #${row.tcgplayer_product_id}  ${row.set_name} · ${row.number ?? '—'} · ${row.name}\n` +
    `      r2:  ${row.r2_url}  (mirrored ${row.mirrored_at ?? '—'})\n` +
    `      src: ${row.source_url ?? '—'}`
  )
}
console.log(`[audit-jp-r2urls] listed ${(listRes.results ?? []).length} of ${suspect} rows.`)
console.log('[audit-jp-r2urls] eyeball a sample of the r2 URLs in a browser — English art on a JP card confirms the bug.')

if (!APPLY) {
  console.log('[audit-jp-r2urls] DRY RUN — no writes. Re-run with --apply to clear the pointers.')
  process.exit(0)
}

// 2) APPLY: clear r2_url + mirrored_at + source so the rows fall back to source_url.
// source is reset to NULL as well — these rows were stamped source='scrydex' by the
// buggy mirror; leaving that would (a) lie about provenance and (b) matter to the
// mirror-eligibility predicate. With WP-2/WP-3 live, JP rows are excluded from the
// candidate pool anyway (not English Pokémon, tcgplayer-cdn source_url), so cleared
// rows stay CDN-served and are NOT re-mirrored with wrong art.
const updateRes = d1(
  `UPDATE product_images SET r2_url = NULL, mirrored_at = NULL, source = NULL WHERE ${SUSPECT_WHERE}`
)
const changed = updateRes.meta?.changes ?? '?'
console.log(`[audit-jp-r2urls] cleared ${changed} rows (r2_url/mirrored_at/source → NULL).`)
console.log('[audit-jp-r2urls] R2 objects were NOT deleted (unreferenced keys are harmless).')
