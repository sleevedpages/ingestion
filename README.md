# SleevedPages — TCGCSV Ingestion Worker

A Cloudflare Worker that pulls card data from [TCGCSV](https://tcgcsv.com) daily
and upserts it into the shared SleevedPages D1 database. Runs on a Cron Trigger
alongside the main SleevedPages Pages app — both bind to the same `sleevedpagesdb`
D1 database.

Ingests cards, sets, and market prices for Pokemon, Magic: The Gathering, One Piece,
and Gundam.

---

## Prerequisites

- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- Authenticated with `wrangler login`
- The `sleevedpagesdb` D1 database already provisioned (shared with the main app)

---

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars   # edit as needed for local overrides
```

---

## Apply the schema migration

The tcg_* tables need to be added to the existing D1 database once before the first
sync. This is safe on an existing database — all statements use `IF NOT EXISTS`.

```bash
# Local dev database
npm run migrate:local

# Production database
npm run migrate:remote
```

---

## Running

### Local development

```bash
npm run dev
```

Starts the Worker locally at `http://localhost:8788`. The D1 binding connects to
a local SQLite file managed by Wrangler.

### Trigger a manual sync (local)

```bash
# macOS / Linux
curl -X POST http://localhost:8788/sync

# Windows PowerShell (curl is an alias for Invoke-WebRequest — use curl.exe or native PS)
curl.exe -X POST http://localhost:8788/sync
# or: Invoke-WebRequest -Method POST -Uri http://localhost:8788/sync
```

The Worker responds immediately with `{ "ok": true, "message": "Sync started" }`
and runs the ingestion in the background via `ctx.waitUntil`.

### Test the cron trigger locally

```bash
wrangler dev --test-scheduled

# In a separate terminal — macOS/Linux:
curl "http://localhost:8788/__scheduled?cron=0+6+*+*+*"

# Windows PowerShell:
curl.exe "http://localhost:8788/__scheduled?cron=0+6+*+*+*"
```

### Deploy to production

```bash
npm run deploy
```

### Trigger a manual sync (production)

```bash
curl.exe -X POST https://sleevedpages-ingestion.sleevedpages.workers.dev/sync
# Windows: curl.exe -X POST https://...
```

---

## Staged initial backfill

Pokemon and Magic each have 200+ sets. A full first sync pushes close to
TCGCSV's 10,000 req/day limit. Stage it with `BACKFILL_LIMIT` (sets per TCG
per run) and `FORCE_SYNC` (bypass the "no change" early-exit):

Set these as temporary overrides in Cloudflare dashboard → Worker → Settings → Variables,
or via `wrangler secret put`, then remove them after the backfill is complete.

```
# Day 1 — set in dashboard or wrangler.toml [vars]
BACKFILL_LIMIT = "50"

# Day 2+ — also needed because TCGCSV may not have refreshed
FORCE_SYNC = "true"
BACKFILL_LIMIT = "50"

# Once all sets show no "deferred groups" warnings, remove both vars.
```

`BACKFILL_LIMIT` applies **per TCG**, so `BACKFILL_LIMIT=50` across four games
processes at most 200 sets (≈ 400–410 requests including overhead).

---

## Change detection

On every run the Worker fetches `https://tcgcsv.com/last-updated.txt` and
compares it against the `completed_at` of the most recent successful sync in
`tcg_sync_log`. If TCGCSV hasn't updated, the run exits immediately without
making any further requests. Set `FORCE_SYNC=true` to bypass this check.

---

## Price subtypes

Some cards have multiple price rows differentiated by `sub_type_name`
(e.g. `Normal`, `Holofoil`, `Reverse Holofoil`). All variants are stored in
`tcg_prices` with the composite unique key `(tcgplayer_product_id, sub_type_name)`.

When the app layer needs a single default price per card, use
[`src/ingestion/price-config.ts`](src/ingestion/price-config.ts). It exports
`PRICE_SUB_TYPE_PRIORITY` and a `pickPreferredSubType()` helper. It also
includes a copy-paste SQL snippet using `DISTINCT ON` (Postgres) or the
equivalent `GROUP BY` approach for SQLite/D1.

| TCG       | Default price priority                                          |
|-----------|-----------------------------------------------------------------|
| Pokemon   | Holofoil → Normal → 1st Edition Holofoil → Reverse Holofoil    |
| Magic     | Normal → Foil                                                   |
| One Piece | Normal                                                          |
| Gundam    | Normal                                                          |

---

## Environment variables

Set non-sensitive values in `wrangler.toml` under `[vars]`. Set secrets with
`wrangler secret put <NAME>`.

| Variable          | Where to set     | Default              | Description                                        |
|-------------------|------------------|----------------------|----------------------------------------------------|
| `DB`              | wrangler.toml    | (D1 binding)         | D1 database binding — configured automatically     |
| `TCGCSV_BASE_URL` | wrangler.toml    | `https://tcgcsv.com` | Override the TCGCSV base URL                       |
| `LOG_LEVEL`       | wrangler.toml    | `info`               | `debug` / `info` / `warn` / `error`               |
| `DRY_RUN`         | dashboard / vars | `false`              | Fetch and transform but skip all DB writes         |
| `BACKFILL_LIMIT`  | dashboard / vars | *(no limit)*         | Max sets per TCG per run — for staged initial load |
| `FORCE_SYNC`      | dashboard / vars | `false`              | Bypass "no TCGCSV change" early-exit              |

---

## Structured logging

All output is JSON lines, visible in the Cloudflare dashboard under
Workers → Logs (live) or via Logpush. Example:

```json
{"timestamp":"2024-01-15T06:00:01Z","level":"info","message":"Starting TCGCSV ingestion run","dryRun":false,"forceSync":false,"backfillLimit":"none"}
{"timestamp":"2024-01-15T06:00:02Z","level":"info","message":"Resolved category","label":"Pokemon","categoryId":3,"apiName":"Pokemon"}
{"timestamp":"2024-01-15T06:00:45Z","level":"info","message":"Ingestion run complete","durationMs":43210,"setsProcessed":182,"setsFailed":0,"cardsUpserted":14320,"pricesUpserted":28640}
```

---

## Adding a new TCG

Edit [`src/ingestion/categories.ts`](src/ingestion/categories.ts) and add the
TCG to `SUPPORTED_TCGS`:

```typescript
export const SUPPORTED_TCGS: SupportedTcg[] = [
  { label: 'Pokemon',   terms: ['Pokemon'] },
  { label: 'Magic',     terms: ['Magic'] },
  { label: 'One Piece', terms: ['One Piece'] },
  { label: 'Gundam',    terms: ['Gundam Card Game', 'Gundam'] },
  { label: 'Digimon',   terms: ['Digimon'] },  // ← add here
];
```

Category IDs are resolved dynamically at runtime — no hardcoded IDs needed.

---

## Project structure

```
src/
  worker.ts               Cloudflare Worker entry point (fetch + scheduled handlers)
  ingestion/
    index.ts              Orchestrator — runIngestion(config)
    categories.ts         Resolve category IDs from TCGCSV + SUPPORTED_TCGS config
    sets.ts               Fetch groups (sets/expansions) for a category
    products.ts           Fetch products + prices for a group
    transformer.ts        Map API responses → DB rows; filter cards vs sealed
    db.ts                 D1 upsert helpers (uses .prepare().bind().batch())
    http.ts               Rate-limited HTTP client with retry + backoff
    logger.ts             Structured JSON logger (console-based for Workers)
    price-config.ts       Price subtype priority map + SQL helper for app layer
    transformer.test.ts   Vitest unit tests (transformer logic only — no D1 needed)
  types/
    tcgcsv.ts             TCGCSV API response types
    db.ts                 Database row types
db/
  migrations/
    001_initial.sql       D1/SQLite schema (applied via wrangler d1 migrations apply)
```

---

## Run tests

```bash
npm test
```

Transformer tests run in Node (no Workers runtime needed — they test pure
transformation logic with no D1 or fetch dependencies).
