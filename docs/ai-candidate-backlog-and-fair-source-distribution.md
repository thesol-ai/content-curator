# AI Candidate Backlog and Fair Source Distribution Plan

Status: Draft  
Owner: The Sol AI / Content Curator  
Repository: `thesol-ai/content-curator`  
Recommended repo path: `docs/ai-candidate-backlog-and-fair-source-distribution.md`  
Scope: Production crypto content curation pipeline  
Document purpose: Product and technical reference before implementation

---

## 1. Executive Summary

The current content curation pipeline successfully scrapes data from Apify, filters duplicates, sends selected fresh candidates to AI scoring, translates selected items, and queues approved posts for Telegram publishing.

However, recent production observations show a structural issue:

- Apify can fetch more items than the AI scoring step is allowed to process.
- The current `AI_MAX_CANDIDATES_PER_RUN` limit protects Claude from oversized prompts and cost spikes, but it also causes fresh scraped items beyond that limit to be left unprocessed.
- Some source accounts dominate Apify datasets because tasks use broad `OR` queries with `Latest` ordering.
- This reduces account diversity and causes the channel output to depend too heavily on a few high-volume sources.
- The result is too few published posts, even when scraping itself is working.

The proposed solution is **not** to blindly increase AI batch size. Instead, the pipeline should introduce a durable AI candidate backlog, process candidates in small safe batches, and use fair source distribution when selecting candidates for AI scoring.

This allows the system to:

- Keep Claude scoring requests small and stable.
- Prevent fresh scraped items from being wasted.
- Control daily AI cost.
- Give more source accounts a chance to be evaluated.
- Increase the probability of producing publishable Telegram posts.
- Improve operational visibility into why output is low or high.

---

## 2. Current Pipeline Behavior

The current pipeline performs the following high-level steps:

1. Apify task runs and creates a dataset.
2. Apify webhook calls the Worker.
3. Worker loads the matching Apify source.
4. Worker fetches up to `APIFY_MAX_ITEMS_PER_SOURCE` items from the dataset.
5. Worker normalizes raw Apify items.
6. Worker applies deduplication.
7. Worker takes only the first `AI_MAX_CANDIDATES_PER_RUN` fresh items.
8. Worker sends that batch to Claude for scoring and risk assessment.
9. AI-selected items are sent for translation.
10. Translated items pass rule gate and are inserted into `publish_queue`.
11. Telegram publisher sends due queue items.

The critical issue is step 7.

Fresh items beyond the configured AI candidate limit currently do not have a durable continuation path. They are not saved into a backlog for later scoring. This means the system may scrape valid fresh items but never evaluate them.

---

## 3. Production Observation Summary

A recent morning production run showed this pattern:

| Time Tehran | Source Group | Fetched | New | Duplicate | AI Selected | AI Rejected | Queued |
|---|---:|---:|---:|---:|---:|---:|---:|
| 08:00 | news-text | 24 | 3 | 21 | 0 | 3 | 0 |
| 08:05 | news-media | 24 | 19 | 5 | 3 | 7 | 3 |
| 08:10 | voices-text | 24 | 1 | 23 | 0 | 1 | 0 |
| 08:15 | voices-media | 24 | 1 | 23 | 0 | 1 | 0 |

Total:

- Raw fetched by Worker: 96
- Duplicate: 72
- Fresh/new: 24
- Sent to AI scoring: 15
- AI selected: 3
- AI rejected: 12
- Queued to Telegram: 3
- Published: 3

This shows that scraping was not the only bottleneck. The system did fetch items, but many were duplicates, and some fresh items did not reach AI due to candidate limits.

Dataset distribution also showed account concentration:

- `news-media` was heavily dominated by Cointelegraph.
- `news-text` was heavily influenced by U.Today and a few news sources.
- `voices-text` was heavily dominated by Scott Melker.
- `voices-media` was more distributed, but still skewed.

This indicates that broad Apify queries using `Latest` do not guarantee fair coverage across accounts.

---

## 4. Product Problem

The channel needs a steady flow of high-quality crypto content. Users expect updates throughout the day, not only a few posts after a scheduled scrape.

Current symptoms:

- Too few Telegram posts are published after successful scrapes.
- AI candidate limits prevent all fresh items from being evaluated.
- High-volume accounts dominate the candidate pool.
- Some source profiles may not get enough representation.
- Operational diagnosis is difficult without a backlog and clear candidate states.
- Increasing scrape volume alone does not solve the problem because AI scoring remains capped.

The product risk is user dissatisfaction due to low posting volume and low source diversity.

---

## 5. Technical Problem

The current architecture treats the AI candidate limit as a hard run-level cutoff. This creates a lossy pipeline.

The AI candidate limit should instead be treated as a safe batch size for each Claude scoring call.

The system needs a durable intermediate layer between dedupe and AI scoring:

- Every fresh item should get a final state.
- Items that cannot be scored immediately should remain pending.
- Scoring should continue later through cron or a continuation drain.
- Candidate selection should be fair across source accounts.
- Cost and call limits must remain enforced.

---

## 6. Goals

### 6.1 Product Goals

- Increase the number of publishable posts without lowering editorial quality.
- Improve source diversity across news media and market voices.
- Avoid over-reliance on a single dominant account.
- Make sure fresh scraped items are not wasted.
- Keep Telegram output steady across the day.
- Preserve strict rejection of risky, promotional, scam-like, or low-value content.
- Make daily performance explainable to stakeholders and channel operators.

### 6.2 Technical Goals

- Keep Claude scoring requests small and reliable.
- Avoid oversized prompts and malformed JSON responses.
- Keep daily AI cost controlled.
- Add a durable backlog for fresh AI candidates.
- Process the backlog incrementally.
- Make candidate state observable.
- Keep all changes behind feature flags where possible.
- Avoid disrupting the existing publish pipeline.

---

## 7. Non-Goals

This project does not aim to:

- Lower editorial standards just to increase post count.
- Disable deduplication.
- Remove risk checks.
- Send all scraped items to AI in one large prompt.
- Increase Claude batch size aggressively without safeguards.
- Change Telegram publishing behavior in the first phase.
- Change Apify schedules in the first implementation phase.
- Add new market-trending sources before the backlog is stable.
- Rewrite the whole pipeline from scratch.

---

## 8. Constraints and Risks

### 8.1 Claude Scoring Constraint

Claude scoring currently receives all candidate items in one prompt and returns a JSON object with scoring results. Increasing the number of items per scoring call can increase the risk of:

- Larger input payloads.
- Timeout.
- HTTP errors.
- Invalid JSON.
- Missing items in the response.
- Higher token cost.
- More expensive retries.

Therefore, `AI_MAX_CANDIDATES_PER_RUN` should not simply be increased from 10 to 20 or 30.

### 8.2 Cost Constraint

The pipeline already has daily call and token budget controls. Any backlog drain must respect:

- `AI_MAX_CALLS_PER_DAY`
- `AI_DAILY_TOKEN_BUDGET`
- Retry limits
- Batch size limits
- Per-execution drain limits

### 8.3 Runtime Constraint

The Worker runtime should not attempt to drain an unlimited backlog in one execution. Backlog processing must be bounded.

### 8.4 Product Quality Constraint

More content is not automatically better. The system must preserve:

- Score threshold.
- Risk assessment.
- Editorial policy.
- Dedupe.
- Rule gate.
- Translation validation.
- Telegram publish safety.

### 8.5 Migration Constraint

Every migration must be checked against the current production D1 schema before merge. Do not merge a migration if production already contains the target columns. Duplicate-column migration failures can block deployment.

### 8.6 Configuration Constraint

Changes to `wrangler.toml`, Apify schedules, webhook configuration, or runtime flags should not be mixed into code implementation PRs unless explicitly required. Configuration changes should be reviewed separately.

---

## 9. Proposed Solution Overview

Introduce an AI candidate backlog.

Instead of directly slicing fresh items and dropping the rest, the pipeline should:

1. Normalize and dedupe Apify items.
2. Insert all fresh candidates into a durable backlog table.
3. Process the backlog in small Claude-safe batches.
4. Select each batch using fair source distribution.
5. Store final AI decisions for every candidate.
6. Queue selected candidates for Telegram.
7. Leave unprocessed candidates pending for a later drain.
8. Drain pending candidates through webhook continuation and scheduled cron.

The key architectural shift:

`AI_MAX_CANDIDATES_PER_RUN` becomes a batch size, not a lossy cutoff.

---

## 10. Proposed Data Model

### 10.1 New Table: `ai_candidate_queue`

Proposed schema:

```sql
CREATE TABLE IF NOT EXISTS ai_candidate_queue (
  id TEXT PRIMARY KEY,
  source_id TEXT,
  run_id TEXT,
  category_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  source_account TEXT,
  source_url TEXT NOT NULL,
  post_id TEXT,
  published_at INTEGER,
  normalized_item_json TEXT NOT NULL,
  dedupe_keys_json TEXT NOT NULL,
  priority_score REAL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  claimed_at TEXT,
  scored_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_candidate_queue_status_created
  ON ai_candidate_queue(status, created_at);

CREATE INDEX IF NOT EXISTS idx_ai_candidate_queue_account_status
  ON ai_candidate_queue(source_account, status);

CREATE INDEX IF NOT EXISTS idx_ai_candidate_queue_run
  ON ai_candidate_queue(run_id);
```

### 10.2 Candidate Status Values

- `pending`: Candidate is waiting for AI scoring.
- `scoring`: Candidate has been claimed for a scoring attempt.
- `ai_selected`: AI selected this candidate for publishing.
- `ai_rejected`: AI rejected this candidate.
- `queued`: Candidate has created at least one publish queue item.
- `failed`: Scoring or downstream processing failed after retry limit.
- `skipped`: Candidate was intentionally skipped by policy, expiry, or stale age.

### 10.3 Important Data Model Notes

- `normalized_item_json` should contain the normalized item used by the orchestrator, not the entire raw Apify item unless necessary.
- `dedupe_keys_json` must preserve the dedupe keys so that final dedupe recording can still happen safely.
- `source_url` and `post_id` should support unique constraints or conflict handling to avoid duplicate backlog entries.
- Candidate storage must not bypass existing `discovery_items`, `run_events`, or `run_item_events`; those should still be used for final reporting.

---

## 11. Configuration Proposal

Introduce new configuration variables:

```toml
AI_CANDIDATE_BACKLOG_ENABLED = "false"
AI_SCORING_BATCH_SIZE = "10"
AI_MAX_SCORING_BATCHES_PER_RUN = "2"
AI_CANDIDATE_BACKLOG_DRAIN_LIMIT = "20"
AI_CANDIDATE_MAX_ATTEMPTS = "2"
AI_CANDIDATE_MAX_AGE_HOURS = "6"
AI_FAIR_SOURCE_PICKER_ENABLED = "false"
```

### 11.1 Meaning

`AI_CANDIDATE_BACKLOG_ENABLED`  
Enables the new backlog flow. Default should be false for safe merge.

`AI_SCORING_BATCH_SIZE`  
Maximum number of candidates per Claude scoring call. Default should stay around 10.

`AI_MAX_SCORING_BATCHES_PER_RUN`  
Maximum scoring batches per Worker execution.

`AI_CANDIDATE_BACKLOG_DRAIN_LIMIT`  
Maximum candidates to drain in a single execution.

`AI_CANDIDATE_MAX_ATTEMPTS`  
Maximum scoring attempts before candidate is marked failed.

`AI_CANDIDATE_MAX_AGE_HOURS`  
Maximum candidate age before skip. Prevents stale backlog from being published too late.

`AI_FAIR_SOURCE_PICKER_ENABLED`  
Enables round-robin source account selection.

---

## 12. Fair Source Distribution Strategy

A fixed quota per source account is not ideal because the number of tracked profiles can change over time. As more profiles are added, fixed quotas become too small and harder to manage.

Instead, use a round-robin picker.

### 12.1 Current Risk

If a dataset contains:

- Cointelegraph: 30 items
- CoinDesk: 4 items
- BeInCrypto: 5 items
- BitcoinMagazine: 1 item

A simple `slice(0, 10)` can over-represent Cointelegraph.

### 12.2 Proposed Batch Selection

The batch picker should:

1. Load pending candidates.
2. Group them by `source_account`.
3. Pick one candidate from each account.
4. Repeat until the batch is full.
5. Prefer higher priority or newer candidates inside each account group.
6. Optionally deprioritize accounts that already had several selected posts in the last 24 hours.

This does not require per-profile manual quota management.

### 12.3 Optional Future Enhancement

Add a soft daily selected cap per account, such as:

- Maximum 3 selected posts per account per day.
- Maximum 1 selected post per account per run, unless the batch would otherwise be empty.

This should not be part of Phase 1. It belongs after the backlog is stable.

---

## 13. Candidate Prioritization

Backlog ordering should not be purely FIFO.

Recommended priority inputs:

- Freshness.
- Engagement signals.
- Source account diversity.
- Media availability.
- Source whitelist.
- Whether account has been underrepresented recently.
- Whether source group is news or voices.
- Whether item is text or media.
- Whether media URL may expire soon.

Initial implementation can keep priority simple:

1. Fresh candidates first.
2. Round-robin by source account.
3. Newer items before older items inside each account group.
4. Optional engagement-based boost later.

---

## 14. Processing Flow

### 14.1 Current Flow

```text
Apify dataset
  -> normalize
  -> dedupe
  -> fresh.slice(0, AI_MAX_CANDIDATES_PER_RUN)
  -> Claude scoring
  -> translation
  -> rule gate
  -> publish_queue
```

### 14.2 New Flow

```text
Apify dataset
  -> normalize
  -> dedupe
  -> enqueue all fresh candidates
  -> drain backlog batch 1
  -> Claude scoring
  -> translation
  -> rule gate
  -> publish_queue
  -> leave remaining candidates pending
```

### 14.3 Cron Continuation

```text
Cloudflare cron
  -> publish due Telegram posts
  -> drain pending AI candidate backlog
  -> process next safe batch
```

This allows the system to continue scoring candidates before the next Apify scrape.

---

## 15. Failure Handling

### 15.1 Claude HTTP Failure

If Claude returns HTTP error:

- Mark candidates back to `pending` if attempts remain.
- Increment `attempt_count`.
- Store `last_error`.
- Record run event.
- Do not mark as rejected.

### 15.2 Invalid JSON

If Claude returns invalid JSON:

- Retry according to `AI_MAX_RETRIES`.
- If still failing, mark batch candidates as `failed` or return to pending depending on attempt count.

### 15.3 Missing AI Result for Candidate

If Claude response does not include a candidate:

- Mark candidate as `failed` or `ai_rejected` with `not_scored`, depending on current system behavior.
- Prefer `failed` during backlog implementation to avoid silent rejection.

### 15.4 Translation Missing

Existing behavior may turn selected candidates into non-publishable items if translation is missing. This should be recorded clearly.

### 15.5 Rule Gate Rejection

If rule gate rejects an AI-selected item, candidate should remain `ai_selected`, while item event records `rule_gate_rejected`.

### 15.6 Duplicate Queue Prevention

The implementation must prevent duplicate `publish_queue` rows if the same candidate is retried or if the Worker execution is repeated.

---

## 16. Observability Requirements

The system needs clear operational visibility.

Minimum metrics:

- Raw fetched count.
- Normalized count.
- Duplicate count.
- Fresh count.
- Enqueued candidate count.
- Pending backlog count.
- Scored count.
- AI selected count.
- AI rejected count.
- Failed scoring count.
- Queued count.
- Published count.
- Rejection reasons.
- Source account distribution.
- AI calls used today.
- AI tokens used today.

Recommended run events:

- `candidate.enqueued`
- `candidate.batch.claimed`
- `candidate.batch.scoring_started`
- `candidate.batch.scoring_succeeded`
- `candidate.batch.scoring_failed`
- `candidate.ai_selected`
- `candidate.ai_rejected`
- `candidate.queued`
- `candidate.skipped_stale`
- `candidate.backlog.drain_completed`

---

## 17. Market Trending Source Proposal

After backlog stability, add a new Apify source for broader market-trending crypto content.

### 17.1 Proposed Task Name

`crypto-x-market-trending`

### 17.2 Goal

Increase the supply of fresh, potentially publishable market content beyond the current news and voices groups.

### 17.3 Initial Query Candidate

```text
(bitcoin OR ethereum OR crypto OR stablecoin OR liquidation OR ETF OR DeFi OR onchain OR "market" OR "Fed") min_faves:100 -filter:replies lang:en
```

### 17.4 Rollout Rule

This source should not be enabled directly into full publishing on day one.

Recommended rollout:

1. Create source.
2. Connect webhook.
3. Feed candidates into AI backlog.
4. Monitor for 24 to 48 hours.
5. Measure duplicate rate, selected rate, rejected rate, and source quality.
6. Decide whether to keep, adjust, or disable.

### 17.5 Risks

- Hype content.
- Price prediction spam.
- Pump-and-dump posts.
- Low-quality engagement bait.
- Overlap with existing sources.
- Too many duplicates.

---

## 18. Rollout Phases

## Phase 0: Documentation and Baseline

### Objective

Create this document and use it as the reference for future implementation.

### Scope

- No code changes.
- No database changes.
- No runtime changes.
- No Apify changes.
- No Telegram changes.

### Deliverables

- Documentation file in `docs/`.
- Baseline production observation recorded.
- Agreement on phased rollout.

### Risk

Very low.

---

## Phase 1: Backlog Schema and Disabled Code Path

### Objective

Introduce the backlog data model and service code behind a feature flag.

### Scope

- Add migration for `ai_candidate_queue`.
- Add TypeScript types.
- Add helper functions for enqueue and candidate status updates.
- Add feature flag checks.
- Keep production behavior unchanged by default.

### Feature Flag

```toml
AI_CANDIDATE_BACKLOG_ENABLED = "false"
```

### Deliverables

- Migration.
- Type definitions.
- Candidate queue service.
- Unit tests for enqueue and status transitions.
- No behavior change while flag is false.

### Risk

Low to medium.

### Safety Requirements

- Existing pipeline must behave exactly the same when flag is false.
- CI must pass.
- No production flag enablement in the PR.
- Migration must be checked against production schema before merge.
- Do not mix this PR with Apify schedule changes, Telegram changes, or source configuration changes.

---

## Phase 2: Backlog Drain for AI Scoring

### Objective

Process pending candidates in small batches.

### Scope

- Add `drainAICandidateQueue`.
- Claim pending candidates safely.
- Score candidates in batches of `AI_SCORING_BATCH_SIZE`.
- Reuse existing AI scoring, translation, rule gate, and publish queue flow.
- Respect daily AI budgets.
- Record candidate events.

### Feature Flags

```toml
AI_CANDIDATE_BACKLOG_ENABLED = "true"
AI_FAIR_SOURCE_PICKER_ENABLED = "false"
```

### Deliverables

- Batch drain service.
- Tests for batch size limits.
- Tests for budget stop behavior.
- Tests for failure handling.
- Tests for not exceeding drain limits.

### Risk

Medium.

### Safety Requirements

- Drain limit must be enforced.
- Candidate attempts must be bounded.
- Failed batches must not create duplicate publish queue rows.
- Dedupe keys must not be recorded in a way that burns unscored candidates incorrectly.
- Existing direct run behavior must remain available as rollback.

---

## Phase 3: Fair Source Picker

### Objective

Improve source account diversity in AI scoring batches.

### Scope

- Add round-robin source account batch selection.
- Keep fallback FIFO when account information is missing.
- Add optional deprioritization for accounts heavily selected in the last 24 hours.

### Feature Flag

```toml
AI_FAIR_SOURCE_PICKER_ENABLED = "true"
```

### Deliverables

- Round-robin picker.
- Tests for balanced account selection.
- Tests for missing source account fallback.
- Operational report comparing distribution before and after.

### Risk

Low to medium.

### Safety Requirements

- Do not starve high-quality accounts.
- Do not create too-small batches when few accounts are available.
- Do not require manual quota per account.
- Keep fairness at AI candidate selection, not Telegram publishing, in this phase.

---

## Phase 4: Controlled Continuation via Cron

### Objective

Allow backlog to continue draining between Apify scrapes.

### Scope

- Trigger backlog drain from scheduled Worker cron.
- Keep publish scheduler behavior intact.
- Ensure cron cannot overrun AI budget.

### Deliverables

- Cron integration.
- Drain logs.
- Daily AI usage reporting.
- Tests for disabled flag behavior.

### Risk

Medium.

### Safety Requirements

- Telegram publishing must not be blocked by backlog drain.
- Backlog drain must stop when AI budget is exceeded.
- Runtime execution must remain bounded.
- Publishing due posts should remain the priority if both publishing and backlog drain happen in one cron execution.

---

## Phase 5: Market Trending Source Experiment

### Objective

Increase fresh candidate supply with a new market-wide trending source.

### Scope

- Add Apify task manually or through controlled setup.
- Add source record.
- Connect webhook.
- Feed output into backlog.
- Monitor for 24 to 48 hours before treating as a stable source.

### Deliverables

- Apify source configuration.
- Monitoring report.
- Decision: keep, tune, or disable.

### Risk

Medium.

### Safety Requirements

- Do not bypass AI scoring.
- Do not bypass risk checks.
- Do not directly increase Telegram publishing until quality is validated.
- Watch duplicate rate and hype rate closely.
- Keep this separate from backlog implementation PRs.

---

## Phase 6: Operational Dashboard / Daily Report

### Objective

Make the pipeline understandable without manual SQL archaeology.

### Scope

Add a daily operational report or admin endpoint showing:

- Scraped count.
- Duplicate count.
- Fresh count.
- Backlog pending count.
- AI scored count.
- AI selected count.
- AI rejected count.
- Queued count.
- Published count.
- Top source accounts.
- Rejection reasons.
- AI budget usage.

### Deliverables

- Admin report endpoint or SQL report script.
- Documentation for daily checks.

### Risk

Low.

---

## 19. Recommended Implementation Order

Recommended order:

1. Merge this documentation only.
2. Implement Phase 1 with feature flag disabled.
3. Add tests and validate no behavior change.
4. Deploy with backlog disabled.
5. Enable backlog in production for one source only, if feasible.
6. Observe.
7. Enable drain with strict limits.
8. Add fair source picker.
9. Add market-trending source.
10. Add reporting.

---

## 20. Safety Principles for Every PR

Every implementation PR must follow these principles:

- One concern per PR.
- No mixed config, migration, and behavior changes unless required.
- Feature flags default to safe/off.
- Production config changes should be separate from code changes.
- Every migration must be checked against production schema before merge.
- Every behavior change must include tests.
- Every rollout must have a rollback path.
- No direct Apify schedule changes inside code PRs unless explicitly approved.
- No Telegram publish behavior changes in backlog infrastructure PRs.
- No `wrangler.toml` changes unless the PR is explicitly about configuration.
- No `package-lock.json` changes unless dependencies actually changed.
- No `tsconfig.tsbuildinfo` or build artifacts should be committed.
- Every PR must list changed files before merge.
- Every PR must run the same validation used by CI.

Recommended local validation:

```bash
git status
git diff --name-only
npm test
npm run typecheck
npm run build
```

---

## 21. Dependencies and Areas an Implementation Agent Must Inspect

Before writing code, the implementation agent must inspect the current repository, especially:

- `apps/worker-api/src/services/curation-orchestrator.ts`
- `apps/worker-api/src/services/ai-gate.ts`
- `apps/worker-api/src/services/run-events.ts`
- `apps/worker-api/src/services/dedupe.ts`
- `apps/worker-api/src/services/rule-gate.ts`
- `apps/worker-api/src/services/telegram-publisher.ts`
- `apps/worker-api/src/services/runtime-config.ts`
- `apps/worker-api/src/types.ts`
- `apps/worker-api/src/index.ts`
- `migrations/`
- `wrangler.toml`
- Existing tests under the test directory

The agent must verify actual table schemas before adding migrations.

The agent must not assume column names. It should inspect migrations and production schema checks before changing SQL.

---

## 22. Open Questions

1. Should backlog candidates be stored as full normalized JSON or as normalized fields plus JSON?
2. Should dedupe keys be recorded at enqueue time or only after scoring?
3. Should stale candidates be marked `skipped` automatically after `AI_CANDIDATE_MAX_AGE_HOURS`?
4. Should selected-per-account daily caps be added in Phase 3 or later?
5. Should market-trending be one task or split into text/media tasks?
6. Should backlog drain run immediately after webhook, cron, or both?
7. Should backlog drain be enabled per source or globally?
8. Should failed candidates be retried automatically or require a manual admin action?
9. Should backlog reports be stored in DB or generated live from SQL?

---

## 23. Initial Product Decision

The recommended decision is:

- Do not increase Claude batch size aggressively.
- Keep scoring batch size small.
- Add a durable candidate backlog.
- Drain backlog in bounded batches.
- Use round-robin source selection for fairness.
- Add market-trending only after backlog is stable.
- Keep all major changes behind feature flags.

This approach addresses the core product issue while protecting the pipeline from cost spikes, model failures, and publishing regressions.

---

# Appendix A: Suggested Terminal Steps to Add This Document to the Repo

Use these steps only after downloading this file.

```bash
git switch main
git pull origin main
git status
```

Continue only if the working tree is clean.

```bash
git switch -c docs/ai-candidate-backlog-plan
mkdir -p docs
cp /path/to/ai-candidate-backlog-and-fair-source-distribution.md docs/ai-candidate-backlog-and-fair-source-distribution.md
git status
git diff --name-only
```

The only changed file should be:

```text
docs/ai-candidate-backlog-and-fair-source-distribution.md
```

Then commit and push:

```bash
git add docs/ai-candidate-backlog-and-fair-source-distribution.md
git commit -m "docs: add AI candidate backlog and fair source distribution plan"
git push origin docs/ai-candidate-backlog-plan
```

Create PR:

```bash
gh pr create \
  --base main \
  --head docs/ai-candidate-backlog-plan \
  --title "Add AI candidate backlog and fair source distribution plan" \
  --body "Adds a product and technical implementation plan for improving AI candidate backlog handling, fair source distribution, controlled AI scoring batches, and future market-trending source rollout.

This is a documentation-only PR.

Safety:
- No code changes.
- No database changes.
- No runtime config changes.
- No Apify changes.
- No Telegram publish changes.
- No pipeline behavior changes."
```

---

# Appendix B: Prompt for a Coding Agent

Use this prompt when asking a coding agent to implement the plan from a ZIP of the repository and/or the GitHub repository link.

```text
You are working on the repository `thesol-ai/content-curator`.

Repository URL:
https://github.com/thesol-ai/content-curator

I will provide either a ZIP of the repository or access to the GitHub repository. Before making any changes, inspect the repository deeply. Do not assume file names, table schemas, or column names. Read the current code and migrations first.

Primary reference document:
`docs/ai-candidate-backlog-and-fair-source-distribution.md`

Your job is to implement the plan phase by phase, safely, with one focused PR per phase. Do not jump ahead. Do not mix unrelated changes. Do not change runtime configuration, Apify schedules, Telegram behavior, or production flags unless explicitly asked.

Critical safety rules:
1. Never commit `tsconfig.tsbuildinfo`, build artifacts, or unrelated generated files.
2. Do not modify `wrangler.toml` unless the phase explicitly requires config documentation or a reviewed config change.
3. Do not merge code, migration, and production flag enablement in the same PR.
4. Every migration must be checked against existing migrations and production schema assumptions before merge.
5. Feature flags must default to safe/off.
6. Existing pipeline behavior must remain unchanged when feature flags are off.
7. Existing tests must pass.
8. Add or update tests for every behavior change.
9. Do not reduce AI quality thresholds to increase post count.
10. Do not increase Claude batch size aggressively.
11. Keep Claude scoring batches small and bounded.
12. Preserve existing dedupe, AI risk checks, translation flow, rule gate, and Telegram publishing safety.
13. Avoid duplicate `publish_queue` rows on retries.
14. Preserve or improve run event observability.
15. Always list changed files and explain why each file changed.

Implementation phases:

Phase 0:
- Add the documentation only if it is not already present.
- No code changes.

Phase 1:
- Add `ai_candidate_queue` schema and disabled code path behind `AI_CANDIDATE_BACKLOG_ENABLED=false`.
- Add TypeScript types and a candidate queue service.
- Add tests for enqueue/status transitions.
- Existing production behavior must be unchanged while the flag is false.

Phase 2:
- Add backlog drain for AI scoring in small batches.
- Add `AI_SCORING_BATCH_SIZE`, `AI_MAX_SCORING_BATCHES_PER_RUN`, `AI_CANDIDATE_BACKLOG_DRAIN_LIMIT`, `AI_CANDIDATE_MAX_ATTEMPTS`, and `AI_CANDIDATE_MAX_AGE_HOURS`.
- Reuse existing AI scoring, translation, rule gate, and publish queue flow.
- Respect AI budgets.
- Add tests for batch limit, drain limit, budget stop, failures, and duplicate queue prevention.

Phase 3:
- Add fair source picker behind `AI_FAIR_SOURCE_PICKER_ENABLED`.
- Implement round-robin selection by `source_account`.
- Add tests for account diversity and fallback behavior.

Phase 4:
- Add controlled cron continuation for backlog drain.
- Ensure Telegram due publishing is not blocked.
- Keep runtime bounded.
- Add tests for disabled flag and budget stop behavior.

Phase 5:
- Do not create or enable new Apify market-trending source in code unless explicitly requested.
- Prepare documentation or a safe setup script only if asked.
- New source must not bypass AI scoring or risk checks.

Phase 6:
- Add an operational report or admin endpoint only after backlog behavior is stable.
- Include scraped, duplicate, fresh, pending, scored, selected, rejected, queued, published, source distribution, rejection reasons, and AI budget usage.

Before each phase:
- Run `git status`.
- Confirm branch name.
- Inspect relevant files.
- Explain planned changes.
- Make the smallest possible changes.
- Run validation:
  - `npm test`
  - `npm run typecheck`
  - `npm run build`
- Provide a concise implementation report.

If anything is ambiguous, stop and ask before changing code.
```
