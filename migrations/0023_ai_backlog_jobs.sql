-- 0023_ai_backlog_jobs.sql
--
-- Durable batch ownership and stage checkpoints for the AI candidate backlog.
-- This migration is additive. It does not activate a new execution path.

CREATE TABLE IF NOT EXISTS ai_backlog_jobs (
  id                    TEXT PRIMARY KEY,
  dispatch_id           TEXT NOT NULL,
  source                TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending',
  stage                 TEXT NOT NULL DEFAULT 'created',
  stage_cursor          INTEGER NOT NULL DEFAULT 0,
  scheduled_time_ms     INTEGER,
  batch_context_json    TEXT,
  lease_token           TEXT,
  lease_expires_at      TEXT,
  queue_sent_at         TEXT,
  next_run_at           TEXT,
  delivery_attempts     INTEGER NOT NULL DEFAULT 0,
  last_error            TEXT,
  created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at          TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_backlog_jobs_dispatch
  ON ai_backlog_jobs(dispatch_id);

CREATE INDEX IF NOT EXISTS idx_ai_backlog_jobs_status_next_run
  ON ai_backlog_jobs(status, next_run_at, updated_at);

CREATE INDEX IF NOT EXISTS idx_ai_backlog_jobs_lease
  ON ai_backlog_jobs(status, lease_expires_at);

CREATE TABLE IF NOT EXISTS ai_backlog_job_items (
  job_id                  TEXT NOT NULL,
  candidate_id            TEXT NOT NULL,
  ordinal                 INTEGER NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'pending',
  score_result_json       TEXT,
  gate_result_json        TEXT,
  duplicate_result_json   TEXT,
  translation_result_json TEXT,
  persist_result_json     TEXT,
  provider_attempts       INTEGER NOT NULL DEFAULT 0,
  translation_failures    INTEGER NOT NULL DEFAULT 0,
  last_error              TEXT,
  created_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at            TEXT,
  PRIMARY KEY (job_id, candidate_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_backlog_job_items_ordinal
  ON ai_backlog_job_items(job_id, ordinal);

CREATE INDEX IF NOT EXISTS idx_ai_backlog_job_items_candidate
  ON ai_backlog_job_items(candidate_id);

CREATE INDEX IF NOT EXISTS idx_ai_backlog_job_items_status
  ON ai_backlog_job_items(job_id, status, ordinal);

ALTER TABLE ai_candidate_queue
  ADD COLUMN processing_job_id TEXT;

CREATE INDEX IF NOT EXISTS idx_ai_candidate_queue_processing_job
  ON ai_candidate_queue(processing_job_id);

CREATE INDEX IF NOT EXISTS idx_ai_candidate_queue_dispatchable
  ON ai_candidate_queue(
    status,
    processing_job_id,
    priority_score DESC,
    created_at ASC
  );
