-- cost-monitor.sql
-- هر روز بزن تا هزینه‌ی Apify و AI از کنترل خارج نشود.

-- ══════════════════════════════════════════════════════════════
-- ۱. هزینه‌ی Apify: چند run در ۲۴ ساعت، و چقدرش mock (هدررفته) بود؟
--    Apify برای هر run پول می‌گیرد، حتی اگر mock برگرداند.
-- ══════════════════════════════════════════════════════════════
SELECT
  source_id,
  COUNT(*) AS runs_24h,
  SUM(CAST(json_extract(metadata_json, '$.rawCount')       AS INTEGER)) AS raw,
  SUM(CAST(json_extract(metadata_json, '$.realRawCount')   AS INTEGER)) AS real,
  SUM(CAST(json_extract(metadata_json, '$.actorMockCount') AS INTEGER)) AS mock,
  ROUND(100.0 * SUM(CAST(json_extract(metadata_json, '$.actorMockCount') AS INTEGER)) /
    NULLIF(SUM(CAST(json_extract(metadata_json, '$.rawCount') AS INTEGER)), 0), 1) AS mock_pct
FROM run_events
WHERE created_at >= datetime('now','-1 day')
  AND event_type = 'dataset.fetch.success'
GROUP BY source_id
ORDER BY runs_24h DESC;
-- اگر یک source هم run زیاد دارد هم mock بالا → پول هدر می‌رود → خاموشش کن.

-- ══════════════════════════════════════════════════════════════
-- ۲. مجموع run در روز (کل هزینه‌ی Apify متناسب با این است)
-- ══════════════════════════════════════════════════════════════
SELECT COUNT(*) AS total_apify_runs_24h
FROM run_events
WHERE created_at >= datetime('now','-1 day')
  AND event_type = 'dataset.fetch.success';
-- با تنظیمات فعلی (continuous, slot=30min) باید حدود ۴۸ یا کمتر باشد.
-- اگر خیلی بیشتر بود → یعنی continuous خاموش شده یا slot کوچک شده.

-- ══════════════════════════════════════════════════════════════
-- ۳. هزینه‌ی AI: چند call و چند توکن در ۲۴ ساعت (در برابر سقف)
--    سقف فعلی production: AI_MAX_CALLS_PER_DAY=100, AI_DAILY_TOKEN_BUDGET=350000
-- ══════════════════════════════════════════════════════════════
SELECT
  provider,
  purpose,
  status,
  COUNT(*)                 AS calls_24h,
  SUM(input_tokens)        AS input_tokens,
  SUM(output_tokens)       AS output_tokens,
  SUM(input_tokens + output_tokens) AS total_tokens
FROM ai_usage
WHERE created_at >= datetime('now','-1 day')
GROUP BY provider, purpose, status
ORDER BY total_tokens DESC;
-- اگر status='skipped' با reason بودجه دیدی → یعنی سقف خورده (سیستم خودش جلوش را گرفته).
-- اگر calls_24h به 100 نزدیک شد → یا سقف را بالا ببر یا منبع‌ها را تمیزتر کن.
