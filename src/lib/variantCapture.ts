/**
 * variantCapture.ts — Session D-bis
 *
 * Shared, unit-testable helpers for capturing structured variant data from the live
 * Scrydex /{game}/v1/cards payload (One Piece / Gundam — each variant is its own
 * TCGPlayer product) and for routing Scrydex variant-data quality errors to the
 * variant_ingest_conflicts review queue instead of silently corrupting products.
 *
 * Confirmed payload shape (OP09-004, operator-captured):
 *   data.id                         -> card id (e.g. "OP09-004"); shared across every
 *                                      variant + printing -> NON-unique attribute.
 *   data.variants[].name            -> variant_kind, verbatim.
 *   data.variants[].images[].large  -> the variant's distinct image (type==='front').
 *   data.variants[].marketplaces[]  -> { name:'tcgplayer', product_id } bridge to
 *                                      products.tcgplayer_product_id.
 *   data.variants[].printings[]     -> which set(s) this variant belongs to.
 *
 * Modeling rule (decided, do not re-litigate):
 *   variant_kind <- variants[].name verbatim (NOT decomposed into a finish taxonomy).
 *   finish       <- variantFinish(name); matches the Session-D price-side vocabulary
 *                   (scrydexProcessor.deriveCanonicalPriceFields) so product-side and
 *                   price-side finish stay consistent. NOT derived by parsing variant_kind.
 *
 * Detection (groups by tcgplayer_product_id BEFORE any write):
 *   1. intra-payload : >=2 variants in the same response claim one product_id.
 *   2. cross-product : an incoming product_id already belongs to a DIFFERENT
 *                      canonical products row (different scrydex_card_id).
 *   Colliding variants do NOT write product/image; each is logged.
 */

export interface VariantEntry {
  cardId:       string | null   // data.id
  number:       string | null   // data.number
  variantName:  string          // variants[].name (defaults 'normal')
  tcgProductId: number          // marketplaces[tcgplayer].product_id
  imageUrl:     string | null   // variants[].images[front].large
  printings:    string | null   // joined variants[].printings (fallback card.printings)
  setCode:      string | null   // sets.code, if resolvable
}

/**
 * Finish per the modeling rule. Mirrors scrydexProcessor.deriveCanonicalPriceFields
 * so product-side `finish` equals the price-side `finish` for the same variant.
 *   'normal'/missing -> 'normal'; otherwise the variant name verbatim ('foil','altArt',…).
 */
export function variantFinish(variantName: string | null | undefined): string {
  return variantName && variantName !== 'normal' ? variantName : 'normal'
}

/** The variant's distinct front image (large, falling back to medium), or null. */
export function frontImageLarge(variant: any): string | null {
  const imgs: any[] = variant?.images ?? []
  const front = imgs.find((i: any) => i?.type === 'front')
  return front?.large ?? front?.medium ?? null
}

/** The TCGPlayer product_id from a variant's marketplaces[], or null. */
export function tcgProductIdOf(variant: any): number | null {
  const m = (variant?.marketplaces ?? []).find((x: any) => x?.name === 'tcgplayer')
  if (!m?.product_id) return null
  const id = parseInt(String(m.product_id), 10)
  return Number.isFinite(id) ? id : null
}

/** Join a printings[] array (strings or {code|name|id} objects) into a display string. */
export function joinPrintings(printings: any): string | null {
  if (!Array.isArray(printings) || printings.length === 0) return null
  const parts = printings
    .map((p: any) => (typeof p === 'string' ? p : (p?.code ?? p?.name ?? p?.id ?? '')))
    .map((s: any) => String(s).trim())
    .filter(Boolean)
  return parts.length ? parts.join(', ') : null
}

/**
 * Flatten a /cards response into one VariantEntry per variant that carries a
 * TCGPlayer product_id. Variants without a product_id are skipped here (the image
 * sync handles those via the card_number fallback).
 */
export function collectVariantEntries(cards: any[], setCode: string | null): VariantEntry[] {
  const entries: VariantEntry[] = []
  for (const card of cards ?? []) {
    for (const variant of (card?.variants ?? []) as any[]) {
      const tcgProductId = tcgProductIdOf(variant)
      if (tcgProductId === null) continue
      entries.push({
        cardId:       card?.id ?? null,
        number:       card?.number ?? null,
        variantName:  variant?.name ?? 'normal',
        tcgProductId,
        imageUrl:     frontImageLarge(variant),
        printings:    joinPrintings(variant?.printings ?? card?.printings),
        setCode,
      })
    }
  }
  return entries
}

/** Set of tcgplayer_product_ids claimed by >=2 entries in the SAME payload (intra-payload conflict). */
export function contestedProductIds(entries: VariantEntry[]): Set<number> {
  const counts = new Map<number, number>()
  for (const e of entries) counts.set(e.tcgProductId, (counts.get(e.tcgProductId) ?? 0) + 1)
  const out = new Set<number>()
  for (const [pid, n] of counts) if (n >= 2) out.add(pid)
  return out
}

// ─── SQL builders ─────────────────────────────────────────────────────────────

// Upsert a conflict row; dedupe on the (card, product, variant) triple. Status is
// NEVER overwritten, so a re-detected conflict refreshes its detail but does not
// re-open a row an admin already resolved/dismissed (and never duplicates an open one).
const CONFLICT_UPSERT_SQL = `
  INSERT INTO variant_ingest_conflicts
    (scrydex_card_id, tcgplayer_product_id, variant_name, variant_printing,
     image_large_url, set_code, status, detected_at)
  VALUES (?, ?, ?, ?, ?, ?, 'open', unixepoch())
  ON CONFLICT (scrydex_card_id, tcgplayer_product_id, variant_name) DO UPDATE SET
    variant_printing = excluded.variant_printing,
    image_large_url  = excluded.image_large_url,
    set_code         = excluded.set_code,
    detected_at      = excluded.detected_at`

export function conflictUpsert(db: D1Database, entry: VariantEntry): D1PreparedStatement {
  return db.prepare(CONFLICT_UPSERT_SQL).bind(
    entry.cardId ?? '',
    String(entry.tcgProductId),
    entry.variantName,
    entry.printings,
    entry.imageUrl,
    entry.setCode,
  )
}

// Capture structured variant fields onto the resolved product. Preserve-on-conflict:
// COALESCE(?, col) takes the incoming value when non-null, else keeps the existing one
// (never nulls an already-set value). No-op when the product row does not exist.
const CAPTURE_UPDATE_SQL = `
  UPDATE products SET
    scrydex_card_id = COALESCE(?, scrydex_card_id),
    variant_kind    = COALESCE(?, variant_kind),
    finish          = COALESCE(?, finish)
  WHERE tcgplayer_product_id = ?`

export function captureUpdate(db: D1Database, entry: VariantEntry): D1PreparedStatement {
  return db.prepare(CAPTURE_UPDATE_SQL).bind(
    entry.cardId,
    entry.variantName,
    variantFinish(entry.variantName),
    entry.tcgProductId,
  )
}

/**
 * Batch-load the existing `scrydex_card_id` (or null) for every entry's
 * tcgplayer_product_id in ONE query per 100 ids. Returns a map: present key ⇒ the
 * row exists (value = its scrydex_card_id or null); absent key ⇒ no product row yet.
 *
 * This replaces the old per-entry `SELECT … WHERE tcgplayer_product_id = ?` round-trip
 * (which was 100s of sequential D1 reads per set and blew the worker's waitUntil budget).
 */
export async function fetchExistingProducts(
  db:         D1Database,
  productIds: number[],
): Promise<Map<number, string | null>> {
  const map = new Map<number, string | null>()
  const ids = [...new Set(productIds)]
  // D1 caps bound parameters at 100 per statement — chunk well under that.
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90)
    const placeholders = chunk.map(() => '?').join(',')
    const { results } = await db.prepare(
      `SELECT tcgplayer_product_id AS pid, scrydex_card_id FROM products WHERE tcgplayer_product_id IN (${placeholders})`
    ).bind(...chunk).all<{ pid: number; scrydex_card_id: string | null }>()
    for (const r of results ?? []) map.set(Number(r.pid), r.scrydex_card_id ?? null)
  }
  return map
}

/**
 * Cross-product collision: the product_id already exists and belongs to a DIFFERENT
 * card (its scrydex_card_id is set and differs from this card's id). Pure / in-memory.
 */
export function isCrossProduct(
  existing:     Map<number, string | null>,
  tcgProductId: number,
  cardId:       string | null,
): boolean {
  if (!existing.has(tcgProductId)) return false
  const owner = existing.get(tcgProductId)
  return !!(owner && owner !== cardId)
}

export interface VariantPlan {
  statements: D1PreparedStatement[]
  captured:   number   // clean variants written
  conflicted: number   // variants routed to the conflict queue
  skipped:    number   // clean variants the cleanWrite callback declined (e.g. no base row)
}

/**
 * Shared conflict-routing + write planner used by BOTH the image-sync capture path
 * and the seed path. `existing` is the pre-fetched product_id → scrydex_card_id map
 * (see fetchExistingProducts). For each entry:
 *   - intra-payload contested OR cross-product collision -> conflict upsert (no write).
 *   - otherwise -> `cleanWrite(entry)` statements (capture/seed + image). An empty
 *     array from cleanWrite counts as skipped (not captured).
 */
export function planVariantWrites(
  db:         D1Database,
  entries:    VariantEntry[],
  existing:   Map<number, string | null>,
  cleanWrite: (entry: VariantEntry) => D1PreparedStatement[],
): VariantPlan {
  const contested = contestedProductIds(entries)
  const statements: D1PreparedStatement[] = []
  let captured = 0, conflicted = 0, skipped = 0

  for (const entry of entries) {
    if (contested.has(entry.tcgProductId) || isCrossProduct(existing, entry.tcgProductId, entry.cardId)) {
      statements.push(conflictUpsert(db, entry))
      conflicted++
      continue
    }
    const clean = cleanWrite(entry)
    if (clean.length === 0) { skipped++; continue }
    statements.push(...clean)
    captured++
  }

  return { statements, captured, conflicted, skipped }
}
