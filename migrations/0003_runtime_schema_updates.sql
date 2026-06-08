-- Runtime schema updates required by current Worker code

-- categories
ALTER TABLE categories ADD COLUMN custom_prompt TEXT;

-- channels
ALTER TABLE channels ADD COLUMN custom_instructions TEXT;
ALTER TABLE channels ADD COLUMN tone_profile TEXT NOT NULL DEFAULT 'neutral';
ALTER TABLE channels ADD COLUMN channel_label TEXT;

-- discovery_items media diagnostics
ALTER TABLE discovery_items ADD COLUMN media_expected_count INTEGER;
ALTER TABLE discovery_items ADD COLUMN media_extracted_count INTEGER;
ALTER TABLE discovery_items ADD COLUMN media_extraction_warnings TEXT DEFAULT '[]';

-- discovery_media lifecycle
ALTER TABLE discovery_media ADD COLUMN thumbnail_url TEXT;
ALTER TABLE discovery_media ADD COLUMN mime_type TEXT;
ALTER TABLE discovery_media ADD COLUMN file_size_bytes INTEGER;
ALTER TABLE discovery_media ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE discovery_media ADD COLUMN processing_error TEXT;
ALTER TABLE discovery_media ADD COLUMN expires_at INTEGER;
ALTER TABLE discovery_media ADD COLUMN telegram_file_id TEXT;
ALTER TABLE discovery_media ADD COLUMN telegram_message_id TEXT;
ALTER TABLE discovery_media ADD COLUMN thumbnail_status TEXT;
ALTER TABLE discovery_media ADD COLUMN thumbnail_error TEXT;
ALTER TABLE discovery_media ADD COLUMN validated_at TEXT;

CREATE INDEX IF NOT EXISTS idx_discovery_media_status ON discovery_media(processing_status);
CREATE INDEX IF NOT EXISTS idx_discovery_media_telegram ON discovery_media(telegram_file_id);

-- publish_queue enhancements
ALTER TABLE publish_queue ADD COLUMN thumbnail_urls TEXT DEFAULT '[]';
ALTER TABLE publish_queue ADD COLUMN media_warning TEXT;
ALTER TABLE publish_queue ADD COLUMN all_message_ids TEXT DEFAULT '[]';
