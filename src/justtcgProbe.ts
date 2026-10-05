/**
 * justtcgProbe.ts — `POST /admin/justtcg-probe` (UAT only, 2026-10-05): measure JustTCG against the
 * rows we already hold. It DECIDES nothing, SWITCHES nothing and WRITES NOTHING TO D1.
 *
 * WHAT IT DOES. Picks a sample of products (explicit ids, or N per game at random from the products
 * that carry a Scrydex condition row — on a database with none, the TCGplayer-raw pool — plus N
 * from the "no TCGplayer raw row" set), fetches from JustTCG ONE raw batch per 20 products
 * (`POST /v1/cards`, all conditions/printings; v1 never carries graded variants) and ONE
 * graded-only call per product (`GET /v2/cards?tcgplayer_id=…&graded=only` — never `include`,
 * which is surcharged; v2 has no batch yet), searches by name for products with no TCGplayer id,
 * then runs the PURE comparison (`justtcgCompare.ts`) and persists the raw payloads + comparison to
 * the private R2 bucket at `probes/justtcg/<date>/<runId>.json` (the Content app's PRICE_ARCHIVE
 * bucket, bound here as `PRICE_ARCHIVE`; unbound → nothing persisted, said so in the response).
 *
 * WHY IT IS RESUMABLE. The Free plan allows 100 calls/day and 10/min. A 60-product sample is
 * 3 raw batches + 60 graded calls, which cannot fit one worker invocation at 10/min. So the run is
 * a QUEUE that travels in the response: each invocation performs up to `maxCalls` (default 9)
 * paced calls and returns `{ done:false, state }`; the caller posts `state` back until `done`.
 * A `cap`/`quota`/`auth` error stops the run with `capHit`/`stopped` — never a retry into a wall.
 *
 * The daily KV counter (`justtcg_calls:<day>`), the key, the typed errors: `lib/justtcgClient.ts`.
 * The comparison semantics: `justtcgCompare.ts`. Tests: `justtcgProbe.test.ts`.
 */

import type { Env } from './worker.js'
import {
  justtcgConfigured, justtcgLimits, readDailyCounter, justtcgGames, justtcgBatchByTcgplayerIds,
  justtcgGradedByTcgplayerId, justtcgSearch, JustTcgError,
  type JtV1Card, type JtV2Card, type JtGame, type JustTcgUsage,
} from './lib/justtcgClient.js'
import { compareProduct, summarise, type OurPriceRow, type OurProduct, type ProductComparison } from './justtcgCompare.js'

const IN_CHUNK = 90
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** The eight games the probe samples by default (canonical_games.name spellings). */
export const DEFAULT_PROBE_GAMES = [
  'Pokemon', 'Pokemon Japan', 'Magic', 'One Piece Card Game', 'Lorcana TCG', 'Gundam Card Game',
  'Riftbound League of Legends Trading Card Game', 'YuGiOh',
]

export interface ProbeProduct {
  productId:          number | null
  tcgplayerProductId: number | null
  game:               string
  name:               string
  number:             string | null
  setName:            string | null
  pool:               'explicit' | 'scrydex_tiers' | 'tcgplayer_raw' | 'no_tcgplayer'
}

export type QueueItem =
  | { kind: 'games' }
  | { kind: 'raw-batch'; tcgplayerIds: number[] }
  | { kind: 'graded'; tcgplayerId: number }
  | { kind: 'search'; productId: number | null; tcgplayerProductId: number | null }

export interface ProbeState {
  runId:      string
  startedAt:  string
  products:   ProbeProduct[]
  queue:      QueueItem[]
  games:      JtGame[] | null
  gameIdMap:  Record<string, string | null>
  raw:        Record<string, JtV1Card>          // tcgplayerId → v1 card
  graded:     Record<string, JtV2Card | null>   // tcgplayerId → v2 card (null = none found)
  search:     Record<string, JtV1Card | null>   // product key → v1 card (null = none)
  calls:      number
  usage:      JustTcgUsage | null
  errors:     Array<{ item: string; kind: string; message: string }>
  stopped:    string | null                     // 'cap' | 'quota' | 'auth' | null
}

export interface ProbeBody {
  canonicalProductIds?: number[]
  tcgplayerProductIds?: number[]
  sample?:              { perGame?: number; games?: string[] }
  includeNoTcgplayer?:  number
  maxCalls?:            number
  includeRaw?:          boolean
  state?:               ProbeState
}

export interface ProbeResult {
  ok:          boolean
  error?:      string
  runId:       string
  done:        boolean
  capHit:      boolean
  stopped:     string | null
  calls:       { thisInvocation: number; total: number; dailyUsed: number; dailyAllowed: number; dailyCap: number; justtcgReported: JustTcgUsage | null }
  queueRemaining: number
  products:    number
  state?:      ProbeState
  summary?:    ReturnType<typeof summarise>
  gameIdMap?:  Record<string, string | null>
  justtcgGames?: Array<{ id: string | null; name: string | null; cards: number | null }>
  comparisons?: ProductComparison[]
  raw?:        { v1: Record<string, JtV1Card>; v2: Record<string, JtV2Card | null>; search: Record<string, JtV1Card | null> }
  persisted:   { key: string; bytes: number } | null
  persistNote?: string
  errors:      ProbeState['errors']
}

// ── Game-id mapping (our canonical_games.name → JustTCG game id, from ONE /v1/games call) ──────

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
/** Name aliases, OUR normalised name → candidate normalised JustTCG tokens (first match wins). */
const GAME_ALIASES: Record<string, string[]> = {
  pokemon:                                   ['pokemon'],
  pokemonjapan:                              ['pokemonjapan', 'pokemonjp', 'japanesepokemon', 'pokemonjapanese'],
  magic:                                     ['magicthegathering', 'magic', 'mtg'],
  onepiececardgame:                          ['onepiececardgame', 'onepiece'],
  lorcanatcg:                                ['disneylorcana', 'lorcana'],
  gundamcardgame:                            ['gundamcardgame', 'gundam'],
  riftboundleagueoflegendstradingcardgame:   ['riftbound'],
  yugioh:                                    ['yugioh'],
  unionarena:                                ['unionarena'],
  digimoncardgame:                           ['digimoncardgame', 'digimon'],
  fleshbloodtcg:                             ['fleshandblood', 'fleshblood'],
  dragonballsuperfusionworld:                ['dragonballsuperfusionworld', 'dragonballfusionworld', 'fusionworld'],
}

export function matchJustTcgGameId(ourGame: string, games: JtGame[]): string | null {
  const key = norm(ourGame)
  const candidates = GAME_ALIASES[key] ?? [key]
  const normed = games.map(g => ({ id: g.id ?? null, nid: norm(g.id), nname: norm(g.name) }))
  // Exact alias on id or name first (so 'pokemon' never matches 'pokemon-japan' before 'pokemonjapan' is tried).
  for (const c of candidates) {
    const hit = normed.find(g => g.nid === c || g.nname === c)
    if (hit?.id) return hit.id
  }
  for (const c of candidates) {
    const hits = normed.filter(g => g.nid.includes(c) || g.nname.includes(c))
    if (hits.length === 1 && hits[0].id) return hits[0].id
    if (key === 'pokemon' && hits.length > 1) {
      const plain = hits.find(g => !g.nid.includes('japan') && !g.nname.includes('japan'))
      if (plain?.id) return plain.id
    }
  }
  return null
}

// ── Product selection (D1 reads only) ──────────────────────────────────────────────────────────

interface ProductRow { id: number; tcgplayer_product_id: number | null; name: string; number: string | null; set_name: string | null; game: string }

const PRODUCT_SELECT = `
  SELECT pr.id, pr.tcgplayer_product_id, pr.name, pr.number, s.name AS set_name, cg.name AS game
  FROM products pr JOIN sets s ON s.id = pr.set_id JOIN canonical_games cg ON cg.id = s.game_id`

const SCRYDEX_TIER_EXISTS = `EXISTS (SELECT 1 FROM prices p WHERE p.product_id = pr.id AND p.source = 'scrydex' AND p.is_graded = 0 AND p.grade IS NULL AND p.condition IN ('NM','LP','MP','HP','DM'))`
const TCG_RAW_EXISTS      = `EXISTS (SELECT 1 FROM prices p WHERE p.product_id = pr.id AND p.source = 'tcgplayer' AND p.is_graded = 0 AND p.grade IS NULL)`
const ANY_RAW_EXISTS      = `EXISTS (SELECT 1 FROM prices p WHERE p.product_id = pr.id AND p.is_graded = 0 AND p.grade IS NULL)`

async function sampleGame(db: D1Database, game: string, n: number): Promise<{ rows: ProductRow[]; pool: 'scrydex_tiers' | 'tcgplayer_raw' }> {
  const tiered = await db.prepare(`${PRODUCT_SELECT} WHERE cg.name = ? AND pr.product_kind = 'card' AND ${SCRYDEX_TIER_EXISTS} ORDER BY RANDOM() LIMIT ?`)
    .bind(game, n).all<ProductRow>()
  if ((tiered.results ?? []).length) return { rows: tiered.results, pool: 'scrydex_tiers' }
  const raw = await db.prepare(`${PRODUCT_SELECT} WHERE cg.name = ? AND pr.product_kind = 'card' AND ${TCG_RAW_EXISTS} ORDER BY RANDOM() LIMIT ?`)
    .bind(game, n).all<ProductRow>()
  return { rows: raw.results ?? [], pool: 'tcgplayer_raw' }
}

async function sampleNoTcgplayer(db: D1Database, n: number): Promise<ProductRow[]> {
  // Prefer products that hold SOME raw row (PriceCharting / Scrydex) — the ones the ladder actually
  // serves past TCGplayer today — then pad from the rest of the set.
  const r = await db.prepare(`${PRODUCT_SELECT} WHERE pr.product_kind = 'card' AND NOT ${TCG_RAW_EXISTS} ORDER BY CASE WHEN ${ANY_RAW_EXISTS} THEN 0 ELSE 1 END, RANDOM() LIMIT ?`)
    .bind(n).all<ProductRow>()
  return r.results ?? []
}

async function loadProductsById(db: D1Database, ids: number[]): Promise<ProductRow[]> {
  const out: ProductRow[] = []
  for (const c of chunk(ids, IN_CHUNK)) {
    const r = await db.prepare(`${PRODUCT_SELECT} WHERE pr.id IN (${c.map(() => '?').join(',')})`).bind(...c).all<ProductRow>()
    out.push(...(r.results ?? []))
  }
  return out
}
async function loadProductsByTcgplayerId(db: D1Database, ids: number[]): Promise<ProductRow[]> {
  const out: ProductRow[] = []
  for (const c of chunk(ids, IN_CHUNK)) {
    const r = await db.prepare(`${PRODUCT_SELECT} WHERE pr.tcgplayer_product_id IN (${c.map(() => '?').join(',')})`).bind(...c).all<ProductRow>()
    out.push(...(r.results ?? []))
  }
  return out
}

const toProbeProduct = (r: ProductRow, pool: ProbeProduct['pool']): ProbeProduct => ({
  productId: r.id, tcgplayerProductId: r.tcgplayer_product_id, game: r.game, name: r.name, number: r.number, setName: r.set_name, pool,
})

export async function selectProducts(db: D1Database, body: ProbeBody): Promise<ProbeProduct[]> {
  const out: ProbeProduct[] = []
  const seen = new Set<string>()
  const push = (p: ProbeProduct) => {
    const k = p.productId != null ? `p${p.productId}` : `t${p.tcgplayerProductId}`
    if (seen.has(k)) return
    seen.add(k); out.push(p)
  }
  const explicitIds = (body.canonicalProductIds ?? []).map(Number).filter(n => Number.isInteger(n) && n > 0)
  if (explicitIds.length) for (const r of await loadProductsById(db, explicitIds)) push(toProbeProduct(r, 'explicit'))
  const tcgIds = (body.tcgplayerProductIds ?? []).map(Number).filter(n => Number.isInteger(n) && n > 0)
  if (tcgIds.length) {
    const found = await loadProductsByTcgplayerId(db, tcgIds)
    for (const r of found) push(toProbeProduct(r, 'explicit'))
    const have = new Set(found.map(r => r.tcgplayer_product_id))
    // An id this database does not know (prod-sampled, UAT-run) is still probed — the caller
    // re-compares against its own rows; here it resolves with zero "ours" rows.
    for (const id of tcgIds) if (!have.has(id)) push({ productId: null, tcgplayerProductId: id, game: 'unknown', name: `tcgplayer:${id}`, number: null, setName: null, pool: 'explicit' })
  }
  if (body.sample) {
    const perGame = Math.max(1, Math.min(50, Number(body.sample.perGame) || 10))
    const games = (body.sample.games?.length ? body.sample.games : DEFAULT_PROBE_GAMES)
    for (const g of games) {
      const { rows, pool } = await sampleGame(db, g, perGame)
      for (const r of rows) push(toProbeProduct(r, pool))
    }
  }
  const noTcg = Math.max(0, Math.min(200, Number(body.includeNoTcgplayer) || 0))
  if (noTcg) for (const r of await sampleNoTcgplayer(db, noTcg)) push(toProbeProduct(r, 'no_tcgplayer'))
  return out
}

async function loadRows(db: D1Database, productIds: number[]): Promise<Map<number, OurPriceRow[]>> {
  const map = new Map<number, OurPriceRow[]>()
  for (const c of chunk(productIds, IN_CHUNK)) {
    const r = await db.prepare(`
      SELECT product_id, source, condition, finish, variant, grade, company, is_graded, is_perfect, is_signed, is_error, value, fetched_at
      FROM prices WHERE product_id IN (${c.map(() => '?').join(',')})`).bind(...c).all<OurPriceRow & { product_id: number }>()
    for (const row of r.results ?? []) {
      const { product_id, ...rest } = row
      ;(map.get(product_id) ?? map.set(product_id, []).get(product_id)!).push(rest)
    }
  }
  return map
}

// ── Queue construction ─────────────────────────────────────────────────────────────────────────

export function buildQueue(products: ProbeProduct[], batchSize: number): QueueItem[] {
  const q: QueueItem[] = [{ kind: 'games' }]
  const withId = products.filter(p => p.tcgplayerProductId != null)
  for (const c of chunk(withId.map(p => p.tcgplayerProductId!), batchSize)) q.push({ kind: 'raw-batch', tcgplayerIds: c })
  // Graded calls: products we hold graded rows for are not known here (rows load at the end), so the
  // order is the selection order — explicit first, then per-game samples, then the no-TCGplayer set.
  for (const p of withId) q.push({ kind: 'graded', tcgplayerId: p.tcgplayerProductId! })
  for (const p of products) if (p.tcgplayerProductId == null && p.productId != null) q.push({ kind: 'search', productId: p.productId, tcgplayerProductId: null })
  return q
}

const searchKey = (item: { productId: number | null; tcgplayerProductId: number | null }) =>
  item.productId != null ? `p${item.productId}` : `t${item.tcgplayerProductId}`

export const DEFAULT_MAX_CALLS = 9

// ── The run ────────────────────────────────────────────────────────────────────────────────────

export async function runJustTcgProbe(env: Env, body: ProbeBody): Promise<ProbeResult> {
  const limits = justtcgLimits(env)
  const maxCalls = Math.max(1, Math.min(50, Number(body.maxCalls) || DEFAULT_MAX_CALLS))

  let state: ProbeState
  if (body.state && Array.isArray(body.state.queue) && Array.isArray(body.state.products)) {
    state = body.state
  } else {
    const products = await selectProducts(env.DB, body)
    state = {
      runId: crypto.randomUUID().slice(0, 8), startedAt: new Date().toISOString(),
      products, queue: buildQueue(products, limits.batchSize), games: null, gameIdMap: {},
      raw: {}, graded: {}, search: {}, calls: 0, usage: null, errors: [], stopped: null,
    }
  }

  let thisInvocation = 0
  let capHit = false
  const note = (item: QueueItem, err: unknown) => {
    const e = err as JustTcgError
    state.errors.push({ item: JSON.stringify(item), kind: e?.kind ?? 'unknown', message: String(e?.message ?? err) })
  }

  while (state.queue.length && thisInvocation < maxCalls && !state.stopped) {
    const item = state.queue[0]
    if (thisInvocation > 0) await sleep(limits.minIntervalMs)
    try {
      if (item.kind === 'games') {
        const res = await justtcgGames(env)
        state.games = res.body?.data ?? []
        for (const p of state.products) if (!(p.game in state.gameIdMap)) state.gameIdMap[p.game] = matchJustTcgGameId(p.game, state.games)
        state.usage = res.usage ?? state.usage
      } else if (item.kind === 'raw-batch') {
        const res = await justtcgBatchByTcgplayerIds(env, item.tcgplayerIds)
        for (const card of res.body?.data ?? []) if (card?.tcgplayerId != null) state.raw[String(card.tcgplayerId)] = card
        state.usage = res.usage ?? state.usage
      } else if (item.kind === 'graded') {
        const res = await justtcgGradedByTcgplayerId(env, item.tcgplayerId)
        const card = (res.body?.data ?? [])[0] ?? null
        state.graded[String(item.tcgplayerId)] = card
      } else if (item.kind === 'search') {
        const p = state.products.find(x => x.productId === item.productId)
        if (!p) { state.queue.shift(); continue }
        const gameId = state.gameIdMap[p.game] ?? null
        const res = await justtcgSearch(env, p.name, gameId, p.number)
        const cards = res.body?.data ?? []
        // Accept only an exact (case-insensitive) name match with the same number when one is known.
        const hit = cards.find(c => norm(c.name) === norm(p.name) && (!p.number || norm(c.number) === norm(p.number))) ?? null
        state.search[searchKey(item)] = hit
        state.usage = res.usage ?? state.usage
      }
      state.calls += 1
      thisInvocation += 1
      state.queue.shift()
    } catch (err) {
      const e = err as JustTcgError
      if (e instanceof JustTcgError && (e.kind === 'cap' || e.kind === 'quota' || e.kind === 'auth' || e.kind === 'not_configured')) {
        state.stopped = e.kind
        capHit = e.kind === 'cap' || e.kind === 'quota'
        note(item, err)
        break
      }
      // rate_limit / timeout / network / http: record, count the attempt (JustTCG may have billed it), move on.
      if (e instanceof JustTcgError && e.kind !== 'rate_limit') { state.calls += 1; thisInvocation += 1 }
      note(item, err)
      state.queue.shift()
      if (e instanceof JustTcgError && e.kind === 'rate_limit') { await sleep(limits.minIntervalMs * 2); thisInvocation += 1 }
    }
  }

  let counter = { used: 0, allowed: 0, cap: limits.dailyCap }
  try { const c = await readDailyCounter(env); counter = { used: c.used, allowed: c.allowed, cap: c.cap } } catch { /* unbound KV already surfaced as not_configured */ }

  const base: ProbeResult = {
    ok: true, runId: state.runId, done: false, capHit, stopped: state.stopped,
    calls: { thisInvocation, total: state.calls, dailyUsed: counter.used, dailyAllowed: counter.allowed, dailyCap: counter.cap, justtcgReported: state.usage },
    queueRemaining: state.queue.length, products: state.products.length, persisted: null, errors: state.errors,
  }

  if (state.queue.length) {
    // Not finished (more calls to make, or stopped on cap/quota/auth): hand the state back. The
    // item that stopped the run is still at the head of the queue, so re-posting the state later
    // (tomorrow, after the cap resets; after the key is fixed) retries it — `stopped` is cleared
    // so the resume is not refused on sight, and the response's `stopped`/`capHit` say why it ended.
    return { ...base, state: { ...state, stopped: null } }
  }

  // ── Finish: compare against OUR rows (this database's), persist, summarise ──────────────────
  const ids = state.products.map(p => p.productId).filter((n): n is number => n != null)
  const rows = await loadRows(env.DB, ids)
  const comparisons: ProductComparison[] = state.products.map(p => {
    const ours: OurProduct = {
      productId: p.productId, tcgplayerProductId: p.tcgplayerProductId, game: p.game, name: p.name, number: p.number, setName: p.setName,
      rows: p.productId != null ? (rows.get(p.productId) ?? []) : [],
    }
    const byId = p.tcgplayerProductId != null ? (state.raw[String(p.tcgplayerProductId)] ?? null) : null
    const bySearch = p.tcgplayerProductId == null ? (state.search[searchKey({ productId: p.productId, tcgplayerProductId: null })] ?? null) : null
    const graded = p.tcgplayerProductId != null ? (state.graded[String(p.tcgplayerProductId)] ?? null) : null
    return compareProduct(ours, byId ?? bySearch, graded, { resolvedBy: byId ? 'tcgplayerId' : (bySearch ? 'search' : null) })
  })
  const summary = summarise(comparisons)
  const justtcgGamesOut = (state.games ?? []).map(g => ({ id: g.id ?? null, name: g.name ?? null, cards: typeof g.cards_count === 'number' ? g.cards_count : null }))

  let persisted: ProbeResult['persisted'] = null
  let persistNote: string | undefined
  const bucket = env.PRICE_ARCHIVE
  if (bucket) {
    const key = `probes/justtcg/${state.startedAt.slice(0, 10)}/${state.runId}.json`
    const payload = JSON.stringify({
      runId: state.runId, startedAt: state.startedAt, finishedAt: new Date().toISOString(), calls: state.calls, usage: state.usage,
      stopped: state.stopped, errors: state.errors, gameIdMap: state.gameIdMap, justtcgGames: justtcgGamesOut,
      products: state.products, summary, comparisons, raw: { v1: state.raw, v2: state.graded, search: state.search },
    })
    try {
      await bucket.put(key, payload, { httpMetadata: { contentType: 'application/json' } })
      persisted = { key, bytes: payload.length }
    } catch (err) {
      persistNote = `R2 put failed: ${String(err)}`
    }
  } else {
    persistNote = 'PRICE_ARCHIVE R2 binding absent on this worker — nothing persisted; the response carries the full result'
  }

  return {
    ...base, done: true, summary, gameIdMap: state.gameIdMap, justtcgGames: justtcgGamesOut, comparisons,
    ...(body.includeRaw ? { raw: { v1: state.raw, v2: state.graded, search: state.search } } : {}),
    persisted, ...(persistNote ? { persistNote } : {}),
  }
}

/** The route's pre-flight: 503 when the key is absent (fail closed) — checked before any D1 read. */
export function probeNotConfigured(env: Env): boolean {
  return !justtcgConfigured(env)
}
