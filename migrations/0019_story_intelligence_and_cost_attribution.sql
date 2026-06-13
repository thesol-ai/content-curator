-- 0019_story_intelligence_and_cost_attribution.sql
-- Additive only (CREATE TABLE IF NOT EXISTS). Safe to apply at any time; the
-- writers below are flag-gated and fall back silently if these tables are
-- missing, so applying this migration changes NO behavior on its own.

-- ── Story intelligence: queryable structured story keys (Phase 6K) ──
CREATE TABLE IF NOT EXISTS story_intelligence_events (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL,
  channel_id TEXT,
  story_key TEXT NOT NULL,
  event_type TEXT,
  canonical_date TEXT,
  primary_entities_json TEXT,
  topic_fingerprint TEXT,
  source_id TEXT,
  source_account TEXT,
  discovery_item_id TEXT,
  candidate_id TEXT,
  queue_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_story_intelligence_lookup
  ON story_intelligence_events(category_id, channel_id, story_key, created_at);

CREATE INDEX IF NOT EXISTS idx_story_intelligence_source
  ON story_intelligence_events(category_id, source_id, source_account, created_at);

-- ── AI cost attribution by source (per-item apportioned token usage) ──
CREATE TABLE IF NOT EXISTS ai_usage_attribution (
  id TEXT PRIMARY KEY,
  ai_usage_id TEXT,
  category_id TEXT,
  channel_id TEXT,
  source_id TEXT,
  source_account TEXT,
  discovery_item_id TEXT,
  candidate_id TEXT,
  queue_id TEXT,
  purpose TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_attr_source_time
  ON ai_usage_attribution(category_id, source_id, source_account, created_at);

CREATE INDEX IF NOT EXISTS idx_ai_usage_attr_candidate
  ON ai_usage_attribution(candidate_id, created_at);
