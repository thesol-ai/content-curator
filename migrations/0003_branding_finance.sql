-- ══════════════════════════════════════════════════════════════
-- 0003_branding_finance.sql
-- اضافه کردن دسته‌بندی‌های Branding و Finance
-- ══════════════════════════════════════════════════════════════

-- Branding category
INSERT OR IGNORE INTO categories (id, label, prompt_profile, score_threshold, freshness_hours, media_mode, language_targets, enabled)
VALUES
  ('branding', 'برندینگ', 'branding_editorial', 75, 72, 'preferred', '["fa","en"]', 1),
  ('finance',  'فایننس',  'finance_editorial',  80, 24, 'optional',  '["fa","en"]', 1);

-- نمونه channel برای Branding (publish_enabled=0 — باید دستی فعال شود)
-- INSERT INTO channels (id, category_id, telegram_chat_id, language, timezone, max_per_day, max_per_hour, min_gap_minutes, publish_enabled, enabled)
-- VALUES
--   ('ch_branding_fa', 'branding', '@YOUR_BRANDING_FA_CHANNEL', 'fa', 'Asia/Tehran', 8, 2, 45, 0, 1),
--   ('ch_branding_en', 'branding', '@YOUR_BRANDING_EN_CHANNEL', 'en', 'UTC', 8, 2, 45, 0, 1),
--   ('ch_finance_fa',  'finance',  '@YOUR_FINANCE_FA_CHANNEL',  'fa', 'Asia/Tehran', 6, 1, 60, 0, 1),
--   ('ch_finance_en',  'finance',  '@YOUR_FINANCE_EN_CHANNEL',  'en', 'UTC', 6, 1, 60, 0, 1);
