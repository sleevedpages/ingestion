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
- **Queue**: Cloudflare Queues — `sleevedpages-sync-queue` (binding: `SYNC_QUEUE`, TCGCSV per-set sync) +
  `sleevedpages-pricecharting-queue` (binding: `PC_PROCESS_QUEUE`, PriceCharting windowed PROCESS-from-R2)
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
| `0 3 * * SUN` | Weekly (MIRROR-FIRST since WP-2, 2026-07-07): `runMirrorJob` (Infinity batches) → `syncScrydexSetMappings` → `syncScrydexImages` → `scrydex_api_log` cleanup (90-day retention). Mirror first so the sync stages can never starve it (the 2026-07-05 run died before the mirror ran); the mirror consumes the PREVIOUS week's synced source_urls. |
| `0 4 * * *` | **DAILY** Scrydex webhook drain → upsert canonical `prices` (dedup by expansion; 20h freshness). **Was `*/10`** — moved to daily for cost control (2026-06; see Price Processing). |
| `0 5 * * *` | **DAILY** PriceCharting **FETCH** (rebuilt 2026-06-19) — download ONE rotated category's CSV → R2 (the only download; arms the 10-min cooldown), then the dedicated `PC_PROCESS_QUEUE` ingests the WHOLE category from that single cached file (canonical `prices`, source='pricecharting', for the 4 games). One download/day respects the 1-per-10-min limit; the queue finishes even a big ~88k-row category. See **PriceCharting CSV Bulk-Ingest (FETCH/PROCESS split)**. Prod only. |
| `0 7 * * *` | **DAILY** News poll → `runNewsPoll()` (`src/newsPoll.ts`). Polls the active DotGG WordPress RSS feeds (`news_sources WHERE is_active=1`), extracts ONLY headline + link + date (`src/lib/feedParser.ts` — bodies never read), UPSERTs `news_items` deduped on `link` (INSERT OR IGNORE), prunes items > 90 days. **LINK-OUT only** — no article text stored. No Scrydex/PriceCharting key needed (public RSS). **Prod only** (`[env.preview.triggers]` omits it — UAT is populated by the on-demand `news-poll` job). 07:00 UTC is clear of the 04/05/06 ingest crons. See Content/CLAUDE.md "News Feed". |

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
| `POST` | `/pricecharting/fetch` | `x-worker-secret` | **CSV FETCH** (2026-06-19) — the ONLY path that downloads. Body `{ category }`. Downloads the full per-game CSV ONCE → R2 (`ingest-raw/pricecharting/{category}/{YYYY-MM-DD}.csv`), arms the 10-min cooldown, then enqueues PROCESSing. **Cooldown-gated → 429** `{cooldown:true, retryAfterSec}` while cooling (so it can never become a rapid re-download vector). Needs `PRICECHARTING_TOKEN`. Returns `{ ok, category, key, date, bytes, processing:'enqueued' }`. |
| `POST` | `/pricecharting/ingest` | `x-worker-secret` | **CSV PROCESS** (rebuilt 2026-06-19) — PROCESS the cached R2 file (NO download, unlimited, idempotent). Body `{ category, sync? }`. Resolves the freshest R2 file (today, else most-recent as a logged **stale fallback**) and enqueues the windowed ingest chain (matches tcg-id-first → validated fuzzy, persists `pricecharting_products`, upserts canonical `prices` source='pricecharting' incl. the retail_buy/sell spread). Default returns `{ ok, mode:'enqueued', category, key, stale }`; `sync:true` processes ONE window inline from offset 0 and returns its `PcWindowCounts` (verification). **Does NOT need `PRICECHARTING_TOKEN`** (R2-only). 409 if nothing was ever fetched. See **PriceCharting CSV Bulk-Ingest (FETCH/PROCESS split)**. |
| `GET` | `/pricecharting/graded?canonicalProductId=&company=&grade=` | `x-worker-secret` | **PRIMARY admin graded source** (2026-06-15). Needs **`PRICECHARTING_TOKEN`**. Resolves the canonical product → a PriceCharting id (search `/api/products?q=<name> <set>` + **validate** the best match + KV-cache `pc_id:{id}` long-TTL; raw `/api/product` cached `pc_product:{pcId}` 24h), decodes the (company,grade) tier, returns `{ ok, price, key, productName, console, salesVolume }` (price INTEGER PENNIES ÷100; `price:null` = unsupported/no-match). Rate limit 1 req/sec (sleeps between search+product). `src/lib/pricechartingClient.ts`. Content proxies **admin-only** + KV-caches 24h. |
| `GET` | `/ebay/graded?canonicalProductId=&company=&grade=` | `x-worker-secret` | **GRADED GAP-FILLER** (2026-06-17 — REPLACED the removed tcggo graded source). Prices the slabs PriceCharting can't (TAG/ACE, grade < 7). Needs **`APIFY_TOKEN` + `APIFY_EBAY_ACTOR_ID`**. Resolves the canonical product → eBay completed+sold search terms (`src/lib/ebaySoldSearch.ts`), runs the Apify eBay actor (`run-sync-get-dataset-items`), then match-filters / trims outliers (MAD) / takes a median → `{ ok, price, n, company, grade, source:'ebay-apify' }` (`price:null`/`n:0` = no comps). Circuit-breaks to null on any actor error. `src/lib/ebayGradedClient.ts`. Content proxies **admin-only**, behind the `ebay_graded_enabled` flag (ships dark), + KV-caches 24h (nulls 6h). ⚠️ Actor input/output shapes are a documented assumption until the actor is pinned + probed. |
| `GET` | `/tcggo/artists?search=&page=` | `x-worker-secret` | **Artist Templates tool** (2026-06-15). Lists/searches tcggo artists → `{ ok, artists:[{id,name,slug,cards_count}], page }`. Content proxies admin-only + KV-caches briefly. |
| `GET` | `/tcggo/artists/:artistId/cards?cardsCount=` | `x-worker-secret` | Paginates **ALL** of an artist's cards (bounded by cards_count / short final page / 40-page free-tier cap) → `{ ok, artistId, count, cards:[{name,card_number,rarity,episode,image,tcgplayer_id,tcgid}], requests }`. Content maps these → canonical products + mints an owned template binder. |
| `POST` | `/admin/purge-placeholder-mirrors` | `x-worker-secret` | **CARD-BACK CLEANUP SWEEP** (2026-07-08). Body `{ cursor?, limit? }`. **Synchronous + cursor-based** (NOT fire-and-forget): runs ONE bounded batch and returns `{ ok, scanned, purged, repaired, remaining, hasMore, cursorNext }`; the caller loops (pass `cursorNext` back as `cursor`) until `hasMore:false` — same loop shape as bulk-enrich / FETCH-PROCESS. Reads each `product_images.r2_url` object straight from R2, SHA-256s it, and on a `PLACEHOLDER_IMAGE_HASHES` match deletes the R2 object + repairs the row (source_url → reconstructed TCGplayer `_in_1000x1000`, r2_url/mirrored_at → NULL, source → NULL). Data changes are regenerable (rows self-repair on the next mirror), never destructive. Loop it with `scripts/purge-placeholder-mirrors.mjs`, or the Content admin panel's "Purge card-back placeholders" card. See **Card-back placeholder guard** below. |
| `POST` | `/admin/dead-url-sweep` | `x-worker-secret` | **WP-6 DEAD SOURCE_URL SWEEP** (2026-07-08, audit IMG-7). Body `{ cursor?, limit? }`. **Synchronous + cursor-based**, same shape as purge-placeholder-mirrors: `{ ok, scanned, alive, dead, repaired, remaining, hasMore, cursorNext }`. Manual-trigger only — **no cron**. Probes `product_images` rows with NO `r2_url` (source_url is their only serving path) and hashes every response (a bare 200 isn't proof of life — Scrydex serves its card-back placeholder at 200); a placeholder match repairs via the SAME `tcgplayerPlaceholderFallback` path the mirror uses; a plain-dead probe (non-2xx/network error/empty body) marks the row via the EXISTING `mirror_attempts`/`mirror_last_attempt_at` bookkeeping (mig 0086) — no new column. `src/deadSourceUrlSweep.ts`. See **Dead source_url sweep (WP-6)** below. |
| `POST` | `/admin/run-job` | `x-worker-secret` | **MANUAL CRON-JOB TRIGGER** (2026-06-19). Body `{ job: 'tcg-sync'\|'image-mirror'\|'scrydex-drain'\|'pricecharting-csv'\|'pricecharting-download', force? }`. Runs the SAME function the matching cron calls (`src/adminJobs.ts`), **fire-and-forget via `waitUntil`** → `{ ok, job, started:true, category? }`. Per-job prereqs: scrydex-drain needs Scrydex keys → 503; **pricecharting-download** (the ONLY download) needs `PRICECHARTING_TOKEN` → 503; **pricecharting-csv** PROCESSes the cached R2 file (no token, no download); image-mirror runs without Scrydex keys. **Double-fire guard:** best-effort KV lock `ingestion_job_lock:{job}` (shared `SLEEVEDPAGES_KV`) → **409** `{alreadyRunning:true}`. **pricecharting-download extra guard:** a download cooldown `ingestion_pc_csv_cooldown` (~10 min, set by ANY download — manual or cron) → **429** `{cooldown:true, retryAfterSec}` (PriceCharting CSV download is hard rate-limited ~1/10min, abuse → account revocation). `pricecharting-csv` (re-process) is NOT cooldown-gated — unlimited + safe. Content proxies this **admin-only** via `POST /api/admin/ingestion/trigger`; status via `GET /api/admin/ingestion/jobs`. See **Manual Cron-Job Triggers** below. |

Scrydex endpoints are called from the Admin panel via Content app proxy (`POST /api/admin/scrydex/trigger`). Direct calls require `x-worker-secret: <INGESTION_WORKER_SECRET>` header.

## Manual Cron-Job Triggers (2026-06-19) — admin-only on-demand runs of the 4 crons

So the operator can run a cron-driven pull on demand from the admin portal without raw `wrangler` commands.
**Admin-only, never public/unauthenticated.** `src/adminJobs.ts` holds the shared pieces; the cron handler
and the manual trigger call the SAME job functions (no duplicated logic):

| Job id | Underlying function | Cron | Safe to re-run? |
|--------|---------------------|------|-----------------|
| `tcg-sync` | `runIngestion(buildConfig(env))` | `0 6 * * *` | ✅ idempotent upserts; long-running |
| `image-mirror` | `runWeeklyImagePipeline(env)` (**`runMirrorJob(Infinity)` FIRST** → set-mappings → image sync → `cleanupScrydexApiLog`; WP-2 order) | `0 3 * * SUN` | ✅ merge-upserts + attempt-backoff (re-runs skip recently-attempted rows); long-running |
| `scrydex-drain` | `processPendingWebhooks(env)` | `0 4 * * *` | ✅ freshness-guarded + deduped + atomic row claims (WP-8 — overlapping runs can never double-drain a row); consumes Scrydex credits |
| `pricecharting-csv` | `runPriceChartingProcess(env, priceChartingCategoryForDay())` — PROCESS the cached R2 CSV (no download) | — (on demand) | ✅ idempotent upserts, R2-only; **unlimited + safe** (never touches the rate limit) |
| `pricecharting-download` | `runPriceChartingFetch(env, priceChartingCategoryForDay())` — DOWNLOAD fresh CSV → R2 → PROCESS | `0 5 * * *` | ⚠️ downloads from PriceCharting — **rate-limited ~1/10min** (cooldown-gated) |
| `news-poll` | `runNewsPoll(env)` — poll active DotGG RSS feeds → upsert `news_items` (headline+link+date, link-out; prune >90d) | `0 7 * * *` (PROD only) | ✅ public RSS, deduped on link — unlimited + safe; no API key. **Use this to populate UAT** (no news cron in UAT). |

- **Auth:** worker side = `x-worker-secret` (`INGESTION_WORKER_SECRET`); Content proxy = the existing admin gate
  (`functions/api/admin/_middleware.js`, `data.userId === ADMIN_USER_ID`). No new env var, no schema change.
- **Fire-and-forget:** all four kick off via `ctx.waitUntil` and return `started:true` immediately (matches the
  crons), so the admin request never blocks on a long job. PriceCharting returns the day-rotated `category` it
  fired.
- **Double-fire guard:** a best-effort KV lock per job (released on completion; TTL is the crash backstop). The
  Content status endpoint reads the SAME keys to render a "Running" pill + disable the button (plus an
  optimistic client window to bridge KV's eventual consistency).
- **⚠️ PriceCharting cooldown:** because the CSV download is hard rate-limited ~1/10min (abuse → account
  revocation, see `/pricecharting/fetch`), ONLY the `pricecharting-download` trigger is gated by a ~10-min
  download cooldown (`ingestion_pc_csv_cooldown`, set by ANY download — the trigger AND the `0 5` cron) so it
  can't become a rapid-loop vector. The status endpoint surfaces `cooldownRemainingSec` on that job so the UI
  pre-disables it and shows a countdown. `pricecharting-csv` (re-process the cached CSV) is **not** gated —
  reading R2 is unlimited and safe.
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

**WP-2 resurrection (2026-07-07, audit IMG-1/3/4/10) — standing behavior:**
- **Candidate selection** is the ONE shared `mirrorCandidateWhere()` (`image-mirror.ts`, used by
  `runMirrorJob` AND `getPendingCards`): eligible (never mirrored / tcgplayer→scrydex upgrade;
  OP/Gundam `source='scrydex'`+r2-NULL CDN-as-final stays excluded) AND mirrorable (Scrydex-host
  `source_url` OR English-Pokémon-with-mapped-expansion URL construction — **tcgplayer-cdn-only
  rows are never candidates**) AND due (`mirror_attempts < 5` + exponential backoff
  3·2^attempts days on `mirror_last_attempt_at`; JS spec `isMirrorRetryDue()`).
- **Attempt bookkeeping** (Content migration 0086): every processed card — success, failure, or
  skip — bumps `product_images.mirror_attempts` + `mirror_last_attempt_at` (`mirrorAttemptUpsert`).
- **Keyset pagination**: `WHERE p.id > ? ORDER BY p.id LIMIT 100` — never OFFSET.
- **Placeholder fingerprint replaces the old blanket <300 KB guard**: the run probes
  `PLACEHOLDER_PROBE_URL` (impossible card number → Scrydex returns its card-back placeholder),
  SHA-256s it, and rejects any fetched image with the same hash; 1 KB sanity floor; a failed
  probe disables detection for the run. Legit small scans now mirror. (mirror-local.mjs keeps
  its own local guard — the script is unchanged.) **Augmented 2026-07-08** by the STATIC
  `PLACEHOLDER_IMAGE_HASHES` set + a TCGplayer fallback/repair — see **Card-back placeholder
  guard** below (the live probe alone can't catch a historically-mirrored, since-re-encoded
  card-back).
- **Per-run summary ALWAYS logged**: `runMirrorJob` is try/finally'd — `image_mirror_log` gets
  processed/mirrored/failed/skipped + `first_error` even if the run dies mid-batch.
- **'Pokemon Japan' is excluded** from URL construction (`isEnglishPokemon`, lib/gameNames.ts).

`runMirrorJob()` / `mirrorCard()` flow per card:

**Attempt 1 — Scrydex CDN (English Pokémon only)**
- URL: `https://images.scrydex.com/pokemon/{scrydex_set_id}-{formattedNumber}/large`
- Requires `tcg_sets.scrydex_set_id` to be populated (set in Admin UI)
- Card number formatting (always splits on `/` first — handles TCGPlayer `number/total` format):
  - TG/GG gallery prefixes: pad numeric part to 2 digits (`TG6` → `TG06`)
  - All other letter prefixes (RC, SV, PR, …): raw digits, no padding (`RC2/RC32` → `RC2`)
  - Pure numeric: strip leading zeros (`025/165` → `25`)
- RC (Radiant Collection) cards share their parent set's `scrydex_set_id` (e.g. Generations RC → `g1`)
- One Piece Scrydex support is deferred — alternate versions use non-sequential identifiers that don't map to TCGPlayer card numbers

**Attempt 2 — stored `source_url` (non-TCGPlayer hosts only)**
- Fetches `product_images.source_url` when it is NOT a tcgplayer-cdn url (e.g. a Scrydex-host
  url that survived thanks to WP-1)
- tcgplayer-cdn urls are never fetched from the worker: datacenter IPs are **blocked (403)** by
  `tcgplayer-cdn.tcgplayer.com`, and TCGPlayer images are deliberately not mirrored anyway (below)

### TCGPlayer fallback image resolution (`_in_1000x1000`)
TCGCSV serves TCGPlayer card images as low-res `_200w` thumbnails. `transformer.ts`
`bumpTcgplayerImageRes()` rewrites them to the operator-verified `_in_1000x1000` form
before they land in `product_images.source_url` (the only image source for TCGPlayer-only
games — One Piece, Gundam — that have no Scrydex coverage). Existing rows were migrated
by Content migration `0064`. `_1000x1000` without the `_in_` infix is access-denied — do
not use it.

**Deliberate decision — do NOT mirror TCGPlayer images to R2.** Since WP-2 the enforcement
is STRUCTURAL: tcgplayer-cdn-only rows are excluded from the mirror candidate pool
(`mirrorCandidateWhere()`) and `mirrorCard` refuses to fetch a tcgplayer-cdn url from the
worker (`isTcgplayerCdnUrl` guard); `mirror-local.mjs` keeps its own ~300 KB local guard
(script unchanged). So TCGPlayer cards render from `source_url` (CDN) via the app's
`r2_url ?? source_url` resolution — never from R2. This is intentional, not an
oversight: TCGPlayer's `_in_1000x1000` images carry a "SAMPLE" watermark on most
alt-art/variant cards, so self-hosting them in R2 would spend storage to mirror a
watermarked asset we can serve from the CDN for free (end-user browsers render the
TCGPlayer CDN fine — only worker datacenter IPs are 403-blocked). Do not "fix" TCGPlayer
mirroring. The Scrydex image path is unchanged and remains preferred where it has coverage.

**Storage**: `cards/{tcgplayer_product_id}.{ext}` in R2
**Public URL**: `https://images.sleevedpages.com/cards/{id}.{ext}`
**DB update**: sets `tcg_products.image_url` to R2 URL + `tcg_products.image_source` to `'scrydex'` or `'tcgplayer'`

## Card-back placeholder guard (Step-0 fix, 2026-07-08)

**Problem (operator-confirmed, real assets):** Scrydex has no scans for some cards
(the whole **`cel25c` / "Celebrations: Classic Collection"** sub-set) and instead
serves a generic Pokémon **card-back placeholder** at HTTP 200. Because
`SOURCE_URL_PRECEDENCE_CASE` makes any `images.scrydex.com` URL win, that card-back
overwrote the correct TCGplayer `source_url` in `product_images`, the mirror stamped
it into R2, and it then won everywhere via `r2_url ?? source_url ?? snapshot`.

**Shared module `src/lib/placeholderImages.ts` — the ONE guard:**
- `PLACEHOLDER_IMAGE_HASHES: Set<string>` — SHA-256 hex of every KNOWN card-back
  body, seeded from Step-0 (live `/large` `fd7c3800…`, `/medium` `b69464a4…`,
  `/small` `01f03f71…`, **and the historical R2 object `c4d4811d…` (cards/250321.png,
  which differs from today's live placeholder — Scrydex re-encoded it, so only a
  static hash finds it)**). **How to append:** download the offending R2 object /
  Scrydex URL, `sha256sum` it, eyeball that it IS a card-back, add the hex + a note.
  A false hash would purge a real card — verify first.
- `isPlaceholderImage(bytes | hex, extraHashes?)` — pure, unit-testable, Workers-native
  `crypto.subtle` (no dependency). Hashes bytes ONCE, so format/size are irrelevant.
- `tcgplayerFullImageUrl(tcgplayer_product_id)` → `https://tcgplayer-cdn.tcgplayer.com/product/{id}_in_1000x1000.jpg`
  — the exact form `transformer.ts bumpTcgplayerImageRes` produces / mig 0064 stored
  (the original image a placeholder overwrote). `_1000x1000` without `_in_` is 403.

**Design chosen = mirror-only guard (design B), NOT a write-time guard.** The
overwrite happens in the weekly `syncScrydexImages` (thousands of `product_images`
writes/run across ~352 sets); a write-time fetch-and-hash per overwrite would blow
the 1000-subrequest/invocation cap. The mirror already fetches+hashes every candidate,
so the guard is free there. Accepted trade-off: a card-back can briefly serve via
`source_url` between a Scrydex write and the next mirror pass (self-heals). So the
Scrydex image writers are **unchanged** — the mirror + purge are the enforcement.

**Mirror-side guard + TCGplayer fallback (`image-mirror.ts`):**
- `fetchImage` now returns `'placeholder'` (sentinel) when the downloaded bytes match
  `PLACEHOLDER_IMAGE_HASHES` OR this run's live probe hash — in addition to the
  existing per-run `fetchPlaceholderHash()` fingerprint (self-updating backstop).
- On a placeholder, `tcgplayerPlaceholderFallback()` fires: reconstruct the TCGplayer
  URL and **repair `source_url` to it, r2_url/mirrored_at NULL, source NULL** (via
  `placeholderRepairUpsert`) so the app serves the real art straight from the CDN.
  It also *attempts* to mirror the TCGplayer image into R2 first, but **that usually
  403s from a worker datacenter IP** (tcgplayer-cdn blocks them — the standing
  no-TCGplayer-in-R2 reason), so the reliable outcome is the `source_url` repair, not
  an R2 write. **`mirrored_at` is NEVER stamped on a skipped/placeholder download.**
- Run counters `placeholder_skips` / `tcgplayer_fallbacks` are added to the structured
  run-summary log line + the `MirrorJobResult` (NOT to `image_mirror_log` — no
  migration this session; finer columns are a future migration).

**Precedence rule (standing):** a Scrydex card-back can never win — the mirror repairs
any placeholder to the TCGplayer image, and the app's `r2_url ?? source_url` chain then
serves real art. If Scrydex later adds a real scan it flows through normally (a real
scan won't hash-match).

**Cleanup sweep — `purge-placeholder-mirrors`** (`src/purgePlaceholderMirrors.ts`,
endpoint `POST /admin/purge-placeholder-mirrors`): bounded, cursor-based (keyset on
`products.id`), ONE batch per call → `{ scanned, purged, repaired, remaining, hasMore,
cursorNext }`. Reads each `r2_url` object from R2 (no external fetch → no
tcgplayer-cdn 403), hashes it, and on a placeholder match deletes the R2 object then
repairs the row (repairs D1-batched ≤90 BEFORE the R2 deletes, so a crash leaves a
repaired row + a stale-but-harmless object, never a nulled r2_url with the card-back
still live). Idempotent + regenerable. Loop it end-to-end with
`node scripts/purge-placeholder-mirrors.mjs` (uses `INGESTION_WORKER_SECRET`;
`--limit N`, `--url <uat>`). **Sweeps all sets** — the per-batch log lines report the
true blast radius. Celebrations (or any set) is NOT blocked from syncing; with the
guard + repair the pipeline is self-healing.

Tests: `src/lib/placeholderImages.test.ts`, `src/purgePlaceholderMirrors.test.ts`,
and the placeholder→TCGplayer cases in `src/image-mirror.test.ts`.

## Ingestion observability floor (audit WP-4, 2026-07-08 — Content migration 0090)

Every worker cron/pipeline stage now writes ONE row to a NEW generic run log,
`ingestion_run_log`, via the shared helper `src/lib/runLog.ts`:

- **`writeRunLog(db, entry)`** — a guarded INSERT. NEVER throws (missing table on an
  un-migrated DB, a transient D1 error) — a log-write failure is caught and logged, never
  masking the stage's own result. `entry.counts` (whatever the stage returned, or nothing)
  is best-effort `JSON.stringify`'d into `counts_json` — this table has NO fixed per-job
  schema on purpose, since every stage's stats look different.
- **`runStage(db, job, stage, fn)`** — wraps an EXISTING call at its call site (never
  changes `fn`'s signature/return type): times it, writes exactly one row on success OR
  failure (try/finally — the WP-2 `runMirrorJob` pattern generalised), and **rethrows**
  whatever `fn` threw so existing `.catch(err => logger.error(...))` chains keep working
  unchanged.
- **Wired at:** the weekly image-mirror pipeline's four sub-stages (`mirror`,
  `scrydex-set-mappings`, `scrydex-image-sync`, `api-log-cleanup` — see
  `adminJobs.ts` `runWeeklyImagePipeline`, job id `image-mirror`); `tcg-sync` (`sync`
  stage, both the cron default case and `/sync`/`/admin/run-job`); `scrydex-drain`
  (`drain` stage, the cron, `/scrydex/process`, and `/admin/run-job`); `pricecharting-csv`
  (`process`) / `pricecharting-download` (`fetch`); `news-poll` (`poll`).
- **`image_mirror_log` gains two columns** (mig 0090): `placeholder_skips` /
  `tcgplayer_fallbacks` — the card-back guard's counters, computed every run since that
  session but with nowhere to persist ("no migration this session", per the prior
  handoff entry). Now landed and wired into the existing per-run INSERT.
- **Surfaced in Content** — `GET /api/admin/ingestion/jobs`'s new `observability` field:
  the latest row per `(job, stage)`, `scrydex_webhook_log` status counts + the terminal
  `'failed'` count (WP-8), both unmatched feeds (`pricecharting_products` +
  `scrydex_unmatched_cards`, with a recent-rows peek), and the mirror job's last-run
  summary now also carrying `placeholderSkips`/`tcgplayerFallbacks`. See
  Content/CLAUDE.md "Observability floor (WP-4, migration 0090)".
- **Optional zero-mirror-week alert** — Content-side only (the worker has no
  `RESEND_API_KEY`); see Content/CLAUDE.md — fires opportunistically when an admin views
  the panel, gated behind `app_config.image_mirror_zero_alert_enabled` (default OFF).

Tests: `src/lib/runLog.test.ts` (the writer + the never-masks-the-result guarantee,
including against the bare `{}` `env.DB` shape `adminJobs.pipeline.test.ts` already uses).

## Dead source_url sweep (audit WP-6, 2026-07-08)

`src/deadSourceUrlSweep.ts` (`POST /admin/dead-url-sweep`) — probes
`product_images.source_url` for rows with NO `r2_url` (source_url is their ONLY serving
path — a row with an `r2_url` is unaffected by a dead source_url, since `r2_url` wins in
serving). **A bare HTTP 200 is NOT proof of life** for two reasons the audit + the
card-back session both found: ~2.5% of stored TCGPlayer source_urls are dead upstream
(403), and Scrydex serves its card-back placeholder at 200 for cards it has no scan of.
Every probed body is hashed (`isPlaceholderImage()`, the SAME guard the mirror uses) —
never trust the status code alone.

- **Manual-trigger only — no cron.** Bounded keyset batches (`products.id`, the same
  idiom as `purgePlaceholderMirrors.ts`) so it can be looped from the admin panel without
  exceeding the request budget: `{ ok, scanned, alive, dead, repaired, remaining,
  hasMore, cursorNext }`.
- **Marking reuses EXISTING bookkeeping — no new column, deliberately narrower than the
  audit's original "add `source_url_dead_at`" plan:**
  - a **plain dead** probe (non-2xx / network error / empty body) calls the SAME
    `mirrorAttemptUpsert()` the mirror itself calls on every processed card — the row
    ages out of the mirror's own candidate pool through the ordinary attempt-ceiling +
    exponential backoff (mig 0086), never a parallel mechanism.
  - a **placeholder** match repairs through the ONE existing repair path,
    `tcgplayerPlaceholderFallback()` — exported from `image-mirror.ts` (loosened to a
    `Pick<CardRow, 'tcgplayer_product_id'|'card_number'|'set_name'>` parameter so the
    sweep can call it without a full `CardRow`) — reconstructs the TCGplayer CDN url,
    opportunistically tries to mirror it, and regardless repairs `source_url` so the app
    stops serving the card-back. Never a second implementation of the repair.
- **Scope note:** the sweep does NOT add a "let serving skip known-dead URLs" mechanism
  (the audit's original WP-6 wording) — a plain-dead TCGplayer-cdn-only row has no other
  image source to fall back to anyway, so "marking" it is an observability record (dates
  it as investigated) more than an active serving change; a genuinely-Scrydex-hosted dead
  row that IS a mirror candidate benefits directly (it ages out of that pool sooner).
- **Surfaced in Content** — the WP-4 Observability panel + a loop-friendly admin proxy
  (`POST /api/admin/image-mirror/dead-url-sweep`) + UI card, mirroring the Bulk Enrich
  Run/Stop loop.

Tests: `src/deadSourceUrlSweep.test.ts` (alive / plain-dead / placeholder-repair /
network-error / keyset pagination).

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
- **WP-8 retry semantics + atomic claims (2026-07-07; Content migration 0089 adds
  `attempts`/`last_attempt_at` + `scrydex_unmatched_cards`).** Row lifecycle:
  `pending → processing (claimed) → complete | error (retryable) | failed (TERMINAL)`.
  - **Atomic claims (double-drain guard):** every candidate row is claimed with a conditional
    UPDATE (`status='processing'`, `last_attempt_at=unixepoch()`; the WHERE re-checks the observed
    state; `meta.changes===1` = the claim won) — overlapping runs (cron + manual
    `POST /scrydex/process` + the admin trigger) can never process the same row twice.
  - **Stale-claim reclaim:** a `processing` row older than `PROCESSING_STALE_SECONDS` (6h — a run
    died mid-claim) is a candidate again; the reclaim UPDATE re-checks staleness so two runs can't
    both take it. Rows claimed but unreached (maxFetches / circuit break) are RELEASED back to
    `pending` at run end.
  - **Error retry with capped backoff:** `error` rows retry when past
    `ERROR_RETRY_BASE_SECONDS << attempts` (2h, 4h, 8h, 16h, 32h) while
    `attempts < MAX_DRAIN_ATTEMPTS` (5). A row-specific failure increments `attempts`; at the cap
    the row goes **TERMINAL `'failed'`** (never selected again — poison can't loop). Unparseable
    `expansion_ids_json` goes straight to `'failed'`.
  - **Guard/403 failures burn NO attempt:** they mark `error` (visible, the June-outage invariant)
    with `attempts` unchanged — a capped month must not march innocent rows to `failed`. **The
    credit guard is the hard backstop for retries too**: it throws BEFORE any API call, so a
    retried row can never spend past the cap, and a 403 still circuit-breaks the run.
  - **Idempotent re-drain:** price writes are ON CONFLICT upserts on the superset identity key,
    and the freshness window makes a re-drain of an already-fetched expansion cost ZERO credits —
    re-processing a row is safe by construction.
  - **Unknown cards recorded, never dropped (ING-3):** a webhook card variant that resolves to NO
    canonical product upserts into `scrydex_unmatched_cards` (deduped per expansion+number+variant;
    `seen_count` ≈ days observed; `first/last_seen_at`). Queryable review surface; Admin surfacing
    is WP-4 scope.
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
- `syncScrydexImages()` runs weekly AFTER the R2 mirror stage (WP-2 mirror-first order — the
  mirror consumes last week's URLs; this refreshes them for the next run); writes
  `product_images.source_url`. Since WP-1, its Scrydex CDN urls SURVIVE the daily TCGCSV sync
  (the `SOURCE_URL_PRECEDENCE_CASE` rule: scrydex > tcgplayer). Game keys come from the shared
  `lib/gameNames.ts` map (WP-3 — 'Lorcana TCG' + the full Riftbound name; 'Pokemon Japan' absent).
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

## PriceCharting CSV Bulk-Ingest (FETCH/PROCESS split — rebuilt 2026-06-19) — the all-users graded backbone for 4 games

The production graded+ungraded price backbone for the **4 games we ingest** (Pokémon, Magic,
Yu-Gi-Oh, One Piece). It **supersedes the on-demand PriceCharting API path FOR THESE 4 GAMES**;
the on-demand `/pricecharting/graded` (admin-only) stays the live fallback for OTHER games.

**ARCHITECTURE — FETCH and PROCESS are SPLIT (the 2026-06-19 rebuild; `src/pricechartingIngest.ts`).**
The source CSV download is HARD rate-limited to **1 per 10 MINUTES** (abuse → the account's API access is
REVOKED) and each export is ~88k rows. The OLD design re-downloaded the WHOLE CSV on every windowed call
(the KV cursor was a row offset into a *fresh re-download*), so a big category NEVER finished on the daily
cron and looping to finish tripped the limit. Now:
- **FETCH** (`fetchPriceChartingCsvToR2`) — once/day/category. Download the full CSV ONCE and store the RAW
  bytes in R2 (reuses the worker's `IMAGES_BUCKET`) under a dated key
  `ingest-raw/pricecharting/{category}/{YYYY-MM-DD}.csv`. Arms the 10-min cooldown the moment a download is
  attempted (even a 429 cools down — never retry-loops). The ONLY function that hits the rate-limited URL.
  ⚠️ The response is **buffered to an `ArrayBuffer` before the R2 `put`** — R2 requires a **known length** and
  the download stream is chunked (no `Content-Length`); passing `res.body` directly throws "Provided readable
  stream must have a known length" (the bug that blocked the first prod fetch, 2026-06-20). A category export
  is ~20–30 MB, well within the 128 MB Worker budget; PROCESS still STREAMS the file back from R2. Do NOT
  revert to a raw-stream `put`.
- **PROCESS** (`processPriceChartingWindow`) — unlimited, from R2. Read the cached object and ingest the
  ENTIRE category across many Worker invocations driven by the **dedicated `PC_PROCESS_QUEUE`**
  (`sleevedpages-pricecharting-queue`). The cursor is a **row offset OVER THE R2 FILE carried IN the queue
  message** — there is NO KV cursor, so the old eventual-consistency bounce is gone. Each window is bounded
  by a wall-time budget (`PC_INGEST_BUDGET_MS`) AND a D1-batch cap (`PC_PROCESS_MAX_BATCHES`) to stay under
  the per-invocation sub-request limit, then enqueues the next offset until EOF. **Completing a big category
  costs ONE download + N cheap R2 reads — never N downloads.** Re-processing the same file is idempotent
  (upserts on the same conflict keys), so a re-process / stale fallback never double-writes.
- **Stale fallback** (`resolveProcessKey`) — PROCESS resolves today's R2 file, else the most-recent dated
  file (logged `pricecharting_process_stale_fallback`); the data is backup-behind-Scrydex, so a 1-day-stale
  file is acceptable. It NEVER re-downloads to compensate and NEVER processes nothing silently.
- **Triggers:** cron `0 5` = FETCH (rotated category) → queue PROCESS; admin `pricecharting-download` =
  FETCH+PROCESS (cooldown-gated); admin `pricecharting-csv` + `POST /pricecharting/ingest` = PROCESS the
  cached file (no download, unlimited); `POST /pricecharting/fetch` = explicit fresh download.

- **Source (operator-confirmed):** `GET https://www.pricecharting.com/price-guide/download-custom?t={PRICECHARTING_TOKEN}&category={cat}`
  for `cat` ∈ `pokemon-cards`, `magic-cards`, `yugioh-cards`, `one-piece-cards`. Returns CSV (~88k
  rows/game). The CSV download is **HARD-rate-limited to 1 per 10 MINUTES** (the file regenerates only
  ~once/24h), and **exceeding it gets the PriceCharting account's API permissions REVOKED**
  (operator-confirmed 2026-06-19). The FETCH/PROCESS split above means this download happens **at most once
  per category per day** (the cron, or an explicit cooldown-gated `POST /pricecharting/fetch`); processing
  the cached file never re-downloads. The cron pulls **ONE category per run, rotated by day** (4-day cycle).
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
  canonical products ONCE per PROCESS window (paginated, a few round trips) into `byTcgId` + `byNumber` maps;
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
- **Scale / windowing across invocations (PROCESS, from the cached R2 file):** each PROCESS window streams
  the cached object (never buffers it whole), **skips to `offset` then collects up to `PC_INGEST_MAX_ROWS`
  rows** (early-stops at the window end), matches in memory, and upserts in 500-row sub-batches **until a
  wall-time budget** (`PC_INGEST_BUDGET_MS`, default 20s — under the ~60s request cap) **OR a D1-batch cap**
  (`PC_PROCESS_MAX_BATCHES`, default 300 — under the 1000 sub-request/invocation cap). It then returns
  `cursorNext = offset + rowsProcessed` and (if `wrapped:false`) the queue consumer enqueues the next window
  at that offset. `wrapped:true` means EOF was reached and the chain stops. **The cursor lives IN the queue
  message — there is NO KV cursor** (so no eventual-consistency bounce; `pc_ingest_cursor:*` is gone). A
  budget/batch cut-off loses no progress (the cursor only advances over fully-written sub-batches; all
  writes idempotent). D1 writes are batched (≤90 statements/batch). Logs `{"log":"pricecharting_csv_process",
  …}` per window with matched/fuzzy/unmatched/sealed counts + `rowsProcessed`/`cursorNext`/`wrapped`/
  `budgetHit`/`batchHit`/`durationMs`; FETCH logs `{"log":"pricecharting_csv_fetch", …}`.
  > **✅ The 2026-06-16/19 "design flaw" (per-window re-download + KV-cursor bounce) is RESOLVED** by the
  > FETCH/PROCESS split above. The download now happens **at most once/category/day**; PROCESS reads the
  > cached R2 file unlimited times. A big ~88k-row category completes from ONE download across many cheap
  > windows driven by `PC_PROCESS_QUEUE` — never N downloads, never the 429/revocation risk, never the KV
  > bounce. "Looping the curl" is no longer a thing: trigger PROCESS once and the queue finishes the
  > category. (Historical context: the old synchronous run also hit the ~60s request cap → `canceled`;
  > the windowed-queue design caps each invocation well under both the time and sub-request limits.)
- **Migration:** `Content/migrations/0070_pricecharting_map.sql` (the `pricecharting_products` map +
  unmatched log + sales-volume — chosen over KV because 350k rows need queryable unmatched counts +
  incremental skip; the existing `pc_id_v2:*`/`pc_product:*` KV keys remain the on-demand API path's id
  cache, a separate concern). The `prices` write needs no migration (schema already has source/grade/etc).
  **The FETCH/PROCESS rebuild adds NO migration** — raw CSV bytes live in R2 (`ingest-raw/pricecharting/…`,
  reusing the existing `IMAGES_BUCKET`), not D1; the cursor is in the queue message, not a table. The new
  infra is a Cloudflare queue (`sleevedpages-pricecharting-queue` + `-uat`) the operator must `wrangler
  queues create` before deploy. Set an R2 lifecycle rule on the `ingest-raw/` prefix (e.g. delete after
  7–14 days) so dated CSVs don't accumulate.
- **Serving:** Content `getGradedPrices` now reads `prices` where `source IN ('scrydex','pricecharting')`
  → the Content "Graded Prices" section serves these to **ALL users** for the 4 games (no admin gate, no
  per-call cost). PriceCharting rows exist ONLY for the 4 ingested games, so their presence IS the gate.
- **Tests:** `src/pricechartingCsv.test.ts` (pure parsers — delimiter detection, the real One Piece
  EB02-010 tab row, parse, decode map, sealed, matchers; UNCHANGED) + `src/pricechartingIngest.test.ts`
  (rebuilt for the split: FETCH downloads ONCE → dated R2 key + arms cooldown + 429 still cools;
  PROCESS ingests from R2 with NO download, windows across the message offset, idempotent re-process,
  missing-R2 terminal; the enqueue-vs-inline driver; `resolveProcessKey` today/stale/none; and an
  **end-to-end big-category test** asserting ONE download → many windows → all rows ingested → re-process,
  download count == 1 throughout). Ingestion suite green at **198**.

### Drain credit audit (`processPendingWebhooks` — §4 #8, measure-first)

The daily drain emits a structured audit line each run for credit observability (parse from
`wrangler tail` / Logpush):
```json
{"log":"scrydex_drain_audit","rows_in":N,"rows_reclaimed_processing":R,"rows_retried_error":E,
 "rows_failed_terminal":T,"distinct_expansions":M,"expansions_fetched":F,
 "fetches_made":C,"fetches_skipped_fresh":S,"unmatched_cards":U,
 "rows_completed":...,"rows_left_pending":...,
 "circuit_broken":false,"max_fetches":1500,"freshness_hours":20,"credits_by_game":{"pokemon":C}}
```
`rows_in` vs `distinct_expansions` quantifies the **dedup collapse** (M webhook rows → 1 fetch
per distinct `(gameSlug, priceType, expansion)`); `fetches_made` (page-calls = credits) vs
`fetches_skipped_fresh` shows the freshness savings; `credits_by_game` confirms the measured
Pokémon concentration. The WP-8 counters (2026-07-07): `rows_reclaimed_processing` = stale
`processing` claims taken over, `rows_retried_error` = backoff-due error retries claimed,
`rows_failed_terminal` = rows that reached the terminal `'failed'` state this run,
`unmatched_cards` = webhook card variants recorded to `scrydex_unmatched_cards`. The `SCRYDEX_DRAIN_MAX_FETCHES` bound and the `freshnessSafeForDrain()`
<24h invariant were **audited and confirmed correct** (no code change needed beyond the log).
**Measured velocity** (pre-existing analysis): card-fetch calls were dominated by **Pokémon
(~3,426, ~80%)** before the daily batch; with daily dedup a run's `fetches_made` is bounded by
the number of distinct volatile expansions, not webhook volume — read the live per-run figure
from `credits_by_game` in the audit line.

## News Poll (2026-06-22) — DotGG RSS → news_items (LINK-OUT only)

Powers the Content **News Feed** under Discover. `src/newsPoll.ts` `runNewsPoll(env)` (the `0 7 * * *`
cron, PROD only; also the `news-poll` admin job) reads `news_sources WHERE is_active=1`, fetches each
WordPress RSS/Atom feed, and extracts **ONLY title + link + pubDate** via the dependency-free
`src/lib/feedParser.ts` `parseFeed()`. It UPSERTs `news_items` deduped on `link` (`INSERT OR IGNORE`)
and prunes items > 90 days. **IP posture: article bodies/summaries/excerpts are NEVER fetched-for-storage
or stored** — `parseFeed` doesn't even read `<description>`/`<content:encoded>`/`<summary>` (a unit test
asserts this). We link OUT for the content (mirrors the Rule Books posture).

- **Resilient + polite:** descriptive User-Agent; per-feed `try/catch` isolation (one bad/stale/blocked
  feed never aborts the run); a fetch timeout + **ONE retry** (the confirmed One Piece feed intermittently
  5xx's — the retry + the daily cadence absorb it); `http(s)`-validates each `feed_url` before fetching.
- **No key needed** (public RSS), so `news-poll` has no Scrydex/PriceCharting prereq in `/admin/run-job`.
- **Step-0-confirmed seed feeds (migration 0079, Content):** Magic (`playingmtg.com/feed/`), One Piece
  (`onepiece.gg/feed`), Lorcana (`lorcana.gg/feed/`), Flesh and Blood (`dotgg.gg/fabtcg/feed/`). Pokémon
  (`pokemontcgzone.com` WP feed frozen at 2024-08) and Yu-Gi-Oh! (`ygozone.com` dormant) were probed and
  **left OUT** — addable later with NO redeploy (a single `INSERT INTO news_sources`).
- **Tables** (`news_sources` / `news_items`) are created by the **Content** migration `0079_news_feed.sql`
  (the Content app owns the schema + serves `GET /api/news`); the worker is just the writer. `news_items`
  has NO body column. Tests: `src/feedParser.test.ts` (parser: well-formed RSS/Atom, malformed-tolerant,
  missing fields, dedupe-on-link, date parsing, **body-ignored assertion**). See Content/CLAUDE.md "News Feed".

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
| `PRICECHARTING_TOKEN` | — | PriceCharting API token. Powers (a) the admin graded-price source `GET /pricecharting/graded` (2026-06-15) and (b) the **CSV FETCH** for the 4 games (`POST /pricecharting/fetch` + the `pricecharting-download` admin job + `0 5 * * *` cron). Required ONLY by FETCH (the download); the PROCESS path reads R2 and needs no token. Set via `wrangler secret put PRICECHARTING_TOKEN` (preview + prod). Absent → FETCH 503 and the cron no-ops; cached files can still be re-processed. Token lives here only — never in the Content app, logs, or responses. |
| `PC_INGEST_MAX_ROWS` | `25000` | Rows COLLECTED into the in-memory window per PROCESS invocation. Usually stops earlier on `PC_INGEST_BUDGET_MS` / `PC_PROCESS_MAX_BATCHES`; this caps memory/window size. |
| `PC_INGEST_BUDGET_MS` | `20000` | Wall-time budget per PROCESS window before it stops + enqueues the next offset. Kept **under the ~60s Workers request-duration cap**. (No longer involves any download — PROCESS reads the cached R2 file; FETCH is the separate, cooldown-gated download.) |
| `PC_PROCESS_MAX_BATCHES` | `300` | Max `DB.batch()` calls per PROCESS window — keeps each invocation well under the **1000 sub-request/invocation** cap. Stops the window early (`batchHit:true`) and enqueues the next offset. |
| `PC_INGEST_FUZZY_MAX` | `400` | Bounded fuzzy lookups per PROCESS window (tcg-id carries the bulk). Unmatched rows are retried on later windows/days. |
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
| `image_mirror_log` | One row per mirror job with processed/mirrored/failed/**skipped**/source counts + **first_error** (Content mig 0086) + **`placeholder_skips`/`tcgplayer_fallbacks`** (Content mig 0090 — the card-back guard's counters) — written via try/finally, so a row lands even when the run dies mid-batch |
| `ingestion_run_log` | Content mig 0090 (audit WP-4): generic per-stage run log — `job`, `stage`, `started_at`, `finished_at`, `status` ('success'\|'error'), `counts_json` (best-effort, stage-shaped), `first_error`, `created_at`. ONE row per worker cron/pipeline stage invocation, written by the shared `runStage()`/`writeRunLog()` (`src/lib/runLog.ts`), success or failure. Covers every stage that has no dedicated table of its own (scrydex-drain, pricecharting, news-poll, and the 3 image-mirror sub-stages besides the mirror itself). |
| `scrydex_webhook_log` | Webhook queue, lifecycle `pending → processing (atomic claim) → complete \| error (retryable) \| failed (TERMINAL)` (**drained ONCE DAILY** `0 4 * * *`, deduped by expansion — cost control 2026-06). WP-8 (Content mig 0089): `attempts` + `last_attempt_at` back the stale-claim reclaim (6h) + capped exponential error backoff (2h·2^attempts, cap 5 → `failed`). Re-arm a terminal row: `UPDATE scrydex_webhook_log SET status='pending', attempts=0 WHERE id=?`. |
| `scrydex_unmatched_cards` | WP-8 (Content mig 0089): webhook cards with no catalogue match, recorded instead of silently dropped (ING-3). Deduped per `(scrydex_expansion_id, card_number, variant_name)` (COALESCE'd unique index — the conflict target must match it); `seen_count` ≈ days observed, `first/last_seen_at`, carries name/game_slug/tcgplayer_product_id for review. |
| `scrydex_api_log` | One row per outbound Scrydex API call — credit guard + admin dashboard. 90-day retention. |
| `variant_ingest_conflicts` | Session D-bis (mig 0065): Scrydex variant collisions (intra-payload dup product_id / cross-product) routed for admin review instead of corrupting `products`. Deduped on `(scrydex_card_id, tcgplayer_product_id, variant_name)`. |
| `pricecharting_products` | 2026-06-16 (Content mig 0070): PriceCharting CSV bulk-ingest map. `pc_id` (PK) ↔ `canonical_product_id` (NULL = unmatched/catalogue-gap), `game_category`, `match_method` ('tcg-id'\|'fuzzy'), `tcg_id`, `console_name`/`product_name`, `is_sealed`, `sales_volume`, `matched_at`, `last_seen_at`. Persisted so re-ingests are incremental + unmatched is reviewable. See **PriceCharting CSV Bulk-Ingest**. |

The old `tcg_categories` / `tcg_sets` / `tcg_products` / `tcg_prices` / `scrydex_prices` tables are
**frozen** (no longer written or read) and kept only as the rollback path until the final session.

## Re-mirror Logic
(Session D — canonical: image state lives in `product_images`, joined `products → sets → canonical_games`.
WP-2 2026-07-07: the full predicate is the shared `mirrorCandidateWhere()` in `image-mirror.ts`.)
Cards are re-queued for mirroring when ALL of:
- **eligible** — never mirrored (no `product_images` row, or `r2_url IS NULL` and `source IS NULL`),
  OR `source = 'tcgplayer' AND sets.scrydex_expansion_id IS NOT NULL` (upgrade to Scrydex art)
- **mirrorable** — `source_url` is a Scrydex-CDN url, OR the game is English Pokémon (NOT
  'Pokemon Japan') with a mapped `scrydex_expansion_id` (constructed URL). TCGPlayer-cdn-only
  rows are never candidates.
- **due** — `mirror_attempts < 5` AND past the exponential backoff
  (3·2^attempts days since `mirror_last_attempt_at`; mig 0086 columns)

A `source='scrydex'` row with `r2_url IS NULL` (One Piece/Gundam Scrydex-CDN-as-final) is intentionally
NOT eligible — this reproduces the old `image_source='scrydex'` exclusion.
Reset a row's attempts to re-arm it: `UPDATE product_images SET mirror_attempts = 0, mirror_last_attempt_at = NULL WHERE product_id = ?`.
