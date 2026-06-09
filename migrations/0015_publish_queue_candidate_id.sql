-- ══════════════════════════════════════════════════════════════
-- 0015_publish_queue_candidate_id.sql
-- Backlog drain duplicate-publish guard — Phase 2
--
-- Adds an optional candidate_id to publish_queue so retrying the same
-- AI candidate cannot create duplicate queue rows for the same channel.
-- Existing rows remain NULL and are not affected by the partial unique index.
-- ══════════════════════════════════════════════════════════════

ALTER TABLE publish_queue ADD COLUMN candidate_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_publish_queue_candidate_channel_unique
  ON publish_queue(candidate_id, channel_id)
  WHERE candidate_id IS NOT NULL;
