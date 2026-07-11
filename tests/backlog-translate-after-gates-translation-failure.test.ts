import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../apps/worker-api/src/services/ai-gate', () => ({
  runAIGate: vi.fn(),
  scoreItems: vi.fn(),
  attachTranslations: vi.fn(),
}));

import { drainAICandidateQueue } from '../apps/worker-api/src/services/backlog-drain';
import { scoreItems, attachTranslations } from '../apps/worker-api/src/services/ai-gate';
import type { AICandidateRow, AIGateResult, Env, NormalizedItem } from '../apps/worker-api/src/types';

const scoreItemsMock = vi.mocked(scoreItems);
const attachTranslationsMock = vi.mocked(attachTranslations);

function normalized(postId: string, text: string): NormalizedItem {
  return {
    platform: 'x', sourceAccount: 'cointelegraph',
    sourceUrl: `https://x.com/cointelegraph/status/${postId}`, postId,
    publishedAt: Math.floor(Date.now() / 1000) - 60, text, media: [],
    engagementLikes: 10, engagementShares: 2, engagementViews: 1000, mediaUrlExpiresSoon: false,
  } as NormalizedItem;
}
function candidate(postId: string, text: string): AICandidateRow {
  const item = normalized(postId, text);
  return {
    id: `cand_${postId}`, source_id: 'src', run_id: 'run_1', category_id: 'crypto', platform: 'x',
    source_account: item.sourceAccount, source_url: item.sourceUrl, post_id: item.postId,
    published_at: item.publishedAt, normalized_item_json: JSON.stringify(item),
    dedupe_keys_json: JSON.stringify([`pid:x:${postId}`]), priority_score: 0, status: 'pending',
    attempt_count: 0, last_error: null, created_at: new Date().toISOString(), claimed_at: null, scored_at: null,
  } as AICandidateRow;
}
function scored(fp: string): AIGateResult {
  return { publish: true, score: 90, riskLevel: 'low', riskFlags: [], topicFingerprint: fp, publishPriority: 'normal', translations: {} };
}
function category() {
  return {
    id: 'crypto', label: 'Crypto', prompt_profile: 'crypto_editorial', custom_prompt: null,
    score_threshold: 75, freshness_hours: 6, media_mode: 'optional', language_targets: '["fa"]',
    editorial_guidelines: null, selection_criteria: null, rejection_criteria: null, required_context: null,
    avoid_duplicate_people_stories: 1, allow_replies: 0, allow_retweets: 1, allow_quotes: 1,
    text_only_policy: 'allow', min_score_for_text_only: null, min_score_for_media: null, enabled: 1,
  };
}
const CHANNEL = {
  id: 'ch_fa', category_id: 'crypto', telegram_chat_id: '@x', language: 'fa', timezone: 'Asia/Tehran',
  allowed_windows: '[]', blocked_windows: '[]', max_per_day: 100, max_per_hour: 10, min_gap_minutes: 0,
  publish_enabled: 1, enabled: 1, semantic_dedupe_enabled: 1, semantic_dedupe_window_hours: 48,
};
function buildDb(rows: AICandidateRow[]) {
  const sqls: string[] = [];
  const stmt = (sql: string) => {
    const n = sql.replace(/\s+/g, ' ');
    return {
      run: vi.fn(async () => ({ meta: { changes: 1 } })),
      all: vi.fn(async () => {
        if (n.includes('FROM ai_candidate_queue') && (n.includes("status = 'pending'") || n.includes("status IN ('pending', 'needs_translation')"))) return { results: rows };
        if (n.includes('FROM channels')) return { results: [CHANNEL] };
        return { results: [] };
      }),
      first: vi.fn(async () => {
        if (n.includes('FROM ai_usage')) return { calls: 0, tokens: 0 };
        if (n.includes('FROM categories')) return category();
        return null;
      }),
    };
  };
  const prepare = vi.fn((sql: string) => { sqls.push(sql); const s = stmt(sql); return { bind: vi.fn(() => s), ...s }; });
  return { prepare, sqls };
}
function env(prepare: ReturnType<typeof vi.fn>): Env {
  return {
    DB: { prepare } as unknown as D1Database,
    AI_CANDIDATE_BACKLOG_ENABLED: 'true', AI_SCORING_BATCH_SIZE: '10', AI_MAX_SCORING_BATCHES_PER_RUN: '1',
    AI_CANDIDATE_BACKLOG_DRAIN_LIMIT: '20', AI_CANDIDATE_MAX_ATTEMPTS: '2', AI_CANDIDATE_MAX_AGE_HOURS: '12',
    AI_MAX_CALLS_PER_DAY: '100', AI_DAILY_TOKEN_BUDGET: '200000', BACKLOG_TRANSLATE_AFTER_GATES_ENABLED: 'true',
  } as unknown as Env;
}

describe('6H translation-failure path (provider 503 must not strand survivors)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('releases 2 survivors to pending, queues nothing, records no publish row', async () => {
    scoreItemsMock.mockResolvedValueOnce([scored('story-a'), scored('story-b')]); // 2 distinct survivors
    attachTranslationsMock.mockRejectedValueOnce(new Error('gemini 503 service unavailable'));

    const db = buildDb([candidate('1', 'Bitcoin ETF saw $500M net inflow today.'), candidate('2', 'Ethereum upgrade ships on mainnet today.')]);
    const result = await drainAICandidateQueue(env(db.prepare), { categoryId: 'crypto', maxBatches: 1 });

    expect(attachTranslationsMock).toHaveBeenCalledTimes(1);
    expect(result.candidatesQueued).toBe(0);
    // no publish_queue insert happened
    expect(db.sqls.some(s => /INSERT OR IGNORE INTO publish_queue/i.test(s))).toBe(false);
    // survivors were returned to pending (release UPDATE), not left claimed
    expect(db.sqls.some(s => /UPDATE ai_candidate_queue/i.test(s) && /pending/i.test(s))).toBe(true);
  });

  it('retries scoring_error without writing publish or dedupe state', async () => {
    scoreItemsMock.mockResolvedValueOnce([{
      publish: false,
      score: 0,
      riskLevel: 'medium',
      riskFlags: ['scoring_error'],
      topicFingerprint: 'err-1',
      publishPriority: 'normal',
      translations: {},
    }]);

    const db = buildDb([
      candidate(
        '1',
        'Bitcoin ETF saw $500M net inflow today.',
      ),
    ]);

    const result = await drainAICandidateQueue(
      env(db.prepare),
      {
        categoryId: 'crypto',
        maxBatches: 1,
      },
    );

    expect(result.error).toBe('scoring_error_retry');
    expect(result.stoppedByBudget).toBe(false);
    expect(result.candidatesQueued).toBe(0);
    expect(result.candidatesRejected).toBe(0);
    expect(result.candidatesSkipped).toBe(1);

    expect(
      db.sqls.some(
        sql => /INSERT OR IGNORE INTO publish_queue/i.test(sql),
      ),
    ).toBe(false);

    expect(
      db.sqls.some(
        sql => /INSERT OR IGNORE INTO dedupe_keys/i.test(sql),
      ),
    ).toBe(false);

    expect(
      db.sqls.some(
        sql =>
          /UPDATE ai_candidate_queue/i.test(sql)
          && /status='pending'/i.test(sql),
      ),
    ).toBe(true);

    expect(
      db.sqls.some(
        sql => sql.includes(
          'attempt_count=CASE WHEN ?',
        ),
      ),
    ).toBe(true);
  });

});
