/**
 * productAttributes.ts — TCGCSV `extendedData` -> canonical `product_attributes` (Content mig 0125)
 *
 * The pure, unit-testable core of the card-attribute write path: extraction, sanitisation, the
 * change-detection hash, and the statement builders. `ingestion/db.ts syncProductAttributes()` is
 * the only caller; nothing here touches D1 state directly.
 *
 * Designed FROM the live diagnostic of all eleven enabled games — read it before changing any
 * constant in this file: `Content/docs/audits/2026-08-11_tcgcsv-extended-data-diagnostic.md`.
 *
 * THE FOUR RULES THIS FILE ENCODES
 *
 * 1. RAW KEYS, VERBATIM. TCGplayer's `extendedData[].name` is stored exactly as it arrives —
 *    `CardType` for Digimon, `Card Type` (with a space) for Pokemon, `RetreatCost` for Pokemon vs
 *    `Retreat Cost` for Pokemon Japan. Eleven games disagree about the spelling of the same
 *    concept, so a NEW game must ingest correctly with zero code change. Mapping raw keys onto
 *    display facets is a READ-side concern (Session 2's Content-side `attributeFacets.js`), kept
 *    there deliberately so a mapping correction is a deploy and not a 268k-product re-sync.
 *
 * 2. PROSE IS SKIPPED. `ATTRIBUTE_PROSE_KEYS` below. Those fields are ~12-27% of the rows but
 *    essentially all of the bytes (up to 2,903 chars/value across 260k cards), they are the ONLY
 *    fields that carry HTML and CR/LF, and nothing in this workstream reads them. Storing them
 *    later is a one-constant change + a re-sync — no schema change.
 *
 * 3. NEVER THROW. A missing, non-array, or structurally broken `extendedData` block yields an
 *    empty attribute list for that product and no error: the tier-resilient parser idiom. A
 *    malformed payload for one card must not fail its group's queue message and strand the set.
 *
 * 4. NEVER STORE A TRUNCATED VALUE. An over-long value is SKIPPED whole, not clipped — a
 *    half-stored `;`-delimited trait list would read as a real, wrong value to a filter. The cap is
 *    far above every observed kept value (the longest is Magic's 53-char `SubType` type line), so
 *    tripping it means the source changed shape and the omission is the honest outcome.
 *
 * 5. THE `@` NAMESPACE IS RESERVED FOR NON-TCGCSV SOURCES (2026-08-12, Session 3A).
 *    `product_attributes` is no longer single-writer: sources other than TCGCSV fill gaps TCGCSV
 *    provably cannot (the first is Magic mana cost + colour, which the 2026-08-11 diagnostic proved
 *    absent from `extendedData` in every era). Because THIS writer rewrites a product's rows as one
 *    atomic delete-then-insert group, an unscoped delete would silently wipe another source's rows
 *    on the next day the product's TCGCSV hash changed. So:
 *      • every non-TCGCSV key is stored as `@<source>.<field>` (`externalAttributeKey`);
 *      • the TCGCSV delete is scoped `name NOT LIKE '@%'` — it owns every un-namespaced key,
 *        including a NEW TCGplayer key it has never seen, so nothing of ITS OWN can ever strand;
 *      • an external writer deletes only `@<its source>.%` and NEVER stamps
 *        `products.extended_data_hash` (that column is TCGCSV's change guard, not a shared one);
 *      • TCGCSV may never write INTO the namespace — a raw `extendedData` key starting with `@` is
 *        dropped by `extractProductAttributes`, so provenance can't be forged from upstream.
 *    Full rationale + the rejected alternatives (a `source` column; a sibling table):
 *    `Content/docs/audits/2026-08-12_scrydex-mtg-attribute-fill-diagnostic.md` §2.
 */

export interface ProductAttribute {
  name:     string
  value:    string
  /** 0-based index in the source `extendedData` array — preserves TCGplayer's own ordering. */
  position: number
}

/** Longest value we will store. Observed max for a KEPT key is 53 chars (Magic `SubType`). */
export const ATTRIBUTE_VALUE_MAX = 512
/** Longest key we will store. Observed max is 18 chars (`DigimonAttribute`, `Digivolve1Level`). */
export const ATTRIBUTE_NAME_MAX = 64
/** Max attribute rows per product. Observed max key count on one product is 18. */
export const ATTRIBUTE_COUNT_MAX = 64

/**
 * First character of every key written by a source OTHER than TCGCSV (rule 5). TCGplayer has never
 * used it — verified against every key in the 11-game diagnostic — and `extractProductAttributes`
 * refuses to store one, so the two key spaces can never overlap.
 */
export const EXTERNAL_KEY_PREFIX = '@'

/** A source id may only be `[a-z0-9]+`: `_` and `%` are LIKE wildcards and would over-match. */
const SOURCE_ID_RE = /^[a-z0-9]+$/

/**
 * The stored key for one field of one external source: `@scrydex.mana_cost`.
 * Field names stay VERBATIM (rule 1 applies to every source) — the prefix is a namespace, not a
 * rename, and the read side matches on the whole key through `attributeFacets.js`.
 */
export function externalAttributeKey(source: string, field: string): string {
  if (!SOURCE_ID_RE.test(source)) {
    throw new Error(`attribute source id must match ${SOURCE_ID_RE} (got ${JSON.stringify(source)})`)
  }
  return `${EXTERNAL_KEY_PREFIX}${source}.${field}`
}

/** True for a key in the reserved non-TCGCSV namespace. */
export function isReservedAttributeKey(name: string): boolean {
  return String(name ?? '').startsWith(EXTERNAL_KEY_PREFIX)
}

/**
 * Normalised form of a key: lowercase, non-alphanumerics removed. Used ONLY for matching against
 * the prose skip list — the stored name is always the raw one. This is what makes `Flavor Text`
 * and `FlavorText`, or `Retreat Cost` and `RetreatCost`, compare equal.
 */
export function normalizeAttributeKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * Long prose / rules-text fields, in NORMALISED form. See rule 2 above.
 * `Attack 1`..`Attack N` (Pokemon, Pokemon Japan) are matched by the `attack<digits>` pattern in
 * `isProseAttributeKey` rather than enumerated, because the count varies by card.
 */
export const ATTRIBUTE_PROSE_KEYS: ReadonlySet<string> = new Set([
  'description',      // Digimon, DBS, F&B, Gundam, Lorcana, One Piece, Pokemon Japan, Riftbound, Yu-Gi-Oh!
  'oracletext',       // Magic
  'cardtext',         // Pokemon
  'flavortext',       // Magic (`FlavorText`), F&B / Lorcana / Pokemon Japan / Riftbound (`Flavor Text`)
  'inheritedeffect',  // Digimon
  'securityeffect',   // Digimon
  'disclaimer',       // Digimon
])

export function isProseAttributeKey(name: string): boolean {
  const key = normalizeAttributeKey(name)
  return ATTRIBUTE_PROSE_KEYS.has(key) || /^attack\d+$/.test(key)
}

const HTML_TAG_RE = /<[^>]*>/g
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
}

/**
 * Strip markup and collapse whitespace, without otherwise normalising the value.
 *
 * Tags become a SPACE (not ''), so `a<br>b` reads `a b` rather than `ab`. Entities are decoded
 * between two tag-strip passes so an entity-encoded tag (`&lt;br&gt;`) is also removed. Everything
 * else — casing, `;` delimiters, the literal string 'None', non-ASCII like `Frieza’s Army` — is
 * left exactly as TCGplayer sent it.
 *
 * Today NO kept field carries HTML (measured 0% across 3,207 products in eleven games); this runs
 * anyway because the source is not under our control and a future field could.
 */
export function sanitizeAttributeValue(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  let out: string
  try {
    out = String(raw)
  } catch {
    // A value whose String() throws (an exotic object with a hostile toString) is not worth
    // storing. Intentional swallow — rule 3: never fail the product over one field.
    return ''
  }
  out = out.replace(HTML_TAG_RE, ' ')
  out = out.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
  out = out.replace(HTML_TAG_RE, ' ')
  return out.replace(/[\s ]+/g, ' ').trim()
}

/**
 * Turn a raw `extendedData` block into the rows we will persist. Never throws (rule 3).
 *
 * Dropped, silently and by design: a non-array block; a non-object entry; a blank or over-long
 * key; a key in the reserved `@` namespace (rule 5 — TCGCSV must never be able to forge another
 * source's provenance); a prose key (rule 2); an empty value (nothing to store, and `value` is NOT
 * NULL); an
 * over-long value (rule 4); and any repeat of a key already seen — first occurrence wins, because
 * the table's PK is (product_id, name) and a duplicate inside one multi-row INSERT would abort the
 * whole atomic batch and fail the group.
 */
export function extractProductAttributes(extendedData: unknown): ProductAttribute[] {
  if (!Array.isArray(extendedData)) return []
  const out: ProductAttribute[] = []
  const seen = new Set<string>()

  for (let i = 0; i < extendedData.length; i++) {
    if (out.length >= ATTRIBUTE_COUNT_MAX) break
    const entry = extendedData[i] as { name?: unknown; value?: unknown } | null
    if (!entry || typeof entry !== 'object') continue

    const rawName = typeof entry.name === 'string' ? entry.name.trim() : ''
    if (!rawName || rawName.length > ATTRIBUTE_NAME_MAX) continue
    if (isReservedAttributeKey(rawName)) continue
    if (isProseAttributeKey(rawName)) continue
    if (seen.has(rawName)) continue

    const value = sanitizeAttributeValue(entry.value)
    if (!value || value.length > ATTRIBUTE_VALUE_MAX) continue

    seen.add(rawName)
    out.push({ name: rawName, value, position: i })
  }
  return out
}

/**
 * Deterministic content hash of a product's kept attributes — the change guard stored in
 * `products.extended_data_hash` (mig 0125).
 *
 * WHY: the daily `tcg-sync` re-upserts the entire catalogue every run. At ~7.9 attributes across
 * 268k products an unguarded delete-and-reinsert would write ~2.1M rows twice over, every day, for
 * data that never changes once a set is published. Comparing this hash makes the steady-state cost
 * ~zero and leaves the first post-deploy run as the backfill.
 *
 * Two independent FNV-1a-style 32-bit accumulators plus the serialised length. Only ever compared
 * old-vs-new for the SAME product, so the collision risk that matters is per-comparison, not
 * birthday-shaped. A collision would mean one product keeps stale attributes until its next real
 * change — not a correctness hazard elsewhere.
 */
export function attributesHash(attrs: readonly ProductAttribute[]): string {
  const s = attrs.map(a => `${a.position}${a.name}${a.value}`).join('')
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193)
    h2 = Math.imul(h2 ^ c, 0x85ebca6b)
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}:${s.length}`
}

/** The hash of a product with no storable attributes — sealed product, accessories, some promos. */
export const EMPTY_ATTRIBUTES_HASH = attributesHash([])

// ── Statement builders ───────────────────────────────────────────────────────
// D1 caps BOUND PARAMETERS at 100 per statement. An attribute row binds 4 (product_id, name,
// value, position), so a multi-row INSERT is chunked at 20 rows = 80 params — comfortably under
// the cap even if a future game exceeds today's 18-key maximum.
export const ATTRIBUTE_INSERT_ROWS_PER_STATEMENT = 20

// ⚠️ COEXISTENCE (rule 5): the TCGCSV delete is SCOPED to un-namespaced keys. It still clears every
// key TCGCSV owns — including one it has never seen before, so a new TCGplayer key can never strand
// — while leaving `@source.*` rows written by another filler untouched. Never widen it back to a
// bare `WHERE product_id = ?`: that is the delete-all that would wipe the other source's rows every
// time this product's `extended_data_hash` changed.
const DELETE_SQL          = `DELETE FROM product_attributes WHERE product_id = ? AND name NOT LIKE '${EXTERNAL_KEY_PREFIX}%'`
const DELETE_EXTERNAL_SQL = 'DELETE FROM product_attributes WHERE product_id = ? AND name LIKE ?'
const HASH_SQL            = 'UPDATE products SET extended_data_hash = ? WHERE id = ?'

/**
 * Clear a product's TCGCSV attribute rows (never another source's — see DELETE_SQL).
 * Always paired with the inserts in the SAME atomic batch.
 */
export function deleteAttributesStmt(db: D1Database, productId: number): D1PreparedStatement {
  return db.prepare(DELETE_SQL).bind(productId)
}

/** Clear ONE external source's rows for a product, and nothing else. */
export function deleteExternalAttributesStmt(
  db:        D1Database,
  productId: number,
  source:    string,
): D1PreparedStatement {
  // externalAttributeKey validates the source id; the `.` and `@` are LIKE-literal, and the
  // `[a-z0-9]+` shape guarantees no `_`/`%` wildcard can sneak into the pattern.
  return db.prepare(DELETE_EXTERNAL_SQL).bind(productId, `${externalAttributeKey(source, '')}%`)
}

/** Multi-row INSERTs for one product's attributes, chunked to stay inside D1's bound-param cap. */
export function insertAttributesStmts(
  db:        D1Database,
  productId: number,
  attrs:     readonly ProductAttribute[],
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = []
  for (let i = 0; i < attrs.length; i += ATTRIBUTE_INSERT_ROWS_PER_STATEMENT) {
    const slice = attrs.slice(i, i + ATTRIBUTE_INSERT_ROWS_PER_STATEMENT)
    const sql =
      'INSERT INTO product_attributes (product_id, name, value, position) VALUES ' +
      slice.map(() => '(?, ?, ?, ?)').join(', ')
    const binds: unknown[] = []
    for (const a of slice) binds.push(productId, a.name, a.value, a.position)
    stmts.push(db.prepare(sql).bind(...binds))
  }
  return stmts
}

/**
 * Stamp the change guard. MUST be the LAST statement of a product's group so a batch that never
 * commits leaves the old/NULL hash and the next run redoes the product (see mig 0125's ordering
 * contract). Never hoist this ahead of the inserts.
 */
export function stampAttributesHashStmt(
  db:        D1Database,
  productId: number,
  hash:      string,
): D1PreparedStatement {
  return db.prepare(HASH_SQL).bind(hash, productId)
}

/**
 * The full statement group for ONE product, in the only safe order:
 * delete -> insert(s) -> stamp hash. Callers must never split a group across two `db.batch()`
 * calls; a batch is the atomic unit.
 */
export function attributeStatementsForProduct(
  db:        D1Database,
  productId: number,
  attrs:     readonly ProductAttribute[],
  hash:      string,
): D1PreparedStatement[] {
  return [
    deleteAttributesStmt(db, productId),
    ...insertAttributesStmts(db, productId, attrs),
    stampAttributesHashStmt(db, productId, hash),
  ]
}

// ── External (non-TCGCSV) sources ────────────────────────────────────────────
// The store-side half of the coexistence contract (rule 5). A filler supplies a flat
// `{ field: value }` map of ITS OWN field names; this namespaces, sanitises and orders them, and
// builds a group that touches only that source's rows.

/**
 * Turn one external source's raw fields into storable rows. Never throws (rule 3): a field that is
 * absent, empty, non-scalar or over-long is simply not stored, so a card missing mana cost still
 * persists its colours. Values are kept VERBATIM apart from the shared HTML/whitespace sanitiser —
 * a mana-cost string stays `{2}{W}{U}`, and a list is joined with the `;` delimiter every other
 * multi-value in this table already uses, so `splitAttributeValues` reads it unchanged.
 *
 * `position` is the field's index in the caller's own list — the same "source order" contract the
 * TCGCSV rows carry, scoped to that source.
 */
export function buildExternalAttributes(
  source: string,
  fields: Readonly<Record<string, unknown>>,
): ProductAttribute[] {
  const out: ProductAttribute[] = []
  for (const [field, raw] of Object.entries(fields ?? {})) {
    if (out.length >= ATTRIBUTE_COUNT_MAX) break
    if (!field.trim()) continue
    const name = externalAttributeKey(source, field.trim())
    if (name.length > ATTRIBUTE_NAME_MAX) continue

    const value = Array.isArray(raw)
      ? raw.map(v => sanitizeAttributeValue(v)).filter(v => v !== '').join(';')
      : sanitizeAttributeValue(raw)
    if (!value || value.length > ATTRIBUTE_VALUE_MAX) continue

    out.push({ name, value, position: out.length })
  }
  return out
}

/**
 * The full statement group for ONE product from ONE external source: delete-own-namespace →
 * insert(s). Like the TCGCSV group it is atomic and must never be split across two `db.batch()`
 * calls; unlike it, there is **no hash stamp** — `products.extended_data_hash` vouches for the
 * TCGCSV rows alone, and stamping it here would make the daily sync skip a product whose TCGCSV
 * attributes it had never actually written. An external filler's own resumability is per-expansion
 * (`scrydex_expansion_freshness`), not per-product.
 *
 * A product with zero resolvable fields yields ONLY the delete — that is deliberate: it clears a
 * stale row set when the source stops carrying the data, and re-running is idempotent either way.
 */
export function externalAttributeStatements(
  db:        D1Database,
  productId: number,
  source:    string,
  attrs:     readonly ProductAttribute[],
): D1PreparedStatement[] {
  return [
    deleteExternalAttributesStmt(db, productId, source),
    ...insertAttributesStmts(db, productId, attrs),
  ]
}
