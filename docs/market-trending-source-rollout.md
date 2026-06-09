# Market Trending Source Rollout Guide

Status: Draft / disabled-by-default rollout guide  
Phase: 6  
Source ID: `src_market_trending_x`  
Category: `crypto`  
Platform: `x`

---

## 1. Purpose

The market-trending source is an experimental Apify source intended to increase the supply of fresh crypto market candidates beyond the existing news and voices sources.

This source must not bypass the AI candidate backlog, Claude scoring, risk checks, rule gate, or Telegram publish queue. It is seeded as disabled by default and must be enabled only after the backlog pipeline is stable.

---

## 2. Safety Requirements

Before enabling the source, confirm:

- `AI_CANDIDATE_BACKLOG_ENABLED=true` is stable in production.
- Backlog cron/manual drain has no recent errors.
- `/internal/report/daily` works.
- `/internal/report/market-trending` works.
- A real Apify task exists.
- The source record has a real dataset or task binding.
- The Apify webhook uses `source_id=src_market_trending_x`.

Do not enable this source if the source still has the placeholder dataset ID.

---

## 3. Recommended Query

Initial query candidate:

```text
(bitcoin OR ethereum OR crypto OR stablecoin OR liquidation OR ETF OR DeFi OR onchain OR "market" OR "Fed") min_faves:100 -filter:replies lang:en
```

Tune `min_faves` and exclusions based on duplicate rate, AI select rate, and risk flags.

---

## 4. Required Webhook Format

Use the explicit source ID. This avoids ambiguous dataset matching and follows the production webhook pattern already used by existing Apify tasks.

```text
https://content-curator.thesol-ai.workers.dev/webhook/apify?source_id=src_market_trending_x&secret=YOUR_SECRET
```

Do not use a generic webhook without `source_id` for this source:

```text
https://your-worker.workers.dev/webhook/apify?secret=YOUR_SECRET
```

The generic form can fall back to dataset matching and is more fragile during experiments or placeholder setup.

---

## 5. Rollout Steps

### Step 1: Create or verify the Apify task

Create the market-trending X/Twitter Apify task using the recommended query. Keep the task disabled or unscheduled until the DB source is configured.

### Step 2: Update the source record

Replace placeholder values before enabling:

```sql
UPDATE apify_sources
SET
  apify_dataset_id = 'REAL_DATASET_ID_OR_INITIAL_DATASET',
  apify_task_id = 'REAL_APIFY_TASK_ID',
  source_config = json_set(
    COALESCE(source_config, '{}'),
    '$.rollout_phase', 'configured',
    '$.webhook_source_id', 'src_market_trending_x'
  )
WHERE id = 'src_market_trending_x';
```

The admin API can also be used:

```bash
curl -X PATCH 'https://content-curator.thesol-ai.workers.dev/internal/apify-sources/src_market_trending_x' \
  -H 'x-internal-api-secret: YOUR_SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"apify_dataset_id":"REAL_DATASET_ID","apify_task_id":"REAL_APIFY_TASK_ID"}'
```

### Step 3: Configure the Apify webhook

Webhook URL:

```text
https://content-curator.thesol-ai.workers.dev/webhook/apify?source_id=src_market_trending_x&secret=YOUR_SECRET
```

Event type:

```text
ACTOR.RUN.SUCCEEDED
```

### Step 4: Enable source after verification

```bash
curl -X PATCH 'https://content-curator.thesol-ai.workers.dev/internal/apify-sources/src_market_trending_x' \
  -H 'x-internal-api-secret: YOUR_SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}'
```

### Step 5: Monitor for 24 to 48 hours

Daily report:

```bash
curl 'https://content-curator.thesol-ai.workers.dev/internal/report/daily?hours=24&category=crypto' \
  -H 'x-internal-api-secret: YOUR_SECRET'
```

Market-trending report:

```bash
curl 'https://content-curator.thesol-ai.workers.dev/internal/report/market-trending?hours=24' \
  -H 'x-internal-api-secret: YOUR_SECRET'
```

---

## 6. Decision Criteria

| Metric | Healthy signal | Action if unhealthy |
|---|---:|---|
| Duplicate rate | Below 60% | Adjust query or reduce overlap with existing sources |
| AI select rate | Above 10% | Raise `min_faves`, add exclusions, or narrow topic terms |
| Queued rate | Above 5% of fetched | Check risk flags, rule gate, and translation missing signals |
| Pending backlog | Not growing continuously | Reduce source volume or drain more conservatively |
| High-risk content | Low | Tighten query and keep AI threshold unchanged |

Recommendation logic:

- `not_started`: source disabled or still placeholder.
- `monitoring`: source enabled but not enough data yet.
- `keep`: duplicate rate and AI select rate are healthy.
- `tune_or_disable`: duplicate rate is too high, select rate is too low, or queue creation is poor.

---

## 7. Rollback

Disable source immediately:

```bash
curl -X PATCH 'https://content-curator.thesol-ai.workers.dev/internal/apify-sources/src_market_trending_x' \
  -H 'x-internal-api-secret: YOUR_SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"enabled":false}'
```

Optionally skip pending backlog candidates from this source:

```sql
UPDATE ai_candidate_queue
SET status='skipped', last_error='market_trending_experiment_rolled_back'
WHERE source_id='src_market_trending_x'
  AND status IN ('pending','scoring');
```

Do not delete historical discovery rows. They are useful for the experiment review.
