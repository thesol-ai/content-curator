import { beforeEach, describe, expect, it, vi } from 'vitest';
import { drainAICandidateQueue } from '../apps/worker-api/src/services/backlog-drain';
import { runAIGate } from '../apps/worker-api/src/services/ai-gate';
import type { AICandidateRow, CategoryRow, Env, NormalizedItem } from '../apps/worker-api/src/types';

vi.mock('../apps/worker-api/src/services/ai-gate', () => ({
  runAIGate: vi.fn(),
}));

const runAIGateMock = vi.mocked(runAIGate);

function item(overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    platform: 'x',
    sourceAccount: 'cointelegraph',
    sourceUrl: 'https://x.com/cointelegraph/status/1',
    postId: '1',
    publishedAt: Math.floor(Date.now() / 1000) - 60,
    text: 'Bitcoin ETF flows rise as institutional demand increases.',
    media: [],
    engagementLikes: 10,
    engagementShares: 2,
    engagementViews: 1000,
    mediaUrlExpiresSoon: false,
    ...overrides,
  };
}

function candidate(overrides: Partial<AICandidateRow> = {}): AICandidateRow {
  const normalized = item(overrides.source_url ? { sourceUrl: overrides.source_url } : {});
  return {
    id: 'cand_1',
    source_id: 'src',
    run_id: 'run_1',
    category_id: 'crypto',
    platform: 'x',
    source_account: normalized.sourceAccount,
    source_url: normalized.sourceUrl,
    post_id: normalized.postId,
    published_at: normalized.publishedAt,
    normalized_item_json: JSON.stringify(normalized),
    dedupe_keys_json: JSON.stringify(['pid:x:1', 'url:1']),
    priority_score: 0,
    status: 'pending',
    attempt_count: 0,
    last_error: null,
    created_at: new Date().toISOString(),
    claimed_at: null,
    scored_at: null,
    ...overrides,
  };
}

function category(overrides: Partial<CategoryRow> = {}): CategoryRow {
  return {
    id: 'crypto',
    label: 'Crypto',
    prompt_profile: 'crypto_editorial',
    custom_prompt: null,
    score_threshold: 75,
    freshness_hours: 6,
    media_mode: 'optional',
    language_targets: '["fa"]',
    editorial_guidelines: null,
    selection_criteria: null,
    rejection_criteria: null,
    required_context: null,
    avoid_duplicate_people_stories: 1,
    allow_replies: 0,
    allow_retweets: 1,
    allow_quotes: 1,
    text_only_policy: 'allow',
    min_score_for_text_only: null,
    min_score_for_media: null,
    enabled: 1,
    ...overrides,
  };
}

function envWithDb(prepare: ReturnType<typeof vi.fn>, overrides: Partial<Env> = {}): Env {
  return {
    DB: { prepare } as unknown as D1Database,
    AI_CANDIDATE_BACKLOG_ENABLED: 'true',
    AI_SCORING_BATCH_SIZE: '10',
    AI_MAX_SCORING_BATCHES_PER_RUN: '2',
    AI_CANDIDATE_BACKLOG_DRAIN_LIMIT: '20',
    AI_CANDIDATE_MAX_ATTEMPTS: '2',
    AI_CANDIDATE_MAX_AGE_HOURS: '6',
    AI_MAX_CALLS_PER_DAY: '10',
    AI_DAILY_TOKEN_BUDGET: '50000',
    ...overrides,
  } as unknown as Env;
}

function makeDb(rows: AICandidateRow[], opts: { callsToday?: number; category?: CategoryRow } = {}) {
  const sqls: string[] = [];
  const bindArgs: unknown[][] = [];
  const prepare = vi.fn((sql: string) => {
    sqls.push(sql);
    const normalized = sql.replace(/\s+/g, ' ');
    return {
      bind: vi.fn((...args: unknown[]) => {
        bindArgs.push(args);
        return makeStatement(normalized, rows, opts);
      }),
      ...makeStatement(normalized, rows, opts),
    };
  });
  return { prepare, sqls, bindArgs };
}

function makeStatement(sql: string, rows: AICandidateRow[], opts: { callsToday?: number; category?: CategoryRow }) {
  return {
    run: vi.fn(async () => {
      if (sql.includes("SET status='scoring'")) return { meta: { changes: 1 } };
      if (sql.includes("SET status='pending'")) return { meta: { changes: 1 } };
      if (sql.includes("SET status='failed'")) return { meta: { changes: 0 } };
      return { meta: { changes: 1 } };
    }),
    all: vi.fn(async () => {
      if (sql.includes('SELECT * FROM ai_candidate_queue')) return { results: rows };
      if (sql.includes('SELECT * FROM channels')) return { results: [] };
      if (sql.includes('SELECT account_handle')) return { results: [] };
      return { results: [] };
    }),
    first: vi.fn(async () => {
      if (sql.includes('FROM ai_usage')) return { calls: opts.callsToday ?? 0, tokens: 0 };
      if (sql.includes('FROM categories')) return opts.category ?? category();
      return null;
    }),
  };
}

describe('backlog drain phase 2 safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a no-op when the backlog feature flag is off', async () => {
    const prepare = vi.fn();
    const result = await drainAICandidateQueue(envWithDb(prepare, { AI_CANDIDATE_BACKLOG_ENABLED: 'false' }));

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('backlog_disabled');
    expect(prepare).not.toHaveBeenCalled();
  });

  it('stops before claiming candidates when the scoring call budget is already exhausted', async () => {
    const db = makeDb([candidate()], { callsToday: 10 });
    const result = await drainAICandidateQueue(envWithDb(db.prepare), { categoryId: 'crypto', maxBatches: 1 });

    expect(result.stoppedByBudget).toBe(true);
    expect(result.candidatesClaimed).toBe(0);
    expect(runAIGateMock).not.toHaveBeenCalled();
    expect(db.sqls.some(sql => sql.includes("SET status='scoring'"))).toBe(false);
  });

  it('releases claimed candidates back to pending when runAIGate reports ai_budget_exceeded instead of throwing', async () => {
    runAIGateMock.mockResolvedValueOnce([{
      publish: false,
      score: 0,
      riskLevel: 'medium',
      riskFlags: ['ai_budget_exceeded'],
      topicFingerprint: 'budget',
      publishPriority: 'normal',
      translations: {},
    }]);
    const db = makeDb([candidate()], { callsToday: 0 });

    const result = await drainAICandidateQueue(envWithDb(db.prepare), { categoryId: 'crypto', maxBatches: 1 });

    expect(result.stoppedByBudget).toBe(true);
    expect(db.sqls.some(sql => sql.includes("SET status='pending'") && sql.includes('attempt_count=CASE'))).toBe(true);
  });

  it('persists pre-AI policy rejections as discovery_items and marks the candidate rejected', async () => {
    const reply = candidate();
    const parsed = JSON.parse(reply.normalized_item_json) as NormalizedItem;
    reply.normalized_item_json = JSON.stringify({ ...parsed, isReply: true });
    const db = makeDb([reply], { callsToday: 0, category: category({ allow_replies: 0 }) });

    const result = await drainAICandidateQueue(envWithDb(db.prepare), { categoryId: 'crypto', maxBatches: 1 });

    expect(result.candidatesRejected).toBe(1);
    expect(runAIGateMock).not.toHaveBeenCalled();
    expect(db.sqls.some(sql => sql.includes('INSERT OR IGNORE INTO discovery_items'))).toBe(true);
    expect(db.sqls.some(sql => sql.includes('status') && sql.includes('ai_candidate_queue'))).toBe(true);
  });

  it('rejects and does not enqueue a candidate when the same semantic topic was recently queued for the channel', async () => {
    const source = candidate();
    runAIGateMock.mockResolvedValueOnce([{
      publish: true,
      score: 90,
      riskLevel: 'low',
      riskFlags: [],
      topicFingerprint: 'humanity-exploit',
      publishPriority: 'normal',
      translations: {
        fa: { captionShort: 'خبر کوتاه', captionFull: 'خبر کامل', hashtags: ['#Crypto'] },
      },
    }]);

    const db = makeDb([source], { callsToday: 0 });
    db.prepare.mockImplementation((sql: string) => {
      db.sqls.push(sql);
      const normalized = sql.replace(/\s+/g, ' ');
      const statement = makeStatement(normalized, [source], { callsToday: 0 });
      const captureBind = <T>(factory: () => T) => vi.fn((...args: unknown[]) => {
        db.bindArgs.push(args);
        return factory();
      });

      if (normalized.includes('SELECT * FROM channels')) {
        return {
          bind: captureBind(() => ({ all: vi.fn(async () => ({ results: [{
            id: 'ch_fa', category_id: 'crypto', telegram_chat_id: '@x', language: 'fa', timezone: 'Asia/Tehran',
            allowed_windows: '[]', blocked_windows: '[]', max_per_day: 100, max_per_hour: 10, min_gap_minutes: 0,
            publish_enabled: 1, enabled: 1, custom_instructions: null, tone_profile: 'neutral', channel_label: null,
            source_enabled: 1, source_label_override: null, signature_enabled: 0, signature_text: null,
            channel_id_footer_enabled: 0, channel_id_footer_text: null, disable_link_preview: 1,
            semantic_dedupe_enabled: 1, semantic_dedupe_window_hours: 48, max_posts_per_source_per_day: null,
            editorial_mode: 'news', audience_level: 'intermediate', caption_style: 'contextual', creativity_level: 0.2,
            caption_max_chars: 1200, caption_short_max_chars: 280, language_prompt: null, terminology_notes: null, forbidden_phrases: null,
          }] })) })),
          ...statement,
        };
      }

      if (normalized.includes('FROM publish_queue q') && normalized.includes('JOIN discovery_items d')) {
        return {
          bind: captureBind(() => ({ first: vi.fn(async () => ({ found: 1 })) })),
          ...statement,
        };
      }

      return { bind: captureBind(() => statement), ...statement };
    });

    const result = await drainAICandidateQueue(envWithDb(db.prepare), { categoryId: 'crypto', maxBatches: 1 });

    expect(result.candidatesSelected).toBe(0);
    expect(result.candidatesRejected).toBe(1);
    expect(result.candidatesQueued).toBe(0);
    expect(db.sqls.some(sql => sql.includes('INSERT OR IGNORE INTO publish_queue'))).toBe(false);
    expect(db.bindArgs.flat()).toContain('similar_topic_recent_channel');
  });

  it('uses candidate_id in publish_queue inserts so retrying a candidate cannot enqueue the same channel twice', async () => {
    const source = candidate();
    runAIGateMock.mockResolvedValueOnce([{
      publish: true,
      score: 90,
      riskLevel: 'low',
      riskFlags: [],
      topicFingerprint: 'btc-etf-flows',
      publishPriority: 'normal',
      translations: {
        fa: { captionShort: 'خبر کوتاه', captionFull: 'خبر کامل', hashtags: ['#BTC'] },
      },
    }]);

    const db = makeDb([source], { callsToday: 0 });
    // Override channels result for this test.
    db.prepare.mockImplementation((sql: string) => {
      db.sqls.push(sql);
      const normalized = sql.replace(/\s+/g, ' ');
      const statement = makeStatement(normalized, [source], { callsToday: 0 });
      if (normalized.includes('SELECT * FROM channels')) {
        return {
          bind: vi.fn(() => ({ all: vi.fn(async () => ({ results: [{
            id: 'ch_fa', category_id: 'crypto', telegram_chat_id: '@x', language: 'fa', timezone: 'Asia/Tehran',
            allowed_windows: '[]', blocked_windows: '[]', max_per_day: 100, max_per_hour: 10, min_gap_minutes: 0,
            publish_enabled: 1, enabled: 1, custom_instructions: null, tone_profile: 'neutral', channel_label: null,
            source_enabled: 1, source_label_override: null, signature_enabled: 0, signature_text: null,
            channel_id_footer_enabled: 0, channel_id_footer_text: null, disable_link_preview: 1,
            semantic_dedupe_enabled: 0, semantic_dedupe_window_hours: 24, max_posts_per_source_per_day: null,
            editorial_mode: 'news', audience_level: 'intermediate', caption_style: 'contextual', creativity_level: 0.2,
            caption_max_chars: 1200, caption_short_max_chars: 280, language_prompt: null, terminology_notes: null, forbidden_phrases: null,
          }] })) })),
          ...statement,
        };
      }
      return { bind: vi.fn((..._args: unknown[]) => statement), ...statement };
    });

    const result = await drainAICandidateQueue(envWithDb(db.prepare), { categoryId: 'crypto', maxBatches: 1 });

    expect(result.candidatesQueued).toBe(1);
    const publishSql = db.sqls.find(sql => sql.includes('INSERT OR IGNORE INTO publish_queue')) ?? '';
    expect(publishSql).toContain('candidate_id');
  });
});
