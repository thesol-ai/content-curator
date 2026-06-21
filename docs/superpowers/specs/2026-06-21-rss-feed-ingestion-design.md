# RSS Feed Ingestion — Design (rev 2)

**Date:** 2026-06-21
**Status:** Revised after external review; implementation in progress
**Branch:** `rss-feed-ingestion`

> rev 2 incorporates an external technical review. Verified-against-code
> corrections are folded in (data-flow path, candidate-queue uniqueness, atomic
> slot claim, scheduled placement). See "Changes from rev 1" at the bottom.

## Goal

Add crypto news **RSS feeds** as a new, independent content source with **zero
Apify cost** (feeds are fetched directly over HTTP). Every ~30 minutes the worker
polls each enabled feed, picks up new articles, and feeds them into the
**existing** pipeline so they are AI-scored, deduplicated, rewritten into a short
Persian analytical brief, and published to the Telegram channel — riding the same
rail as Apify-sourced items (no separate queue).

Initial feeds (all return `HTTP 200` + XML when fetched with a browser
`User-Agent` + `Accept` header — verified 2026-06-21):

| Feed | Full text in feed? | Image in feed? |
|---|---|---|
| `https://www.coindesk.com/arc/outboundfeeds/rss-full-text?outputType=xml` | yes (`content:encoded` ~3.8k) | yes |
| `https://cointelegraph.com/rss` | no (summary ~170) | yes (enclosure) |
| `https://www.theblock.co/rss.xml` | no (summary ~190) | thumbnail |
| `https://cryptoslate.com/feed/` | yes (`content:encoded` ~16k) | yes |

## Hard constraints (from product owner)

1. **Do not disturb the working Twitter/Apify path.** No edits to the internals
   of shared hot functions Twitter depends on (`attachTranslations`,
   `normalizeTwitterItem`, the Apify rotation/curation branch).
2. **No separate queues / parallel coordination.** RSS rides the same
   `ai_candidate_queue` → `backlog-drain` → `publish_queue` → scheduler rail.
3. **Zero Apify cost.** Direct HTTP fetch.
4. **Bounded downstream AI cost.** Cheap relevance scoring on the feed summary
   first; only survivors pay for full-text extraction + brief generation.
5. **Copyright-safe output**, enforced by prompt + post-check, not just intent.

## Cost model (explicit)

RSS is **zero-Apify-cost, with bounded downstream AI/Jina cost** — *not* zero
cost. The shape matches existing Apify items:

- **Score everything** on title + feed summary (cheap Claude Haiku, the existing
  scoring gate). This is the pre-filter: obvious junk is rejected here, before any
  expensive step.
- **Survivors only:** ensure full text (free from `content:encoded`, else Jina,
  capped) → generate the Persian brief. This replaces the translation step that
  Apify survivors already pay for, so RSS adds no new *class* of cost beyond the
  occasional Jina fetch for the two summary-only feeds.

Known v1 tradeoff (accepted): scoring a 170–190 char summary may occasionally
under-select good articles from Cointelegraph/The Block. v1 keeps the RSS scoring
threshold lenient (high recall) and we monitor per-feed; a gray-zone
"enrich-then-rescore" mechanism is explicitly deferred to v2 to keep the shared
`backlog-drain` scoring path simple.

## Data flow (corrected — RSS does NOT insert discovery_items directly)

Verified against code: in the current pipeline `discovery_items` are written
**after** the AI decision, inside `backlog-drain.persistCandidateDecision →
saveDiscoveryItem`. Fresh source items are pushed into `ai_candidate_queue` via
`enqueueCandidates`. RSS must follow the **same** path.

```
cron (*/5) → if RSS slot is due AND claimed atomically:
  for each enabled rss_source (own try/catch, short per-feed timeout ~8–12s):
    conditional GET (If-None-Match / If-Modified-Since); 304 → skip
      parse XML (fast-xml-parser) → raw items
        for items newer than watermark AND canonical-url unseen:
          normalizeRssItem(raw)         # canonical url, image, feed summary text
          dedupe/stale pre-AI filters   # reuse existing helpers
          enqueueCandidates(...)        # ai_candidate_queue  (NOT discovery_items)
# ── shared rail, unchanged below ──
backlog-drain:
  AI score (title + feed summary)       # cheap pre-filter, rejects most
  gates + storyKey dedup + AI judge     # cross-source dedup
  survivors:
    split by platform →
      platform==='rss': enrichAndBriefRssSurvivors()
        full text = content:encoded (if long enough) → else Jina (capped) → else summary
        generate Persian analytical brief + source attribution
      else: attachTranslations()        # Twitter path, UNTOUCHED
  persistCandidateDecision → saveDiscoveryItem → publish_queue → scheduler
```

Scoring runs **before** any Jina fetch (cost). Full-text + brief happen only for
survivors. `discovery_items` are created by the existing `saveDiscoveryItem`, not
by RSS ingestion — avoiding ghost rows and observability drift.

## Components

### New

1. **Migration `0021_rss_sources` + seed.** Schedule state and content watermark
   are kept distinct:
   ```sql
   CREATE TABLE rss_sources (
     id TEXT PRIMARY KEY,
     category_id TEXT NOT NULL,
     feed_url TEXT NOT NULL,
     label TEXT NOT NULL,
     source_account TEXT NOT NULL,          -- canonical, e.g. 'coindesk'
     enabled INTEGER NOT NULL DEFAULT 1,
     poll_interval_minutes INTEGER NOT NULL DEFAULT 30,
     last_checked_at TEXT,
     last_success_at TEXT,
     last_http_status INTEGER,
     last_error TEXT,
     consecutive_failures INTEGER NOT NULL DEFAULT 0,
     etag TEXT,
     last_modified TEXT,
     last_seen_item_url TEXT,
     last_seen_item_published_at INTEGER,
     created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at TEXT
   );
   ```
   Seeded with the four feeds for the crypto category, `enabled=1`. A canonical
   `source_account` per feed is mandatory (source cap / fair-source behavior keys
   on `NormalizedItem.sourceAccount`).

2. **`rss-url.ts`** — `canonicalArticleUrl(raw)`: `http→https`, lowercase host,
   strip fragment + trailing slash, drop tracking params (`utm_*`, `fbclid`,
   `gclid`, `mc_cid`, `mc_eid`, `igshid`, `ref`, …), normalize amp/mobile hosts.
   Used for **both** `sourceUrl` and `postId` (candidate queue has
   `idx_ai_candidate_queue_source_url_unique`, verified — a unique index on
   `source_url`, so the canonical form must be stable).

3. **`rss-feed-parser.ts`** — wraps `fast-xml-parser` (chosen; **no regex
   parser**). Returns raw item objects with `title, link, guid, pubDate,
   description, contentEncoded, imageCandidates[]`. Handles CDATA, namespaces
   (`content:`, `media:`, `dc:`), `media:content` / `media:thumbnail` /
   `enclosure`, missing/`guid=1`, HTML entities, invalid XML (returns `[]`).

4. **`rss-feed-fetcher.ts`** — conditional `GET` with browser UA + Accept header,
   short timeout, ETag/Last-Modified handling (304 → skip), returns raw items +
   response metadata for `rss_sources` bookkeeping.

5. **`rss-content-extractor.ts`** — layered full-text for a single survivor:
   `content:encoded` (if stripped length ≥ `JINA_MIN_CONTENT_CHARS`) → else Jina
   `https://r.jina.ai/<canonical-url>` (if enabled + under daily cap) → else feed
   summary. **Jina policy:** public articles only; if a paywall/login-wall/403 is
   detected, do **not** bypass — fall back to summary; full text is transient
   (used for the brief, not stored). Budget tracked in `ai_usage`
   (`provider='jina'`, `purpose='rss_fulltext'`, `status=success|skipped|error`).

6. **`rss-ingestion.ts`** — orchestrator: per-feed fetch→parse→normalize→
   dedupe→`enqueueCandidates`, under a dedicated RSS `discovery_run` for
   observability. Atomic per-source slot claim mirroring `claimRotationSlot`
   (`INSERT OR IGNORE` on a settings/claim key `rss_ingest_slot:{source}:{slot}`)
   so only one cron tick per slot fetches a given feed. Caps: per-feed,
   per-run-total, per-day-total.

7. **`rss-brief.ts`** — `generateRssBrief(...)`: copyright-safe Persian post.
   Prompt rules: do not translate paragraph-by-paragraph, do not preserve
   sentence order, **no direct quotes**, summarize/analyze in original Persian,
   include source attribution + link. Post-check guardrail: caption length cap,
   reject/repair if output contains long verbatim passages from the source.

### Changed (small, low-risk)

8. **`normalizeRssItem`** (`apify-client.ts`) — extract lead image
   (`media:content` image/* → `enclosure` image/* → `media:thumbnail` → first
   absolute-https `<img>` in content), carry stripped+capped `content:encoded`
   when present, and set `sourceUrl = postId = canonicalArticleUrl(link)` (never
   `guid`; Cointelegraph emits `guid=1`). `sourceAccount` comes from the feed's
   canonical `source_account`, not the article author. Only the `rss` branch
   changes.

9. **`backlog-drain.ts`** — at the survivor step, **split** `survivorIdx` into
   `rssSurvivorIdx` and `nonRssSurvivorIdx`:
   - non-RSS → existing `attachTranslations` (unchanged), map results back by
     original index.
   - RSS → `enrichAndBriefRssSurvivors`, map results back by original index.
   - Failure isolation: an RSS brief failure releases only RSS candidates to
     `pending`; an `attachTranslations` failure releases only non-RSS survivors.
     Neither aborts the whole batch.

10. **`index.ts` `scheduled`** — add RSS ingestion **after `publishDueItems` and
    before `drainAICandidateQueue`**, wrapped in its own `try/catch` and
    flag-gated. publish-due must never be delayed by feed latency; new RSS items
    still get scored on the same tick.

11. **`wrangler.toml` + `types.ts`** — flags, safe defaults:
    `RSS_INGEST_ENABLED="false"`, `RSS_FEED_PROBE_ONLY="false"`,
    `RSS_INGEST_INTERVAL_MIN="30"`, `RSS_MAX_ITEMS_PER_FEED="4"`,
    `RSS_MAX_NEW_ITEMS_PER_RUN="12"`, `RSS_MAX_NEW_ITEMS_PER_DAY="80"`,
    `RSS_FEED_TIMEOUT_SEC="10"`, `JINA_READER_ENABLED="false"`,
    `JINA_MIN_CONTENT_CHARS="500"`, `JINA_MAX_CALLS_PER_DAY="50"`,
    `JINA_API_KEY` (optional).

### Phase 0 — probe-only (safety before live ingestion)

`RSS_FEED_PROBE_ONLY="true"` runs fetch+parse and logs per feed: status,
content-type, item count, latest title/link, has `content:encoded`?, has image? —
**no enqueue, no publish.** This de-risks Cloudflare **egress-IP** differences
(the feeds return 200 from a normal client; a Worker's egress may be treated
differently by bot protection). The URLs themselves are confirmed reachable.

### Reused unchanged

`ai_candidate_queue`, `backlog-drain` scoring/gates/dedup/AI judge,
`discovery_items` (written by `saveDiscoveryItem`), media pipeline (`direct_url`),
`telegram-publisher`, scheduler.

## Dedup notes

- **Idempotent:** canonical-url `postId`/`sourceUrl` + candidate-queue unique
  index + `INSERT OR IGNORE` ⇒ re-reading a feed enqueues nothing new.
- **Cross-source:** RSS dedups against Twitter/Apify via shared storyKey + AI
  judge (CoinDesk/Cointelegraph/The Block are also scraped from X).

## Error handling / isolation

- Per-feed try/catch with short timeout; one bad/slow feed never blocks others or
  the Apify path; `rss_sources.last_error` / `consecutive_failures` updated.
- Jina failure / paywall → fall back to summary (or skip per policy), never crash.
- RSS brief failure → release only RSS candidates (mirrors existing translation
  failure handling).
- All flags default off → dark-launchable.

## Testing

Unit: canonical-url variants (one candidate only), `normalizeRssItem` (image
extraction, content carry, `guid=1`, canonical source fields), parser shaping
(CDATA, `content:encoded`, `media:*`, enclosure, missing guid, entities, invalid
XML → []), extractor decision (content vs Jina vs summary), paywall detection →
no bypass, brief guardrail (no verbatim/quote, length), slot/cap gating.

Integration: 304 → no enqueue; 403/500 → `last_error` set, other feeds continue;
two ticks same slot → one fetch; **RSS candidate flows through `ai_candidate_queue`
then `backlog-drain` writes `discovery_items`**; mixed survivors → RSS brief and
`attachTranslations` update correct indices; RSS brief failure releases only RSS;
non-RSS translation failure leaves RSS unaffected.

Regression: existing 468-test suite stays green (Twitter path untouched).

## Out of scope (YAGNI for v1)

FiveFilters/RSSHub fallbacks; gray-zone enrich-then-rescore (v2); admin UI for
feeds (seed via migration); a separate cron expression (time-gated instead).

## Changes from rev 1

1. Wording: "zero-marginal-cost" → "zero-Apify-cost with bounded AI/Jina cost".
2. Data flow corrected: RSS → `enqueueCandidates`, **not** direct
   `discovery_items` insert (verified `saveDiscoveryItem` runs post-AI).
3. `rss_sources` schema expanded (schedule state, error counters, watermark,
   canonical `source_account`).
4. Atomic per-feed slot claim added (mirrors `claimRotationSlot`).
5. Parser decided: **fast-xml-parser**, no regex.
6. Probe-only Phase 0 added (egress-IP framing; URLs verified reachable).
7. Jina policy tightened: no paywall bypass, transient text, capped + logged.
8. Mixed-survivor split in `backlog-drain` specified with isolated failure
   release.
9. Canonicalization strengthened for **both** `sourceUrl` and `postId` (unique
   index verified) + canonical `sourceAccount`.
10. Caps lowered + per-run/per-day totals added.
11. Scheduled placement fixed: after `publishDueItems`, before backlog drain.
12. Copyright guardrail made enforceable (no direct quotes + post-check).
