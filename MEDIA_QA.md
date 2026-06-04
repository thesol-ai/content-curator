# Media QA Checklist

This checklist covers the manual and automated QA flow for Telegram media publishing.
It is intentionally separate from dashboard work: no dashboard refactor is required for this phase.

## Scope

Validate that the publishing pipeline handles:

- single image posts as `sendPhoto`
- single video posts as `sendVideo`
- mixed albums as `sendMediaGroup`
- broken or expired media without breaking the whole queue
- binary upload mode for media reliability
- source/signature/channel footer in media captions
- follow-up text messages with link previews disabled

## Safe test setup

Before any live Telegram QA, keep public publishing disabled unless the test channel is isolated:

```text
TELEGRAM_FINAL_PUBLISH_ENABLED=false for public/prod channels during setup
telegram_publish_enabled=false until the test queue is inspected
only enable publish on the dedicated test channel
```

For fast QA, use the manual endpoints added earlier:

```text
POST /internal/publish/due
POST /internal/queue/:id/publish-now
GET  /internal/queue/:id/preview
GET  /internal/media?item=<item_id>
```

## Apify test queries

Use sources that actually include media. A link preview card from Telegram is not media.

```text
from:Cointelegraph filter:images
from:WatcherGuru filter:images
from:Cointelegraph filter:videos
```

Suggested X/Twitter run configuration for image testing:

```json
{
  "twitterContent": "from:Cointelegraph filter:images",
  "queryType": "Latest",
  "lang": "en",
  "maxItems": 10,
  "filter:replies": false,
  "filter:nativeretweets": false
}
```

Suggested X/Twitter run configuration for video testing:

```json
{
  "twitterContent": "from:Cointelegraph filter:videos",
  "queryType": "Latest",
  "lang": "en",
  "maxItems": 10,
  "filter:replies": false,
  "filter:nativeretweets": false
}
```

## Expected DB state

For media posts:

```text
discovery_items.media_count > 0
discovery_media has one row per extracted media item
publish_queue.media_urls is not []
publish_queue.telegram_method is sendPhoto, sendVideo, or sendMediaGroup
```

After publish:

```text
publish_queue.status = published or retry/failed with a clear publish_error
publish_queue.all_message_ids contains every Telegram message id for media groups
discovery_media.processing_status = uploaded for sent media
discovery_media.telegram_file_id is populated when Telegram returns one
discovery_media.telegram_message_id is populated for sent media
```

For partial media groups:

```text
publish_queue.media_warning contains partial_media_group when some items failed
discovery_media.processing_status identifies failed/expired/unsupported items
published media should still have uploaded status
```

## Expected Telegram behavior

Single image:

```text
Telegram method: sendPhoto
Caption uses Telegram HTML
Raw source URL is not visible
Source appears only as linked label
```

Single video:

```text
Telegram method: sendVideo when accepted
Fallback order: sendVideo -> sendDocument -> sendMessage
If a follow-up message is sent, link_preview_options.is_disabled = true
```

Media group:

```text
Telegram method: sendMediaGroup
Only the first media item has caption
If full caption is too long, a follow-up sendMessage is sent
Follow-up sendMessage has link preview disabled
```

## Automated coverage

Run:

```bash
npm test -- --run tests/media-qa.test.ts tests/media-resolver.test.ts tests/e2e-validation.test.ts
```

The dedicated media QA tests cover:

- formatted single image captions
- formatted single video captions and full-caption follow-up
- mixed media groups from normalized Apify fixtures
- partial media group publishing in binary mode
- fail-closed behavior when partial media publishing is disabled
- atomic source/signature/footer handling in media captions
