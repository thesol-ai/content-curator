# Artificial Intelligence category

Phase 05 introduces `ai` as a future non-crypto category, but keeps it disabled.

Safety state:

- category seed is `enabled=0`
- channel seed is `publish_enabled=0` and `enabled=0`
- Apify source seed is `enabled=0`
- source strategy is no-op and returns no rotation plan
- no Telegram publishing is enabled
- no scheduler/runtime flags are changed
- no article or Rich Message behavior is enabled

The next rollout step must be a separate dry-run PR that explicitly enables only controlled discovery for this category.
