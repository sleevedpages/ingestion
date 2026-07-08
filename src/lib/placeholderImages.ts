/**
 * placeholderImages.ts — the ONE shared placeholder-image guard.
 *
 * WHY THIS EXISTS
 * Scrydex does not have real scans for every card. For those cards its image CDN
 * still returns HTTP 200 — serving a generic Pokémon **card-back placeholder**
 * (confirmed for the whole `cel25c` / "Celebrations: Classic Collection" sub-set,
 * 2026-07-08). Our pipeline treated that Scrydex URL as primary, so the card-back
 * overwrote the correct TCGplayer image in `product_images` and then got mirrored
 * into R2 — winning everywhere via `r2_url ?? source_url ?? snapshot`.
 *
 * The fix is byte-identity: a placeholder is placeholder bytes, whatever the size,
 * format, or URL. Both the image mirror (before any R2 write) and the
 * `purge-placeholder-mirrors` cleanup sweep (over existing R2 objects) hash the
 * bytes and reject/purge any hash in PLACEHOLDER_IMAGE_HASHES below.
 *
 * ── PLACEHOLDER_IMAGE_HASHES — provenance & how to append ─────────────────────
 * SHA-256 (hex) of every KNOWN Scrydex card-back placeholder body. Seeded from the
 * Step-0 investigation (2026-07-08, fetched live):
 *
 *   fd7c3800…ad2c  images.scrydex.com/pokemon/<any>/large   png  186,316 B  (current live /large)
 *   b69464a4…bbe9  images.scrydex.com/pokemon/<any>/medium  png   82,623 B  (current live /medium)
 *   01f03f71…c1c1  images.scrydex.com/pokemon/<any>/small   png   45,551 B  (current live /small)
 *   c4d4811d…cb21  images.sleevedpages.com/cards/250321.png png  172,520 B  (HISTORICAL card-back
 *                  already mirrored into R2 — Scrydex re-encoded its placeholder since, so this
 *                  differs from today's live /large and is only findable by the purge sweep)
 *
 * The impossible-card probe URL: https://images.scrydex.com/pokemon/base1-999999/large
 * returns the current /large placeholder — every real /large card-back hashes the same.
 *
 * TO APPEND A NEW HASH: download the offending R2 object or Scrydex URL, run
 *   node -e "const {createHash}=require('crypto');process.stdin.pipe(require('crypto').createHash('sha256').setEncoding('hex')).on('data',h=>console.log(h))"
 * (or `sha256sum`), confirm by eye it IS a card-back, and add the hex digest below
 * with a one-line note. Adding a false hash would purge a real card — verify first.
 * The mirror ALSO runs a live per-run fingerprint probe (image-mirror.ts) as a
 * second, self-updating line of defence for freshly re-encoded placeholders.
 */
export const PLACEHOLDER_IMAGE_HASHES: Set<string> = new Set<string>([
  'fd7c3800f9b8ebadf4b31a735f569a180e66201741b00fafa17879967884ad2c', // Scrydex /large  card-back (live 2026-07-08)
  'b69464a47d1a512acaad2f1fb473775eab711bdc554566638b78d62b0414bbe9', // Scrydex /medium card-back (live 2026-07-08)
  '01f03f71564c567abf1b8f38b87e16e42bd02ebbd77ddebb9671178646b1c1f5', // Scrydex /small  card-back (live 2026-07-08)
  'c4d4811d46dc037cbd3c00a1213bb047ea3b0eb9d63bddb5352ef83074c3cb21', // R2 cards/250321.png card-back (historical, in prod now)
])

/** SHA-256 → lowercase hex. Workers-native (crypto.subtle), no dependency. */
export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Pure, unit-testable placeholder decision. Accepts either raw image bytes (which
 * it hashes) or a precomputed lowercase-hex SHA-256. Returns true when the content
 * is a KNOWN placeholder. `extraHashes` folds in run-scoped hashes (e.g. the
 * mirror's live probe fingerprint) without mutating the shared constant.
 */
export async function isPlaceholderImage(
  input: ArrayBuffer | string,
  extraHashes?: Iterable<string> | null,
): Promise<boolean> {
  const hash = typeof input === 'string' ? input.toLowerCase() : await sha256Hex(input)
  if (PLACEHOLDER_IMAGE_HASHES.has(hash)) return true
  if (extraHashes) {
    for (const h of extraHashes) {
      if (h && h.toLowerCase() === hash) return true
    }
  }
  return false
}

/**
 * Reconstruct the operator-verified full-res TCGplayer CDN image URL for a product
 * from its `products.tcgplayer_product_id`. This is the exact `_in_1000x1000` form
 * `transformer.ts bumpTcgplayerImageRes()` produces and mig 0064 stored — the
 * original image that a Scrydex placeholder overwrote. `_1000x1000` without the
 * `_in_` infix is access-denied; `_in_1000x1000` returns 200. Returns null for a
 * missing/invalid id.
 */
export function tcgplayerFullImageUrl(tcgplayerProductId: number | null | undefined): string | null {
  if (tcgplayerProductId == null || !Number.isFinite(Number(tcgplayerProductId))) return null
  return `https://tcgplayer-cdn.tcgplayer.com/product/${tcgplayerProductId}_in_1000x1000.jpg`
}
