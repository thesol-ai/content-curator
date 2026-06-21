// Integration: full drainAICandidateQueue under the RSS-brief daily budget, on a
// real SQLite DB. Only the AI calls (scoreItems / attachTranslations) are mocked;
// the queue state machine, gates, rule gate, brief budget, and the Anthropic
// brief endpoint (test B) run for real.
//
// Two budget states are proven:
//   A. budget ALREADY exhausted at drain start → RSS is excluded before
//      claim/scoring (no AI scoring/duplicate-judge churn), non-RSS still drains.
//   B. budget hit MID-tick → the RSS survivor that crossed the cap is released to
//      pending with attempt DECREMENTED (not burned, not persisted), while the
//      RSS that fit the budget is briefed/queued and non-RSS still drains.

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

function fillBriefBudget(db: FakeD1, n: number): void {
  for (let i = 0; i < n; i++) {
    db.exec(`INSERT INTO ai_usage (id, provider, purpose, model, input_tokens, output_tokens, status)
             VALUES ('u${i}', 'anthropic', 'rss_brief', 'claude-test', 10, 10, 'success')`);
  }
}

function baseEnv(db: FakeD1, overrides: Record<string, string> = {}): any {
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
    ...overrides,
  };
}

function scoredPlatforms(): string[] {
  return scoreItemsMock.mock.calls.flatMap(call => (call[1] as NormalizedItem[]).map(i => i.platform));
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
  db.exec(`UPDATE categories SET score_threshold = 50, freshness_hours = 24, text_only_policy = 'allow',
            min_score_for_text_only = NULL, min_score_for_media = NULL WHERE id = 'crypto'`);
  db.exec(`INSERT INTO discovery_runs (id, category_id, platform, apify_dataset_id, status) VALUES ('run1', 'crypto', 'x', 'ds1', 'processing')`);

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
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('drainAICandidateQueue — RSS brief budget is platform-scoped', () => {
  it('A: when the brief budget is ALREADY exhausted, RSS is never scored and non-RSS still drains', async () => {
    fillBriefBudget(db, 2); // == RSS_BRIEF_MAX_CALLS_PER_DAY → exhausted at drain start
    // RSS carries a huge priority_score (publishedAt) so it sorts ahead of non-RSS.
    seedCandidate(db, 'rss', 'r1', NOW - 60);
    seedCandidate(db, 'rss', 'r2', NOW - 61);
    seedCandidate(db, 'x', 'x1', 10);
    seedCandidate(db, 'x', 'x2', 9);

    const result = await drainAICandidateQueue(baseEnv(db), { categoryId: 'crypto', maxBatches: 3 });

    // No drain failure; RSS deferral surfaced as a structured warning, not `error`.
    expect(result.stoppedByBudget).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.rssBudgetExhausted).toBe(true);
    expect(result.deferredPlatforms).toEqual(['rss']);
    expect(result.warnings).toContain('rss_brief_daily_cap');

    // The cost-churn guarantee: RSS never entered scoring at all.
    expect(scoredPlatforms()).not.toContain('rss');

    // RSS untouched: still pending, attempt_count 0, never claimed (no defer reason).
    const rss = db.rows<{ status: string; attempt_count: number; last_error: string | null }>(
      `SELECT status, attempt_count, last_error FROM ai_candidate_queue WHERE platform='rss' ORDER BY id`);
    expect(rss.map(r => r.status)).toEqual(['pending', 'pending']);
    expect(rss.map(r => r.attempt_count)).toEqual([0, 0]);
    expect(rss.every(r => r.last_error === null)).toBe(true);
    expect(db.get<{ c: number }>(`SELECT COUNT(*) c FROM discovery_items WHERE platform='rss'`)!.c).toBe(0);

    // Non-RSS drained to the publish queue.
    const nonRss = db.rows<{ status: string }>(`SELECT status FROM ai_candidate_queue WHERE platform='x'`);
    expect(nonRss.every(r => r.status !== 'pending' && r.status !== 'scoring')).toBe(true);
    expect(db.get<{ c: number }>(`SELECT COUNT(*) c FROM publish_queue WHERE channel_id='ch_fa'`)!.c).toBe(2);
  });

  it('B: when the cap is hit MID-tick, the over-cap RSS is deferred without burning attempts; non-RSS drains', async () => {
    fillBriefBudget(db, 0); // room for exactly 1 brief before the cap of 1
    // Anthropic brief endpoint returns a valid Persian brief (only call that fetches).
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      content: [{ text: JSON.stringify({
        captionShort: 'تیتر کوتاه فارسی',
        captionFull: 'این یک تحلیل کاملا فارسی و اصیل درباره یک رویداد کریپتویی است که به اندازه کافی بلند است و هیچ همپوشانی با متن منبع انگلیسی ندارد.',
        hashtags: ['#کریپتو'],
      }) }],
      usage: { input_tokens: 10, output_tokens: 20 },
    }), { status: 200 })));

    seedCandidate(db, 'rss', 'r1', NOW - 60); // briefed (fits the budget of 1)
    seedCandidate(db, 'rss', 'r2', NOW - 61); // crosses the cap → deferred
    seedCandidate(db, 'x', 'x1', 10);
    seedCandidate(db, 'x', 'x2', 9);

    const env = baseEnv(db, { RSS_BRIEF_MAX_CALLS_PER_DAY: '1', ANTHROPIC_API_KEY: 'k' });
    const result = await drainAICandidateQueue(env, { categoryId: 'crypto', maxBatches: 3 });

    expect(result.stoppedByBudget).toBe(false);
    expect(result.rssBudgetExhausted).toBe(true);

    // r1 briefed and queued; r2 deferred to pending with attempt NOT burned.
    const r1 = db.get<{ status: string }>(`SELECT status FROM ai_candidate_queue WHERE id='cand_rss_r1'`)!;
    const r2 = db.get<{ status: string; attempt_count: number; last_error: string }>(
      `SELECT status, attempt_count, last_error FROM ai_candidate_queue WHERE id='cand_rss_r2'`)!;
    expect(r1.status).toBe('queued');
    expect(r2.status).toBe('pending');
    expect(r2.attempt_count).toBe(0);
    expect(r2.last_error).toBe('rss_brief_daily_cap');
    expect(db.get<{ c: number }>(`SELECT COUNT(*) c FROM discovery_items WHERE source_url LIKE '%/r2'`)!.c).toBe(0);

    // Non-RSS still drained: queue holds the briefed r1 + both x items.
    const nonRss = db.rows<{ status: string }>(`SELECT status FROM ai_candidate_queue WHERE platform='x'`);
    expect(nonRss.every(r => r.status !== 'pending' && r.status !== 'scoring')).toBe(true);
    expect(db.get<{ c: number }>(`SELECT COUNT(*) c FROM publish_queue WHERE channel_id='ch_fa'`)!.c).toBe(3);
  });
});
