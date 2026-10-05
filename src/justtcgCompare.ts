/**
 * justtcgCompare.ts — PURE comparison of what we hold (canonical `prices` rows) against a JustTCG
 * payload, one product at a time, plus the per-game summary. No I/O, no imports at runtime (the
 * operator script `scripts/justtcg-probe.mjs` loads this file directly under Node's type stripping
 * to re-run the comparison against PROD's read-only rows — UAT holds no Scrydex / PriceCharting
 * rows at all, measured 2026-10-05, so the worker's own comparison on UAT covers only TCGplayer).
 *
 * The "ours" side re-implements, deliberately and minimally, three Content contracts so the probe
 * compares like-for-like (the names are the Content ones; drift is pinned by justtcgProbe.test.ts):
 *   • `finishKey()` — the printing comparison key (functions/lib/pricing.js);
 *   • the RAW ladder — TCGplayer (finish-matched: requested → Normal → highest) → PriceCharting
 *     loose → Scrydex NM (normal → highest) (`resolveRawLadder`);
 *   • `selectGradedRows` labels — an `is_perfect` row is relabelled `<company> <perfect tier>`
 *     (CGC/TAG 'Pristine 10', BGS 'Black Label 10'; other companies' perfect rows DROPPED),
 *     `is_signed` / `is_error` rows excluded, one entry per label.
 * This module DECIDES nothing and WRITES nothing; it measures.
 */

import type { JtV1Card, JtV1Variant, JtV2Card, JtV2Variant } from './lib/justtcgClient.js'

// ── Our side ───────────────────────────────────────────────────────────────────────────────────

export interface OurPriceRow {
  source:     string               // 'tcgplayer' | 'pricecharting' | 'scrydex'
  condition:  string | null        // Scrydex 'NM'…'DM' on tier rows
  finish:     string | null
  variant:    string | null
  grade:      string | null        // combined label 'PSA 10' / 'Grade 9.5'
  company:    string | null
  is_graded:  number
  is_perfect: number
  is_signed:  number
  is_error:   number
  value:      number | null
  fetched_at: number | null        // unix seconds
}

export interface OurProduct {
  productId:          number | null
  tcgplayerProductId: number | null
  game:               string        // canonical_games.name
  name:               string
  number:             string | null
  setName:            string | null
  rows:               OurPriceRow[]
  /** Days of our own TCGplayer-basis `price_daily` series, when the caller measured it. */
  priceDailyDays?:    number | null
}

/** Twin of Content `finishKey()` — camelCase split, '1st'→'first', 'edition' dropped, alnum only. */
export function finishKey(finish: unknown): string | null {
  if (finish == null) return null
  const s = String(finish)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/\b1st\b/g, 'first')
    .replace(/\bedition\b/g, '')
    .replace(/[^a-z0-9]/g, '')
  return s || null
}

export const TIER_CODES = ['NM', 'LP', 'MP', 'HP', 'DM'] as const
export type TierCode = (typeof TIER_CODES)[number]

/** JustTCG condition names (v1 `condition`) → our Scrydex tier codes. Unknown → null. */
export function conditionCode(condition: unknown): TierCode | null {
  const c = String(condition ?? '').trim().toLowerCase()
  if (!c) return null
  if (c === 'nm' || c === 'near mint') return 'NM'
  if (c === 'lp' || c === 'lightly played') return 'LP'
  if (c === 'mp' || c === 'moderately played') return 'MP'
  if (c === 'hp' || c === 'heavily played') return 'HP'
  if (c === 'dm' || c === 'damaged') return 'DM'
  return null
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export interface LadderResult { value: number | null; source: string | null; finish: string | null }

/** The raw ladder over a product's rows (twin of Content `resolveRawLadder` over `partsFromRawRows`). */
export function resolveRawLadder(rows: OurPriceRow[], requestedFinish: string | null = null): LadderResult {
  const raw = rows.filter(r => r.is_graded === 0 && r.grade == null && r.value != null)
  // Rung 1 — TCGplayer, finish-matched.
  const tcg = raw.filter(r => r.source === 'tcgplayer')
  if (tcg.length) {
    const want = finishKey(requestedFinish)
    const pick = (want ? tcg.find(r => finishKey(r.finish) === want) : undefined)
      ?? tcg.find(r => finishKey(r.finish) === 'normal')
      ?? tcg.reduce((b, r) => ((r.value ?? -1) > (b.value ?? -1) ? r : b), tcg[0])
    return { value: pick.value, source: 'tcgplayer', finish: pick.finish }
  }
  // Rung 2 — PriceCharting loose.
  const pc = raw.find(r => r.source === 'pricecharting')
  if (pc) return { value: pc.value, source: 'pricecharting', finish: pc.finish }
  // Rung 3 — Scrydex NM market (normal → highest).
  const sx = raw.filter(r => r.source === 'scrydex' && (r.condition == null || r.condition === 'NM'))
  if (sx.length) {
    const pick = sx.find(r => r.finish === 'normal')
      ?? sx.reduce((b, r) => ((r.value ?? -1) > (b.value ?? -1) ? r : b), sx[0])
    return { value: pick.value, source: 'scrydex', finish: pick.finish }
  }
  return { value: null, source: null, finish: null }
}

export type TierMap = Partial<Record<TierCode, number>>

/** Scrydex NM/LP/MP/HP/DM per tier: finish 'normal' first, else the highest-value finish (the
 *  Content `selectConditionRows` rule with no requested printing). */
export function scrydexTiers(rows: OurPriceRow[]): TierMap {
  const out: TierMap = {}
  for (const code of TIER_CODES) {
    const pool = rows.filter(r => r.source === 'scrydex' && r.is_graded === 0 && r.grade == null && r.condition === code && r.value != null)
    if (!pool.length) continue
    const pick = pool.find(r => r.finish === 'normal')
      ?? pool.reduce((b, r) => ((r.value ?? -1) > (b.value ?? -1) ? r : b), pool[0])
    out[code] = pick.value!
  }
  return out
}

export const PERFECT_TIER_LABEL: Record<string, string> = { CGC: 'Pristine 10', BGS: 'Black Label 10', TAG: 'Pristine 10' }

export interface GradedLabel {
  label:     string            // our vocabulary: 'PSA 10' / 'CGC Pristine 10' / 'Grade 9.5'
  company:   string | null     // from the row, else the label's leading token when it is a company
  source:    string
  isPerfect: boolean
  value:     number | null
  fetchedAt: number | null
}

const KNOWN_COMPANIES = new Set(['PSA', 'BGS', 'CGC', 'SGC', 'TAG', 'ACE', 'ARS', 'AGS', 'BCCG', 'BVG', 'CCIC', 'DGS', 'PGC'])

/** Our graded labels: the `selectGradedRows` filter + relabel, one per label (scrydex preferred). */
export function ourGradedLabels(rows: OurPriceRow[]): GradedLabel[] {
  const byLabel = new Map<string, GradedLabel>()
  const ordered = [...rows].sort((a, b) => (a.source === 'scrydex' ? -1 : 0) - (b.source === 'scrydex' ? -1 : 0))
  for (const r of ordered) {
    if (r.is_graded !== 1 || r.grade == null || r.is_signed === 1 || r.is_error === 1) continue
    const company = r.company?.toUpperCase() ?? (KNOWN_COMPANIES.has(String(r.grade).split(' ')[0]) ? String(r.grade).split(' ')[0] : null)
    let label = String(r.grade)
    let isPerfect = false
    if (r.is_perfect === 1) {
      const perfect = company ? PERFECT_TIER_LABEL[company] : undefined
      if (!perfect) continue                       // a perfect row for a company with no premium tier is DROPPED
      label = `${company} ${perfect}`
      isPerfect = true
    }
    if (byLabel.has(label)) continue
    byLabel.set(label, { label, company, source: r.source, isPerfect, value: r.value, fetchedAt: r.fetched_at })
  }
  return [...byLabel.values()]
}

// ── JustTCG side ───────────────────────────────────────────────────────────────────────────────

export interface JtGradedEntry {
  company:     string | null
  grade:       number | null
  gradeLabel:  string | null
  qualifier:   string | null
  canonical:   string | null
  /** Our-vocabulary label this variant maps to, or null when it cannot (qualifier, Authentic, unknown). */
  ourLabel:    string | null
  skipReason:  string | null
  price:       number | null
  updatedAt:   number | null
  historyPoints: number
}

const fmtGrade = (g: number): string => (Number.isInteger(g) ? String(g) : String(g))

/** Map one v2 graded variant to our label vocabulary — the future writer's `is_perfect` / skip rules
 *  are read off this function's recorded behaviour, so keep every case explicit. */
export function justtcgGradedEntry(v: JtV2Variant): JtGradedEntry {
  const g = v.grading ?? {}
  const market = (v.markets ?? [])[0] ?? null
  const base: JtGradedEntry = {
    company: g.company ?? null, grade: num(g.grade), gradeLabel: g.grade_label ?? null,
    qualifier: g.qualifier ?? null, canonical: g.canonical ?? null,
    ourLabel: null, skipReason: null,
    price: num(market?.price), updatedAt: num(market?.updated_at), historyPoints: market?.price_history?.length ?? 0,
  }
  const company = (g.company ?? '').toUpperCase()
  if (!company) return { ...base, skipReason: 'no_company' }
  if (g.qualifier) return { ...base, skipReason: `qualifier:${g.qualifier}` }      // qualified slabs are priced separately — we hold no such bucket
  if (base.grade == null) return { ...base, skipReason: 'authentic_or_no_grade' }
  const label = (g.grade_label ?? '').trim().toLowerCase()
  if (label) {
    if (label === 'black label' && company === 'BGS') return { ...base, ourLabel: 'BGS Black Label 10' }
    if (label === 'pristine' && (company === 'CGC' || company === 'TAG' || company === 'BGS')) return { ...base, ourLabel: `${company} Pristine 10` }
    return { ...base, skipReason: `grade_label:${g.grade_label}` }
  }
  return { ...base, ourLabel: `${company} ${fmtGrade(base.grade)}` }
}

function isEnglish(v: { language?: string | null }): boolean {
  const l = (v.language ?? '').trim().toLowerCase()
  return !l || l === 'english' || l === 'en'
}

/** Pick the JustTCG printing to compare: our ladder's finish by key → 'Normal' → the highest NM price. */
export function pickPrinting(variants: JtV1Variant[], ourFinish: string | null): string | null {
  const en = variants.filter(isEnglish)
  if (!en.length) return null
  const want = finishKey(ourFinish)
  const keys = new Map<string, string>()
  for (const v of en) { const k = finishKey(v.printing); if (k && !keys.has(k)) keys.set(k, String(v.printing)) }
  if (want && keys.has(want)) return keys.get(want)!
  if (keys.has('normal')) return keys.get('normal')!
  let best: JtV1Variant | null = null
  for (const v of en) if (conditionCode(v.condition) === 'NM' && num(v.price) != null && (best == null || (v.price as number) > (best.price as number))) best = v
  return best?.printing ? String(best.printing) : (en[0].printing ? String(en[0].printing) : null)
}

export function justtcgTiers(variants: JtV1Variant[], printing: string | null): TierMap {
  const out: TierMap = {}
  const want = finishKey(printing)
  for (const v of variants) {
    if (!isEnglish(v)) continue
    if (want && finishKey(v.printing) !== want) continue
    const code = conditionCode(v.condition)
    const p = num(v.price)
    if (!code || p == null) continue
    if (out[code] == null) out[code] = p
  }
  return out
}

// ── The comparison ─────────────────────────────────────────────────────────────────────────────

const pctDelta = (ours: number | null | undefined, theirs: number | null | undefined): number | null =>
  (ours != null && theirs != null && ours !== 0) ? Math.round(((theirs - ours) / ours) * 1000) / 10 : null

const ratio = (a: number | undefined, b: number | undefined): number | null =>
  (a != null && b != null && b !== 0) ? Math.round((a / b) * 1000) / 1000 : null

const ageDays = (unixSeconds: number | null | undefined, now: number): number | null =>
  unixSeconds == null ? null : Math.round(((now - unixSeconds) / 86_400) * 10) / 10

export interface ProductComparison {
  productId:          number | null
  tcgplayerProductId: number | null
  game:               string
  name:               string
  resolved:           boolean
  resolvedBy:         'tcgplayerId' | 'search' | null
  justtcg:            { cardId: string | null; game: string | null; set: string | null; variants: number; english: number; languages: string[] }
  printings:          { justtcg: string[]; ourFinishKeys: string[]; unmapped: string[]; compared: string | null }
  raw:                { ours: LadderResult; justtcgNm: number | null; justtcgUpdatedAt: number | null; deltaPct: number | null }
  tiers:              { ours: TierMap; justtcg: TierMap; deltaPct: Partial<Record<TierCode, number | null>>; ourTierCount: number; justtcgTierCount: number
                        spread: { ours: Record<string, number | null>; justtcg: Record<string, number | null> } }
  trends:             { priceChange24hr: number | null; priceChange7d: number | null; priceChange30d: number | null; historyPoints: number; historyDays: number | null; ourPriceDailyDays: number | null }
  graded:             { ours: GradedLabel[]; justtcg: JtGradedEntry[]; matched: Array<{ label: string; ourValue: number | null; ourSource: string; jtPrice: number | null; deltaPct: number | null }>
                        justtcgOnly: string[]; oursOnly: Array<{ label: string; source: string }>; skipped: Array<{ canonical: string | null; reason: string }>
                        gradeLabelsSeen: string[]; qualifiersSeen: string[]; companiesSeen: string[] }
  freshness:          { justtcgRawAgeDays: number | null; justtcgGradedAgeDaysMin: number | null; ourLadderAgeDays: number | null }
}

export function compareProduct(
  ours: OurProduct,
  jtRaw: JtV1Card | null,
  jtGraded: JtV2Card | null,
  opts: { resolvedBy?: 'tcgplayerId' | 'search' | null; nowSeconds?: number } = {},
): ProductComparison {
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000)
  const ladder = resolveRawLadder(ours.rows)
  const variants = jtRaw?.variants ?? []
  const english = variants.filter(isEnglish)
  const languages = [...new Set(variants.map(v => (v.language ?? 'English') as string))]

  const ourFinishKeys = [...new Set(ours.rows.filter(r => r.is_graded === 0).map(r => finishKey(r.finish) ?? finishKey(r.variant)).filter((k): k is string => !!k))]
  const jtPrintings = [...new Set(english.map(v => String(v.printing ?? '')).filter(Boolean))]
  const unmapped = jtPrintings.filter(p => { const k = finishKey(p); return !k || !ourFinishKeys.includes(k) })
  const compared = jtRaw ? pickPrinting(variants, ladder.finish) : null

  const jtTiers = jtRaw ? justtcgTiers(variants, compared) : {}
  const ourTiers = scrydexTiers(ours.rows)
  const deltaPct: Partial<Record<TierCode, number | null>> = {}
  for (const code of TIER_CODES) if (ourTiers[code] != null || jtTiers[code] != null) deltaPct[code] = pctDelta(ourTiers[code], jtTiers[code])

  const nmVariant = english.find(v => conditionCode(v.condition) === 'NM' && (!compared || finishKey(v.printing) === finishKey(compared)) && num(v.price) != null) ?? null
  const history = nmVariant?.priceHistory30d ?? nmVariant?.priceHistory ?? []
  const histT = history.map(h => h.t).filter(t => typeof t === 'number')
  const historyDays = histT.length ? Math.round(((Math.max(...histT) - Math.min(...histT)) / 86_400) * 10) / 10 : null

  const ourGraded = ourGradedLabels(ours.rows)
  const jtGradedEntries = (jtGraded?.variants ?? []).filter(v => v.type === 'graded' || v.grading).map(justtcgGradedEntry)
  const jtByLabel = new Map<string, JtGradedEntry>()
  for (const e of jtGradedEntries) if (e.ourLabel && !jtByLabel.has(e.ourLabel)) jtByLabel.set(e.ourLabel, e)
  const matched = ourGraded.filter(g => jtByLabel.has(g.label)).map(g => {
    const j = jtByLabel.get(g.label)!
    return { label: g.label, ourValue: g.value, ourSource: g.source, jtPrice: j.price, deltaPct: pctDelta(g.value, j.price) }
  })
  const ourLabelSet = new Set(ourGraded.map(g => g.label))
  const gradedAges = jtGradedEntries.map(e => e.updatedAt).filter((t): t is number => t != null)

  return {
    productId: ours.productId, tcgplayerProductId: ours.tcgplayerProductId, game: ours.game, name: ours.name,
    resolved: !!jtRaw, resolvedBy: jtRaw ? (opts.resolvedBy ?? 'tcgplayerId') : null,
    justtcg: { cardId: jtRaw?.uuid ?? jtRaw?.id ?? null, game: jtRaw?.game ?? null, set: jtRaw?.set_name ?? jtRaw?.set ?? null, variants: variants.length, english: english.length, languages },
    printings: { justtcg: jtPrintings, ourFinishKeys, unmapped, compared },
    raw: { ours: ladder, justtcgNm: num(nmVariant?.price), justtcgUpdatedAt: num(nmVariant?.lastUpdated), deltaPct: pctDelta(ladder.value, num(nmVariant?.price)) },
    tiers: {
      ours: ourTiers, justtcg: jtTiers, deltaPct,
      ourTierCount: Object.keys(ourTiers).length, justtcgTierCount: Object.keys(jtTiers).length,
      spread: {
        ours:    { LP_NM: ratio(ourTiers.LP, ourTiers.NM), MP_NM: ratio(ourTiers.MP, ourTiers.NM), HP_NM: ratio(ourTiers.HP, ourTiers.NM) },
        justtcg: { LP_NM: ratio(jtTiers.LP, jtTiers.NM),   MP_NM: ratio(jtTiers.MP, jtTiers.NM),   HP_NM: ratio(jtTiers.HP, jtTiers.NM) },
      },
    },
    trends: {
      priceChange24hr: num(nmVariant?.priceChange24hr), priceChange7d: num(nmVariant?.priceChange7d), priceChange30d: num(nmVariant?.priceChange30d),
      historyPoints: history.length, historyDays, ourPriceDailyDays: ours.priceDailyDays ?? null,
    },
    graded: {
      ours: ourGraded, justtcg: jtGradedEntries, matched,
      justtcgOnly: [...jtByLabel.keys()].filter(l => !ourLabelSet.has(l)),
      oursOnly: ourGraded.filter(g => !jtByLabel.has(g.label)).map(g => ({ label: g.label, source: g.source })),
      skipped: jtGradedEntries.filter(e => e.skipReason).map(e => ({ canonical: e.canonical, reason: e.skipReason! })),
      gradeLabelsSeen: [...new Set(jtGradedEntries.map(e => e.gradeLabel).filter((x): x is string => !!x))],
      qualifiersSeen:  [...new Set(jtGradedEntries.map(e => e.qualifier).filter((x): x is string => !!x))],
      companiesSeen:   [...new Set(jtGradedEntries.map(e => e.company).filter((x): x is string => !!x))],
    },
    freshness: {
      justtcgRawAgeDays: ageDays(num(nmVariant?.lastUpdated), now),
      justtcgGradedAgeDaysMin: gradedAges.length ? ageDays(Math.max(...gradedAges), now) : null,
      ourLadderAgeDays: ageDays(ours.rows.find(r => r.source === ladder.source && r.is_graded === 0 && r.grade == null)?.fetched_at ?? null, now),
    },
  }
}

// ── The summary (one row per game + totals) ────────────────────────────────────────────────────

export function median(values: Array<number | null | undefined>): number | null {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : Math.round(((v[m - 1] + v[m]) / 2) * 10) / 10
}

export interface GameSummary {
  game: string; sampled: number; resolved: number; resolvedPct: number
  withOurTiers: number; justtcg3PlusTiers: number; tierCoveragePct: number
  nmDeltaMedianPct: number | null; lpDeltaMedianPct: number | null; mpDeltaMedianPct: number | null; hpDeltaMedianPct: number | null
  rawHeadlineDeltaMedianPct: number | null
  withOurGraded: number; justtcgGraded: number; gradedCoveragePct: number; gradedLabelsMatched: number; gradedDeltaMedianPct: number | null
  justtcgOnlyLabels: string[]; oursOnlyLabels: string[]
  freshnessMedianDays: number | null; historyDaysMedian: number | null; priceChange24hrPresentPct: number
  unmappedPrintings: string[]; gradeLabelsSeen: string[]; qualifiersSeen: string[]; companiesSeen: string[]
}

const pct = (n: number, d: number): number => (d ? Math.round((n / d) * 1000) / 10 : 0)

export function summarise(list: ProductComparison[]): { games: GameSummary[]; totals: GameSummary } {
  const byGame = new Map<string, ProductComparison[]>()
  for (const c of list) (byGame.get(c.game) ?? byGame.set(c.game, []).get(c.game)!).push(c)
  const one = (game: string, cs: ProductComparison[]): GameSummary => {
    const resolved = cs.filter(c => c.resolved)
    const withOurTiers = cs.filter(c => c.tiers.ourTierCount >= 1)
    const jt3 = resolved.filter(c => c.tiers.justtcgTierCount >= 3)
    const withOurGraded = cs.filter(c => c.graded.ours.length >= 1)
    const jtGraded = cs.filter(c => c.graded.justtcg.length >= 1)
    const matchedDeltas = cs.flatMap(c => c.graded.matched.map(m => m.deltaPct))
    return {
      game, sampled: cs.length, resolved: resolved.length, resolvedPct: pct(resolved.length, cs.length),
      withOurTiers: withOurTiers.length, justtcg3PlusTiers: jt3.length, tierCoveragePct: pct(jt3.length, cs.length),
      nmDeltaMedianPct: median(cs.map(c => c.tiers.deltaPct.NM)), lpDeltaMedianPct: median(cs.map(c => c.tiers.deltaPct.LP)),
      mpDeltaMedianPct: median(cs.map(c => c.tiers.deltaPct.MP)), hpDeltaMedianPct: median(cs.map(c => c.tiers.deltaPct.HP)),
      rawHeadlineDeltaMedianPct: median(cs.map(c => c.raw.deltaPct)),
      withOurGraded: withOurGraded.length, justtcgGraded: jtGraded.length, gradedCoveragePct: pct(jtGraded.length, cs.length),
      gradedLabelsMatched: cs.reduce((n, c) => n + c.graded.matched.length, 0), gradedDeltaMedianPct: median(matchedDeltas),
      justtcgOnlyLabels: [...new Set(cs.flatMap(c => c.graded.justtcgOnly))].sort(),
      oursOnlyLabels: [...new Set(cs.flatMap(c => c.graded.oursOnly.map(o => `${o.label} (${o.source})`)))].sort(),
      freshnessMedianDays: median(cs.map(c => c.freshness.justtcgRawAgeDays)), historyDaysMedian: median(cs.map(c => c.trends.historyDays)),
      priceChange24hrPresentPct: pct(resolved.filter(c => c.trends.priceChange24hr != null).length, resolved.length),
      unmappedPrintings: [...new Set(cs.flatMap(c => c.printings.unmapped))].sort(),
      gradeLabelsSeen: [...new Set(cs.flatMap(c => c.graded.gradeLabelsSeen))].sort(),
      qualifiersSeen:  [...new Set(cs.flatMap(c => c.graded.qualifiersSeen))].sort(),
      companiesSeen:   [...new Set(cs.flatMap(c => c.graded.companiesSeen))].sort(),
    }
  }
  const games = [...byGame.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([g, cs]) => one(g, cs))
  return { games, totals: one('ALL', list) }
}
