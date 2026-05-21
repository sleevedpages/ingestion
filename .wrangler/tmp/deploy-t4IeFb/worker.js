var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/ingestion/logger.ts
var LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};
var currentLevel = "info";
function setLogLevel(level) {
  currentLevel = level in LEVELS ? level : "info";
}
__name(setLogLevel, "setLogLevel");
function emit(level, message, data) {
  if (LEVELS[level] < LEVELS[currentLevel]) return;
  const entry = {
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    level,
    message
  };
  if (data) Object.assign(entry, data);
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}
__name(emit, "emit");
var logger = {
  debug: /* @__PURE__ */ __name((message, data) => emit("debug", message, data), "debug"),
  info: /* @__PURE__ */ __name((message, data) => emit("info", message, data), "info"),
  warn: /* @__PURE__ */ __name((message, data) => emit("warn", message, data), "warn"),
  error: /* @__PURE__ */ __name((message, data) => emit("error", message, data), "error")
};

// src/ingestion/http.ts
var USER_AGENT = "SleevedPages/1.0.0";
var MIN_INTERVAL_MS = 100;
var MAX_RETRIES = 3;
var BACKOFF_MS = [100, 400, 1600];
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
__name(sleep, "sleep");
var RateLimitedClient = class {
  static {
    __name(this, "RateLimitedClient");
  }
  lastRequestAt = 0;
  baseUrl;
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }
  async get(path) {
    await this.throttle();
    return this.fetchWithRetry(this.baseUrl + path, 0);
  }
  async getText(path) {
    await this.throttle();
    return this.fetchTextWithRetry(this.baseUrl + path, 0);
  }
  async throttle() {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < MIN_INTERVAL_MS) {
      await sleep(MIN_INTERVAL_MS - elapsed);
    }
    this.lastRequestAt = Date.now();
  }
  async fetchWithRetry(url, attempt) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT }
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText} \u2014 ${url}`);
      }
      return res.json();
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = BACKOFF_MS[attempt] ?? 1600;
        logger.warn("Request failed, retrying", {
          url,
          attempt: attempt + 1,
          delayMs: delay,
          error: String(err)
        });
        await sleep(delay);
        await this.throttle();
        return this.fetchWithRetry(url, attempt + 1);
      }
      throw err;
    }
  }
  async fetchTextWithRetry(url, attempt) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT }
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText} \u2014 ${url}`);
      }
      return res.text();
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = BACKOFF_MS[attempt] ?? 1600;
        logger.warn("Request failed, retrying", {
          url,
          attempt: attempt + 1,
          delayMs: delay,
          error: String(err)
        });
        await sleep(delay);
        await this.throttle();
        return this.fetchTextWithRetry(url, attempt + 1);
      }
      throw err;
    }
  }
};

// src/ingestion/categories.ts
var SUPPORTED_TCGS = [
  { label: "Pokemon", terms: ["Pokemon"] },
  { label: "Magic", terms: ["Magic"] },
  { label: "One Piece", terms: ["One Piece"] },
  // "Gundam Card Game" is the canonical TCGplayer name; plain "Gundam" is a fallback.
  { label: "Gundam", terms: ["Gundam Card Game", "Gundam"] }
];
function matchCategory(results, term) {
  const lower = term.toLowerCase();
  return results.find(
    (cat) => cat.name.toLowerCase().includes(lower) || (cat.displayName ?? "").toLowerCase().includes(lower)
  );
}
__name(matchCategory, "matchCategory");
async function resolveCategories(httpClient) {
  logger.debug("Fetching TCG categories from TCGCSV");
  const data = await httpClient.get("/tcgplayer/categories");
  const resolved = /* @__PURE__ */ new Map();
  for (const tcg of SUPPORTED_TCGS) {
    let match;
    let matchedTerm;
    for (const term of tcg.terms) {
      match = matchCategory(data.results, term);
      if (match) {
        matchedTerm = term;
        break;
      }
    }
    if (match && matchedTerm) {
      const usedFallback = matchedTerm !== tcg.terms[0];
      if (usedFallback) {
        logger.warn("Resolved category using fallback term \u2014 primary term not found", {
          label: tcg.label,
          primaryTerm: tcg.terms[0],
          matchedTerm,
          categoryId: match.categoryId,
          apiName: match.name
        });
      } else {
        logger.info("Resolved category", {
          label: tcg.label,
          categoryId: match.categoryId,
          apiName: match.name
        });
      }
      resolved.set(tcg.label, {
        categoryId: match.categoryId,
        name: match.name,
        displayName: match.displayName,
        modifiedOn: match.modifiedOn,
        imageUrl: match.image,
        seoText: match.seoText,
        isDirectBrand: match.isDirectBrand
      });
    } else {
      logger.warn(
        "Could not resolve TCG category \u2014 check /tcgplayer/categories and add the correct name to SUPPORTED_TCGS.",
        {
          label: tcg.label,
          termsAttempted: tcg.terms,
          availableCategories: data.results.map((c) => c.name)
        }
      );
    }
  }
  return resolved;
}
__name(resolveCategories, "resolveCategories");

// src/ingestion/sets.ts
async function fetchGroups(httpClient, categoryId) {
  const data = await httpClient.get(
    `/tcgplayer/${categoryId}/groups`
  );
  return data.results;
}
__name(fetchGroups, "fetchGroups");

// src/ingestion/products.ts
async function fetchGroupData(httpClient, categoryId, groupId) {
  const productData = await httpClient.get(
    `/tcgplayer/${categoryId}/${groupId}/products`
  );
  const priceData = await httpClient.get(
    `/tcgplayer/${categoryId}/${groupId}/prices`
  );
  return {
    products: productData.results,
    prices: priceData.results
  };
}
__name(fetchGroupData, "fetchGroupData");

// src/ingestion/transformer.ts
function getExtendedValue(product, fieldName) {
  return product.extendedData.find(
    (f) => f.name.toLowerCase() === fieldName.toLowerCase()
  )?.value ?? null;
}
__name(getExtendedValue, "getExtendedValue");
function transformCategory(cat, now = /* @__PURE__ */ new Date()) {
  return {
    tcgplayer_category_id: cat.categoryId,
    name: cat.name,
    display_name: cat.displayName ?? null,
    modified_on: cat.modifiedOn ?? null,
    image_url: cat.imageUrl ?? null,
    seo_text: cat.seoText ?? null,
    is_direct_brand: cat.isDirectBrand ? 1 : 0,
    synced_at: now
  };
}
__name(transformCategory, "transformCategory");
function transformGroup(group, now = /* @__PURE__ */ new Date()) {
  return {
    tcgplayer_group_id: group.groupId,
    tcgplayer_category_id: group.categoryId,
    name: group.name,
    abbreviation: group.abbreviation ?? null,
    published_on: group.publishedOn ? new Date(group.publishedOn) : null,
    modified_on: group.modifiedOn ?? null,
    is_supplemental: group.isSupplemental,
    synced_at: now
  };
}
__name(transformGroup, "transformGroup");
function transformProduct(product, now = /* @__PURE__ */ new Date()) {
  return {
    tcgplayer_product_id: product.productId,
    tcgplayer_group_id: product.groupId,
    tcgplayer_category_id: product.categoryId,
    name: product.name,
    clean_name: product.cleanName ?? null,
    image_url: product.imageUrl ?? null,
    tcgplayer_url: product.url ?? null,
    modified_on: product.modifiedOn ?? null,
    image_count: product.imageCount ?? null,
    presale_info: product.presaleInfo ? JSON.stringify(product.presaleInfo) : null,
    card_number: getExtendedValue(product, "Number"),
    rarity: getExtendedValue(product, "Rarity"),
    extended_data: product.extendedData,
    synced_at: now
  };
}
__name(transformProduct, "transformProduct");
function transformPrice(price, now = /* @__PURE__ */ new Date()) {
  return {
    tcgplayer_product_id: price.productId,
    sub_type_name: price.subTypeName,
    low_price: price.lowPrice,
    mid_price: price.midPrice,
    high_price: price.highPrice,
    market_price: price.marketPrice,
    direct_low_price: price.directLowPrice,
    synced_at: now
  };
}
__name(transformPrice, "transformPrice");
function transformGroupData(products, prices, now = /* @__PURE__ */ new Date()) {
  const productRows = products.map((p) => transformProduct(p, now));
  const productIds = new Set(productRows.map((p) => p.tcgplayer_product_id));
  const priceRows = prices.filter((p) => productIds.has(p.productId)).map((p) => transformPrice(p, now));
  return { products: productRows, prices: priceRows };
}
__name(transformGroupData, "transformGroupData");

// src/ingestion/db.ts
var BATCH_SIZE = 100;
function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
__name(chunk, "chunk");
function iso(d) {
  return d.toISOString();
}
__name(iso, "iso");
async function upsertCategory(db, row) {
  await db.prepare(
    `INSERT INTO tcg_categories
         (tcgplayer_category_id, name, display_name, modified_on,
          image_url, seo_text, is_direct_brand, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tcgplayer_category_id) DO UPDATE SET
         name           = excluded.name,
         display_name   = excluded.display_name,
         modified_on    = excluded.modified_on,
         image_url      = excluded.image_url,
         seo_text       = excluded.seo_text,
         is_direct_brand = excluded.is_direct_brand,
         synced_at      = excluded.synced_at`
  ).bind(
    row.tcgplayer_category_id,
    row.name,
    row.display_name,
    row.modified_on,
    row.image_url,
    row.seo_text,
    row.is_direct_brand,
    iso(row.synced_at)
  ).run();
}
__name(upsertCategory, "upsertCategory");
async function upsertSet(db, row) {
  await db.prepare(
    `INSERT INTO tcg_sets
         (tcgplayer_group_id, tcgplayer_category_id, name, abbreviation,
          published_on, modified_on, is_supplemental, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tcgplayer_group_id) DO UPDATE SET
         tcgplayer_category_id = excluded.tcgplayer_category_id,
         name                  = excluded.name,
         abbreviation          = excluded.abbreviation,
         published_on          = excluded.published_on,
         modified_on           = excluded.modified_on,
         is_supplemental       = excluded.is_supplemental,
         synced_at             = excluded.synced_at`
  ).bind(
    row.tcgplayer_group_id,
    row.tcgplayer_category_id,
    row.name,
    row.abbreviation,
    row.published_on ? iso(row.published_on) : null,
    row.modified_on,
    row.is_supplemental ? 1 : 0,
    iso(row.synced_at)
  ).run();
}
__name(upsertSet, "upsertSet");
var PRODUCT_SQL = `
  INSERT INTO tcg_products
    (tcgplayer_product_id, tcgplayer_group_id, tcgplayer_category_id,
     name, clean_name, image_url, tcgplayer_url, modified_on, image_count,
     presale_info, card_number, rarity, extended_data, synced_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (tcgplayer_product_id) DO UPDATE SET
    tcgplayer_group_id    = excluded.tcgplayer_group_id,
    tcgplayer_category_id = excluded.tcgplayer_category_id,
    name                  = excluded.name,
    clean_name            = excluded.clean_name,
    image_url             = excluded.image_url,
    tcgplayer_url         = excluded.tcgplayer_url,
    modified_on           = excluded.modified_on,
    image_count           = excluded.image_count,
    presale_info          = excluded.presale_info,
    card_number           = excluded.card_number,
    rarity                = excluded.rarity,
    extended_data         = excluded.extended_data,
    synced_at             = excluded.synced_at`;
async function upsertProducts(db, rows) {
  if (rows.length === 0) return 0;
  for (const batch of chunk(rows, BATCH_SIZE)) {
    await db.batch(
      batch.map(
        (r) => db.prepare(PRODUCT_SQL).bind(
          r.tcgplayer_product_id,
          r.tcgplayer_group_id,
          r.tcgplayer_category_id,
          r.name,
          r.clean_name,
          r.image_url,
          r.tcgplayer_url,
          r.modified_on,
          r.image_count,
          r.presale_info,
          r.card_number,
          r.rarity,
          JSON.stringify(r.extended_data),
          iso(r.synced_at)
        )
      )
    );
  }
  return rows.length;
}
__name(upsertProducts, "upsertProducts");
var PRICE_SQL = `
  INSERT INTO tcg_prices
    (tcgplayer_product_id, sub_type_name, low_price, mid_price,
     high_price, market_price, direct_low_price, synced_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (tcgplayer_product_id, sub_type_name) DO UPDATE SET
    low_price        = excluded.low_price,
    mid_price        = excluded.mid_price,
    high_price       = excluded.high_price,
    market_price     = excluded.market_price,
    direct_low_price = excluded.direct_low_price,
    synced_at        = excluded.synced_at`;
async function upsertPrices(db, rows) {
  if (rows.length === 0) return 0;
  for (const batch of chunk(rows, BATCH_SIZE)) {
    await db.batch(
      batch.map(
        (r) => db.prepare(PRICE_SQL).bind(
          r.tcgplayer_product_id,
          r.sub_type_name,
          r.low_price,
          r.mid_price,
          r.high_price,
          r.market_price,
          r.direct_low_price,
          iso(r.synced_at)
        )
      )
    );
  }
  return rows.length;
}
__name(upsertPrices, "upsertPrices");
async function createSyncLog(db) {
  const result = await db.prepare(
    `INSERT INTO tcg_sync_log (started_at, status) VALUES (?, 'running')`
  ).bind((/* @__PURE__ */ new Date()).toISOString()).run();
  return result.meta.last_row_id;
}
__name(createSyncLog, "createSyncLog");
async function updateSyncLog(db, id, status, fields) {
  await db.prepare(
    `UPDATE tcg_sync_log SET
         completed_at      = ?,
         status            = ?,
         tcgs_processed    = ?,
         sets_processed    = ?,
         products_upserted = ?,
         prices_upserted   = ?,
         error_message     = ?
       WHERE id = ?`
  ).bind(
    (/* @__PURE__ */ new Date()).toISOString(),
    status,
    fields.tcgsProcessed ? JSON.stringify(fields.tcgsProcessed) : null,
    fields.setsProcessed ?? null,
    fields.productsUpserted ?? null,
    fields.pricesUpserted ?? null,
    fields.errorMessage ?? null,
    id
  ).run();
}
__name(updateSyncLog, "updateSyncLog");
async function getLastSuccessfulSync(db) {
  const row = await db.prepare(
    `SELECT completed_at FROM tcg_sync_log
       WHERE status = 'success'
       ORDER BY completed_at DESC
       LIMIT 1`
  ).first();
  return row?.completed_at ? new Date(row.completed_at) : null;
}
__name(getLastSuccessfulSync, "getLastSuccessfulSync");

// src/ingestion/index.ts
async function getLastUpdated(httpClient) {
  try {
    const text = await httpClient.getText("/last-updated.txt");
    const ts = new Date(text.trim());
    return isNaN(ts.getTime()) ? null : ts;
  } catch {
    return null;
  }
}
__name(getLastUpdated, "getLastUpdated");
async function runIngestion(config) {
  const startedAt = Date.now();
  setLogLevel(config.logLevel);
  logger.info("Starting TCGCSV ingestion run", {
    dryRun: config.dryRun,
    forceSync: config.forceSync,
    backfillLimit: config.backfillLimit ?? "none"
  });
  const httpClient = new RateLimitedClient(config.tcgcsvBaseUrl);
  const [lastUpdated, lastSync] = await Promise.all([
    getLastUpdated(httpClient),
    config.dryRun ? Promise.resolve(null) : getLastSuccessfulSync(config.db)
  ]);
  logger.info("Change detection", {
    tcgcsvLastUpdated: lastUpdated?.toISOString() ?? "unknown",
    lastSuccessfulSync: lastSync?.toISOString() ?? "never"
  });
  if (lastUpdated && lastSync && lastUpdated <= lastSync) {
    if (config.forceSync) {
      logger.warn("TCGCSV unchanged since last sync but FORCE_SYNC=true \u2014 proceeding anyway", {
        lastUpdated: lastUpdated.toISOString(),
        lastSync: lastSync.toISOString()
      });
    } else {
      logger.info("TCGCSV has not updated since last sync \u2014 exiting early", {
        lastUpdated: lastUpdated.toISOString(),
        lastSync: lastSync.toISOString(),
        tip: "Set FORCE_SYNC=true to override (e.g. for staged backfill runs)"
      });
      return;
    }
  }
  let syncLogId = null;
  if (!config.dryRun) {
    syncLogId = await createSyncLog(config.db);
  }
  const stats = {
    setsProcessed: 0,
    setsFailed: 0,
    productsUpserted: 0,
    pricesUpserted: 0,
    tcgsProcessed: []
  };
  const now = /* @__PURE__ */ new Date();
  try {
    const categories = await resolveCategories(httpClient);
    for (const [label, category] of categories) {
      logger.info("Processing TCG category", {
        tcg: label,
        categoryId: category.categoryId,
        name: category.name
      });
      const categoryRow = transformCategory(category, now);
      if (!config.dryRun) {
        await upsertCategory(config.db, categoryRow);
      }
      let groups;
      try {
        groups = await fetchGroups(httpClient, category.categoryId);
      } catch (err) {
        logger.error("Failed to fetch groups for category", {
          tcg: label,
          categoryId: category.categoryId,
          error: String(err)
        });
        continue;
      }
      const groupsToProcess = config.backfillLimit !== null ? groups.slice(0, config.backfillLimit) : groups;
      if (config.backfillLimit !== null && groupsToProcess.length < groups.length) {
        logger.warn("BACKFILL_LIMIT reached \u2014 remaining sets deferred to next run", {
          tcg: label,
          limit: config.backfillLimit,
          totalGroups: groups.length,
          deferredGroups: groups.length - groupsToProcess.length,
          tip: "Re-run with FORCE_SYNC=true until all sets are ingested"
        });
      }
      logger.info("Fetched groups", {
        tcg: label,
        totalGroups: groups.length,
        processingGroups: groupsToProcess.length
      });
      for (const group of groupsToProcess) {
        try {
          const setRow = transformGroup(group, now);
          if (!config.dryRun) {
            await upsertSet(config.db, setRow);
          }
          const { products, prices } = await fetchGroupData(
            httpClient,
            category.categoryId,
            group.groupId
          );
          const { products: productRows, prices: priceRows } = transformGroupData(
            products,
            prices,
            now
          );
          logger.info("Processed group", {
            groupId: group.groupId,
            name: group.name,
            products: productRows.length,
            prices: priceRows.length
          });
          if (!config.dryRun) {
            const [productsCount, pricesCount] = await Promise.all([
              upsertProducts(config.db, productRows),
              upsertPrices(config.db, priceRows)
            ]);
            stats.productsUpserted += productsCount;
            stats.pricesUpserted += pricesCount;
          } else {
            stats.productsUpserted += productRows.length;
            stats.pricesUpserted += priceRows.length;
          }
          stats.setsProcessed++;
        } catch (err) {
          logger.error("Failed to process group", {
            groupId: group.groupId,
            name: group.name,
            error: String(err)
          });
          stats.setsFailed++;
        }
      }
      stats.tcgsProcessed.push(label);
    }
    const durationMs = Date.now() - startedAt;
    logger.info("Ingestion run complete", {
      dryRun: config.dryRun,
      durationMs,
      ...stats
    });
    if (!config.dryRun && syncLogId !== null) {
      await updateSyncLog(config.db, syncLogId, "success", {
        tcgsProcessed: stats.tcgsProcessed,
        setsProcessed: stats.setsProcessed,
        productsUpserted: stats.productsUpserted,
        pricesUpserted: stats.pricesUpserted
      });
    }
  } catch (err) {
    const errorMessage = String(err);
    logger.error("Ingestion run failed", { error: errorMessage });
    if (!config.dryRun && syncLogId !== null) {
      await updateSyncLog(config.db, syncLogId, "failed", {
        tcgsProcessed: stats.tcgsProcessed,
        setsProcessed: stats.setsProcessed,
        productsUpserted: stats.productsUpserted,
        pricesUpserted: stats.pricesUpserted,
        errorMessage
      });
    }
    throw err;
  }
}
__name(runIngestion, "runIngestion");

// src/worker.ts
function buildConfig(env) {
  return {
    db: env.DB,
    tcgcsvBaseUrl: env.TCGCSV_BASE_URL ?? "https://tcgcsv.com",
    logLevel: env.LOG_LEVEL ?? "info",
    dryRun: env.DRY_RUN === "true",
    backfillLimit: env.BACKFILL_LIMIT ? parseInt(env.BACKFILL_LIMIT, 10) : null,
    forceSync: env.FORCE_SYNC === "true"
  };
}
__name(buildConfig, "buildConfig");
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
__name(json, "json");
var worker_default = {
  /**
   * HTTP handler — used for manual triggers and health checks.
   *
   * GET /          → health check
   * POST /sync     → kick off a sync run; responds immediately, runs in background
   */
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/") {
      return json({ ok: true, service: "sleevedpages-ingestion" });
    }
    if (pathname === "/sync" && request.method === "POST") {
      ctx.waitUntil(
        runIngestion(buildConfig(env)).catch(
          (err) => logger.error("Manual sync failed", { error: String(err) })
        )
      );
      return json({ ok: true, message: "Sync started" });
    }
    return json({ ok: false, error: "Not found" }, 404);
  },
  /**
   * Cron handler — triggered by the schedule in wrangler.toml ("0 6 * * *").
   */
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      runIngestion(buildConfig(env)).catch(
        (err) => logger.error("Scheduled sync failed", { error: String(err) })
      )
    );
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
