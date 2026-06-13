# Ingestion Worker Audit — pre-Session D (read-only)

**Date:** 2026-06-11
**Scope:** `sleevedpages-ingestion` Cloudflare Worker (`G:\SleevedPages\Ingestion`).
**Purpose:** Map every write, read, trigger, and external contract the worker performs so
Session D (repoint the worker to write the canonical model) can be written with confidence.
The rebuild's ordering rule is **write-repoint must precede read-flip**: the deferred
catalogue-browse readers (Session C) cannot move to canonical until the worker is provably
writing canonical fresh data. This document is the spine of that repoint.

**Method:** Static analysis only. No code was changed, no worker run, no live API calls.
Every claim cites `file:line` (or function). Items that cannot be determined from static
reading are flagged as **OPEN QUESTION** for Session D to resolve at implementation time.

**Canonical schema reference** used throughout: `Content/migrations/0058_canonical_tables.sql`
(tables `canonical_games`, `sets`, `products`, `prices`, `product_images`).

---

## 0. TL;DR for Session D

- The worker writes **seven** tables today, all in the old model: `tcg_categories`,
  `tcg_sets`, `tcg_products`, `tcg_prices`, `tcg_sync_log` (TCGCSV pipeline);
  `scrydex_prices`, `scrydex_webhook_log`, `scrydex_api_log`, `image_mirror_log`
  (Scrydex/image pipeline). That is the complete repoint surface (§2).
- **The worker mints no product ids of its own** in the normal path — it relies on
  `tcg_products.tcgplayer_product_id UNIQUE` (TCGPlayer external id) and SQLite's
  `AUTOINCREMENT` for the internal `tcg_products.id`. Canonical makes `products.id` the
  spine, so Session D must resolve/create canonical `products.id` by `tcgplayer_product_id`
  (and `sets.id` by `tcgplayer_group_id`, `canonical_games.id` by `tcgplayer_category_id`)
  on every upsert (§2, §8).
- `scrydex_prices` writes the **OLD internal `tcg_products.id`** into a column misleadingly
  named `tcg_product_id` (`scrydexProcessor.ts:286`). Canonical `prices` has no such column —
  it keys on canonical `products.id`. This is the single most error-prone repoint (§2, §3).
- **`scrydex_card_id` is derivable but NOT currently captured.** The Scrydex `/{game}/v1/cards`
  response carries a card-level identifier the worker reads `card.number`, `card.variants`,
  `card.images` from but never reads `card.id`. Session D *can* populate it — but only by
  adding capture of that field; nothing today persists it (§4). **Needs a one-line confirm of
  the exact Scrydex field name against a live response.**
- The **403-masking bug** is real and precisely located: `scrydexProcessor.ts:162-168`
  (inner catch swallows a 403 and continues) + `:171-178` (row still marked `complete`). It
  is isolated to error handling and survives the repoint (§5).
- **`SCRYDEX_MONTHLY_LIMIT` config bug:** the code default is correct (`5000`,
  `scrydexClient.ts:14`) but the deployed env var is `50000` → guard threshold 49,500, never
  trips before Scrydex's real 5,000 cap. Fix is env-only, not code (§5, §6).
- The **variant-image pipeline** (One Piece / Gundam) is wired end-to-end but blocked by the
  same 403 outage; it also has a structural gap (TCGCSV ingests one row per card number;
  variant rows only exist if `seedVariantProducts` ran). Recommend splitting into **Session
  D-bis** (§7, §8).

---

## 1. Entry points and triggers

### 1a. `fetch` HTTP handler (`worker.ts:56-223`)

| Method | Path | Auth | Handler | What it does |
|--------|------|------|---------|--------------|
| GET | `/` | none | `worker.ts:59` | Health check → `{ ok, service }` |
| POST | `/sync` | none | `worker.ts:63` | Kick off `runIngestion()` in background (`ctx.waitUntil`), respond immediately |
| POST | `/scrydex/process` | `x-worker-secret` | `worker.ts:82` | Background `processPendingWebhooks(env)` |
| POST | `/scrydex/sync-sets` | `x-worker-secret` | `worker.ts:91` | Background `syncScrydexSetMappings(env)` |
| POST | `/scrydex/sync-images` | `x-worker-secret` | `worker.ts:100` | Background `syncScrydexImages(env, body.game?)` |
| POST | `/admin/sync-variant-images` | `x-worker-secret` | `worker.ts:115` | Background `backfillVariantImages(env, body.game?)` |
| POST | `/admin/seed-variant-products` | `x-worker-secret` | `worker.ts:136` | Background `seedVariantProducts(env, body.game?)` |
| POST | `/admin/backfill-r2-urls` | `x-worker-secret` | `worker.ts:157` | Background `backfillR2ImageUrls(env)` |
| POST | `/mirror` | none | `worker.ts:170` | `runMirrorJob(env, 1)` — 1 batch, blocking, returns stats |
| GET | `/mirror/pending?limit=N&scrydex_only=1` | none | `worker.ts:183` | `getPendingCards()` — next N cards needing mirror (for `mirror-local.mjs`) |
| POST | `/mirror/upload` | none | `worker.ts:194` | Decode base64 bytes → `uploadCardImage()` → R2 + DB |
| * | (any other) | — | `worker.ts:222` | 404 |

Auth gates (`worker.ts:73-80, 116-122, 137-143`): the `/scrydex/*`, `/admin/sync-variant-images`,
and `/admin/seed-variant-products` paths require `x-worker-secret === env.INGESTION_WORKER_SECRET`
**and** `SCRYDEX_API_KEY`/`SCRYDEX_TEAM_ID` to be set (503 otherwise). `/admin/backfill-r2-urls`
requires only the worker secret (no Scrydex). **`/sync`, `/mirror`, `/mirror/pending`,
`/mirror/upload`, and `/` are unauthenticated** — note for Session D, these are open POST endpoints.

**Content-app proxies (`POST /api/admin/scrydex/trigger` and image-mirror admin routes):** the
Content app calls `/scrydex/process|sync-sets|sync-images`, `/admin/backfill-r2-urls`
(per `Content/CLAUDE.md` "Image Audit" / "Card Image Resolution"), and the variant endpoints.
All go through the `x-worker-secret` header.

### 1b. `scheduled` cron handler (`worker.ts:229-275`)

Dispatch is a `switch (event.cron)`:

| Cron | Branch | Runs (in order) |
|------|--------|-----------------|
| `0 3 * * SUN` | `worker.ts:236-253` | If Scrydex keys set: `syncScrydexSetMappings` → `syncScrydexImages`; then **always** `runMirrorJob(env, Infinity)`; then `cleanupScrydexApiLog` |
| `*/10 * * * *` | `worker.ts:255-264` | If Scrydex keys set: `processPendingWebhooks(env)` |
| default (`0 6 * * *` + anything else) | `worker.ts:266-273` | `runIngestion(buildConfig(env))` — daily TCGCSV sync |

Note the weekly mirror (`runMirrorJob`) runs even without Scrydex keys (it can still do the
TCGPlayer-CDN path, though datacenter IPs are 403'd — see §6c). The default branch is a
**catch-all**: any cron string not explicitly matched runs the daily TCG sync.

### 1c. Cron registration — prod vs UAT (`wrangler.toml`)

- **Production** (`wrangler.toml:35-36`): `crons = ["0 6 * * *", "0 3 * * SUN", "*/10 * * * *"]`.
- **UAT/preview** (`wrangler.toml:101-102`): `crons = ["0 6 * * *"]` — **daily sync only.**
  The Scrydex crons are intentionally absent, documented at `wrangler.toml:95-100`
  ("Do not add the Scrydex crons back here"). **VERIFIED against the actual file** — the
  documented claim in `Ingestion/CLAUDE.md` is correct. UAT also uses a different D1
  (`sleevedpagesdb-uat`, `wrangler.toml:75-78`) and a separate queue
  (`sleevedpages-sync-queue-uat`, `:80-89`), but **shares the prod R2 bucket** (`:91-93`).

### 1d. Queue consumer (`worker.ts:285-293`)

- Queue: `sleevedpages-sync-queue` (prod) / `-uat` (preview). Binding `SYNC_QUEUE`.
- Config (`wrangler.toml:20-25`): `max_batch_size=10`, `max_batch_timeout=30`,
  `max_retries=2`, `max_concurrent_consumers=1`.
- Consumer loops messages, calls `processGroupMessage(message.body, env.DB)`, then `ack()`.
  Each message is one TCGPlayer group/set (`SyncGroupMessage`, `index.ts:30-39`). The
  consumer fetches that group's products+prices from TCGCSV and upserts them
  (`processGroupInline`, `index.ts:300-333`). **D1 errors propagate (no try/catch around
  `processGroupMessage`) so the queue retries; HTTP/transform errors are caught inside
  `processGroupInline`/`processGroupMessage` so `groups_completed` still advances**
  (`index.ts:279-292`).

---

## 2. Write surface — THE CRITICAL SECTION

Every database write the worker performs. Sourced by grepping all `INSERT`/`UPDATE`/`DELETE`/
`.batch(`/`.run()` in `Ingestion/src` and reading each site.

> **Legend for "Canonical gap":** ✅ direct equivalent · ⚠️ needs id-resolution/remap ·
> 🔴 no direct canonical column / renamed / dropped.

### 2a. TCGCSV pipeline (daily `0 6 * * *` cron, `/sync`, queue consumer)

| # | File:line / fn | Table | Op | Columns written | Trigger | Ext/Int ids | Canonical gap |
|---|----------------|-------|----|-----------------|---------|-------------|---------------|
| W1 | `ingestion/db.ts:28-58` `upsertCategory` | `tcg_categories` | UPSERT (ON CONFLICT `tcgplayer_category_id`) | `tcgplayer_category_id, name, display_name, modified_on, image_url, seo_text, is_direct_brand, synced_at` | orchestrator `index.ts:130` per category | external (`tcgplayer_category_id`) | ⚠️ → `canonical_games` (`id` minted, `tcgplayer_category_id UNIQUE`, `name`, `is_active`). No canonical column for `display_name/modified_on/image_url/seo_text/is_direct_brand` — dropped. `card_back_url` on canonical_games comes from the app `games` table, **not** TCGCSV — do not write it here. |
| W2 | `ingestion/db.ts:64-105` `upsertSetsBatch`/`bindSet` | `tcg_sets` | UPSERT (ON CONFLICT `tcgplayer_group_id`) | `tcgplayer_group_id, tcgplayer_category_id, name, abbreviation, published_on, modified_on, is_supplemental, scrydex_set_id, synced_at` | orchestrator `index.ts:181` (batched, all sets) | external (`tcgplayer_group_id`, `tcgplayer_category_id`) | ⚠️ → `sets`: `name`, `code`←`abbreviation`, `release_date`←`published_on`, `tcgplayer_group_id UNIQUE`, `scrydex_expansion_id`←`scrydex_set_id`, `game_id`←resolve `canonical_games.id` by category. **Note `scrydex_set_id` upsert uses `COALESCE(tcg_sets.scrydex_set_id, excluded…)` (`db.ts:76`)** — preserves a manually/weekly-set mapping; replicate this preserve-on-conflict in canonical. `modified_on/is_supplemental` dropped. |
| W3 | `ingestion/db.ts:111-166` `upsertProducts` | `tcg_products` | UPSERT (ON CONFLICT `tcgplayer_product_id`, batched 100) | `tcgplayer_product_id, tcgplayer_group_id, tcgplayer_category_id, name, clean_name, image_url, tcgplayer_url, modified_on, image_count, presale_info, card_number, rarity, extended_data, synced_at` | queue consumer / inline `index.ts:328` | external (`tcgplayer_product_id`, `tcgplayer_group_id`) | 🔴/⚠️ → `products`: `name`, `number`←`card_number`, `rarity`, `tcgplayer_product_id UNIQUE`, `set_id`←resolve `sets.id` by group, `product_kind` (derive from `isCard()`, `transformer.ts:20`). **No canonical columns for `clean_name` (KNOWN degradation, Content/CLAUDE.md Session B), `tcgplayer_url`, `modified_on`, `image_count`, `presale_info`, `extended_data`.** `image_url` does NOT live on `products` — it moves to `product_images` (W7/W8/W9). `image_url` preserve-on-conflict logic (`db.ts:124-128`, keep R2 url when `image_source` set) must be reproduced against `product_images`. |
| W4 | `ingestion/db.ts:172-207` `upsertPrices` | `tcg_prices` | UPSERT (ON CONFLICT `tcgplayer_product_id, sub_type_name`, batched 100) | `tcgplayer_product_id, sub_type_name, low_price, mid_price, high_price, market_price, direct_low_price, synced_at` | queue consumer / inline `index.ts:329` | external (`tcgplayer_product_id`) | ⚠️ → `prices` rows with `source='tcgplayer'`, `product_id`←resolve `products.id` by `tcgplayer_product_id`, `finish`←`sub_type_name`, `condition=NULL`, `grade=NULL`, `value`←`market_price`. **Canonical `prices.value` is market-only — `low/mid/high/direct_low` are dropped** (Content/CLAUDE.md Session B). UNIQUE identity is `(product_id, source, COALESCE(condition,''), COALESCE(finish,''), COALESCE(grade,''))`. |
| W5 | `ingestion/db.ts:213-221` `createSyncLog` | `tcg_sync_log` | INSERT | `started_at, status='running'` | `runIngestion` start `index.ts:110` | n/a | ✅ operational/bookkeeping. No canonical equivalent required; keep as-is (or rename). Returns `last_row_id` used as `syncLogId`. |
| W6a | `ingestion/db.ts:223-258` `updateSyncLog` | `tcg_sync_log` | UPDATE | `completed_at, status, tcgs_processed, sets_processed, products_upserted, prices_upserted, error_message` | inline-mode end / failure `index.ts:235,248` | n/a | ✅ bookkeeping |
| W6b | `ingestion/db.ts:275-293` `setGroupsEnqueued` | `tcg_sync_log` | UPDATE | `tcgs_processed, groups_enqueued, sets_processed=0, products_upserted=0, prices_upserted=0` | orchestrator after enqueue `index.ts:193` | n/a | ✅ bookkeeping |
| W6c | `ingestion/db.ts:297-328` `updateSyncLogProgress` | `tcg_sync_log` | UPDATE (atomic increment; flips `status='success'`/`completed_at` when `groups_completed+1 >= groups_enqueued`) | `groups_completed, sets_processed, products_upserted, prices_upserted, completed_at, status` | each queue consumer `index.ts:291` | n/a | ✅ bookkeeping. **Columns `groups_enqueued/groups_completed` are added by `db/migrations/0002_queue_tracking.sql`.** |

### 2b. Scrydex price pipeline (`*/10 * * * *` cron, `/scrydex/process`)

| # | File:line / fn | Table | Op | Columns written | Trigger | Ext/Int ids | Canonical gap |
|---|----------------|-------|----|-----------------|---------|-------------|---------------|
| W7 | `scrydexProcessor.ts:106-108` | `scrydex_webhook_log` | UPDATE | `status='processing'` | per pending row `processPendingWebhooks` | n/a | ✅ control-plane; canonical price ingestion can keep this log table or replace it. |
| W8 | `scrydexProcessor.ts:119-126` | `scrydex_webhook_log` | UPDATE | `status='complete', prices_upserted=0, credits_used=0, completed_at` | game-filtered skip | n/a | ✅ control-plane (see §5 masking bug — `complete` is also written on the error path). |
| W9 | `scrydexProcessor.ts:171-178` | `scrydex_webhook_log` | UPDATE | `status='complete', prices_upserted, credits_used, completed_at` | end of row processing (success **and** swallowed-403) | n/a | ✅/🔴 control-plane — **the masking bug, §5.** |
| W10 | `scrydexProcessor.ts:187-193` | `scrydex_webhook_log` | UPDATE | `status='error', error_message, completed_at` | outer catch (e.g. bad JSON) | n/a | ✅ control-plane (only reached on non-fetch fatals — §5). |
| **W11** | **`scrydexProcessor.ts:272-296` `buildPriceUpserts`** | **`scrydex_prices`** | **UPSERT** (ON CONFLICT `tcg_product_id, price_type, condition, is_foil, currency`, batched 100 `:157`) | **`tcg_product_id` (= internal `tcg_products.id`!), `price_type`, `condition`, `is_foil=0`, `currency`, `low_price`, `market_price`, `trends_json`, `game`, `source_expansion_id`, `last_updated`** | webhook processing `:149` | **internal `tcg_products.id`** bound from `product.id` (`:286`) — despite the column name `tcg_product_id` | 🔴 **THE critical remap.** Canonical `prices` (source='scrydex') keys on **canonical `products.id`**, `condition`←NM/LP/MP/HP/DM, `finish`←parsed from the `(foil)`/`(altArt)` suffix, `value`←`market_price`, `trend_*`←parsed from `trends_json`, `fetched_at`←`last_updated`. The internal-id → canonical-id mapping is `products.legacy_tcg_product_id = tcg_products.id` (frozen bridge, dropped in final session) OR a fresh resolve by `tcgplayer_product_id`. `is_foil`, `currency`, `game`, `source_expansion_id`, `price_type='raw'/'graded'` have no 1:1 canonical column — `price_type='graded'` rows map to `prices.grade`; `currency` (always 'USD' here) is dropped. **See §3 for the resolve query this write depends on.** |

### 2c. Scrydex set-mapping & image pipeline (weekly `0 3 * * SUN`, `/scrydex/sync-sets`, `/scrydex/sync-images`, variant admin endpoints)

| # | File:line / fn | Table | Op | Columns written | Trigger | Ext/Int ids | Canonical gap |
|---|----------------|-------|----|-----------------|---------|-------------|---------------|
| W12 | `scrydexSetMapping.ts:104-105` | `tcg_sets` | UPDATE | `scrydex_set_id` (by `tcg_sets.id`) | `syncScrydexSetMappings` weekly / `/scrydex/sync-sets` | internal `tcg_sets.id`; writes external `scrydex_set_id` | ⚠️ → `sets.scrydex_expansion_id` (by `sets.id`). Match logic (abbreviation/code/ptcgo_code then normalised name) is repointable unchanged; only the target column/PK changes. |
| W13 | `scrydexImageSync.ts:145-151` | `tcg_products` | UPDATE | `image_url, image_source='scrydex'` (by `tcgplayer_product_id`) — One Piece/Gundam variant path | `syncScrydexImages` weekly / `/scrydex/sync-images` | external `tcgplayer_product_id` | 🔴 image cols move to `product_images` (resolve `product_id` by `tcgplayer_product_id`; write `r2_url`/`source_url`+`source`). |
| W14 | `scrydexImageSync.ts:157-164` | `tcg_products` | UPDATE | `image_url, image_source='scrydex'` (by `tcgplayer_group_id`+`card_number`, only if not already R2) — variant fallback | same | external (group+number) | 🔴 → `product_images`; needs product resolution by group+number. |
| W15 | `scrydexImageSync.ts:184-192` | `tcg_products` | UPDATE | `image_url` (by `tcgplayer_group_id`+`card_number`, only if not already R2) — all-other-games card-level path | same | external (group+number) | 🔴 → `product_images`. **Note: does NOT set `image_source`** (intentional — only the R2 mirror sets source; this writes the Scrydex CDN url as a pre-mirror source_url). |
| W16 | `image-mirror.ts:119-121` | `tcg_products` | UPDATE | `image_url=<R2 url>, image_source='scrydex'` (by `tcgplayer_product_id`) — variant fast-path in `mirrorCard` | `runMirrorJob` weekly / `/mirror` | external `tcgplayer_product_id` | 🔴 → `product_images.r2_url` + `source='scrydex'` + `mirrored_at`. |
| W17 | `image-mirror.ts:156-158` | `tcg_products` | UPDATE | `image_url=<R2 url>, image_source='scrydex'` (Pokémon Scrydex-CDN path) | same | external | 🔴 → `product_images.r2_url`. |
| W18 | `image-mirror.ts:210-212` | `tcg_products` | UPDATE | `image_url=<R2 url>, image_source='tcgplayer'` (TCGPlayer fallback path) | same | external | 🔴 → `product_images.r2_url` + `source='tcgplayer'`. |
| W19 | `image-mirror.ts:287-289` `uploadCardImage` | `tcg_products` | UPDATE | `image_url=<R2 url>, image_source=<param>` (by `tcgplayer_product_id`) | `/mirror/upload` (from `mirror-local.mjs`) **and** `backfillVariantImages` (`backfillR2Urls.ts:413`) | external | 🔴 → `product_images.r2_url`. This is the shared R2-write helper — repointing it covers both the local-mirror and variant-backfill paths. |
| W20 | `image-mirror.ts:391-401` `runMirrorJob` | `image_mirror_log` | INSERT | `processed, mirrored, failed, scrydex_hits, tcgplayer_hits, duration_ms` | end of each mirror job | n/a | ✅ bookkeeping (`scrydex_hits`/`tcgplayer_hits` renamed from `skrydex_hits` by Content migration 0055). |
| W21 | `backfillR2Urls.ts:102-107` `backfillR2ImageUrls` | `tcg_products` | UPDATE (batched 100) | `image_url=<R2 url>` (by internal `tcg_products.id`) | `/admin/backfill-r2-urls` | internal `tcg_products.id` | 🔴 → `product_images.r2_url`. **Uses internal `id` in WHERE** — note for resolution. |
| **W22** | **`backfillR2Urls.ts:232-249` `seedVariantProducts`** | **`tcg_products`** | **INSERT** (batched 100) | `tcgplayer_product_id, tcgplayer_group_id, tcgplayer_category_id, name (base+variant suffix), clean_name, card_number, rarity, image_url, image_source ('scrydex'\|NULL), modified_on` | `/admin/seed-variant-products` | external (mints new product rows by Scrydex marketplace `product_id`) | 🔴/⚠️ **This is the only place the worker CREATES product rows from Scrydex data (not TCGCSV).** Canonical: INSERT into `products` (mint `products.id`, set `tcgplayer_product_id`, `set_id`, `name`, `number`, `rarity`, `product_kind='card'`, ideally `variant_kind` from `variant.name` and `scrydex_card_id` from `card.id` — both available here in the response but currently unused) + `product_images`. **See §7.** |
| W23 | `backfillR2Urls.ts:413` (calls W19) | `tcg_products` | UPDATE | via `uploadCardImage` | `backfillVariantImages` / `/admin/sync-variant-images` | external | (same as W19) |

### 2d. Scrydex API audit log (every outbound Scrydex call)

| # | File:line / fn | Table | Op | Columns written | Trigger | Canonical gap |
|---|----------------|-------|----|-----------------|---------|---------------|
| W24 | `lib/scrydexClient.ts:42-47` `logCall` | `scrydex_api_log` | INSERT | `endpoint, job_name, response_status, credits_used, status ('success'\|'error'\|'blocked'), notes` | inside `scrydexFetch` on every call (success/error/blocked) | ✅ operational; credit-guard source of truth. **Logging failures are swallowed (`:81,106,117`) and never block a response.** Carries over unchanged. |
| W25 | `lib/scrydexClient.ts:128-132` `cleanupScrydexApiLog` | `scrydex_api_log` | DELETE | rows `called_at < now-90 days` | weekly cron `worker.ts:249` | ✅ retention; unchanged. |

**Write-surface completeness check:** the grep for `INSERT/UPDATE/DELETE/.batch(/.run()` over
`Ingestion/src` returned exactly the sites enumerated above (W1–W25). `ingestion/sets.ts` and
`ingestion/products.ts` contain **no** DB access (fetch+transform only — confirmed by grep).
`run.ts` is a local dev runner (not deployed). There are **no dynamically-constructed table
names**; the only dynamic SQL is the parameterized `IN (?)` clause built from a fixed game list
(`backfillR2Urls.ts:151,338`; `scrydexImageSync.ts` two static query variants) — all column lists
are static.

---

## 3. Read surface (worker's own internal joins/resolves)

These are the worker's reads that resolve ids / dedup / check freshness. Distinct from the
app's reads — Session D must repoint these too, because canonical renames/relocates the join
columns they use.

| R# | File:line / fn | Reads | Join/resolve key | Canonical impact |
|----|----------------|-------|------------------|------------------|
| R1 | `scrydexProcessor.ts:240-242` | `tcg_products` → `id` WHERE `tcgplayer_product_id = ?` | external id → internal id (**price write W11 binds this `id`**) | Repoint to `products.id` WHERE `tcgplayer_product_id=?`. |
| R2 | `scrydexProcessor.ts:248-255` | `tcg_products p JOIN tcg_sets s ON p.tcgplayer_group_id=s.tcgplayer_group_id` WHERE `card_number` + `scrydex_set_id` | fallback product resolve by number+expansion | Repoint to `products p JOIN sets s ON p.set_id=s.id` WHERE `p.number` + `s.scrydex_expansion_id`. **`tcg_products` has no `set_id`; `products` DOES** — the join simplifies. |
| R3 | `scrydexProcessor.ts:66-72` `isExpansionFresh` | `scrydex_prices` WHERE `source_expansion_id` + `price_type` + `last_updated > now-window` | freshness dedup (relies on `idx_scrydex_prices_expansion`, migration 0042) | Canonical `prices` has **no `source_expansion_id` or `price_type` column.** Freshness must be reworked: either keep a side table, or dedup on `(product_id, source, fetched_at)` joined back to `sets.scrydex_expansion_id`. **OPEN QUESTION / design task for Session D — the cheapest freshness check today depends on a column canonical drops.** |
| R4 | `scrydexProcessor.ts:92-98` | `scrydex_webhook_log` WHERE `status='pending'` LIMIT 50 | webhook queue drain | Unchanged if `scrydex_webhook_log` is retained as the control plane. |
| R5 | `scrydexSetMapping.ts:83-88` | `tcg_sets s JOIN tcg_categories c` WHERE category name LIKE game word | sets per game to map | Repoint to `sets JOIN canonical_games`. |
| R6 | `scrydexSetMapping.ts:130-139` | `tcg_products JOIN tcg_sets JOIN tcg_categories` GROUP BY group+number HAVING count>1 | variant audit (log only) | Repoint joins; advisory only. |
| R7 | `scrydexImageSync.ts:62-101` | `tcg_sets s JOIN tcg_categories c` + `EXISTS(tcg_products … image_url not R2)` | sets needing image sync (pre-filter) | Repoint to `sets/canonical_games`; the `EXISTS` image check moves to `product_images.r2_url`. |
| R8 | `image-mirror.ts:317-337` `runMirrorJob` & `:244-262` `getPendingCards` | `tcg_products p JOIN tcg_sets s JOIN tcg_categories c` WHERE `card_number IS NOT NULL AND (image_source IS NULL OR (image_source='tcgplayer' AND scrydex_set_id IS NOT NULL))` | which cards still need mirroring (re-mirror logic) | Repoint joins to `products/sets/canonical_games`; `image_source`/`image_url` predicates move to `product_images` (`r2_url IS NULL` / `source='tcgplayer'`). This is the **re-mirror eligibility query** (Ingestion/CLAUDE.md "Re-mirror Logic"). |
| R9 | `backfillR2Urls.ts:52-63` | `tcg_products JOIN tcg_sets JOIN tcg_categories` WHERE `image_url` not R2 | rows to backfill | Repoint; predicate → `product_images`. |
| R10 | `backfillR2Urls.ts:153-161, 192-208, 340-347, 394-396` | `tcg_sets`/`tcg_categories` for sets; `tcg_products` base-row + `tcgplayer_product_id` existence checks (seed/variant) | variant seeding/backfill resolves | Repoint to canonical tables; existence checks → `products.tcgplayer_product_id`. |
| R11 | `ingestion/db.ts:260-272` `getLastSuccessfulSync` | `tcg_sync_log` WHERE `status='success'` ORDER BY `completed_at` | change-detection gate (`index.ts:84`) | Bookkeeping table; unchanged. |
| R12 | `ingestion/categories.ts:24-31` `loadSupportedTcgs` & `price-config.ts:35-44` `loadPriceConfig` | `tcg_supported_games` (`label, terms, price_priority, enabled`) | which games to sync + price subtype priority | **Config table, NOT a `tcg_*` catalogue table.** Independent of the canonical rebuild — leave as-is. (Added by `db/migrations/0003_supported_games.sql`.) |
| R13 | `lib/scrydexClient.ts:23-31` `getMonthlyCreditsUsed` | `scrydex_api_log` SUM(`credits_used`) this month, `status != 'blocked'` | credit guard | Unchanged. |

---

## 4. The `scrydex_card_id` question

**Finding: `scrydex_card_id` is derivable from data the worker already fetches, but is NOT
captured anywhere today. The audit note "Session D populates it from Scrydex" is achievable but
requires NEW capture code — nothing currently reads the Scrydex card identifier.**

Evidence:
- The worker fetches `/{game}/v1/cards?expansion=…&include=prices` and iterates the returned
  card objects in three places: `scrydexProcessor.ts:221-301` (prices), `scrydexImageSync.ts:103-195`
  (images), `backfillR2Urls.ts:188-251` (seed) and `:379-426` (variant images).
- In **every** loop the code reads `card.number`, `card.variants`, `card.images`,
  `variant.marketplaces`, `variant.name`, `variant.prices`, `variant.images` — but **never
  `card.id`** (grep for `card.id`/`c.id` in `Ingestion/src` returns only `exp.id` for
  *expansions* in `scrydexSetMapping.ts:69` and SQL `p.id`/`s.id` column refs; no read of a
  Scrydex *card* id).
- The Scrydex object model demonstrably carries a top-level `id`: the expansions response is
  read as `exp.id` (`scrydexSetMapping.ts:69`). By the same API convention the cards response
  exposes a card-level `id` (the Scrydex card identifier, e.g. a slug like `base1-4`), which is
  exactly what `products.scrydex_card_id TEXT UNIQUE` (`0058:74`) is meant to hold.

**Conclusion for Session D:**
- `scrydex_card_id` **can** be populated, but only by adding `card.id` capture to the cards-loop
  writers (most naturally W11 price upsert and/or W22 seed, since those already iterate cards
  with a resolved product). It is **not** present in the webhook payload itself (the webhook is a
  change-signal only — see §6b); it lives in the post-webhook `/cards` pull.
- **OPEN QUESTION (verify at implementation):** the exact field name on the Scrydex *card*
  object (`id` vs `card_id` vs nested) cannot be 100%-confirmed from static reading because no
  captured sample response exists in the repo. Confirm against one live `/{game}/v1/cards`
  response (or the Scrydex API docs) before wiring it. If the field is per-**variant** rather
  than per-card, `scrydex_card_id`'s UNIQUE constraint and one-row-per-product assumption need
  review (variant rows would each need a distinct Scrydex id).
- Because population depends on a working `/cards` endpoint, it is **blocked by the 403 outage**
  until the cap lifts — another reason to scope it into Session D-bis (§8).

---

## 5. The 403-masking bug

**Location (precise):** `Ingestion/src/scrydexProcessor.ts`.

Control flow that swallows the error:
1. `fetchExpansionCards` throws on a non-OK response: `if (!res.ok) throw new Error('Scrydex ${res.status} …')` — `scrydexProcessor.ts:214`. A 403 (`CREDIT_CAP_HIT`) hits this.
2. The per-expansion `try/catch` inside the row loop catches it: `scrydexProcessor.ts:162-168`. It special-cases only `ScrydexCreditLimitError` (the *internal* guard, `:163-165`) → `break`. **Any other error — including the 403 `Error` — falls to `console.error(...)` and the loop `continue`s** (`:167`). Note: an HTTP 403 is **not** a `ScrydexCreditLimitError` (that class is only thrown by the pre-call guard in `scrydexClient.ts:84`), so the circuit-breaker `break` is never taken on a real outage.
3. After the expansion loop completes (all expansions having silently failed), the row is unconditionally marked **complete**: `scrydexProcessor.ts:171-178` writes `status='complete', prices_upserted=0, credits_used=0, completed_at=unixepoch()` (W9).
4. The outer `catch` (`:185-194`, W10) — the only path that writes `status='error'` — is reached **only** for fatals *outside* the expansion loop (e.g. `JSON.parse(expansion_ids_json)` failing at `:111`). A fetch 403 never reaches it.

**Net effect:** a multi-day, all-games outage looks like a stream of clean `complete` webhooks
with 0 prices — no surfaced error, no retry, no alert. Matches the handoff's open-item #0 exactly
(`Partner_Platform_Handoff_Summary.md:362-374`).

**Fix shape (do NOT implement — for Session D):** track hard fetch failures per webhook; on a
fetch failure mark the row `status='error'` (retryable/visible) instead of `complete`; treat a
403/`CREDIT_CAP_HIT` as a circuit-breaker that `break`s the run like `ScrydexCreditLimitError`
(so the batch stops burning calls on guaranteed-403 expansions); surface failures in the admin
Scrydex dashboard. **Isolation:** the bug is entirely within error-handling/control-flow around
`fetchExpansionCards` and the `scrydex_webhook_log` status writes (W7–W10). It touches **no join
keys or price columns**, so it is orthogonal to the canonical repoint and survives it unchanged —
it can land in Session D or even before, independently.

**Related config bug (env, not code):** the credit guard's code default is correct —
`DEFAULT_MONTHLY_LIMIT = 5000` (`scrydexClient.ts:14`), threshold `limit-500` (`:68`). But the
deployed `SCRYDEX_MONTHLY_LIMIT=50000` (per both CLAUDE.md files) makes the threshold 49,500,
which never trips before Scrydex's real 5,000 cap. **Fix:** set `SCRYDEX_MONTHLY_LIMIT` to the
true cap in **both** worker and Content app. No code change. (If the env var were simply unset,
the code would already do the right thing.)

---

## 6. External dependency contracts

### 6a. TCGCSV (`https://tcgcsv.com`, `TCGCSV_BASE_URL`)

Endpoints pulled (via `RateLimitedClient`, `ingestion/http.ts`):
- `GET /last-updated.txt` — change detection (`index.ts:42-49`). Parsed as a `Date`; if
  `<= lastSuccessfulSync` and not `FORCE_SYNC`, the run exits early (`index.ts:92-106`).
- `GET /tcgplayer/categories` — all categories (`categories.ts:50`). Matched against
  `tcg_supported_games.terms` substrings → `ResolvedCategory`. → **W1** `tcg_categories`.
- `GET /tcgplayer/{categoryId}/groups` (sets) — `sets.ts` (`fetchGroups`). → **W2** `tcg_sets`.
- `GET /tcgplayer/{categoryId}/{groupId}/products` and `/prices` — `products.ts` (`fetchGroupData`).
  → **W3** `tcg_products`, **W4** `tcg_prices`.

Mapping TCGCSV → `tcg_*` is in `transformer.ts`:
- `transformCategory` (`:26-40`), `transformGroup` (`:42-57`), `transformProduct` (`:59-79`),
  `transformPrice` (`:81-95`).
- `card_number` ← `extendedData["Number"]`, `rarity` ← `extendedData["Rarity"]`
  (`getExtendedValue`, `:6-12`). `isCard()` (`:20-24`) = has `Rarity` or `Number` extendedData —
  **this is the source for canonical `products.product_kind` ('card' vs 'sealed').** All products
  are stored regardless (`transformGroupData:107-109`).
- `transformGroup` also sets `scrydex_set_id` from a **static name→id lookup**
  `getScrydexSetId(group.name)` (`lib/scrydexSets.ts`) — a hard-coded Pokémon map used as the
  initial seed before the weekly `syncScrydexSetMappings` (W12) refines it.

This is what becomes **TCGCSV → canonical** in Session D (W1→canonical_games, W2→sets,
W3→products, W4→prices source='tcgplayer').

### 6b. Scrydex (`https://api.scrydex.com`, via `scrydexClient.ts`)

- **Single entry point:** `scrydexFetch(env, endpoint, jobName, {params})` (`scrydexClient.ts:61-122`).
  Headers `X-Api-Key`, `X-Team-ID`, `Accept: application/json` (`:97-101`). **No file calls
  Scrydex directly** — confirmed; all callers import `scrydexFetch`.
- **Endpoints used:**
  - `/{game}/v1/expansions?limit=500` — set mapping (`scrydexSetMapping.ts:48`). Reads
    `exp.id`, `exp.code`, `exp.ptcgo_code`, `exp.name`.
  - `/{game}/v1/cards?expansion={scrydex_set_id}&limit=500[&include=prices]` — prices
    (`scrydexProcessor.ts:212`, with `include=prices`), images (`scrydexImageSync.ts:111`,
    no prices), seed/variant (`backfillR2Urls.ts:171,364`, no prices).
  - `/account/v1/usage` is **NOT** called by the worker (it's the Content app's
    `/api/admin/scrydex/usage`). The worker's credit accounting is purely local via
    `scrydex_api_log` (R13).
- **Webhook payload shape (change-signal only — VERIFIED by absence):** the worker never reads
  prices from a webhook. It reads only `scrydex_webhook_log.event_name` and
  `expansion_ids_json` (`scrydexProcessor.ts:93-111`), derives `gameSlug = eventName.split('.')[0]`
  and `priceType = eventName.includes('graded') ? 'graded' : 'raw'` (`:113-114`), then **pulls**
  the actual prices from `/{game}/v1/cards?include=prices`. So the webhook carries a game/event
  name + a list of expansion ids — **no prices**. Confirms the handoff. (The Content app writes
  `scrydex_webhook_log`; the worker only consumes it — that INSERT is in the Content app, not in
  this audit's write surface.)
- **`?include=prices`:** used **only** in the price processor (`scrydexProcessor.ts:210`).
  Image/seed/variant pulls omit it. The price shape consumed: `card.variants[].prices[]` with
  `price.type` (matched to `'raw'`/`'graded'`), `price.condition`, `price.currency`, `price.low`,
  `price.market`, `price.trends` (`scrydexProcessor.ts:260-296`). Variant matching:
  `variant.marketplaces[].name==='tcgplayer'` → `.product_id` (`:234-235`).
- **Credit-guard wrapper:** `scrydexFetch` pre-checks `getMonthlyCreditsUsed(db)` (SUM of
  `scrydex_api_log.credits_used` this month where `status!='blocked'`, R13) against
  `SCRYDEX_MONTHLY_LIMIT - 500`. If exceeded, it logs a `blocked` row (W24) and throws
  `ScrydexCreditLimitError` (`:78-85`). Reads `env.SCRYDEX_MONTHLY_LIMIT` (`:67`), default 5000.
  Every non-blocked call logs `credits_used=1` (`:105,116`) — i.e. credit accounting assumes
  1 credit/call. **Note:** on a 403 the call is logged `status='error', credits_used=1` even
  though Scrydex doesn't bill blocked/403 calls (handoff:340) — a minor local over-count, not a
  correctness issue.

### 6c. R2 image mirroring (`IMAGES_BUCKET`, `https://images.sleevedpages.com`)

Flow source-url → R2 → DB column:
- Source url chosen per `mirrorCard` (`image-mirror.ts:102-215`): variant fast-path
  (caller-supplied url, W16) → Pokémon Scrydex CDN
  (`buildScrydexImageUrl(scrydex_set_id, card_number)` or `…FromSetName`, `:139-141`, W17) →
  TCGPlayer `image_url` fallback (W18). **Worker datacenter IPs are 403'd by
  `tcgplayer-cdn.tcgplayer.com`** (Ingestion/CLAUDE.md) — hence `mirror-local.mjs` +
  `/mirror/pending`/`/mirror/upload` exist to fetch from a residential IP and hand bytes back
  (W19).
- Bytes written to R2 key `cards/{tcgplayer_product_id}.{ext}` (`:113,147,195,279`), public url
  `https://images.sleevedpages.com/cards/{id}.{ext}`.
- DB record: `UPDATE tcg_products SET image_url=<R2 url>, image_source='scrydex'|'tcgplayer'`
  (W16–W19). A placeholder guard rejects Scrydex card-back images `< 300 KB` (`:80`).
- **Canonical:** `image_url`/`image_source` on `tcg_products` map to
  `product_images.r2_url`/`source_url`/`source`/`mirrored_at` (`0058:110-117`). Every W13–W19,
  W21, W23 must write `product_images` keyed on resolved `products.id`. The re-mirror
  eligibility (R8) and the `image_url LIKE 'images.sleevedpages.com%'` "already R2" predicate
  (everywhere) become `product_images.r2_url IS [NOT] NULL`.

---

## 7. Variant image pipeline (One Piece / Gundam)

**Current end-to-end flow:**
1. **Set mapping (W12, `syncScrydexSetMappings`):** maps `tcg_sets.scrydex_set_id`. For
   variant-image games it also runs a **log-only audit** (R6, `scrydexSetMapping.ts:128-153`)
   counting `card_number`s with >1 product row, printing "run backfillVariantImages…".
2. **Seed (W22, `seedVariantProducts`, `/admin/seed-variant-products`):** because **TCGCSV
   ingests only ONE product row per card number** for these games (`backfillR2Urls.ts:138-145`
   comment), the per-variant TCGPlayer product rows often don't exist. This job fetches Scrydex
   `/cards`, finds each `variant.marketplaces[tcgplayer].product_id`, and **INSERTs a missing
   `tcg_products` row** cloned from the base row (name + variant suffix) with the variant's front
   image. Skips if the `product_id` already exists or no base row found (`:200-218`).
3. **Image sync (W13/W14, `syncScrydexImages`):** for One Piece/Gundam, matches each
   `variant` by `marketplaces[tcgplayer].product_id` → writes `variant.images[front].large`
   to that product row; falls back to card_number match when a variant has no marketplace entry
   (`scrydexImageSync.ts:126-174`).
4. **Variant image backfill (W19 via W23, `backfillVariantImages`, `/admin/sync-variant-images`):**
   re-mirrors the correct per-variant image into R2 for product_ids that already exist
   (`backfillR2Urls.ts:331-466`).

**Where it breaks (read-only diagnosis):**
- **Structural ordering dependency:** steps 3/4 only affect rows that exist. If `seedVariantProducts`
  (step 2) hasn't run/succeeded for a set, the alt-art `product_id`s are absent, so
  `syncScrydexImages`'s primary `product_id` match finds nothing and the **fallback writes the
  same base-art image to all variants of a card_number** (`scrydexImageSync.ts:152-166`,
  `backfillVariantImages` verifies existence at `:394-401` and **skips** missing ones → `setSkipped++`).
  Net: missing variant rows ⇒ variants never get distinct images. This matches the handoff's
  "variant images still not pulling for One Piece/Gundam."
- **Current hard blocker:** every step 2–4 calls `/{game}/v1/cards`, which is **403
  (`CREDIT_CAP_HIT`) since 2026-06-07** — so seeding and variant imaging cannot run at all right
  now regardless of logic correctness. The variant pipeline is **blocked, then structurally
  incomplete** — fixing the logic is moot until the cap lifts.
- **Possible data-quality gap (OPEN QUESTION):** `seedVariantProducts` clones `base.card_number`
  and `base.clean_name`/`rarity` onto the new row (`backfillR2Urls.ts:240-248`) and sets
  `image_source='scrydex'` only if an image was found. It does **not** capture `variant.name` as a
  structured field or the Scrydex card id — so even after seeding, there's no clean
  `variant_kind`/`finish` to carry into canonical. Whether the existing seeded rows are correct
  enough to map cleanly needs a live-data check Session D-bis should do.

**What the canonical columns mean for the fix:**
- `products.variant_kind` (`0058:71`, NULL today, no source column) — the natural home for
  `variant.name` (`'normal'|'foil'|'altArt'|…`). Seeding (W22) is the place to populate it going
  forward, since that's where variants are enumerated.
- `products.finish` (`0058:72`, NULL today) — per-product finish; canonical notes "price-level
  finish carries it" today. For variant games, finish is effectively the variant.
- `products.tcgplayer_product_id` (UNIQUE) — already the per-variant key the worker matches on;
  maps 1:1.
- `products.scrydex_card_id` — capturable here from `card.id` (§4) if the field is confirmed.

**Recommendation:** the variant pipeline is **not a clean fold into the core repoint.** It needs
(a) the 403 lifted, (b) live-data validation of seeded rows, and (c) new `variant_kind`/`finish`/
`scrydex_card_id` capture — all of which are post-write-repoint concerns. **Split into Session
D-bis** (see §8).

---

## 8. Session D repoint plan (recommendation, not implementation)

### 8a. Order of operations (write-repoint, then read-flip)

**Phase 1 — preconditions (no worker code):**
1. Lift the Scrydex 5,000 cap on the dashboard **and** set `SCRYDEX_MONTHLY_LIMIT` to the true
   cap in worker + Content app (§5). Until the cap lifts, no Scrydex write path can be validated.
2. Land the small, rewrite-independent **403-masking fix** (§5) — optional but cheap, and makes
   the rest of Session D observable instead of silently "complete".

**Phase 2 — write-repoint (the worker becomes the canonical writer):** repoint in dependency
order so foreign keys resolve. For each, add an id-resolution step (canonical has no external
unique that the worker can blind-upsert on except the ones marked UNIQUE in 0058):
1. **W1 → `canonical_games`** (resolve/mint by `tcgplayer_category_id UNIQUE`). Don't touch
   `card_back_url` (app-owned).
2. **W2 + W12 → `sets`** (resolve/mint by `tcgplayer_group_id UNIQUE`; set `game_id` from
   canonical_games; preserve `scrydex_expansion_id` on conflict — replicate the
   `COALESCE` from `db.ts:76`).
3. **W3 + W22 → `products`** (resolve/mint by `tcgplayer_product_id UNIQUE`; set `set_id`,
   `product_kind` from `isCard()`). This is where the **internal-id mint** now happens:
   canonical `products.id` is auto-incremented by SQLite on first insert of a new
   `tcgplayer_product_id`; the worker resolves it with `SELECT id FROM products WHERE
   tcgplayer_product_id=?` (replacing R1). For the price-fallback resolve (R2), use
   `products JOIN sets`.
4. **W4 → `prices` (source='tcgplayer')** (resolve `product_id` by `tcgplayer_product_id`;
   `finish`←`sub_type_name`; `value`←`market_price`).
5. **W11 → `prices` (source='scrydex')** — the critical one. Replace the `tcg_product_id`
   (old internal id) bind with the **canonical `products.id`** resolved via R1/R2; split the
   `(foil)`/`(altArt)` suffix into `finish`; map `price_type='graded'` to `grade`; parse
   `trends_json` into `trend_1d…90d`; `value`←`market_price`; `fetched_at`←`last_updated`.
   **Rework the freshness check (R3)** which currently depends on the dropped
   `source_expansion_id`/`price_type` columns — design decision flagged as OPEN QUESTION.
6. **W13–W19, W21, W23 → `product_images`** (resolve `product_id`; write
   `r2_url`/`source_url`/`source`/`mirrored_at`). Repoint the re-mirror eligibility query (R8)
   and every `image_url LIKE 'images.sleevedpages.com%'` predicate to `product_images.r2_url`.
7. **Bookkeeping (W5/W6/W20/W24/W25) and the webhook control log (W7–W10):** leave on their own
   tables (`tcg_sync_log`, `image_mirror_log`, `scrydex_api_log`, `scrydex_webhook_log`) — they
   are operational, not catalogue data, and have no canonical equivalent. (Optionally rename
   later; not required.)

**Phase 3 — delta carry-over (Scrydex rows written between Session A and the D repoint):**
- Migration 0060 froze a snapshot of `scrydex_prices` into canonical `prices` at Session A time.
- Any `scrydex_prices` rows the `*/10` cron wrote **after** 0060 but **before** the D repoint are
  stranded unless carried. **The 403 outage means this delta is currently ~0** (all `complete`
  webhooks upserted 0 rows since 06-07; only 1,749 total rows ever exist, frozen 06-07 02:52 —
  handoff:375-378). **But the cap will be lifted in Phase 1**, so between lift and repoint the
  cron *will* start producing rows again. Carry them with a one-shot copy:
  `scrydex_prices` → `prices` joined `scrydex_prices.tcg_product_id =
  products.legacy_tcg_product_id` (the frozen bridge), de-duped against existing `prices` by the
  `uq_prices_identity` index. Run this copy **immediately before** flipping the worker, or simply
  let the first post-repoint cron re-fetch (a normal re-sync repopulates everything — handoff:381;
  no end-user data is at stake either way). **Recommendation: prefer re-sync over delta-copy** —
  simpler, and the freshness window will naturally refill canonical `prices` once the worker
  writes there directly.

**Phase 4 — read-flip (the deferred Session C readers):** only after Phase 2 is verified writing
fresh canonical data, flip the catalogue-browse readers Session C deliberately left on `tcg_*`
(per `Content/CLAUDE.md` Session C "Deliberately deferred to Session D"):
`functions/api/cards/search`, `cards/lookup`, `*/from-set`, `import/search-cards`,
`functions/lib/cardLookup.js`, `scan-card`, `scan-staging`, plus the secondary owned-card image
displays `inventory/index`, `binders/[id]/sideboard`, `national-dex/*`, and the admin
image-mirror/tcg tools. These must NOT flip before Phase 2, or they'd read the frozen Session-A
snapshot as if fresh — the exact bug the rebuild exists to kill.

### 8b. Recommendation: one session or two?

**Split.** Two scopes with different risk and different blockers:

- **Session D (core repoint) — do now-ish, once the cap is lifted:** Phases 1–4 above for the
  **TCGCSV pipeline + the raw Scrydex price write (W11) + image writes**. This is mechanical
  id-remapping with clear canonical targets and is the thing that unblocks the read-flip
  (satisfies the write-before-read ordering rule). Include the 403-masking fix and the
  `SCRYDEX_MONTHLY_LIMIT` correction (both rewrite-safe).
- **Session D-bis (variant images + `scrydex_card_id`) — defer:** the variant pipeline (§7) and
  `scrydex_card_id` population (§4) both (a) are blocked by the 403 until the cap lifts and real
  `/cards` data flows, (b) need new structured capture (`variant_kind`/`finish`/`scrydex_card_id`)
  that doesn't exist in any current write, and (c) need live-data validation of the seeded
  variant rows. Bundling them into Session D would couple a mechanical, verifiable repoint to an
  open-ended data-quality investigation. Keep them separate.

### 8c. Open questions for Session D (cannot be resolved by static reading)

1. **Scrydex card-id field name (§4):** confirm the exact field (`card.id`?) on a live
   `/{game}/v1/cards` response, and whether it's per-card or per-variant, before populating
   `products.scrydex_card_id`.
2. **Freshness check redesign (R3):** canonical `prices` drops `source_expansion_id` and
   `price_type` — decide how `processPendingWebhooks` dedups without them (side table vs. join
   through `sets.scrydex_expansion_id` vs. `(product_id, source, fetched_at)` window).
3. **Seeded variant row quality (§7):** validate existing One Piece/Gundam seeded rows against
   live Scrydex once `/cards` works — do they map cleanly to `variant_kind`/`finish`?
4. **`prices.value` loss of `low/mid/high/direct_low` (W4) and `low_price` (W11):** confirm no
   app reader needs the dropped TCGPlayer low/mid/high once the worker stops writing them
   (Content/CLAUDE.md says `value` is market-only — but the worker currently still *writes* the
   full set to `tcg_prices`; after repoint those columns vanish from the canonical write).
5. **`scrydex_expansion_id` NON-unique (17 prod dupes, `0058:26-31`):** the per-expansion
   resolve in R2/R3/R5/R7 must tolerate a non-unique expansion id (RC/sub-sets share a parent) —
   confirm the resolve picks the right set when an expansion id maps to multiple `sets` rows.

---

## Appendix — files read for this audit

`worker.ts`, `wrangler.toml`, `ingestion/index.ts`, `ingestion/db.ts`, `ingestion/transformer.ts`,
`ingestion/categories.ts`, `ingestion/price-config.ts`, `ingestion/scheduler.ts`,
`ingestion/sets.ts`, `ingestion/products.ts` (grep-confirmed no DB), `types/db.ts`,
`scrydexProcessor.ts`, `scrydexSetMapping.ts`, `scrydexImageSync.ts`, `backfillR2Urls.ts`,
`image-mirror.ts`, `lib/scrydexClient.ts`, `db/migrations/001_initial.sql`,
`db/migrations/0005_image_source.sql`; both `CLAUDE.md` files; `Content/CLAUDE.md` canonical
sections; `Content/migrations/0058_canonical_tables.sql`;
`Content/Partner_Platform_Handoff_Summary.md` open-item #0.

**No files were modified. No worker was run. No live API calls were made.**
