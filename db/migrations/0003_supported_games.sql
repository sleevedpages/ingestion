-- Makes supported TCGs database-driven so the admin can manage them without code changes.
-- Applied via: npm run migrate:local / migrate:remote

CREATE TABLE IF NOT EXISTS tcg_supported_games (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  label          TEXT UNIQUE NOT NULL,
  terms          TEXT NOT NULL,          -- JSON array of TCGCSV name match strings
  price_priority TEXT NOT NULL,          -- JSON array of preferred sub_type_name values
  enabled        INTEGER NOT NULL DEFAULT 1,  -- 0/1 toggle
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

INSERT INTO tcg_supported_games (label, terms, price_priority, enabled, created_at, updated_at) VALUES
  ('Pokemon',   '["Pokemon"]',                         '["Holofoil","Normal","1st Edition Holofoil","Reverse Holofoil"]', 1, datetime('now'), datetime('now')),
  ('Magic',     '["Magic"]',                           '["Normal","Foil"]',    1, datetime('now'), datetime('now')),
  ('One Piece', '["One Piece"]',                       '["Normal"]',           1, datetime('now'), datetime('now')),
  ('Gundam',    '["Gundam Card Game","Gundam"]',        '["Normal"]',           1, datetime('now'), datetime('now'));
