# RSS Feed Ingestion — Design

**Date:** 2026-06-21
**Status:** Approved design, pending spec review
**Branch:** `rss-feed-ingestion`

## Goal

Add crypto news **RSS feeds** as a new, independent, zero-marginal-cost content
source. Every ~30 minutes the worker fetches each enabled feed, picks up new
articles, and feeds them into the **existing** publishing pipeline so they get
AI-scored, deduplicated, rewritten into Persian, and published to the Telegram
channel — exactly like Apify-sourced items.

Initial feeds:

| Feed | Full text in feed? | Image in feed? |
|---|---|---|
| `https://www.coindesk.com/arc/outboundfeeds/rss-full-text?outputType=xml` | yes (`content:encoded`, ~3.8k chars) | yes |
| `https://cointelegraph.com/rss` | no (summary ~170 chars) | yes (enclosure) |
| `https://www.theblock.co/rss.xml` | no (summary ~190 chars) | thumbnail only |
| `https://cryptoslate.com/feed/` | yes (`content:encoded`, ~16k chars) | yes |

## Hard constraints (from product owner)

1. **Must not disturb the working Twitter/Apify path.** No edits to shared hot
   code that Twitter depends on (especially `attachTranslations`,
   `normalizeTwitterItem`, the Apify rotation/curation branch).
2. **No separate queues or parallel coordination machinery.** RSS items ride the
   **same** `discovery_items` → candidate queue → `backlog-drain` → `publish_queue`
   → scheduler rail. The only thing that is RSS-specific is *ingestion transport*
   and a small *rewrite* step.
3. **Zero Apify cost for RSS.** Feeds are fetched directly over HTTP.
4. **Performance unaffected, fewer errors, least pipeline complexity.** Failures
   in RSS must be isolated (one feed failing must not affect other feeds or the
   Apify path).
5. **Copyright-safe output.** Do not republish full line-by-line translations of
   articles. Produce an analytical Persian brief with source attribution.

## Why this is mostly an additive change

The pipeline is already platform-agnostic below ingestion:

- `Platform` already includes `'rss'` (`types.ts`).
- `normalizeItem` already dispatches `rss` → `normalizeRssItem` (`apify-client.ts`).
- Admin routes already accept `'rss'` as a valid platform.
- `discovery_items`, candidate queue, `backlog-drain` (scoring, storyKey dedup,
  AI duplicate judge), media pipeline, scheduler, and publisher all operate on
  `discovery_items` regardless of platform.

The only missing piece is the **transport**: today every item arrives via
`fetchApifyDataset` (read an Apify dataset). There is no direct feed fetch + XML
parse. That, plus a copyright-safe rewrite step, is what this work adds.

## Architecture

```
cron (*/5)  ──►  if RSS due (>= RSS_INGEST_INTERVAL_MIN since last) :
                   for each enabled rss_source (own try/catch):
                     conditional GET feed (etag/last-modified)
                       └─ parse XML → raw items
                            └─ for items newer than watermark AND postId unseen:
                                 normalizeRssItem(raw)   # title, summary, image, link
                                   └─ INSERT discovery_items (platform='rss')
                 # ── from here: the SHARED rail, unchanged ──
                 candidate queue → backlog-drain:
                   AI score (title + feed summary)        # cheap, rejects most
                   gates + storyKey dedup + AI judge      # cross-source dedup
                   survivors only:
                     if platform=='rss':                  # guarded branch, call-site only
                       enrichAndBriefRssSurvivors():
                         full text = content:encoded
                                     → else Jina Reader (capped) for survivors
                                     → else fall back to feed summary
                         generate Persian analytical brief + source attribution
                     else: attachTranslations()           # Twitter path, UNTOUCHED
                   media download (lead image, existing direct_url pipeline)
                   publish_queue → scheduler → Telegram
```

Key ordering decision: **AI scoring happens before any Jina full-text fetch.**
We only spend a Jina call (and its rate-limit budget) on items that already
passed relevance scoring and dedup. Rejected items never trigger an external
fetch.

## Components

### New

1. **`rss_sources` table** (new migration)
   - Columns: `id`, `category_id`, `feed_url`, `label`, `enabled`,
     `last_fetched_at`, `etag`, `last_modified`, `created_at`.
   - Separate from `apify_sources` (whose `apify_dataset_id NOT NULL` is
     meaningless for feeds). Seeded with the four feeds above for the crypto
     category.

2. **`rss-feed-fetcher.ts`**
   - `GET` the feed URL with a conditional request (`If-None-Match` /
     `If-Modified-Since` using stored `etag`/`last_modified`); on `304` skip.
   - Parse the XML into raw item objects shaped to match `normalizeRssItem`'s
     expected fields (`title`, `link`, `guid`, `pubDate`, `description`,
     `content:encoded`, image candidates).
   - **Open sub-decision (resolve in plan):** use `fast-xml-parser` (robust,
     bundles in Workers) vs a focused regex parser (no dependency). Lean toward
     `fast-xml-parser` for correctness unless bundle size is a problem.

3. **`rss-content-extractor.ts`**
   - Layered full-text extraction for a single survivor:
     1. Use `content:encoded` if its stripped length ≥ `JINA_MIN_CONTENT_CHARS`.
     2. Else, if `JINA_READER_ENABLED` and under the daily cap, fetch
        `https://r.jina.ai/<article-url>` (Markdown). Optional API key via env.
     3. Else fall back to the feed summary (item is never dropped for this).
   - Daily call budget tracked the same way as the duplicate judge
     (`ai_usage`-style counter), with a `skipped` record when capped.

4. **`rss-ingestion.ts`**
   - Orchestrates: for each enabled feed → fetch → parse → normalize → insert
     `discovery_items` under a dedicated RSS `discovery_run`.
   - Time-gated to `RSS_INGEST_INTERVAL_MIN` using a stored watermark, mirroring
     the existing Apify rotation-slot gating pattern in `index.ts`.

5. **RSS brief generator** (e.g. `generateRssBrief` in a small new module, or
   colocated with the extractor)
   - Produces a copyright-safe Persian post: Persian title, 5–8 line analytical
     summary, key points, likely market impact, and **source link + outlet
     name**. This is a *rewrite*, not a line-by-line translation.

### Changed (small, low-risk)

6. **`normalizeRssItem`** (`apify-client.ts`) — currently discards image and full
   text and risks postId collisions.
   - Extract lead image from `media:content` / `enclosure` / `media:thumbnail` /
     first `<img>` in `content:encoded`.
   - Carry `content:encoded` (stripped, length-capped) when present.
   - **`postId` = canonical article link** (strip `utm_*` query params), not
     `guid` — Cointelegraph emits `guid=1`, which would collide and break dedup.
   - Only the `rss` branch changes; Twitter/Instagram/LinkedIn normalizers are
     untouched.

7. **`backlog-drain.ts`** — one platform-guarded branch at the survivor step
   (around the existing `attachTranslations` call): RSS survivors go through
   `enrichAndBriefRssSurvivors(...)`; everything else calls the existing
   `attachTranslations` unchanged. No new queue, no change to scoring/dedup.

8. **`index.ts` `scheduled`** — add an RSS ingestion tick, time-gated, wrapped in
   its own `try/catch`. The existing `*/5` cron expression and the Apify branch
   are unchanged.

9. **`wrangler.toml` + `types.ts`** — new env flags, all defaulting off/safe:
   - `RSS_INGEST_ENABLED` (default `"false"`)
   - `RSS_INGEST_INTERVAL_MIN` (default `"30"`)
   - `RSS_MAX_ITEMS_PER_FEED` (default `"8"`)
   - `JINA_READER_ENABLED` (default `"false"`)
   - `JINA_MIN_CONTENT_CHARS` (default `"500"`)
   - `JINA_MAX_CALLS_PER_DAY` (default `"50"`)
   - `JINA_API_KEY` (optional)

### Reused unchanged

`discovery_items`, candidate queue, `backlog-drain` scoring/gates/dedup/AI judge,
media pipeline (`direct_url`), `telegram-publisher`, scheduler.

## Data / dedup notes

- **Idempotent re-fetch:** `postId` = canonical link; re-reading a feed re-inserts
  nothing new because existing discovery dedup keys on source + postId.
- **Cross-source dedup:** RSS items dedup against Twitter/Apify items through the
  shared storyKey + AI duplicate judge, since all converge in `discovery_items`.
  (CoinDesk/Cointelegraph/TheBlock are also scraped from X via Apify; the judge
  catches the overlap.)
- **Watermark:** per-feed `last_fetched_at` gates ingestion frequency; per-item
  `pubDate` plus postId dedup gates which items are new.

## Error handling / isolation

- Each feed fetch+parse is wrapped independently; a failing feed is logged and
  skipped, never aborting the batch or the Apify path.
- Jina failure → fall back to feed summary; the item still publishes.
- Brief-generation failure → release the survivor to retry (same pattern as the
  existing `attachTranslations` failure handling), never strand items.
- All RSS env flags default to safe/off so the feature can be dark-launched and
  enabled per-flag in production.

## Testing

- Unit: `normalizeRssItem` upgrades (image extraction, content carry, canonical
  postId, Cointelegraph `guid=1` case), XML parser shaping, layered extractor
  decision logic (content:encoded vs Jina vs summary), brief generator shape,
  daily-cap gating.
- Integration: ingestion inserts `discovery_items` with `platform='rss'`; RSS
  survivors route to the brief branch while non-RSS survivors still call
  `attachTranslations`; one feed failing does not affect others.
- Regression: existing 468-test suite stays green (Twitter path untouched).

## Out of scope (YAGNI for v1)

- FiveFilters secondary fallback (Jina + summary fallback is enough for v1).
- RSSHub full-text routes.
- Admin UI for managing feeds (seed via migration; reuse existing source admin
  routes if needed).
- A separate RSS cron expression (time-gated within the existing cron instead).
