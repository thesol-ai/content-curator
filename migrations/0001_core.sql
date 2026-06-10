-- ══════════════════════════════════════════════════════════════
-- 0001_core.sql — core schema
-- ══════════════════════════════════════════════════════════════
PRAGMA foreign_keys = ON;

-- categories
CREATE TABLE IF NOT EXISTS categories (
  id               TEXT PRIMARY KEY,
  label            TEXT NOT NULL,
  prompt_profile   TEXT NOT NULL,
  score_threshold  REAL NOT NULL DEFAULT 75,
  freshness_hours  INTEGER NOT NULL DEFAULT 48,
  media_mode       TEXT NOT NULL DEFAULT 'optional',
  language_targets TEXT NOT NULL DEFAULT '["fa"]',
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- source_accounts
CREATE TABLE IF NOT EXISTS source_accounts (
  id             TEXT PRIMARY KEY,
  category_id    TEXT NOT NULL REFERENCES categories(id),
  platform       TEXT NOT NULL,
  account_handle TEXT NOT NULL,
  display_name   TEXT,
  trust_level    TEXT NOT NULL DEFAULT 'medium',
  enabled        INTEGER NOT NULL DEFAULT 1,
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_source_accounts_category ON source_accounts(category_id, enabled);

-- apify_sources
CREATE TABLE IF NOT EXISTS apify_sources (
  id               TEXT PRIMARY KEY,
  category_id      TEXT NOT NULL REFERENCES categories(id),
  platform         TEXT NOT NULL,
  apify_dataset_id TEXT NOT NULL,
  label            TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_apify_sources_category ON apify_sources(category_id, enabled);

-- channels
CREATE TABLE IF NOT EXISTS channels (
  id               TEXT PRIMARY KEY,
  category_id      TEXT NOT NULL REFERENCES categories(id),
  telegram_chat_id TEXT NOT NULL,
  language         TEXT NOT NULL,
  timezone         TEXT NOT NULL DEFAULT 'Asia/Tehran',
  allowed_windows  TEXT NOT NULL DEFAULT '["09:00-13:00","17:00-22:30"]',
  blocked_windows  TEXT NOT NULL DEFAULT '["00:00-08:00"]',
  max_per_day      INTEGER NOT NULL DEFAULT 10,
  max_per_hour     INTEGER NOT NULL DEFAULT 2,
  min_gap_minutes  INTEGER NOT NULL DEFAULT 30,
  publish_enabled  INTEGER NOT NULL DEFAULT 0,
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_channels_category ON channels(category_id, enabled);

-- discovery_runs
CREATE TABLE IF NOT EXISTS discovery_runs (
  id               TEXT PRIMARY KEY,
  category_id      TEXT NOT NULL,
  platform         TEXT NOT NULL,
  apify_dataset_id TEXT NOT NULL,
  items_fetched    INTEGER NOT NULL DEFAULT 0,
  items_new        INTEGER NOT NULL DEFAULT 0,
  items_duplicate  INTEGER NOT NULL DEFAULT 0,
  items_ai_selected INTEGER NOT NULL DEFAULT 0,
  items_ai_rejected INTEGER NOT NULL DEFAULT 0,
  items_queued     INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'processing',
  error_message    TEXT,
  ai_input_tokens  INTEGER,
  ai_output_tokens INTEGER,
  duration_ms      INTEGER,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_discovery_runs_category ON discovery_runs(category_id, status);
CREATE INDEX IF NOT EXISTS idx_discovery_runs_created  ON discovery_runs(created_at DESC);

-- discovery_items
CREATE TABLE IF NOT EXISTS discovery_items (
  id                 TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL REFERENCES discovery_runs(id),
  category_id        TEXT NOT NULL,
  platform           TEXT NOT NULL,
  source_account     TEXT NOT NULL,
  source_url         TEXT NOT NULL,
  post_id            TEXT NOT NULL,
  published_at       INTEGER NOT NULL,
  text               TEXT,
  text_hash          TEXT,
  topic_fingerprint  TEXT,
  media_count        INTEGER NOT NULL DEFAULT 0,
  engagement_likes   INTEGER NOT NULL DEFAULT 0,
  engagement_shares  INTEGER NOT NULL DEFAULT 0,
  engagement_views   INTEGER NOT NULL DEFAULT 0,
  ai_score           REAL,
  ai_risk            TEXT,
  ai_priority        TEXT,
  ai_reason          TEXT,
  risk_flags         TEXT DEFAULT '[]',
  status             TEXT NOT NULL DEFAULT 'pending',
  reject_reason      TEXT,
  created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_discovery_items_run      ON discovery_items(run_id);
CREATE INDEX IF NOT EXISTS idx_discovery_items_status   ON discovery_items(status);
CREATE INDEX IF NOT EXISTS idx_discovery_items_category ON discovery_items(category_id, status);

-- discovery_media
CREATE TABLE IF NOT EXISTS discovery_media (
  id           TEXT PRIMARY KEY,
  item_id      TEXT NOT NULL REFERENCES discovery_items(id),
  media_index  INTEGER NOT NULL,
  media_type   TEXT NOT NULL,
  source_url   TEXT NOT NULL,
  width        INTEGER,
  height       INTEGER,
  duration_sec INTEGER,
  size_mb      REAL,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_discovery_media_item ON discovery_media(item_id);

-- dedupe_keys
CREATE TABLE IF NOT EXISTS dedupe_keys (
  key        TEXT PRIMARY KEY,
  item_id    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_dedupe_keys_created ON dedupe_keys(created_at);

-- publish_queue — source_url اضافه شد برای sendMessageWithLink
CREATE TABLE IF NOT EXISTS publish_queue (
  id                  TEXT PRIMARY KEY,
  item_id             TEXT NOT NULL REFERENCES discovery_items(id),
  channel_id          TEXT NOT NULL REFERENCES channels(id),
  language            TEXT NOT NULL,
  source_url          TEXT NOT NULL DEFAULT '',
  caption_short       TEXT,
  caption_full        TEXT,
  hashtags            TEXT DEFAULT '[]',
  telegram_method     TEXT NOT NULL DEFAULT 'sendMessage',
  media_urls          TEXT DEFAULT '[]',
  media_types         TEXT DEFAULT '[]',  -- ["image","video",...] برای sendMediaGroup
  scheduled_at        INTEGER NOT NULL,   -- unix timestamp
  status              TEXT NOT NULL DEFAULT 'scheduled',
  retry_count         INTEGER NOT NULL DEFAULT 0,
  telegram_message_id TEXT,
  publish_error       TEXT,
  published_at        INTEGER,            -- unix timestamp
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_publish_queue_status  ON publish_queue(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_publish_queue_channel ON publish_queue(channel_id, status);
CREATE INDEX IF NOT EXISTS idx_publish_queue_item    ON publish_queue(item_id);

-- settings
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('telegram_publish_enabled',  'false'),
  ('apify_curation_enabled',    'false'),
  ('apify_curation_dry_run',    'true'),
  ('maintenance_mode',          'false');
