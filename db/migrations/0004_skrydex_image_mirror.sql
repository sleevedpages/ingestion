-- 0004_skrydex_image_mirror.sql
-- Adds Skrydex set ID mapping to tcg_sets and creates the image mirror log.

ALTER TABLE tcg_sets ADD COLUMN skrydex_set_id TEXT;

CREATE TABLE IF NOT EXISTS image_mirror_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  processed      INTEGER NOT NULL DEFAULT 0,
  mirrored       INTEGER NOT NULL DEFAULT 0,
  failed         INTEGER NOT NULL DEFAULT 0,
  skrydex_hits   INTEGER NOT NULL DEFAULT 0,
  tcgplayer_hits INTEGER NOT NULL DEFAULT 0,
  duration_ms    INTEGER,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
