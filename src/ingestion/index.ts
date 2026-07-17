import { RateLimitedClient } from './http.js';
import { logger, setLogLevel } from './logger.js';
import { resolveCategories, loadSupportedTcgs } from './categories.js';
import { fetchGroups } from './sets.js';
import { fetchGroupData } from './products.js';
import { transformCategory, transformGroup, transformGroupData } from './transformer.js';
import { loadPriceConfig } from './price-config.js';
import { loadImagePreferences, preferenceForLabel } from '../lib/imagePreference.js';
import {
  upsertCategory,
  upsertSetsBatch,
  upsertProducts,
  upsertProductSourceImages,
  upsertPrices,
  createSyncLog,
  updateSyncLog,
  setGroupsEnqueued,
  updateSyncLogProgress,
  getLastSuccessfulSync,
} from './db.js';

export interface IngestionConfig {
  db: D1Database;
  syncQueue: Queue<SyncGroupMessage> | null;
  tcgcsvBaseUrl: string;
  logLevel: string;
  dryRun: boolean;
  backfillLimit: number | null;
  forceSync: boolean;
}

export interface SyncGroupMessage {
  syncLogId: number;
  categoryId: number;
  groupId: number;
  groupName: string;
  tcgLabel: string;
  tcgcsvBaseUrl: string;
  logLevel: string;
  dryRun: boolean;
}

async function getLastUpdated(httpClient: RateLimitedClient): Promise<Date | null> {
  try {
    const text = await httpClient.getText('/last-updated.txt');
    const ts = new Date(text.trim());
    return isNaN(ts.getTime()) ? null : ts;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Orchestrator — resolves categories/sets, enqueues one message per group.
// When syncQueue is null (dry-run or local dev without queue) falls back to
// synchronous inline processing (the pre-queue behaviour).
// ---------------------------------------------------------------------------

export async function runIngestion(config: IngestionConfig): Promise<void> {
  const startedAt = Date.now();
  setLogLevel(config.logLevel);

  logger.info('Starting TCGCSV ingestion run', {
    dryRun: config.dryRun,
    forceSync: config.forceSync,
    backfillLimit: config.backfillLimit ?? 'none',
    mode: config.syncQueue ? 'queue' : 'inline',
  });

  const httpClient = new RateLimitedClient(config.tcgcsvBaseUrl);

  const [supportedTcgs, priceConfig] = await Promise.all([
    loadSupportedTcgs(config.db),
    loadPriceConfig(config.db),
  ]);

  logger.info('Loaded supported TCGs from database', {
    count: supportedTcgs.length,
    labels: supportedTcgs.map((t) => t.label),
    priceConfigKeys: Object.keys(priceConfig),
  });

  // Change detection
  const [lastUpdated, lastSync] = await Promise.all([
    getLastUpdated(httpClient),
    config.dryRun ? Promise.resolve(null) : getLastSuccessfulSync(config.db),
  ]);

  logger.info('Change detection', {
    tcgcsvLastUpdated: lastUpdated?.toISOString() ?? 'unknown',
    lastSuccessfulSync: lastSync?.toISOString() ?? 'never',
  });

  if (lastUpdated && lastSync && lastUpdated <= lastSync) {
    if (config.forceSync) {
      logger.warn('TCGCSV unchanged since last sync but FORCE_SYNC=true — proceeding anyway', {
        lastUpdated: lastUpdated.toISOString(),
        lastSync: lastSync.toISOString(),
      });
    } else {
      logger.info('TCGCSV has not updated since last sync — exiting early', {
        lastUpdated: lastUpdated.toISOString(),
        lastSync: lastSync.toISOString(),
        tip: 'Set FORCE_SYNC=true to override (e.g. for staged backfill runs)',
      });
      return;
    }
  }

  let syncLogId: number | null = null;
  if (!config.dryRun) {
    syncLogId = await createSyncLog(config.db);
  }

  const now = new Date();

  try {
    const categories = await resolveCategories(httpClient, supportedTcgs);

    // Collect all set rows and group messages across every TCG before writing anything.
    const allSetRows = [];
    const allMessages: SyncGroupMessage[] = [];
    const tcgLabels: string[] = [];

    for (const [label, category] of categories) {
      logger.info('Resolving groups for TCG', {
        tcg: label,
        categoryId: category.categoryId,
      });

      if (!config.dryRun) {
        await upsertCategory(config.db, transformCategory(category, now));
      }

      let groups;
      try {
        groups = await fetchGroups(httpClient, category.categoryId);
      } catch (err) {
        logger.error('Failed to fetch groups for category', {
          tcg: label,
          categoryId: category.categoryId,
          error: String(err),
        });
        continue;
      }

      const groupsToProcess =
        config.backfillLimit !== null ? groups.slice(0, config.backfillLimit) : groups;

      if (config.backfillLimit !== null && groupsToProcess.length < groups.length) {
        logger.warn('BACKFILL_LIMIT reached — remaining sets deferred to next run', {
          tcg: label,
          limit: config.backfillLimit,
          totalGroups: groups.length,
          deferredGroups: groups.length - groupsToProcess.length,
        });
      }

      for (const group of groupsToProcess) {
        allSetRows.push(transformGroup(group, now));
        allMessages.push({
          syncLogId: syncLogId ?? 0,
          categoryId: category.categoryId,
          groupId: group.groupId,
          groupName: group.name,
          tcgLabel: label,
          tcgcsvBaseUrl: config.tcgcsvBaseUrl,
          logLevel: config.logLevel,
          dryRun: config.dryRun,
        });
      }

      tcgLabels.push(label);
      logger.info('Groups resolved', {
        tcg: label,
        totalGroups: groups.length,
        enqueueing: groupsToProcess.length,
      });
    }

    // Batch-upsert all sets in one pass (~8 subrequests for 800 sets).
    if (!config.dryRun && allSetRows.length > 0) {
      await upsertSetsBatch(config.db, allSetRows);
    }

    if (config.syncQueue && !config.dryRun) {
      // Queue mode: dispatch one message per group; consumers handle fetch + upsert.
      const QUEUE_BATCH = 100; // Cloudflare queue sendBatch limit
      for (let i = 0; i < allMessages.length; i += QUEUE_BATCH) {
        await config.syncQueue.sendBatch(
          allMessages.slice(i, i + QUEUE_BATCH).map((body) => ({ body }))
        );
      }

      await setGroupsEnqueued(config.db, syncLogId!, allMessages.length, tcgLabels);

      logger.info('All groups enqueued — consumers will process asynchronously', {
        groupsEnqueued: allMessages.length,
        tcgsProcessed: tcgLabels,
        orchestratorDurationMs: Date.now() - startedAt,
      });
    } else {
      // Inline fallback (dry-run or no queue binding — used in local dev / testing).
      let setsProcessed = 0;
      let setsFailed = 0;
      let productsUpserted = 0;
      let pricesUpserted = 0;

      for (const message of allMessages) {
        try {
          const { productsUpserted: p, pricesUpserted: pr } =
            await processGroupInline(message, config);
          productsUpserted += p;
          pricesUpserted += pr;
          setsProcessed++;
        } catch (err) {
          logger.error('Failed to process group (inline)', {
            groupId: message.groupId,
            name: message.groupName,
            error: String(err),
          });
          setsFailed++;
        }
      }

      logger.info('Ingestion run complete (inline mode)', {
        dryRun: config.dryRun,
        durationMs: Date.now() - startedAt,
        setsProcessed,
        setsFailed,
        productsUpserted,
        pricesUpserted,
        tcgsProcessed: tcgLabels,
      });

      if (!config.dryRun && syncLogId !== null) {
        await updateSyncLog(config.db, syncLogId, 'success', {
          tcgsProcessed: tcgLabels,
          setsProcessed,
          productsUpserted,
          pricesUpserted,
        });
      }
    }
  } catch (err) {
    const errorMessage = String(err);
    logger.error('Ingestion orchestration failed', { error: errorMessage });

    if (!config.dryRun && syncLogId !== null) {
      await updateSyncLog(config.db, syncLogId, 'failed', { errorMessage });
    }

    throw err;
  }
}

// ---------------------------------------------------------------------------
// Consumer — called by the queue handler for each group message.
// HTTP errors are caught internally so groups_completed always advances.
// D1 errors from updateSyncLogProgress propagate so the queue can retry.
// ---------------------------------------------------------------------------

export async function processGroupMessage(
  message: SyncGroupMessage,
  db: D1Database
): Promise<void> {
  setLogLevel(message.logLevel);

  let productsUpserted = 0;
  let pricesUpserted = 0;
  let failed = false;

  try {
    const result = await processGroupInline(message, {
      db,
      tcgcsvBaseUrl: message.tcgcsvBaseUrl,
      dryRun: message.dryRun,
    });
    productsUpserted = result.productsUpserted;
    pricesUpserted = result.pricesUpserted;
  } catch (err) {
    logger.error('Group processing failed', {
      groupId: message.groupId,
      name: message.groupName,
      tcg: message.tcgLabel,
      error: String(err),
    });
    failed = true;
  }

  // D1 errors here are not caught — they propagate so the queue retries the message.
  if (!message.dryRun) {
    await updateSyncLogProgress(db, message.syncLogId, { productsUpserted, pricesUpserted, failed });
  }
}

// ---------------------------------------------------------------------------
// Shared fetch-transform-upsert logic used by both queue consumers and the
// inline fallback path.
// ---------------------------------------------------------------------------

async function processGroupInline(
  message: SyncGroupMessage,
  config: Pick<IngestionConfig, 'db' | 'dryRun' | 'tcgcsvBaseUrl'>
): Promise<{ productsUpserted: number; pricesUpserted: number }> {
  const httpClient = new RateLimitedClient(config.tcgcsvBaseUrl);
  const now = new Date();

  const { products, prices } = await fetchGroupData(
    httpClient,
    message.categoryId,
    message.groupId
  );

  const { products: productRows, prices: priceRows } = transformGroupData(products, prices, now);

  logger.info('Fetched group data', {
    tcg: message.tcgLabel,
    groupId: message.groupId,
    name: message.groupName,
    products: productRows.length,
    prices: priceRows.length,
  });

  if (config.dryRun) {
    return { productsUpserted: productRows.length, pricesUpserted: priceRows.length };
  }

  // Canonical write order matters: prices and product_images both resolve products.id
  // via sub-select, so products MUST be written first (the old tcg_* tables stored the
  // external id directly and could run in parallel — canonical cannot).
  const productsUpserted = await upsertProducts(config.db, productRows);
  // Relocate the TCGPlayer original image url into product_images.source_url (the old
  // tcg_products.image_url write) so the R2 mirror has a source to fetch. The write
  // consults the game's image_source_preference (mig 0104, keyed by the message's
  // tcgLabel): 'scrydex'-preferred (Bandai) games PRESERVE stored Scrydex art.
  const preferences = await loadImagePreferences(config.db);
  await upsertProductSourceImages(
    config.db,
    productRows,
    preferenceForLabel(preferences, message.tcgLabel)
  );
  const pricesUpserted = await upsertPrices(config.db, priceRows);

  return { productsUpserted, pricesUpserted };
}
