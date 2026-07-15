/**
 * Admin-triggered PC-console mint job (2026-07-15, DIAGNOSTIC_DON_AND_GEMPACK B).
 *
 * Some PriceCharting consoles have NO possible TCGCSV canonical counterpart — the archetype is
 * the five Chinese-exclusive Pokémon "Gem Pack" sets (CBB1C–CBB5C, 796 map rows, 100% unmatched,
 * all tcg_id NULL: TCGplayer has no Simplified-Chinese Pokémon category). Their rows land
 * unmatched by DESIGN, so search/pricing can never light up until canonical rows exist.
 *
 * This job MINTS the canonical rows from the console's unmatched `pricecharting_products` rows:
 *   - ONE `sets` row per console (game_id = the canonical game spine row; name from the PC
 *     console name unless overridden; `code` from the operator-supplied set code where known;
 *     NO tcgplayer_group_id — nullable by schema, SQLite UNIQUE permits multiple NULLs).
 *   - One `products` row per unmatched map row: name + number parsed from the PC product_name
 *     ("Gengar #307" → name 'Gengar', number '307'); genre-flagged sealed rows and
 *     Booster Box/Pack–shaped names → product_kind='sealed'; everything else 'card'.
 *     NO tcgplayer_product_id, NO scrydex_card_id.
 *   - Stamps `pricecharting_products.canonical_product_id` (+ match_method='minted',
 *     matched_at) so the NEXT daily PROCESS pass writes `prices` rows
 *     (source='pricecharting', loose + graded) with ZERO write-path changes — the matcher
 *     skips already-stamped rows (see pricechartingIngest.ts loadExistingMatches), so the two
 *     mechanisms can never fight.
 *
 * DELIBERATE CARVE-OUT: the mint writes NO `product_images` row. PriceCharting provides no card
 * images and there is no TCGplayer/Scrydex id to construct one from — minted products render the
 * gated no-image placeholder until an admin uploads art via the Content per-product image upload
 * (POST /api/admin/products/:productId/image). This is a documented exception to the
 * "every product-creating ingest path MUST write a product_images.source_url row" rule
 * (Content/CLAUDE.md → Images & uploads).
 *
 * IDEMPOTENT: re-running for the same console never duplicates — the set upserts by
 * (game_id, name), products upsert by (set_id, name, number), and only still-unmatched map rows
 * are stamped. Generalizable: nothing Gem-Pack-specific is hardcoded; the operator supplies the
 * console → game/code mapping per call (the one-piece/yugioh unmatched pools have the same shape
 * and are future candidates).
 *
 * ROLLBACK: delete the minted product/set ids and NULL the stamped rows — the returned
 * `setId`/`productIds` ranges are captured in the session handoff for exactly this purpose.
 */

import type { Env } from './worker.js'
import { logger } from './ingestion/logger.js'

/** PC game_category → TCGplayer category id, for resolving the canonical game spine row.
 * (Deliberately mirrors pricechartingIngest.ts CATEGORY_TCGPLAYER_IDS — one id per category.) */
const CATEGORY_TO_TCGPLAYER_ID: Record<string, number> = {
  'pokemon-cards':   3,
  'magic-cards':     1,
  'yugioh-cards':    2,
  'one-piece-cards': 68,
}

const DB_CHUNK = 90   // statements per DB.batch() (D1 caps bound params at 100/statement)

export interface MintPcConsoleInput {
  gameCategory: string          // PC category the console lives in, e.g. 'pokemon-cards'
  consoleName:  string          // exact pricecharting_products.console_name, e.g. 'Pokemon Chinese Gem Pack'
  setCode?:     string | null   // operator-supplied set code where known, e.g. 'CBB1C'
  setName?:     string | null   // optional override; defaults to the PC console name
}

export interface MintPcConsoleResult {
  ok:               boolean
  error?:           string
  gameCategory?:    string
  consoleName?:     string
  setId?:           number
  setCreated?:      boolean
  unmatchedRows?:   number
  productsCreated?: number
  productsExisting?: number
  sealed?:          number
  stamped?:         number
  skipped?:         number      // rows whose product_name parsed to an empty name (never expected)
  productIds?:      { min: number; max: number } | null   // minted-set product id range (rollback aid)
}

/** Parse a PC product_name into { name, number }: a trailing/embedded `#NNN` token becomes the
 * card number ("Gengar #307" → { name: 'Gengar', number: '307' }); no token → number null. PURE. */
export function parsePcProductName(productName: string): { name: string; number: string | null } {
  const raw = String(productName ?? '').trim()
  const m = raw.match(/#([A-Za-z0-9][\w./-]*)/)
  if (!m) return { name: raw, number: null }
  const name = (raw.slice(0, m.index) + raw.slice((m.index ?? 0) + m[0].length))
    .replace(/\s{2,}/g, ' ').trim()
  return { name, number: m[1] }
}

/** Sealed classification for a mint row: the map's genre-derived is_sealed flag, plus
 * Booster Box/Pack–shaped names as a belt-and-braces (PC occasionally leaves genre blank). PURE. */
export function isSealedMintRow(row: { product_name?: string | null; is_sealed?: number | null }): boolean {
  if (row.is_sealed === 1) return true
  return /\bbooster\s+(box|pack)\b/i.test(String(row.product_name ?? ''))
}

export async function mintPcConsole(env: Env, input: MintPcConsoleInput): Promise<MintPcConsoleResult> {
  const gameCategory = String(input.gameCategory ?? '').trim()
  const consoleName  = String(input.consoleName ?? '').trim()
  const setCode      = input.setCode?.trim() || null
  const setName      = input.setName?.trim() || consoleName

  const tcgplayerCategoryId = CATEGORY_TO_TCGPLAYER_ID[gameCategory]
  if (!tcgplayerCategoryId) {
    return { ok: false, error: `gameCategory must be one of ${Object.keys(CATEGORY_TO_TCGPLAYER_ID).join(', ')}` }
  }
  if (!consoleName) return { ok: false, error: 'consoleName is required' }

  // ── Canonical game spine row (the REAL canonical game — Pokémon here for Gem Packs) ──
  const game = await env.DB.prepare(
    'SELECT id FROM canonical_games WHERE tcgplayer_category_id = ?',
  ).bind(tcgplayerCategoryId).first<{ id: number }>()
  if (!game) return { ok: false, error: `No canonical_games row for category ${gameCategory}` }

  // ── The console's still-unmatched map rows (the mint source) ──
  const { results: unmatched } = await env.DB.prepare(
    `SELECT pc_id, product_name, is_sealed FROM pricecharting_products
     WHERE game_category = ? AND console_name = ? AND canonical_product_id IS NULL
     ORDER BY pc_id`,
  ).bind(gameCategory, consoleName).all<{ pc_id: string; product_name: string | null; is_sealed: number | null }>()
  const rows = unmatched ?? []

  // ── Mint (or reuse) the ONE set row — upsert by (game_id, name) for idempotency ──
  let setCreated = false
  let setRow = await env.DB.prepare(
    'SELECT id FROM sets WHERE game_id = ? AND name = ?',
  ).bind(game.id, setName).first<{ id: number }>()
  if (!setRow) {
    // A pure re-run with nothing left to do must not mint an empty set.
    if (rows.length === 0) {
      return { ok: true, gameCategory, consoleName, unmatchedRows: 0, productsCreated: 0,
               productsExisting: 0, sealed: 0, stamped: 0, skipped: 0, setCreated: false, productIds: null }
    }
    await env.DB.prepare(
      'INSERT INTO sets (game_id, name, code) VALUES (?, ?, ?)',
    ).bind(game.id, setName, setCode).run()
    setRow = await env.DB.prepare(
      'SELECT id FROM sets WHERE game_id = ? AND name = ?',
    ).bind(game.id, setName).first<{ id: number }>()
    setCreated = true
  }
  if (!setRow) return { ok: false, error: 'Failed to mint the set row' }
  const setId = setRow.id

  // ── Existing products in the minted set (idempotency key: name + number) ──
  const keyOf = (name: string, number: string | null) => `${name.toLowerCase()}|${(number ?? '').toLowerCase()}`
  const loadExisting = async () => {
    const map = new Map<string, number>()
    const { results } = await env.DB.prepare(
      "SELECT id, name, COALESCE(number, '') AS number FROM products WHERE set_id = ?",
    ).bind(setId).all<{ id: number; name: string; number: string }>()
    for (const p of results ?? []) map.set(keyOf(p.name, p.number || null), p.id)
    return map
  }
  let existing = await loadExisting()
  const productsExisting = existing.size

  // ── Parse + insert the missing products (no external ids, no product_images — see header) ──
  let sealed = 0, skipped = 0
  const wanted = new Map<string, { name: string; number: string | null; kind: 'card' | 'sealed' }>()
  const rowKey = new Map<string, string>()   // pc_id → product key (for stamping)
  for (const r of rows) {
    const { name, number } = parsePcProductName(r.product_name ?? '')
    if (!name) { skipped++; continue }
    const kind = isSealedMintRow(r) ? 'sealed' : 'card'
    const k = keyOf(name, number)
    if (!wanted.has(k)) wanted.set(k, { name, number, kind })
    rowKey.set(r.pc_id, k)
  }
  const toInsert = [...wanted.entries()].filter(([k]) => !existing.has(k)).map(([, v]) => v)
  sealed = toInsert.filter((v) => v.kind === 'sealed').length

  const insertStmts = toInsert.map((v) =>
    env.DB.prepare(
      'INSERT INTO products (set_id, name, number, rarity, product_kind) VALUES (?, ?, ?, NULL, ?)',
    ).bind(setId, v.name, v.number, v.kind),
  )
  for (let i = 0; i < insertStmts.length; i += DB_CHUNK) {
    await env.DB.batch(insertStmts.slice(i, i + DB_CHUNK))
  }
  if (toInsert.length > 0) existing = await loadExisting()

  // ── Stamp the map rows → the next daily PROCESS pass prices them (zero write-path changes) ──
  const stampStmts: D1PreparedStatement[] = []
  for (const r of rows) {
    const k = rowKey.get(r.pc_id)
    const productId = k ? existing.get(k) : undefined
    if (productId == null) continue
    stampStmts.push(env.DB.prepare(
      `UPDATE pricecharting_products
       SET canonical_product_id = ?, match_method = 'minted', matched_at = unixepoch()
       WHERE pc_id = ? AND canonical_product_id IS NULL`,
    ).bind(productId, r.pc_id))
  }
  for (let i = 0; i < stampStmts.length; i += DB_CHUNK) {
    await env.DB.batch(stampStmts.slice(i, i + DB_CHUNK))
  }

  // Rollback aid: the minted set's product id range (captured in the handoff).
  const range = await env.DB.prepare(
    'SELECT MIN(id) AS min, MAX(id) AS max FROM products WHERE set_id = ?',
  ).bind(setId).first<{ min: number | null; max: number | null }>()

  const result: MintPcConsoleResult = {
    ok: true, gameCategory, consoleName, setId, setCreated,
    unmatchedRows: rows.length,
    productsCreated: toInsert.length,
    productsExisting,
    sealed,
    stamped: stampStmts.length,
    skipped,
    productIds: range?.min != null && range?.max != null ? { min: range.min, max: range.max } : null,
  }
  logger.info('mint_pc_console', result as unknown as Record<string, unknown>)
  return result
}
