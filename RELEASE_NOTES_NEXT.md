# Next release notes

This release moves Content Curator from a working pilot pipeline toward a safer production-ready editorial system.

## Highlights

- Runtime safety now uses centralized effective config.
- Telegram publish requires both env-level and DB-level permission.
- Scheduler respects the final publish kill-switch.
- Unknown Apify webhook datasets/sources are safe no-ops.
- Telegram message formatting is handled by a dedicated formatter.
- Raw source URLs are hidden behind localized linked labels.
- Link previews are disabled in all text-message paths.
- Channel-level source, signature, footer, and link-preview controls are supported.
- Manual publish endpoints support QA without waiting for cron.
- Backend queue preview uses the real formatter, preventing dashboard/publish divergence.
- Dashboard gained formatting, queue preview, publish-now, and editorial controls without redesign.
- Semantic run-level dedupe rejects near-duplicate source/topic candidates.
- Editorial controls support category and language/channel prompt tuning.
- Reply, quote, retweet, and text-only policies are configurable.
- Apify sources can store actor/task metadata and last webhook dataset IDs.
- Media QA coverage was added for photo/video/media-group publishing.

## Operational caution

This release includes changes that affect live publishing behavior. Before deploying to public channels, complete `RELEASE_CHECKLIST.md`.

The safest activation order is:

1. Deploy with publish disabled.
2. Run migrations.
3. Run curation in dry-run mode.
4. Review rejected/selected items.
5. Review queue previews.
6. Publish only to a test channel.
7. Enable production channels gradually.

## Dashboard note

The dashboard structure and styling were preserved. Changes were additive: new fields, controls, and actions were added without removing existing dashboard sections or splitting the dashboard into new frontend files.

## Known follow-up work

- Optional stricter window-based semantic dedupe by `category_id + channel_id + topic_fingerprint`.
- Optional direct Apify task/actor execution from Worker once task credentials and cost controls are explicitly designed.
- Dependency audit remediation for npm vulnerabilities reported during `npm ci`.
- Additional live media QA with real Apify datasets before broad rollout.

## Phase 14 — Dependency audit remediation

- Upgraded `vitest` to the current 4.x line.
- Upgraded `wrangler` to the current 4.x line.
- Added `npm run validate:audit` for repeatable audit checks.
- Added `DEPENDENCY_AUDIT.md` with verification commands and audit notes.
- Verified the updated toolchain with typecheck, full tests, dry-run build, media validation, release validation, and npm audit.

Dashboard files were not changed in this phase.
