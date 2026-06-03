/**
 * Scrydex Webhook Processor
 *
 * Runs every 10 minutes via cron — picks up pending scrydex_webhook_log rows
 * and fetches updated prices from the Scrydex API.
 *
 * Credit-control measures (added after June 2026 credit archaeology):
 *
 *   1. FRESHNESS WINDOW (SCRYDEX_PRICE_FRESHNESS_HOURS, default 20h)
 *      Before fetching prices for an expansion, checks whether scrydex_prices
 *      already has rows for that expansion+priceType updated within the window.
 *      If fresh, the webhook is marked complete without an API call.
 *      This eliminates the 5-6x/day redundant MTG fetches that were burning
 *      ~390 credits/day for 68 sets.
 *
 *   2. GAME FILTER (SCRYDEX_PRICE_GAMES env var, optional)
 *      Comma-separated list of game slugs to actually process, e.g.
 *        SCRYDEX_PRICE_GAMES=pokemon,onepiece,gundam,lorcana,riftbound
 *      Webhooks for other games (e.g. magicthegathering) are immediately
 *      completed with prices_upserted=0 and a 'game-filtered' note.
 *      Unset → all games are processed.
 *
 * Price matching strategy (in priority order):
 *   1. variant.marketplaces[tcgplayer].product_id → tcg_products.tcgplayer_product_id
 *   2. Fallback: card.number + expansion skrydex_set_id join
 *      (uses tcgplayer_group_id, NOT the non-existent set_id column)
 *
 * Variant handling:
 *   One Piece + Gundam: each variant has a unique TCGPlayer product_id + own images
 *   All others (Pokemon, MTG, Lorcana, Riftbound): variants share a product_id
 *
 * Price condition format:
 *   'NM'             — standard near-mint
 *   'NM (foil)'      — foil variant
 *   'NM (altArt)'    — alternate art variant
 */

import type { Env } from './worker.js'
import { scrydexFetch, ScrydexCreditLimitError } from './lib/scrydexClient.js'

const SLUG_TO_GAME: Record<string, string> = {
  pokemon:           'Pokemon',
  magicthegathering: 'Magic',
  onepiece:          'One Piece Card Game',
  gundam:            'Gundam Card Game',
  lorcana:           'Lorcana',
  riftbound:         'Riftbound',
}

const BATCH_SIZE          = 100
const PENDING_FETCH_LIMIT = 50  // increased from 20; deduplication makes each run cheaper

// ─── Freshness check ─────────────────────────────────────────────────────────

/**
 * Returns true when scrydex_prices already has at least one row for this
 * expansion + priceType that was written within maxAgeSeconds.
 * Relies on idx_scrydex_prices_expansion (migration 0042) for fast lookup.
 */
async function isExpansionFresh(
  db:            D1Database,
  expansionId:   string,
  priceType:     string,
  maxAgeSeconds: number,
): Promise<boolean> {
  const row = await db.prepare(`
    SELECT 1 FROM scrydex_prices
    WHERE  source_expansion_id = ?
    AND    price_type          = ?
    AND    last_updated        > unixepoch() - ?
    LIMIT 1
  `).bind(expansionId, priceType, maxAgeSeconds).first<{ 1: number }>()
  return row !== null
}

// ─── Main processor ───────────────────────────────────────────────────────────

export async function processPendingWebhooks(env: Env): Promise<void> {
  // ── Config ──────────────────────────────────────────────────────────────────
  const freshnessHours = env.SCRYDEX_PRICE_FRESHNESS_HOURS
    ? parseInt(env.SCRYDEX_PRICE_FRESHNESS_HOURS, 10)
    : 20                              // default: don't re-fetch within 20 h
  const freshnessSeconds = freshnessHours * 3600

  // Optional allowlist — only process these game slugs; skip all others.
  // Unset → process everything.
  const gameFilter: Set<string> | null = env.SCRYDEX_PRICE_GAMES
    ? new Set(env.SCRYDEX_PRICE_GAMES.split(',').map(s => s.trim()).filter(Boolean))
    : null

  // ── Fetch pending rows ───────────────────────────────────────────────────────
  const pending = await env.DB.prepare(`
    SELECT id, event_name, expansion_ids_json
    FROM   scrydex_webhook_log
    WHERE  status = 'pending'
    ORDER BY received_at ASC
    LIMIT ${PENDING_FETCH_LIMIT}
  `).all()

  if (!pending.results.length) return

  console.log(`[ScrydexProcessor] ${pending.results.length} pending webhook(s) ` +
    `(freshness=${freshnessHours}h, gameFilter=${gameFilter ? [...gameFilter].join(',') : 'all'})`)

  for (const row of pending.results) {
    await env.DB.prepare(
      "UPDATE scrydex_webhook_log SET status = 'processing' WHERE id = ?"
    ).bind(row.id).run()

    try {
      const expansionIds: string[] = JSON.parse(row.expansion_ids_json as string)
      const eventName   = row.event_name as string
      const gameSlug    = eventName.split('.')[0]
      const priceType   = eventName.includes('graded') ? 'graded' : 'raw'
      const gameName    = SLUG_TO_GAME[gameSlug] ?? gameSlug

      // ── Game filter ─────────────────────────────────────────────────────────
      if (gameFilter && !gameFilter.has(gameSlug)) {
        await env.DB.prepare(`
          UPDATE scrydex_webhook_log SET
            status          = 'complete',
            prices_upserted = 0,
            credits_used    = 0,
            completed_at    = unixepoch()
          WHERE id = ?
        `).bind(row.id).run()
        console.log(`[ScrydexProcessor] ${eventName}: skipped (game-filtered)`)
        continue
      }

      let pricesUpserted = 0
      let creditsUsed    = 0
      let skippedFresh   = 0

      for (const expansionId of expansionIds) {
        // ── Freshness check ────────────────────────────────────────────────────
        const fresh = await isExpansionFresh(env.DB, expansionId, priceType, freshnessSeconds)
        if (fresh) {
          skippedFresh++
          continue
        }

        try {
          const cards = await fetchExpansionCards(env, gameSlug, expansionId, true)
          creditsUsed++

          const allUpserts: D1PreparedStatement[] = []
          for (const card of cards) {
            const upserts = await buildPriceUpserts(
              env.DB, card, gameName, expansionId, priceType
            )
            allUpserts.push(...upserts)
          }

          // Batch writes in chunks of 100
          for (let i = 0; i < allUpserts.length; i += BATCH_SIZE) {
            await env.DB.batch(allUpserts.slice(i, i + BATCH_SIZE))
          }
          pricesUpserted += allUpserts.length

          await new Promise(r => setTimeout(r, 100))
        } catch (err) {
          if (err instanceof ScrydexCreditLimitError) {
            console.warn('[ScrydexProcessor] Credit limit guard triggered — stopping expansion processing')
            break
          }
          console.error(`[ScrydexProcessor] Expansion ${expansionId}:`, err)
        }
      }

      await env.DB.prepare(`
        UPDATE scrydex_webhook_log SET
          status          = 'complete',
          prices_upserted = ?,
          credits_used    = ?,
          completed_at    = unixepoch()
        WHERE id = ?
      `).bind(pricesUpserted, creditsUsed, row.id).run()

      console.log(
        `[ScrydexProcessor] ${eventName}:`,
        `${expansionIds.length} expansions (${skippedFresh} fresh-skipped),`,
        `${pricesUpserted} prices, ${creditsUsed} credits`
      )
    } catch (err) {
      console.error(`[ScrydexProcessor] Fatal on row ${row.id}:`, err)
      await env.DB.prepare(`
        UPDATE scrydex_webhook_log SET
          status        = 'error',
          error_message = ?,
          completed_at  = unixepoch()
        WHERE id = ?
      `).bind((err as Error).message, row.id).run()
    }
  }
}

// ─── Scrydex API ──────────────────────────────────────────────────────────────

async function fetchExpansionCards(
  env:           Env,
  gameSlug:      string,
  expansionId:   string,
  includePrices: boolean,
): Promise<unknown[]> {
  const params: Record<string, string> = {
    expansion: expansionId,
    limit:     '500',
  }
  if (includePrices) params.include = 'prices'

  const res = await scrydexFetch(env, `/${gameSlug}/v1/cards`, 'processPendingWebhooks', { params })
  if (res.status === 429) throw new Error('Scrydex rate limit')
  if (!res.ok) throw new Error(`Scrydex ${res.status} for ${gameSlug}/${expansionId}`)
  const data = await res.json() as { data?: unknown[] }
  return data.data ?? []
}

// ─── Price upsert building ────────────────────────────────────────────────────

async function buildPriceUpserts(
  db:          D1Database,
  card:        unknown,
  gameName:    string,
  expansionId: string,
  priceType:   string,
): Promise<D1PreparedStatement[]> {
  const c = card as any
  const upserts: D1PreparedStatement[] = []
  const variants: any[] = c.variants ?? []

  for (const variant of variants) {
    // Primary match: TCGPlayer product_id from marketplace data
    const tcgMarket    = (variant.marketplaces ?? []).find((m: any) => m.name === 'tcgplayer')
    const tcgProductId = tcgMarket?.product_id ? parseInt(tcgMarket.product_id, 10) : null

    let product: { id: number } | null = null

    if (tcgProductId) {
      product = await db.prepare(
        'SELECT id FROM tcg_products WHERE tcgplayer_product_id = ? LIMIT 1'
      ).bind(tcgProductId).first() as { id: number } | null
    }

    // Fallback: card number + skrydex_set_id expansion join
    // NOTE: join on tcgplayer_group_id — tcg_products has NO set_id column
    if (!product) {
      product = await db.prepare(`
        SELECT p.id
        FROM   tcg_products p
        JOIN   tcg_sets s ON p.tcgplayer_group_id = s.tcgplayer_group_id
        WHERE  LOWER(p.card_number) = LOWER(?)
        AND    LOWER(s.skrydex_set_id) = LOWER(?)
        LIMIT 1
      `).bind(c.number ?? '', expansionId).first() as { id: number } | null
    }

    if (!product) continue

    const variantName: string  = variant.name ?? 'normal'
    const variantPrices: any[] = variant.prices ?? []

    for (const price of variantPrices) {
      if (price.type !== priceType) continue

      // Condition format: 'NM', 'NM (foil)', 'NM (altArt)'
      const condition = variantName === 'normal'
        ? price.condition
        : `${price.condition} (${variantName})`

      upserts.push(
        db.prepare(`
          INSERT INTO scrydex_prices
            (tcg_product_id, price_type, condition, is_foil,
             currency, low_price, market_price, trends_json,
             game, source_expansion_id, last_updated)
          VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, unixepoch())
          ON CONFLICT(tcg_product_id, price_type, condition, is_foil, currency)
          DO UPDATE SET
            low_price           = excluded.low_price,
            market_price        = excluded.market_price,
            trends_json         = excluded.trends_json,
            source_expansion_id = excluded.source_expansion_id,
            last_updated        = excluded.last_updated
        `).bind(
          product.id,
          priceType,
          condition,
          price.currency ?? 'USD',
          price.low      ?? null,
          price.market   ?? null,
          price.trends   ? JSON.stringify(price.trends) : null,
          gameName,
          expansionId,
        )
      )
    }
  }

  return upserts
}
