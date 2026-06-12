# Content Curator

> Fully automated, multi-category content curation and Telegram publishing system.
> **Apify → Cloudflare Worker → Claude AI → Telegram**
> Current production crypto pilot also uses **controlled Apify rotation → AI candidate backlog → fair source scoring → Gemini translation → Telegram scheduler**.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Current Production Architecture & Pilot State](#current-production-architecture-pilot-state)
- [AI Candidate Backlog & Fair Source Distribution](#ai-candidate-backlog-fair-source-distribution)
- [Apify Controlled Rotation](#apify-controlled-rotation)
- [Crypto Quality Gate & Whale Alert Throttle](#crypto-quality-gate-whale-alert-throttle)
- [Pipeline Flow](#pipeline-flow)
- [Media Processing](#media-processing)
- [Category & Language System](#category-language-system)
- [Project Structure](#project-structure)
- [Tech Stack & Cost](#tech-stack-cost)
- [Prerequisites](#prerequisites)
- [Setup Guide](#setup-guide)
- [Configuration Reference](#configuration-reference)
- [Apify Actors](#apify-actors)
- [Telegram Bot & Channels](#telegram-bot-channels)
- [AI Models & Cost](#ai-models-cost)
- [Scheduling & Time Windows](#scheduling-time-windows)
- [Market Snapshot](#market-snapshot)
- [Operational Runbook](#operational-runbook)
- [Documentation & Release Hygiene](#documentation-release-hygiene)
- [Dashboard](#dashboard)
- [API Reference](#api-reference)
- [Safety Switches](#safety-switches)
- [Security](#security)
- [GitHub Actions](#github-actions)
- [Validation & Quality Gates](#validation-quality-gates)
- [Release Hardening & Production Checklist](#release-hardening-production-checklist)
- [Current Limitations & Next Improvements](#current-limitations-next-improvements)
- [Troubleshooting](#troubleshooting)
- [Monthly Cost Estimate](#monthly-cost-estimate)
- [Documentation & Release Hygiene](#documentation-release-hygiene-1)

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
│  │  5. AI scoring — Claude Haiku                   │   │
│  │     └─ Score 0–100, risk level, publish priority     │   │
│  │     └─ Uses category custom_prompt if set            │   │
│  │  6. Translation — Gemini / OpenAI                │   │
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

The original architecture remains valid: Apify produces datasets, the Cloudflare Worker ingests them, Claude scores candidates, Gemini translates selected items, and Telegram publishes scheduled queue items. The current production crypto pilot adds several operational layers on top of that base flow.

### Effective production flow

```text
Cloudflare cron every 5 minutes
  -> controlled Apify rotation, when APIFY_ROTATION_ENABLED=true
  -> market snapshot direct send, when a configured slot is due
  -> publish due Telegram queue items
  -> recover, skip, or fail stale AI candidates
  -> drain AI candidate backlog in bounded batches
  -> clean old dedupe keys
```

`APIFY_SCHEDULED_CURATION_ENABLED=false` in production on purpose. Fresh datasets should come from source-scoped Apify webhooks and controlled rotation, not repeated reprocessing of old datasets.

### Current crypto pilot

```text
Worker URL: https://content-curator.thesol-ai.workers.dev
D1 database: content-curator-db-v2
category_id: crypto
channel_id: crypto_fa_pilot
Telegram channel: @thesolcrypto_fa
language: fa
timezone: Asia/Tehran
media mode: binary_upload
Cloudflare Stream fallback: disabled by default
```

### Current capacity target

The Persian crypto pilot is configured for a high-volume target of up to 72 posts/day. With `max_per_hour=4` and `min_gap_minutes=15`, that target is only reachable if the queue stays ahead of the scheduler throughout the active posting windows.

Operationally, the system should create roughly 12 usable scheduled items per active 3-hour rotation window. If natural runs consistently create fewer items, fix candidate supply and source/query quality before loosening editorial gates or raising AI spend.

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
npm install
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
npx npx wrangler deploy --env production
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
- `npx npx wrangler deploy --env production`

Do not paste secrets into chat or logs. For local checks, load `.dev.vars.production` privately and only verify presence/length, not the value.

---

## Documentation & Release Hygiene

The README is the durable source of truth for architecture, setup, configuration, API usage, operations, and troubleshooting.

`RELEASE_CHECKLIST.md` should remain separate because it is an operational deployment gate, not general product documentation.

Historical planning documents can be useful while a feature is still being designed, but they should not remain as competing architecture references after the implementation has landed. If a planning document is fully represented in the README and no longer matches production, archive or delete it in a separate documentation-cleanup commit.

Recommended cleanup policy:

```text
Keep:
  README.md
  RELEASE_CHECKLIST.md

Review separately before deleting:
  docs/ai-candidate-backlog-and-fair-source-distribution.md
  docs/market-trending-source-rollout.md
  RELEASE_NOTES_NEXT.md
```

Do not mix documentation deletion with runtime code changes. Keep those commits separate so review does not become archaeology with syntax highlighting.

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
  3. npm install --frozen-lockfile
  4. npm run typecheck          ← TypeScript must compile cleanly
  5. wrangler deploy --dry-run  ← Build must succeed
  6. Secret scan             ← Regex check: no API keys in source
```

**Required:** `CLOUDFLARE_API_TOKEN` GitHub secret

### Deploy (`deploy-cloudflare.yml`) — manual trigger only

```yaml
Trigger: workflow_dispatch → input: environment (production)

Steps:
  1. Checkout + install
  2. npm run typecheck
  3. npx npx wrangler deploy --env production
  4. Health check: curl WORKER_URL/health → must return 200
```

**Required GitHub secrets:** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
**Required GitHub variable:** `WORKER_URL`

---

## Validation & Quality Gates

Run validation from the repository root before every production deploy or documentation cleanup commit.

```bash
npm run typecheck
npm test -- --run
npm run build
npm run validate:release
```

Use stricter release validation when production flags are intentionally enabled in `wrangler.toml`:

```bash
RELEASE_STRICT=1 npm run validate:release
```

Recommended release review:

- `git status --short` is clean except for intended files.
- No `.dev.vars*`, secrets, local snapshots, ZIPs, generated diffs, or backup files are staged.
- D1 migrations apply locally before remote.
- `TELEGRAM_FINAL_PUBLISH_ENABLED`, `TELEGRAM_PUBLISH_SCHEDULER_ENABLED`, channel `publish_enabled`, and DB `telegram_publish_enabled` are intentionally reviewed.
- Queue preview matches the expected Telegram message format.
- Raw source URLs are not visible in final messages.
- Link previews are disabled in text fallback paths.
- Production write actions are not run during validation unless explicitly intended.

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
- Media QA scenarios are covered by `npm run validate:media` and a private Telegram test-channel check before broad rollout.

Dashboard styling and structure are intentionally not changed by release hardening. Dashboard changes should remain additive and use the existing `apps/dashboard/index.html` structure unless a separate refactor PR is explicitly approved.

---

<!-- README-PRODUCTION-OPS-ADDENDUM:START -->

## Current Limitations & Next Improvements

The current production system is stable enough to run the crypto pilot, but the following areas still need measurement or future tuning:

- Natural Apify runs must be measured over several rotation windows to confirm whether they can supply enough fresh candidates for 72 posts/day.
- Duplicate rate can still make scrape volume look healthy while producing too few new candidates.
- Source cohorts may need tuning if queue depth stays low after natural runs.
- `whale_alert` is intentionally throttled; it should not be used to fill volume gaps.
- Market snapshot posts are direct sends and should be monitored separately from normal `publish_queue` throughput.
- `APIFY_MAX_ITEMS_PER_SOURCE` and source cadence should be raised only after measuring Apify cost, duplicate rate, AI token cost, and queue creation rate together.
- Cloudflare Stream remains disabled by default; enable it only after explicit cost and reliability review.

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
# Then redeploy: npx npx wrangler deploy --env production

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

## Documentation & Release Hygiene

The README is the durable source of truth for architecture, setup, configuration, API usage, operations, and troubleshooting.

`RELEASE_CHECKLIST.md` should remain separate because it is an operational deployment gate, not general product documentation.

Historical planning documents can be useful while a feature is still being designed, but they should not remain as competing architecture references after the implementation has landed. If a planning document is fully represented in the README and no longer matches production, archive or delete it in a separate documentation-cleanup commit.

Recommended cleanup policy:

```text
Keep:
  README.md
  RELEASE_CHECKLIST.md

Review separately before deleting:
  docs/ai-candidate-backlog-and-fair-source-distribution.md
  docs/market-trending-source-rollout.md
  RELEASE_NOTES_NEXT.md
```

Do not mix documentation deletion with runtime code changes. Keep those commits separate so review does not become archaeology with syntax highlighting.
