# Hourly all-profiles experiment rollback notes

Baseline rollback:
- Use `ops/experiments/hourly-all-profiles/rollback_to_baseline.sh`.
- That restores the control-plane config from the baseline snapshot and deploys the baseline `wrangler.toml`.
- It intentionally does not restore runtime queue rows or resurrect failed/published messages.

Apify task created for experiment:
- Name: crypto-v2-hourly-all
- Task ID: 3ooiOnMdFTXyCJsQV
- Actor: CJdippxWmn9uRfooo
- Saved input file: `hourly_all_task_input.json`

Observed Apify behavior:
- `maxItems=12` returned 20 items per profile in the validation run.
- Eight profiles produced 160 raw items.
- Therefore the experiment uses:
  - `APIFY_RAW_FETCH_LIMIT_PER_SOURCE=200`
  - `APIFY_MAX_ITEMS_PER_SOURCE=160`

Rollback Apify:
- Do not delete the task during rollback.
- Disable any native Apify schedule if one was accidentally created.
- Production rollback switches Worker allowlist back to the old four sources, so this task becomes unused.
