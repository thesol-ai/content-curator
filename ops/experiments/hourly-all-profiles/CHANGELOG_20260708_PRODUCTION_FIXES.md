# Hourly all-profiles production fixes - 2026-07-08

## Branch

fix/hourly-per-profile-ingestion

## Production deploys

### Per-account ingestion cap

Commit:
117fdd3 Cap hourly all-profile ingestion per account

Worker version:
98a8213c-ea24-45d2-a370-abe31a059a81

Changes:
- Added APIFY_PER_ACCOUNT_MAX_ITEMS=12.
- Added Worker-side per-source-account cap after Apify fetch.
- Kept max 12 normalized items per X profile before dedupe/backlog.
- Changed AI_FAIR_SOURCE_PICKER_POOL_MULTIPLIER to 20.
- Did not change Telegram publisher behavior.

Validation:
- Actor still returned 160 raw items, 20 per profile.
- Worker capped processing to 96 items, 12 per profile.
- normalizedSkippedByPerAccountCap=64.

Rollback:
- Restore from ops/experiments/hourly-all-profiles/backups/pre_per_profile_fix_20260708_172733/restore.sh.

### Translation missing retry safety

Commit:
e9a2e76 Keep translation-missing candidates retryable

Worker version:
9404a3db-5d9a-4565-acf7-dd80280e6578

Changes:
- Added AI_CANDIDATE_TRANSLATION_MAX_ATTEMPTS=6.
- Kept normal AI_CANDIDATE_MAX_ATTEMPTS=2.
- needs_translation candidates no longer fail at the normal scoring attempt limit.
- Enabled TRANSLATION_DEBUG_ENABLED=true temporarily for validation.
- Did not change Apify scrape, source selection, publish scheduler, or Telegram publish behavior.

Validation:
- Before patch, 4 publish-eligible candidates hit translation_missing and 0 queue rows were created.
- After patch, the 19:31 run created 2 queued candidates.
- Publish queue showed 1 published Cointelegraph item and 1 scheduled cryptodotnews item.

Rollback:
- Restore from ops/experiments/hourly-all-profiles/patches/translation_missing_retry_20260708_193051/restore.sh.

## Important notes

Production is deployed from this branch until it is merged to main.
Do not redeploy main until these commits are merged, otherwise the fixes can be overwritten.

Do not manually trigger:
- /internal/backlog/drain
- /internal/curation/trigger
- /internal/apify/rotation/run
- /internal/publish/due
