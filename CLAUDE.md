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
  adminJobs.ts           # Manual cron-job triggers (POST /admin/run-job): shared runWeeklyImagePipeline + day-rotated PriceCharting category + KV double-fire lock + PriceCharting download cooldown. Cron handler + manual trigger share these (one impl per job).
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
| `0 5 * * *` | **DAILY** PriceCharting CSV bulk-ingest — ONE category/run, rotated by day (4-day cycle). Upserts canonical `prices` (source='pricecharting') for the 4 games. See **PriceCharting CSV Bulk-Ingest**. Prod only. |

> **Each cron can also be run ON DEMAND** from the Content admin portal (Admin → Catalog → **Ingestion Jobs**)
> via `POST /admin/run-job` (x-worker-secret, admin-proxied). The cron handler and the manual trigger call the
> SAME functions (`src/adminJobs.ts`) — no duplicated logic. The Sunday pipeline is `runWeeklyImagePipeline()`;
> the PriceCharting category is `priceChartingCategoryForDay()` (shared with the cron). See **Manual Cron-Job
> Triggers** below.

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
| `POST` | `/scrydex/enrich-card` | `x-worker-secret` | **Blocking** tier-aware detail enrichment (2026-06-18). Body `{ canonicalProductId, classes:['core'\|'comps'\|'history'] }`. Per class: **core** = `GET /{slug}/v1/cards/{scrydexId}?include=prices,pop_reports` → canonical `prices` (per-variant ranges low/mid/high + graded matrix w/ signed/error/perfect flags) + `card_pop_reports`; **comps** = `/listings` → `card_listings` (prune >180d); **history** = `/price_history` → `card_price_history` (prune >365d). Marks `card_enrichment_freshness(product_id, class)` per class. Credit-guarded; a guard trip / 403 cap → `{ ok:true, skipped }`. Content proxies this from `POST /api/cards/enrich` (authed + tier-gated + per-class 24h freshness). `src/scrydexEnrich.ts`. See Content/CLAUDE.md "Scrydex Detail Enrichment". |
| `POST` | `/scrydex/vision-identify` | `x-worker-secret` | **Blocking** Scrydex Vision card identify (§4 #7) — `multipart/form-data` `image` + optional `games` (csv). Calls `scrydexVisionIdentify()` (credit guard + **5-credit** `scrydex_api_log` debit); returns `{ ok, analysis, matches }` (403/cap → 502 `{ok:false,status:403}` so the caller falls back to Claude). Content proxies this **admin-only** for the scanner. |
| `POST` | `/pricecharting/ingest` | `x-worker-secret` | **CSV BULK-INGEST** (2026-06-16). Body `{ category, force? }` (`category` ∈ pokemon-cards\|magic-cards\|yugioh-cards\|one-piece-cards). Same job the `0 5 * * *` cron runs for one category. Streams the per-game price-guide CSV, matches each row to a canonical product (tcg-id first → validated fuzzy fallback), persists the map (`pricecharting_products`), and upserts canonical `prices` (source='pricecharting'). Resumable (KV cursor `pc_ingest_cursor:{category}`) and **time-bounded** (`PC_INGEST_BUDGET_MS`, default 20s — under the ~60s request cap) so it returns counts instead of being canceled. ⚠️ Each call **RE-DOWNLOADS the whole CSV**, and the download is HARD-limited to **1/10 min (abuse → account revoked)**, so do NOT rapid-loop a big category — one-piece is small enough (~3 calls) but the big games need the design fix (see **PriceCharting CSV Bulk-Ingest → ⚠️ design flaw**). Returns `{ ok, matchedTcgId, matchedFuzzy, unmatched, sealedRows, sealedMatched, pricesUpserted, rowsCollected, rowsProcessed, windowStart, cursorNext, wrapped, budgetHit, durationMs }`. Needs `PRICECHARTING_TOKEN`. See **PriceCharting CSV Bulk-Ingest**. |
| `GET` | `/pricecharting/graded?canonicalProductId=&company=&grade=` | `x-worker-secret` | **PRIMARY admin graded source** (2026-06-15). Needs **`PRICECHARTING_TOKEN`**. Resolves the canonical product → a PriceCharting id (search `/api/products?q=<name> <set>` + **validate** the best match + KV-cache `pc_id:{id}` long-TTL; raw `/api/product` cached `pc_product:{pcId}` 24h), decodes the (company,grade) tier, returns `{ ok, price, key, productName, console, salesVolume }` (price INTEGER PENNIES ÷100; `price:null` = unsupported/no-match). Rate limit 1 req/sec (sleeps between search+product). `src/lib/pricechartingClient.ts`. Content proxies **admin-only** + KV-caches 24h. |
| `GET` | `/ebay/graded?canonicalProductId=&company=&grade=` | `x-worker-secret` | **GRADED GAP-FILLER** (2026-06-17 — REPLACED the removed tcggo graded source). Prices the slabs PriceCharting can't (TAG/ACE, grade < 7). Needs **`APIFY_TOKEN` + `APIFY_EBAY_ACTOR_ID`**. Resolves the canonical product → eBay completed+sold search terms (`src/lib/ebaySoldSearch.ts`), runs the Apify eBay actor (`run-sync-get-dataset-items`), then match-filters / trims outliers (MAD) / takes a median → `{ ok, price, n, company, grade, source:'ebay-apify' }` (`price:null`/`n:0` = no comps). Circuit-breaks to null on any actor error. `src/lib/ebayGradedClient.ts`. Content proxies **admin-only**, behind the `ebay_graded_enabled` flag (ships dark), + KV-caches 24h (nulls 6h). ⚠️ Actor input/output shapes are a documented assumption until the actor is pinned + probed. |
| `GET` | `/tcggo/artists?search=&page=` | `x-worker-secret` | **Artist Templates tool** (2026-06-15). Lists/searches tcggo artists → `{ ok, artists:[{id,name,slug,cards_count}], page }`. Content proxies admin-only + KV-caches briefly. |
| `GET` | `/tcggo/artists/:artistId/cards?cardsCount=` | `x-worker-secret` | Paginates **ALL** of an artist's cards (bounded by cards_count / short final page / 40-page free-tier cap) → `{ ok, artistId, count, cards:[{name,card_number,rarity,episode,image,tcgplayer_id,tcgid}], requests }`. Content maps these → canonical products + mints an owned template binder. |
| `POST` | `/admin/run-job` | `x-worker-secret` | **MANUAL CRON-JOB TRIGGER** (2026-06-19). Body `{ job: 'tcg-sync'\|'image-mirror'\|'scrydex-drain'\|'pricecharting-csv', force? }`. Runs the SAME function the matching cron calls (`src/adminJobs.ts`), **fire-and-forget via `waitUntil`** → `{ ok, job, started:true, category? }`. Per-job prereqs mirror the cron guards (scrydex-drain needs Scrydex keys → 503; pricecharting-csv needs `PRICECHARTING_TOKEN` → 503; image-mirror runs without Scrydex keys, sub-steps self-skip). **Double-fire guard:** best-effort KV lock `ingestion_job_lock:{job}` (shared `SLEEVEDPAGES_KV`) → **409** `{alreadyRunning:true}` while a run is in flight. **pricecharting-csv extra guard:** a download cooldown `ingestion_pc_csv_cooldown` (~10 min, set by ANY download — manual or cron) → **429** `{cooldown:true, retryAfterSec}` because the PriceCharting CSV download is hard rate-limited ~1/10min (abuse → account revocation). Content proxies this **admin-only** via `POST /api/admin/ingestion/trigger`; status via `GET /api/admin/ingestion/jobs`. See **Manual Cron-Job Triggers** below. |

Scrydex endpoints are called from the Admin panel via Content app proxy (`POST /api/admin/scrydex/trigger`). Direct calls require `x-worker-secret: <INGESTION_WORKER_SECRET>` header.

## Manual Cron-Job Triggers (2026-06-19) — admin-only on-demand runs of the 4 crons

So the operator can run a cron-driven pull on demand from the admin portal without raw `wrangler` commands.
**Admin-only, never public/unauthenticated.** `src/adminJobs.ts` holds the shared pieces; the cron handler
and the manual trigger call the SAME job functions (no duplicated logic):

| Job id | Underlying function | Cron | Safe to re-run? |
|--------|---------------------|------|-----------------|
| `tcg-sync` | `runIngestion(buildConfig(env))` | `0 6 * * *` | ✅ idempotent upserts; long-running |
| `image-mirror` | `runWeeklyImagePipeline(env)` (set-mappings → image sync → `runMirrorJob(Infinity)` → `cleanupScrydexApiLog`) | `0 3 * * SUN` | ✅ merge-upserts, skips already-mirrored sets; long-running |
| `scrydex-drain` | `processPendingWebhooks(env)` | `0 4 * * *` | ✅ freshness-guarded + deduped; consumes Scrydex credits |
| `pricecharting-csv` | `ingestPriceChartingCategory(env, priceChartingCategoryForDay())` | `0 5 * * *` | ✅ idempotent upserts + resumable cursor; consumes PriceCharting quota |

- **Auth:** worker side = `x-worker-secret` (`INGESTION_WORKER_SECRET`); Content proxy = the existing admin gate
  (`functions/api/admin/_middleware.js`, `data.userId === ADMIN_USER_ID`). No new env var, no schema change.
- **Fire-and-forget:** all four kick off via `ctx.waitUntil` and return `started:true` immediately (matches the
  crons), so the admin request never blocks on a long job. PriceCharting returns the day-rotated `category` it
  fired.
- **Double-fire guard:** a best-effort KV lock per job (released on completion; TTL is the crash backstop). The
  Content status endpoint reads the SAME keys to render a "Running" pill + disable the button (plus an
  optimistic client window to bridge KV's eventual consistency).
- **⚠️ PriceCharting cooldown:** because the CSV download is hard rate-limited ~1/10min (abuse → account
  revocation, see `/pricecharting/ingest`), the `pricecharting-csv` trigger is additionally gated by a ~10-min
  download cooldown (`ingestion_pc_csv_cooldown`, set by the manual trigger AND the `0 5` cron) so the button
  can't become a rapid-loop vector. The status endpoint surfaces `cooldownRemainingSec` so the UI pre-disables
  it and shows a countdown.
- **Last-run:** surfaced for `tcg-sync` (`tcg_sync_log`) and `image-mirror` (`image_mirror_log`); the other two
  have no dedicated run-log table yet (future nicety — the panel shows the pending Scrydex webhook count for the
  drain instead). Tests: `src/adminJobs.test.ts`.

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

## PriceCharting CSV Bulk-Ingest (2026-06-16) — the all-users graded backbone for 4 games

The production graded+ungraded price backbone for the **4 games we ingest** (Pokémon, Magic,
Yu-Gi-Oh, One Piece). It **supersedes the on-demand PriceCharting API path FOR THESE 4 GAMES**;
the on-demand `/pricecharting/graded` (admin-only) stays the live fallback for OTHER games.

- **Source (operator-confirmed):** `GET https://www.pricecharting.com/price-guide/download-custom?t={PRICECHARTING_TOKEN}&category={cat}`
  for `cat` ∈ `pokemon-cards`, `magic-cards`, `yugioh-cards`, `one-piece-cards`. Returns CSV (~88k
  rows/game). The CSV download is **HARD-rate-limited to 1 per 10 MINUTES** (the file regenerates only
  ~once/24h), and **exceeding it gets the PriceCharting account's API permissions REVOKED**
  (operator-confirmed 2026-06-19). ⚠️ This is the constraint the current per-window re-download VIOLATES
  when rapid-looped — see the **design-flaw** note below. We pull
  on the **daily `0 5 * * *` cron, ONE category per run, rotated by day** (4-day cycle). Manual:
  `POST /pricecharting/ingest { category, force? }`.
- **Format: TAB-separated** (operator-confirmed) with **unquoted thousands commas** in the dollar fields
  (`$2,200.00`) and trailing spaces. The parser **auto-detects the delimiter** from the header
  (`detectDelimiter` — tab vs comma) so a comma split never shreds a priced row; `parseDollarsToCents`
  strips `$`/`,`/space. `tcg-id` = the TCGPlayer product id; `genre`="Sealed Product" flags sealed.
- **CSV prices are DOLLAR strings** ("$46.47", "$2,200.00") — parse → integer cents (exact) → store
  **dollars** in canonical `prices.value` (matches the scrydex/tcgplayer rows the serving reads;
  `value` is dollars, NOT cents, despite the /api JSON returning pennies).
- **Decode map (shared, identical to the API path):** `src/lib/pricechartingCsv.ts` builds its
  CSV-column→grade-label list from `pricechartingClient.ts` `GRADE_KEY_LABEL` + `LOOSE_KEY`, so a card
  decodes the same whichever path priced it. `loose-price` → ungraded/market (condition NULL, finish
  'normal', grade NULL); `cib`→'Grade 7 / 7.5'; `new`→'Grade 8 / 8.5'; `graded-price`→'Grade 9';
  `box-only`→'Grade 9.5'; `manual-only`→'PSA 10'; `bgs-10`→'BGS 10'; `condition-17`→'CGC 10';
  `condition-18`→'SGC 10'. (No TAG/ACE; sub-10 grades are company-agnostic — same caveats as the API.)
- **Matching is IN-MEMORY (`src/pricechartingIngest.ts`)** — `loadProductIndex()` pulls the game's
  canonical products ONCE per run (paginated, a few round trips) into `byTcgId` + `byNumber` maps;
  `matchRows()` is then pure CPU (no per-row D1 query). **WHY (fixed 2026-06-17):** the per-row fuzzy
  JOIN fired once per row, and PriceCharting sorts the guide **oldest-first** so the early rows
  (vintage WoTC, pre-TCGPlayer) have **no tcg-id** → an all-fuzzy storm (~135ms/row → 500 rows in 54s,
  `matchedTcgId:0`). The in-memory index makes match cost negligible; only the batched writes hit D1.
  - **PRIMARY — tcg-id** (`tcg-id` ≈73% populated overall; it is the TCGPlayer product id): `byTcgId`
    map lookup, **validated** by name-token overlap (`validateTcgIdMatch`) so a wrong/stale id never
    misprices. tcgplayer_product_id is globally unique → no game scoping needed. (Early oldest rows have
    no tcg-id and many aren't in our catalogue → recorded unmatched; tcg-id matches climb in later/newer
    windows — read the live rate from the per-run counts, don't assume 73% in any single window.)
  - **FALLBACK — validated fuzzy** (no/failed tcg-id): candidates from the `byNumber` index (card
    number), scored on name+number (`pickBestCanonicalMatch`), accept at ≥5 (name + number) — **reject
    weak matches rather than misprice**. Bounded per run (`PC_INGEST_FUZZY_MAX`, default 400).
  - **Persisted mapping** → `pricecharting_products` (pc_id ↔ canonical product id). Re-runs re-match
    in memory (cheap + deterministic) and re-upsert prices on the same conflict keys (= the daily
    refresh, no dupes). **Unmatched rows are RECORDED** (`canonical_product_id IS NULL`), never silently
    dropped — the catalogue-gap signal (count/list per game). `sales-volume` captured per pc_id.
- **Sealed rows** (genre = "Sealed Product"): matched like any row; written with **ONLY the ungraded /
  market row** (sealed product has no graded tiers). Where a sealed row can't be matched it is counted
  unmatched (not dropped).
- **Write path:** idempotent upsert into canonical `prices` (`source='pricecharting'`), one row per
  (product, grade/company) on the superset `uq_prices_identity` conflict key. Re-runs update
  value+fetched_at, never duplicate. **The ungraded/loose row also carries the `retail_buy`/`retail_sell`
  spread** (`retail-loose-buy`/`retail-loose-sell` → `prices.retail_buy`/`retail_sell`, mig 0075);
  graded rows stay value-only. `csvRowToPriceRows` attaches them to the `grade===null` row.
- **Scale / resumability / TIME-BOUNDED (must not block past the request cap):** the CSV is **streamed**
  (never buffered whole) and parsing **early-stops at the window end** (never downloads the tail past the
  window). Each run resumes from a KV cursor (`pc_ingest_cursor:{category}`) and processes rows in 500-row
  sub-batches **until a wall-time budget** (`PC_INGEST_BUDGET_MS`, default **20000 ms** — under the ~60s
  Workers request-duration cap), then saves the cursor at the **exact row reached** (`cursorNext`) and
  returns. `PC_INGEST_MAX_ROWS` (default 25000) is a hard per-run upper bound; `wrapped:true` means it hit
  EOF and the next run starts a fresh pass (daily refresh). A budget cut-off (`budgetHit:true`) loses no
  progress — the cursor only advances over fully-written sub-batches, and all writes are idempotent. D1
  writes are batched (≤90 statements/batch). Logs `{"log":"pricecharting_csv_ingest", …}` with
  matched/fuzzy/unmatched/sealed counts + `rowsProcessed`/`cursorNext`/`wrapped`/`budgetHit`/`durationMs`.
  > **WHY (fixed 2026-06-16):** the first synchronous run held the client connection for the whole 25k-row
  > window and hit the **~60s request-duration cap → `outcome:"canceled"`** (cpuTime ~1s; it was I/O-bound
  > on hundreds of sequential D1 round trips). The time-budget + sub-batch cursor caps each run well under
  > the cap so it returns counts.
  >
  > **⚠️ DESIGN FLAW — do NOT rapid-loop a big category (operator-confirmed 2026-06-19).** Each
  > `/pricecharting/ingest` call **re-downloads the ENTIRE ~88k-row CSV** and merely skips to the cursor,
  > so the old "loop the curl until `wrapped:true`" guidance issues **one full download per ~20s window**.
  > The PriceCharting CSV download is **HARD-limited to 1 per 10 MINUTES — abuse REVOKES the account's API
  > permissions** (API calls 1/sec). So rapid-looping a big game (~176 windows) both **violates the limit**
  > (observed: HTTP 429) and **thrashes the KV cursor** — a call reads `pc_ingest_cursor:{category}` before
  > the prior call's write has propagated (KV eventual consistency), so the offset bounces and can falsely
  > look "stuck". The daily cron (1 download/category/day) respects the limit but processes only ONE window
  > per day, so it **never finishes** an 88k-row game. **PROPER FIX (its own prompt):** download each CSV
  > **once/day → cache to R2** → process the whole file from the cached copy (and/or drive it with a
  > Workflow / Durable Object / queue across sub-requests), so one daily download fully ingests a category.
  > **For now: one-piece-cards wraps in ~3 calls; the big 3 should NOT be rapid-looped.** Status +
  > partial-coverage numbers live in Content `Partner_Platform_Handoff_Summary.md`.
- **Migration:** `Content/migrations/0070_pricecharting_map.sql` (the `pricecharting_products` map +
  unmatched log + sales-volume — chosen over KV because 350k rows need queryable unmatched counts +
  incremental skip; the existing `pc_id_v2:*`/`pc_product:*` KV keys remain the on-demand API path's id
  cache, a separate concern). The `prices` write needs no migration (schema already has source/grade/etc).
- **Serving:** Content `getGradedPrices` now reads `prices` where `source IN ('scrydex','pricecharting')`
  → the Content "Graded Prices" section serves these to **ALL users** for the 4 games (no admin gate, no
  per-call cost). PriceCharting rows exist ONLY for the 4 ingested games, so their presence IS the gate.
- **Tests (+30 → 136):** `src/pricechartingCsv.test.ts` (delimiter detection, the real One Piece
  EB02-010 tab row, parse, decode map, sealed, matchers) + `src/pricechartingIngest.test.ts` (tcg-id
  primary, fuzzy fallback, weak rejection, unmatched counted, idempotent re-run, sealed write).

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
| `SCRYDEX_MONTHLY_LIMIT` | `50000` | Monthly Scrydex credit cap (Growth tier). Guard blocks calls when usage ≥ `SCRYDEX_MONTHLY_LIMIT - 500`. Set the same value in the Content app env vars. **CARRY-FORWARD (corrected 2026-06-18): STAY on Growth through ~end-of-year, then reassess post-show — do NOT drop to Starter.** The 4-tier paid data model (Collector `core_pricing` = graded matrix / pop / trends; Curator `comps_and_history` = listings + price_history) plus Vision all REQUIRE Growth-tier endpoints; Starter lacks graded/pop/trends/history/Vision, so dropping would break paid entitlements. |
| `INGESTION_WORKER_SECRET` | — | Shared secret for admin-triggered HTTP endpoints (`/scrydex/*`, `/tcggo/*`) |
| `PRICECHARTING_TOKEN` | — | PriceCharting API token. Powers (a) the admin graded-price source `GET /pricecharting/graded` (2026-06-15) and (b) the **daily CSV bulk-ingest** for the 4 games (`POST /pricecharting/ingest` + `0 5 * * *` cron, 2026-06-16). Set via `wrangler secret put PRICECHARTING_TOKEN` (preview + prod). Absent → both 503 and the cron no-ops. Token lives here only — never in the Content app, logs, or responses. |
| `PC_INGEST_MAX_ROWS` | `25000` | Hard upper bound on CSV rows collected per bulk-ingest run. The run usually stops earlier on `PC_INGEST_BUDGET_MS`; this just caps memory/window size. |
| `PC_INGEST_BUDGET_MS` | `20000` | Wall-time budget per bulk-ingest run before it stops + saves the cursor. Kept **under the ~60s Workers request-duration cap** so the synchronous endpoint returns counts instead of being canceled. ⚠️ Each call **RE-DOWNLOADS the full CSV** (HARD-limited 1/10 min — abuse → account revoked), so do NOT rapid-loop a big category — see the ⚠️ design-flaw note in **PriceCharting CSV Bulk-Ingest**. |
| `PC_INGEST_FUZZY_MAX` | `400` | Bounded fuzzy lookups per bulk-ingest run (tcg-id carries the bulk). Unmatched rows are retried on later runs. |
| `TCGGO_RAPIDAPI_KEY` | — | RapidAPI key for tcggo (`pokemon-tcg-api.p.rapidapi.com`). **STILL REQUIRED** — powers the **Artist Templates** ingestion tool (`GET /tcggo/artists*`). Its graded eBay-sold role was **REMOVED** (2026-06-17, unreliable canonical-id matching); `GET /tcggo/graded-prices` is gone. Set via `wrangler secret put TCGGO_RAPIDAPI_KEY`. Absent → the artist endpoints 503. Free tier 100 req/day — Content KV-caches; artist pulls are admin-triggered + bounded. |
| `APIFY_TOKEN` | — | Apify API token for the eBay sold-comp graded **gap-filler** `GET /ebay/graded` (2026-06-17 — replaced tcggo graded). Set via `wrangler secret put APIFY_TOKEN`. Absent → 503. Lives here only — never in the Content app, logs, or responses. |
| `APIFY_EBAY_ACTOR_ID` | — | Apify eBay actor id (e.g. `username~actor-name`) the gap-filler runs. Set via `wrangler secret put APIFY_EBAY_ACTOR_ID`. Absent → 503. **Pin down + probe the actor's dataset shape before the Content `ebay_graded_enabled` flag is switched on** (the parser is written against a documented assumption). |
| `SLEEVEDPAGES_KV` (binding) | — | Shared KV namespace (the Content app's `SLEEVEDPAGES_KV`, same id). Caches PriceCharting ids (`pc_id:*`) + raw product responses (`pc_product:*`). Bound in `wrangler.toml` (prod + preview). |
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
| `prices` | `product_id`, `source` ('tcgplayer'\|'scrydex'\|'pricecharting'), `condition`, `finish`, `grade`, `value` (market), `trend_*`, `fetched_at`. **+ enrichment cols (Content mig 0073): `low`/`mid`/`high`, `variant`, `company`, `is_signed`/`is_error`/`is_perfect`, `trend_180d`, `trends_json`.** **+ spread cols (Content mig 0075): `direct_low` (TCGplayer Direct), `retail_buy`/`retail_sell` (PriceCharting ungraded buy/sell).** The ungraded **SPREAD** is now persisted, not dropped: TCGCSV writes `low`/`mid`/`high`/`direct_low` (was market-only); PriceCharting writes `retail_buy`/`retail_sell` on the loose row. (Content serves the chain Scrydex→PriceCharting→TCGCSV with provenance — see Content/CLAUDE.md "Source fallback chain + provenance + spread".) Identity index `uq_prices_identity` is the SUPERSET `(product_id, source, condition, finish, grade, variant, company, is_signed, is_error, is_perfect)` (COALESCE'd) — **all `prices` writers' `ON CONFLICT` must use this column list** (the mig-0075 spread cols are non-identity). (was `tcg_prices` + `scrydex_prices`) |
| `card_pop_reports` / `card_listings` / `card_price_history` / `card_enrichment_freshness` | Content mig 0073 — Scrydex detail enrichment: graded population counts, sold comps, daily price history, and the per-(product, data_class) 24h freshness lever. Written by `src/scrydexEnrich.ts` (`POST /scrydex/enrich-card`). See Content/CLAUDE.md "Scrydex Detail Enrichment". |
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
| `pricecharting_products` | 2026-06-16 (Content mig 0070): PriceCharting CSV bulk-ingest map. `pc_id` (PK) ↔ `canonical_product_id` (NULL = unmatched/catalogue-gap), `game_category`, `match_method` ('tcg-id'\|'fuzzy'), `tcg_id`, `console_name`/`product_name`, `is_sealed`, `sales_volume`, `matched_at`, `last_seen_at`. Persisted so re-ingests are incremental + unmatched is reviewable. See **PriceCharting CSV Bulk-Ingest**. |

The old `tcg_categories` / `tcg_sets` / `tcg_products` / `tcg_prices` / `scrydex_prices` tables are
**frozen** (no longer written or read) and kept only as the rollback path until the final session.

## Re-mirror Logic
(Session D — canonical: image state lives in `product_images`, joined `products → sets → canonical_games`.)
Cards are re-queued for mirroring when:
- **never mirrored** — no `product_images` row, or a row with `r2_url IS NULL` and `source IS NULL`
- `product_images.source = 'tcgplayer' AND sets.scrydex_expansion_id IS NOT NULL` (upgrade to higher-res Scrydex image)

A `source='scrydex'` row with `r2_url IS NULL` (One Piece/Gundam Scrydex-CDN-as-final) is intentionally
NOT eligible — this reproduces the old `image_source='scrydex'` exclusion.
