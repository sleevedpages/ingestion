-- Adds queue-based progress tracking to tcg_sync_log.
-- Applied via: npm run migrate:local / migrate:remote

ALTER TABLE tcg_sync_log ADD COLUMN groups_enqueued  INTEGER;
ALTER TABLE tcg_sync_log ADD COLUMN groups_completed INTEGER NOT NULL DEFAULT 0;
