#!/usr/bin/env bash
set -euo pipefail

DB="${DB:-content-curator-db-v2}"

echo "=== CHANNEL CONFIG ==="
npx wrangler d1 execute "$DB" --remote --env production --config wrangler.toml --command "
SELECT
  id, enabled, publish_enabled, timezone,
  allowed_windows, blocked_windows,
  max_per_day, max_per_hour, min_gap_minutes
FROM channels
WHERE id='crypto_fa_pilot';
"

echo ""
echo "=== HOURLY SOURCE ==="
npx wrangler d1 execute "$DB" --remote --env production --config wrangler.toml --command "
SELECT
  id, category_id, platform, label, enabled,
  apify_task_id, apify_dataset_id, last_dataset_id,
  source_config
FROM apify_sources
WHERE id='crypto_v2_hourly_all'
   OR category_id='crypto'
ORDER BY id;
"

echo ""
echo "=== LAST 6H APIFY ROTATION ==="
npx wrangler d1 execute "$DB" --remote --env production --config wrangler.toml --command "
SELECT
  datetime(created_at, '+3 hours', '+30 minutes') AS created_tehran,
  event_type,
  source_id,
  dataset_id,
  json_extract(metadata_json, '$.actorRunId') AS actor_run_id,
  json_extract(metadata_json, '$.datasetHealth.realRawCount') AS real_raw_count,
  json_extract(metadata_json, '$.inputOverride.since_time') AS since_time
FROM run_events
WHERE created_at >= datetime('now', '-6 hours')
  AND event_type LIKE 'apify.rotation.%'
ORDER BY created_at DESC
LIMIT 80;
"

echo ""
echo "=== QUEUE NEXT 6H ==="
npx wrangler d1 execute "$DB" --remote --env production --config wrangler.toml --command "
SELECT
  status,
  COUNT(*) AS rows,
  MIN(datetime(scheduled_at, 'unixepoch', '+3 hours', '+30 minutes')) AS first_scheduled_tehran,
  MAX(datetime(scheduled_at, 'unixepoch', '+3 hours', '+30 minutes')) AS last_scheduled_tehran
FROM publish_queue
WHERE channel_id='crypto_fa_pilot'
  AND status IN ('scheduled','retry','publishing')
  AND scheduled_at BETWEEN unixepoch('now') - 3600 AND unixepoch('now') + 6*3600
GROUP BY status;
"

echo ""
echo "=== AI COST LAST 6H ==="
npx wrangler d1 execute "$DB" --remote --env production --config wrangler.toml --command "
SELECT
  provider, purpose, status,
  COUNT(*) AS calls,
  COALESCE(SUM(input_tokens + output_tokens),0) AS total_tokens,
  MIN(datetime(created_at, '+3 hours', '+30 minutes')) AS first_tehran,
  MAX(datetime(created_at, '+3 hours', '+30 minutes')) AS last_tehran
FROM ai_usage
WHERE created_at >= datetime('now', '-6 hours')
GROUP BY provider, purpose, status
ORDER BY provider, purpose, status;
"

echo ""
echo "=== PUBLISH SAFETY ERRORS LAST 24H ==="
npx wrangler d1 execute "$DB" --remote --env production --config wrangler.toml --command "
SELECT
  status,
  publish_error,
  COUNT(*) AS rows,
  MIN(datetime(created_at, '+3 hours', '+30 minutes')) AS first_created_tehran,
  MAX(datetime(created_at, '+3 hours', '+30 minutes')) AS last_created_tehran
FROM publish_queue
WHERE channel_id='crypto_fa_pilot'
  AND created_at >= datetime('now', '-24 hours')
  AND (
    status='publishing'
    OR publish_error LIKE '%stale_publishing%'
    OR publish_error LIKE '%recovered_from_stale_publishing%'
    OR publish_error LIKE '%legacy_recovered_retry_quarantined%'
    OR publish_error LIKE '%final_publish_duplicate_guard%'
  )
GROUP BY status, publish_error
ORDER BY rows DESC;
"
