-- ══════════════════════════════════════════════════════════════
-- 0009_message_format_controls.sql
-- Phase 12: channel-level Telegram message formatting controls
-- ══════════════════════════════════════════════════════════════

-- Source display controls. source_url remains in publish_queue for audit even when hidden from Telegram output.
ALTER TABLE channels ADD COLUMN source_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE channels ADD COLUMN source_label_override TEXT;

-- Plain-text channel signature controls. Custom HTML is intentionally not allowed in phase 1.
ALTER TABLE channels ADD COLUMN signature_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN signature_text TEXT;

-- Optional footer for the public channel id/handle.
ALTER TABLE channels ADD COLUMN channel_id_footer_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN channel_id_footer_text TEXT;

-- Telegram link previews must be disabled by default for clean channel output.
ALTER TABLE channels ADD COLUMN disable_link_preview INTEGER NOT NULL DEFAULT 1;

-- Controls reserved for the next semantic-dedupe implementation phase.
ALTER TABLE channels ADD COLUMN semantic_dedupe_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE channels ADD COLUMN semantic_dedupe_window_hours INTEGER NOT NULL DEFAULT 24;
ALTER TABLE channels ADD COLUMN max_posts_per_source_per_day INTEGER;
