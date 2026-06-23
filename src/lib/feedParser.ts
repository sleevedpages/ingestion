// Tiny hand-rolled RSS / Atom extractor — ZERO runtime dependencies.
//
// It extracts ONLY three fields per item: title, link, published date. It DELIBERATELY
// never reads <description>, <content>, <content:encoded>, or <summary> — storing/relaying
// article bodies would rehost the publisher's content, the exact thing the News Feed (like
// Rule Books) avoids. We link out for the content. A unit test asserts the body is ignored.
//
// RSS and Atom are simple, flat XML for these three fields, so a careful regex extractor is
// sufficient and keeps the worker dependency-free. The parser is defensive: malformed XML,
// missing fields, or junk yields fewer/zero items, never a throw.

export interface FeedItem {
  title: string
  link: string
  publishedAt: string | null // ISO 8601, or null when the feed's date is missing/unparseable
}

// Decode the small set of XML entities that appear in titles/urls + strip CDATA wrappers.
// Ampersand is decoded LAST so a literal "&amp;lt;" round-trips correctly.
function decode(raw: string): string {
  if (!raw) return ''
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&#0*38;/gi, '&')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

// First inner text of <tag ...>...</tag> within a block (case-insensitive, namespace-safe via
// the caller passing e.g. "dc:date"). Returns null when absent.
function firstTag(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i')
  const m = block.match(re)
  return m ? m[1] : null
}

// Atom (and some RSS) carry the URL as <link href="..." rel="..."/>. Prefer rel="alternate"
// or a rel-less link; never return a self/edit/enclosure link.
function extractHrefLink(block: string): string {
  let fallback = ''
  for (const m of block.matchAll(/<link\b([^>]*?)\/?>/gi)) {
    const attrs = m[1] ?? ''
    const href = attrs.match(/href=["']([^"']+)["']/i)?.[1]
    if (!href) continue
    const rel = attrs.match(/rel=["']([^"']+)["']/i)?.[1]?.toLowerCase()
    if (!rel || rel === 'alternate') return decode(href)
    if (rel === 'self' || rel === 'edit' || rel === 'enclosure') continue
    if (!fallback) fallback = decode(href)
  }
  return fallback
}

function isHttpUrl(u: string): boolean {
  return /^https?:\/\//i.test(u)
}

// Parse an RSS pubDate (RFC 822) or Atom updated/published (ISO 8601) into a normalised ISO
// 8601 UTC string. Returns null when missing or unparseable (never throws). Uses Date.parse,
// which handles both formats in the Workers runtime.
export function toIso(raw: string | null | undefined): string | null {
  if (!raw) return null
  const t = Date.parse(decode(raw))
  if (Number.isNaN(t)) return null
  return new Date(t).toISOString()
}

/**
 * Extract { title, link, publishedAt } for every RSS <item> (or Atom <entry>) in `xml`.
 * Items are deduped within the feed by link (first occurrence wins). Items without a title or
 * a valid http(s) link are dropped. Article bodies are NEVER read.
 */
export function parseFeed(xml: string): FeedItem[] {
  if (!xml || typeof xml !== 'string') return []

  let blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi)
  let isAtom = false
  if (!blocks || blocks.length === 0) {
    blocks = xml.match(/<entry\b[\s\S]*?<\/entry>/gi)
    isAtom = true
  }
  if (!blocks) return []

  const items: FeedItem[] = []
  const seen = new Set<string>()

  for (const block of blocks) {
    const title = decode(firstTag(block, 'title') ?? '')

    // Link resolution differs by format; both fall back to the other shape defensively.
    let link = ''
    if (isAtom) {
      link = extractHrefLink(block)
    } else {
      const rawLink = firstTag(block, 'link')
      if (rawLink && rawLink.trim()) link = decode(rawLink)
      if (!link) link = extractHrefLink(block) // some RSS use <atom:link href=...>
      if (!link) {
        const guid = block.match(/<guid[^>]*isPermaLink=["']true["'][^>]*>([\s\S]*?)<\/guid>/i)
        if (guid) link = decode(guid[1])
      }
    }
    link = link.trim()

    const dateRaw = isAtom
      ? firstTag(block, 'updated') ?? firstTag(block, 'published')
      : firstTag(block, 'pubDate') ?? firstTag(block, 'dc:date')
    const publishedAt = toIso(dateRaw)

    // Require a title + a valid http(s) link. Body fields are intentionally never touched.
    if (!title || !isHttpUrl(link)) continue
    if (seen.has(link)) continue
    seen.add(link)
    items.push({ title, link, publishedAt })
  }

  return items
}
