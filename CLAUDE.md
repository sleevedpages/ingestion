# SleevedPages — Ingestion Worker

## What this is
A Cloudflare Worker that handles two jobs:
1. **TCG data sync** — pulls card/set/price data from TCGCSV into D1 daily
2. **Image mirroring** — fetches card images from Skrydex CDN and TCGPlayer, stores them in R2

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
node scripts/mirror-local.mjs --skrydex-only   # Pokémon + One Piece high-res pass first
node scripts/mirror-local.mjs --batch 100 --concurrency 10
```

## Project Structure
```
src/
  worker.ts           # Entry point: fetch handler, cron handler, queue consumer
  image-mirror.ts     # R2 image mirroring logic + HTTP endpoint helpers
  run.ts              # Local dev runner (not deployed)
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
    skrydexUrl.ts     # URL builders for Skrydex/Scrydex image CDN
    skrydexSets.ts    # tcg_sets.name → skrydex_set_id lookup map
  types/
    db.ts             # D1 row types
    tcgcsv.ts         # TCGCSV API response types

scripts/
  mirror-local.mjs    # Fetches images from local IP → uploads to Worker → R2

db/migrations/
  001_initial.sql             # Core schema: tcg_categories, tcg_sets, tcg_products, tcg_prices, tcg_sync_log
  0002_queue_tracking.sql     # Queue-based sync tracking
  0003_supported_games.sql    # Supported games list
  0004_skrydex_image_mirror.sql  # Adds tcg_sets.skrydex_set_id + image_mirror_log table
  0005_image_source.sql       # Adds tcg_products.image_source column
```

## Cron Schedule
| Cron | Job |
|------|-----|
| `0 6 * * *` | Daily TCG data sync (categories → sets → products → prices) |
| `0 3 * * SUN` | Weekly image mirror job (Sunday 3 AM UTC) |

## HTTP Endpoints
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Health check |
| `POST` | `/sync` | Manual trigger for data sync (non-blocking) |
| `POST` | `/mirror` | Manual trigger for image mirror job (1 batch, fast) |
| `GET` | `/mirror/pending?limit=N&skrydex_only=1` | Returns next N cards needing mirroring |
| `POST` | `/mirror/upload` | Accepts base64 image bytes + writes to R2 |

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

**Attempt 1 — Skrydex CDN (Pokémon only)**
- URL: `https://images.scrydex.com/pokemon/{skrydex_set_id}-{formattedNumber}/large`
- Requires `tcg_sets.skrydex_set_id` to be populated (set in Admin UI)
- Card number formatting (always splits on `/` first — handles TCGPlayer `number/total` format):
  - TG/GG gallery prefixes: pad numeric part to 2 digits (`TG6` → `TG06`)
  - All other letter prefixes (RC, SV, PR, …): raw digits, no padding (`RC2/RC32` → `RC2`)
  - Pure numeric: strip leading zeros (`025/165` → `25`)
- RC (Radiant Collection) cards share their parent set's `skrydex_set_id` (e.g. Generations RC → `g1`)
- One Piece Skrydex support is deferred — alternate versions use non-sequential identifiers that don't map to TCGPlayer card numbers

**Attempt 2 — TCGPlayer CDN fallback**
- Uses `tcg_products.image_url` (original TCGPlayer URL)
- Worker datacenter IPs are **blocked (403)** by `tcgplayer-cdn.tcgplayer.com`
- Use `mirror-local.mjs` instead for TCGPlayer images

**Storage**: `cards/{tcgplayer_product_id}.{ext}` in R2
**Public URL**: `https://images.sleevedpages.com/cards/{id}.{ext}`
**DB update**: sets `tcg_products.image_url` to R2 URL + `tcg_products.image_source` to `'skrydex'` or `'tcgplayer'`

## Local Mirror Script (`scripts/mirror-local.mjs`)
Fetches images from your local machine's IP (bypasses CDN blocks) and hands bytes to the Worker:
1. `GET /mirror/pending` → batch of cards needing mirroring
2. For each card: fetch image locally (Skrydex or TCGPlayer)
3. `POST /mirror/upload` → Worker writes bytes to R2, updates D1

Handles both Pokémon (Skrydex + TCGPlayer fallback) and One Piece (Skrydex + TCGPlayer fallback).

`--skrydex-only` flag filters to Pokémon + One Piece cards with a Skrydex set mapping — use this first to get high-res images before the TCGPlayer pass.

## Skrydex Set Mapping
- `tcg_sets.skrydex_set_id` maps a TCGPlayer set to its Scrydex CDN identifier
- Managed via Admin UI → Skrydex Set Mappings
- Lookup map for known sets is in `src/lib/skrydexSets.ts`
- Radiant Collection (RC) cards live within the parent set (e.g. `g1` for Generations) — set `skrydex_set_id = 'g1'` on the Generations set and RC cards will resolve correctly

## Environment Variables
| Var | Default | Purpose |
|-----|---------|---------|
| `TCGCSV_BASE_URL` | `https://tcgcsv.com` | Data source base URL |
| `LOG_LEVEL` | `debug` | Log verbosity: `debug` \| `info` \| `warn` \| `error` |
| `DRY_RUN` | `false` | Skip DB writes when `true` |
| `BACKFILL_LIMIT` | null | Limit products upserted per sync (dev only) |
| `FORCE_SYNC` | `false` | Re-sync all sets regardless of `synced_at` |

## D1 Schema (Ingestion tables)

| Table | Purpose |
|-------|---------|
| `tcg_categories` | TCGPlayer games (Pokémon id=3, One Piece id=68, etc.) |
| `tcg_sets` | Sets per game. `skrydex_set_id` nullable — set in Admin to enable Skrydex mirroring |
| `tcg_products` | Cards + sealed products. `card_number` + `rarity` from extendedData (null for non-cards). `image_url` updated to R2 after mirroring. `image_source`: null \| `'skrydex'` \| `'tcgplayer'` |
| `tcg_prices` | Market prices. `sub_type_name`: `Normal`, `Holofoil`, `Reverse Holofoil`, etc. |
| `tcg_sync_log` | One row per sync run with counts + status |
| `image_mirror_log` | One row per mirror job with processed/mirrored/failed/source counts |

## Re-mirror Logic
Cards are re-queued for mirroring when:
- `image_source IS NULL` (never mirrored)
- `image_source = 'tcgplayer' AND skrydex_set_id IS NOT NULL` (can be upgraded to higher-res Skrydex image)
