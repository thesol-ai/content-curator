import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  createDefaultAiBacklogStageHandlers,
  runAiBacklogJobStep,
  type AIBacklogStageHandlers,
} from '../apps/worker-api/src/services/ai-backlog-stage-runner';

import type {
  AIBacklogJobItemRow,
  AIBacklogJobRow,
  Env,
} from '../apps/worker-api/src/types';

interface MockState {
  job: AIBacklogJobRow | null;
  items: AIBacklogJobItemRow[];
  runChanges: number;
  sql: string[];
  bound: unknown[][];
}

function makeJob(
  overrides: Partial<AIBacklogJobRow> = {},
): AIBacklogJobRow {
  return {
    id: 'job-1',
    dispatch_id: 'cron:300000',
    source: 'cron',
    status: 'processing',
    stage: 'created',
    stage_cursor: 0,
    scheduled_time_ms: 300000,
    batch_context_json: null,
    lease_token: 'lease-token',
    lease_expires_at: '2099-01-01 00:00:00',
    queue_sent_at: null,
    next_run_at: null,
    delivery_attempts: 1,
    last_error: null,
    created_at: '2026-07-12 00:00:00',
    updated_at: '2026-07-12 00:00:00',
    completed_at: null,
    ...overrides,
  };
}

function makeItem(
  candidateId = 'candidate-1',
): AIBacklogJobItemRow {
  return {
    job_id: 'job-1',
    candidate_id: candidateId,
    ordinal: 0,
    status: 'pending',
    score_result_json: null,
    gate_result_json: null,
    duplicate_result_json: null,
    translation_result_json: null,
    persist_result_json: null,
    provider_attempts: 0,
    last_error: null,
    created_at: '2026-07-12 00:00:00',
    updated_at: '2026-07-12 00:00:00',
    completed_at: null,
  };
}

function makeEnv(state: MockState): Env {
  const prepare = vi.fn((sql: string) => {
    state.sql.push(sql);

    const statement: any = {
      args: [] as unknown[],
      bind: vi.fn((...args: unknown[]) => {
        statement.args = args;
        state.bound.push(args);
        return statement;
      }),
      run: vi.fn(async () => ({
        success: true,
        meta: {
          changes: state.runChanges,
        },
        results: [],
      })),
      first: vi.fn(async () => state.job),
      all: vi.fn(async () => ({
        success: true,
        results: state.items,
        meta: {},
      })),
    };

    return statement;
  });

  const batch = vi.fn(async (
    statements: D1PreparedStatement[],
  ) => statements.map(() => ({
    success: true,
    meta: {
      changes: state.runChanges,
    },
    results: [],
  })));

  return {
    DB: {
      prepare,
      batch,
    },
  } as unknown as Env;
}

function makeHandlers() {
  const empty = vi.fn(async () => ({}));

  const handlers: AIBacklogStageHandlers = {
    score: vi.fn(async () => ({
      stageCursor: 1,
      batchContext: {
        scored: 1,
      },
    })),
    gate: empty,
    duplicate: empty,
    translation: empty,
    persist: empty,
  };

  return handlers;
}

describe('ai-backlog-stage-runner', () => {
  let state: MockState;

  beforeEach(() => {
    state = {
      job: makeJob(),
      items: [makeItem()],
      runChanges: 1,
      sql: [],
      bound: [],
    };
  });

  it('runs exactly one score stage and persists progress', async () => {
    const env = makeEnv(state);
    const handlers = makeHandlers();

    const result = await runAiBacklogJobStep(
      env,
      'job-1',
      handlers,
    );

    expect(result).toEqual({
      ok: true,
      progressed: true,
      completed: false,
      jobId: 'job-1',
      action: 'score',
      previousStage: 'created',
      nextStage: 'scored',
    });

    expect(handlers.score).toHaveBeenCalledTimes(1);
    expect(handlers.gate).not.toHaveBeenCalled();
    expect(handlers.translation).not.toHaveBeenCalled();

    expect(state.sql.some(sql =>
      sql.includes('stage = ?')
    )).toBe(true);

    expect(state.bound.some(args =>
      args[0] === 'scored'
      && args[1] === 1
    )).toBe(true);

    expect(state.sql.some(sql =>
      sql.includes("status = 'pending'")
      && sql.includes('lease_token = NULL')
    )).toBe(true);
  });

  it('does nothing when another worker owns the lease', async () => {
    state.runChanges = 0;

    const env = makeEnv(state);
    const handlers = makeHandlers();

    const result = await runAiBacklogJobStep(
      env,
      'job-1',
      handlers,
    );

    expect(result.reason).toBe('lease_unavailable');
    expect(result.progressed).toBe(false);
    expect(handlers.score).not.toHaveBeenCalled();
  });

  it('completes a persisted job without running another handler', async () => {
    state.job = makeJob({
      stage: 'persisted',
    });

    const env = makeEnv(state);
    const handlers = makeHandlers();

    const result = await runAiBacklogJobStep(
      env,
      'job-1',
      handlers,
    );

    expect(result.ok).toBe(true);
    expect(result.completed).toBe(true);
    expect(result.nextStage).toBe('completed');

    expect(handlers.score).not.toHaveBeenCalled();
    expect(handlers.persist).not.toHaveBeenCalled();

    expect(state.sql.some(sql =>
      sql.includes("status = 'completed'")
    )).toBe(true);
  });

  it('releases the lease when a stage handler fails', async () => {
    const env = makeEnv(state);
    const handlers = makeHandlers();

    handlers.score = vi.fn(async () => {
      throw new Error('provider_failure');
    });

    const result = await runAiBacklogJobStep(
      env,
      'job-1',
      handlers,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe('provider_failure');

    expect(state.bound.some(args =>
      args.some(value =>
        value === 'stage_error:provider_failure'
      )
    )).toBe(true);
  });

  it('refuses to advance a job with no reserved items', async () => {
    state.items = [];

    const env = makeEnv(state);
    const handlers = makeHandlers();

    const result = await runAiBacklogJobStep(
      env,
      'job-1',
      handlers,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe('job_has_no_items');
    expect(handlers.score).not.toHaveBeenCalled();
  });
  it('creates the complete default stage handler map', () => {
    const handlers =
      createDefaultAiBacklogStageHandlers();

    expect(
      Object.keys(handlers).sort(),
    ).toEqual([
      'duplicate',
      'gate',
      'persist',
      'score',
      'translation',
    ]);

    expect(
      Object.values(handlers).every(
        handler =>
          typeof handler === 'function',
      ),
    ).toBe(true);
  });

});
