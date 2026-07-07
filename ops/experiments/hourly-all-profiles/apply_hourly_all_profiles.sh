#!/usr/bin/env bash
set -euo pipefail

DB="${DB:-content-curator-db-v2}"
BASELINE="${BASELINE:-ops/experiments/hourly-all-profiles/snapshots/baseline_20260707_144200}"

: "${HOURLY_APIFY_TASK_ID:?Set HOURLY_APIFY_TASK_ID first}"
: "${HOURLY_INITIAL_DATASET_ID:?Set HOURLY_INITIAL_DATASET_ID from a successful manual Apify task run first}"

echo "=== APPLY HOURLY ALL-PROFILES EXPERIMENT ==="
echo "Task: $HOURLY_APIFY_TASK_ID"
echo "Initial dataset: $HOURLY_INITIAL_DATASET_ID"
echo "Baseline: $BASELINE"

if [ ! -f "$BASELINE/rollback_to_this_baseline.sh" ]; then
  echo "STOP: baseline rollback missing: $BASELINE/rollback_to_this_baseline.sh"
  exit 1
fi

echo ""
echo "=== PATCH wrangler.toml EXPERIMENT VARS ==="
python3 - <<'PY'
from pathlib import Path
import re

p = Path("wrangler.toml")
s = p.read_text()

updates = {
    "APIFY_CRYPTO_V2_FIXED_SCHEDULE_ENABLED": "false",
    "APIFY_ROTATION_ENABLED": "true",
    "APIFY_ROTATION_CONTINUOUS_ENABLED": "true",
    "APIFY_ROTATION_INTERVAL_HOURS": "1",
    "APIFY_ROTATION_SLOT_MINUTES": "60",
    "APIFY_ROTATION_SOURCE_ALLOWLIST": "crypto_v2_hourly_all",
    "APIFY_ROTATION_CONTINUOUS_SOURCES_PER_SLOT": "1",
    "APIFY_PRE_RUN_MAX_RUNS_PER_DAY": "30",
    "APIFY_MAX_ATTEMPTS_PER_SLOT": "1",
    "APIFY_TASK_MAX_RETRIES": "0",
    "APIFY_ADAPTIVE_ATTEMPT_SELECTION_ENABLED": "false",
    "APIFY_MAX_ITEMS_PER_SOURCE": "60",
    "APIFY_RAW_FETCH_LIMIT_PER_SOURCE": "120",
    "TELEGRAM_PUBLISH_DUE_LIMIT": "1",
    "PUBLISH_DELAY_BREAKING_MINUTES": "1",
    "PUBLISH_DELAY_HIGH_MINUTES": "1",
    "PUBLISH_DELAY_NORMAL_MINUTES": "1",
    "PUBLISH_DELAY_LOW_MINUTES": "1",
    "PUBLISH_DELAY_EXPIRING_MEDIA_DEFAULT_MINUTES": "1",
    "PUBLISH_DELAY_EXPIRING_MEDIA_HIGH_MINUTES": "1"
}

def set_var(text: str, key: str, value: str) -> str:
    line = f'{key} = "{value}"'
    pattern = rf'^{re.escape(key)}\s*=\s*".*"$'
    if re.search(pattern, text, flags=re.M):
        return re.sub(pattern, line, text, count=1, flags=re.M)
    m = re.search(r'^\[env\.production\.vars\]\s*$', text, flags=re.M)
    if not m:
        raise SystemExit("PATCH_FAILED: [env.production.vars] not found")
    insert_at = m.end()
    return text[:insert_at] + "\n" + line + text[insert_at:]

for k, v in updates.items():
    s = set_var(s, k, v)

p.write_text(s)
print("PATCH_OK: wrangler.toml experiment vars updated")
PY

echo ""
echo "=== TYPECHECK ==="
npm run typecheck

echo ""
echo "=== DEPLOY CONFIG ==="
npm run deploy

echo ""
echo "=== APPLY DB CONFIG ==="
TMP_SQL="$(mktemp)"
cat > "$TMP_SQL" <<SQL
BEGIN TRANSACTION;

INSERT OR IGNORE INTO apify_sources (
  id, category_id, platform, apify_dataset_id, label, enabled,
  apify_actor_id, apify_task_id, last_dataset_id, source_config
)
VALUES (
  'crypto_v2_hourly_all',
  'crypto',
  'x',
  '$HOURLY_INITIAL_DATASET_ID',
  'Hourly all X profiles experiment',
  1,
  'kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest',
  '$HOURLY_APIFY_TASK_ID',
  '$HOURLY_INITIAL_DATASET_ID',
  '{"experiment":"hourly-all-profiles-48h","version":"v2","lane":"hourly_all","accounts":["Cointelegraph","CoinDesk","WuBlockchain","cryptodotnews","CryptoRank_io","WhaleFactor","cryptomanran","CryptoMichNL"],"query_mode":"profile_latest_text_and_media","maxItems":60,"media_policy":"allow_text_and_media","managed_by":"worker_strategy","old_sources_deleted":false}'
);

UPDATE apify_sources
SET
  category_id='crypto',
  platform='x',
  apify_dataset_id='$HOURLY_INITIAL_DATASET_ID',
  label='Hourly all X profiles experiment',
  enabled=1,
  apify_actor_id='kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest',
  apify_task_id='$HOURLY_APIFY_TASK_ID',
  last_dataset_id='$HOURLY_INITIAL_DATASET_ID',
  source_config='{"experiment":"hourly-all-profiles-48h","version":"v2","lane":"hourly_all","accounts":["Cointelegraph","CoinDesk","WuBlockchain","cryptodotnews","CryptoRank_io","WhaleFactor","cryptomanran","CryptoMichNL"],"query_mode":"profile_latest_text_and_media","maxItems":60,"media_policy":"allow_text_and_media","managed_by":"worker_strategy","old_sources_deleted":false}'
WHERE id='crypto_v2_hourly_all';

UPDATE channels
SET
  allowed_windows='["00:00-23:59"]',
  blocked_windows='[]',
  max_per_day=288,
  max_per_hour=12,
  min_gap_minutes=5
WHERE id='crypto_fa_pilot';

COMMIT;
SQL

npx wrangler d1 execute "$DB" --remote --env production --config wrangler.toml --file "$TMP_SQL"
rm -f "$TMP_SQL"

echo ""
echo "=== VERIFY AFTER APPLY ==="
bash ops/experiments/hourly-all-profiles/verify_hourly_all_profiles.sh

echo ""
echo "=== APPLY DONE ==="
