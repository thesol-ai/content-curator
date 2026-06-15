-- source-health-check.sql
-- Health check for Apify/Kaito source quality.
-- IMPORTANT: count ONLY dataset.fetch.success.
-- Do NOT include normalize.complete here, otherwise raw/mock counts are double-counted.

-- 1) General 24h source health report
SELECT
  source_id,
  COUNT(*) AS fetch_events,
  SUM(CAST(json_extract(metadata_json, '$.rawCount') AS INTEGER)) AS raw_count,
  SUM(CAST(json_extract(metadata_json, '$.realRawCount') AS INTEGER)) AS real_count,
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
HAVING raw_count >= 20
ORDER BY mock_pct DESC, raw_count DESC;

-- 2) Disable candidates.
-- Do NOT disable a source based on one bad run. This threshold requires:
--   - mock_pct >= 90
--   - raw_count >= 50
--   - fetch_events >= 3
WITH health AS (
  SELECT
    source_id,
    COUNT(*) AS fetch_events,
    SUM(CAST(json_extract(metadata_json, '$.rawCount') AS INTEGER)) AS raw_count,
    SUM(CAST(json_extract(metadata_json, '$.realRawCount') AS INTEGER)) AS real_count,
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

-- 3) not_scored retry verification after deploy
SELECT
  status,
  last_error,
  COUNT(*) AS n,
  MAX(attempt_count) AS max_attempts
FROM ai_candidate_queue
WHERE created_at >= datetime('now','-24 hours')
GROUP BY status, last_error
ORDER BY n DESC;
