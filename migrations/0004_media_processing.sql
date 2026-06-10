-- ══════════════════════════════════════════════════════════════
-- 0004_media_processing.sql
-- Phase 2: Media processing lifecycle + Category extensions
-- ══════════════════════════════════════════════════════════════

-- ── Enhanced discovery_media ──────────────────────────────────
-- thumbnail_url: URL عکس پیش‌نمایش ویدئو (از پلتفرم اصلی)
ALTER TABLE discovery_media ADD COLUMN thumbnail_url TEXT;
-- mime_type: مثال image/jpeg, video/mp4
ALTER TABLE discovery_media ADD COLUMN mime_type TEXT;
-- file_size_bytes: اندازه دقیق فایل (اگر موجود)
ALTER TABLE discovery_media ADD COLUMN file_size_bytes INTEGER;
-- processing_status: وضعیت پردازش مدیا
--   pending → validating → ready | failed | unsupported | too_large | expired
ALTER TABLE discovery_media ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'pending';
-- processing_error: پیام خطای دقیق
ALTER TABLE discovery_media ADD COLUMN processing_error TEXT;
-- expires_at: unix timestamp — برای Instagram/LinkedIn CDN URLs
ALTER TABLE discovery_media ADD COLUMN expires_at INTEGER;
-- telegram_file_id: بعد از اولین upload موفق ذخیره می‌شود (برای reuse)
ALTER TABLE discovery_media ADD COLUMN telegram_file_id TEXT;
-- validated_at: timestamp آخرین validation موفق
ALTER TABLE discovery_media ADD COLUMN validated_at TEXT;

-- ── Category extensions ───────────────────────────────────────
-- custom_prompt: اگر set شود، به جای prompt_profile hardcoded استفاده می‌شود
-- این امکان می‌دهد بدون تغییر کد، هر تعداد دسته‌بندی جدید با prompt اختصاصی بسازید
ALTER TABLE categories ADD COLUMN custom_prompt TEXT;

-- ── Channel extensions ────────────────────────────────────────
-- custom_instructions: دستورالعمل اختصاصی برای AI در هنگام ترجمه برای این کانال
--   مثال: "این کانال برای مخاطبان حرفه‌ای است، از اصطلاحات تخصصی استفاده کن"
ALTER TABLE channels ADD COLUMN custom_instructions TEXT;
-- tone_profile: لحن کانال — formal | casual | educational | news | analytical
ALTER TABLE channels ADD COLUMN tone_profile TEXT NOT NULL DEFAULT 'neutral';
-- channel_label: نام نمایشی کانال برای داشبورد
ALTER TABLE channels ADD COLUMN channel_label TEXT;

-- ── publish_queue enhancement ─────────────────────────────────
-- media_warning: اگر مدیایی با خطا ارسال شد اما بقیه موفق بودند
ALTER TABLE publish_queue ADD COLUMN media_warning TEXT;
-- all_message_ids: آرایه JSON از تمام message_id های Telegram (برای media group)
ALTER TABLE publish_queue ADD COLUMN all_message_ids TEXT DEFAULT '[]';

-- ── Indexes for new columns ───────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_discovery_media_status ON discovery_media(processing_status);
CREATE INDEX IF NOT EXISTS idx_discovery_media_telegram ON discovery_media(telegram_file_id);
