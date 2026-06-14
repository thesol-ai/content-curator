import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../apps/worker-api/src/services/ai-gate', () => ({
  runAIGate: vi.fn(),
  scoreItems: vi.fn(),
  attachTranslations: vi.fn(),
}));

import { drainAICandidateQueue } from '../apps/worker-api/src/services/backlog-drain';
import { attachTranslations, runAIGate, scoreItems } from '../apps/worker-api/src/services/ai-gate';
import type { AICandidateRow, AIGateResult, Env, NormalizedItem } from '../apps/worker-api/src/types';

const scoreItemsMock = vi.mocked(scoreItems);
const attachTranslationsMock = vi.mocked(attachTranslations);
const runAIGateMock = vi.mocked(runAIGate);

const ETF_TEXT = 'Bitcoin ETF saw net inflow of $500M today.';

function normalized(postId: string): NormalizedItem {
  return {
    platform: 'x',
    sourceAccount: 'cointelegraph',
    sourceUrl: `https://x.com/cointelegraph/status/${postId}`,
    postId,
    publishedAt: Math.floor(Date.now() / 1000) - 60,
    text: ETF_TEXT,
    media: [],
    engagementLikes: 10,
    engagementShares: 2,
    engagementViews: 1000,
    mediaUrlExpiresSoon: false,
  } as NormalizedItem;
}

function candidate(postId: string): AICandidateRow {
  const item = normalized(postId);
  return {
    id: `cand_${postId}`,
    source_id: 'src',
    run_id: 'run_1',
    category_id: 'crypto',
    platform: 'x',
    source_account: item.sourceAccount,
    source_url: item.sourceUrl,
    post_id: item.postId,
    published_at: item.publishedAt,
    normalized_item_json: JSON.stringify(item),
    dedupe_keys_json: JSON.stringify([`pid:x:${postId}`]),
    priority_score: 0,
    status: 'pending',
    attempt_count: 0,
    last_error: null,
    created_at: new Date().toISOString(),
    claimed_at: null,
    scored_at: null,
  } as AICandidateRow;
}

function scored(): AIGateResult {
  return {
    publish: true,
    score: 90,
    riskLevel: 'low',
    riskFlags: [],
    topicFingerprint: 'spot-bitcoin-etf-inflows',
    publishPriority: 'normal',
    translations: {},
  };
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

function env(prepare: ReturnType<typeof vi.fn>): Env {
  return {
    DB: { prepare } as unknown as D1Database,
    AI_CANDIDATE_BACKLOG_ENABLED: 'true',
    AI_SCORING_BATCH_SIZE: '10',
    AI_MAX_SCORING_BATCHES_PER_RUN: '1',
    AI_CANDIDATE_BACKLOG_DRAIN_LIMIT: '20',
    AI_CANDIDATE_MAX_ATTEMPTS: '2',
    AI_CANDIDATE_MAX_AGE_HOURS: '12',
    AI_MAX_CALLS_PER_DAY: '100',
    AI_DAILY_TOKEN_BUDGET: '200000',
    BACKLOG_TRANSLATE_AFTER_GATES_ENABLED: 'true',
  } as unknown as Env;
}

function buildDb(rows: AICandidateRow[]) {
  const sqls: string[] = [];
  const stmt = (sql: string) => {
    const n = sql.replace(/\s+/g, ' ');
    return {
      run: vi.fn(async () => ({ meta: { changes: 1 } })),
      all: vi.fn(async () => {
        if (n.includes('FROM ai_candidate_queue') && (n.includes("status = 'pending'") || n.includes("status IN ('pending', 'needs_translation')"))) return { results: rows };
        if (n.includes('FROM channels')) return { results: [CHANNEL] };
        if (n.includes('account_handle')) return { results: [] };
        return { results: [] }; // story-cluster / theme lookups → no recent matches
      }),
      first: vi.fn(async () => {
        if (n.includes('FROM ai_usage')) return { calls: 0, tokens: 0 };
        if (n.includes('FROM categories')) return category();
        return null; // topic-dup "found", MAX(scheduled_at), quota counts
      }),
    };
  };
  const prepare = vi.fn((sql: string) => {
    sqls.push(sql);
    const s = stmt(sql);
    return { bind: vi.fn(() => s), ...s };
  });
  return { prepare, sqls };
}

describe('Phase 6H — translate after gates', () => {
  beforeEach(() => vi.clearAllMocks());

  it('scores all but translates ONLY survivors, rejecting the intra-batch duplicate', async () => {
    scoreItemsMock.mockResolvedValueOnce([scored(), scored()]); // both identical ETF story
    attachTranslationsMock.mockImplementation(async (_e, items) =>
      items.map(() => ({
        ...scored(),
        translations: { fa: { captionShort: 'کوتاه', captionFull: 'کامل', hashtags: ['#BTC'] } },
      })),
    );

    const db = buildDb([candidate('1'), candidate('2')]);
    const result = await drainAICandidateQueue(env(db.prepare), { categoryId: 'crypto', maxBatches: 1 });

    // scoring ran on the batch; runAIGate (combined) was NOT used in this path
    expect(scoreItemsMock).toHaveBeenCalledTimes(1);
    expect(runAIGateMock).not.toHaveBeenCalled();

    // translation paid for survivors only (1 of 2 — the second is a story dup)
    expect(attachTranslationsMock).toHaveBeenCalledTimes(1);
    const translatedItems = attachTranslationsMock.mock.calls[0]![1];
    expect(translatedItems).toHaveLength(1);

    expect(result.candidatesScored).toBe(2);
    expect(result.candidatesSelected).toBe(1);
    expect(result.candidatesRejected).toBe(1);
    expect(result.candidatesQueued).toBe(1);
    expect(db.sqls.some(s => s.includes('INSERT OR IGNORE INTO publish_queue'))).toBe(true);
  });

  it('does not call attachTranslations when every item is rejected', async () => {
    // Two identical items: first survives gates, second is the intra-batch dup.
    // Force both to be rejected by making them non-crypto so pre-AI drops them
    // before scoring — attachTranslations must never run.
    scoreItemsMock.mockResolvedValue([]);
    const nonCrypto = candidate('9');
    const parsed = JSON.parse(nonCrypto.normalized_item_json) as NormalizedItem;
    nonCrypto.normalized_item_json = JSON.stringify({ ...parsed, text: 'A generic post about nothing in particular.' });

    const db = buildDb([nonCrypto]);
    await drainAICandidateQueue(env(db.prepare), { categoryId: 'crypto', maxBatches: 1 });
    expect(attachTranslationsMock).not.toHaveBeenCalled();
  });

  it('review-4 fix: a translation failure releases survivors to pending instead of stranding them as claimed', async () => {
    scoreItemsMock.mockResolvedValueOnce([scored()]);
    attachTranslationsMock.mockRejectedValueOnce(new Error('gemini 503'));

    const db = buildDb([candidate('1')]);
    const result = await drainAICandidateQueue(env(db.prepare), { categoryId: 'crypto', maxBatches: 1 });

    // it tried to translate, failed, and must NOT have queued anything…
    expect(attachTranslationsMock).toHaveBeenCalledTimes(1);
    expect(result.candidatesQueued).toBe(0);
    // …and must have issued an UPDATE returning the claimed row to pending
    // (releaseClaimedCandidatesToPending), not left it claimed.
    const released = db.sqls.some(s => /UPDATE ai_candidate_queue/i.test(s) && /pending/i.test(s));
    expect(released).toBe(true);
  });
});
