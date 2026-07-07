# Hourly all-profiles experiment

This bundle tests one Apify task containing all X profiles, running hourly, with 24h publishing and a 5-minute publish cadence.

This folder does not affect production by itself.

Files:
- experiment.json: intended test settings
- apply_hourly_all_profiles.sh: applies the experiment to production
- verify_hourly_all_profiles.sh: read-only verification
- rollback_to_baseline.sh: restores the saved baseline config

Important:
- Old sources are not deleted.
- Rollback restores control-plane config only.
- Runtime queue/events are not restored, to avoid resurrecting already-published posts.
- Before running apply, create the new Apify task and run it once manually.
- Apply requires:
  - HOURLY_APIFY_TASK_ID
  - HOURLY_INITIAL_DATASET_ID
