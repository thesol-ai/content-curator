# Release hardening checklist

This checklist is the final gate before merging or deploying the current Content Curator release.

It is intentionally operational and conservative. The project can publish to real Telegram channels, spend real API budget, and process real Apify runs. Do not treat this as ceremonial paperwork. Ceremonies are how software ships surprises.

## 1. Repository checks

Run from the repository root:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run validate:media
npm run validate:release
```

For a stricter release gate that fails on production-enabled publish/curation flags in `wrangler.toml`:

```bash
RELEASE_STRICT=1 npm run validate:release
```

Expected state:

- TypeScript passes.
- Unit and integration tests pass.
- Worker dry-run build passes.
- Media QA targeted tests pass.
- Release hardening check passes, or any warnings are explicitly reviewed and accepted by the release owner.

## 2. Migration order

Before adding or applying migrations, confirm the current order:

```bash
ls -la migrations
```

Expected migrations for this release line:

```text
0001_core.sql
0002_seed_categories.sql
0003_branding_finance.sql
0004_media_processing.sql
0005_thumbnail_urls.sql
0006_media_observability.sql
0007_apify_extraction_diagnostics.sql
0008_ai_usage.sql
0009_message_format_controls.sql
0010_editorial_controls.sql
0011_content_filter_controls.sql
0012_apify_source_task_binding.sql
```

Do not rename, reuse, or edit an already-applied migration. If another branch has different migration numbering, resolve that before merge.

Apply locally before remote:

```bash
npm run db:migrate:local
```

Remote migration must only be run after config and publish toggles are reviewed:

```bash
npm run db:migrate:remote
```

## 3. Secrets check

Never commit real values for:

```text
ANTHROPIC_API_KEY
GEMINI_API_KEY
APIFY_TOKEN
TELEGRAM_BOT_TOKEN
INTERNAL_API_SECRET
CLOUDFLARE_API_TOKEN
CLOUDFLARE_STREAM_API_TOKEN
```

Use Cloudflare Worker secrets:

```bash
wrangler secret put ANTHROPIC_API_KEY --env production
wrangler secret put GEMINI_API_KEY --env production
wrangler secret put APIFY_TOKEN --env production
wrangler secret put TELEGRAM_BOT_TOKEN --env production
wrangler secret put INTERNAL_API_SECRET --env production
```

Run:

```bash
npm run validate:release
```

The release check scans common high-risk files for committed secret-like assignments.

## 4. Runtime safety switches

Before deployment, explicitly review these values in `wrangler.toml` and in the D1 `settings` table:

```text
APIFY_CURATION_ENABLED
APIFY_CURATION_DRY_RUN
TELEGRAM_FINAL_PUBLISH_ENABLED
TELEGRAM_PUBLISH_SCHEDULER_ENABLED
TELEGRAM_PUBLISH_DUE_LIMIT
```

Effective Telegram publish must require both locks:

```text
TELEGRAM_FINAL_PUBLISH_ENABLED=true
telegram_publish_enabled=true
```

Effective scheduled publishing must require:

```text
TELEGRAM_PUBLISH_SCHEDULER_ENABLED=true
TELEGRAM_FINAL_PUBLISH_ENABLED=true
telegram_publish_enabled=true
```

For a safe staging/default posture:

```text
APIFY_CURATION_ENABLED=false
APIFY_CURATION_DRY_RUN=true
TELEGRAM_FINAL_PUBLISH_ENABLED=false
TELEGRAM_PUBLISH_SCHEDULER_ENABLED=false
telegram_publish_enabled=false
```

For production activation, turn things on intentionally and in this order:

1. Run dry-run curation.
2. Confirm selected/rejected items look right.
3. Confirm queue previews look right.
4. Enable DB `telegram_publish_enabled` only for test channel first.
5. Enable channel `publish_enabled` only for test channel first.
6. Enable env-level final publish and scheduler only after test publish succeeds.

## 5. Channel production-safe defaults

Before public-channel publish, review every active channel:

```text
max_per_day
max_per_hour
min_gap_minutes
allowed_windows
blocked_windows
source_enabled
signature_enabled
channel_id_footer_enabled
disable_link_preview
semantic_dedupe_enabled
semantic_dedupe_window_hours
```

Recommended crypto pilot defaults:

```text
max_per_day = 5
max_per_hour = 1
min_gap_minutes = 90
allowed_windows = ["09:00-23:00"]
blocked_windows = ["00:00-08:00"]
source_enabled = true
signature_enabled = true
channel_id_footer_enabled = true
disable_link_preview = true
semantic_dedupe_enabled = true
semantic_dedupe_window_hours = 24
allow_replies = false
text_only_policy = penalize
min_score_for_text_only = 90
```

## 6. Prompt and editorial QA

For each active category/channel pair, verify:

- Category editorial guidelines exist.
- Selection criteria and rejection criteria are specific enough.
- Required context explains important people, projects, and recurring concepts.
- Language prompt is set for each language/channel.
- Forbidden phrases include obvious machine-like phrases for that language.
- Translation prompt does not ask the model to include raw source URLs.
- Queue preview shows source as a linked label only.

For Persian crypto, check that outputs introduce people like Vitalik Buterin on first mention, avoid raw tweet phrasing, and read like Telegram news/education posts rather than translated fragments.

## 7. Content filter QA

Review category-level controls:

```text
allow_replies
allow_retweets
allow_quotes
text_only_policy
min_score_for_text_only
min_score_for_media
```

For crypto pilots, keep replies disabled unless a source is explicitly meant to publish standalone replies.

Confirm reject reasons are visible in `/internal/items`, especially:

```text
reply_not_allowed
retweet_not_allowed
quote_not_allowed
text_only_rejected
text_only_score_floor
media_score_floor
similar_topic_in_run
```

## 8. Telegram formatting QA

Before public publish, use dashboard queue preview or:

```bash
curl "$WORKER/internal/queue/$QUEUE_ID/preview" \
  -H "x-internal-api-secret: $INTERNAL_API_SECRET"
```

Confirm:

- Raw source URL is not visible in the message body.
- Source appears only as a linked label.
- Signature is escaped plain text.
- Channel footer is correct.
- Link preview is disabled in the Telegram payload.
- Media captions do not split footer/source halfway.

## 9. Manual publish QA

Use manual endpoints only after preview is correct:

```bash
curl -X POST "$WORKER/internal/publish/due" \
  -H "x-internal-api-secret: $INTERNAL_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"limit":1}'
```

For one queue item:

```bash
curl -X POST "$WORKER/internal/queue/$QUEUE_ID/publish-now" \
  -H "x-internal-api-secret: $INTERNAL_API_SECRET"
```

Manual publish endpoints bypass scheduler timing only. They must not bypass final Telegram publish locks.

## 10. Apify webhook QA

For Apify webhooks, prefer:

```text
POST /webhook/apify?source_id=src_xxx
x-webhook-secret: ...
```

Confirm:

- Known `source_id` processes only that source.
- Unknown `source_id` is a safe no-op.
- Invalid `source_id` returns a controlled error.
- `last_dataset_id` updates after webhook ingestion.

## 11. Media QA

Run:

```bash
npm run validate:media
```

Follow `MEDIA_QA.md` for manual tests:

```text
from:Cointelegraph filter:images
from:WatcherGuru filter:images
from:Cointelegraph filter:videos
```

Confirm single photo, single video, media group, broken media, and follow-up captions all behave correctly.

## 12. Final pre-merge checklist

- [ ] Migrations are ordered and local migrations apply.
- [ ] No secrets are committed.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes or failure is documented and fixed.
- [ ] `npm run build` passes.
- [ ] `npm run validate:media` passes.
- [ ] `npm run validate:release` passes.
- [ ] Runtime switches reviewed.
- [ ] Channel quotas/windows reset from test values.
- [ ] Prompt/editorial controls reviewed for every live category/channel.
- [ ] Reply/text-only/media policies reviewed.
- [ ] Queue preview matches expected Telegram output.
- [ ] Link preview disabled everywhere.
- [ ] Raw source URL not visible in messages.
- [ ] Test channel publish succeeds before public channels are enabled.
