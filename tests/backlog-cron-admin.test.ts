import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../apps/worker-api/src/index';
import { handleAdmin } from '../apps/worker-api/src/routes/admin';
import { publishDueItems, runCuration } from '../apps/worker-api/src/services/curation-orchestrator';
import { cleanupOldDedupeKeys } from '../apps/worker-api/src/services/dedupe';
import { maybeSendMarketSnapshotDirect } from '../apps/worker-api/src/services/market-snapshot';
import { getRuntimeConfig } from '../apps/worker-api/src/services/runtime-config';
import { drainAICandidateQueue } from '../apps/worker-api/src/services/backlog-drain';
import {
  failMaxAttemptPendingCandidates,
  getCandidateBacklogDrainLimit,
  getCandidateMaxAgeHours,
  getCandidateQueueStats,
  getMaxCandidateAttempts,
  getMaxScoringBatchesPerRun,
  getScoringBatchSize,
  isCandidateBacklogEnabled,
  isFairSourcePickerEnabled,
  recoverStaleScoringCandidates,
  skipStaleCandidates,
} from '../apps/worker-api/src/services/candidate-queue';
import type { Env } from '../apps/worker-api/src/types';

vi.mock('../apps/worker-api/src/services/curation-orchestrator', () => ({
  runCuration: vi.fn(),
  publishDueItems: vi.fn(),
  publishQueueItem: vi.fn(),
}));

vi.mock('../apps/worker-api/src/services/dedupe', () => ({
  cleanupOldDedupeKeys: vi.fn(),
}));

vi.mock('../apps/worker-api/src/services/runtime-config', () => ({
  getRuntimeConfig: vi.fn(),
}));

vi.mock('../apps/worker-api/src/services/market-snapshot', () => ({
  maybeSendMarketSnapshotDirect: vi.fn(),
  buildMarketSnapshotText: vi.fn(),
  sendMarketSnapshotDirect: vi.fn(),
}));

vi.mock('../apps/worker-api/src/services/backlog-drain', () => ({
  drainAICandidateQueue: vi.fn(),
}));

vi.mock('../apps/worker-api/src/services/candidate-queue', () => ({
  failMaxAttemptPendingCandidates: vi.fn(),
  getCandidateBacklogDrainLimit: vi.fn(),
  getCandidateMaxAgeHours: vi.fn(),
  getCandidateQueueStats: vi.fn(),
  getMaxCandidateAttempts: vi.fn(),
  getMaxScoringBatchesPerRun: vi.fn(),
  getScoringBatchSize: vi.fn(),
  isCandidateBacklogEnabled: vi.fn(),
  isFairSourcePickerEnabled: vi.fn(),
  recoverStaleScoringCandidates: vi.fn(),
  skipStaleCandidates: vi.fn(),
}));

const publishDueItemsMock = vi.mocked(publishDueItems);
const runCurationMock = vi.mocked(runCuration);
const cleanupOldDedupeKeysMock = vi.mocked(cleanupOldDedupeKeys);
const maybeSendMarketSnapshotDirectMock = vi.mocked(maybeSendMarketSnapshotDirect);
const getRuntimeConfigMock = vi.mocked(getRuntimeConfig);
const drainAICandidateQueueMock = vi.mocked(drainAICandidateQueue);
const isCandidateBacklogEnabledMock = vi.mocked(isCandidateBacklogEnabled);
const recoverStaleScoringCandidatesMock = vi.mocked(recoverStaleScoringCandidates);
const failMaxAttemptPendingCandidatesMock = vi.mocked(failMaxAttemptPendingCandidates);
const skipStaleCandidatesMock = vi.mocked(skipStaleCandidates);
const getCandidateQueueStatsMock = vi.mocked(getCandidateQueueStats);
const getScoringBatchSizeMock = vi.mocked(getScoringBatchSize);
const getMaxScoringBatchesPerRunMock = vi.mocked(getMaxScoringBatchesPerRun);
const getCandidateBacklogDrainLimitMock = vi.mocked(getCandidateBacklogDrainLimit);
const getMaxCandidateAttemptsMock = vi.mocked(getMaxCandidateAttempts);
const getCandidateMaxAgeHoursMock = vi.mocked(getCandidateMaxAgeHours);
const isFairSourcePickerEnabledMock = vi.mocked(isFairSourcePickerEnabled);

function env(overrides: Partial<Env> = {}): Env {
  return {
    DB: makeDb() as unknown as D1Database,
    AI_MAX_CALLS_PER_DAY: '100',
    AI_DAILY_TOKEN_BUDGET: '200000',
    ...overrides,
  } as unknown as Env;
}

function makeDb() {
  return {
    prepare: vi.fn((sql: string) => {
      const stmt = {
        bind: vi.fn((..._args: unknown[]) => stmt),
        all: vi.fn(async () => {
          if (sql.includes('FROM ai_candidate_queue') && sql.includes('GROUP BY')) {
            return { results: [{ source_account: 'cointelegraph', count: 7 }] };
          }
          return { results: [] };
        }),
        first: vi.fn(async () => {
          if (sql.includes('FROM ai_usage')) return { calls: 3, tokens: 1234 };
          return null;
        }),
        run: vi.fn(async () => ({ meta: { changes: 1 } })),
      };
      return stmt;
    }),
  };
}

function adminRequest(path: string, method = 'GET', body?: unknown): Request {
  return new Request(`https://worker.test${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function runScheduled(testEnv: Env) {
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: vi.fn((p: Promise<unknown>) => { waits.push(p); }) } as unknown as ExecutionContext;
  await worker.scheduled({} as ScheduledController, testEnv, ctx);
  await Promise.all(waits);
}

beforeEach(() => {
  vi.clearAllMocks();
  getRuntimeConfigMock.mockResolvedValue({
    maintenanceMode: false,
    curationEnabled: true,
    curationDryRun: false,
    telegramPublishEnabled: true,
    telegramSchedulerEnabled: true,
  });
  runCurationMock.mockResolvedValue([]);
  maybeSendMarketSnapshotDirectMock.mockResolvedValue({ shouldRun: false, sent: false, reason: 'not_due' } as any);
  publishDueItemsMock.mockResolvedValue({ published: 0, failed: 0, skipped: 0 });
  cleanupOldDedupeKeysMock.mockResolvedValue(0);
  isCandidateBacklogEnabledMock.mockReturnValue(false);
  recoverStaleScoringCandidatesMock.mockResolvedValue({ recovered: 0, failed: 0 });
  failMaxAttemptPendingCandidatesMock.mockResolvedValue(0);
  skipStaleCandidatesMock.mockResolvedValue(0);
  drainAICandidateQueueMock.mockResolvedValue({
    ok: true,
    skipped: false,
    candidatesPulled: 0,
    candidatesClaimed: 0,
    candidatesScored: 0,
    candidatesSelected: 0,
    candidatesRejected: 0,
    candidatesQueued: 0,
    candidatesFailed: 0,
    candidatesSkipped: 0,
    batchesAttempted: 0,
    stoppedByBudget: false,
  });
  getCandidateQueueStatsMock.mockResolvedValue({ pending: 4, scoring: 1, ai_selected: 2, ai_rejected: 3, queued: 2, failed: 0, skipped: 1 });
  getScoringBatchSizeMock.mockReturnValue(10);
  getMaxScoringBatchesPerRunMock.mockReturnValue(2);
  getCandidateBacklogDrainLimitMock.mockReturnValue(20);
  getMaxCandidateAttemptsMock.mockReturnValue(2);
  getCandidateMaxAgeHoursMock.mockReturnValue(6);
  isFairSourcePickerEnabledMock.mockReturnValue(false);
});

describe('Phase 4 scheduled backlog drain', () => {
  it('does not touch the backlog when the feature flag is disabled', async () => {
    await runScheduled(env());

    expect(publishDueItemsMock).toHaveBeenCalledTimes(1);
    expect(drainAICandidateQueueMock).not.toHaveBeenCalled();
    expect(recoverStaleScoringCandidatesMock).not.toHaveBeenCalled();
    expect(cleanupOldDedupeKeysMock).toHaveBeenCalledTimes(1);
  });

  it('runs backlog drain only after publish due and before cleanup when enabled', async () => {
    const order: string[] = [];
    isCandidateBacklogEnabledMock.mockReturnValue(true);
    publishDueItemsMock.mockImplementation(async () => { order.push('publish'); return { published: 0, failed: 0, skipped: 0 }; });
    recoverStaleScoringCandidatesMock.mockImplementation(async () => { order.push('recover'); return { recovered: 1, failed: 0 }; });
    failMaxAttemptPendingCandidatesMock.mockImplementation(async () => { order.push('fail-max'); return 0; });
    skipStaleCandidatesMock.mockImplementation(async () => { order.push('skip-stale'); return 2; });
    drainAICandidateQueueMock.mockImplementation(async () => { order.push('drain'); return {
      ok: true, skipped: false, candidatesPulled: 1, candidatesClaimed: 1, candidatesScored: 1,
      candidatesSelected: 0, candidatesRejected: 1, candidatesQueued: 0, candidatesFailed: 0,
      candidatesSkipped: 0, batchesAttempted: 1, stoppedByBudget: false,
    }; });
    cleanupOldDedupeKeysMock.mockImplementation(async () => { order.push('cleanup'); return 0; });

    await runScheduled(env());

    expect(order).toEqual(['publish', 'recover', 'fail-max', 'skip-stale', 'drain', 'cleanup']);
    expect(drainAICandidateQueueMock).toHaveBeenCalledWith(expect.anything(), { recoverStale: false, skipStale: false });
  });

  it('isolates backlog errors so dedupe cleanup still runs', async () => {
    const order: string[] = [];
    isCandidateBacklogEnabledMock.mockReturnValue(true);
    publishDueItemsMock.mockImplementation(async () => { order.push('publish'); return { published: 0, failed: 0, skipped: 0 }; });
    drainAICandidateQueueMock.mockImplementation(async () => { order.push('drain'); throw new Error('boom'); });
    cleanupOldDedupeKeysMock.mockImplementation(async () => { order.push('cleanup'); return 0; });

    await runScheduled(env());

    expect(order).toEqual(['publish', 'drain', 'cleanup']);
    expect(cleanupOldDedupeKeysMock).toHaveBeenCalledTimes(1);
  });
});

describe('Phase 4 manual backlog admin endpoints', () => {
  it('returns read-only backlog stats even when disabled', async () => {
    isCandidateBacklogEnabledMock.mockReturnValue(false);

    const res = await handleAdmin(adminRequest('/internal/backlog/stats'), env(), {} as ExecutionContext);
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.enabled).toBe(false);
    expect(body.status_counts.pending).toBe(4);
    expect(body.top_pending_accounts).toEqual([{ source_account: 'cointelegraph', count: 7 }]);
    expect(body.ai_budget.calls_today).toBe(3);
    expect(body.config.scoring_batch_size).toBe(10);
  });

  it('refuses manual drain when backlog is disabled', async () => {
    isCandidateBacklogEnabledMock.mockReturnValue(false);

    const res = await handleAdmin(adminRequest('/internal/backlog/drain', 'POST', { limit: 5 }), env(), {} as ExecutionContext);
    const body = await res.json() as any;

    expect(res.status).toBe(409);
    expect(body.error).toBe('backlog_disabled');
    expect(drainAICandidateQueueMock).not.toHaveBeenCalled();
  });

  it('sanitizes and clamps manual drain options before calling drain', async () => {
    isCandidateBacklogEnabledMock.mockReturnValue(true);

    const res = await handleAdmin(adminRequest('/internal/backlog/drain', 'POST', {
      category_id: 'crypto_main',
      limit: 999,
      maxBatches: 99,
      skipStale: true,
      recoverStale: false,
    }), env(), {} as ExecutionContext);
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(drainAICandidateQueueMock).toHaveBeenCalledWith(expect.anything(), {
      categoryId: 'crypto_main',
      limit: 20,
      maxBatches: 2,
      skipStale: true,
      recoverStale: false,
    });
  });

  it('drops invalid category ids instead of passing unsafe values to SQL paths', async () => {
    isCandidateBacklogEnabledMock.mockReturnValue(true);

    await handleAdmin(adminRequest('/internal/backlog/drain', 'POST', {
      category_id: "crypto';drop",
      limit: 3,
    }), env(), {} as ExecutionContext);

    expect(drainAICandidateQueueMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      categoryId: undefined,
      limit: 3,
    }));
  });
});
