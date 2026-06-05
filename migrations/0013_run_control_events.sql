-- ══════════════════════════════════════════════════════════════
-- run control / raw observability events
-- Adds durable run-level and item-level event logs for debugging
-- webhook/curation/publish behavior without relying on transient tail logs.
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  phase TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  message TEXT,

  category_id TEXT,
  platform TEXT,
  source_id TEXT,
  dataset_id TEXT,
  actor_run_id TEXT,

  item_id TEXT,
  queue_id TEXT,

  provider TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  duration_ms INTEGER,

  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_run_events_run_id_created
ON run_events(run_id, created_at);

CREATE INDEX IF NOT EXISTS idx_run_events_type_created
ON run_events(event_type, created_at);

CREATE INDEX IF NOT EXISTS idx_run_events_phase_created
ON run_events(phase, created_at);

CREATE INDEX IF NOT EXISTS idx_run_events_severity_created
ON run_events(severity, created_at);


CREATE TABLE IF NOT EXISTS run_item_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,

  item_id TEXT,
  source_url TEXT,
  post_id TEXT,
  source_account TEXT,

  phase TEXT NOT NULL,
  status TEXT NOT NULL,
  reject_reason TEXT,

  ai_score REAL,
  ai_risk TEXT,
  media_count INTEGER,
  queue_id TEXT,

  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_run_item_events_run_id_created
ON run_item_events(run_id, created_at);

CREATE INDEX IF NOT EXISTS idx_run_item_events_status_created
ON run_item_events(status, created_at);

CREATE INDEX IF NOT EXISTS idx_run_item_events_post_id
ON run_item_events(post_id);

CREATE INDEX IF NOT EXISTS idx_run_item_events_queue_id
ON run_item_events(queue_id);
