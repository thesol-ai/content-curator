# Content Curator

> **Multi-category autonomous content curation system**
> Apify → Cloudflare Worker → Claude AI → Telegram

**→ [راهنمای کامل فارسی](#راهنمای-فارسی)**

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Pipeline Flow](#pipeline-flow)
- [Project Structure](#project-structure)
- [Tech Stack & Cost](#tech-stack--cost)
- [Prerequisites](#prerequisites)
- [Setup Guide](#setup-guide)
- [Configuration Reference](#configuration-reference)
- [Apify Actors](#apify-actors)
- [Telegram Bot & Channels](#telegram-bot--channels)
- [AI Models & Cost Management](#ai-models--cost-management)
- [Dashboard](#dashboard)
- [API Reference](#api-reference)
- [Safety Switches](#safety-switches)
- [Security](#security)
- [GitHub Actions](#github-actions)
- [Troubleshooting](#troubleshooting)
- [Monthly Cost Estimate](#monthly-cost-estimate)
- [راهنمای فارسی](#راهنمای-فارسی)

---

## Overview

Content Curator is a fully automated, multi-category content curation pipeline that:

- **Discovers** posts from Twitter/X, Instagram, and LinkedIn via Apify
- **Deduplicates** content using platform ID, URL hash, and text hash
- **Scores** items using Claude AI (Haiku) for relevance, freshness, and risk
- **Translates** selected items into multiple languages using Gemini or OpenAI (3× cheaper than Claude)
- **Schedules** and **publishes** to Telegram channels with rate-limit compliance
- **Manages** everything through a built-in web dashboard with Setup Wizard

**No Make.com. No Google Sheets. No GitHub Actions for media. No human review required.**

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        APIFY CONSOLE                        │
│   Task: crypto-x      Task: design-ig    Task: mkt-linkedin │
│   Schedule: 0 9,21    Schedule: 0 10     Schedule: 0 10 * 1,4│
│              ↓ webhook (ACTOR.RUN.SUCCEEDED)                │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              CLOUDFLARE WORKER  (Serverless)                │
│                                                             │
│  POST /webhook/apify                                        │
│         │                                                   │
│         ▼ ctx.waitUntil (async — responds 200 immediately)  │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │           CURATION PIPELINE                         │   │
│  │                                                     │   │
│  │  1. Fetch dataset from Apify API                    │   │
│  │  2. Normalize (X / Instagram / LinkedIn / RSS)      │   │
│  │  3. Deduplicate (D1: postId + URL hash + text hash) │   │
│  │  4. AI Gate — Phase 1: Claude Haiku                 │   │
│  │     └─ Score 0-100, Risk level, Priority            │   │
│  │  5. AI Gate — Phase 2: Gemini / OpenAI              │   │
│  │     └─ Translation + Caption (per language)         │   │
│  │  6. Rule Gate: daily quota, time window             │   │
│  │  7. Publish Queue → D1                              │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  CRON  every 30 min                                 │   │
│  │  └─ publishDueItems()                               │   │
│  │     ├─ Check hourly rate limit per channel          │   │
│  │     ├─ Check minimum gap between posts              │   │
│  │     ├─ Optimistic lock (prevents double-send)       │   │
│  │     └─ Telegram Bot API call                        │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
       @crypto_fa      @crypto_en       @design_fa
      (Telegram)       (Telegram)       (Telegram)
```

### Multi-language Architecture

```
Category: crypto
  ├── Channel: crypto_fa  → @channel_fa  (Persian)   ← 10/day, 2/hr
  ├── Channel: crypto_en  → @channel_en  (English)   ← 12/day, 2/hr
  └── Channel: crypto_ar  → @channel_ar  (Arabic)    ← 8/day, 2/hr

Category: design
  └── Channel: design_fa  → @channel_fa  (Persian)   ← 6/day, 1/hr

One source item → scored once → translated N times → N queue rows
```

---

## Pipeline Flow

```
Apify run finishes
        │
        ▼
Worker receives webhook (POST /webhook/apify)
        │ returns 200 immediately
        │ ctx.waitUntil → async processing
        ▼
fetchApifyDataset(datasetId, apifyToken, maxItems)
        │
        ▼
normalizeItem(raw, platform)
  X:         url, text, author.userName, createdAt, media[]
  Instagram: url, displayUrl, videoUrl, childPosts[], caption, ownerUsername
  LinkedIn:  linkedinUrl, content, postImages[], postVideo, postedAt.timestamp
        │
        ▼
Deduplicate — for each item compute:
  Key 1: "pid:{platform}:{postId}"          ← exact match
  Key 2: "url:{stableHash(normalizedUrl)}"  ← URL-based
  Key 3: "txt:{stableHash(text[0:200])}"    ← content-based
  → check D1 dedupe_keys table (72h window)
        │
        ▼  only new items continue
Phase 1 — Claude Haiku (scoring only):
  Input:  items[].{url, platform, text[0:400], likes, has_media}
  Output: items[].{score:0-100, risk_level, risk_flags, publish_priority}
  Cost:   ~2,000 output tokens per run
        │
        ▼  only items with score >= threshold continue
Phase 2 — Gemini / OpenAI (translation):
  Input:  selected items + language targets
  Output: per-language {caption_short ≤900, caption_full ≤3500, hashtags[]}
  Cost:   ~90,000 output tokens per run (3× cheaper with Gemini Flash-Lite)
        │
        ▼
Rule Gate — per channel:
  ✓ daily quota not exceeded
  ✓ translation exists for channel language
  ✓ risk_level ≠ high
  → compute scheduledAt based on priority + mediaUrlExpiresSoon
        │
        ▼
Save to publish_queue (D1)
  telegram_method: sendMediaGroup | sendPhoto | sendVideo | sendMessage
        │
  Cron every 30 min
        ▼
publishDueItems():
  → check hourly rate limit per channel
  → check min_gap_minutes
  → optimistic lock (UPDATE WHERE status='scheduled')
  → Telegram Bot API call
  → retry on failure (max 3 times, 30min apart)
```

### Media Handling

```
Item has media?
    │
    ├─ 0 media → sendMessage (text only)
    ├─ 1 image → sendPhoto  (image + caption ≤1024 chars)
    ├─ 1 video → sendVideo  (if size ≤50MB, duration ≤5min)
    │            otherwise → sendMessageWithLink
    └─ 2-10 → sendMediaGroup (album, caption on first item)

Instagram/LinkedIn media URLs expire in hours → mediaUrlExpiresSoon=true
  → scheduledAt capped at 1 hour (not 2-6 hours)
  → Telegram fetches URL before it expires

Telegram limits:
  - photo: max 5MB, video: max 50MB (via URL)
  - sendMediaGroup: 10 items = 10 rate-limit units
  - Bot API: 30 msg/sec global, 1 msg/sec per chat
  - This system: max 2 posts/hour/channel → well within limits
```

---

## Project Structure

```
content-curator/
├── .gitignore                        ← secrets, node_modules, .wrangler
├── .env.example                      ← variable reference (no real values)
├── package.json                      ← root scripts, devDependencies
├── pnpm-workspace.yaml               ← monorepo config
├── tsconfig.json                     ← TypeScript base config
├── wrangler.toml                     ← Cloudflare Worker config
│
├── apps/
│   ├── worker-api/
│   │   ├── package.json              ← @curator/worker package
│   │   ├── tsconfig.json             ← extends root tsconfig
│   │   └── src/
│   │       ├── index.ts              ← Worker entry: fetch + scheduled
│   │       ├── types.ts              ← Env interface, all shared types
│   │       ├── routes/
│   │       │   ├── health.ts         ← GET /health (public), GET /status (public)
│   │       │   ├── apify-webhook.ts  ← POST /webhook/apify (secret-protected)
│   │       │   └── admin.ts          ← All /internal/* endpoints
│   │       └── services/
│   │           ├── apify-client.ts   ← Fetch + normalize (X/IG/LinkedIn/RSS)
│   │           ├── dedupe.ts         ← stableHash, isDuplicate, recordDedupeKeys
│   │           ├── ai-gate.ts        ← Phase 1: Claude scoring, Phase 2: translation
│   │           ├── rule-gate.ts      ← Quota, time windows, scheduledAt
│   │           ├── media-resolver.ts ← Select telegram method, buildMediaGroupPayload
│   │           ├── telegram-publisher.ts ← Bot API calls, retry logic
│   │           └── curation-orchestrator.ts ← Pipeline coordinator
│   │
│   └── dashboard/
│       ├── config.js                 ← API URL (no secrets here)
│       └── index.html                ← Single-file dashboard (no build needed)
│
├── migrations/
│   ├── 0001_core.sql                 ← All 10 D1 tables
│   └── 0002_seed_categories.sql      ← Default category seeds
│
└── .github/
    └── workflows/
        ├── ci.yml                    ← Typecheck + build validation + secret scan
        └── deploy-cloudflare.yml     ← Manual deploy to production
```

---

## Tech Stack & Cost

| Layer | Technology | Monthly Cost |
|-------|-----------|-------------|
| Compute | Cloudflare Workers | Free (100K req/day) |
| Database | Cloudflare D1 (SQLite) | Free (5GB) |
| Discovery | Apify (Twitter Kaito) | ~$3–11 |
| Discovery | Apify (Instagram) | ~$3–16 |
| Discovery | Apify (LinkedIn) | ~$1–3 |
| AI Scoring | Claude Haiku | ~$2–5 |
| AI Translation | Gemini 2.5 Flash-Lite | ~$2–4 |
| Delivery | Telegram Bot API | Free |
| Dashboard | Cloudflare Pages | Free |
| **Total** | | **~$11–39** |

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 22 | [nodejs.org](https://nodejs.org) |
| pnpm | ≥ 9.15 | `npm i -g pnpm` |
| Wrangler | ≥ 3.114 | `npm i -g wrangler` |

**Required accounts:**
- [Cloudflare](https://dash.cloudflare.com) (free)
- [Apify](https://console.apify.com) (pay-per-result)
- [Anthropic](https://console.anthropic.com) (Claude API)
- [Google AI Studio](https://aistudio.google.com) (Gemini API — or OpenAI)
- Telegram (Bot from @BotFather)

---

## Setup Guide

### Step 1 — Clone & Install

```bash
git clone https://github.com/YOUR_ORG/content-curator.git
cd content-curator
pnpm install
```

### Step 2 — Cloudflare Login

```bash
wrangler login
# Opens browser for OAuth
```

### Step 3 — Create D1 Database

```bash
wrangler d1 create content-curator-db
```

Copy the `database_id` from the output and replace `00000000-0000-0000-0000-000000000000` in **both** `[[d1_databases]]` blocks in `wrangler.toml`.

### Step 4 — Run Migrations

```bash
# Local test first
pnpm db:migrate:local

# Remote production
pnpm db:migrate:remote
```

Verify:
```bash
wrangler d1 execute content-curator-db --remote --env production \
  --command "SELECT name FROM sqlite_master WHERE type='table';"
# Expected: 10 tables
```

### Step 5 — Set Secrets

```bash
# Claude API (required for scoring)
wrangler secret put ANTHROPIC_API_KEY --env production

# Translation provider — choose ONE:
wrangler secret put GEMINI_API_KEY --env production    # recommended (cheapest)
# OR
wrangler secret put OPENAI_API_KEY --env production    # alternative

# Platform tokens
wrangler secret put APIFY_TOKEN --env production
wrangler secret put TELEGRAM_BOT_TOKEN --env production

# Dashboard auth
wrangler secret put INTERNAL_API_SECRET --env production
# Generate with: openssl rand -hex 32
```

> **Security:** Secrets are stored encrypted in Cloudflare's infrastructure. Never put real values in `wrangler.toml` or any file that could be committed.

### Step 6 — Configure wrangler.toml

```toml
# Set these vars in wrangler.toml [env.production.vars]:

TRANSLATION_PROVIDER = "gemini"            # or "openai" or "claude"
TRANSLATION_MODEL    = "gemini-2.5-flash-lite"
AI_SCORING_MODEL     = "claude-haiku-4-5-20251001"
```

### Step 7 — Deploy Worker

```bash
pnpm typecheck    # must pass before deploy
pnpm deploy       # deploys to production
```

Worker URL: `https://content-curator.YOUR_ACCOUNT.workers.dev`

### Step 8 — Verify Deployment

```bash
curl https://content-curator.YOUR_ACCOUNT.workers.dev/health
# {"ok":true,"status":"healthy","db":"connected","environment":"production"}
```

### Step 9 — Open Dashboard

1. Open `apps/dashboard/index.html` in browser (or deploy to Cloudflare Pages)
2. Enter your Worker URL and `INTERNAL_API_SECRET`
3. Click **Setup Wizard** in the sidebar for guided configuration

### Step 10 — Telegram Bot Setup

```bash
# 1. Open @BotFather in Telegram
# 2. /newbot → choose name and username
# 3. Copy the token → wrangler secret put TELEGRAM_BOT_TOKEN

# 4. Add bot as Admin to your channel
#    Settings → Administrators → Add → your_bot
#    Required permission: Post Messages

# 5. Get your channel's Chat ID:
curl "https://api.telegram.org/botYOUR_TOKEN/getChat?chat_id=@your_channel"
# Look for "id" in response: -1001234567890
```

### Step 11 — Add Categories (via Dashboard or SQL)

```sql
INSERT INTO categories (id, label, prompt_profile, score_threshold, freshness_hours, media_mode, language_targets)
VALUES
  ('crypto',    'کریپتو',    'crypto_editorial',    80, 24,  'optional',  '["fa","en"]'),
  ('design',    'دیزاین',    'design_editorial',    70, 168, 'preferred', '["fa"]'),
  ('marketing', 'مارکتینگ',  'marketing_editorial', 75, 72,  'optional',  '["fa","en"]');
```

Or via Dashboard → Categories → ＋ Add Category

### Step 12 — Add Channels

```bash
# Via API:
curl -X POST https://your-worker.workers.dev/internal/channels \
  -H "x-internal-api-secret: YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "crypto_fa",
    "category_id": "crypto",
    "telegram_chat_id": "@your_channel",
    "language": "fa",
    "timezone": "Asia/Tehran",
    "max_per_day": 10,
    "max_per_hour": 2,
    "min_gap_minutes": 30,
    "allowed_windows": ["08:00-00:00"],
    "blocked_windows": ["00:00-08:00"]
  }'
```

**Note:** Channels start with `publish_enabled=0`. Enable only after testing.

### Step 13 — Configure Apify

For each platform/category, create an Apify Task:

**Twitter/X Task:**
```json
{
  "Actor": "kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest",
  "Input": {
    "twitterHandles": ["coindesk", "cz_binance", "VitalikButerin"],
    "maxItems": 30,
    "addUserInfo": false
  },
  "Schedule": "0 9,21 * * *"
}
```

**Instagram Task:**
```json
{
  "Actor": "apify/instagram-post-scraper",
  "Input": {
    "directUrls": ["https://www.instagram.com/coindesk/"],
    "resultsLimit": 10
  },
  "Schedule": "0 10 * * *"
}
```

**LinkedIn Task:**
```json
{
  "Actor": "harvestapi/linkedin-profile-posts",
  "Input": {
    "profileUrls": ["https://www.linkedin.com/in/naval"],
    "maxPostsPerProfile": 5,
    "scrapeReactions": false,
    "scrapeComments": false
  },
  "Schedule": "0 10 * * 1,4"
}
```

**Webhook for each Task** (Apify Console → Task → Integrations → Webhooks):
```
Event:   ACTOR.RUN.SUCCEEDED
URL:     https://your-worker.workers.dev/webhook/apify?secret=YOUR_INTERNAL_SECRET
Method:  POST
Payload: {"datasetId": "{{resource.defaultDatasetId}}", "platform": "x"}
```

Change `"platform"` to `"x"`, `"instagram"`, or `"linkedin"` per task.

### Step 14 — Register Dataset IDs

After each Task's first run, copy the Dataset ID from Apify:

```bash
curl -X POST https://your-worker.workers.dev/internal/apify-sources \
  -H "x-internal-api-secret: YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "category_id": "crypto",
    "platform": "x",
    "apify_dataset_id": "ABC123xyz...",
    "label": "Crypto Twitter"
  }'
```

### Step 15 — Activation Sequence

Follow this **exact order** — never enable everything at once:

```
Phase 1  APIFY_CURATION_ENABLED=false  DRY_RUN=true   PUBLISH=false
         → Setup complete, verify config

Phase 2  APIFY_CURATION_ENABLED=true   DRY_RUN=true   PUBLISH=false
         → Claude scores items, check scoring quality
         → curl .../internal/items?status=ai_selected

Phase 3  APIFY_CURATION_ENABLED=true   DRY_RUN=false  PUBLISH=false
         → Queue fills up, verify scheduled_at and methods
         → curl .../internal/queue?status=scheduled

Phase 4  APIFY_CURATION_ENABLED=true   DRY_RUN=false  PUBLISH=true
         → Enable ONE test channel (publish_enabled=1)
         → Watch a private test channel for 24h

Phase 5  Enable public channels one by one
         → Monitor for a week before enabling all
```

---

## Configuration Reference

### wrangler.toml Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `APIFY_CURATION_ENABLED` | `false` | Enable the entire pipeline |
| `APIFY_CURATION_DRY_RUN` | `true` | Score but don't queue |
| `APIFY_MAX_ITEMS_PER_SOURCE` | `100` | Items to fetch per Apify dataset |
| `AI_SCORING_MODEL` | `claude-haiku-4-5-20251001` | Claude model for scoring |
| `AI_SCORE_THRESHOLD_DEFAULT` | `75` | Minimum score (0-100) |
| `AI_MAX_CALLS_PER_DAY` | `10` | Claude API calls per day limit |
| `AI_DAILY_TOKEN_BUDGET` | `50000` | Claude tokens per day limit |
| `AI_MAX_CANDIDATES_PER_RUN` | `50` | Items sent to Claude per run |
| `AI_MAX_TEXT_CHARS_PER_ITEM` | `400` | Text chars sent to AI per item |
| `AI_MAX_RETRIES` | `1` | AI call retry count |
| `TRANSLATION_PROVIDER` | `gemini` | `gemini` \| `openai` \| `claude` |
| `TRANSLATION_MODEL` | `gemini-2.5-flash-lite` | Translation model name |
| `TELEGRAM_FINAL_PUBLISH_ENABLED` | `false` | Enable actual sending |
| `TELEGRAM_PUBLISH_SCHEDULER_ENABLED` | `false` | Enable cron publisher |
| `TELEGRAM_PUBLISH_DUE_LIMIT` | `5` | Items to publish per cron run |
| `MEDIA_PROCESSING_MODE` | `direct_url` | Always `direct_url` for Apify |

### Secrets (via `wrangler secret put`)

| Secret | Required | Description |
|--------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key (scoring) |
| `GEMINI_API_KEY` | If provider=gemini | Google Gemini API key |
| `OPENAI_API_KEY` | If provider=openai | OpenAI API key |
| `APIFY_TOKEN` | Yes | Apify API token |
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `INTERNAL_API_SECRET` | Yes | Dashboard auth (≥32 chars) |

### D1 Tables

| Table | Purpose |
|-------|---------|
| `categories` | Category definitions (id, prompt_profile, threshold, languages) |
| `channels` | Telegram channels (language, rate limits, time windows) |
| `source_accounts` | Whitelisted accounts for AI scoring boost |
| `apify_sources` | Dataset ID → category/platform mapping |
| `discovery_runs` | Log of each Apify pipeline run |
| `discovery_items` | Individual posts after AI scoring |
| `discovery_media` | Media URLs per post |
| `dedupe_keys` | 72h deduplication window |
| `publish_queue` | Scheduled posts awaiting Telegram delivery |
| `settings` | Runtime toggles (override env vars) |

---

## Apify Actors

### Twitter/X — `kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest`

**Price:** $0.25 / 1,000 tweets

**Input schema:**
```json
{
  "twitterHandles": ["handle1", "handle2"],
  "maxItems": 30,
  "addUserInfo": false
}
```

**Key output fields used:**
```
url / twitterUrl          → post URL
text / full_text          → tweet text
author.userName           → handle
createdAt                 → timestamp (ISO)
likeCount, retweetCount   → engagement
viewCount                 → views
media[].media_url_https   → media URL (⚠ test with a tweet that has images)
media[].type              → "photo" | "video" | "animated_gif"
```

> **Note:** Twitter media URLs are generally stable. Test with an image-containing tweet before relying on media delivery.

**Recommended schedule:** `0 */6 * * *` (every 6 hours for breaking news)

---

### Instagram — `apify/instagram-post-scraper`

**Price:** $1.70 / 1,000 posts

**Input schema:**
```json
{
  "directUrls": ["https://www.instagram.com/username/"],
  "resultsLimit": 10
}
```

**Key output fields used:**
```
url                       → post URL
shortCode / id            → post ID
displayUrl                → image URL (⚠ EXPIRES in hours!)
videoUrl                  → Reel URL  (⚠ EXPIRES in hours!)
childPosts[].displayUrl   → carousel images
childPosts[].videoUrl     → carousel videos
caption                   → post text
ownerUsername             → handle
timestamp                 → ISO timestamp
likesCount, videoViewCount → engagement
```

> **⚠ CDN Expiry:** Instagram URLs (`scontent.cdninstagram.com`) expire in **a few hours to 2 days**. The system automatically flags `mediaUrlExpiresSoon=true` and caps `scheduledAt` to max 1 hour, so Telegram fetches the URL before it expires.

> **Carousel:** All slides sent as `sendMediaGroup` (up to 10 items).

**Recommended schedule:** `0 10 * * *` (once daily)

---

### LinkedIn — `harvestapi/linkedin-profile-posts`

**Price:** $2.00 / 1,000 posts

**Input schema:**
```json
{
  "profileUrls": ["https://www.linkedin.com/in/username"],
  "maxPostsPerProfile": 5,
  "scrapeReactions": false,
  "scrapeComments": false
}
```

**Key output fields used:**
```
linkedinUrl               → post URL
content / text            → post text
author.publicIdentifier   → handle
postedAt.timestamp        → ms timestamp (÷1000 for unix)
postImages[].url          → image URL (⚠ has expiresAt!)
postImages[].expiresAt    → expiry timestamp
postVideo.videoUrl        → video URL  (⚠ has expiry!)
document.coverPages       → PDF carousel images
engagement.likes/shares   → metrics
```

> **⚠ URL Expiry:** LinkedIn media has explicit `expiresAt` timestamps (~24-48h). System flags as `mediaUrlExpiresSoon=true`.

**Recommended schedule:** `0 10 * * 1,4` (Monday and Thursday)

---

## Telegram Bot & Channels

### Bot Setup

1. Message `@BotFather` → `/newbot`
2. Choose name and username
3. Copy token → `wrangler secret put TELEGRAM_BOT_TOKEN --env production`
4. Add bot as channel Admin with **"Post Messages"** permission

### Getting Chat ID

```bash
# For a public channel:
curl "https://api.telegram.org/bot{TOKEN}/getChat?chat_id=@channel_username"
# Returns: "id": -1001234567890

# For a private channel: Add bot, post a message, then:
curl "https://api.telegram.org/bot{TOKEN}/getUpdates"
```

### Rate Limits

| Limit | Value | This System |
|-------|-------|-------------|
| Global (all chats) | 30 msg/sec | max 1 per 30min |
| Per channel | 1 msg/sec | max 2/hr = safe |
| sendMediaGroup 10 items | uses 10 quota units | handled by min_gap |
| 429 Too Many Requests | retry after `retry_after` | 3 retries × 30min |

### Time Windows

```json
{
  "allowed_windows": ["08:00-00:00"],
  "blocked_windows": ["00:00-08:00"],
  "max_per_day": 10,
  "max_per_hour": 2,
  "min_gap_minutes": 30
}
```

For global English audiences:
```json
{
  "allowed_windows": ["00:00-23:59"],
  "max_per_day": 12,
  "max_per_hour": 2,
  "min_gap_minutes": 20
}
```

### Telegram Message Methods

| Method | When | Caption limit |
|--------|------|--------------|
| `sendMessage` | No media | 4096 chars |
| `sendPhoto` | 1 image | 1024 chars on photo, separate msg for rest |
| `sendVideo` | 1 video ≤50MB | 1024 chars on video |
| `sendMediaGroup` | 2-10 images/videos | 1024 chars on first item |
| `sendMessageWithLink` | Expired/heavy media | 4096 chars + source link |

---

## AI Models & Cost Management

### Two-Phase AI Architecture

```
Phase 1 — Claude Haiku (scoring only)
  Input:  all new items (text + metadata)
  Task:   score 0-100, risk level, publish priority
  Output: ~2,000 tokens per run
  Cost:   $0.80 input / $4.00 output per 1M tokens

Phase 2 — Gemini / OpenAI (translation + captions)
  Input:  only selected items (score >= threshold)
  Task:   write captions in N languages
  Output: ~90,000 tokens per run (3× the cost driver)
  Cost:   depends on provider chosen
```

### Translation Provider Comparison

| Provider | Model | Output/1M | 90K tokens cost | Quality |
|----------|-------|-----------|-----------------|---------|
| **Gemini** | `gemini-2.5-flash-lite` | $0.40 | **$0.04** | Good |
| **Gemini** | `gemini-2.5-flash` | $2.50 | $0.23 | Better |
| **OpenAI** | `gpt-4.1-nano` | $0.40 | $0.04 | Good |
| **OpenAI** | `gpt-4o-mini` | $0.60 | $0.05 | Better |
| Claude | `claude-haiku-4-5` | $4.00 | $0.36 | Best |

**Recommendation:** Start with `gemini-2.5-flash-lite`. Upgrade to `gemini-2.5-flash` if Persian caption quality is insufficient.

### Budget Controls

```toml
AI_MAX_CALLS_PER_DAY     = "10"     # Claude scoring calls
AI_DAILY_TOKEN_BUDGET    = "50000"  # Claude tokens total
AI_MAX_CANDIDATES_PER_RUN = "50"   # items sent to Claude
```

The system stops calling Claude when either limit is hit.

### Available Models

**Gemini (Google):**
- `gemini-2.5-flash-lite` — cheapest ($0.10/$0.40 per 1M)
- `gemini-2.5-flash` — balanced ($0.30/$2.50 per 1M)
- `gemini-2.5-pro` — most capable ($1.25/$10 per 1M)
- `gemini-3.1-flash-lite` — newest cheap option

**OpenAI:**
- `gpt-4.1-nano` — cheapest ($0.10/$0.40 per 1M)
- `gpt-4o-mini` — popular ($0.15/$0.60 per 1M)
- `gpt-4.1-mini` — better ($0.40/$1.60 per 1M)

**Claude (scoring only, recommended):**
- `claude-haiku-4-5-20251001` — fast & cheap ($0.80/$4.00 per 1M)
- `claude-sonnet-4-6` — more capable ($3.00/$15 per 1M)

---

## Dashboard

The dashboard is a **single HTML file** — no build, no dependencies.

### Deploy to Cloudflare Pages

1. Cloudflare Dashboard → Pages → Create application → Connect to Git
2. Settings:
   ```
   Framework preset:  None
   Build command:     (empty)
   Build output dir:  apps/dashboard
   Root directory:    (empty)
   ```
3. Deploy → URL: `https://curator-dash.pages.dev`

### First Login

The dashboard asks for:
- **Worker API URL** — `https://content-curator.YOUR_ACCOUNT.workers.dev`
- **Internal API Secret** — the `INTERNAL_API_SECRET` you set

Credentials are stored in browser `localStorage`. They are only sent as an HTTP header to your own Worker.

### Dashboard Pages

| Page | Description |
|------|-------------|
| **Overview** | Stats, queue preview, channel status |
| **Publish Queue** | Scheduled/failed/published items, cancel |
| **Discovery Runs** | Pipeline run history, manual trigger |
| **Content Items** | AI-selected and AI-rejected items |
| **Categories** | CRUD, language targets, prompt profiles |
| **Channels** | Per-channel pause/resume, rate limits |
| **Source Accounts** | Whitelisted accounts |
| **Apify Datasets** | Dataset ID mappings, webhook URL |
| **AI Settings** | Provider selection, cost calculator |
| **System Switches** | Global on/off toggles |
| **Connection** | API URL and secret management |

### Setup Wizard (7 Steps)

1. Welcome — connection verified
2. Create Category — preset or custom
3. Add Channel — Telegram chat ID + rate limits
4. Apify Dataset — paste Dataset ID
5. Source Accounts — whitelist accounts
6. Dry-run Test — verify pipeline
7. Activation — enable step by step

---

## API Reference

All `/internal/*` endpoints require header: `x-internal-api-secret: YOUR_SECRET`

### Public Endpoints

```
GET  /health          → system health (200 or 503)
GET  /status          → category/channel/queue counts
POST /webhook/apify?secret=XXX  → Apify webhook receiver
```

### Monitoring

```
GET /internal/stats
GET /internal/runs?category=crypto&limit=20
GET /internal/items?status=ai_selected&category=crypto&platform=x&limit=50
GET /internal/queue?status=scheduled&channel=crypto_fa&limit=50
```

**Valid `status` values for items:** `ai_selected`, `ai_rejected`, `queued`, `duplicate`, `error`
**Valid `status` values for queue:** `scheduled`, `published`, `failed`, `retry`, `cancelled`

### Control

```
POST /internal/curation/trigger
Body: {"dryRun": true, "force": true}

POST /internal/admin/toggle
Body: {"key": "telegram_publish_enabled", "value": "true"}

GET  /internal/admin/settings
```

**Toggle keys:** `telegram_publish_enabled`, `apify_curation_enabled`, `apify_curation_dry_run`, `maintenance_mode`

### Categories

```
GET    /internal/categories
POST   /internal/categories
       Body: {id, label, prompt_profile, score_threshold, freshness_hours, media_mode, language_targets}
PATCH  /internal/categories/:id
       Body: {score_threshold?, freshness_hours?, media_mode?, language_targets?, enabled?, prompt_profile?}
```

### Channels

```
GET    /internal/channels?category=crypto
POST   /internal/channels
       Body: {id, category_id, telegram_chat_id, language, timezone, max_per_day, max_per_hour, min_gap_minutes, allowed_windows, blocked_windows}
PATCH  /internal/channels/:id
POST   /internal/channels/:id/publish
       Body: {"enabled": true}
```

### Sources & Datasets

```
GET    /internal/source-accounts?category=crypto
POST   /internal/source-accounts
       Body: {category_id, platform, account_handle, display_name?, trust_level}
DELETE /internal/source-accounts/:id

GET    /internal/apify-sources
POST   /internal/apify-sources
       Body: {category_id, platform, apify_dataset_id, label?}
DELETE /internal/apify-sources/:id

DELETE /internal/queue/:id    → cancel scheduled item
```

---

## Safety Switches

```
APIFY_CURATION_ENABLED = false     → entire pipeline off
APIFY_CURATION_DRY_RUN = true      → score but don't queue
TELEGRAM_FINAL_PUBLISH_ENABLED = false  → no Telegram sends
TELEGRAM_PUBLISH_SCHEDULER_ENABLED = false  → cron doesn't publish
channels.publish_enabled = 0       → per-channel pause
maintenance_mode = true            → emergency stop all
```

**Emergency stop:**
```bash
curl -X POST .../internal/admin/toggle \
  -H "x-internal-api-secret: SECRET" \
  -d '{"key": "telegram_publish_enabled", "value": "false"}'

curl -X POST .../internal/admin/toggle \
  -H "x-internal-api-secret: SECRET" \
  -d '{"key": "apify_curation_enabled", "value": "false"}'
```

---

## Security

### What is Protected

| Endpoint | Protection |
|----------|-----------|
| `/health`, `/status` | Public — no sensitive data |
| `/webhook/apify` | `?secret=` query param (compare-safe) |
| `/internal/*` | `x-internal-api-secret` header |
| Dashboard | Same `INTERNAL_API_SECRET` stored in localStorage |

### What is Never Exposed

- API keys are only in Cloudflare encrypted secrets
- `/health` returns only: ok, db status, environment, timestamp
- Error messages from `admin.ts` return generic `"internal_server_error"` (not stack traces)
- Telegram bot token is redacted from any error logs

### Input Validation

All admin endpoints validate:
- IDs: `/^[\w-]{1,64}$/`
- Platform: whitelist `['x', 'instagram', 'linkedin', 'rss']`
- Telegram chat ID: must start with `@` or `-` (number)
- Language codes: `/^[a-z]{2}$/`
- Time windows: `/^\d{2}:\d{2}-\d{2}:\d{2}$/` per entry
- Score threshold: clamped 0-100
- All SQL uses parameterized queries

### Git Security

`.gitignore` covers:
```
.env, .env.local, .env.production
.wrangler/
*.key, *.pem
node_modules/
```

CI workflow scans for common API key patterns before build.

---

## GitHub Actions

### CI (`ci.yml`) — Runs on PR and push to main/dev

```yaml
Steps:
  1. Checkout
  2. Setup Node 22 + pnpm
  3. pnpm install --frozen-lockfile
  4. pnpm typecheck          ← TypeScript must compile
  5. wrangler deploy --dry-run  ← Build must succeed
  6. Secret scan             ← No API keys in code
```

**Required GitHub Secrets for CI:**
- `CLOUDFLARE_API_TOKEN` (needed even for dry-run)

### Deploy (`deploy-cloudflare.yml`) — Manual trigger only

```yaml
Trigger: workflow_dispatch
  Input: environment (production)

Steps:
  1. Checkout + install
  2. pnpm typecheck
  3. wrangler deploy --env production
  4. Health check verification
```

**Required GitHub Secrets for Deploy:**
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

**Required GitHub Variables:**
- `WORKER_URL` — your worker hostname for health check

### Adding GitHub Secrets

```
Repository → Settings → Secrets and variables → Actions → New repository secret
```

---

## Troubleshooting

### Items not arriving from Apify

```bash
# 1. Check apify sources are registered
curl .../internal/apify-sources -H "x-internal-api-secret: SECRET"

# 2. Trigger manually with force
curl -X POST .../internal/curation/trigger \
  -H "x-internal-api-secret: SECRET" \
  -d '{"dryRun": true, "force": true}'

# 3. Check run error_message
curl ".../internal/runs?limit=3" -H "..."
```

### Claude scoring all rejected

```bash
# Check ai_rejected items for clues
curl ".../internal/items?status=ai_rejected&limit=20" -H "..."
# Look at ai_score values

# Temporarily lower threshold
curl -X PATCH .../internal/categories/crypto -H "..." \
  -d '{"score_threshold": 60}'
```

### Instagram media expired before publish

```bash
# Lower min_gap_minutes for the channel
curl -X PATCH .../internal/channels/crypto_fa -H "..." \
  -d '{"min_gap_minutes": 10}'

# OR increase publish frequency (more posts/hour)
curl -X PATCH .../internal/channels/crypto_fa -H "..." \
  -d '{"max_per_hour": 3}'
```

### Telegram 429 Too Many Requests

The system retries automatically. If persistent:
```bash
# Check failed queue items
curl ".../internal/queue?status=failed&limit=10" -H "..."
# Look at publish_error field

# Reset failed items to retry
# (cancel and re-trigger, or wait 30min for auto-retry)
```

### Translation quality poor

```bash
# Switch to a better model in wrangler.toml:
TRANSLATION_MODEL = "gemini-2.5-flash"  # instead of flash-lite
# Then redeploy: pnpm deploy
```

### Worker responds slowly or times out

Cloudflare Workers have a 30-second CPU time limit (free plan) and 30-second wall time.
The webhook responds immediately (`ctx.waitUntil`) so Apify won't timeout.
If curation takes too long, reduce `AI_MAX_CANDIDATES_PER_RUN`.

---

## Monthly Cost Estimate

### Scenario: 3 categories, 6 channels (fa+en), 3 platforms

| Service | Volume | Cost |
|---------|--------|------|
| Cloudflare Workers | 100K+ req/day | **$0** |
| Cloudflare D1 | <5GB | **$0** |
| Cloudflare Pages | Dashboard | **$0** |
| Apify Twitter (Kaito) | ~45K tweets | ~$11 |
| Apify Instagram | ~9K posts | ~$15 |
| Apify LinkedIn | ~600 posts | ~$1.20 |
| Claude Haiku (scoring) | ~450 runs/mo | ~$3 |
| Gemini Flash-Lite (translation) | ~450 runs/mo | ~$2 |
| Telegram Bot | — | **$0** |
| **Total** | | **~$32** |

### Cost Reduction Tips

- Reduce `APIFY_MAX_ITEMS_PER_SOURCE` to 30-50
- Increase `AI_SCORE_THRESHOLD_DEFAULT` to 80 (fewer translations)
- Use `gemini-2.5-flash-lite` for translation (not flash or pro)
- Run Apify tasks less frequently (once daily instead of twice)
- Reduce `AI_MAX_CANDIDATES_PER_RUN` to 30

---

---

# راهنمای فارسی

> **[↑ Back to English documentation](#table-of-contents)**

---

## فهرست مطالب

- [معرفی](#معرفی)
- [معماری سیستم](#معماری-سیستم)
- [جریان پایپ‌لاین](#جریان-پایپلاین)
- [پیش‌نیازها](#پیش‌نیازها)
- [راهنمای راه‌اندازی](#راهنمای-راه‌اندازی)
- [تنظیمات Apify](#تنظیمات-apify)
- [ربات تلگرام](#ربات-تلگرام)
- [مدیریت هزینه AI](#مدیریت-هزینه-ai)
- [داشبورد](#داشبورد)
- [کنترل و مدیریت](#کنترل-و-مدیریت)
- [امنیت](#امنیت)
- [رفع مشکلات](#رفع-مشکلات)
- [هزینه ماهانه](#هزینه-ماهانه)

---

## معرفی

Content Curator یک سیستم کیورِیشن محتوای خودکار چندکتگوری است که:

- محتوا را از **Twitter/X، Instagram و LinkedIn** از طریق Apify جمع‌آوری می‌کند
- محتوای تکراری را با سه روش مختلف حذف می‌کند
- آیتم‌ها را با **Claude AI** امتیازدهی و ریسک‌سنجی می‌کند
- ترجمه و caption را با **Gemini یا OpenAI** می‌نویسد (۳× ارزان‌تر از Claude)
- در **کانال‌های تلگرام** به صورت برنامه‌ریزی‌شده منتشر می‌کند
- یک **داشبورد وب** با Setup Wizard برای مدیریت آسان دارد

**بدون Make.com، بدون Google Sheets، بدون GitHub Actions برای media، بدون review انسانی.**

---

## معماری سیستم

```
┌─────────────────────────────────────────────────────────────┐
│                      APIFY CONSOLE                          │
│  Task کریپتو Twitter     Task دیزاین IG    Task لینکدین    │
│  هر ۶ ساعت              روزی یکبار        دوبار هفته       │
│           ↓ webhook (ACTOR.RUN.SUCCEEDED)                   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│           CLOUDFLARE WORKER (Serverless)                    │
│                                                             │
│  POST /webhook/apify → ctx.waitUntil (async)                │
│                                                             │
│  ۱. Fetch dataset از Apify API                             │
│  ۲. Normalize (فرمت مشترک برای همه پلتفرم‌ها)              │
│  ۳. Deduplicate (D1: postId + URL hash + text hash)         │
│  ۴. AI Gate مرحله ۱ → Claude Haiku (scoring + risk)         │
│  ۵. AI Gate مرحله ۲ → Gemini/OpenAI (ترجمه + caption)       │
│  ۶. Rule Gate (quota روزانه، time window)                   │
│  ۷. Publish Queue → D1                                      │
│                                                             │
│  Cron هر ۳۰ دقیقه → بررسی صف → ارسال به تلگرام            │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
         @crypto_fa      @crypto_en      @design_fa
```

### مدیریت چندزبانه

```
Category: crypto
  ├── Channel: crypto_fa  → @کانال_فارسی  (فارسی)    ← ۱۰/روز، ۲/ساعت
  ├── Channel: crypto_en  → @channel_en   (انگلیسی)   ← ۱۲/روز، ۲/ساعت
  └── Channel: crypto_ar  → @قناة_عربي    (عربی)      ← ۸/روز، ۲/ساعت

Category: design
  └── Channel: design_fa  → @کانال_دیزاین (فقط فارسی) ← ۶/روز، ۱/ساعت

یک آیتم از Apify ← یک بار scoring ← N بار ترجمه ← N ردیف در queue
```

---

## جریان پایپ‌لاین

### مرحله ۱ — جمع‌آوری

Apify هر Task را بر اساس schedule اجرا می‌کند. بعد از تمام شدن، webhook به Worker ارسال می‌شود. Worker بلافاصله ۲۰۰ OK برمی‌گرداند (تا Apify timeout نشود) و پردازش را async ادامه می‌دهد.

### مرحله ۲ — Normalize

هر پلتفرم فیلدهای متفاوتی دارد:

```
Twitter:   url ← url/twitterUrl, text ← text/full_text, media ← media[]
Instagram: url ← url, image ← displayUrl (⚠ expire می‌شود!), carousel ← childPosts[]
LinkedIn:  url ← linkedinUrl, text ← content, images ← postImages[] (⚠ expire می‌شود!)
```

### مرحله ۳ — Deduplicate

سه کلید برای هر آیتم:
- `pid:{platform}:{postId}` — دقیق‌ترین
- `url:{hash(normalizedUrl)}` — URL-based
- `txt:{hash(text[0:200])}` — برای بازنشر در پلتفرم‌های مختلف

پنجره زمانی: ۷۲ ساعت

### مرحله ۴ — AI Gate (دو فاز جداگانه)

**فاز ۱ — Claude Haiku (فقط scoring):**
- Input: همه آیتم‌های جدید + metadata
- Output: score 0-100، risk_level، publish_priority
- هزینه: ~۲۰۰۰ output token per run

**فاز ۲ — Gemini/OpenAI (فقط translation):**
- Input: فقط آیتم‌هایی که score بالا دارند
- Output: caption_short (≤۹۰۰ کاراکتر)، caption_full (≤۳۵۰۰ کاراکتر)، hashtags
- هزینه: ~۹۰۰۰۰ output token per run — ۳× ارزان‌تر با Gemini

> چرا جدا؟ ترجمه ۹۰٪ هزینه را می‌خورد. Gemini Flash-Lite ۱۰× ارزان‌تر از Claude برای این کار است.

### مرحله ۵ — Rule Gate

برای هر کانال:
- ✓ quota روزانه تجاوز نکرده؟
- ✓ ترجمه به زبان کانال موجود است؟
- ✓ risk_level برابر high نیست؟
- → محاسبه scheduled_at بر اساس priority

اگر `mediaUrlExpiresSoon=true` (Instagram/LinkedIn):
- Breaking: ۵ دقیقه بعد
- High: ۲۰ دقیقه بعد
- Normal: ۱ ساعت بعد (نه ۲-۶ ساعت)

### مرحله ۶ — Publish

Cron هر ۳۰ دقیقه:
```
برای هر آیتم scheduled که scheduled_at ≤ now:
  ✓ بررسی hourly rate limit
  ✓ بررسی minimum gap
  ✓ Optimistic lock (جلوگیری از ارسال دوتایی)
  → ارسال به Telegram Bot API
  → retry تا ۳ بار با ۳۰ دقیقه فاصله
```

---

## پیش‌نیازها

| ابزار | نسخه | نصب |
|-------|------|-----|
| Node.js | ≥ ۲۲ | [nodejs.org](https://nodejs.org) |
| pnpm | ≥ ۹.۱۵ | `npm i -g pnpm` |
| Wrangler | ≥ ۳.۱۱۴ | `npm i -g wrangler` |

**حساب‌های مورد نیاز:**
- [Cloudflare](https://dash.cloudflare.com) (رایگان)
- [Apify](https://console.apify.com) (pay-per-result)
- [Anthropic](https://console.anthropic.com) (Claude API)
- [Google AI Studio](https://aistudio.google.com) (Gemini) یا OpenAI
- Telegram (ربات از @BotFather)

---

## راهنمای راه‌اندازی

### مرحله ۱ — نصب

```bash
git clone https://github.com/YOUR_ORG/content-curator.git
cd content-curator
pnpm install
```

### مرحله ۲ — ورود به Cloudflare

```bash
wrangler login
```

### مرحله ۳ — ساخت D1 Database

```bash
wrangler d1 create content-curator-db
# خروجی: database_id را کپی کنید
```

`database_id` را در `wrangler.toml` در هر دو بلوک `[[d1_databases]]` جایگزین کنید.

### مرحله ۴ — اجرای Migrations

```bash
pnpm db:migrate:local   # تست local
pnpm db:migrate:remote  # production
```

### مرحله ۵ — تنظیم Secrets

```bash
# Claude API (اجباری برای scoring)
wrangler secret put ANTHROPIC_API_KEY --env production

# انتخاب یکی از این‌ها برای ترجمه:
wrangler secret put GEMINI_API_KEY --env production    # توصیه شده
# یا:
wrangler secret put OPENAI_API_KEY --env production

# سرویس‌های دیگر
wrangler secret put APIFY_TOKEN --env production
wrangler secret put TELEGRAM_BOT_TOKEN --env production

# داشبورد (حداقل ۳۲ کاراکتر تصادفی)
wrangler secret put INTERNAL_API_SECRET --env production
# تولید: openssl rand -hex 32
```

### مرحله ۶ — Deploy

```bash
pnpm typecheck  # باید pass شود
pnpm deploy
```

### مرحله ۷ — بررسی

```bash
curl https://content-curator.YOUR_ACCOUNT.workers.dev/health
# {"ok":true,"status":"healthy","db":"connected"}
```

### مرحله ۸ — باز کردن داشبورد

فایل `apps/dashboard/index.html` را در مرورگر باز کنید یا در Cloudflare Pages deploy کنید.

**اولین ورود:** Worker URL و INTERNAL_API_SECRET را وارد کنید.

**Setup Wizard:** از منوی چپ → **setup wizard** — ۷ مرحله راهنمایی می‌کند.

---

## تنظیمات Apify

### Actor کریپتو Twitter/X

```
Actor: kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest
Input:
{
  "twitterHandles": ["coindesk", "cz_binance", "VitalikButerin"],
  "maxItems": 30,
  "addUserInfo": false
}
Schedule: 0 9,21 * * *   (روزی دو بار)
```

### Actor Instagram

```
Actor: apify/instagram-post-scraper
Input:
{
  "directUrls": ["https://www.instagram.com/coindesk/"],
  "resultsLimit": 10
}
Schedule: 0 10 * * *   (روزی یکبار)
```

> **⚠ مهم:** URL های Instagram (scontent.cdninstagram.com) ظرف چند ساعت expire می‌شوند.
> سیستم خودکار این را detect می‌کند و آیتم را سریع‌تر publish می‌کند.

### Actor LinkedIn

```
Actor: harvestapi/linkedin-profile-posts
Input:
{
  "profileUrls": ["https://www.linkedin.com/in/naval"],
  "maxPostsPerProfile": 5,
  "scrapeReactions": false,
  "scrapeComments": false
}
Schedule: 0 10 * * 1,4   (دوشنبه و پنجشنبه)
```

> **⚠ مهم:** `scrapeReactions=false` را حتماً نگه دارید — هزینه جداگانه دارد.

### تنظیم Webhook در Apify

در هر Task → Integrations → Webhooks:

```
Event:   ACTOR.RUN.SUCCEEDED
URL:     https://your-worker.workers.dev/webhook/apify?secret=YOUR_INTERNAL_SECRET
Method:  POST
Payload: {"datasetId": "{{resource.defaultDatasetId}}", "platform": "x"}
```

`"platform"` را برای هر Task عوض کنید: `"x"`, `"instagram"`, `"linkedin"`

### ثبت Dataset ID

بعد از اولین run هر Task، Dataset ID را از Apify کپی کنید و ثبت کنید:

```bash
curl -X POST https://your-worker.workers.dev/internal/apify-sources \
  -H "x-internal-api-secret: YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "category_id": "crypto",
    "platform": "x",
    "apify_dataset_id": "ABC123xyz...",
    "label": "Crypto Twitter"
  }'
```

---

## ربات تلگرام

### ساخت ربات

۱. در تلگرام به `@BotFather` پیام دهید → `/newbot`
۲. نام و username انتخاب کنید
۳. Token را کپی کنید → `wrangler secret put TELEGRAM_BOT_TOKEN --env production`

### افزودن ربات به کانال

۱. کانال را باز کنید → Settings → Administrators → Add Administrator
۲. ربات را پیدا کنید
۳. فقط **Post Messages** را فعال کنید

### دریافت Chat ID

```bash
curl "https://api.telegram.org/botYOUR_TOKEN/getChat?chat_id=@your_channel"
# در response: "id": -1001234567890
```

### محدودیت‌های تلگرام

| محدودیت | مقدار | این سیستم |
|---------|-------|-----------|
| Global (همه chats) | ۳۰ پیام/ثانیه | حداکثر ۱ هر ۳۰ دقیقه |
| Per chat/channel | ۱ پیام/ثانیه | حداکثر ۲/ساعت — کاملاً ایمن |
| sendMediaGroup با ۱۰ آیتم | ۱۰ واحد از quota | هندل شده با min_gap |
| خطای ۴۲۹ | retry_after ثانیه | ۳ بار retry با ۳۰ دقیقه فاصله |

### زمان‌بندی پیشنهادی

**کانال فارسی (ایران):**
```json
{
  "allowed_windows": ["08:00-00:00"],
  "blocked_windows": ["00:00-08:00"],
  "max_per_day": 10,
  "max_per_hour": 2,
  "min_gap_minutes": 30,
  "timezone": "Asia/Tehran"
}
```

**کانال انگلیسی (جهانی):**
```json
{
  "allowed_windows": ["00:00-23:59"],
  "max_per_day": 12,
  "max_per_hour": 2,
  "min_gap_minutes": 20,
  "timezone": "UTC"
}
```

---

## مدیریت هزینه AI

### معماری دو مرحله‌ای

```
مرحله ۱ — Claude Haiku:  فقط scoring + risk
  → هر run: ~۲۰۰۰ output token
  → هزینه: ~$0.008 per run

مرحله ۲ — Gemini/OpenAI:  فقط ترجمه
  → هر run: ~۹۰,۰۰۰ output token
  → هزینه با Gemini Flash-Lite: ~$0.04 per run
  → هزینه با Claude Haiku: ~$0.36 per run (۹× گران‌تر!)
```

### مقایسه Providerها برای ترجمه

| Provider | مدل | قیمت output/1M | هزینه ۹۰K token |
|----------|-----|----------------|-----------------|
| **Gemini** | `gemini-2.5-flash-lite` | $0.40 | **$0.04** |
| **OpenAI** | `gpt-4.1-nano` | $0.40 | **$0.04** |
| **OpenAI** | `gpt-4o-mini` | $0.60 | $0.05 |
| Claude | `claude-haiku-4-5` | $4.00 | $0.36 |

**توصیه:** با `gemini-2.5-flash-lite` شروع کنید. اگر کیفیت فارسی کافی نبود، به `gemini-2.5-flash` ارتقا دهید.

### تنظیم در wrangler.toml

```toml
TRANSLATION_PROVIDER = "gemini"
TRANSLATION_MODEL    = "gemini-2.5-flash-lite"
AI_SCORING_MODEL     = "claude-haiku-4-5-20251001"
```

---

## داشبورد

### Deploy در Cloudflare Pages

۱. Cloudflare Dashboard → Pages → Create application → Connect to Git
۲. تنظیمات:
   ```
   Framework preset:  None
   Build command:     (خالی)
   Build output dir:  apps/dashboard
   Root directory:    (خالی)
   ```
۳. Deploy → آدرس: `https://curator-dash.pages.dev`

### یا باز کردن مستقیم

فایل `apps/dashboard/index.html` را در مرورگر باز کنید.

### صفحات داشبورد

| صفحه | توضیح |
|------|-------|
| **Overview** | آمار کلی، صف بعدی، وضعیت کانال‌ها |
| **Publish Queue** | scheduled/failed/published، دکمه cancel |
| **Discovery Runs** | تاریخچه run‌ها، trigger دستی |
| **Content Items** | آیتم‌های selected و rejected با لینک منبع |
| **Categories** | CRUD، زبان‌های هدف، prompt profiles |
| **Channels** | pause/resume هر کانال، rate limits |
| **Source Accounts** | whitelist اکانت‌ها |
| **Apify Datasets** | Dataset ID ها، webhook URL |
| **AI Settings** | انتخاب provider، calculator هزینه |
| **System Switches** | toggle همه کلیدها |
| **Connection** | مدیریت API URL و secret |

### Setup Wizard (۷ مرحله)

از منوی چپ → **setup wizard**:

| مرحله | کار |
|-------|-----|
| ۱ | خوش‌آمدگویی و تأیید اتصال |
| ۲ | ساخت Category با preset |
| ۳ | تنظیم Channel تلگرام |
| ۴ | وارد کردن Apify Dataset ID |
| ۵ | افزودن Source Accounts به whitelist |
| ۶ | اجرای dry-run test |
| ۷ | فعال‌سازی مرحله به مرحله |

---

## کنترل و مدیریت

### Safety Switches

```bash
# خاموش کردن فوری
curl -X POST .../internal/admin/toggle \
  -H "x-internal-api-secret: SECRET" \
  -d '{"key": "telegram_publish_enabled", "value": "false"}'

curl -X POST .../internal/admin/toggle \
  -H "x-internal-api-secret: SECRET" \
  -d '{"key": "apify_curation_enabled", "value": "false"}'
```

### ترتیب فعال‌سازی

```
فاز ۱  curation:off  dry_run:on  publish:off  → ستاپ و تأیید
فاز ۲  curation:on   dry_run:on  publish:off  → تست scoring
فاز ۳  curation:on   dry_run:off publish:off  → تست queue
فاز ۴  curation:on   dry_run:off publish:on   → کانال test
فاز ۵  کانال‌های عمومی را یک به یک فعال کنید
```

### Pause/Resume کانال

```bash
# Pause یک کانال
curl -X POST .../internal/channels/crypto_fa/publish \
  -H "x-internal-api-secret: SECRET" \
  -d '{"enabled": false}'

# Resume
curl -X POST .../internal/channels/crypto_fa/publish \
  -H "x-internal-api-secret: SECRET" \
  -d '{"enabled": true}'
```

---

## امنیت

### چه چیزی محافظت می‌شود

| چه | چطور |
|----|------|
| API Keys | در Cloudflare encrypted secrets — هرگز در کد |
| `/health` | عمومی است ولی اطلاعات حساس ندارد |
| `/webhook/apify` | `?secret=` در query param |
| `/internal/*` | `x-internal-api-secret` header |
| داشبورد | همان secret در localStorage — هرگز به جایی ارسال نمی‌شود |

### چه چیزی هرگز leak نمی‌شود

- API Keys فقط در Cloudflare encrypted secrets
- Error های internal → generic `"internal_server_error"` برمی‌گردد
- Bot token از error messages حذف می‌شود
- هیچ stack trace ای به client ارسال نمی‌شود

### GitHub Actions Security

CI هر push را اسکن می‌کند:
- بررسی pattern های معمول API key: `sk-ant-api`, `AIzaSy`, `sk-proj`
- اگر پیدا شود → CI fail می‌شود و deploy انجام نمی‌شود

---

## رفع مشکلات

### آیتم‌ها از Apify نمی‌آیند

```bash
# ۱. بررسی apify sources
curl .../internal/apify-sources -H "x-internal-api-secret: SECRET"

# ۲. Trigger دستی
curl -X POST .../internal/curation/trigger \
  -H "x-internal-api-secret: SECRET" \
  -d '{"dryRun": true, "force": true}'

# ۳. بررسی error_message در runs
curl ".../internal/runs?limit=3" -H "..."
```

### Claude همه را reject می‌کند

```bash
# بررسی آیتم‌های rejected
curl ".../internal/items?status=ai_rejected&limit=20" -H "..."
# ai_score ها را ببینید

# موقتاً threshold را کاهش دهید
curl -X PATCH .../internal/categories/crypto -H "..." \
  -d '{"score_threshold": 60}'
```

### URL Instagram قبل از ارسال expire شد

```bash
# کاهش min_gap_minutes
curl -X PATCH .../internal/channels/crypto_fa -H "..." \
  -d '{"min_gap_minutes": 10}'

# یا افزایش تعداد ارسال در ساعت
curl -X PATCH .../internal/channels/crypto_fa -H "..." \
  -d '{"max_per_hour": 3}'
```

### خطای ۴۲۹ از تلگرام

سیستم خودکار retry می‌کند (۳ بار با ۳۰ دقیقه فاصله).
```bash
# بررسی failed queue
curl ".../internal/queue?status=failed&limit=10" -H "..."
# ستون publish_error را ببینید
```

### کیفیت ترجمه فارسی ضعیف است

```toml
# در wrangler.toml:
TRANSLATION_MODEL = "gemini-2.5-flash"  # به جای flash-lite
# سپس: pnpm deploy
```

---

## هزینه ماهانه

### سناریو: ۳ category، ۶ کانال، ۳ پلتفرم

| سرویس | حجم | هزینه |
|-------|-----|-------|
| Cloudflare Workers | >۱۰۰K req/day | **$0** |
| Cloudflare D1 | <۵GB | **$0** |
| Cloudflare Pages | داشبورد | **$0** |
| Apify Twitter (Kaito) | ~۴۵K tweet | ~$11 |
| Apify Instagram | ~۹K post | ~$15 |
| Apify LinkedIn | ~۶۰۰ post | ~$1.20 |
| Claude Haiku (scoring) | ~۴۵۰ run/ماه | ~$3 |
| Gemini Flash-Lite (ترجمه) | ~۴۵۰ run/ماه | ~$2 |
| Telegram Bot | — | **$0** |
| **جمع** | | **~$32** |

### کاهش هزینه

- `APIFY_MAX_ITEMS_PER_SOURCE` را به ۳۰ کاهش دهید
- `AI_SCORE_THRESHOLD_DEFAULT` را به ۸۰ افزایش دهید (کمتر ترجمه)
- از `gemini-2.5-flash-lite` استفاده کنید (نه flash یا pro)
- Task های Apify را روزی یکبار schedule کنید (نه بیشتر)
- `AI_MAX_CANDIDATES_PER_RUN` را به ۳۰ کاهش دهید
