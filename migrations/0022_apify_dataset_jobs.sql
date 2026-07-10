-- 0022_apify_dataset_jobs.sql
-- Durable job ledger for Apify datasets.
-- Prevents losing datasets when cron/webhook execution is killed by CPU limits.

CREATE TABLE IF NOT EXISTS apify_dataset_jobs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  actor_run_id TEXT,
  rotation_run_id TEXT,
  category_id TEXT,
  platform TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claimed_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_apify_dataset_jobs_source_dataset
  ON apify_dataset_jobs(source_id, dataset_id);

CREATE INDEX IF NOT EXISTS idx_apify_dataset_jobs_status_created
  ON apify_dataset_jobs(status, created_at);

CREATE INDEX IF NOT EXISTS idx_apify_dataset_jobs_dataset
  ON apify_dataset_jobs(dataset_id);

CREATE INDEX IF NOT EXISTS idx_apify_dataset_jobs_source_status
  ON apify_dataset_jobs(source_id, status);
