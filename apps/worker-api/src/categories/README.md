# Category modules

Category-specific behavior lives here so core pipeline files stay category-agnostic.

## Current production modules

- `crypto/` contains the current production crypto policy, scoring prompt, and Apify source strategy.
- `default/` is an explicit no-op fallback for unknown or not-yet-supported categories.

## Rules

- Do not add live behavior in a template/refactor PR.
- Do not add a new category together with core pipeline refactors.
- Unknown categories must not receive crypto policy, crypto scoring prompts, or crypto source rotation plans.
- New category modules must start disabled or dry-run only until a separate rollout PR enables them.
- Source strategy must return `null` for unsupported sources.
- Feature flags and runtime config remain outside category plugins.
- Rich Message and article pipeline belong in later phases, not in category template/default work.

## Add a category

1. Copy `_template/` to a new folder, for example `branding/`.
2. Rename exported symbols from `template...` to `<category>...`.
3. Keep policy and source strategy no-op at first.
4. Add registry imports and maps.
5. Add tests proving no crypto contamination and no live publishing.
6. Roll out the DB/category/source rows in a separate disabled or dry-run PR.
