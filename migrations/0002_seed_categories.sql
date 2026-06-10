-- ══════════════════════════════════════════════════════════════
-- 0002_seed_categories.sql
-- دسته‌بندی‌های پیش‌فرض — قابل تغییر بعد از deploy
-- ══════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO categories (id, label, prompt_profile, score_threshold, freshness_hours, media_mode, language_targets, enabled)
VALUES
  ('crypto',    'کریپتو',    'crypto_editorial',    80, 24,  'optional',  '["fa","en"]', 1),
  ('design',    'دیزاین',    'design_editorial',    70, 168, 'preferred', '["fa","en"]', 1),
  ('marketing', 'مارکتینگ',  'marketing_editorial', 75, 72,  'optional',  '["fa","en"]', 1),
  ('product',   'پروداکت',   'product_editorial',   75, 72,  'optional',  '["fa","en"]', 1),
  ('ai_news',   'هوش مصنوعی','ai_news_editorial',   75, 48,  'optional',  '["fa","en"]', 0);

-- توجه: همه categories پیش‌فرض enabled=1 هستند به جز ai_news
-- channels باید جداگانه اضافه شوند با publish_enabled=0
