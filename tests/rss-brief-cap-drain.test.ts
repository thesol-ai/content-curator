// Integration: full drainAICandidateQueue under an exhausted RSS-brief budget.
//
// Proves the platform-scoped cap behavior end-to-end on a real SQLite DB:
//   - RSS survivors hitting the daily brief cap are released to pending with the
//     attempt DECREMENTED (never burned toward max-attempts) and NOT persisted.
//   - The RSS cap does NOT halt the whole drain: non-RSS candidates sitting
//     behind RSS (RSS sorts first by priority_score = publishedAt) still drain
//     to the publish_queue in the same tick.
//
// Only the AI calls (scoreItems / attachTranslations) are mocked; the queue
// state machine, gates, rule gate, and budget counters run for real.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../apps/worker-api/src/services/ai-gate', () => ({
  runAIGate: vi.fn(),
  scoreItems: vi.fn(),
  attachTranslations: vi.fn(),
  channelTranslationKey: (channelId: string) => `channel:${channelId}`,
}));

import { makeTestDb, type FakeD1 } from './helpers/fake-d1';
import { drainAICandidateQueue } from '../apps/worker-api/src/services/backlog-drain';
import { attachTranslations, scoreItems } from '../apps/worker-api/src/services/ai-gate';
import type { AIGateResult, NormalizedItem } from '../apps/worker-api/src/types';

const scoreItemsMock = vi.mocked(scoreItems);
const attachTranslationsMock = vi.mocked(attachTranslations);

const NOW = Math.floor(Date.now() / 1000);

function item(platform: 'rss' | 'x', postId: string): NormalizedItem {
  const host = platform === 'rss' ? 'https://www.coindesk.com' : 'https://x.com/acct/status';
  return {
    platform,
    sourceAccount: platform === 'rss' ? 'coindesk' : 'someacct',
    sourceUrl: `${host}/${postId}`,
    postId,
    publishedAt: NOW - 60,
    text: `Story ${postId} about a distinct crypto topic ${postId}.`,
    media: platform === 'x' ? [{ type: 'image', url: `https://img/${postId}.jpg` }] : [],
    engagementLikes: 5,
    engagementShares: 1,
    engagementViews: 100,
    mediaUrlExpiresSoon: false,
  } as NormalizedItem;
}

function scored(postId: string): AIGateResult {
  return {
    publish: true,
    score: 95,
    riskLevel: 'low',
    riskFlags: [],
    topicFingerprint: `topic-${postId}`,
    publishPriority: 'normal',
    translations: {},
  };
}

function seedCandidate(db: FakeD1, platform: 'rss' | 'x', postId: string, priority: number): void {
  const it = item(platform, postId);
  db.exec(`
    INSERT INTO ai_candidate_queue
      (id, source_id, run_id, category_id, platform, source_account, source_url, post_id,
       published_at, normalized_item_json, dedupe_keys_json, priority_score, status, attempt_count, created_at)
    VALUES (
      'cand_${platform}_${postId}', 'src', 'run1', 'crypto', '${platform}', '${it.sourceAccount}',
      '${it.sourceUrl}', '${postId}', ${it.publishedAt},
      '${JSON.stringify(it).replace(/'/g, "''")}', '["pid:${platform}:${postId}"]',
      ${priority}, 'pending', 0, CURRENT_TIMESTAMP
    )
  `);
}

function baseEnv(db: FakeD1): any {
  return {
    DB: db,
    AI_CANDIDATE_BACKLOG_ENABLED: 'true',
    BACKLOG_TRANSLATE_AFTER_GATES_ENABLED: 'true',
    AI_SCORING_BATCH_SIZE: '2',
    AI_MAX_SCORING_BATCHES_PER_RUN: '3',
    AI_CANDIDATE_BACKLOG_DRAIN_LIMIT: '20',
    AI_CANDIDATE_MAX_ATTEMPTS: '3',
    AI_CANDIDATE_MAX_AGE_HOURS: '24',
    AI_MAX_CALLS_PER_DAY: '100',
    AI_DAILY_TOKEN_BUDGET: '500000',
    RSS_BRIEF_MODEL: 'claude-test',
    RSS_BRIEF_MAX_CALLS_PER_DAY: '2',
  };
}

let db: FakeD1;
beforeEach(() => {
  db = makeTestDb();
  vi.clearAllMocks();
  // A permissive, enabled crypto channel (no semantic dedupe, open windows).
  db.exec(`
    INSERT INTO channels
      (id, category_id, telegram_chat_id, language, timezone, allowed_windows, blocked_windows,
       max_per_day, max_per_hour, min_gap_minutes, publish_enabled, enabled, semantic_dedupe_enabled, semantic_dedupe_window_hours)
    VALUES
      ('ch_fa', 'crypto', '@test', 'fa', 'Asia/Tehran', '[]', '[]', 100, 50, 0, 1, 1, 0, 48)
  `);
  // Make the crypto category permissive so survivors are not policy-rejected.
  db.exec(`UPDATE categories SET score_threshold = 50, freshness_hours = 24, text_only_policy = 'allow',
            min_score_for_text_only = NULL, min_score_for_media = NULL WHERE id = 'crypto'`);
  // discovery_items / persisted decisions reference the candidate's run_id.
  db.exec(`INSERT INTO discovery_runs (id, category_id, platform, apify_dataset_id, status) VALUES ('run1', 'crypto', 'x', 'ds1', 'processing')`);

  // Pre-fill the RSS brief budget to its cap (2 real model calls today).
  for (let i = 0; i < 2; i++) {
    db.exec(`INSERT INTO ai_usage (id, provider, purpose, model, input_tokens, output_tokens, status)
             VALUES ('u${i}', 'anthropic', 'rss_brief', 'claude-test', 10, 10, 'success')`);
  }
});
afterEach(() => vi.restoreAllMocks());

describe('drainAICandidateQueue — RSS brief cap is platform-scoped', () => {
  it('defers RSS without burning attempts while non-RSS keeps draining to the queue', async () => {
    // RSS rows carry a huge priority_score (publishedAt) so they sort to the
    // front; non-RSS rows sort behind them. Batch size 2 → batch 1 is all RSS.
    seedCandidate(db, 'rss', 'r1', NOW - 60);
    seedCandidate(db, 'rss', 'r2', NOW - 61);
    seedCandidate(db, 'x', 'x1', 10);
    seedCandidate(db, 'x', 'x2', 9);

    scoreItemsMock.mockImplementation(async (_e: any, items: NormalizedItem[]) => items.map(it => scored(it.postId)));
    attachTranslationsMock.mockImplementation(async (_e: any, items: NormalizedItem[]) =>
      items.map(it => ({
        ...scored(it.postId),
        translations: {
          'channel:ch_fa': { captionShort: 'کوتاه', captionFull: 'متن کامل تحلیلی', hashtags: ['#BTC'] },
          fa: { captionShort: 'کوتاه', captionFull: 'متن کامل تحلیلی', hashtags: ['#BTC'] },
        },
      })),
    );

    const result = await drainAICandidateQueue(baseEnv(db), { categoryId: 'crypto', maxBatches: 3 });

    // The whole drain was NOT stopped by the RSS cap.
    expect(result.stoppedByBudget).toBe(false);

    // RSS candidates: released back to pending, attempt_count NOT burned.
    const rss = db.rows<{ id: string; status: string; attempt_count: number; last_error: string }>(
      `SELECT id, status, attempt_count, last_error FROM ai_candidate_queue WHERE platform='rss' ORDER BY id`);
    expect(rss.map(r => r.status)).toEqual(['pending', 'pending']);
    expect(rss.map(r => r.attempt_count)).toEqual([0, 0]);
    expect(rss.every(r => r.last_error === 'rss_brief_daily_cap')).toBe(true);

    // RSS never persisted a discovery_item (no premature dedupe_keys lock).
    expect(db.get<{ c: number }>(`SELECT COUNT(*) c FROM discovery_items WHERE platform='rss'`)!.c).toBe(0);

    // Non-RSS candidates: drained to terminal state (NOT left pending), queued.
    const nonRss = db.rows<{ id: string; status: string }>(
      `SELECT id, status FROM ai_candidate_queue WHERE platform='x' ORDER BY id`);
    expect(nonRss.every(r => r.status !== 'pending' && r.status !== 'scoring')).toBe(true);
    expect(db.get<{ c: number }>(`SELECT COUNT(*) c FROM publish_queue WHERE channel_id='ch_fa'`)!.c).toBe(2);
  });
});
