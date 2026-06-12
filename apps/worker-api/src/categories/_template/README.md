# Category module template

Copy this folder when adding a new category module.

This template intentionally contains no live behavior. Do not wire a real category into production with active sources or channels in the same PR that creates the module.

Required rollout order:

1. Add no-op category module.
2. Add tests for no crypto contamination.
3. Add disabled/dry-run DB rows in a separate phase.
4. Enable publishing only after dry-run validation and smoke checks.

Never bypass runtime kill-switches from a category module.
