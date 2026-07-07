# Hourly all-profiles apply and rollback runbook

Baseline snapshot:
ops/experiments/hourly-all-profiles/snapshots/baseline_20260707_144200

Rollback command:
bash ops/experiments/hourly-all-profiles/rollback_to_baseline.sh

Rollback restores:
- baseline wrangler.toml production env values
- crypto_fa_pilot channel control-plane config
- crypto apify_sources control-plane rows
- settings rows captured in baseline snapshot

Rollback does not restore:
- publish_queue runtime rows
- already published Telegram messages
- AI usage rows
- Apify run history
- discovery_items created during experiment

Experiment target:
- source id: crypto_v2_hourly_all
- task id: 3ooiOnMdFTXyCJsQV
- initial validated dataset: nFAtPbAQsu0gbDLKC
- saved input file: hourly_all_task_input.json
- observed Apify behavior: maxItems=12 produced 160 raw items, 20 per profile

Worker env target:
- APIFY_CRYPTO_V2_FIXED_SCHEDULE_ENABLED=false
- APIFY_ROTATION_INTERVAL_HOURS=1
- APIFY_ROTATION_SLOT_MINUTES=60
- APIFY_ROTATION_SOURCE_ALLOWLIST=crypto_v2_hourly_all
- APIFY_PRE_RUN_MAX_RUNS_PER_DAY=30
- APIFY_MAX_ITEMS_PER_SOURCE=160
- APIFY_RAW_FETCH_LIMIT_PER_SOURCE=200

Channel target:
- allowed_windows=["00:00-23:59"]
- blocked_windows=[]
- max_per_day=288
- max_per_hour=12
- min_gap_minutes=5

Publish target:
- TELEGRAM_PUBLISH_DUE_LIMIT=1
- publish delays become 1 minute
- source account gap becomes 5 minutes

Apply command:
export HOURLY_APIFY_TASK_ID="3ooiOnMdFTXyCJsQV"
export HOURLY_INITIAL_DATASET_ID="nFAtPbAQsu0gbDLKC"
bash ops/experiments/hourly-all-profiles/apply_hourly_all_profiles.sh

Rollback command:
bash ops/experiments/hourly-all-profiles/rollback_to_baseline.sh

After rollback verify:
- Worker allowlist is back to the old four sources
- APIFY_CRYPTO_V2_FIXED_SCHEDULE_ENABLED=true
- APIFY_ROTATION_SLOT_MINUTES=180
- APIFY_PRE_RUN_MAX_RUNS_PER_DAY=8
- channel is back to 09:00-01:00, max/hour 4, min gap 15
- crypto_v2_hourly_all is not in the production allowlist
