-- source-health-check.sql
-- پایش لایه ۱ (تأمین داده). هر روز بزن.
--
-- اصلاح طبق review: فقط 'dataset.fetch.success' شمرده می‌شود.
-- چون 'normalize.complete' هم همان rawCount/realRawCount/actorMockCount را دارد،
-- شمردن هر دو با هم = double-count. اینجا فقط یک event canonical می‌گیریم.

SELECT
  source_id,
  COUNT(*) AS fetch_events,
  SUM(CAST(json_extract(metadata_json, '$.rawCount')       AS INTEGER)) AS raw_count,
  SUM(CAST(json_extract(metadata_json, '$.realRawCount')   AS INTEGER)) AS real_count,
  SUM(CAST(json_extract(metadata_json, '$.actorMockCount') AS INTEGER)) AS mock_count,
  ROUND(
    100.0 * SUM(CAST(json_extract(metadata_json, '$.actorMockCount') AS INTEGER)) /
    NULLIF(SUM(CAST(json_extract(metadata_json, '$.rawCount') AS INTEGER)), 0),
    1
  ) AS mock_pct
FROM run_events
WHERE created_at >= datetime('now','-24 hours')
  AND event_type = 'dataset.fetch.success'
GROUP BY source_id
HAVING raw_count >= 20            -- نمونه‌ی کافی؛ تصمیم با ۲ توییت نگیر
ORDER BY mock_pct DESC, raw_count DESC;

-- معیار خاموش‌کردن (طبق review، محافظه‌کارانه — با یک run قهرکردن actor اعدام نکن):
--   mock_pct >= 90  AND  raw_count >= 50  AND  fetch_events >= 3  → خاموش کن
--   mock_pct 70-90                                                → cooldown (interval بیشتر)
--   mock_pct < 40                                                 → سالم، نگه دار

-- ── پایش fix باگ not_scored بعد از deploy ──
-- اگر fix کار کند، ردیف‌های 'not_scored_retry' را با attempt_count صعودی می‌بینی.
-- بخشی در drain بعدی score خوب می‌گیرند؛ بقیه بعد از max attempts، fail (نه دفنِ خاموش).
SELECT
  status,
  last_error,
  COUNT(*)            AS n,
  MAX(attempt_count)  AS max_attempts
FROM ai_candidate_queue
WHERE created_at >= datetime('now','-24 hours')
GROUP BY status, last_error
ORDER BY n DESC;

-- ══════════════════════════════════════════════════════════════
-- query دوم: disable_candidates
-- source‌هایی که واقعاً باید خاموش شوند را مستقیم لیست می‌کند، با threshold
-- معنادار، تا کسی از روی یک run تصادفی source را اعدام نکند.
-- ══════════════════════════════════════════════════════════════
WITH health AS (
  SELECT
    source_id,
    COUNT(*) AS fetch_events,
    SUM(CAST(json_extract(metadata_json, '$.rawCount')       AS INTEGER)) AS raw_count,
    SUM(CAST(json_extract(metadata_json, '$.realRawCount')   AS INTEGER)) AS real_count,
    SUM(CAST(json_extract(metadata_json, '$.actorMockCount') AS INTEGER)) AS mock_count,
    ROUND(
      100.0 * SUM(CAST(json_extract(metadata_json, '$.actorMockCount') AS INTEGER)) /
      NULLIF(SUM(CAST(json_extract(metadata_json, '$.rawCount') AS INTEGER)), 0),
      1
    ) AS mock_pct
  FROM run_events
  WHERE created_at >= datetime('now','-24 hours')
    AND event_type = 'dataset.fetch.success'
  GROUP BY source_id
)
SELECT *
FROM health
WHERE mock_pct >= 90
  AND raw_count >= 50
  AND fetch_events >= 3
ORDER BY mock_pct DESC, raw_count DESC;
-- هر source‌ای که در این لیست ظاهر شود، کاندیدای خاموش‌کردن است:
--   UPDATE apify_sources SET enabled=0 WHERE id='<source_id>';
