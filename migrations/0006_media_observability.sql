-- ══════════════════════════════════════════════════════════════
-- 0006_media_observability.sql
-- Phase 6: per-media publish observability
-- ══════════════════════════════════════════════════════════════

ALTER TABLE discovery_media ADD COLUMN telegram_message_id TEXT;
ALTER TABLE discovery_media ADD COLUMN thumbnail_status TEXT;
ALTER TABLE discovery_media ADD COLUMN thumbnail_error TEXT;

CREATE INDEX IF NOT EXISTS idx_discovery_media_item_index ON discovery_media(item_id, media_index);
CREATE INDEX IF NOT EXISTS idx_discovery_media_message ON discovery_media(telegram_message_id);
