// ══════════════════════════════════════════════════════════════
// tests/candidate-queue.test.ts — Phase 1
// تست‌های unit برای سرویس candidate-queue
// ══════════════════════════════════════════════════════════════

import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  isCandidateBacklogEnabled,
  isFairSourcePickerEnabled,
  getScoringBatchSize,
  getMaxScoringBatchesPerRun,
  getCandidateBacklogDrainLimit,
  getMaxCandidateAttempts,
  getCandidateMaxAgeHours,
  enqueueCandidates,
  updateCandidateStatus,
  updateCandidatesStatus,
  fetchPendingCandidates,
  countPendingCandidates,
  skipStaleCandidates,
  getCandidateQueueStats,
} from '../apps/worker-api/src/services/candidate-queue';
import type { Env, NormalizedItem, AICandidateRow } from '../apps/worker-api/src/types';

// ── Test helpers ──────────────────────────────────────────────

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: makeMockDB(),
    APIFY_TOKEN: 'test',
    ANTHROPIC_API_KEY: 'test',
    GEMINI_API_KEY: 'test',
    OPENAI_API_KEY: 'test',
    TELEGRAM_BOT_TOKEN: 'test',
    INTERNAL_API_SECRET: 'test',
    AI_SCORING_MODEL: 'claude-haiku-4-5-20251001',
    AI_SCORE_THRESHOLD_DEFAULT: '75',
    AI_MAX_CALLS_PER_DAY: '10',
    AI_DAILY_TOKEN_BUDGET: '50000',
    AI_MAX_CANDIDATES_PER_RUN: '12',
    AI_MAX_TEXT_CHARS_PER_ITEM: '400',
    AI_MAX_OUTPUT_TOKENS: '4096',
    AI_MAX_RETRIES: '1',
    TRANSLATION_PROVIDER: 'gemini',
    TRANSLATION_MODEL: 'gemini-2.5-flash-lite',
    APIFY_CURATION_ENABLED: 'true',
    APIFY_CURATION_DRY_RUN: 'false',
    APIFY_MAX_ITEMS_PER_SOURCE: '50',
    TELEGRAM_FINAL_PUBLISH_ENABLED: 'true',
    TELEGRAM_PUBLISH_SCHEDULER_ENABLED: 'true',
    TELEGRAM_PUBLISH_DUE_LIMIT: '4',
    MEDIA_PROCESSING_MODE: 'direct_url',
    MEDIA_MAX_DOWNLOAD_MB: '50',
    MEDIA_DOWNLOAD_TIMEOUT_SEC: '60',
    DEDUPE_WINDOW_HOURS: '168',
    ENVIRONMENT: 'test',
    LOG_LEVEL: 'info',
    ...overrides,
  } as unknown as Env;
}

function makeMockDB() {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(function (this: unknown, ...args: unknown[]) { return this; }),
      run: vi.fn(async () => ({ meta: { changes: 1 } })),
      all: vi.fn(async () => ({ results: [] })),
      first: vi.fn(async () => null),
    })),
  };
}

function makeNormalizedItem(overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    platform: 'x',
    sourceAccount: 'cointelegraph',
    sourceUrl: 'https://x.com/cointelegraph/status/123456',
    postId: '123456',
    publishedAt: Math.floor(Date.now() / 1000) - 300,
    text: 'Bitcoin reaches new all-time high as institutional demand surges.',
    media: [],
    engagementLikes: 1200,
    engagementShares: 300,
    engagementViews: 45000,
    mediaUrlExpiresSoon: false,
    ...overrides,
  };
}

// ── Config helpers ────────────────────────────────────────────

describe('config helpers', () => {
  describe('isCandidateBacklogEnabled', () => {
    it('returns false when flag is absent', () => {
      expect(isCandidateBacklogEnabled(makeEnv())).toBe(false);
    });

    it('returns false when flag is "false"', () => {
      expect(isCandidateBacklogEnabled(makeEnv({ AI_CANDIDATE_BACKLOG_ENABLED: 'false' }))).toBe(false);
    });

    it('returns true only when flag is exactly "true"', () => {
      expect(isCandidateBacklogEnabled(makeEnv({ AI_CANDIDATE_BACKLOG_ENABLED: 'true' }))).toBe(true);
    });

    it('returns false for any other value including "1" or "yes"', () => {
      expect(isCandidateBacklogEnabled(makeEnv({ AI_CANDIDATE_BACKLOG_ENABLED: '1' }))).toBe(false);
      expect(isCandidateBacklogEnabled(makeEnv({ AI_CANDIDATE_BACKLOG_ENABLED: 'yes' }))).toBe(false);
      expect(isCandidateBacklogEnabled(makeEnv({ AI_CANDIDATE_BACKLOG_ENABLED: 'TRUE' }))).toBe(false);
    });
  });

  describe('isFairSourcePickerEnabled', () => {
    it('returns false by default', () => {
      expect(isFairSourcePickerEnabled(makeEnv())).toBe(false);
    });

    it('returns true only when explicitly set', () => {
      expect(isFairSourcePickerEnabled(makeEnv({ AI_FAIR_SOURCE_PICKER_ENABLED: 'true' }))).toBe(true);
    });
  });

  describe('getScoringBatchSize', () => {
    it('returns 10 by default', () => {
      expect(getScoringBatchSize(makeEnv())).toBe(10);
    });

    it('parses the configured value', () => {
      expect(getScoringBatchSize(makeEnv({ AI_SCORING_BATCH_SIZE: '8' }))).toBe(8);
    });

    it('falls back to 10 for invalid values', () => {
      expect(getScoringBatchSize(makeEnv({ AI_SCORING_BATCH_SIZE: 'abc' }))).toBe(10);
      expect(getScoringBatchSize(makeEnv({ AI_SCORING_BATCH_SIZE: '0' }))).toBe(10);
      expect(getScoringBatchSize(makeEnv({ AI_SCORING_BATCH_SIZE: '-5' }))).toBe(10);
    });
  });

  describe('getMaxScoringBatchesPerRun', () => {
    it('returns 2 by default', () => {
      expect(getMaxScoringBatchesPerRun(makeEnv())).toBe(2);
    });

    it('parses the configured value', () => {
      expect(getMaxScoringBatchesPerRun(makeEnv({ AI_MAX_SCORING_BATCHES_PER_RUN: '3' }))).toBe(3);
    });

    it('falls back to 2 for invalid values', () => {
      expect(getMaxScoringBatchesPerRun(makeEnv({ AI_MAX_SCORING_BATCHES_PER_RUN: '0' }))).toBe(2);
    });
  });

  describe('getCandidateBacklogDrainLimit', () => {
    it('returns 20 by default', () => {
      expect(getCandidateBacklogDrainLimit(makeEnv())).toBe(20);
    });

    it('parses the configured value', () => {
      expect(getCandidateBacklogDrainLimit(makeEnv({ AI_CANDIDATE_BACKLOG_DRAIN_LIMIT: '15' }))).toBe(15);
    });
  });

  describe('getMaxCandidateAttempts', () => {
    it('returns 2 by default', () => {
      expect(getMaxCandidateAttempts(makeEnv())).toBe(2);
    });

    it('parses the configured value', () => {
      expect(getMaxCandidateAttempts(makeEnv({ AI_CANDIDATE_MAX_ATTEMPTS: '3' }))).toBe(3);
    });
  });

  describe('getCandidateMaxAgeHours', () => {
    it('returns 6 by default', () => {
      expect(getCandidateMaxAgeHours(makeEnv())).toBe(6);
    });

    it('parses the configured value', () => {
      expect(getCandidateMaxAgeHours(makeEnv({ AI_CANDIDATE_MAX_AGE_HOURS: '12' }))).toBe(12);
    });

    it('falls back to 6 for invalid values', () => {
      expect(getCandidateMaxAgeHours(makeEnv({ AI_CANDIDATE_MAX_AGE_HOURS: '-1' }))).toBe(6);
    });
  });
});

// ── enqueueCandidates ─────────────────────────────────────────

describe('enqueueCandidates', () => {
  it('inserts a single candidate and returns inserted=true', async () => {
    const mockDB = makeMockDB();
    const mockRun = vi.fn(async () => ({ meta: { changes: 1 } }));
    mockDB.prepare = vi.fn(() => ({
      bind: vi.fn(function (this: unknown) { return { run: mockRun }; }),
      run: mockRun,
      all: vi.fn(async () => ({ results: [] })),
      first: vi.fn(async () => null),
    }));
    const env = makeEnv({ DB: mockDB as unknown as D1Database });

    const results = await enqueueCandidates(env, [{
      runId: 'run_001',
      categoryId: 'cat-crypto',
      platform: 'x',
      sourceAccount: 'cointelegraph',
      sourceUrl: 'https://x.com/cointelegraph/status/111',
      postId: '111',
      publishedAt: Math.floor(Date.now() / 1000),
      normalizedItem: makeNormalizedItem(),
      dedupeKeys: ['pid:x:111', 'url:abc123'],
    }]);

    expect(results).toHaveLength(1);
    expect(results[0]!.inserted).toBe(true);
    expect(results[0]!.id).toMatch(/^cand_/);
    expect(mockDB.prepare).toHaveBeenCalled();
  });

  it('returns inserted=false when DB reports 0 changes (duplicate source_url)', async () => {
    const mockDB = makeMockDB();
    mockDB.prepare = vi.fn(() => ({
      bind: vi.fn(function (this: unknown) {
        return { run: vi.fn(async () => ({ meta: { changes: 0 } })) };
      }),
      run: vi.fn(async () => ({ meta: { changes: 0 } })),
      all: vi.fn(async () => ({ results: [] })),
      first: vi.fn(async () => null),
    }));
    const env = makeEnv({ DB: mockDB as unknown as D1Database });

    const results = await enqueueCandidates(env, [{
      runId: 'run_001',
      categoryId: 'cat-crypto',
      platform: 'x',
      sourceAccount: 'cointelegraph',
      sourceUrl: 'https://x.com/cointelegraph/status/duplicate',
      postId: 'duplicate',
      publishedAt: Math.floor(Date.now() / 1000),
      normalizedItem: makeNormalizedItem(),
      dedupeKeys: [],
    }]);

    expect(results[0]!.inserted).toBe(false);
    expect(results[0]!.reason).toBe('duplicate_source_url');
  });

  it('handles multiple inputs independently', async () => {
    const changes = [1, 0, 1];
    let callIndex = 0;
    const mockDB = makeMockDB();
    mockDB.prepare = vi.fn(() => ({
      bind: vi.fn(function (this: unknown) {
        const idx = callIndex++;
        return { run: vi.fn(async () => ({ meta: { changes: changes[idx] ?? 0 } })) };
      }),
      run: vi.fn(),
      all: vi.fn(async () => ({ results: [] })),
      first: vi.fn(async () => null),
    }));
    const env = makeEnv({ DB: mockDB as unknown as D1Database });

    const inputs = [
      { runId: 'r1', categoryId: 'c1', platform: 'x', sourceAccount: 'acc1', sourceUrl: 'https://x.com/1', postId: '1', publishedAt: 1000, normalizedItem: makeNormalizedItem(), dedupeKeys: [] },
      { runId: 'r1', categoryId: 'c1', platform: 'x', sourceAccount: 'acc2', sourceUrl: 'https://x.com/2', postId: '2', publishedAt: 1001, normalizedItem: makeNormalizedItem(), dedupeKeys: [] },
      { runId: 'r1', categoryId: 'c1', platform: 'x', sourceAccount: 'acc3', sourceUrl: 'https://x.com/3', postId: '3', publishedAt: 1002, normalizedItem: makeNormalizedItem(), dedupeKeys: [] },
    ];

    const results = await enqueueCandidates(env, inputs);
    expect(results).toHaveLength(3);
    expect(results[0]!.inserted).toBe(true);
    expect(results[1]!.inserted).toBe(false);
    expect(results[2]!.inserted).toBe(true);
  });

  it('returns inserted=false and does not throw on DB error', async () => {
    const mockDB = makeMockDB();
    mockDB.prepare = vi.fn(() => ({
      bind: vi.fn(function (this: unknown) {
        return { run: vi.fn(async () => { throw new Error('D1 connection failed'); }) };
      }),
      run: vi.fn(),
      all: vi.fn(async () => ({ results: [] })),
      first: vi.fn(async () => null),
    }));
    const env = makeEnv({ DB: mockDB as unknown as D1Database });

    const results = await enqueueCandidates(env, [{
      runId: 'r1', categoryId: 'c1', platform: 'x', sourceAccount: 'acc1',
      sourceUrl: 'https://x.com/err', postId: 'err', publishedAt: 1000,
      normalizedItem: makeNormalizedItem(), dedupeKeys: [],
    }]);

    expect(results[0]!.inserted).toBe(false);
    expect(results[0]!.reason).toContain('error');
  });

  it('serializes normalizedItem and dedupeKeys to JSON', async () => {
    let capturedArgs: unknown[] = [];
    const mockDB = makeMockDB();
    mockDB.prepare = vi.fn(() => ({
      bind: vi.fn(function (this: unknown, ...args: unknown[]) {
        capturedArgs = args;
        return { run: vi.fn(async () => ({ meta: { changes: 1 } })) };
      }),
      run: vi.fn(),
      all: vi.fn(async () => ({ results: [] })),
      first: vi.fn(async () => null),
    }));
    const env = makeEnv({ DB: mockDB as unknown as D1Database });
    const item = makeNormalizedItem({ text: 'Test serialization' });
    const keys = ['pid:x:999', 'url:deadbeef'];

    await enqueueCandidates(env, [{
      runId: 'r1', categoryId: 'c1', platform: 'x', sourceAccount: 'acc1',
      sourceUrl: 'https://x.com/ser', postId: '999', publishedAt: 1000,
      normalizedItem: item, dedupeKeys: keys,
    }]);

    // normalized_item_json باید به JSON string تبدیل شده باشد
    const normalizedJson = capturedArgs.find(a => typeof a === 'string' && a.includes('"text"'));
    expect(normalizedJson).toBeTruthy();
    expect(JSON.parse(normalizedJson as string)).toMatchObject({ text: 'Test serialization' });

    // dedupe_keys_json باید به JSON string تبدیل شده باشد
    const dedupeJson = capturedArgs.find(a => typeof a === 'string' && a.includes('pid:x:999'));
    expect(dedupeJson).toBeTruthy();
    expect(JSON.parse(dedupeJson as string)).toEqual(keys);
  });
});

// ── updateCandidateStatus ─────────────────────────────────────

describe('updateCandidateStatus', () => {
  it('calls DB UPDATE with the new status', async () => {
    const mockRun = vi.fn(async () => ({ meta: { changes: 1 } }));
    const mockDB = makeMockDB();
    mockDB.prepare = vi.fn(() => ({
      bind: vi.fn(function (this: unknown) { return { run: mockRun }; }),
      run: mockRun,
      all: vi.fn(async () => ({ results: [] })),
      first: vi.fn(async () => null),
    }));
    const env = makeEnv({ DB: mockDB as unknown as D1Database });

    await updateCandidateStatus(env, 'cand_abc', 'ai_selected');
    expect(mockDB.prepare).toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalled();
  });

  it('does not throw when DB fails — pipeline safety', async () => {
    const mockDB = makeMockDB();
    mockDB.prepare = vi.fn(() => ({
      bind: vi.fn(function (this: unknown) {
        return { run: vi.fn(async () => { throw new Error('DB error'); }) };
      }),
      run: vi.fn(),
      all: vi.fn(async () => ({ results: [] })),
      first: vi.fn(async () => null),
    }));
    const env = makeEnv({ DB: mockDB as unknown as D1Database });

    // نباید throw کند
    await expect(updateCandidateStatus(env, 'cand_abc', 'failed')).resolves.toBeUndefined();
  });
});

// ── updateCandidatesStatus ────────────────────────────────────

describe('updateCandidatesStatus', () => {
  it('does nothing for empty ids array', async () => {
    const mockDB = makeMockDB();
    const env = makeEnv({ DB: mockDB as unknown as D1Database });
    await updateCandidatesStatus(env, [], 'pending');
    expect(mockDB.prepare).not.toHaveBeenCalled();
  });

  it('calls updateCandidateStatus for each id', async () => {
    const mockRun = vi.fn(async () => ({ meta: { changes: 1 } }));
    const mockDB = makeMockDB();
    mockDB.prepare = vi.fn(() => ({
      bind: vi.fn(function (this: unknown) { return { run: mockRun }; }),
      run: mockRun,
      all: vi.fn(async () => ({ results: [] })),
      first: vi.fn(async () => null),
    }));
    const env = makeEnv({ DB: mockDB as unknown as D1Database });

    await updateCandidatesStatus(env, ['id1', 'id2', 'id3'], 'pending', { lastError: 'claude timeout' });
    // باید برای هر id یک بار prepare فراخوانی شده باشد
    expect(mockDB.prepare).toHaveBeenCalledTimes(3);
  });
});

// ── fetchPendingCandidates ────────────────────────────────────

describe('fetchPendingCandidates', () => {
  it('returns empty array on empty DB', async () => {
    const env = makeEnv();
    const result = await fetchPendingCandidates(env, 10);
    expect(result).toEqual([]);
  });

  it('returns rows from DB when present', async () => {
    const fakeRow: Partial<AICandidateRow> = {
      id: 'cand_001',
      status: 'pending',
      source_account: 'cointelegraph',
      category_id: 'cat-crypto',
      platform: 'x',
      source_url: 'https://x.com/ct/1',
      normalized_item_json: '{}',
      dedupe_keys_json: '[]',
      priority_score: 0,
      attempt_count: 0,
      created_at: new Date().toISOString(),
      last_error: null,
      claimed_at: null,
      scored_at: null,
    };
    const mockDB = makeMockDB();
    mockDB.prepare = vi.fn(() => ({
      bind: vi.fn(function (this: unknown) {
        return { all: vi.fn(async () => ({ results: [fakeRow] })) };
      }),
      run: vi.fn(async () => ({ meta: { changes: 1 } })),
      all: vi.fn(async () => ({ results: [fakeRow] })),
      first: vi.fn(async () => null),
    }));
    const env = makeEnv({ DB: mockDB as unknown as D1Database });

    const rows = await fetchPendingCandidates(env, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('cand_001');
  });

  it('returns empty array on DB error — pipeline safety', async () => {
    const mockDB = makeMockDB();
    mockDB.prepare = vi.fn(() => ({
      bind: vi.fn(function (this: unknown) {
        return { all: vi.fn(async () => { throw new Error('DB error'); }) };
      }),
      run: vi.fn(),
      all: vi.fn(async () => { throw new Error('DB error'); }),
      first: vi.fn(async () => null),
    }));
    const env = makeEnv({ DB: mockDB as unknown as D1Database });

    const rows = await fetchPendingCandidates(env, 10);
    expect(rows).toEqual([]);
  });

  it('passes category filter to query when provided', async () => {
    let capturedSql = '';
    const mockDB = makeMockDB();
    mockDB.prepare = vi.fn((sql: string) => {
      capturedSql = sql;
      return {
        bind: vi.fn(function (this: unknown) { return { all: vi.fn(async () => ({ results: [] })) }; }),
        run: vi.fn(),
        all: vi.fn(async () => ({ results: [] })),
        first: vi.fn(async () => null),
      };
    });
    const env = makeEnv({ DB: mockDB as unknown as D1Database });

    await fetchPendingCandidates(env, 5, 'cat-crypto');
    expect(capturedSql).toContain('category_id');
  });
});

// ── countPendingCandidates ────────────────────────────────────

describe('countPendingCandidates', () => {
  it('returns 0 on empty or error', async () => {
    const env = makeEnv();
    const count = await countPendingCandidates(env);
    expect(count).toBe(0);
  });

  it('returns count from DB', async () => {
    const mockDB = makeMockDB();
    mockDB.prepare = vi.fn(() => ({
      bind: vi.fn(function (this: unknown) {
        return { first: vi.fn(async () => ({ cnt: 42 })) };
      }),
      run: vi.fn(),
      all: vi.fn(async () => ({ results: [] })),
      first: vi.fn(async () => ({ cnt: 42 })),
    }));
    const env = makeEnv({ DB: mockDB as unknown as D1Database });

    const count = await countPendingCandidates(env);
    expect(count).toBe(42);
  });
});

// ── skipStaleCandidates ───────────────────────────────────────

describe('skipStaleCandidates', () => {
  it('returns 0 on DB error — pipeline safety', async () => {
    const mockDB = makeMockDB();
    mockDB.prepare = vi.fn(() => ({
      bind: vi.fn(function (this: unknown) {
        return { run: vi.fn(async () => { throw new Error('DB error'); }) };
      }),
      run: vi.fn(async () => { throw new Error('DB error'); }),
      all: vi.fn(async () => ({ results: [] })),
      first: vi.fn(async () => null),
    }));
    const env = makeEnv({ DB: mockDB as unknown as D1Database });

    const skipped = await skipStaleCandidates(env);
    expect(skipped).toBe(0);
  });

  it('returns number of skipped rows', async () => {
    const mockDB = makeMockDB();
    mockDB.prepare = vi.fn(() => ({
      bind: vi.fn(function (this: unknown) {
        return { run: vi.fn(async () => ({ meta: { changes: 7 } })) };
      }),
      run: vi.fn(async () => ({ meta: { changes: 7 } })),
      all: vi.fn(async () => ({ results: [] })),
      first: vi.fn(async () => null),
    }));
    const env = makeEnv({ DB: mockDB as unknown as D1Database });

    const skipped = await skipStaleCandidates(env);
    expect(skipped).toBe(7);
  });
});

// ── getCandidateQueueStats ────────────────────────────────────

describe('getCandidateQueueStats', () => {
  it('returns all-zero stats when DB is empty', async () => {
    const env = makeEnv();
    const stats = await getCandidateQueueStats(env);
    expect(stats).toEqual({
      pending: 0, scoring: 0, ai_selected: 0,
      ai_rejected: 0, queued: 0, failed: 0, skipped: 0,
    });
  });

  it('maps DB status counts to stats correctly', async () => {
    const mockDB = makeMockDB();
    mockDB.prepare = vi.fn(() => ({
      bind: vi.fn(function (this: unknown) { return this; }),
      run: vi.fn(),
      all: vi.fn(async () => ({
        results: [
          { status: 'pending', cnt: 12 },
          { status: 'ai_selected', cnt: 3 },
          { status: 'ai_rejected', cnt: 8 },
          { status: 'failed', cnt: 1 },
        ],
      })),
      first: vi.fn(async () => null),
    }));
    const env = makeEnv({ DB: mockDB as unknown as D1Database });

    const stats = await getCandidateQueueStats(env);
    expect(stats.pending).toBe(12);
    expect(stats.ai_selected).toBe(3);
    expect(stats.ai_rejected).toBe(8);
    expect(stats.failed).toBe(1);
    expect(stats.scoring).toBe(0);
    expect(stats.queued).toBe(0);
    expect(stats.skipped).toBe(0);
  });

  it('returns all-zero stats on DB error — never throws', async () => {
    const mockDB = makeMockDB();
    mockDB.prepare = vi.fn(() => ({
      bind: vi.fn(function (this: unknown) { return this; }),
      run: vi.fn(),
      all: vi.fn(async () => { throw new Error('DB error'); }),
      first: vi.fn(async () => null),
    }));
    const env = makeEnv({ DB: mockDB as unknown as D1Database });

    const stats = await getCandidateQueueStats(env);
    expect(stats.pending).toBe(0);
  });
});

// ── Feature flag gate (safety check) ─────────────────────────

describe('feature flag safety', () => {
  it('backlog flag is false by default — existing pipeline behavior unchanged', () => {
    const env = makeEnv();
    // مهم‌ترین تست: بدون هیچ override ای، flag باید false باشد
    expect(isCandidateBacklogEnabled(env)).toBe(false);
  });

  it('fair source picker flag is false by default', () => {
    const env = makeEnv();
    expect(isFairSourcePickerEnabled(env)).toBe(false);
  });

  it('all batch size defaults are safe and bounded', () => {
    const env = makeEnv();
    expect(getScoringBatchSize(env)).toBeLessThanOrEqual(15);
    expect(getMaxScoringBatchesPerRun(env)).toBeLessThanOrEqual(5);
    expect(getCandidateBacklogDrainLimit(env)).toBeLessThanOrEqual(30);
    expect(getMaxCandidateAttempts(env)).toBeLessThanOrEqual(3);
  });
});
