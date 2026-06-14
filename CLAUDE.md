# SleevedPages — Ingestion Worker

> **Session D done (2026-06-11) — the worker is now the CANONICAL writer.** It writes
> `canonical_games` / `sets` / `products` / `prices` / `product_images` (NOT the old `tcg_*`
> tables, which are frozen and kept only as the rollback path). Repoint map:
> `INGESTION_AUDIT.md`. Key changes:
> - TCGCSV pipeline (`ingestion/db.ts`): `upsertCategory/upsertSetsBatch/upsertProducts/upsertPrices`
>   resolve canonical ids by sub-select on the external UNIQUE keys. Products are written **before**
>   prices (`ingestion/index.ts` — canonical prices resolve `products.id` via sub-select; the old
>   parallel `Promise.all` would break the FK).
> - Scrydex price processor (`scrydexProcessor.ts`): writes canonical `prices` (source='scrydex')
>   keyed on `products.id`; condition/finish/grade/trend mapping mirrors migration 0060. Freshness
>   now uses the dedicated `scrydex_expansion_freshness` side table (migration 0063). **403-masking
>   fixed**: a 403/`CREDIT_CAP_HIT` marks the webhook `status='error'` and circuit-breaks the run.
> - Image surface → `product_images` via `src/lib/productImages.ts` (merge-upserts keyed on
>   resolved `products.id`; UNIQUE(product_id) from migration 0063). `uploadCardImage`,
>   `image-mirror.ts`, `scrydexImageSync.ts`, `backfillR2Urls.ts` all repointed.
> - **Session D-bis (DONE 2026-06-12):** `seedVariantProducts` (W22) now writes canonical
>   `products` (+ `product_images` + `variant_ingest_conflicts`) — it was the last `tcg_*`
>   writer, so **NO worker path writes `tcg_*` anymore.** `scrydex_card_id` / `variant_kind`
>   / `finish` are captured on variant products from the live `/cards` payload; per-variant
>   images are keyed on the `tcgplayer_product_id` bridge (the variant-image-pull fix); and
>   Scrydex variant-data collisions route to a `variant_ingest_conflicts` review queue
>   instead of silently corrupting products. See **Variant Capture (Session D-bis)** below.
> - **`SCRYDEX_MONTHLY_LIMIT`** must be set to the true cap (code default 5000 is correct).

## What this is
A Cloudflare Worker that handles two jobs:
1. **TCG data sync** — pulls card/set/price data from TCGCSV into D1 daily
2. **Image mirroring** — fetches card images from Scrydex CDN and TCGPlayer, stores them in R2

Shares the same D1 database (`sleevedpagesdb`) and R2 bucket (`sleeved-pages-images`) as the Content app.

## Tech Stack
- **Runtime**: Cloudflare Workers (TypeScript)
- **Database**: Cloudflare D1 — `sleevedpagesdb` (binding: `DB`)
- **Storage**: Cloudflare R2 — `sleeved-pages-images` (binding: `IMAGES_BUCKET`)
- **Queue**: Cloudflare Queues — `sleevedpages-sync-queue` (binding: `SYNC_QUEUE`)
- **Data source**: TCGCSV API (`https://tcgcsv.com`) for card/set/price data

## Commands
```bash
npm run dev          # wrangler dev (port 8788)
npm run deploy       # Deploy to Cloudflare Workers
npm run typecheck    # tsc --noEmit
npm run test         # vitest run
npm run migrate:remote  # Apply pending D1 migrations (production)
npm run migrate:local   # Apply pending D1 migrations (local)

# Local image mirror script (bypasses CDN IP blocks)
node scripts/mirror-local.mjs
node scripts/mirror-local.mjs --scrydex-only   # Pokémon + One Piece high-res pass first
node scripts/mirror-local.mjs --batch 100 --concurrency 10
```

## Project Structure
```
src/
  worker.ts              # Entry point: fetch handler, cron handler, queue consumer
  image-mirror.ts        # R2 image mirroring logic + HTTP endpoint helpers
  scrydexProcessor.ts    # Process pending scrydex_webhook_log rows → upsert scrydex_prices
  scrydexSetMapping.ts   # Sync Scrydex expansion catalog → populate tcg_sets.scrydex_set_id
  scrydexImageSync.ts    # Write Scrydex image URLs to tcg_products before R2 mirror
  run.ts                 # Local dev runner (not deployed)
  ingestion/
    index.ts          # runIngestion() orchestrator
    categories.ts     # Sync TCGPlayer categories (games)
    sets.ts           # Sync TCGPlayer sets
    products.ts       # Sync cards/products + extended data
    prices.ts         # Sync market prices
    db.ts             # D1 upsert helpers
    scheduler.ts      # Decides which sets need re-sync
    transformer.ts    # Maps TCGCSV API shapes to DB rows
    http.ts           # Fetch wrapper with retries
    logger.ts         # Structured JSON logger (LOG_LEVEL env var)
    price-config.ts   # Which games/sets to sync prices for
  lib/
    scrydexClient.ts  # Scrydex API fetch wrapper — credit guard + scrydex_api_log logging
    scrydexUrl.ts     # URL builders for Scrydex/Scrydex image CDN
    scrydexSets.ts    # set name → scrydex_expansion_id lookup map
    productImages.ts  # Session D: canonical product_images merge-upsert helpers (r2/source_url, keyed on products.id)
  types/
    db.ts             # D1 row types
    tcgcsv.ts         # TCGCSV API response types

scripts/
  mirror-local.mjs    # Fetches images from local IP → uploads to Worker → R2

db/migrations/
  001_initial.sql             # Core schema: tcg_categories, tcg_sets, tcg_products, tcg_prices, tcg_sync_log
  0002_queue_tracking.sql     # Queue-based sync tracking
  0003_supported_games.sql    # Supported games list
  0004_skrydex_image_mirror.sql  # (historical filename) Adds tcg_sets.skrydex_set_id, later renamed to scrydex_set_id by Content migration 0055
  0005_image_source.sql       # Adds tcg_products.image_source column
```

## Cron Schedule

**Production** (`[triggers]` in `wrangler.toml`):
| Cron | Job |
|------|-----|
| `0 6 * * *` | Daily TCG data sync (categories → sets → products → prices) |
| `0 3 * * SUN` | Weekly: `syncScrydexSetMappings` → `syncScrydexImages` → `runMirrorJob` (Infinity batches) → `scrydex_api_log` cleanup (90-day retention) |
| `0 4 * * *` | **DAILY** Scrydex webhook drain → upsert canonical `prices` (dedup by expansion; 20h freshness). **Was `*/10`** — moved to daily for cost control (2026-06; see Price Processing). |

**UAT** (`[env.preview.triggers]` in `wrangler.toml`) — **Scrydex crons are permanently absent**:
| Cron | Job |
|------|-----|
| `0 6 * * *` | Daily TCG data sync only |

The `0 3 * * SUN` and `0 4 * * *` (Scrydex) crons are not registered in the UAT environment. UAT card data is sourced from a weekly prod → UAT sync; Scrydex API calls from UAT would consume production credits. The Content App webhook handler (`/api/webhooks/scrydex`) remains active in UAT for endpoint testing. **Do not add Scrydex crons back to `[env.preview.triggers]`.**

## HTTP Endpoints
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | None | Health check |
| `POST` | `/sync` | None | Manual trigger for TCG data sync (non-blocking) |
| `POST` | `/mirror` | None | Manual trigger for image mirror (1 batch) |
| `GET` | `/mirror/pending?limit=N&scrydex_only=1` | None | Next N cards needing mirroring |
| `POST` | `/mirror/upload` | None | Upload image bytes → R2 (used by mirror-local.mjs) |
| `POST` | `/scrydex/process` | `x-worker-secret` | Process pending webhook log rows |
| `POST` | `/scrydex/sync-sets` | `x-worker-secret` | Pull Scrydex expansion catalog → update `scrydex_set_id` |
| `POST` | `/scrydex/sync-images` | `x-worker-secret` | Write Scrydex image URLs + capture variant fields to canonical `products`/`product_images` |
| `POST` | `/scrydex/sync-set` | `x-worker-secret` | **Blocking** per-set sync — body `{ setId \| scrydexExpansionId, force? }`; fetches that set's expansion ONCE and writes canonical prices (raw+graded) + images for it; credit-guarded; skips when both price types are fresh (unless `force`); marks the expansion fresh on success; returns `{ ok, skipped?, cardsFetched, pricesUpserted, imagesUpdated, variantsMatched, variantsConflicted, requests }`. See **Per-Set Sync** below. |
| `POST` | `/scrydex/refresh-card` | `x-worker-secret` | **Blocking** vendor on-demand refresh — body `{ product_id }`; fetches the expansion but upserts raw+graded prices for **only the target card** (matched by `tcgplayer_product_id`/number), does NOT mark the expansion fresh; returns `{ ok, pricesUpserted, requests }` |
| `POST` | `/scrydex/vision-identify` | `x-worker-secret` | **Blocking** Scrydex Vision card identify (§4 #7) — `multipart/form-data` `image` + optional `games` (csv). Calls `scrydexVisionIdentify()` (credit guard + **5-credit** `scrydex_api_log` debit); returns `{ ok, analysis, matches }` (403/cap → 502 `{ok:false,status:403}` so the caller falls back to Claude). Content proxies this **admin-only** for the scanner. |
| `GET` | `/tcggo/graded-prices?tcgplayerId=...` | `x-worker-secret` | tcggo (RapidAPI `pokemon-tcg-api.p.rapidapi.com`) eBay-sold graded medians. Needs **`TCGGO_RAPIDAPI_KEY`** (NOT Scrydex). Calls `/cards?tcgplayer_id=...` with `x-rapidapi-key`, reads `prices.ebay.graded[company][grade]` → returns `{ ok, tcgplayerId, graded:{psa,bgs,cgc}|null, source:'tcggo' }`. 404/no graded → `graded:null`. `src/lib/tcggoClient.ts`. Content proxies this **admin-only** + KV-caches 24h (free-tier protection). |

Scrydex endpoints are called from the Admin panel via Content app proxy (`POST /api/admin/scrydex/trigger`). Direct calls require `x-worker-secret: <INGESTION_WORKER_SECRET>` header.

## Data Sync Pipeline
`runIngestion()` flow:
1. Fetch all categories from TCGCSV → upsert `tcg_categories`
2. For each supported game: fetch sets → upsert `tcg_sets`
3. For each set that needs re-sync (scheduler): fetch products → upsert `tcg_products`
4. Fetch prices for configured games → upsert `tcg_prices`
5. Uses Cloudflare Queue to fan out per-set work (up to 10 groups per consumer invocation)

Supported games are controlled by `tcg_categories` and `price-config.ts`. Currently: Pokémon, One Piece.

## Image Mirror Pipeline
`runMirrorJob()` / `mirrorCard()` flow per card:

**Attempt 1 — Scrydex CDN (Pokémon only)**
- URL: `https://images.scrydex.com/pokemon/{scrydex_set_id}-{formattedNumber}/large`
- Requires `tcg_sets.scrydex_set_id` to be populated (set in Admin UI)
- Card number formatting (always splits on `/` first — handles TCGPlayer `number/total` format):
  - TG/GG gallery prefixes: pad numeric part to 2 digits (`TG6` → `TG06`)
  - All other letter prefixes (RC, SV, PR, …): raw digits, no padding (`RC2/RC32` → `RC2`)
  - Pure numeric: strip leading zeros (`025/165` → `25`)
- RC (Radiant Collection) cards share their parent set's `scrydex_set_id` (e.g. Generations RC → `g1`)
- One Piece Scrydex support is deferred — alternate versions use non-sequential identifiers that don't map to TCGPlayer card numbers

**Attempt 2 — TCGPlayer CDN fallback**
- Uses the TCGPlayer source url stored in `product_images.source_url`
- Worker datacenter IPs are **blocked (403)** by `tcgplayer-cdn.tcgplayer.com`
- Use `mirror-local.mjs` instead for TCGPlayer images

### TCGPlayer fallback image resolution (`_in_1000x1000`)
TCGCSV serves TCGPlayer card images as low-res `_200w` thumbnails. `transformer.ts`
`bumpTcgplayerImageRes()` rewrites them to the operator-verified `_in_1000x1000` form
before they land in `product_images.source_url` (the only image source for TCGPlayer-only
games — One Piece, Gundam — that have no Scrydex coverage). Existing rows were migrated
by Content migration `0064`. `_1000x1000` without the `_in_` infix is access-denied — do
not use it.

**Deliberate decision — do NOT mirror TCGPlayer images to R2.** The size guard in
`image-mirror.ts` / `mirror-local.mjs` (~300 KB) rejects these small/`_in_1000x1000`
TCGPlayer images on all paths, so TCGPlayer cards render from `source_url` (CDN) via the
app's `r2_url ?? source_url` resolution — never from R2. This is intentional, not an
oversight: TCGPlayer's `_in_1000x1000` images carry a "SAMPLE" watermark on most
alt-art/variant cards, so self-hosting them in R2 would spend storage to mirror a
watermarked asset we can serve from the CDN for free (end-user browsers render the
TCGPlayer CDN fine — only worker datacenter IPs are 403-blocked). Do not scope the guard
to "fix" TCGPlayer mirroring. The Scrydex image path is unchanged and remains preferred
where it has coverage.

**Storage**: `cards/{tcgplayer_product_id}.{ext}` in R2
**Public URL**: `https://images.sleevedpages.com/cards/{id}.{ext}`
**DB update**: sets `tcg_products.image_url` to R2 URL + `tcg_products.image_source` to `'scrydex'` or `'tcgplayer'`

## Local Mirror Script (`scripts/mirror-local.mjs`)
Fetches images from your local machine's IP (bypasses CDN blocks) and hands bytes to the Worker:
1. `GET /mirror/pending` → batch of cards needing mirroring
2. For each card: fetch image locally (Scrydex or TCGPlayer)
3. `POST /mirror/upload` → Worker writes bytes to R2, updates D1

Handles both Pokémon (Scrydex + TCGPlayer fallback) and One Piece (Scrydex + TCGPlayer fallback).

`--scrydex-only` flag filters to Pokémon + One Piece cards with a Scrydex set mapping — use this first to get high-res images before the TCGPlayer pass.

## Scrydex Integration

### scrydexClient.ts — API Wrapper (required for all outbound calls)
`src/lib/scrydexClient.ts` is the single entry point for every outbound Scrydex API call in the Ingestion worker. **No file may call the Scrydex API directly** — all calls go through `scrydexFetch()`.

Key exports:
- `scrydexFetch(env, endpoint, jobName, options?)` — authenticated fetch with credit guard + logging. Returns `Response`. Throws `ScrydexCreditLimitError` when guard trips.
- `ScrydexCreditLimitError` — named error class; catch with `instanceof` in expansion/set loops and break out gracefully.
- `cleanupScrydexApiLog(db)` — deletes rows older than 90 days; called from weekly cron.
- `scrydexVisionIdentify(env, image, games?)` — **Scrydex Vision** (`POST /vision/v1/cards/identify`,
  premium **5 credits/request**). Multipart (image Blob + optional comma-separated `games` scope). Goes
  through the same monthly credit guard + `scrydex_api_log` accounting (debits 5). Returns the raw
  `Response` so the caller applies its own 403/circuit handling. Used by the worker's
  `/scrydex/vision-identify` endpoint (Content scanner proxies it admin-only — see Content/CLAUDE.md
  "Scrydex Vision Scanner").

Credit guard: blocks calls when `scrydex_api_log` shows ≥ `SCRYDEX_MONTHLY_LIMIT - 500` credits used this month. Guard inserts a `status='blocked'` row and throws — never crashes the worker.

### Cards endpoint query — `lib/scrydexCards.ts` (CRITICAL, fixed 2026-06-12)
The Scrydex `/{game}/v1/cards` endpoint filters by a **Lucene `q` query** and paginates with
**`page`/`pageSize`** — NOT the `expansion`/`limit` params the worker historically sent. Scrydex
**silently ignores** unknown params, so `?expansion=<id>&limit=500` returned the default first page
(~100 cards) of the WHOLE game, every time. That capped every per-expansion pull (prices, images,
seed) at ~100 cards/game — the long-standing reason coverage was tiny.

**Always fetch cards via `fetchAllExpansionCards(env, gameSlug, expansionId, jobName, includePrices?)`**
(`lib/scrydexCards.ts`). It sends `q=expansion.id:<expansionId>` + `pageSize=250` + `page=N`, and
**paginates on `response.totalCount`** (not `batch.length < pageSize`, so a server-capped page size
still completes). Returns `{ cards, requests }` (requests = credits). Throws `ScrydexCardsError`
(carries `.status`) on non-OK → callers circuit-break on 403. Used by `scrydexProcessor` (prices),
`scrydexImageSync`, `seedVariantProducts`, `backfillVariantImages`. The `expansionId` must be a real
Scrydex expansion id (e.g. `OP09`, `GD04`), which is what `q=expansion.id:` matches.

> The `/expansions` endpoint (`scrydexSetMapping`) still sends `limit:'500'` — same ignored-param
> risk; if a game has >100 expansions only the first page is mapped. Manual mappings cover the gap
> today; convert to `pageSize`/`page` if full auto-mapping is needed.

### Set Mapping
- `tcg_sets.scrydex_set_id` maps a TCGPlayer set to its Scrydex expansion identifier
- **Auto-populated weekly** by `syncScrydexSetMappings()` in `src/scrydexSetMapping.ts`
  - Fetches Scrydex expansion catalog for all 6 games (6 credits/week)
  - Matches by: `tcg_sets.abbreviation` = Scrydex `code`/`ptcgo_code` (priority), then normalised name
- Can also be set manually via Admin UI → Scrydex Set Mappings
- Lookup map for known Pokémon sets still in `src/lib/scrydexSets.ts` (used by image mirror)
- Radiant Collection (RC) cards share the parent set's `scrydex_set_id` (e.g. `g1` for Generations)

### Price Processing — DAILY BATCH (cost control, 2026-06)
- Scrydex sends webhooks to Content app at `/api/webhooks/scrydex`; the handler is instant —
  only logs to `scrydex_webhook_log` (status `'pending'`).
- **The worker drains pending rows ONCE DAILY (`0 4 * * *`)** via `processPendingWebhooks()` — moved
  off the old `*/10` cron. **Why:** measured usage showed card-fetch calls dominated by **Pokémon
  (3,426, ~80%)**, driven by price *volatility × webhook frequency*, not set count. The daily batch
  collapses a day's redundant change-notifications into **one fetch per distinct expansion**, attacking
  the Pokémon concentration directly without throttling any game.
  - **Dedup by expansion:** the drain groups all pending rows by distinct `(gameSlug, priceType,
    expansion)`, fetches each ONCE, then marks ALL rows referencing it complete (incrementally, so a
    `waitUntil` cut-off loses no progress). Bounded by `SCRYDEX_DRAIN_MAX_FETCHES` (default 1500 page-calls);
    overflow rows stay pending for the next run / a manual `POST /scrydex/process`.
  - Primary match: `variant.marketplaces[tcgplayer].product_id` → canonical `products.tcgplayer_product_id`;
    fallback `card.number` + `scrydex_expansion_id` join. Batches at 100 statements per `DB.batch()`.
- **⚠️ FRESHNESS↔DRAIN COUPLING (invariant):** `SCRYDEX_PRICE_FRESHNESS_HOURS` (default 20h) MUST stay
  **< the 24h drain interval** (`DRAIN_INTERVAL_HOURS`). If it ever reaches ≥24h, every daily run no-ops
  against its own prior run and **prices silently freeze**. `freshnessSafeForDrain()` logs a loud error if
  violated. Freshness uses the `scrydex_expansion_freshness` side table (migration 0063) and also gives
  **resumability** (a cut-off run leaves fetched expansions marked fresh).
- **`SCRYDEX_PRICE_GAMES` is deliberately NOT applied** — it would only save credits by throttling
  Pokémon (the high-volatility primary game), which is unacceptable. The daily batch is the lever. The env
  var is kept available + documented as an emergency escape hatch only.
- **Vendor on-demand refresh** (`refreshCardPrices` / `POST /scrydex/refresh-card`): the release valve for
  the daily default. Fetches the card's expansion but upserts raw+graded for **only the target card**
  (matched by `tcgplayer_product_id`, then number) — NOT the whole expansion (that was ~1000 sequential D1
  reads / ~2min and is why the button hung). It does **NOT** mark the expansion fresh (that would suppress
  the daily refresh for every other card in the set). Content gates it (vendor access + ownership + 1/hour
  rate limit) and proxies here. See Content/CLAUDE.md.

### Image Sync
- `syncScrydexImages()` runs weekly before the R2 mirror job; writes `product_images.source_url`
- One Piece + Gundam: each variant has a unique TCGPlayer product_id → write `variant.images[front].large`
  keyed on the `tcgplayer_product_id` bridge (per-variant), AND capture `scrydex_card_id`/
  `variant_kind`/`finish` + route collisions (see **Variant Capture (Session D-bis)**)
- All other games: variants share a product_id → use `card.images[front].large`, match via `tcgplayer_group_id`
- Image writes go through `product_images` (`r2_url ?? source_url`); never the frozen `tcg_*`
- **Set pre-filter**: only fetches API data for sets that still have at least one product without an R2 image URL. Once a set is fully mirrored, it is skipped entirely — saving 1 credit per already-synced set per weekly run (352 mapped sets in production → near-zero cost after initial R2 backfill).

### Variant Capture (Session D-bis)

`src/lib/variantCapture.ts` is the shared, unit-tested core used by both `syncScrydexImages`
(One Piece / Gundam path) and `seedVariantProducts`. It captures structured variant data
from the live `/{game}/v1/cards` payload and routes Scrydex variant-data quality errors to
the `variant_ingest_conflicts` review queue.

**Confirmed payload shape** (operator-captured OP09-004, 8 variants):
- `data.id` — the card id, a printed-number string (e.g. `"OP09-004"`). **There is no separate
  `scrydex_card_id` field — the card id IS `data.id`.** It is **shared across printings**
  (OP09-004 appears in OP09 / OP13 / PRB02 via `data.printings`) and across every variant, so
  `products.scrydex_card_id` is a **non-unique attribute, never a key** (migration 0065 dropped
  its UNIQUE constraint).
- `data.variants[]` each carries: `name` (→ `products.variant_kind` verbatim), `images[].large`
  (distinct per variant, `type==='front'` → the variant's image), `marketplaces[]` where
  `name==='tcgplayer'` → `product_id` (the bridge to `products.tcgplayer_product_id`), and
  `printings[]` (which set(s) the variant belongs to).

**Modeling rule (decided):** `variant_kind ← variants[].name` verbatim (NOT decomposed into a
finish taxonomy — One Piece/Gundam variant cards are always foil). `finish ← variantFinish(name)`,
which mirrors `scrydexProcessor.deriveCanonicalPriceFields` so product-side `finish` equals the
price-side `finish` for the same variant. All captured fields are written **preserve-on-conflict**
(`COALESCE` — a populated value is never nulled).

**Conflict detection** (groups by `tcgplayer_product_id` BEFORE any write):
1. **intra-payload** — ≥2 variants in one `/cards` response claim the same `tcgplayer_product_id`
   (confirmed real: OP09-004 `wantedPoster`/OP13 and `goldSpecialAltArt`/PRB02 both = `657442`).
   None of the colliding variants auto-write; each is logged.
2. **cross-product** — an incoming variant's `tcgplayer_product_id` already belongs to a different
   canonical `products` row (different `scrydex_card_id`). Not overwritten; logged.

**Base-row resolution (seed):** the printed card code (e.g. `GD04-001`, `OP09-004`) lives in
Scrydex **`card.id`**, NOT `card.number` (which is the bare/short form). `products.number` stores
the full printed code, so `seedVariantProducts` resolves the base row by `card.id` first, then
falls back to `card.number`. (Matching on `card.number` alone was the long-standing reason variant
seeding produced 0 rows — `card.number` never equals the stored `GD04-001`-style number.)

**Performance (learned the hard way on the live prod run):**
- Many canonical sets share ONE `scrydex_expansion_id` (non-unique expansion ids + manual
  mappings). `seedVariantProducts` therefore iterates **distinct expansions, not sets** (GROUP BY
  `scrydex_expansion_id`) and resolves base rows **game-wide** (`fetchBasesByNumber` by `game_id`),
  so one fetch + scan covers every set sharing the expansion. `syncScrydexImages` caches `/cards`
  by `scrydex_set_id` and captures each expansion once (`capturedExpansions` guard). Per-set
  iteration re-fetched + re-scanned the same data ~80× → wasted credits + `waitUntil` cancellation.
- The cross-product check (`fetchExistingProducts`) and base lookups (`fetchBasesByNumber`) are
  **batched — one `IN (…)` query per 90 keys**. Chunk at **≤90, not 100**: D1 caps bound
  parameters at **100 per statement** (`fetchBasesByNumber` also binds `game_id`, so 90+1).
- **Resumable.** A full seed still exceeds the worker `waitUntil` budget (~25 expansions/invocation),
  so each expansion is marked in `scrydex_expansion_freshness` (`price_type='seed'`) after its writes
  succeed; a re-run skips marked expansions. Re-run `/admin/seed-variant-products` until the seeded
  count stops climbing (`SELECT COUNT(*) FROM scrydex_expansion_freshness WHERE price_type='seed'`).
  Force a re-seed by deleting the `'seed'` rows. **For One Piece/Gundam the seed alone delivers
  per-variant images + structured fields, so `sync-images` is optional/redundant for those games.**

Colliding variants do NOT write product/image — they upsert into `variant_ingest_conflicts`
(deduped on the `(scrydex_card_id, tcgplayer_product_id, variant_name)` triple; re-running never
duplicates an open conflict nor re-opens a resolved/dismissed one). Non-colliding (the clean
majority) capture + image normally. Resolution is via the Content admin **Variant Conflicts**
panel (`/api/admin/variant-conflicts`), where reassigning a conflict applies its
`scrydex_card_id`/`variant_kind`/`finish`/image to the chosen product.

### HTTP Endpoints (admin-triggered, require `x-worker-secret` header)
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/scrydex/process` | Process pending webhook log rows |
| `POST` | `/scrydex/sync-sets` | Pull Scrydex expansion catalog → update `scrydex_set_id` |
| `POST` | `/scrydex/sync-images` | Write Scrydex image URLs + capture variant fields to canonical `products`/`product_images`; route collisions to `variant_ingest_conflicts` |
| `POST` | `/scrydex/sync-set` | **Blocking** per-set sync (cards + prices + images for one expansion); see **Per-Set Sync** |
| `POST` | `/admin/seed-variant-products` | Mint per-variant canonical `products` rows (+ capture + images + conflict routing) |

### Per-Set Sync (`src/scrydexSyncSet.ts` — `POST /scrydex/sync-set`)

On-demand sync of a **single set** (cards + prices + images for that set's Scrydex
expansion) so the operator can bulk-update one set without a full-game sync. **Blocking** —
returns the result counts so the Admin UI can show them.

- **Input:** `{ setId | scrydexExpansionId, force? }`. `setId` = canonical `sets.id`;
  `scrydexExpansionId` = `sets.scrydex_expansion_id` (e.g. `sv08`, `OP09`). When several
  canonical sets share one expansion id, the lowest `sets.id` is resolved — the single
  expansion fetch covers them all.
- **Reuses the existing machinery (no new fetch/writer logic):** `fetchAllExpansionCards()`
  (q=expansion.id + page/pageSize) for ONE paginated fetch; `buildPriceUpserts()` for
  canonical `prices` (raw + graded, source='scrydex', R1 product_id → R2 number fallback);
  the `variantCapture` + `productImages` helpers for canonical `products` capture +
  `product_images` (OP/Gundam per-variant capture + conflict routing; all other games
  card-level image by group+number). **CANONICAL ONLY** — no `tcg_*` writes (those tables
  were DROPPED in migration 0066).
- **Credit-guarded** (via `scrydexFetch`'s monthly guard) + 403 circuit breaker. Respects
  `SCRYDEX_MONTHLY_LIMIT`.
- **Freshness / resumability:** skips when BOTH `raw` and `graded` are inside the freshness
  window (`scrydex_expansion_freshness`), unless `force:true`. Marks the expansion fresh for
  **both** price types on success, so the next daily drain dedups it away.
- **Returns:** `{ ok, skipped?, setId, setName, scrydexExpansionId, game, cardsFetched,
  pricesUpserted, imagesUpdated, variantsMatched, variantsConflicted, variantsUnmatched,
  requests }`. Emits a structured `{"log":"scrydex_sync_set",…}` line.
- **Admin UI:** Content **Admin → Image Audit → "Sync a Single Set"** (game → set picker;
  only sets with a Scrydex expansion are listed; a Force checkbox). Proxied admin-only via
  Content `POST /api/admin/scrydex/sync-set` (`data.userId === ADMIN_USER_ID` +
  `INGESTION_WORKER_SECRET`).
- **Local invocation** (direct, requires the secret):
  ```bash
  curl -X POST "$INGESTION_WORKER_URL/scrydex/sync-set" \
    -H "x-worker-secret: $INGESTION_WORKER_SECRET" -H 'content-type: application/json' \
    -d '{"scrydexExpansionId":"sv08","force":true}'
  # or by canonical set id:  -d '{"setId":5}'
  ```
- Tests: `src/scrydexSyncSet.test.ts` (happy path → canonical writes + freshness marked;
  set-not-found; fresh-skip; force bypass; credit-guard short-circuit).

### Drain credit audit (`processPendingWebhooks` — §4 #8, measure-first)

The daily drain emits a structured audit line each run for credit observability (parse from
`wrangler tail` / Logpush):
```json
{"log":"scrydex_drain_audit","rows_in":N,"distinct_expansions":M,"expansions_fetched":F,
 "fetches_made":C,"fetches_skipped_fresh":S,"rows_completed":...,"rows_left_pending":...,
 "circuit_broken":false,"max_fetches":1500,"freshness_hours":20,"credits_by_game":{"pokemon":C}}
```
`rows_in` vs `distinct_expansions` quantifies the **dedup collapse** (M webhook rows → 1 fetch
per distinct `(gameSlug, priceType, expansion)`); `fetches_made` (page-calls = credits) vs
`fetches_skipped_fresh` shows the freshness savings; `credits_by_game` confirms the measured
Pokémon concentration. The `SCRYDEX_DRAIN_MAX_FETCHES` bound and the `freshnessSafeForDrain()`
<24h invariant were **audited and confirmed correct** (no code change needed beyond the log).
**Measured velocity** (pre-existing analysis): card-fetch calls were dominated by **Pokémon
(~3,426, ~80%)** before the daily batch; with daily dedup a run's `fetches_made` is bounded by
the number of distinct volatile expansions, not webhook volume — read the live per-run figure
from `credits_by_game` in the audit line.

## Environment Variables
| Var | Default | Purpose |
|-----|---------|---------|
| `TCGCSV_BASE_URL` | `https://tcgcsv.com` | Data source base URL |
| `LOG_LEVEL` | `debug` | Log verbosity: `debug` \| `info` \| `warn` \| `error` |
| `DRY_RUN` | `false` | Skip DB writes when `true` |
| `BACKFILL_LIMIT` | null | Limit products upserted per sync (dev only) |
| `FORCE_SYNC` | `false` | Re-sync all sets regardless of `synced_at` |
| `SCRYDEX_API_KEY` | — | Scrydex API key — required for price processing, set mapping, image sync |
| `SCRYDEX_TEAM_ID` | — | Scrydex team ID — required alongside API key |
| `SCRYDEX_MONTHLY_LIMIT` | `50000` | Monthly Scrydex credit cap (upgraded tier). Guard blocks calls when usage ≥ `SCRYDEX_MONTHLY_LIMIT - 500`. Set the same value in the Content app env vars. |
| `INGESTION_WORKER_SECRET` | — | Shared secret for admin-triggered HTTP endpoints (`/scrydex/*`, `/tcggo/*`) |
| `TCGGO_RAPIDAPI_KEY` | — | RapidAPI key for tcggo (`pokemon-tcg-api.p.rapidapi.com`) graded eBay-sold medians. Powers `GET /tcggo/graded-prices` (admin-only demo, proxied + KV-cached by Content). Set via `wrangler secret put TCGGO_RAPIDAPI_KEY`. Absent → the endpoint 503s and the Content lookup falls back to a manual price. |
| `SCRYDEX_PRICE_FRESHNESS_HOURS` | `20` | Freshness window for the daily drain. **MUST stay < 24h** (the drain interval) or prices silently freeze — see the FRESHNESS↔DRAIN coupling invariant. Skips a re-fetch if `scrydex_expansion_freshness` has a recent row. |
| `SCRYDEX_PRICE_GAMES` | (all / **unset in prod**) | Optional comma-separated slug allowlist. **Deliberately NOT set** — scoping only saves credits by throttling Pokémon (the primary game), which is unacceptable. Emergency escape hatch only. |
| `SCRYDEX_DRAIN_MAX_FETCHES` | `1500` | Cap on Scrydex page-calls per daily drain invocation (waitUntil safety). Overflow expansions stay pending for the next run / a manual `POST /scrydex/process`. |

## D1 Schema

**Catalogue (Session D — the worker now WRITES these canonical tables):**
| Table | Purpose |
|-------|---------|
| `canonical_games` | Games. Resolve/mint by `tcgplayer_category_id`. (was `tcg_categories`) |
| `sets` | Sets per game. `game_id`→canonical_games, `code` (was abbreviation), `release_date`, `scrydex_expansion_id`. (was `tcg_sets`) |
| `products` | Cards + sealed. `set_id`→sets, `number`, `rarity`, `product_kind` (card/sealed). No image column. (was `tcg_products`) |
| `prices` | `product_id`, `source` ('tcgplayer'\|'scrydex'), `condition`, `finish`, `grade`, `value` (market), `trend_*`, `fetched_at`. (was `tcg_prices` + `scrydex_prices`) |
| `product_images` | `product_id` (UNIQUE, mig 0063), `r2_url`, `source_url`, `source`, `mirrored_at`. |

**Bookkeeping / control plane (unchanged — still written by the worker):**
| Table | Purpose |
|-------|---------|
| `scrydex_expansion_freshness` | Session D (mig 0063): `(scrydex_expansion_id, price_type)` → `last_updated`. Per-expansion freshness/dedup for the price processor. |
| `tcg_sync_log` | One row per sync run with counts + status |
| `image_mirror_log` | One row per mirror job with processed/mirrored/failed/source counts |
| `scrydex_webhook_log` | Pending→processing→complete/error webhook queue (**drained ONCE DAILY** `0 4 * * *`, deduped by expansion — cost control 2026-06) |
| `scrydex_api_log` | One row per outbound Scrydex API call — credit guard + admin dashboard. 90-day retention. |
| `variant_ingest_conflicts` | Session D-bis (mig 0065): Scrydex variant collisions (intra-payload dup product_id / cross-product) routed for admin review instead of corrupting `products`. Deduped on `(scrydex_card_id, tcgplayer_product_id, variant_name)`. |

The old `tcg_categories` / `tcg_sets` / `tcg_products` / `tcg_prices` / `scrydex_prices` tables are
**frozen** (no longer written or read) and kept only as the rollback path until the final session.

## Re-mirror Logic
(Session D — canonical: image state lives in `product_images`, joined `products → sets → canonical_games`.)
Cards are re-queued for mirroring when:
- **never mirrored** — no `product_images` row, or a row with `r2_url IS NULL` and `source IS NULL`
- `product_images.source = 'tcgplayer' AND sets.scrydex_expansion_id IS NOT NULL` (upgrade to higher-res Scrydex image)

A `source='scrydex'` row with `r2_url IS NULL` (One Piece/Gundam Scrydex-CDN-as-final) is intentionally
NOT eligible — this reproduces the old `image_source='scrydex'` exclusion.
