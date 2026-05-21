import { runIngestion, processGroupMessage, type IngestionConfig, type SyncGroupMessage } from './ingestion/index.js';
import { runMirrorJob } from './image-mirror.js';
import { logger } from './ingestion/logger.js';

export interface Env {
  DB: D1Database;
  IMAGES_BUCKET: R2Bucket;
  SYNC_QUEUE?: Queue<SyncGroupMessage>;
  TCGCSV_BASE_URL?: string;
  LOG_LEVEL?: string;
  DRY_RUN?: string;
  BACKFILL_LIMIT?: string;
  FORCE_SYNC?: string;
}

function buildConfig(env: Env): IngestionConfig {
  return {
    db: env.DB,
    syncQueue: env.SYNC_QUEUE ?? null,
    tcgcsvBaseUrl: env.TCGCSV_BASE_URL ?? 'https://tcgcsv.com',
    logLevel: env.LOG_LEVEL ?? 'info',
    dryRun: env.DRY_RUN === 'true',
    backfillLimit: env.BACKFILL_LIMIT ? parseInt(env.BACKFILL_LIMIT, 10) : null,
    forceSync: env.FORCE_SYNC === 'true',
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default {
  /**
   * HTTP handler — used for manual triggers and health checks.
   *
   * GET /          → health check
   * POST /sync     → kick off a sync run; responds immediately, runs in background
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === '/') {
      return json({ ok: true, service: 'sleevedpages-ingestion' });
    }

    if (pathname === '/sync' && request.method === 'POST') {
      ctx.waitUntil(
        runIngestion(buildConfig(env)).catch((err) =>
          logger.error('Manual sync failed', { error: String(err) })
        )
      );
      return json({ ok: true, message: 'Sync started' });
    }

    if (pathname === '/mirror' && request.method === 'POST') {
      try {
        const result = await runMirrorJob({ DB: env.DB, IMAGES_BUCKET: env.IMAGES_BUCKET });
        return json({ ok: true, ...result });
      } catch (err) {
        logger.error('Manual mirror failed', { error: String(err) });
        return json({ ok: false, error: String(err) }, 500);
      }
    }

    return json({ ok: false, error: 'Not found' }, 404);
  },

  /**
   * Cron handler:
   *  "0 6 * * *" — daily TCGPlayer data sync
   *  "0 3 * * 0" — weekly Sunday image mirror job
   */
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    if (event.cron === '0 3 * * SUN') {
      ctx.waitUntil(
        runMirrorJob({ DB: env.DB, IMAGES_BUCKET: env.IMAGES_BUCKET }).catch((err) =>
          logger.error('Scheduled mirror failed', { error: String(err) })
        )
      );
    } else {
      ctx.waitUntil(
        runIngestion(buildConfig(env)).catch((err) =>
          logger.error('Scheduled sync failed', { error: String(err) })
        )
      );
    }
  },

  /**
   * Queue consumer — invoked for each batch of group messages.
   * Processes up to max_batch_size groups sequentially; max_concurrent_consumers = 1
   * ensures TCGCSV fetch rate stays orderly across invocations.
   *
   * HTTP fetch errors are caught inside processGroupMessage (groups_completed still
   * advances). D1 errors propagate here, causing the queue to retry the message.
   */
  async queue(
    batch: MessageBatch<SyncGroupMessage>,
    env: Env
  ): Promise<void> {
    for (const message of batch.messages) {
      await processGroupMessage(message.body, env.DB);
      message.ack();
    }
  },
};
