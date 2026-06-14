import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../apps/worker-api/src/services/ai-gate', () => ({
  runAIGate: vi.fn(),
  scoreItems: vi.fn(),
  attachTranslations: vi.fn(),
}));

import { drainAICandidateQueue } from '../apps/worker-api/src/services/backlog-drain';
import { runAIGate } from '../apps/worker-api/src/services/ai-gate';
import { applyPersianCaptionQualityGuard } from '../apps/worker-api/src/services/story-quality-guard';
import type { AICandidateRow, AIGateResult, Env, NormalizedItem, TranslationOutput } from '../apps/worker-api/src/types';

const runAIGateMock = vi.mocked(runAIGate);

function normalized(postId: string): NormalizedItem {
  return {
    platform: 'x', sourceAccount: 'cointelegraph',
    sourceUrl: `https://x.com/cointelegraph/status/${postId}`, postId,
    publishedAt: Math.floor(Date.now() / 1000) - 60,
    text: 'Bitcoin ETF net inflow of $500M today.', media: [],
    engagementLikes: 10, engagementShares: 2, engagementViews: 1000, mediaUrlExpiresSoon: false,
  } as NormalizedItem;
}
function candidate(postId: string): AICandidateRow {
  const item = normalized(postId);
  return {
    id: `cand_${postId}`, source_id: 'src', run_id: 'run_1', category_id: 'crypto', platform: 'x',
    source_account: item.sourceAccount, source_url: item.sourceUrl, post_id: item.postId,
    published_at: item.publishedAt, normalized_item_json: JSON.stringify(item),
    dedupe_keys_json: JSON.stringify([`pid:x:${postId}`]), priority_score: 0, status: 'pending',
    attempt_count: 0, last_error: null, created_at: new Date().toISOString(), claimed_at: null, scored_at: null,
  } as AICandidateRow;
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
function rejectedResult(): AIGateResult {
  // publish:false → items are scored then ai_rejected (no queue/translation needed)
  return { publish: false, score: 10, riskLevel: 'low', riskFlags: [], topicFingerprint: 'x', publishPriority: 'normal', translations: {} };
}

function buildDb(rows: AICandidateRow[]) {
  const stmt = (sql: string) => {
    const n = sql.replace(/\s+/g, ' ');
    return {
      run: vi.fn(async () => ({ meta: { changes: 1 } })),
      all: vi.fn(async () => {
        if (n.includes('FROM ai_candidate_queue') && (n.includes("status = 'pending'") || n.includes("status IN ('pending', 'needs_translation')"))) return { results: rows };
        if (n.includes('FROM channels')) return { results: [] };
        if (n.includes('account_handle')) return { results: [] };
        return { results: [] };
      }),
      first: vi.fn(async () => {
        if (n.includes('FROM ai_usage')) return { calls: 0, tokens: 0 };
        if (n.includes('FROM categories')) return category();
        return null;
      }),
    };
  };
  const prepare = vi.fn((sql: string) => ({ bind: vi.fn(() => stmt(sql)), ...stmt(sql) }));
  return { prepare };
}

function env(): Env {
  return {
    DB: { prepare: buildDb(Array.from({ length: 30 }, (_, i) => candidate(String(i + 1)))).prepare } as unknown as D1Database,
    AI_CANDIDATE_BACKLOG_ENABLED: 'true',
    AI_SCORING_BATCH_SIZE: '5',
    AI_MAX_SCORING_BATCHES_PER_RUN: '1',     // normal max = 1 (like production)
    AI_CANDIDATE_BACKLOG_DRAIN_LIMIT: '10',  // base drain limit = 10
    AI_CANDIDATE_MAX_ATTEMPTS: '2',
    AI_CANDIDATE_MAX_AGE_HOURS: '12',
    AI_MAX_CALLS_PER_DAY: '100',
    AI_DAILY_TOKEN_BUDGET: '200000',
    QUEUE_HEALTH_STARVING_MAX_BATCHES: '3',
  } as unknown as Env;
}

describe('hotfix: queue-health maxBatches is NOT re-clamped to normal (issue 2)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs only 1 scoring batch by default', async () => {
    runAIGateMock.mockImplementation(async (_e, items) => items.map(() => rejectedResult()));
    const e = env();
    e.DB = { prepare: buildDb(Array.from({ length: 30 }, (_, i) => candidate(String(i + 1)))).prepare } as unknown as D1Database;
    await drainAICandidateQueue(e, { categoryId: 'crypto' });
    expect(runAIGateMock).toHaveBeenCalledTimes(1);
  });

  it('runs up to the elevated maxBatches when the controller requests it (was clamped to 1 before the fix)', async () => {
    runAIGateMock.mockImplementation(async (_e, items) => items.map(() => rejectedResult()));
    const e = env();
    e.DB = { prepare: buildDb(Array.from({ length: 30 }, (_, i) => candidate(String(i + 1)))).prepare } as unknown as D1Database;
    await drainAICandidateQueue(e, { categoryId: 'crypto', maxBatches: 3 });
    expect(runAIGateMock).toHaveBeenCalledTimes(3);
  });
});

function t(captionFull: string): TranslationOutput {
  return { captionShort: captionFull, captionFull, hashtags: [] };
}

describe('hotfix: filler-tail strip keeps informative captions (issue 9)', () => {
  it('strips a trailing pure-filler sentence but keeps the factual one', () => {
    const src = 'Janus Henderson JAAA fund brought $200M onto Solana.';
    const out = applyPersianCaptionQualityGuard(
      'fa',
      t('ورود ۲۰۰ میلیون دلار صندوق JAAA به سولانا. این خبر نشان‌دهنده پذیرش نهادی است.'),
      src,
    );
    expect(out.ok).toBe(true);
    // the factual sentence remains, the cliché tail is gone
    expect(out.translation!.captionFull).toContain('۲۰۰ میلیون دلار');
    expect(out.translation!.captionFull).not.toContain('نشان‌دهنده پذیرش نهادی');
  });

  it('still rejects a caption that is filler through-and-through', () => {
    const out = applyPersianCaptionQualityGuard('fa', t('این خبر نشان‌دهنده پذیرش نهادی است.'), 'A protocol announced an integration.');
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('caption_generic_filler');
  });
});
