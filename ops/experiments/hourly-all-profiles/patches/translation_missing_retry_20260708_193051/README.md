# Translation missing retry safety patch

## Context

Branch:
fix/hourly-per-profile-ingestion

Previous production patch:
- Added APIFY_PER_ACCOUNT_MAX_ITEMS=12.
- Added per-source-account cap after Apify fetch.
- Changed AI_FAIR_SOURCE_PICKER_POOL_MULTIPLIER from 6 to 20.
- Deployed Worker version 98a8213c-ea24-45d2-a370-abe31a059a81.
- Commit: 117fdd3 Cap hourly all-profile ingestion per account.

Validation:
- Run run_1783522880116_sm0t9i at 2026-07-08 18:31 Tehran.
- Raw Apify count: 160.
- After per-account cap: 96.
- Each of 8 profiles had max 12 normalized items.
- normalizedSkippedByPerAccountCap: 64.

Problem found after validation:
- 8 candidates entered AI candidate backlog.
- 4 unique candidates became publish-eligible / ai_selected.
- 0 publish_queue rows were created.
- 3 selected candidates failed with max_attempts_exceeded after repeated translation_missing.
- 1 selected WhaleFactor candidate became ai_rejected on retry.
- Gemini translation calls were successful at provider level, but no usable channel translation was attached.

Root cause:
- needs_translation candidates are claimed like pending candidates.
- claimCandidateBatch increments attempt_count for needs_translation.
- failMaxAttemptPendingCandidates fails needs_translation at the same AI_CANDIDATE_MAX_ATTEMPTS threshold as normal scoring.
- Translation-missing selected candidates can be buried after 2 attempts, even though the scoring decision was good.

Patch intent:
- Separate translation retry budget from normal scoring retry budget.
- Keep selected candidates with translation_missing alive longer.
- Enable translation diagnostics for the next natural cron run.
- Do not change Apify scrape, source selection, publishing scheduler, or Telegram publish behavior.

Rollback:
- Restore files from *.before in this directory.
- Run npm run typecheck.
- Run npm run deploy.
