-- ══════════════════════════════════════════════════════════════
-- 0012_apify_source_task_binding.sql
-- Apify source metadata for actor/task-based recurring runs
-- ══════════════════════════════════════════════════════════════

ALTER TABLE apify_sources ADD COLUMN apify_actor_id TEXT;
ALTER TABLE apify_sources ADD COLUMN apify_task_id TEXT;
ALTER TABLE apify_sources ADD COLUMN last_dataset_id TEXT;
ALTER TABLE apify_sources ADD COLUMN source_config TEXT DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_apify_sources_actor ON apify_sources(apify_actor_id);
CREATE INDEX IF NOT EXISTS idx_apify_sources_task ON apify_sources(apify_task_id);
CREATE INDEX IF NOT EXISTS idx_apify_sources_last_dataset ON apify_sources(last_dataset_id);
