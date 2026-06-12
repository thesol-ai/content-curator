# Content Curator

> Fully automated, multi-category content curation and Telegram publishing system.
> **Apify → Cloudflare Worker → Claude AI → Telegram**
> Current production crypto pilot also uses **controlled Apify rotation → AI candidate backlog → fair source scoring → Gemini translation → Telegram scheduler**.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Pipeline Flow](#pipeline-flow)
- [Current Production Architecture & Pilot State](#current-production-architecture--pilot-state)
- [AI Candidate Backlog & Fair Source Distribution](#ai-candidate-backlog--fair-source-distribution)
- [Apify Controlled Rotation](#apify-controlled-rotation)
- [Crypto Quality Gate & Whale Alert Throttle](#crypto-quality-gate--whale-alert-throttle)
- [Media Processing](#media-processing)
- [Category & Language System](#category--language-system)
- [Project Structure](#project-structure)
- [Tech Stack & Cost](#tech-stack--cost)
- [Prerequisites](#prerequisites)
- [Setup Guide](#setup-guide)
- [Configuration Reference](#configuration-reference)
- [Apify Actors](#apify-actors)
- [Telegram Bot & Channels](#telegram-bot--channels)
- [AI Models & Cost](#ai-models--cost)
- [Scheduling & Time Windows](#scheduling--time-windows)
- [Market Snapshot](#market-snapshot)
- [Operational Runbook](#operational-runbook)
- [Documentation Consolidation & Cleanup](#documentation-consolidation--cleanup)
- [Dashboard](#dashboard)
- [API Reference](#api-reference)
- [Safety Switches](#safety-switches)
- [Security](#security)
- [GitHub Actions](#github-actions)
- [Implementation Phases & Validation History](#implementation-phases--validation-history)
- [Troubleshooting](#troubleshooting)
- [Monthly Cost Estimate](#monthly-cost-estimate)

---

## Overview

Content Curator is a zero-touch content pipeline that discovers posts from social media, scores them with Claude AI, translates them with Gemini, and publishes them to Telegram channels — fully automatically.

**Current production crypto pilot status:**

- Production Worker: `https://content-curator.thesol-ai.workers.dev`
- Production D1 database: `content-curator-db-v2`
- Active pilot category/channel: `crypto` → `crypto_fa_pilot` → `@thesolcrypto_fa`
- Worker cron: every 5 minutes
- Production publishing path: Apify controlled rotation + webhook/dataset ingestion + AI candidate backlog + Claude scoring + Gemini translation + Telegram scheduler
- Media mode in production: `binary_upload`
- Cloudflare Stream fallback: disabled by default through `STREAM_TRANSCODE_ENABLED=false`
- Target production cadence for the crypto Persian pilot: up to 72 posts/day, constrained by channel windows, `max_per_hour`, and `min_gap_minutes`

**What it does:**

- Discovers posts from Twitter/X, Instagram, LinkedIn, and RSS via Apify
- Deduplicates using three independent keys: platform post ID, URL hash, and text hash (7-day window)
- Scores items 0–100 using Claude Haiku: relevance, freshness, risk level, publish priority
- Filters stale items before AI scoring (saves cost, enforces freshness)
- Translates selected items into any number of target languages using Gemini Flash-Lite or OpenAI
- Enforces per-channel rules: timezone-aware time windows, daily quota, hourly rate, minimum gap
- Publishes to Telegram channels with full media support: photos, videos (with thumbnails), carousels
- Supports binary media upload to avoid CDN expiry issues on Instagram and LinkedIn
- Manages everything through a built-in admin API and web dashboard

**What it does not do:**

- No human review (by design — Claude validates autonomously)
- No Make.com, Zapier, or Google Sheets dependency
- No hardcoded category limit — add any category via API or SQL

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                       APIFY CONSOLE                          │
│  Actor: crypto-x     Actor: design-ig    Actor: mkt-linkedin │
│  Schedule: 0 9,21    Schedule: 0 10      Schedule: 0 10 * 1,4│
│              ↓ webhook (ACTOR.RUN.SUCCEEDED)                 │
└──────────────────────────────────────────────────────────────┘
                             │
                    datasetId scoped
                             │
                             ▼
┌──────────────────────────────────────────────────────────────┐
│             CLOUDFLARE WORKER  (Serverless)                  │
│                                                              │
│  POST /webhook/apify                                         │
│         │                                                    │
│         ▼ ctx.waitUntil — responds 200 immediately           │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │               CURATION PIPELINE                      │   │
│  │                                                      │   │
│  │  1. Fetch dataset from Apify API (scoped to source)  │   │
│  │  2. Normalize (X / Instagram / LinkedIn / RSS)       │   │
│  │     └─ Extract: text, media URLs, thumbnailUrls      │   │
│  │  3. Deduplicate (D1: postId + URL hash + text hash)  │   │
│  │  4. Freshness pre-filter (before AI — saves cost)    │   │
│  │  5. AI Gate Phase 1 — Claude Haiku                   │   │
│  │     └─ Score 0–100, risk level, publish priority     │   │
│  │     └─ Uses category custom_prompt if set            │   │
│  │  6. AI Gate Phase 2 — Gemini / OpenAI                │   │
│  │     └─ Translate + write captions per language       │   │
│  │     └─ Uses channel custom_instructions if set       │   │
│  │  7. Rule Gate — per-channel validation               │   │
│  │     └─ Timezone-aware daily quota + windows          │   │
│  │     └─ min_gap + existing scheduled count            │   │
│  │  8. Publish Queue → D1                               │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  CRON  every 5 minutes                               │   │
│  │  └─ publishDueItems()                                │   │
│  │     ├─ Check hourly rate limit per channel           │   │
│  │     ├─ Check minimum gap between posts               │   │
│  │     ├─ Optimistic lock (prevents double-send)        │   │
│  │     ├─ Download media binary (if binary_upload mode) │   │
│  │     └─ Telegram Bot API: sendPhoto/sendVideo/Album   │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Maintenance mode check on every non-health request          │
└──────────────────────────────────────────────────────────────┘
                             │
           ┌─────────────────┼─────────────────┐
           ▼                 ▼                 ▼
     @crypto_fa        @crypto_en         @design_fa
    (Telegram)         (Telegram)         (Telegram)
```

### Multi-category, multi-language layout

```
Category: crypto  (score_threshold: 80, freshness: 24h)
  ├── Source: kaitoeasyapi/twitter → dataset_id_1
  ├── Source: apify/instagram-post-scraper → dataset_id_2
  ├── Channel: crypto_fa  → @CryptoChannelFa  (fa, Asia/Tehran)
  └── Channel: crypto_en  → @CryptoChannelEn  (en, UTC)

Category: design  (score_threshold: 70, freshness: 168h)
  ├── Source: apify/instagram-post-scraper → dataset_id_3
  └── Channel: design_fa  → @DesignChannelFa  (fa, Asia/Tehran)

Category: finance  (score_threshold: 80, freshness: 24h)
  └── Channel: finance_fa  → @FinanceChannelFa  (fa, Asia/Tehran)
  └── Channel: finance_en  → @FinanceChannelEn  (en, UTC)
  └── Channel: finance_ar  → @FinanceChannelAr  (ar, Asia/Dubai)
```


---

## Current Production Architecture & Pilot State

The original architecture remains valid: Apify produces datasets, the Cloudflare Worker ingests them, Claude scores candidates, Gemini translates selected items, and Telegram publishes scheduled queue items. The current production crypto pilot adds several important operational layers on top of that base flow.

### Effective production flow

```text
Cloudflare cron every 5 minutes
  -> optional scheduled dataset curation only if APIFY_SCHEDULED_CURATION_ENABLED=true
  -> controlled Apify rotation if APIFY_ROTATION_ENABLED=true
  -> market snapshot direct send if a configured slot is due
  -> publish due Telegram queue items
  -> recover/skip/fail stale AI candidates
  -> drain AI candidate backlog in bounded batches
  -> cleanup old dedupe keys
```

Production intentionally keeps `APIFY_SCHEDULED_CURATION_ENABLED=false` so the Worker does not repeatedly reprocess old datasets. Freshness is normally driven by Apify task runs, source-scoped webhooks, and controlled Apify rotation.

### Current production knobs

```toml
APIFY_ROTATION_ENABLED = "true"
APIFY_ROTATION_INTERVAL_HOURS = "3"
APIFY_ROTATION_MAX_SOURCES_PER_TICK = "2"
APIFY_ROTATION_WAIT_FOR_FINISH_SECONDS = "60"

AI_CANDIDATE_BACKLOG_ENABLED = "true"
AI_FAIR_SOURCE_PICKER_ENABLED = "true"
AI_SCORING_BATCH_SIZE = "5"
AI_MAX_SCORING_BATCHES_PER_RUN = "1"
AI_CANDIDATE_BACKLOG_DRAIN_LIMIT = "10"
AI_CANDIDATE_MAX_ATTEMPTS = "2"
AI_CANDIDATE_MAX_AGE_HOURS = "12"

AI_MAX_CALLS_PER_DAY = "100"
AI_DAILY_TOKEN_BUDGET = "200000"

TELEGRAM_FINAL_PUBLISH_ENABLED = "true"
TELEGRAM_PUBLISH_SCHEDULER_ENABLED = "true"
TELEGRAM_PUBLISH_DUE_LIMIT = "4"

MEDIA_PROCESSING_MODE = "binary_upload"
STREAM_TRANSCODE_ENABLED = "false"
```

### Crypto Persian pilot channel

The current pilot channel is configured for high-frequency publishing, but it is still bounded by editorial quality, queue availability, and channel rate limits.

```text
category_id: crypto
channel_id: crypto_fa_pilot
language: fa
timezone: Asia/Tehran
allowed windows: 07:00-23:59 and 00:00-01:00
blocked window: 01:00-07:00
max_per_day: 72
max_per_hour: 4
min_gap_minutes: 15
```

This means the theoretical maximum is 72 posts/day only when enough high-quality queue items exist. If the queue runs empty for several hours, the system cannot safely publish 72 quality posts without either increasing candidate supply, improving source diversity, or changing editorial constraints.

---

## AI Candidate Backlog & Fair Source Distribution

Earlier versions treated `AI_MAX_CANDIDATES_PER_RUN` as a lossy cutoff: fresh items beyond the AI candidate limit could be fetched and normalized but never scored. The current architecture uses a durable `ai_candidate_queue` between dedupe and AI scoring.

### Why it exists

The backlog solves four production problems:

- fresh candidates are not wasted when Apify fetches more than Claude should score in one call;
- Claude prompts stay small and predictable;
- daily AI cost limits remain enforceable;
- source accounts get fairer representation instead of letting one high-volume account dominate every scoring batch.

### Backlog lifecycle

```text
Apify dataset
  -> normalize
  -> source-account balancing
  -> dedupe
  -> freshness check
  -> enqueue fresh candidates into ai_candidate_queue
  -> claim a small batch
  -> pre-AI content policy reject where possible
  -> Claude scoring only for survivors
  -> Gemini translation for selected items
  -> rule gate
  -> publish_queue insert
  -> candidate status update
```

### Candidate statuses

| Status | Meaning |
|---|---|
| `pending` | Candidate is waiting for AI scoring. |
| `scoring` | Candidate has been claimed for a scoring attempt. |
| `ai_selected` | Claude selected the item, but it may not have created a queue row yet. |
| `ai_rejected` | Item was rejected by pre-AI policy or Claude/editorial policy. |
| `queued` | At least one `publish_queue` row was created. |
| `failed` | Candidate exceeded attempts or had an unrecoverable processing error. |
| `skipped` | Candidate was intentionally skipped, usually because it became stale. |

### Fair source picker

When `AI_FAIR_SOURCE_PICKER_ENABLED=true`, the backlog drain loads a larger pending pool and selects candidates round-robin by `source_account`. This avoids scoring a batch made entirely of one account when multiple sources are available.

The picker is intentionally soft: it improves diversity without starving high-quality active sources. The final publish decision still goes through Claude scoring, semantic dedupe, rule gate, and queue limits.

### Manual drain

Use small, bounded drains in production. This endpoint is a production write because it can spend AI budget and create Telegram queue items.

```bash
curl -s -X POST "$BASE/internal/backlog/drain" \
  -H "x-internal-api-secret: $INTERNAL_API_SECRET" \
  -H "Content-Type: application/json" \
  --data '{"category_id":"crypto","limit":5,"maxBatches":1,"skipStale":true,"recoverStale":true}' | jq .
```

---

## Apify Controlled Rotation

The current crypto pilot does not rely only on static Apify schedules. It uses controlled Worker-side rotation over existing Apify task IDs and source records.

### Why rotation exists

Broad Apify queries can be expensive and noisy. They can also over-represent whichever account posts most recently. Controlled rotation reduces that failure mode by rotating account cohorts and topic gates while keeping `maxItems` intentionally small.

### Rotation source IDs

```text
src_crypto_x_news_media
src_crypto_x_news_text
src_crypto_x_voices_media
src_crypto_x_voices_text
src_market_trending_x_media
src_market_trending_x_text
```

### Main cohort families

| Family | Purpose | Typical maxItems |
|---|---:|---:|
| `core_news` | trusted crypto news accounts with explicit crypto topic gates | 18 |
| `expert_signals` | analyst/project/market voices with crypto signal gates | 16 |
| `security_alert` | hacks, exploits, phishing, bridge/security incidents | 8 |
| `token_project_watch` | listings, mainnets, token launches, upgrades, funding, protocol events | 10 |
| `market_impact` | ETF, liquidity, stablecoin, on-chain, liquidation and macro-with-crypto relevance | 10 |

### Query override fields

The Worker sends both fields to Apify task runs:

```json
{
  "query": "...",
  "twitterContent": "...",
  "maxItems": 18,
  "queryType": "Latest",
  "lang": "en",
  "since_time": "..."
}
```

Both `query` and `twitterContent` are intentionally sent because different Apify task versions/configs have used different field names. This avoids silent empty runs during task changes.

### Dry-run rotation

```bash
curl -s -X POST "$BASE/internal/apify/rotation/run" \
  -H "x-internal-api-secret: $INTERNAL_API_SECRET" \
  -H "Content-Type: application/json" \
  --data '{"force":true,"dryRun":true}' | jq .
```

### One-source real rotation

This is a production-cost action because it runs an Apify task.

```bash
curl -s -X POST "$BASE/internal/apify/rotation/run" \
  -H "x-internal-api-secret: $INTERNAL_API_SECRET" \
  -H "Content-Type: application/json" \
  --data '{"force":true,"onlySourceId":"src_crypto_x_news_text"}' | jq .
```

---

## Crypto Quality Gate & Whale Alert Throttle

The crypto pilot now has a deterministic pre-AI content policy. The purpose is to reject obvious junk before Claude scoring instead of spending model budget on posts that clearly do not belong in the channel.

### Pre-AI rejects

Before Claude scoring, crypto items can be rejected with reasons such as:

| Reject reason | Meaning |
|---|---|
| `pre_ai_empty_text` | No usable text. |
| `pre_ai_engagement_bait` | Poll/bait/prediction-style low-value post. |
| `pre_ai_generic_ai_news` | AI news without explicit crypto relevance. |
| `pre_ai_generic_equity_or_spacex` | Equity/IPO/SpaceX content without crypto relevance. |
| `pre_ai_generic_geopolitics` | Geopolitics without explicit crypto, liquidity, oil, stablecoin, ETF, or risk-asset angle. |
| `pre_ai_non_crypto` | No crypto anchor or accepted crypto-native context. |
| `pre_ai_whale_unknown_to_unknown` | Whale Alert unknown-wallet to unknown-wallet transfer. |
| `pre_ai_whale_non_core_asset` | Whale Alert asset is not BTC, ETH, USDT, or USDC. |
| `pre_ai_whale_institution_to_unknown` | Low-signal custody/institution-to-unknown movement. |
| `pre_ai_whale_low_signal` | Whale Alert transfer does not meet signal thresholds. |

### Whale Alert rules

`whale_alert` is not globally banned. Some on-chain movements are legitimate market context. The gate allows only higher-signal cases:

- USDC/USDT mint or burn at or above 100M USD;
- USDC/USDT DeFi flow at or above 100M USD;
- exchange inflow/outflow for BTC, ETH, USDC, or USDT above configured thresholds;
- core assets only: BTC, ETH, USDT, USDC.

Unknown-to-unknown transfers, non-core assets, low-value movements, and institution/custody-to-unknown flows are rejected before Claude.

### Daily queue throttle

Even valid Whale Alert items are capped at the queue layer. For each channel, if two Whale Alert items are already scheduled/retry/publishing/published in the recent daily window, additional Whale Alert candidates are not queued and are recorded with:

```text
whale_alert_daily_cap
```

This keeps the channel from becoming mostly wallet-transfer posts.

---

## Pipeline Flow

```
Apify webhook
     │
     ├─ Extract datasetId → scope to matching source only
     │
     ▼
fetchApifyDataset(datasetId)
     │
     ▼
normalizeItem() — platform-specific
     │  X:         text, media[], thumbnailUrl per video
     │  Instagram: childPosts[] → carousel, videoUrl + displayUrl thumbnail
     │  LinkedIn:  postImages[], postVideo.videoUrl + thumbnailUrl
     │  RSS:       text only
     │
     ▼
Deduplication (3 keys, configurable window)
     │  pid:{platform}:{postId}
     │  url:{hash(normalizedUrl)}
     │  txt:{hash(text[0:300])}
     │
     ▼
Freshness pre-filter  ← NEW: deterministic, before AI
     │  item.publishedAt < (now - freshness_hours * 3600) → discard
     │  Also records dedupe keys for stale items (no reprocess)
     │
     ▼
Claude Haiku — Scoring + Risk
     │  Category prompt profile OR custom_prompt from DB
     │  Returns: score, risk_level, risk_flags, publish_priority
     │  Robust JSON extraction (strips markdown fences)
     │
     ▼
Gemini / OpenAI / Claude — Translation
     │  All language_targets translated in one API call
     │  Uses channel custom_instructions if available
     │  Missing language → item flagged, not silently skipped
     │
     ▼
Rule Gate — per-channel
     │  Timezone-aware day start for daily quota
     │  Counts published + scheduled + retry items (not just published)
     │  Respects allowed_windows and blocked_windows
     │  Applies min_gap from last scheduled item in DB
     │
     ▼
publish_queue INSERT
     │  Stores: caption_short, caption_full, media_urls,
     │          thumbnail_urls, media_types, scheduled_at
     │
     ▼
Cron runs every 5 min
     │  publishDueItems()
     │  status = 'scheduled' OR 'retry', scheduled_at <= now
     │
     ▼
Media processing (mode-dependent)
     │  direct_url:    URL passed to Telegram (fast, CDN-dependent)
     │  binary_upload: Download blob → multipart/form-data upload
     │  r2_storage:    Download → R2 bucket → stable URL
     │
     ▼
Telegram Bot API
     sendPhoto / sendVideo (+ thumbnail) / sendMediaGroup (attach://)
     │
     ▼
DB UPDATE: status=published, telegram_message_id, all_message_ids
```

---

## Media Processing

Media handling is the most critical reliability concern. Three modes are available via `MEDIA_PROCESSING_MODE`.

### Mode: `direct_url` (default)

Passes CDN URLs directly to Telegram. Fast. Appropriate for Twitter/X where URLs are stable.

**Risk:** Instagram and LinkedIn CDN URLs expire within hours. If the Telegram cron runs too late, publishing fails.

### Mode: `binary_upload` ⭐ Recommended for production

Downloads each media file at publish time, then uploads as `multipart/form-data` to Telegram.

**Benefits:**
- Solves the CDN expiry problem — the binary is fetched while the URL is still valid
- Video thumbnails are uploaded as a separate `thumbnail` field
- Per-media error recovery: one broken item does not fail the entire album
- `sendMediaGroup` uses `attach://file0`, `attach://file1` binary references

**Memory note:** Files up to `MEDIA_MAX_DOWNLOAD_MB` (default 50MB) are held in Worker memory during upload. Very large videos may hit Cloudflare Worker memory limits on free plans.

### Mode: `r2_storage`

Downloads media, stores in a Cloudflare R2 bucket, then serves from a stable URL. Best for retry safety.

**Setup:**
```toml
# wrangler.toml
[[r2_buckets]]
binding = "MEDIA_BUCKET"
bucket_name = "content-curator-media"
```
```bash
wrangler r2 bucket create content-curator-media
wrangler secret put R2_PUBLIC_BASE_URL  # e.g. https://media.yourdomain.com
```

### Thumbnail support

Video thumbnails are extracted from source platforms:
- **Twitter/X:** `media_url_https` from the video entity (still frame provided by Twitter)
- **Instagram:** `displayUrl` from the same carousel child as the video
- **LinkedIn:** `postVideo.thumbnailUrl` from Apify output

Thumbnails are stored in `discovery_media.thumbnail_url` and `publish_queue.thumbnail_urls` (JSON array parallel to `media_urls`). When uploading via `binary_upload`, the thumbnail blob is attached as `thumbnail` on `sendVideo` calls.

### Per-media status tracking

`discovery_media.processing_status` tracks each media item through:

| Status | Meaning |
|--------|---------|
| `pending` | Not yet validated |
| `validating` | HEAD request in progress |
| `ready` | Validated or downloaded |
| `failed` | Download or validation failed |
| `unsupported` | MIME type not accepted by Telegram |
| `too_large` | Exceeds `MEDIA_MAX_DOWNLOAD_MB` |
| `expired` | CDN URL returned 403 or 404 |
| `uploaded` | `telegram_file_id` cached for reuse |

---

## Category & Language System

The system is fully dynamic — any number of categories and languages can be added without code changes.

### Adding a new category

**Via API:**
```bash
curl -X POST https://your-worker.workers.dev/internal/categories \
  -H "x-internal-api-secret: YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "health",
    "label": "Health & Wellness",
    "prompt_profile": "default_editorial",
    "custom_prompt": "Curate health content for a general audience. Focus on evidence-based medicine. NEVER provide medical advice. Risk flags: misinformation, pseudoscience, dangerous_advice, unverified_claims.",
    "score_threshold": 80,
    "freshness_hours": 48,
    "media_mode": "preferred",
    "language_targets": ["en", "fa", "ar", "tr"]
  }'
```

**Via SQL migration:**
```sql
INSERT INTO categories (id, label, prompt_profile, custom_prompt, score_threshold, freshness_hours, media_mode, language_targets, enabled)
VALUES ('health', 'Health', 'default_editorial', 'Your custom prompt here...', 80, 48, 'preferred', '["en","fa"]', 1);
```

If `custom_prompt` is set, it overrides `prompt_profile` entirely. This lets you create any number of categories with precise AI behavior without touching the codebase.

### Built-in prompt profiles

| Profile | Use case |
|---------|---------|
| `default_editorial` | General audience content |
| `crypto_editorial` | Crypto/blockchain — strict risk flags |
| `design_editorial` | UX/design/product teams |
| `marketing_editorial` | Growth/marketing strategy |
| `product_editorial` | Product managers and founders |
| `ai_news_editorial` | AI/ML practitioners |
| `branding_editorial` | Brand strategy — trademark/attribution safety |
| `finance_editorial` | Finance — investment advice detection, disclaimers |

### Adding a channel for a new language

```bash
curl -X POST https://your-worker.workers.dev/internal/channels \
  -H "x-internal-api-secret: YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "crypto_ar",
    "category_id": "crypto",
    "telegram_chat_id": "@YourArabicCryptoChannel",
    "language": "ar",
    "timezone": "Asia/Dubai",
    "channel_label": "كريبتو عربي",
    "custom_instructions": "Write in formal Modern Standard Arabic. Explain DeFi terms in simple language. Add a disclaimer on crypto risk at the end of each post.",
    "tone_profile": "formal",
    "allowed_windows": ["09:00-12:00", "18:00-22:00"],
    "blocked_windows": ["00:00-08:00"],
    "max_per_day": 8,
    "max_per_hour": 2,
    "min_gap_minutes": 45
  }'
```

The `custom_instructions` field is injected into the translation prompt, giving each channel its own tone, terminology, and formatting preferences.

### Supported languages

| Code | Language | Code | Language |
|------|---------|------|---------|
| `fa` | Persian (Farsi) | `ar` | Arabic |
| `en` | English | `tr` | Turkish |
| `ru` | Russian | `de` | German |
| `fr` | French | `es` | Spanish |
| `zh` | Chinese (Simplified) | `hi` | Hindi |
| `id` | Indonesian | `ko` | Korean |
| `ja` | Japanese | `pt` | Portuguese |
| `it` | Italian | `nl` | Dutch |

---

## Project Structure

```
content-curator/
├── apps/
│   ├── worker-api/
│   │   └── src/
│   │       ├── index.ts                    # Worker entry — routing, cron, maintenance mode
│   │       ├── types.ts                    # Shared TypeScript interfaces
│   │       ├── routes/
│   │       │   ├── admin.ts                # /internal/* endpoints
│   │       │   ├── apify-webhook.ts        # POST /webhook/apify
│   │       │   └── health.ts               # GET /health, /status
│   │       └── services/
│   │           ├── ai-gate.ts              # Claude scoring + Gemini/OpenAI translation
│   │           ├── apify-client.ts         # Fetch + normalize (X, Instagram, LinkedIn, RSS)
│   │           ├── curation-orchestrator.ts# Main pipeline + cron publisher
│   │           ├── dedupe.ts               # 3-key deduplication, configurable window
│   │           ├── media-processor.ts      # Download, validate, R2 store, FormData builder
│   │           ├── media-resolver.ts       # Method selection (sendPhoto/sendVideo/sendMediaGroup)
│   │           ├── rule-gate.ts            # Timezone-aware scheduling + window enforcement
│   │           └── telegram-publisher.ts   # Telegram Bot API (JSON + binary multipart)
│   └── dashboard/
│       ├── index.html                      # Admin dashboard SPA
│       └── config.js                       # Dashboard configuration
├── migrations/
│   ├── 0001_core.sql                       # Schema: all core tables
│   ├── 0002_seed_categories.sql            # Seed: crypto, design, marketing, product, ai_news
│   ├── 0003_branding_finance.sql           # Seed: branding, finance categories
│   ├── 0004_media_processing.sql           # Alter: media lifecycle, category/channel extensions
│   └── 0005_thumbnail_urls.sql             # Alter: thumbnail_urls in publish_queue
├── wrangler.toml                           # Cloudflare config + all env vars
├── package.json
└── tsconfig.json
```


### Current important Worker services

The original structure above is still accurate, but production now relies on several additional services that are important enough to call out explicitly.

| File | Purpose |
|---|---|
| `apps/worker-api/src/services/candidate-queue.ts` | Durable AI candidate backlog, status transitions, stale recovery, max attempts, backlog stats. |
| `apps/worker-api/src/services/backlog-drain.ts` | Bounded backlog scoring, pre-AI policy filtering, translation, rule gate, queue creation. |
| `apps/worker-api/src/services/fair-source-picker.ts` | Round-robin source-account candidate selection for AI scoring diversity. |
| `apps/worker-api/src/services/apify-rotation-runner.ts` | Worker-side controlled Apify task rotation, cohort planning, query overrides, rotation bucket claiming. |
| `apps/worker-api/src/services/content-policy.ts` | Editorial reject policy, crypto pre-AI filter, semantic/run-level duplicate rejection, Whale Alert rules. |
| `apps/worker-api/src/services/story-dedupe.ts` | Recent story/topic dedupe for channels using topic fingerprints. |
| `apps/worker-api/src/services/market-snapshot.ts` | Direct market snapshot publishing for configured slots. |
| `apps/worker-api/src/services/operational-report.ts` | Read-only operational reporting. |
| `apps/worker-api/src/routes/telegram-admin-bot.ts` | Telegram admin bot webhook route, protected separately from public health endpoints. |

### Current migration line

The early migration list above documents the initial schema. The current repository has later migrations for media observability, Apify extraction diagnostics, AI usage, formatting/editorial controls, Apify task binding, AI candidate backlog, market-trending sources, and production hardening.

Do not edit already-applied migrations. Add a new numbered migration for future schema changes and verify remote D1 before applying it.

---

## Tech Stack & Cost

| Component | Service | Pricing |
|-----------|---------|---------|
| Runtime | Cloudflare Workers | Free (100K req/day) |
| Database | Cloudflare D1 (SQLite) | Free (<5GB) |
| Media storage | Cloudflare R2 (optional) | Free (<10GB) |
| Dashboard | Cloudflare Pages / static | Free |
| Content scraping | Apify | ~$15–32/month (see below) |
| AI scoring | Claude Haiku | ~$3/month |
| AI translation | Gemini Flash-Lite | ~$2/month |
| Publishing | Telegram Bot API | Free |

---

## Prerequisites

- Node.js 22+, npm
- Cloudflare account (free tier is sufficient)
- Wrangler CLI: `npm install -g wrangler`
- Apify account with API token
- Anthropic API key
- Google Gemini API key (or OpenAI as alternative)
- Telegram bot token + channel admin rights

---

## Setup Guide

### 1. Install and authenticate

```bash
git clone https://github.com/your-org/content-curator.git
cd content-curator
pnpm install
wrangler login
```

### 2. Create the D1 database

```bash
wrangler d1 create content-curator-db-v2
# Copy the database_id from output
```

Update `wrangler.toml`:
```toml
[[d1_databases]]
binding = "DB"
database_name = "content-curator-db-v2"
database_id = "YOUR_ACTUAL_DATABASE_ID"
```

### 3. Run migrations

```bash
# Local test
wrangler d1 migrations apply content-curator-db-v2 --local

# Remote production
wrangler d1 migrations apply content-curator-db-v2 --remote
```

Verify:
```bash
wrangler d1 execute content-curator-db-v2 --command "SELECT name FROM sqlite_master WHERE type='table'" --remote
# Expected: 10 tables including discovery_media, publish_queue, etc.
```

### 4. Configure secrets

```bash
# Required
wrangler secret put ANTHROPIC_API_KEY     # Claude API key
wrangler secret put APIFY_TOKEN           # Apify API token
wrangler secret put TELEGRAM_BOT_TOKEN    # From @BotFather
wrangler secret put INTERNAL_API_SECRET   # Min 32 chars: openssl rand -hex 32

# Translation — choose ONE:
wrangler secret put GEMINI_API_KEY        # Recommended (cheapest)
# OR
wrangler secret put OPENAI_API_KEY        # Alternative

# Optional — for R2 storage mode
wrangler secret put R2_PUBLIC_BASE_URL    # https://media.yourdomain.com
```

### 5. Deploy

```bash
wrangler deploy --env production
```

Verify:
```bash
curl https://your-worker.workers.dev/health
# {"ok":true,"status":"healthy","db":"connected","environment":"production"}
```

### 6. Create Telegram bot and channels

```
1. Open @BotFather in Telegram
2. /newbot → enter name and username
3. Copy the token → wrangler secret put TELEGRAM_BOT_TOKEN

4. For each channel:
   - Create the channel in Telegram
   - Add your bot as Admin with "Post Messages" permission
   - Get the chat ID:
     curl "https://api.telegram.org/bot{TOKEN}/getUpdates"
     # Send any message to the channel first, then look for "chat": {"id": -1001234567890}
```

### 7. Register channels and sources via API

```bash
BASE="https://your-worker.workers.dev"
AUTH="x-internal-api-secret: YOUR_SECRET"

# Register a channel
curl -X POST $BASE/internal/channels -H "$AUTH" -H "Content-Type: application/json" -d '{
  "id": "crypto_fa",
  "category_id": "crypto",
  "telegram_chat_id": "@YourCryptoChannelFa",
  "language": "fa",
  "timezone": "Asia/Tehran",
  "allowed_windows": ["09:00-13:00", "17:00-22:30"],
  "blocked_windows": ["00:00-08:00"],
  "max_per_day": 10,
  "max_per_hour": 2,
  "min_gap_minutes": 30
}'

# Register an Apify source
curl -X POST $BASE/internal/apify-sources -H "$AUTH" -H "Content-Type: application/json" -d '{
  "category_id": "crypto",
  "platform": "x",
  "apify_dataset_id": "YOUR_APIFY_DATASET_ID",
  "label": "crypto-twitter"
}'
```

### 8. Enable publishing

```bash
# Enable step by step — test each stage before proceeding

# Stage 1: dry run (score but don't queue)
curl -X POST $BASE/internal/admin/toggle -H "$AUTH" -d '{"key":"apify_curation_enabled","value":"true"}'
# Wait for webhook, check /internal/items?status=ai_selected

# Stage 2: enable queue
curl -X POST $BASE/internal/admin/toggle -H "$AUTH" -d '{"key":"apify_curation_dry_run","value":"false"}'
# Check /internal/queue?status=scheduled

# Stage 3: enable scheduler (cron publishes)
curl -X POST $BASE/internal/admin/toggle -H "$AUTH" -d '{"key":"telegram_publish_enabled","value":"true"}'
# Also set TELEGRAM_PUBLISH_SCHEDULER_ENABLED=true in wrangler.toml and redeploy

# Stage 4: enable publishing per channel
curl -X POST $BASE/internal/channels/crypto_fa/publish -H "$AUTH" -d '{"enabled":true}'
```

---

## Configuration Reference

### wrangler.toml variables

| Variable | Default | Description |
|----------|---------|-------------|
| `APIFY_CURATION_ENABLED` | `false` | Enable the entire curation pipeline |
| `APIFY_CURATION_DRY_RUN` | `true` | Score + reject/select but do not insert into queue |
| `APIFY_MAX_ITEMS_PER_SOURCE` | `100` | Items fetched per Apify dataset per run |
| `APIFY_RAW_FETCH_LIMIT_PER_SOURCE` | unset | Raw rows fetched before balancing and final source limit. Production uses `300`. |
| `APIFY_ROTATION_ENABLED` | `false` | Enables Worker-side controlled Apify task rotation. |
| `APIFY_ROTATION_INTERVAL_HOURS` | `3` | Rotation bucket width. Production uses 3 hours. |
| `APIFY_ROTATION_MAX_SOURCES_PER_TICK` | `2` | Max Apify source tasks the cron may start per tick. |
| `APIFY_ROTATION_WAIT_FOR_FINISH_SECONDS` | `60` | Wait time passed to Apify task run API. |
| `AI_SCORING_MODEL` | `claude-haiku-4-5-20251001` | Claude model for scoring |
| `AI_SCORE_THRESHOLD_DEFAULT` | `75` | Minimum score to select (0–100) |
| `AI_MAX_CALLS_PER_DAY` | `10` | Claude API calls per day (tracked, not yet hard-enforced) |
| `AI_DAILY_TOKEN_BUDGET` | `50000` | Claude token budget per day |
| `AI_MAX_CANDIDATES_PER_RUN` | `50` | Items sent to Claude per pipeline run |
| `AI_CANDIDATE_BACKLOG_ENABLED` | `false` | Enables durable `ai_candidate_queue` flow. Production crypto uses `true`. |
| `AI_FAIR_SOURCE_PICKER_ENABLED` | `false` | Enables round-robin source-account selection for scoring batches. |
| `AI_SCORING_BATCH_SIZE` | `10` | Claude scoring batch size when backlog is enabled. Production uses `5`. |
| `AI_MAX_SCORING_BATCHES_PER_RUN` | `1` | Max backlog scoring batches per Worker execution. |
| `AI_CANDIDATE_BACKLOG_DRAIN_LIMIT` | `10` | Upper bound for candidates drained per execution. |
| `AI_CANDIDATE_MAX_ATTEMPTS` | `2` | Max scoring attempts before candidate failure. |
| `AI_CANDIDATE_MAX_AGE_HOURS` | `12` | Max backlog age before stale skip. |
| `AI_MAX_TEXT_CHARS_PER_ITEM` | `400` | Text chars sent to AI per item |
| `AI_MAX_RETRIES` | `1` | Retry count for AI API calls |
| `TRANSLATION_PROVIDER` | `gemini` | `gemini` \| `openai` \| `claude` |
| `TRANSLATION_MODEL` | `gemini-2.5-flash-lite` | Translation model |
| `TELEGRAM_FINAL_PUBLISH_ENABLED` | `false` | Actually send messages to Telegram |
| `TELEGRAM_PUBLISH_SCHEDULER_ENABLED` | `false` | Cron-based publish (must also be true in settings table) |
| `TELEGRAM_PUBLISH_DUE_LIMIT` | `5` | Items to attempt per cron run |
| `MEDIA_PROCESSING_MODE` | `direct_url` | `direct_url` \| `binary_upload` \| `r2_storage` |
| `MEDIA_MAX_DOWNLOAD_MB` | `50` | Max file size to download (MB) |
| `MEDIA_DOWNLOAD_TIMEOUT_SEC` | `60` | Download timeout per media file |
| `DEDUPE_WINDOW_HOURS` | `168` | Deduplication lookback window (7 days) |
| `MARKET_SNAPSHOT_ENABLED` | `false` | Enables direct market snapshot publishing. |
| `MARKET_SNAPSHOT_INTERVAL_HOURS` | `1` | Snapshot cadence guard. |
| `MARKET_SNAPSHOT_SLOTS` | unset | Local-time snapshot slots, e.g. `09:05,12:35,15:35,18:35,21:35`. |
| `MARKET_SNAPSHOT_CHANNEL_ID` | unset | Channel receiving snapshot posts. |

### Secrets (set with `wrangler secret put`)

| Secret | Required | Description |
|--------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key for scoring |
| `GEMINI_API_KEY` | If provider=gemini | Google Gemini API key |
| `OPENAI_API_KEY` | If provider=openai | OpenAI API key |
| `APIFY_TOKEN` | Yes | Apify API token |
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `INTERNAL_API_SECRET` | Yes | Admin auth secret (≥32 chars) |
| `R2_PUBLIC_BASE_URL` | If r2_storage | Public base URL for R2 bucket |

### Database tables

| Table | Purpose |
|-------|---------|
| `categories` | Category definitions: id, prompt_profile, custom_prompt, threshold, languages |
| `channels` | Telegram channels: language, timezone, rate limits, time windows, custom_instructions |
| `source_accounts` | Whitelisted social accounts (trust level used in AI scoring) |
| `apify_sources` | Dataset ID → category/platform mapping |
| `discovery_runs` | Log of each pipeline run with metrics |
| `discovery_items` | Individual posts after AI scoring |
| `discovery_media` | Media URLs with processing status, thumbnail, telegram_file_id |
| `dedupe_keys` | Configurable deduplication window |
| `publish_queue` | Scheduled posts: captions, media_urls, thumbnail_urls, status |
| `ai_candidate_queue` | Durable backlog between dedupe and Claude scoring. |
| `run_events` | Phase-level operational events and diagnostics. |
| `run_item_events` | Item-level diagnostics, reject reasons, queue creation events. |
| `ai_usage` | Provider/model/purpose token and call usage. |
| `settings` | Runtime toggles that override env vars |

---

## Apify Actors

### Production note: static actors plus controlled rotation

The original actor notes below are still useful for platform schema and cost expectations. The production crypto pilot also uses Worker-side controlled rotation through existing Apify task IDs. Rotation does not replace Apify; it controls which account cohorts and topic gates are passed to the Apify tasks on each 3-hour bucket.

For crypto X/Twitter sources, prefer source-scoped webhooks:

```text
POST /webhook/apify?source_id=src_crypto_x_news_text
x-webhook-secret: YOUR_INTERNAL_API_SECRET
```

The generic dataset-matching webhook still works, but `source_id` is safer for experiments and rotating sources because it avoids ambiguous dataset matching.

### Twitter/X — `kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest`

**Price:** ~$0.25 / 1,000 tweets

**Input:**
```json
{
  "twitterHandles": ["handle1", "handle2"],
  "maxItems": 30,
  "addUserInfo": false
}
```

**Key fields extracted:**
```
url / twitterUrl              → post URL
text / full_text              → tweet text
author.userName               → handle
createdAt                     → timestamp (ISO)
likeCount, retweetCount, viewCount → engagement
media[].type                  → photo | video | animated_gif
media[].media_url_https       → image URL
video_info.variants[].url     → MP4 variants (highest bitrate selected)
media_url_https               → thumbnail for video type
```

> Videos: The system picks the highest-bitrate non-DASH MP4 variant. `media_url_https` is used as thumbnail.

**Recommended schedule:** `0 */6 * * *` (every 6 hours)

---

### Instagram — `apify/instagram-post-scraper`

**Price:** ~$1.70 / 1,000 posts

**Input:**
```json
{
  "directUrls": ["https://www.instagram.com/username/"],
  "resultsLimit": 10
}
```

**Key fields extracted:**
```
url                           → post URL
shortCode / id                → post ID
displayUrl                    → image URL or video thumbnail (⚠ EXPIRES)
videoUrl                      → Reel URL (⚠ EXPIRES in hours)
childPosts[].displayUrl       → carousel images
childPosts[].videoUrl         → carousel videos
childPosts[].thumbnailUrl     → carousel video thumbnails
caption                       → post text
ownerUsername                 → handle
timestamp                     → ISO timestamp
likesCount, videoViewCount    → engagement
```

> **CDN Expiry:** Instagram URLs expire within a few hours to 2 days. The system sets `mediaUrlExpiresSoon=true` and schedules immediate publishing. Use `binary_upload` mode in production to download the binary before it expires.

**Recommended schedule:** `0 10 * * *` (once daily)

---

### LinkedIn — `harvestapi/linkedin-profile-posts`

**Price:** ~$2.00 / 1,000 posts

**Input:**
```json
{
  "profileUrls": ["https://www.linkedin.com/in/username"],
  "maxPostsPerProfile": 5,
  "scrapeReactions": false,
  "scrapeComments": false
}
```

**Key fields extracted:**
```
linkedinUrl                   → post URL
content / text                → post text
author.publicIdentifier       → handle
postedAt.timestamp            → ms timestamp (÷1000 for unix)
postImages[].url              → image URL (⚠ expires)
postImages[].width/height     → dimensions
postVideo.videoUrl            → video URL (⚠ expires)
postVideo.thumbnailUrl        → video thumbnail URL
document.coverPages[].imageUrls → PDF carousel cover images
engagement.likes/shares       → metrics
```

**Recommended schedule:** `0 10 * * 1,4` (Monday and Thursday)

---

### Setting up Apify webhooks

For each Apify actor run that should trigger curation automatically:

```
1. Open your Actor task in Apify console
2. Navigate to: Integrations → Webhooks → Add webhook
3. Event type: ACTOR.RUN.SUCCEEDED
4. Webhook URL: https://your-worker.workers.dev/webhook/apify
5. Headers: x-webhook-secret: YOUR_INTERNAL_API_SECRET
   (safer than query param — avoids secret in server logs)
6. Payload template (default is fine, system reads datasetId automatically)
```

The webhook is scoped: only the Apify source whose `apify_dataset_id` matches the incoming `datasetId` is processed. Other sources are not triggered.

---

## Telegram Bot & Channels

### Bot setup

```
1. Open @BotFather in Telegram → /newbot
2. Choose name and username
3. Copy token → wrangler secret put TELEGRAM_BOT_TOKEN
4. Add bot as Admin to each channel:
   Channel → Settings → Administrators → Add Administrator → your_bot
   Required permission: Post Messages
5. Get channel chat ID:
   curl "https://api.telegram.org/bot{TOKEN}/getUpdates"
   Post a message to the channel first, then find: "chat": {"id": -1001234567890}
```

### Telegram send methods

| Method | Used when | Media type |
|--------|-----------|-----------|
| `sendMessage` | No media, or media disabled | Text only |
| `sendPhoto` | Single image | Binary blob or URL |
| `sendVideo` | Single video | Binary blob + thumbnail blob |
| `sendMediaGroup` | 2–10 images/videos | Binary `attach://` references |

### Caption limits

| Context | Limit |
|---------|-------|
| Media caption (sendPhoto, sendVideo, first item in group) | 1,024 chars |
| Standalone text message | 4,096 chars |
| Generated `caption_short` in DB | ≤900 chars |
| Generated `caption_full` in DB | ≤3,500 chars |

When `caption_full` exceeds 1,024 chars, the system sends the media group first, then a separate text message with the full caption. A failure of the second message is recorded in `publish_error` but does not mark the item as failed.

All AI-generated captions are HTML-escaped before sending (`&`, `<`, `>` → `&amp;`, `&lt;`, `&gt;`). Truncation uses `safeTruncate()` which avoids cutting inside HTML entities.

---

## AI Models & Cost

### Scoring — Claude Haiku (`claude-haiku-4-5-20251001`)

Used for: scoring, risk assessment, publish priority.
Not used for: translation (3× more expensive per output token).

**Approximate cost:** ~$0.25 per 1M input tokens, ~$1.25 per 1M output tokens.
Per run (50 items): ~$0.005–$0.02.

**Score threshold by category:**

| Category | Recommended threshold | Freshness |
|----------|-----------------------|-----------|
| crypto | 80 | 24h |
| finance | 80 | 24h |
| ai_news | 75 | 48h |
| marketing | 75 | 72h |
| product | 75 | 72h |
| branding | 75 | 72h |
| design | 70 | 168h (7 days) |

### Translation — Gemini Flash-Lite (recommended)

`gemini-2.5-flash-lite`: $0.10 input / $0.40 output per 1M tokens.

Alternatives:
- `gemini-2.5-flash`: Better quality, ~6× more expensive
- `gpt-4.1-nano`: Similar price to Flash-Lite
- `gpt-4o-mini`: Slightly better quality, ~4× more expensive
- `claude-haiku-4-5-20251001`: Highest quality, ~10× more expensive

Change model without code:
```toml
# wrangler.toml
TRANSLATION_MODEL = "gemini-2.5-flash"  # upgrade quality
```

### Category-level score override

```bash
# Lower threshold temporarily for a quiet category
curl -X PATCH .../internal/categories/design \
  -H "x-internal-api-secret: SECRET" \
  -d '{"score_threshold": 60}'
```

---

## Scheduling & Time Windows

Each channel enforces its own timezone-aware schedule.

### Time window enforcement

`allowed_windows` defines when posts may be scheduled. `blocked_windows` defines when they must not.

```json
"allowed_windows": ["09:00-13:00", "17:00-22:30"]
"blocked_windows": ["00:00-08:00", "23:00-23:59"]
```

**Behavior:** If the computed `scheduled_at` falls outside an allowed window, it is pushed to the start of the next window. If it falls inside a blocked window, it is pushed past the end of that window. The search continues up to 7 days forward.

### Daily quota

Counts both `published` and `scheduled/retry/publishing` items for the current channel-local day. This prevents over-scheduling even if items haven't been published yet.

### Current crypto_fa_pilot capacity math

For `crypto_fa_pilot`, the current production target is up to 72 posts/day. With `max_per_hour=4` and `min_gap_minutes=15`, the channel can publish at most four items per hour. With the active publishing windows, this is close to the theoretical daily ceiling.

Operationally, that means the queue must stay ahead of the scheduler. If the system needs 72 posts/day, it should normally create roughly 12 usable queue items per active 3-hour rotation window. If it consistently creates fewer, increase candidate supply or tune source/query quality before loosening editorial filters.

### Publish priority → delay mapping

| Priority | Normal content | Expiring media |
|----------|---------------|----------------|
| `breaking` | +5 minutes | +5 minutes |
| `high` | +1 hour | +20 minutes |
| `normal` | +2 hours | +1 hour |
| `low` | +6 hours | +1 hour |

### min_gap enforcement

At schedule creation time, the system reads `MAX(scheduled_at)` for the channel from existing scheduled items and ensures the new item is at least `min_gap_minutes` after that.

### Cron granularity limitation

The cron runs every 5 minutes. Breaking content scheduled for "+5 minutes" should normally be attempted on the next cron tick, subject to channel rate limits and Telegram availability. For time-sensitive content (expiring Instagram/LinkedIn), use `binary_upload` mode and set `min_gap_minutes ≤ 15`.


---

## Market Snapshot

Market snapshots are direct Telegram sends rather than normal `publish_queue` items. They are useful for predictable market-context posts at configured times.

Production configuration:

```toml
MARKET_SNAPSHOT_ENABLED = "true"
MARKET_SNAPSHOT_INTERVAL_HOURS = "1"
MARKET_SNAPSHOT_SLOTS = "09:05,12:35,15:35,18:35,21:35"
MARKET_SNAPSHOT_CHANNEL_ID = "crypto_fa_pilot"
```

Preview without publishing:

```bash
curl -s "$BASE/internal/market-snapshot/preview" \
  -H "x-internal-api-secret: $INTERNAL_API_SECRET" | jq .
```

Send now. This is a production write and can publish to Telegram:

```bash
curl -s -X POST "$BASE/internal/market-snapshot/send-now" \
  -H "x-internal-api-secret: $INTERNAL_API_SECRET" \
  -H "Content-Type: application/json" \
  --data '{"channel_id":"crypto_fa_pilot","force":true}' | jq .
```

---

## Operational Runbook

### Health check

```bash
curl -s "$BASE/health" | jq .
```

Expected production shape:

```json
{"ok":true,"status":"healthy","db":"connected","environment":"production"}
```

### Backlog and AI budget snapshot

```bash
curl -s "$BASE/internal/backlog/stats" \
  -H "x-internal-api-secret: $INTERNAL_API_SECRET" \
| jq '.ai_budget,.status_counts,.top_pending_accounts'
```

Watch these fields together:

| Field | Meaning |
|---|---|
| `calls_today` | Successful Claude scoring calls in the last day. |
| `tokens_today` | Successful Claude scoring tokens in the last day. |
| `tokens_remaining` | Remaining scoring budget before backlog drain stops. |
| `pending` | Backlog candidates waiting for scoring. |
| `queued` | Candidates that created queue items. |
| `ai_rejected` | Candidates rejected by pre-AI or AI/editorial policy. |

### Scheduled queue snapshot

```bash
curl -s "$BASE/internal/queue?status=scheduled&channel=crypto_fa_pilot&limit=50" \
  -H "x-internal-api-secret: $INTERNAL_API_SECRET" \
| jq '.queue[] | {id,source_url,caption_short,scheduled_at,status}'
```

### Publish due manually

This is a production write. It respects final publish locks and channel rate limits.

```bash
curl -s -X POST "$BASE/internal/publish/due" \
  -H "x-internal-api-secret: $INTERNAL_API_SECRET" \
  -H "Content-Type: application/json" \
  --data '{"limit":1}' | jq .
```

### Preview one queue item

```bash
QID="q_example"

curl -s "$BASE/internal/queue/$QID/preview" \
  -H "x-internal-api-secret: $INTERNAL_API_SECRET" | jq .
```

### Publish one queue item now

This bypasses scheduled time, but it still respects publishing locks and channel rate limits by default.

```bash
curl -s -X POST "$BASE/internal/queue/$QID/publish-now" \
  -H "x-internal-api-secret: $INTERNAL_API_SECRET" | jq .
```

If the response has `reason: rate_limit_min_gap`, the system is behaving correctly. Wait for the natural scheduler window.

### Crypto pipeline debug snapshot

```bash
curl -s "$BASE/internal/debug/crypto-pipeline" \
  -H "x-internal-api-secret: $INTERNAL_API_SECRET" \
| jq '.runtime_config,.channel,.queue_counts,.recent_runs[0:8]'
```

### Ops report

```bash
curl -s "$BASE/internal/report/ops?hours=24&category=crypto" \
  -H "x-internal-api-secret: $INTERNAL_API_SECRET" | jq .
```

Telegram-ready preview:

```bash
curl -s "$BASE/internal/report/ops/telegram-preview?hours=24&category=crypto" \
  -H "x-internal-api-secret: $INTERNAL_API_SECRET" | jq .
```

### 72-post/day monitoring

For the crypto Persian pilot, watch these ratios every few hours:

```text
scheduled + published today >= pace needed for 72/day
new_items / fetched
queued / fetched
AI_tokens / queued
published / queued
Whale Alert items per day <= 2
```

If queue depth is low:

1. Check Apify rotation runs and dataset freshness.
2. Check duplicate rate. High duplicates mean scrape volume is being wasted.
3. Check pending backlog. High pending with low budget means AI budget/batch tuning is the bottleneck.
4. Check `ai_rejected` reasons. Too many pre-AI rejects means source/query quality is bad, not that Claude is broken.
5. Tune source cohorts/queries before raising `maxItems` or loosening editorial filters.

### Production write warnings

These actions can spend money, publish posts, or change production state:

- `/internal/apify/rotation/run` without `dryRun:true`
- `/internal/backlog/drain`
- `/internal/publish/due`
- `/internal/queue/:id/publish-now`
- `/internal/market-snapshot/send-now`
- D1 `UPDATE` statements against `publish_queue`, `ai_usage`, `settings`, `channels`, or `apify_sources`
- `wrangler deploy --env production`

Do not paste secrets into chat or logs. For local checks, load `.dev.vars.production` privately and only verify presence/length, not the value.

---

## Documentation Consolidation & Cleanup

The repository has accumulated several `.md` files from phased implementation and rollout planning. The README should be the durable source of truth for architecture, setup, API, operations, and troubleshooting.

### Keep

| File | Why |
|---|---|
| `README.md` | Main architecture, setup, API, operations, and production reference. |
| `RELEASE_CHECKLIST.md` | Final deployment checklist and production safety gate. |

### Candidates to consolidate into README, then delete in a separate cleanup commit

| File | Reason |
|---|---|
| `docs/ai-candidate-backlog-and-fair-source-distribution.md` | Useful historically, but much of it describes a draft plan that is now implemented and active in production. The durable parts are now covered by the AI Candidate Backlog section. |
| `docs/market-trending-source-rollout.md` | Useful rollout context, but the source model has evolved into text/media market-trending sources and controlled rotation. Durable parts are now covered by Apify Controlled Rotation and Operational Runbook. |
| `RELEASE_NOTES_NEXT.md` | Release notes for a rollout that has effectively happened. Keep only if archival release notes are needed; otherwise consolidate durable notes into README and remove the stale “next” file. |

Cleanup should be a separate commit after README review so documentation deletion does not hide content changes in one giant diff.

---

## Dashboard

The built-in dashboard at `/dashboard/index.html` provides:

- **Setup Wizard:** Step-by-step guided configuration
- **Live stats:** Runs, items, queue status, published count
- **Category management:** Edit thresholds, languages, media mode
- **Channel management:** Toggle publish, edit rate limits and windows
- **Source management:** Add/remove Apify dataset sources
- **Queue inspection:** View scheduled, failed, retry items. Cancel or retry individual items.
- **Settings toggles:** Flip maintenance mode, dry run, publish enable in one click

Access: open `apps/dashboard/index.html` in a browser and enter your worker URL and secret.

---

## API Reference

All `/internal/*` endpoints require: `x-internal-api-secret: YOUR_SECRET`

### Public

```
GET  /health          → {ok, status, db, environment, timestamp}
GET  /status          → {ok, categories, channels, queue_pending}
POST /webhook/apify   → receives Apify webhook (header: x-webhook-secret)
```

### Monitoring

```
GET /internal/stats
→ {categories, channels, queue_pending, queue_retry, queue_failed, published_24h, items_today, last_run}

GET /internal/runs?category=crypto&limit=20
GET /internal/items?status=ai_selected&category=crypto&platform=x&limit=50
GET /internal/queue?status=scheduled&channel=crypto_fa&limit=50
GET /internal/backlog/stats
POST /internal/backlog/drain
GET /internal/debug/crypto-pipeline
GET /internal/report/ops?hours=24&category=crypto
GET /internal/report/ops/telegram-preview?hours=24&category=crypto
GET /internal/report/daily?hours=24&category=crypto
GET /internal/report/market-trending?hours=24
GET /internal/media?item=ITEM_ID
GET /internal/debug/runs/:runId/events
GET /internal/debug/runs/:runId/items
```

**Item statuses:** `ai_selected`, `ai_rejected`, `queued`, `duplicate`, `error`
**Queue statuses:** `scheduled`, `publishing`, `published`, `failed`, `retry`, `cancelled`

### Queue control

```
DELETE /internal/queue/:id
→ Cancels a scheduled, retry, or failed item

POST /internal/queue/:id/retry
→ Resets a failed/retry item back to scheduled (retry_count=0, scheduled_at=now+60s)
```

### Control

```
POST /internal/curation/trigger
Body: {"dryRun": true, "force": true}

POST /internal/apify/rotation/run
Body: {"force": true, "dryRun": true, "onlySourceId": "src_crypto_x_news_text"}

POST /internal/market-snapshot/send-now
Body: {"channel_id":"crypto_fa_pilot","force":true}

GET /internal/market-snapshot/preview

POST /internal/admin/toggle
Body: {"key": "telegram_publish_enabled", "value": "true"}

GET  /internal/admin/settings
→ All current runtime setting values
```

**Toggle keys:** `telegram_publish_enabled`, `apify_curation_enabled`, `apify_curation_dry_run`, `maintenance_mode`

### Categories

```
GET    /internal/categories
POST   /internal/categories
       Body: {id, label, prompt_profile, custom_prompt?, score_threshold, freshness_hours, media_mode, language_targets}
PATCH  /internal/categories/:id
       Body: {score_threshold?, freshness_hours?, media_mode?, language_targets?, enabled?, prompt_profile?, custom_prompt?}
```

### Channels

```
GET    /internal/channels?category=crypto
POST   /internal/channels
       Body: {id, category_id, telegram_chat_id, language, timezone, max_per_day, max_per_hour,
              min_gap_minutes, allowed_windows, blocked_windows, custom_instructions?, tone_profile?, channel_label?}
PATCH  /internal/channels/:id
POST   /internal/channels/:id/publish
       Body: {"enabled": true}
```

### Sources & Accounts

```
GET    /internal/source-accounts?category=crypto
POST   /internal/source-accounts
       Body: {category_id, platform, account_handle, display_name?, trust_level}
DELETE /internal/source-accounts/:id

GET    /internal/apify-sources
POST   /internal/apify-sources
       Body: {category_id, platform, apify_dataset_id, label?}
DELETE /internal/apify-sources/:id
```

---

## Safety Switches

The system has multiple independent safety layers. Disable any one of them to stop that part of the pipeline.

```
APIFY_CURATION_ENABLED = false          → entire pipeline off (env var)
APIFY_CURATION_DRY_RUN = true           → score but don't queue (env var or settings table)
TELEGRAM_FINAL_PUBLISH_ENABLED = false  → don't call Telegram API (env var or settings table)
TELEGRAM_PUBLISH_SCHEDULER_ENABLED = false  → cron doesn't publish (env var)
channels.publish_enabled = 0            → per-channel pause (DB)
channels.enabled = 0                    → channel removed from all pipelines (DB)
maintenance_mode = true                 → blocks all non-health endpoints + cron (settings table)
AI_CANDIDATE_BACKLOG_ENABLED = false     → disables durable candidate backlog and backlog drain
APIFY_ROTATION_ENABLED = false           → stops Worker-side Apify task rotation
MARKET_SNAPSHOT_ENABLED = false          → stops scheduled market snapshots
STREAM_TRANSCODE_ENABLED = false         → prevents paid Cloudflare Stream fallback calls
```

**Emergency stop (via API):**
```bash
# Stop all publishing immediately
curl -X POST .../internal/admin/toggle \
  -H "x-internal-api-secret: SECRET" \
  -d '{"key": "maintenance_mode", "value": "true"}'

# Stop only Telegram sending (keeps queueing)
curl -X POST .../internal/admin/toggle \
  -H "x-internal-api-secret: SECRET" \
  -d '{"key": "telegram_publish_enabled", "value": "false"}'

# Stop only curation (keeps publishing queue)
curl -X POST .../internal/admin/toggle \
  -H "x-internal-api-secret: SECRET" \
  -d '{"key": "apify_curation_enabled", "value": "false"}'
```

**Precedence:** env var `TELEGRAM_FINAL_PUBLISH_ENABLED=false` takes priority over the `telegram_publish_enabled` settings table value. Both must be `true` for publishing to occur.

---

## Security

### Endpoint protection

| Endpoint | Protection |
|----------|-----------|
| `/health`, `/status` | Public — no sensitive data exposed |
| `/webhook/apify` | `x-webhook-secret` header (preferred) or `?secret=` query param |
| `/internal/*` | `x-internal-api-secret` header — required |
| Dashboard | Same `INTERNAL_API_SECRET` in browser localStorage |

**Note on query-param secret:** Using `?secret=YOUR_SECRET` in the webhook URL is supported for Apify compatibility but is less secure — query params appear in server logs and URLs may be shared. Prefer the `x-webhook-secret` header.

### What is never exposed

- API keys stored only in Cloudflare encrypted secrets (never in code)
- `/health` returns only: ok, db status, environment, timestamp
- Admin routes return generic `"internal_server_error"` to clients (details in Worker logs)
- Telegram bot token is redacted from all error messages
- `caption_full` is excluded from queue list responses

### Input validation

All admin endpoints validate:
- IDs: `/^[\w-]{1,64}$/`
- Platform: whitelist `['x', 'instagram', 'linkedin', 'rss']`
- Telegram chat ID: must start with `@` or `-`
- Language codes: `/^[a-z]{2}$/`
- Time windows: `/^\d{2}:\d{2}-\d{2}:\d{2}$/`
- Score threshold: clamped 0–100
- All SQL uses parameterized queries (no string interpolation)

---

## GitHub Actions

### CI (`ci.yml`) — runs on PR and push to main/dev

```yaml
Steps:
  1. Checkout
  2. Setup Node 22 + npm
  3. pnpm install --frozen-lockfile
  4. pnpm typecheck          ← TypeScript must compile cleanly
  5. wrangler deploy --dry-run  ← Build must succeed
  6. Secret scan             ← Regex check: no API keys in source
```

**Required:** `CLOUDFLARE_API_TOKEN` GitHub secret

### Deploy (`deploy-cloudflare.yml`) — manual trigger only

```yaml
Trigger: workflow_dispatch → input: environment (production)

Steps:
  1. Checkout + install
  2. pnpm typecheck
  3. wrangler deploy --env production
  4. Health check: curl WORKER_URL/health → must return 200
```

**Required GitHub secrets:** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
**Required GitHub variable:** `WORKER_URL`

---

## Implementation Phases & Validation History

This section consolidates the previously separate phase documents into the main README so setup, validation, operational history, and release-readiness notes stay in one place.

The phased work intentionally followed a low-risk sequence: first add tests and guardrails, then fix scheduling, publisher reliability, R2 behavior, thumbnail validation, media observability, Apify normalization, AI prompt wiring, optional Stream fallback hardening, AI cost guardrails, and final end-to-end validation.

### Phase 0 — Baseline

This phase adds a test and validation baseline without changing the Worker runtime behavior.

#### What changed

- Added Vitest coverage for media resolution, media processing forms, Apify normalization, rule gate basics, Telegram publisher behavior, and video blob analysis.
- Added Apify fixture objects for Twitter/X video, Instagram carousel/reel, LinkedIn video, and LinkedIn document posts.
- Added `npm run validate`, which runs typecheck, tests, and Wrangler dry-run build.
- Updated GitHub Actions to use the existing `package-lock.json` with `npm ci` and to run the validation baseline.
- Switched package manager metadata to npm to match the existing lockfile and CI path.

#### Runtime behavior

No production runtime logic was intentionally changed in this phase.

The tests intentionally document some current baseline behavior that may be changed in later phases, including:

- direct URL video publish currently falls back from `sendVideo` to text + source link after a Telegram media error.
- media group processing currently supports partial media publishing by filtering failed items.

Later phases should update the affected tests when those behaviors are intentionally changed.

#### Validation command

```bash
npm run validate
```

Current validation result:

- TypeScript typecheck: pass
- Vitest: 24 tests pass
- Wrangler dry-run build: pass

### Phase 1 — Configuration Consistency & No-Cost Stream Safety

This phase intentionally does **not** change the core publishing behavior, media fallback behavior, scheduling logic, Apify normalization, or AI prompts.

The goal is to prevent accidental paid Cloudflare Stream usage and make runtime media/Stream settings visible to operators.

#### Changes

##### 1. Explicit Stream Safety Gate

A new centralized helper was added:

- `apps/worker-api/src/services/stream-config.ts`

Cloudflare Stream is now enabled only when all of these are true:

1. `STREAM_TRANSCODE_ENABLED === "true"`
2. `CLOUDFLARE_ACCOUNT_ID` is configured
3. `CLOUDFLARE_STREAM_API_TOKEN` is configured

Credentials alone are not enough.

##### 2. Stream Guard in Transcoder

`transcodeViaStream()` now checks the centralized Stream gate before making any Cloudflare API call.

If Stream is disabled or incomplete, it returns a normal failure result and does not call `fetch()`.

##### 3. Stream Guard in Telegram Publisher

`telegram-publisher.ts` now checks the same Stream gate before attempting the paid fallback.

If a binary `sendVideo` fails with `media_error` and Stream is disabled, the system logs the skip reason and continues to the existing `sendDocument` fallback.

##### 4. Wrangler Defaults

`STREAM_TRANSCODE_ENABLED = "false"` was added to both local/default and production vars.

This keeps paid video transcoding disabled by default even if Stream credentials are later added.

##### 5. Runtime Visibility

`/internal/stats` now includes a non-secret `runtime_config` object with:

- environment
- media processing mode
- effective curation state
- effective dry-run state
- effective Telegram publish state
- Telegram scheduler env state
- Stream transcode status

No secret values are returned.

##### 6. Dashboard Minimal Update

The AI Settings page now shows a small Cloudflare Stream fallback status alert.

No dashboard navigation, layout structure, data model, or existing workflow was changed.

#### Not Changed

This phase does not fix:

- direct URL video fallback behavior
- R2 single photo/video stable URL usage
- scheduling windows
- thumbnail validation
- Cloudflare Stream download flow
- media processing status lifecycle
- custom prompt/channel instruction wiring

Those belong to later phases.

#### Validation

Executed successfully:

```bash
npm run validate
```

Result:

- TypeScript typecheck passed
- Vitest passed: 29 tests
- Wrangler dry-run build passed

#### Safety Notes

Cloudflare Stream can only create cost if `STREAM_TRANSCODE_ENABLED=true` and both required Stream credentials are present. By default, even production has `STREAM_TRANSCODE_ENABLED=false`.

### Phase 2 — Scheduling Correctness

Phase 2 was applied on top of `content-curator-phase1.zip`.

#### Scope

This phase only changes scheduling-related behavior:

- `allowed_windows`
- `blocked_windows`
- channel timezone handling
- channel-local daily quota checks
- `min_gap_minutes` planning
- dashboard/API defaults for allowed windows

No media publishing behavior, Cloudflare Stream behavior, Apify normalization, AI prompts, or Telegram fallback behavior was changed in this phase.

#### What changed

##### 1. Timezone-aware local day bounds

`rule-gate.ts` now computes the channel-local day start and end using `Intl.DateTimeFormat` and a timezone offset iteration helper. Daily quota checks are based on the local day of the computed `scheduled_at`, not the worker/server day.

##### 2. Window handling

The scheduler now supports:

- Normal windows, for example `09:00-17:00`
- Early-day windows, for example `00:00-08:00`
- Overnight windows, for example `22:00-02:00`
- Legacy near-midnight windows, for example `08:00-00:00`

Window end times are treated as exclusive. For example, `00:00-08:00` means blocked until exactly `08:00`.

##### 3. Blocked windows take priority

The scheduling normalizer first moves a candidate into an allowed window, then moves it out of blocked windows. It repeats this normalization to avoid ending in an invalid slot after a blocked-window adjustment.

##### 4. Daily quota includes scheduled work

Daily quota now counts both:

- published items in the relevant channel-local day
- already scheduled/retry/publishing items in the same channel-local day

This prevents overfilling a channel day before publish time.

##### 5. `min_gap_minutes` still applies during planning

The scheduler keeps respecting the latest scheduled/published item when choosing the next schedule time.

##### 6. Safer defaults

New channel creation now defaults `allowed_windows` to:

```json
["08:00-23:59"]
```

instead of:

```json
["08:00-00:00"]
```

The legacy `08:00-00:00` value is still supported, but new defaults avoid ambiguity.

The dashboard channel modal and setup wizard were updated only for this default value. The dashboard structure was not changed.

#### Files changed

- `apps/worker-api/src/services/rule-gate.ts`
- `apps/worker-api/src/routes/admin.ts`
- `apps/dashboard/index.html`
- `tests/rule-gate.test.ts`
- documentation references for the safer default window

#### Validation

The full validation suite passed:

```text
npm run typecheck: passed
npm test: 37 tests passed
npm run build: wrangler dry-run passed
npm run validate: passed
```

#### Intentional non-changes

Phase 2 did not change:

- Telegram media publishing
- direct URL video fallback
- partial media group policy
- Cloudflare Stream behavior
- R2 behavior
- thumbnail validation
- Apify extraction logic
- AI scoring or translation logic

### Phase 3 — Telegram Publisher Reliability

This phase starts from `content-curator-phase2.zip` and intentionally limits changes to Telegram publishing reliability in the free path. It does not change Apify normalization, AI scoring, translation, scheduling, R2 behavior, or Cloudflare Stream behavior.

#### What changed

##### Direct URL video fallback

`direct_url` video publishing now uses a safer fallback chain:

1. `sendVideo` with the original URL.
2. If Telegram returns a media/fetch/format/size URL error, try `sendDocument` with the same URL.
3. If `sendDocument` also fails, publish text plus the source link.

This preserves the no-cost path while giving Telegram one more chance to deliver the video as a downloadable file before falling back to text.

##### Partial media group policy

Binary media groups now make partial publishing explicit and configurable.

`MEDIA_GROUP_PARTIAL_PUBLISH_ENABLED=true` is the default. In this mode, if some album items fail processing but at least one item is valid, the valid items are published and the queue warning records the failed indexes.

`MEDIA_GROUP_PARTIAL_PUBLISH_ENABLED=false` fails the whole media group if any item fails processing.

This keeps the flexible product behavior while making it visible and testable instead of hidden.

##### Telegram error classification

Telegram API errors are now classified more specifically:

- `rate_limit`
- `media_error`
- `file_too_large`
- `expired_url`
- `invalid_format`
- `network`
- `auth`
- `unknown`

The existing `retry_after` handling remains in place.

##### Caption follow-up and partial publish warnings

Warnings for partial media groups and follow-up caption failures continue to be stored through `captionError`, which the orchestrator writes to `publish_queue.publish_error` for published items.

##### Dashboard visibility

The dashboard structure was not changed. The existing AI Settings runtime panel now shows whether media group partial publishing is enabled.

#### What did not change

- Cloudflare Stream is still disabled by default and still gated by Phase 1 safety controls.
- No video transcoding behavior was added or modified.
- No R2 single-media behavior was changed.
- No thumbnail validation was added in this phase.
- No Apify, AI, or scheduler logic was changed.
- Human review remains out of scope.

#### Validation

Phase 3 should pass:

```bash
npm run typecheck
npm test
npm run build
npm run validate
```

The test suite now includes 41 tests, including direct URL video document fallback and partial media group policy tests.

### Phase 4 — R2 Stable URL Behavior

#### Scope

Phase 4 is intentionally limited to R2 stable URL behavior for single `sendPhoto` and `sendVideo` publishing paths.

No dashboard layout changes were made. No changes were made to Apify normalization, AI scoring, translation, scheduling, Cloudflare Stream, thumbnail validation, or media-group partial publishing policy.

#### Problem

Before this phase, `media-processor.ts` correctly stored media in R2 when `MEDIA_PROCESSING_MODE=r2_storage` and returned `processed.stableUrl`.

However, `telegram-publisher.ts` only used `processed.blob` for single `sendPhoto` and `sendVideo` paths. In R2 mode, the processor intentionally clears `processed.blob` after storing the file in R2, so single photo/video publishing silently fell back to the original Apify/CDN URL.

That meant `r2_storage` worked better for media groups than for single media posts.

#### Changes

##### Single photo

When `MEDIA_PROCESSING_MODE !== direct_url`, `sendPhoto` now uses this priority order:

1. Existing Telegram `file_id`
2. Downloaded `blob` via multipart upload
3. R2 `stableUrl`
4. Original source URL only if processing failed or no stable URL exists

##### Single video

When `MEDIA_PROCESSING_MODE !== direct_url`, `sendVideo` now uses this priority order:

1. Existing Telegram `file_id`
2. R2 `stableUrl` when the processor returns a stable URL and no blob
3. Downloaded `blob` via multipart upload
4. Original source URL only if processing failed or no stable URL exists

For R2 stable video URLs, the same free fallback chain is used:

```text
stableUrl sendVideo
  -> if Telegram media/fetch/format error
stableUrl sendDocument
  -> if document also fails
text + source link
```

Cloudflare Stream is not introduced or changed in this phase.

#### Tests Added

- `processMediaItem()` in `r2_storage` mode stores media and returns `stableUrl` without retaining `blob`.
- Single `sendPhoto` uses the R2 stable URL instead of the original CDN URL.
- Single `sendVideo` uses the R2 stable URL and falls the same stable URL back to `sendDocument` before text fallback.

#### Validation

The full validation suite passed after this phase:

```text
npm run typecheck: passed
npm test: 44 tests passed
npm run build: wrangler dry-run passed
npm run validate: passed
```

#### Explicit Non-Goals

- No thumbnail validation changes.
- No R2 lifecycle/status persistence changes.
- No Telegram `file_id` persistence changes.
- No Cloudflare Stream hardening.
- No dashboard redesign.
- No media group behavior changes.

### Phase 5 — Thumbnail Validation

#### Scope

Phase 5 only tightens thumbnail handling for Telegram video uploads. It does not change the media publishing strategy, Cloudflare Stream behavior, R2 behavior, Apify normalization, AI prompts, scheduling, or dashboard layout.

#### Why this phase exists

Telegram video thumbnails are not generic images. For reliable Bot API usage, a thumbnail must be a JPEG image, must be small, and must not exceed Telegram's thumbnail dimensions. Previous versions accepted any `image/*` blob up to 5MB, which meant PNG/WebP/oversized images could be attached and then rejected or ignored by Telegram.

#### Runtime behavior changes

- Video thumbnails are now validated before being attached to multipart Telegram uploads.
- Only JPEG thumbnails are accepted.
- Thumbnail size must be under 200KB.
- Thumbnail width and height must not exceed 320px.
- JPEG dimensions are read from the JPEG SOF marker before attach.
- Invalid thumbnails are skipped, but the video remains publishable.
- Invalid thumbnail outcomes are recorded on the processed media object as `thumbnailStatus` and `thumbnailError`.
- URL-based `sendVideo` no longer sends a raw `thumbnail` URL because Telegram video thumbnails are only reliable in multipart upload flows.
- Cloudflare Stream thumbnail URLs, if returned later, are also passed through the same validation before attach.

#### Explicit non-goals

- No thumbnail generation was added.
- No image resizing or format conversion was added.
- No paid service was introduced.
- No Cloudflare Stream behavior was changed.
- No dashboard layout or navigation was changed.
- No media status persistence was added; that belongs to Phase 6.

#### Important product note

This phase validates thumbnails that already exist. It does not guarantee a thumbnail for every video. If a source platform provides no thumbnail, or provides an invalid thumbnail, the video can still be published without an attached thumbnail. Generating thumbnails from video frames remains a later, separate decision.

#### Validation

Phase 5 adds tests for:

- valid JPEG thumbnail under Telegram limits
- non-JPEG thumbnail rejection
- oversized thumbnail rejection
- oversized dimension rejection
- binary video thumbnail attach only when valid
- invalid thumbnail skip while video remains usable
- direct URL video publishing not sending raw thumbnail URLs

All validation commands passed:

```text
npm run typecheck
npm test
npm run build
npm run validate
```

### Phase 6 — Media Status & Observability

#### Scope

This phase adds observability for media processing and Telegram publishing without changing the core publishing policy.

No changes were made to:

- Cloudflare Stream behavior
- R2 storage behavior
- thumbnail validation rules
- Apify normalization
- AI prompts/scoring/translation
- scheduling logic
- partial media group policy
- dashboard structure/navigation

#### What changed

##### 1. Telegram publish results now include per-media metadata

`publishToTelegram()` now returns optional `mediaResults` with one entry per source media item when media publishing is attempted.

Each entry can include:

- `mediaIndex`
- `processing_status`
- processing error
- Telegram `file_id`
- Telegram `message_id`
- thumbnail status/error

This does not change how media is sent. It only makes the outcome inspectable.

##### 2. Telegram file IDs are parsed from successful responses

The publisher now extracts file IDs from Telegram responses for:

- `photo`
- `video`
- `document`
- `animation`

For photos, the largest returned size is used.

For media groups, Telegram result order is mapped back to original source media indexes, even when partial publishing skipped failed items.

##### 3. Discovery media rows are synced after publish attempts

`publishDueItems()` now:

- loads existing `telegram_file_id`s for the queue item before publishing
- passes them to the publisher for reuse
- updates `discovery_media` after publish attempts

Updated columns include:

- `processing_status`
- `processing_error`
- `telegram_file_id`
- `telegram_message_id`
- `thumbnail_status`
- `thumbnail_error`
- `validated_at`

##### 4. New media observability migration

Added migration:

```text
migrations/0006_media_observability.sql
```

It adds:

- `discovery_media.telegram_message_id`
- `discovery_media.thumbnail_status`
- `discovery_media.thumbnail_error`
- useful media indexes

##### 5. New internal media diagnostics endpoint

Added:

```http
GET /internal/media?item={item_id}
GET /internal/media?status=failed
GET /internal/media?limit=100
```

This endpoint is protected by the existing `/internal/*` secret check.

##### 6. Stats include media counters

`GET /internal/stats` now includes:

- `media_pending`
- `media_failed`
- `media_uploaded`

##### 7. Queue dashboard shows existing media warning/message metadata

The dashboard structure was not redesigned. The existing queue row template now displays:

- `media_warning`
- `all_message_ids`

when these values exist.

#### Important behavior notes

Partial media group publishing remains enabled by default, unchanged from Phase 3.

If partial publishing occurs:

- successful media are marked `uploaded`
- failed media keep their specific failure status/error
- Telegram message IDs and file IDs are mapped to the original media indexes that were actually sent

If Telegram falls all the way back to text for a video, the media item is marked with a failed/unsupported status while the queue item can still be considered published as a text fallback.

#### Validation

Phase 6 validation covered:

- TypeScript typecheck
- Vitest regression tests
- Wrangler dry-run build
- Full `npm run validate`

New tests verify:

- Telegram file IDs are extracted from photo responses
- media group file IDs are mapped back to original media indexes after partial publish

### Phase 7 — Apify Normalization Hardening

#### Scope

Phase 7 hardens source normalization for Apify outputs without changing Telegram publishing behavior, scheduling, AI selection, Cloudflare Stream, R2, or dashboard structure.

The goal is to reduce media loss caused by actor schema variation and make extraction problems visible before publish.

#### Changes

##### 1. More defensive X/Twitter media extraction

`apify-client.ts` now checks multiple Twitter/X media shapes:

- `extendedEntities.media`
- `extended_entities.media`
- `entities.media`
- `media`
- `attachments.media`
- `legacy.extended_entities.media`
- `legacy.entities.media`

For video media, it selects the highest bitrate MP4 variant and rejects HLS/DASH/manifest URLs before they reach Telegram.

If a video only has HLS/DASH variants, it is skipped with an extraction warning.

##### 2. More defensive Instagram media extraction

Instagram extraction now supports:

- `childPosts`
- `sidecarChildren`
- `carouselMedia`
- `carousel_media`
- `shortcode_media.edge_sidecar_to_children.edges[].node`
- `edge_sidecar_to_children.edges[].node`
- `images[]`
- single image, single video, and Reel-like fields

Video URL and thumbnail URL are handled separately.

Unsupported stream URLs such as `.m3u8` and `manifest.mpd` are rejected with warnings.

##### 3. More defensive LinkedIn media extraction

LinkedIn extraction now supports:

- `postVideo`
- alternate `video` / `videos[0]` shapes
- `postImages`
- `images`
- `imageUrls`
- `document.coverPages`
- `document.pages`
- article image fallback

Important behavior: if a LinkedIn post includes both `postVideo` and `postImages`, the video is preferred. Some actors expose video preview frames inside `postImages`; treating those as the main media would lose the actual video.

##### 4. Extraction diagnostics

`NormalizedItem` now carries:

- `expectedMediaCount`
- `mediaWarnings`

These are persisted to `discovery_items` via migration `0007_apify_extraction_diagnostics.sql`:

- `media_expected_count`
- `media_extracted_count`
- `media_extraction_warnings`

The admin items endpoint now includes these fields so diagnostics can be inspected without direct DB access.

##### 5. Fixture coverage

New fixtures cover:

- Twitter/X HLS-only video
- Instagram `sidecarChildren`
- Instagram `carousel_media` with manifest video
- LinkedIn alternate video schema
- LinkedIn video with `postImages` preview frame
- LinkedIn document carousel with more than 10 pages

#### Intentional Non-Changes

This phase does not change:

- Telegram publisher fallback logic
- partial media group policy
- R2 behavior
- Cloudflare Stream behavior
- thumbnail validation rules
- scheduling
- AI prompts
- dashboard layout or navigation

#### Validation

The full validation suite passed after this phase:

```text
npm run typecheck: passed
npm test: 57 tests passed
npm run build: wrangler dry-run passed
npm run validate: passed
```

### Phase 8 — Category & Channel Prompt Wiring

#### Scope

This phase wires existing schema fields into API persistence, dashboard forms, and AI target selection. It does not change Telegram publishing, media processing, scheduling, Cloudflare Stream, R2, or Apify normalization behavior.

#### What changed

##### Category prompt wiring

- `custom_prompt` is now persisted when creating categories through `POST /internal/categories`.
- `custom_prompt` is now updateable through `PATCH /internal/categories/:id`.
- `runScoring()` already prioritizes `category.custom_prompt` over the built-in `prompt_profile`; this behavior is now reachable from API/dashboard configuration.

##### Channel prompt wiring

- `custom_instructions`, `tone_profile`, and `channel_label` are now persisted when creating channels through `POST /internal/channels`.
- These fields are now updateable through `PATCH /internal/channels/:id`.
- Dashboard channel modal now exposes these fields without changing the dashboard layout/navigation.

##### Translation target behavior

The existing language-level translation behavior is preserved.

For normal channels without custom AI context, translations remain keyed by language:

```json
{
  "fa": { "caption_short": "...", "caption_full": "...", "hashtags": [] },
  "en": { "caption_short": "...", "caption_full": "...", "hashtags": [] }
}
```

For channels with at least one of the following:

- `custom_instructions`
- non-neutral `tone_profile`
- `channel_label`

an additional channel-specific translation target is requested using this key format:

```text
channel:<channel_id>
```

The orchestrator then prefers the channel-specific translation and falls back to the language-level translation:

```text
ai.translations[`channel:${channel.id}`] ?? ai.translations[channel.language]
```

This keeps backwards compatibility and avoids multiplying translation output for every channel unnecessarily.

#### Dashboard changes

Dashboard structure was not redesigned.

Only existing modals were extended:

- Category modal: added `Custom Prompt` textarea.
- Category modal: added branding and finance prompt profiles to the existing select.
- Channel modal: added `Channel Label`, `Tone Profile`, and `Custom Instructions` fields.
- Category/channel edit now uses PATCH when editing an existing entity, instead of always attempting POST.

#### Tests added

- `tests/ai-gate-phase8.test.ts`
  - Verifies language-level translation keys remain unchanged for channels without custom AI context.
  - Verifies a channel-specific key is added only when a channel has custom tone/instructions/label.

- `tests/admin-phase8.test.ts`
  - Verifies category `custom_prompt` is persisted on create and patch.
  - Verifies channel AI context fields are persisted on create and patch.

#### Validation

Phase 8 passed:

```text
npm run typecheck
npm test
npm run build
npm run validate
```

Final test count after this phase: 63 tests.

#### Deliberately unchanged

- No media behavior changed.
- No Telegram fallback behavior changed.
- No Cloudflare Stream behavior changed.
- No R2 behavior changed.
- No scheduling behavior changed.
- No Apify normalization behavior changed.
- No human review workflow added.

### Phase 9 — Cloudflare Stream Fallback Hardening

#### Scope

Phase 9 hardens the optional Cloudflare Stream fallback path without changing the default free publishing path.

Cloudflare Stream remains disabled by default. It is still called only when all of the following are true:

1. `STREAM_TRANSCODE_ENABLED=true`
2. `CLOUDFLARE_ACCOUNT_ID` is configured
3. `CLOUDFLARE_STREAM_API_TOKEN` is configured
4. Telegram has already rejected the first binary `sendVideo` attempt with a media-compatible fallback error

No direct URL video, R2 stable URL video, image publishing, scheduling, Apify normalization, AI prompt, or dashboard behavior is changed in this phase.

#### What changed

##### 1. No fabricated Cloudflare Stream download URLs

The previous Stream fallback constructed a URL like:

```text
https://customer-${accountId}.cloudflarestream.com/${videoId}/downloads/default.mp4
```

That is not safe because the Stream customer subdomain is not guaranteed to be the Cloudflare account ID.

The new flow only uses MP4 download URLs returned by Cloudflare API response metadata.

##### 2. Download generation is re-checked properly

If an MP4 download URL is not already present on the Stream video object, the worker requests download generation through the Stream downloads endpoint, then polls the Stream video metadata until a usable download URL appears.

It does not call `.blob()` on an earlier failed download response.

##### 3. Stream asset deletion no longer happens before Telegram send

`transcodeViaStream()` now returns the transcoded MP4 blob and `streamVideoId` without deleting the Stream asset immediately.

`telegram-publisher.ts` deletes the Stream asset only after the transcoded video has been successfully sent to Telegram.

If Telegram rejects the transcoded video too, the Stream asset is left in place for debugging rather than being deleted before the failure can be inspected.

##### 4. Stream logic is covered by mocked tests

New tests cover:

- Stream remains disabled unless `STREAM_TRANSCODE_ENABLED=true`.
- Download URLs are extracted only from API-returned metadata.
- No `customer-${accountId}` URL is fabricated.
- Publisher calls Stream only after a binary `sendVideo` media error.
- Publisher deletes the Stream asset only after successful Telegram send.

#### Side effects deliberately avoided

This phase does not:

- Route all videos to Cloudflare Stream.
- Enable Stream by default.
- Change direct URL publishing.
- Change R2 behavior.
- Change thumbnail validation.
- Change media group partial publishing.
- Change dashboard structure.
- Add any new paid path unless Stream is explicitly enabled.

#### Validation

Expected validation commands:

```bash
npm run typecheck
npm test
npm run build
npm run validate
```

### Phase 10 — AI Reliability & Cost Guardrails

Phase 10 is intentionally limited to AI scoring/translation reliability and usage observability. It does not change Telegram publishing, media processing, R2, Cloudflare Stream, scheduling, Apify normalization, or dashboard layout.

#### What changed

##### Claude scoring budget guardrails

Claude scoring now checks the existing scoring budget configuration before making an Anthropic API call:

- `AI_MAX_CALLS_PER_DAY`
- `AI_DAILY_TOKEN_BUDGET`

The guardrail is intentionally scoped to Claude scoring because these variables were already documented as Claude/scoring budget controls. Translation behavior is not blocked by this budget in Phase 10 to avoid surprising queue volume changes.

If the scoring budget is exhausted, items are rejected with:

- `riskFlags: ["ai_budget_exceeded"]`
- no external AI call is made
- a skipped usage record is written when the `ai_usage` migration is available

If the `ai_usage` table is missing, budget checks and usage writes fail open. This avoids taking the production pipeline down during staged migrations.

##### AI usage telemetry

A new migration adds `ai_usage`:

```text
migrations/0008_ai_usage.sql
```

The table records:

- provider
- purpose: `scoring` or `translation`
- model
- input/output tokens
- status: `success`, `failed`, or `skipped`
- error message
- created timestamp

Token usage is recorded from provider metadata where available:

- Anthropic: `usage.input_tokens`, `usage.output_tokens`
- Gemini: `usageMetadata.promptTokenCount`, `usageMetadata.candidatesTokenCount`
- OpenAI: `usage.prompt_tokens`, `usage.completion_tokens`

##### Runtime stats

`/internal/stats` now includes 24-hour AI usage counters:

- `ai_calls_24h`
- `ai_tokens_24h`
- `ai_scoring_calls_24h`
- `ai_scoring_tokens_24h`
- `ai_translation_calls_24h`
- `ai_translation_tokens_24h`

`runtime_config` also exposes the active AI guardrail settings without exposing any secrets.

##### More robust AI result matching

AI scoring and translation matching now normalize URLs before matching. It handles common tracking query parameters such as:

- `utm_*`
- `fbclid`
- `gclid`
- `ref`
- `ref_src`
- `igshid`

Scoring also accepts optional `post_id` in AI output and falls back to matching by `postId` if URL matching fails.

##### Missing translation visibility

If an item gets only some of the required translation targets, it is no longer silently opaque. The item remains publishable if at least one usable translation exists, but missing targets are surfaced in `riskFlags` as:

```text
translation_missing:<target_key>
```

If all translations are missing, the item is marked not publishable with `translation_missing`.

##### Output token setting

Provider calls now respect `AI_MAX_OUTPUT_TOKENS` instead of hardcoded `4096` values for translation and hardcoded `2048` for Claude scoring.

#### What did not change

- No dashboard redesign.
- No media behavior changes.
- No Telegram publisher changes.
- No Cloudflare Stream behavior changes.
- No R2 behavior changes.
- No scheduling changes.
- No Apify normalization changes.
- No human review flow.

#### Validation

Phase 10 validation passed:

```text
npm run typecheck: passed
npm test: 69 tests passed
npm run build: wrangler dry-run passed
npm run validate: passed
```

### Phase 11 — End-to-End Validation Baseline

Phase 11 adds a non-invasive validation layer on top of the previous ten phases. It does not change production publishing behavior, scheduling behavior, AI behavior, media processing, Cloudflare Stream, R2, Apify normalization, or the dashboard structure.

#### What this phase validates

The goal is to confirm that the integrated pipeline pieces still work together after all earlier phased changes:

- Apify normalization preserves media order, media type, and thumbnail metadata.
- Media resolution chooses the expected Telegram method.
- Telegram publisher fallback behavior works without paid services.
- Video fallback uses `sendDocument` before falling back to text.
- Cloudflare Stream stays disabled unless explicitly enabled.
- Media group publishing can remain partial and observable.
- Long album captions still create a follow-up text message.
- Phase documents and migrations are present and ordered.

#### No-cost guardrail

`STREAM_TRANSCODE_ENABLED` must remain `false` by default. Phase 11 validation explicitly checks this so a future config edit does not accidentally enable paid Stream usage.

#### Dashboard impact

None. The dashboard was not modified in this phase.

#### Scripts

```bash
npm run validate
npm run validate:phase11
npm run validate:e2e
```

`validate:e2e` runs the standard build/test validation and then checks phase-specific release-readiness invariants.

#### Manual staging checklist

Use a private Telegram test channel before enabling public channels:

1. Text-only post publishes as `sendMessage`.
2. Single image publishes as `sendPhoto`.
3. Single video publishes as `sendVideo` if accepted by Telegram.
4. If video `sendVideo` is rejected, it falls back to `sendDocument` before text+link.
5. Instagram carousel publishes as a media group.
6. Mixed image/video album preserves item order for valid items.
7. Partial album warnings appear when some media fail and partial publishing is enabled.
8. Thumbnail is attached only when it passes Telegram constraints.
9. `MEDIA_PROCESSING_MODE=binary_upload` does not call Cloudflare Stream unless `STREAM_TRANSCODE_ENABLED=true`.
10. Channel scheduling respects timezone, allowed windows, blocked windows, daily quota, and min gap.
11. AI scoring stops before Anthropic calls when the daily scoring call budget is exhausted.
12. Missing translation targets are surfaced as risk flags.

#### Intentionally unchanged

- No live Telegram API calls are added to automated tests.
- No paid Cloudflare Stream calls are made.
- No dashboard redesign is made.
- No production toggles are changed.

### Phase 12 — Release Hardening, Formatting, and Editorial Controls

After the Phase 11 validation baseline, the system added production-facing editorial and formatting hardening.

#### What changed

- Telegram message formatting moved behind a backend formatter so dashboard preview and real publish output do not diverge.
- Raw source URLs are hidden behind source labels instead of being printed into message bodies.
- Link preview is disabled in text fallback paths.
- Channel-level controls were added for source attribution, signature, footer, and link preview behavior.
- Reply, retweet, quote, and text-only controls became configurable.
- Queue preview and publish-now endpoints were added for operational QA.
- Apify sources gained task/actor metadata and last dataset tracking.
- Release hardening validation was added through `npm run validate:release` and `npm run validate:release:strict`.

### Phase 13 — AI Candidate Backlog, Query-First Discovery, and Production Throughput Work

This phase addressed the core production bottleneck: the system could scrape enough raw data but still fail to create enough high-quality Telegram queue items.

#### What changed

- Added durable `ai_candidate_queue` between dedupe and Claude scoring.
- Added bounded backlog drain through cron and admin endpoint.
- Added source-account fair picker for Claude scoring batches.
- Changed `AI_MAX_CANDIDATES_PER_RUN` from a lossy cutoff into a safe batch concept when backlog is enabled.
- Added controlled Apify rotation with cohorts and topic gates.
- Added source-account balancing before final source limit slicing.
- Added raw fetch limit so the Worker can fetch a larger raw dataset, balance by account, then process a smaller final candidate set.
- Added market-trending text/media source families for controlled experimentation.
- Added ops/debug reports for backlog, recent runs, and pipeline state.

#### Production posture

```text
AI_CANDIDATE_BACKLOG_ENABLED=true
AI_FAIR_SOURCE_PICKER_ENABLED=true
APIFY_ROTATION_ENABLED=true
APIFY_SCHEDULED_CURATION_ENABLED=false
```

### Phase 14 — Dependency Audit Remediation

#### What changed

- Upgraded `vitest` to the current 4.x line.
- Upgraded `wrangler` to the current 4.x line.
- Added `npm run validate:audit`.
- Verified the updated toolchain with typecheck, tests, dry-run build, media validation, release validation, and npm audit.

### Phase 15 — Crypto Input Quality Gate and Whale Alert Throttle

This phase tightened the crypto pilot after production showed too much low-value AI/geopolitics/general news and too many Whale Alert queue items.

#### What changed

- Tightened Apify rotation topic gates for crypto relevance.
- Removed `whale_alert` from general voices cohorts.
- Kept only high-signal whale/on-chain use cases.
- Added deterministic pre-AI rejects for generic AI, generic equities/SpaceX, generic geopolitics, engagement bait, non-crypto posts, and low-signal Whale Alert transfers.
- Added Whale Alert daily queue throttle so a valid on-chain item can still publish, but the channel cannot become mostly wallet-transfer posts.

#### Validation

```bash
npm test -- --run tests/apify-rotation-query-buckets.test.ts tests/content-policy-crypto-pre-ai.test.ts
npm test -- --run tests/backlog-drain.test.ts tests/discovery-quality-phase9a.test.ts
npm run typecheck
npm test -- --run
```

---

## Release Hardening & Production Checklist

Before merging or deploying this release, use the dedicated release checklist:

```bash
npm run validate:release
```

For a stricter gate that fails when production publish/curation flags are enabled in `wrangler.toml`:

```bash
RELEASE_STRICT=1 npm run validate:release
```

The release checklist is documented in:

```text
RELEASE_CHECKLIST.md
```

Historical release notes for the last rollout may exist in:

```text
RELEASE_NOTES_NEXT.md
```

The release gate checks the migration chain, required release documents, no obvious committed secrets, runtime safety-switch expectations, Telegram preview safety, prompt source URL rules, and release-owner warnings for risky production flags.

The final manual pre-deploy review must include:

- D1 migrations are applied locally before remote.
- No real secrets are committed.
- `TELEGRAM_FINAL_PUBLISH_ENABLED` and `telegram_publish_enabled` are both intentionally reviewed.
- `TELEGRAM_PUBLISH_SCHEDULER_ENABLED` is not enabled unless final publish is intentionally enabled.
- Channel quotas, windows, and min-gap settings are reset from test values.
- Queue preview output matches expected Telegram output.
- Raw source URLs are not visible in messages.
- Link preview is disabled in all text fallback paths.
- Media QA scenarios in `MEDIA_QA.md` are complete for the pilot category.

Dashboard styling and structure are intentionally not changed by release hardening. Dashboard changes should remain additive and use the existing `apps/dashboard/index.html` structure unless a separate refactor PR is explicitly approved.

---

## Troubleshooting

### Scheduled queue is empty

Check the full pipeline before increasing scrape volume:

```bash
curl -s "$BASE/internal/backlog/stats" \
  -H "x-internal-api-secret: $INTERNAL_API_SECRET" \
| jq '.ai_budget,.status_counts,.top_pending_accounts'

curl -s "$BASE/internal/debug/crypto-pipeline" \
  -H "x-internal-api-secret: $INTERNAL_API_SECRET" \
| jq '.recent_runs[0:10],.scheduled_queue,.failed_retry_queue,.diagnosis'
```

Interpretation:

- `pending > 0` and budget remaining: run a small backlog drain or wait for cron.
- `pending > 0` and budget exhausted: do not force more scoring; wait for budget window or intentionally revise budget.
- `items_fetched > 0` but `items_new = 0`: scrape is mostly duplicate/stale.
- `items_new > 0` but `queued = 0`: check pre-AI reject reasons, AI scores, semantic dedupe, rule gate, and translation availability.
- scheduled queue exists but publish returns `rate_limit_min_gap`: wait; this is normal channel protection.

### Apify rotation ran but no new queue items appeared

A successful Apify task run only proves Apify produced a dataset. Queue creation still depends on webhook/ingestion, dedupe, freshness, pre-AI policy, Claude budget, translation, semantic dedupe, and rule gate.

Check recent runs:

```bash
curl -s "$BASE/internal/debug/crypto-pipeline" \
  -H "x-internal-api-secret: $INTERNAL_API_SECRET" \
| jq '.recent_runs[0:8] | map({dataset:.apify_dataset_id,fetched:.items_fetched,new:.items_new,queued:.items_queued,rejected:.items_ai_rejected,created:.created_at})'
```

If `fetched` is high and `new` is zero, do not raise AI budget. The bottleneck is source freshness/dedupe, not Claude.

### AI budget exhausted

Backlog drain stops when the scoring budget is exceeded. Do not reset production AI usage repeatedly unless a release owner explicitly accepts the cost and quality risk.

Read-only budget check:

```bash
curl -s "$BASE/internal/backlog/stats" \
  -H "x-internal-api-secret: $INTERNAL_API_SECRET" | jq '.ai_budget'
```

### Too many Whale Alert items

The production code now has pre-AI Whale Alert filtering and queue throttle. Existing scheduled Whale Alert rows from before a patch may still need manual cleanup. Prefer cancelling low-signal queued items rather than deleting historical discovery data.

Read current scheduled Whale Alert rows:

```bash
npx wrangler d1 execute content-curator-db-v2 --remote --json --command "SELECT id, source_url, scheduled_at, caption_short FROM publish_queue WHERE status='scheduled' AND channel_id='crypto_fa_pilot' AND source_url LIKE '%/whale_alert/%' ORDER BY scheduled_at;" \
| jq -r '.[0].results[] | "\nID: \(.id)\nURL: \(.source_url)\nTIME: \(.scheduled_at)\nTEXT:\n\(.caption_short)\n"'
```

Cancel selected queue rows through the API when possible:

```bash
curl -s -X DELETE "$BASE/internal/queue/$QID" \
  -H "x-internal-api-secret: $INTERNAL_API_SECRET" | jq .
```

### Items not arriving from Apify

```bash
# Check sources are registered
curl .../internal/apify-sources -H "x-internal-api-secret: SECRET"

# Trigger manually
curl -X POST .../internal/curation/trigger \
  -H "x-internal-api-secret: SECRET" \
  -d '{"dryRun": true, "force": true}'

# Check for errors
curl ".../internal/runs?limit=5" -H "x-internal-api-secret: SECRET"
# Look at error_message field
```

### All items AI-rejected

```bash
# Inspect rejected items and their scores
curl ".../internal/items?status=ai_rejected&limit=20" -H "..."

# Temporarily lower threshold to diagnose
curl -X PATCH .../internal/categories/crypto -H "..." \
  -d '{"score_threshold": 55}'

# Check if items are too old (freshness filter)
# Category freshness_hours might be too short for your source update frequency
curl -X PATCH .../internal/categories/design -H "..." \
  -d '{"freshness_hours": 336}'  # extend to 14 days
```

### Media failing on publish

```bash
# Check failed queue items and their error type
curl ".../internal/queue?status=failed&limit=10" -H "..."
# Look at publish_error — it now includes error type prefix:
# [media_error] Bad Request: wrong file identifier
# [rate_limit] Too Many Requests
# [network] timeout

# Switch to binary_upload mode to handle expiring CDN URLs
# In wrangler.toml:
MEDIA_PROCESSING_MODE = "binary_upload"
# Then redeploy: wrangler deploy --env production

# Retry a specific failed item
curl -X POST .../internal/queue/QUEUE_ITEM_ID/retry -H "..."
```

### Instagram media expired before publish

```bash
# Option 1: Switch to binary_upload mode (downloads at schedule time)
MEDIA_PROCESSING_MODE = "binary_upload"

# Option 2: Reduce publish delay for expiring media
# System already caps scheduling at 1h for expiring URLs.
# Ensure cron is running and TELEGRAM_PUBLISH_SCHEDULER_ENABLED=true.

# Option 3: Reduce min_gap_minutes
curl -X PATCH .../internal/channels/crypto_fa -H "..." \
  -d '{"min_gap_minutes": 10}'
```

### Translation missing for some languages

```bash
# Check if the language is in category.language_targets
curl .../internal/categories -H "..."

# Upgrade translation model for better language coverage
# In wrangler.toml:
TRANSLATION_MODEL = "gemini-2.5-flash"  # more capable than flash-lite

# Check if channel custom_instructions are too restrictive
curl .../internal/channels -H "..."
```

### Telegram 429 rate limit

The system automatically reads `retry_after` from Telegram's response and schedules retry accordingly. If persistent:

```bash
# Check retry items
curl ".../internal/queue?status=retry&limit=10" -H "..."

# Reduce per-channel rate
curl -X PATCH .../internal/channels/crypto_fa -H "..." \
  -d '{"max_per_hour": 1, "min_gap_minutes": 60}'
```

### Maintenance mode is blocking requests

```bash
# Disable maintenance mode
curl -X POST .../internal/admin/toggle \
  -H "x-internal-api-secret: SECRET" \
  -d '{"key": "maintenance_mode", "value": "false"}'
```

### Worker times out during curation

Cloudflare Workers have a 30-second CPU time limit (free plan) and up to 30 minutes wall time via `waitUntil`.

```bash
# Reduce items per run
# In wrangler.toml:
AI_MAX_CANDIDATES_PER_RUN = "20"
APIFY_MAX_ITEMS_PER_SOURCE = "30"

# Check if media download is timing out (binary_upload mode)
MEDIA_DOWNLOAD_TIMEOUT_SEC = "30"
MEDIA_MAX_DOWNLOAD_MB = "20"
```

---

## Monthly Cost Estimate

### Current crypto pilot cost model

The current production crypto pilot has three variable cost drivers:

1. Apify task runs and fetched result count.
2. Claude scoring calls/tokens.
3. Gemini translation calls/tokens.

Cloudflare Worker, D1, Telegram Bot API, and the static dashboard are normally free at the current expected scale. Cloudflare Stream remains disabled by default and should not create cost unless explicitly enabled.

Useful formulas:

```text
Apify cost ≈ fetched_results × actor_price_per_result
Claude scoring cost ≈ input_tokens × input_price + output_tokens × output_price
Gemini translation cost ≈ input_tokens × input_price + output_tokens × output_price
```

Operationally, the important ratios are:

```text
items_new / items_fetched
items_queued / items_fetched
AI_tokens / queued_item
published / queued_item
```

A high fetched count with low new count means scrape spend is being wasted on duplicates/stale items. A high new count with low queued count means editorial policy, AI selection, semantic dedupe, translation, or rule gate is the bottleneck.

### Scenario: 3 categories, 6 channels (2 languages each), 3 platforms

| Service | Volume | Monthly cost |
|---------|--------|-------------|
| Cloudflare Workers | Unlimited on free plan | **$0** |
| Cloudflare D1 | < 5GB | **$0** |
| Cloudflare R2 (optional) | < 10GB | **$0** |
| Cloudflare Pages (dashboard) | — | **$0** |
| Apify Twitter (Kaito) | ~45K tweets | ~$11 |
| Apify Instagram | ~9K posts | ~$15 |
| Apify LinkedIn | ~600 posts | ~$1.20 |
| Claude Haiku (scoring) | ~450 pipeline runs | ~$3 |
| Gemini Flash-Lite (translation) | ~450 pipeline runs | ~$2 |
| Telegram Bot API | — | **$0** |
| **Total** | | **~$32/month** |

### Cost reduction

- Lower `APIFY_MAX_ITEMS_PER_SOURCE` to 30–50
- Raise `AI_SCORE_THRESHOLD_DEFAULT` to 80 (fewer items reach translation)
- Use `gemini-2.5-flash-lite` (not flash or pro)
- Run Apify tasks once daily instead of twice
- Lower `AI_MAX_CANDIDATES_PER_RUN` to 25
- Increase `DEDUPE_WINDOW_HOURS` to 336 (2 weeks) to catch more repeats early

---

*TypeScript · Cloudflare Workers · D1 · Apify · Claude · Gemini · Telegram Bot API*
