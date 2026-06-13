/**
 * backfillR2Urls.ts
 *
 * One-time admin-triggered backfill: for every tcg_products row whose image_url
 * still points at a non-R2 source (TCGPlayer, Scrydex CDN, etc.), checks whether
 * a mirrored copy already exists in the R2 bucket and, if so, updates image_url
 * to the canonical R2 public URL.
 *
 * Records with no matching R2 object are left unchanged — TCGPlayer remains the
 * de-facto fallback for those cards until a future mirror run covers them.
 *
 * Called by: POST /admin/backfill-r2-urls (x-worker-secret required)
 */

import type { Env } from './worker.js'
import { uploadCardImage } from './image-mirror.js'
import { r2ImageUpsert, sourceUrlUpsertByProductId } from './lib/productImages.js'
import { ScrydexCreditLimitError } from './lib/scrydexClient.js'
import { fetchAllExpansionCards, ScrydexCardsError } from './lib/scrydexCards.js'
import {
  collectVariantEntries,
  fetchExistingProducts,
  planVariantWrites,
  variantFinish,
  type VariantEntry,
} from './lib/variantCapture.js'

const R2_PUBLIC_BASE = 'https://images.sleevedpages.com'
const EXTENSIONS     = ['jpg', 'png', 'webp'] as const
const CONCURRENCY    = 20

// Games where each TCGPlayer product row is a distinct variant with its own image
const VARIANT_IMAGE_CATEGORY_NAMES = ['One Piece Card Game', 'Gundam Card Game']

const GAME_SLUG_BY_CATEGORY_NAME: Record<string, string> = {
  'One Piece Card Game': 'onepiece',
  'Gundam Card Game':    'gundam',
}

interface ProductRow {
  tcgplayer_product_id: number
  category_name:        string
}

export interface GameSummary {
  game:    string
  checked: number
  updated: number
  skipped: number
}

export interface BackfillResult {
  totalChecked: number
  totalUpdated: number
  totalSkipped: number
  games:        GameSummary[]
}

export async function backfillR2ImageUrls(env: Env): Promise<BackfillResult> {
  // Canonical (Session D): products without an R2 image yet (no product_images row,
  // or a row with r2_url NULL). For each we probe R2 by tcgplayer_product_id and, if
  // a mirrored object exists, record its r2_url (preserving any existing source).
  const { results } = await env.DB.prepare(`
    SELECT
      p.tcgplayer_product_id,
      g.name AS category_name
    FROM  products        p
    JOIN  sets            s ON s.id = p.set_id
    JOIN  canonical_games g ON g.id = s.game_id
    LEFT JOIN product_images pi ON pi.product_id = p.id
    WHERE pi.r2_url IS NULL
  `).all<ProductRow>()

  const rows      = results ?? []
  const gameStats = new Map<string, GameSummary>()
  const toUpdate: { tcgProductId: number; url: string }[] = []

  // Check R2 existence concurrently in chunks of CONCURRENCY
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const chunk = rows.slice(i, i + CONCURRENCY)

    const resolved = await Promise.all(chunk.map(async (row) => {
      for (const ext of EXTENSIONS) {
        const key = `cards/${row.tcgplayer_product_id}.${ext}`
        const obj = await env.IMAGES_BUCKET.head(key)
        if (obj) {
          return { row, url: `${R2_PUBLIC_BASE}/${key}` }
        }
      }
      return { row, url: null }
    }))

    for (const { row, url } of resolved) {
      const game = row.category_name
      if (!gameStats.has(game)) {
        gameStats.set(game, { game, checked: 0, updated: 0, skipped: 0 })
      }
      const stats = gameStats.get(game)!
      stats.checked++
      if (url) {
        toUpdate.push({ tcgProductId: row.tcgplayer_product_id, url })
        stats.updated++
      } else {
        stats.skipped++
      }
    }
  }

  // Batch-write product_images upserts (100 statements per D1 batch). Source is
  // unknown for a generic R2 backfill, so it is preserved (only r2_url/mirrored_at set).
  if (toUpdate.length > 0) {
    const statements = toUpdate.map(({ tcgProductId, url }) =>
      r2ImageUpsert(env.DB, tcgProductId, url, null)
    )
    for (let i = 0; i < statements.length; i += 100) {
      await env.DB.batch(statements.slice(i, i + 100))
    }
  }

  const games = [...gameStats.values()].sort((a, b) => b.updated - a.updated)

  console.log('[BackfillR2] Complete')
  console.log(`  Total checked : ${rows.length}`)
  console.log(`  Total updated : ${toUpdate.length}`)
  console.log(`  Total skipped : ${rows.length - toUpdate.length}  (no R2 copy found)`)
  for (const g of games) {
    console.log(`  ${g.game}: checked=${g.checked} updated=${g.updated} skipped=${g.skipped}`)
  }

  return {
    totalChecked: rows.length,
    totalUpdated: toUpdate.length,
    totalSkipped: rows.length - toUpdate.length,
    games,
  }
}

// ─── Variant product seeding ─────────────────────────────────────────────────

export interface SeedVariantResult {
  inserted:   number
  skipped:    number
  conflicted: number
}

// Canonical seed upsert: mint a per-variant products row (or fill structured fields on
// an existing one). Preserve-on-conflict — name/number/rarity/set_id are NOT clobbered,
// and the structured fields COALESCE so a populated value is never nulled.
const SEED_INSERT_SQL = `
  INSERT INTO products
    (tcgplayer_product_id, set_id, name, number, rarity, product_kind,
     variant_kind, finish, scrydex_card_id)
  VALUES (?, ?, ?, ?, ?, 'card', ?, ?, ?)
  ON CONFLICT (tcgplayer_product_id) DO UPDATE SET
    variant_kind    = COALESCE(excluded.variant_kind, products.variant_kind),
    finish          = COALESCE(excluded.finish, products.finish),
    scrydex_card_id = COALESCE(excluded.scrydex_card_id, products.scrydex_card_id)`

interface BaseRow { set_id: number; name: string; number: string | null; rarity: string | null }

/**
 * Batch-resolve base product rows by printed card code, GAME-WIDE, in ONE query per 90
 * keys. Returns a map keyed on LOWER(products.number) (the full printed code is globally
 * unique within a game, e.g. 'GD04-001'). Callers look up by `card.id` (the full printed
 * code) first, then `card.number`. Game-wide (not group-scoped) so a single fetch of a
 * shared expansion resolves every card to its real set — no per-set re-iteration.
 */
async function fetchBasesByNumber(
  db:     D1Database,
  gameId: number,
  keys:   string[],
): Promise<Map<string, BaseRow>> {
  const map = new Map<string, BaseRow>()
  const uniq = [...new Set(keys.map(k => k.toLowerCase()))]
  // D1 caps bound parameters at 100 per statement; this query also binds gameId (+1).
  for (let i = 0; i < uniq.length; i += 90) {
    const chunk = uniq.slice(i, i + 90)
    const placeholders = chunk.map(() => '?').join(',')
    const { results } = await db.prepare(`
      SELECT p.number, p.set_id, p.name, p.rarity
      FROM   products p
      JOIN   sets     s ON p.set_id = s.id
      WHERE  s.game_id = ?
      AND    LOWER(p.number) IN (${placeholders})
    `).bind(gameId, ...chunk).all<BaseRow & { number: string }>()
    for (const r of results ?? []) {
      if (r.number) map.set(String(r.number).toLowerCase(), r)
    }
  }
  return map
}

/**
 * Seeds missing alt-art rows in canonical `products` from Scrydex marketplace data.
 *
 * SESSION D-bis: repointed off the frozen tcg_products onto canonical `products` — this
 * is now the LAST tcg_* writer to move, so after this no worker path writes tcg_*.
 *
 * For One Piece and Gundam, TCGCSV only ingests one product row per card number.
 * Scrydex knows each variant's unique tcgplayer_product_id via marketplace data.
 * This function mints the missing per-variant `products` rows (cloned from the base
 * card's set_id/name/number/rarity) AND captures the structured variant fields
 * (scrydex_card_id <- data.id, variant_kind <- variant.name, finish) + the variant's
 * distinct image, so scrydexImageSync / backfillVariantImages can later refine them.
 *
 * The SAME conflict detection as the capture path applies: a seed insert that would
 * collide on tcgplayer_product_id with a DIFFERENT card (cross-product) — or an
 * intra-payload duplicate product_id — routes to variant_ingest_conflicts and does NOT
 * clobber. Preserve-on-conflict for the structured fields (COALESCE — never null a set value).
 *
 * @param env  Worker bindings
 * @param game Optional canonical_games.name filter (e.g. 'One Piece Card Game').
 *             When omitted, all VARIANT_IMAGE_CATEGORY_NAMES games are processed.
 */
export async function seedVariantProducts(env: Env, game?: string): Promise<SeedVariantResult> {
  const result: SeedVariantResult = { inserted: 0, skipped: 0, conflicted: 0 }

  const categoryNames = game ? [game] : VARIANT_IMAGE_CATEGORY_NAMES
  const inClause = categoryNames.map(() => '?').join(', ')

  // Iterate DISTINCT expansions, not distinct sets: many canonical sets share one
  // scrydex_expansion_id (non-unique expansion ids / manual mappings), and base rows are
  // resolved game-wide, so fetching + processing each expansion ONCE covers every set
  // that shares it. (Per-set iteration re-fetched + re-scanned the same data ~80×,
  // wasting credits and blowing the waitUntil budget.)
  const { results: expansions } = await env.DB.prepare(`
    SELECT g.id AS game_id, g.name AS game, s.scrydex_expansion_id AS scrydex_set_id
    FROM   sets            s
    JOIN   canonical_games g ON g.id = s.game_id
    WHERE  s.scrydex_expansion_id IS NOT NULL
    AND    g.name IN (${inClause})
    GROUP  BY g.id, s.scrydex_expansion_id
    ORDER  BY g.name
  `).bind(...categoryNames).all()

  // Resumability: skip expansions already seeded in a prior run (marked in
  // scrydex_expansion_freshness with price_type='seed'). Each expansion is marked AFTER
  // its writes succeed, so a waitUntil-cancelled run loses no progress — just re-run the
  // endpoint until it reports everything skipped. (To force a re-seed, delete the 'seed'
  // rows for those expansions.)
  const { results: seededRows } = await env.DB.prepare(
    "SELECT scrydex_expansion_id FROM scrydex_expansion_freshness WHERE price_type = 'seed'"
  ).all()
  const alreadySeeded = new Set((seededRows ?? []).map((r: any) => String(r.scrydex_expansion_id)))

  outer: for (const exp of (expansions ?? []) as any[]) {
    const gameName = exp.game as string
    const gameSlug = GAME_SLUG_BY_CATEGORY_NAME[gameName]
    if (!gameSlug) continue
    if (alreadySeeded.has(String(exp.scrydex_set_id))) continue

    try {
      const { cards } = await fetchAllExpansionCards(env, gameSlug, exp.scrydex_set_id, 'seedVariantProducts')

      const entries = collectVariantEntries(cards, null)

      // Batch-load base rows GAME-WIDE in one query per 90 keys (keyed on the printed card
      // code). For One Piece / Gundam the printed code (e.g. 'GD04-001') lives in Scrydex
      // `card.id`; `card.number` is the bare form. products.number stores the full code,
      // so we resolve the base by card.id first, then fall back to card.number.
      const baseKeys = entries.flatMap(e => [e.cardId, e.number]).filter((k): k is string => !!k)
      const basesByNumber = await fetchBasesByNumber(env.DB, exp.game_id, baseKeys)
      const lookupBase = (entry: VariantEntry): BaseRow | null =>
        (entry.cardId && basesByNumber.get(entry.cardId.toLowerCase())) ||
        (entry.number && basesByNumber.get(entry.number.toLowerCase())) ||
        null

      // Pre-fetch existing products in ONE query (cross-product collision detection).
      const existing = await fetchExistingProducts(env.DB, entries.map(e => e.tcgProductId))

      const cleanWrite = (entry: VariantEntry): D1PreparedStatement[] => {
        const base = lookupBase(entry)
        if (!base) return []   // no base row to clone from → skip

        const suffix = entry.variantName && entry.variantName !== 'normal'
          ? ` (${entry.variantName})` : ''
        const stmts: D1PreparedStatement[] = [
          env.DB.prepare(SEED_INSERT_SQL).bind(
            entry.tcgProductId,
            base.set_id,
            `${base.name}${suffix}`,
            base.number ?? null,
            base.rarity ?? null,
            entry.variantName,
            variantFinish(entry.variantName),
            entry.cardId,
          ),
        ]
        if (entry.imageUrl) {
          stmts.push(sourceUrlUpsertByProductId(env.DB, entry.tcgProductId, entry.imageUrl, 'scrydex'))
        }
        return stmts
      }

      const plan = planVariantWrites(env.DB, entries, existing, cleanWrite)

      // Batch in chunks of 100. Each card's seed-insert precedes its image upsert in the
      // array, and D1 batches run sequentially, so the product exists before its image
      // upsert's INSERT…SELECT resolves it.
      for (let i = 0; i < plan.statements.length; i += 100) {
        await env.DB.batch(plan.statements.slice(i, i + 100))
      }

      result.inserted   += plan.captured
      result.skipped    += plan.skipped
      result.conflicted += plan.conflicted

      // Mark this expansion seeded so a subsequent run skips it (resumability).
      await env.DB.prepare(`
        INSERT INTO scrydex_expansion_freshness (scrydex_expansion_id, price_type, last_updated)
        VALUES (?, 'seed', unixepoch())
        ON CONFLICT (scrydex_expansion_id, price_type) DO UPDATE SET last_updated = excluded.last_updated
      `).bind(exp.scrydex_set_id).run()

      if (plan.captured > 0 || plan.conflicted > 0) {
        console.log(
          `[SeedVariants] ${exp.game} / ${exp.scrydex_set_id}: seeded=${plan.captured} skipped=${plan.skipped} conflicts=${plan.conflicted}`,
        )
      }

      await new Promise(r => setTimeout(r, 100))   // pace Scrydex between expansions
    } catch (err) {
      if (err instanceof ScrydexCreditLimitError) {
        console.warn('[SeedVariants] Credit limit guard triggered — stopping')
        break outer
      }
      if (err instanceof ScrydexCardsError && err.status === 403) {
        console.error('[SeedVariants] 403 (CREDIT_CAP_HIT) — circuit breaker, stopping run')
        break outer
      }
      console.error(`[SeedVariants] Error on expansion ${exp.scrydex_set_id}:`, err)
    }
  }

  console.log(`[SeedVariants] Complete: seeded=${result.inserted} skipped=${result.skipped} conflicts=${result.conflicted}`)
  return result
}

// ─── Variant image backfill ───────────────────────────────────────────────────

export interface VariantGameSummary {
  game:      string
  processed: number
  corrected: number
  skipped:   number
  failed:    number
}

export interface VariantBackfillResult {
  processed: number
  corrected: number
  skipped:   number
  failed:    number
  byGame:    VariantGameSummary[]
}

/** Fetch image bytes from a URL; returns null on failure or if the result is a placeholder. */
async function fetchVariantImageBytes(url: string): Promise<{ buffer: ArrayBuffer; contentType: string } | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'Referer':    'https://www.tcgplayer.com/',
        'User-Agent': 'Mozilla/5.0 (compatible; SleevedPages/1.0)',
      },
    })
    if (!res.ok) return null
    const contentType = res.headers.get('content-type') ?? 'image/jpeg'
    const buffer = await res.arrayBuffer()
    // Reject only truly empty/broken responses (< 5 KB is not a real card image)
    if (buffer.byteLength < 5_000) return null
    return { buffer, contentType }
  } catch {
    return null
  }
}

/**
 * Re-mirrors variant images for games where each TCGPlayer product has its own image.
 *
 * Queries tcg_products for card_numbers with more than one product row (confirmed variant sets),
 * fetches fresh Scrydex variant data for each expansion, matches each variant to the correct
 * tcg_products row via tcgplayer_product_id, and mirrors the correct image to R2.
 *
 * All Scrydex API calls go through scrydexFetch() — the monthly credit guard is respected.
 *
 * @param env  Worker bindings (DB, IMAGES_BUCKET, SCRYDEX_API_KEY required)
 * @param game Optional tcg_categories.name filter (e.g. 'One Piece Card Game').
 *             When omitted, all VARIANT_IMAGE_CATEGORY_NAMES games are processed.
 */
export async function backfillVariantImages(env: Env, game?: string): Promise<VariantBackfillResult> {
  const result: VariantBackfillResult = { processed: 0, corrected: 0, skipped: 0, failed: 0, byGame: [] }

  // Determine which category names to query
  const categoryNames = game ? [game] : VARIANT_IMAGE_CATEGORY_NAMES

  // Build IN clause — parameterized with individual ? placeholders
  const inClause = categoryNames.map(() => '?').join(', ')

  const { results: sets } = await env.DB.prepare(`
    SELECT s.id, s.name, s.scrydex_expansion_id AS scrydex_set_id, s.tcgplayer_group_id, g.name AS game
    FROM   sets            s
    JOIN   canonical_games g ON g.id = s.game_id
    WHERE  s.scrydex_expansion_id IS NOT NULL
    AND    g.name IN (${inClause})
    ORDER  BY g.name, s.id ASC
  `).bind(...categoryNames).all()

  const gameStats = new Map<string, VariantGameSummary>()

  outer: for (const set of (sets ?? []) as any[]) {
    const gameName = set.game as string
    const gameSlug = GAME_SLUG_BY_CATEGORY_NAME[gameName]
    if (!gameSlug) continue

    if (!gameStats.has(gameName)) {
      gameStats.set(gameName, { game: gameName, processed: 0, corrected: 0, skipped: 0, failed: 0 })
    }
    const stats = gameStats.get(gameName)!

    try {
      const { cards } = await fetchAllExpansionCards(env, gameSlug, set.scrydex_set_id, 'backfillVariantImages')

      let setProcessed = 0, setCorrected = 0, setSkipped = 0, setFailed = 0

      for (const card of cards) {
        for (const variant of (card.variants ?? []) as any[]) {
          const variantImages: any[] = variant.images ?? []
          const frontImage = variantImages.find((i: any) => i.type === 'front')
          const imageUrl   = frontImage?.large ?? frontImage?.medium ?? null
          if (!imageUrl) continue

          const tcgMarket    = (variant.marketplaces ?? []).find((m: any) => m.name === 'tcgplayer')
          const tcgProductId = tcgMarket?.product_id ? parseInt(tcgMarket.product_id, 10) : null
          if (!tcgProductId) {
            setSkipped++
            continue
          }

          // Verify this product exists in canonical `products` before fetching bytes
          const exists = await env.DB.prepare(
            `SELECT tcgplayer_product_id FROM products WHERE tcgplayer_product_id = ?`
          ).bind(tcgProductId).first<{ tcgplayer_product_id: number }>()

          if (!exists) {
            setSkipped++
            continue
          }

          setProcessed++

          const fetched = await fetchVariantImageBytes(imageUrl)
          if (!fetched) {
            setFailed++
            console.warn(`[VariantBackfill] Image fetch failed — product ${tcgProductId}: ${imageUrl}`)
            continue
          }

          try {
            await uploadCardImage(
              { DB: env.DB, IMAGES_BUCKET: env.IMAGES_BUCKET },
              tcgProductId,
              fetched.buffer,
              fetched.contentType,
              'scrydex',
            )
            setCorrected++
          } catch (e) {
            setFailed++
            console.warn(`[VariantBackfill] Upload failed — product ${tcgProductId}:`, e)
          }
        }
      }

      stats.processed += setProcessed
      stats.corrected += setCorrected
      stats.skipped   += setSkipped
      stats.failed    += setFailed
      result.processed += setProcessed
      result.corrected += setCorrected
      result.skipped   += setSkipped
      result.failed    += setFailed

      console.log(
        `[VariantBackfill] ${set.name}:`,
        `processed=${setProcessed} corrected=${setCorrected}`,
        `skipped=${setSkipped} failed=${setFailed}`,
      )

      await new Promise(r => setTimeout(r, 100))
    } catch (err) {
      if (err instanceof ScrydexCreditLimitError) {
        console.warn('[VariantBackfill] Credit limit guard triggered — stopping')
        break outer
      }
      if (err instanceof ScrydexCardsError && err.status === 403) {
        console.error('[VariantBackfill] 403 (CREDIT_CAP_HIT) — circuit breaker, stopping run')
        break outer
      }
      console.error(`[VariantBackfill] Error on ${set.name}:`, err)
    }
  }

  result.byGame = [...gameStats.values()].sort((a, b) => b.corrected - a.corrected)

  console.log('[VariantBackfill] Complete:', JSON.stringify({
    processed: result.processed,
    corrected: result.corrected,
    skipped:   result.skipped,
    failed:    result.failed,
  }))
  for (const g of result.byGame) {
    console.log(`  ${g.game}: processed=${g.processed} corrected=${g.corrected} skipped=${g.skipped} failed=${g.failed}`)
  }

  return result
}
