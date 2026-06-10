-- ══════════════════════════════════════════════════════════════
-- 0005_thumbnail_urls.sql
-- اضافه کردن thumbnail_urls به publish_queue
-- ══════════════════════════════════════════════════════════════

-- thumbnail_urls: آرایه JSON موازی با media_urls — برای ارسال thumbnail ویدئو
ALTER TABLE publish_queue ADD COLUMN thumbnail_urls TEXT DEFAULT '[]';
