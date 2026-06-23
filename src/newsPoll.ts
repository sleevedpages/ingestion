// News poll — fetch the active DotGG WordPress RSS/Atom feeds, extract ONLY headline + link +
// date, and UPSERT into news_items deduped on `link`. LINK-OUT ONLY: article bodies are never
// fetched-for-storage, never stored (see lib/feedParser.ts — it doesn't even read them).
//
// Runs on the prod-only `0 7 * * *` cron AND on demand via POST /admin/run-job { job:'news-poll' }
// (UAT has no news cron, so UAT is populated by the on-demand run). No Scrydex/PriceCharting key
// is needed — these are public RSS feeds.
//
// Be polite + resilient:
//   - a descriptive User-Agent
//   - per-feed isolation: one bad/stale/blocked feed never aborts the run (try/catch per source)
//   - a fetch timeout + ONE retry (the confirmed One Piece feed intermittently 5xx's; the retry
//     plus the daily cadence absorb it)
//   - http(s)-validate the stored feed_url before fetching (defense-in-depth)
//   - prune items older than 90 days each run

import type { Env } from './worker.js'
import { parseFeed } from './lib/feedParser.js'
import { logger } from './ingestion/logger.js'

const FETCH_TIMEOUT_MS = 12_000
const PRUNE_DAYS = 90
const TITLE_MAX = 500
const UA = 'SleevedPagesNewsBot/1.0 (+https://sleevedpages.com; link-out TCG news)'

interface SourceRow {
  id: number
  feed_url: string
  game: string
}

export interface NewsPollResult {
  sources: number
  inserted: number
  failed: number
}

// Fetch a feed body with a timeout and ONE retry. 4xx → give up (a permanent error, no retry);
// network/timeout/5xx → retry once (transient). Returns null on failure (the caller isolates it).
async function fetchFeed(url: string): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        },
        signal: controller.signal,
      })
      if (res.ok) return await res.text()
      if (res.status < 500) return null // 4xx → permanent, do not retry
    } catch {
      // network error / timeout → fall through to one retry
    } finally {
      clearTimeout(timer)
    }
  }
  return null
}

export async function runNewsPoll(env: Env): Promise<NewsPollResult> {
  const { results } = await env.DB.prepare(
    `SELECT id, feed_url, game FROM news_sources WHERE is_active = 1 ORDER BY sort_order ASC`,
  ).all<SourceRow>()
  const sources = results ?? []

  let inserted = 0
  let failed = 0

  for (const src of sources) {
    // http(s)-validate the stored feed_url — never fetch a non-web scheme.
    if (!/^https?:\/\//i.test(src.feed_url)) {
      failed++
      logger.warn('news poll: skipped non-http feed_url', { sourceId: src.id })
      continue
    }
    try {
      const xml = await fetchFeed(src.feed_url)
      if (!xml) {
        failed++
        logger.warn('news poll: feed fetch failed', { feed: src.feed_url })
        continue
      }
      const items = parseFeed(xml)
      if (items.length === 0) continue

      // UPSERT deduped on link (INSERT OR IGNORE → ON CONFLICT(link) DO NOTHING). Batched.
      const stmts = items.map((it) =>
        env.DB.prepare(
          `INSERT OR IGNORE INTO news_items (source_id, title, link, game, published_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).bind(src.id, it.title.slice(0, TITLE_MAX), it.link, src.game, it.publishedAt),
      )
      for (let i = 0; i < stmts.length; i += 50) {
        const batch = await env.DB.batch(stmts.slice(i, i + 50))
        for (const r of batch) inserted += (r.meta?.changes ?? 0)
      }
    } catch (err) {
      failed++
      logger.error('news poll: source failed', { feed: src.feed_url, error: String(err) })
    }
  }

  // Prune items older than 90 days. julianday() parses both the ISO-8601 published_at and the
  // datetime('now') fetched_at, so the comparison is correct regardless of string format.
  await env.DB.prepare(
    `DELETE FROM news_items
      WHERE julianday(COALESCE(published_at, fetched_at)) < julianday('now', ?)`,
  ).bind(`-${PRUNE_DAYS} days`).run().catch((err) =>
    logger.error('news poll: prune failed', { error: String(err) }),
  )

  logger.info('news_poll', { sources: sources.length, inserted, failed })
  return { sources: sources.length, inserted, failed }
}
