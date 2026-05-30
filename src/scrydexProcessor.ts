/**
 * Scrydex webhook processor
 *
 * Runs every 10 minutes via cron — polls `scrydex_webhook_log` for pending
 * rows and fetches updated prices from the Scrydex API.
 *
 * Runs in the Ingestion Worker with no timeout budget concerns (unlike the
 * Pages Function waitUntil() which was killed after 30 seconds).
 *
 * Key design decisions vs the original Pages Function implementation:
 * - Product lookup uses a single expansion-based query (3 bind params) instead
 *   of an IN clause, avoiding D1's ~512 SQL variable limit on large MTG sets.
 * - Batch writes are chunked at 100 statements per env.DB.batch() call.
 * - Uses the correct join: p.tcgplayer_group_id = s.tcgplayer_group_id
 *   (tcg_products has no set_id column).
 */

import type { Env } from './worker.js'

const SCRYDEX_BASE = 'https://api.scrydex.com'

const SLUG_TO_GAME: Record<string, string> = {
  pokemon:           'Pokemon',
  magicthegathering: 'Magic',
  onepiece:          'One Piece Card Game',
  gundam:            'Gundam Card Game',
  lorcana:           'Lorcana',
  riftbound:         'Riftbound',
}

const BATCH_SIZE = 100   // max statements per D1 batch call

export async function processPendingWebhooks(env: Env): Promise<void> {
  const pending = await env.DB.prepare(`
    SELECT id, event_name, expansion_ids_json
    FROM   scrydex_webhook_log
    WHERE  status = 'pending'
    ORDER BY received_at ASC
    LIMIT 50
  `).all()

  if (!pending.results.length) return

  console.log(`[ScrydexProcessor] ${pending.results.length} pending webhook(s)`)

  for (const row of pending.results) {
    await env.DB.prepare(
      "UPDATE scrydex_webhook_log SET status = 'processing' WHERE id = ?"
    ).bind(row.id).run()

    try {
      const expansionIds: string[] = JSON.parse(row.expansion_ids_json as string)
      const eventName  = row.event_name as string
      const gameSlug   = eventName.split('.')[0]
      const priceType  = eventName.includes('graded') ? 'graded' : 'raw'
      const gameName   = SLUG_TO_GAME[gameSlug] ?? gameSlug

      let totalPricesUpserted = 0
      let totalCreditsUsed    = 0

      for (const expansionId of expansionIds) {
        try {
          const cards = await fetchExpansionPrices(env, gameSlug, expansionId)
          totalCreditsUsed++

          if (!cards.length) continue

          const upserts = await buildPriceUpserts(
            env.DB, cards, gameName, expansionId, priceType
          )

          if (upserts.length) {
            for (let i = 0; i < upserts.length; i += BATCH_SIZE) {
              await env.DB.batch(upserts.slice(i, i + BATCH_SIZE))
            }
            totalPricesUpserted += upserts.length
          }

          // Be a good API citizen
          await new Promise(r => setTimeout(r, 100))
        } catch (err) {
          console.error(`[ScrydexProcessor] Expansion ${expansionId} failed:`, err)
        }
      }

      await env.DB.prepare(`
        UPDATE scrydex_webhook_log SET
          status          = 'complete',
          prices_upserted = ?,
          credits_used    = ?,
          completed_at    = unixepoch()
        WHERE id = ?
      `).bind(totalPricesUpserted, totalCreditsUsed, row.id).run()

      console.log(
        `[ScrydexProcessor] ${eventName} done:`,
        `${expansionIds.length} expansions, ${totalPricesUpserted} prices, ${totalCreditsUsed} credits`
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

async function fetchExpansionPrices(env: Env, gameSlug: string, expansionId: string) {
  const url = `${SCRYDEX_BASE}/${gameSlug}/v1/cards?expansion=${expansionId}&include=prices&limit=500`
  const res = await fetch(url, {
    headers: {
      'X-Api-Key': env.SCRYDEX_API_KEY!,
      'X-Team-ID': env.SCRYDEX_TEAM_ID!,
      'Accept':    'application/json',
    },
  })
  if (res.status === 429) throw new Error('Scrydex rate limit — back off and retry')
  if (!res.ok) throw new Error(`Scrydex API ${res.status}`)
  const data = await res.json() as { data?: unknown[] }
  return data.data ?? []
}

// ─── Product matching + upsert building ──────────────────────────────────────

async function buildPriceUpserts(
  db:          D1Database,
  scrydexCards: unknown[],
  game:         string,
  expansionId:  string,
  priceType:    string
): Promise<D1PreparedStatement[]> {
  // Fetch ALL products for this expansion in one query — only 3 bind params,
  // no IN clause, no variable-count limit regardless of set size.
  // tcg_products joins to tcg_sets via tcgplayer_group_id (not set_id).
  const { results: expansionProducts } = await db.prepare(`
    SELECT p.id, LOWER(p.card_number) AS cn
    FROM   tcg_products p
    JOIN   tcg_sets s       ON p.tcgplayer_group_id = s.tcgplayer_group_id
    JOIN   tcg_categories c ON s.tcgplayer_category_id = c.tcgplayer_category_id
    WHERE (
      LOWER(s.skrydex_set_id) = LOWER(?)
      OR LOWER(s.abbreviation) = LOWER(?)
    )
    AND LOWER(c.name) LIKE LOWER(?)
  `).bind(
    expansionId,
    expansionId,
    `%${game.split(' ')[0]}%`,
  ).all()

  // card_number (lowercase) → internal tcg_products.id
  const productMap = new Map<string, number>(
    expansionProducts.map((p: any) => [p.cn as string, p.id as number])
  )

  const upserts: D1PreparedStatement[] = []

  for (const card of scrydexCards as any[]) {
    const cardNumber: string = card.number ?? card.card_number ?? ''
    if (!cardNumber) continue

    const productId = productMap.get(cardNumber.toLowerCase())
    if (!productId) continue

    for (const price of (card.prices ?? []) as any[]) {
      upserts.push(
        db.prepare(`
          INSERT INTO scrydex_prices
            (tcg_product_id, scrydex_card_id, price_type, condition, is_foil,
             currency, low_price, market_price, trends_json,
             game, source_expansion_id, last_updated)
          VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, unixepoch())
          ON CONFLICT(tcg_product_id, price_type, condition, is_foil, currency)
          DO UPDATE SET
            low_price           = excluded.low_price,
            market_price        = excluded.market_price,
            trends_json         = excluded.trends_json,
            source_expansion_id = excluded.source_expansion_id,
            last_updated        = excluded.last_updated
        `).bind(
          productId,
          card.id      ?? null,
          priceType,
          price.condition,
          price.currency ?? 'USD',
          price.low      ?? null,
          price.market   ?? null,
          price.trends   ? JSON.stringify(price.trends) : null,
          game,
          expansionId,
        )
      )
    }
  }

  return upserts
}
