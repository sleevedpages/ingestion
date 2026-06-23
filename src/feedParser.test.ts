import { describe, it, expect } from 'vitest'
import { parseFeed, toIso } from './lib/feedParser.js'

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>OnePiece.gg</title>
    <link>https://onepiece.gg</link>
    <item>
      <title>New OP12 set list revealed</title>
      <link>https://onepiece.gg/op12-set-list</link>
      <pubDate>Mon, 22 Jun 2026 12:30:38 +0000</pubDate>
      <description>This is the full article body that we must NOT store or relay.</description>
      <content:encoded><![CDATA[<p>Even more body text here, also ignored.</p>]]></content:encoded>
    </item>
    <item>
      <title><![CDATA[Tournament report: Luffy & Zoro top 8]]></title>
      <link>https://onepiece.gg/report?a=1&amp;b=2</link>
      <pubDate>Sun, 21 Jun 2026 09:00:00 +0000</pubDate>
    </item>
  </channel>
</rss>`

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>PlayingMTG</title>
  <entry>
    <title>Standard banlist update</title>
    <link rel="self" href="https://playingmtg.com/feed/self"/>
    <link rel="alternate" href="https://playingmtg.com/standard-banlist"/>
    <updated>2026-06-02T10:27:54Z</updated>
    <summary>Body summary that must be ignored.</summary>
  </entry>
</feed>`

describe('parseFeed — RSS', () => {
  const items = parseFeed(RSS)

  it('extracts one entry per <item> with title + link + ISO date', () => {
    expect(items).toHaveLength(2)
    expect(items[0]).toEqual({
      title: 'New OP12 set list revealed',
      link: 'https://onepiece.gg/op12-set-list',
      publishedAt: '2026-06-22T12:30:38.000Z',
    })
  })

  it('decodes CDATA titles and &amp; in links', () => {
    expect(items[1].title).toBe('Tournament report: Luffy & Zoro top 8')
    expect(items[1].link).toBe('https://onepiece.gg/report?a=1&b=2')
  })

  it('IGNORES the article body — no description/content/summary field is ever returned', () => {
    for (const it of items) {
      expect(Object.keys(it).sort()).toEqual(['link', 'publishedAt', 'title'])
      const blob = JSON.stringify(it)
      expect(blob).not.toContain('article body')
      expect(blob).not.toContain('body text')
    }
  })
})

describe('parseFeed — Atom', () => {
  it('extracts <entry> and prefers the rel="alternate" link (never rel="self")', () => {
    const items = parseFeed(ATOM)
    expect(items).toHaveLength(1)
    expect(items[0]).toEqual({
      title: 'Standard banlist update',
      link: 'https://playingmtg.com/standard-banlist',
      publishedAt: '2026-06-02T10:27:54.000Z',
    })
  })
})

describe('parseFeed — tolerance / edge cases', () => {
  it('returns [] for empty / non-string / junk input (never throws)', () => {
    expect(parseFeed('')).toEqual([])
    // @ts-expect-error testing a non-string input
    expect(parseFeed(null)).toEqual([])
    expect(parseFeed('<html><body>not a feed</body></html>')).toEqual([])
    expect(parseFeed('<rss><channel><item>broken')).toEqual([])
  })

  it('tolerates a malformed/incomplete item and keeps the good ones', () => {
    const xml = `<rss><channel>
      <item><title>Good</title><link>https://x.gg/a</link><pubDate>Mon, 22 Jun 2026 12:00:00 +0000</pubDate></item>
      <item><title>No link here</title></item>
      <item><link>https://x.gg/c</link></item>
    </channel></rss>`
    const items = parseFeed(xml)
    expect(items).toHaveLength(1)
    expect(items[0].link).toBe('https://x.gg/a')
  })

  it('drops items with a non-http(s) link', () => {
    const xml = `<rss><channel>
      <item><title>JS</title><link>javascript:alert(1)</link></item>
      <item><title>FTP</title><link>ftp://x.gg/a</link></item>
      <item><title>OK</title><link>https://x.gg/ok</link></item>
    </channel></rss>`
    const items = parseFeed(xml)
    expect(items).toHaveLength(1)
    expect(items[0].link).toBe('https://x.gg/ok')
  })

  it('leaves publishedAt null when the date is missing or unparseable', () => {
    const xml = `<rss><channel>
      <item><title>No date</title><link>https://x.gg/a</link></item>
      <item><title>Bad date</title><link>https://x.gg/b</link><pubDate>not a date</pubDate></item>
    </channel></rss>`
    const items = parseFeed(xml)
    expect(items.map((i) => i.publishedAt)).toEqual([null, null])
  })

  it('dedupes within the feed on link (first occurrence wins)', () => {
    const xml = `<rss><channel>
      <item><title>First</title><link>https://x.gg/dup</link></item>
      <item><title>Second (same link)</title><link>https://x.gg/dup</link></item>
      <item><title>Other</title><link>https://x.gg/other</link></item>
    </channel></rss>`
    const items = parseFeed(xml)
    expect(items).toHaveLength(2)
    expect(items[0].title).toBe('First')
    expect(items.map((i) => i.link)).toEqual(['https://x.gg/dup', 'https://x.gg/other'])
  })
})

describe('toIso', () => {
  it('parses RFC-822 (RSS) and ISO-8601 (Atom) dates to ISO UTC', () => {
    expect(toIso('Mon, 22 Jun 2026 12:30:38 +0000')).toBe('2026-06-22T12:30:38.000Z')
    expect(toIso('2026-06-02T10:27:54Z')).toBe('2026-06-02T10:27:54.000Z')
  })
  it('returns null for missing/unparseable', () => {
    expect(toIso(null)).toBeNull()
    expect(toIso(undefined)).toBeNull()
    expect(toIso('garbage')).toBeNull()
  })
})
