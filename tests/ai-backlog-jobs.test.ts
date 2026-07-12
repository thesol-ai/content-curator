import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAiBacklogDispatchId,
  buildAiBacklogJobId,
  checkpointAiBacklogJobItem,
  claimAiBacklogJobLease,
  completeAiBacklogJob,
  createOrGetAiBacklogJob,
  reserveCandidatesForAiBacklogJob,
} from '../apps/worker-api/src/services/ai-backlog-jobs';
import type {
  AIBacklogJobItemRow,
  AIBacklogJobRow,
  Env,
} from '../apps/worker-api/src/types';

interface MockState {
  sql: string[];
  bound: unknown[][];
  runChanges: number;
  firstValue: unknown;
  allResults: unknown[];
}

function makeEnv(state: MockState) {
  const batch = vi.fn(async (statements: D1PreparedStatement[]) =>
    statements.map(() => ({
      success: true,
      meta: { changes: state.runChanges },
      results: [],
    })),
  );

  const prepare = vi.fn((sql: string) => {
    state.sql.push(sql);

    const statement: any = {
      boundArgs: [] as unknown[],
      bind: vi.fn((...args: unknown[]) => {
        statement.boundArgs = args;
        state.bound.push(args);
        return statement;
      }),
      run: vi.fn(async () => ({
        success: true,
        meta: { changes: state.runChanges },
        results: [],
      })),
      first: vi.fn(async () => state.firstValue),
      all: vi.fn(async () => ({
        success: true,
        results: state.allResults,
        meta: {},
      })),
    };

    return statement;
  });

  return {
    env: {
      DB: {
        prepare,
        batch,
      },
    } as unknown as Env,
    batch,
    prepare,
  };
}

function makeState(): MockState {
  return {
    sql: [],
    bound: [],
    runChanges: 1,
    firstValue: null,
    allResults: [],
  };
}

describe('ai-backlog-jobs', () => {
  let state: MockState;

  beforeEach(() => {
    state = makeState();
  });

  it('builds a deterministic dispatch id for a five minute slot', () => {
    expect(buildAiBacklogDispatchId(300001)).toBe('cron:300000');
    expect(buildAiBacklogDispatchId(599999)).toBe('cron:300000');
  });

  it('builds a stable job id from a dispatch id', () => {
    expect(buildAiBacklogJobId('cron:300000'))
      .toBe('ai_job:cron:300000');
  });

  it('creates or loads a job by dispatch id', async () => {
    const expected = {
      id: 'ai_job:cron:300000',
      dispatch_id: 'cron:300000',
      source: 'cron',
      status: 'pending',
      stage: 'created',
    } as AIBacklogJobRow;

    state.firstValue = expected;

    const { env } = makeEnv(state);

    const result = await createOrGetAiBacklogJob(env, {
      dispatchId: 'cron:300000',
      source: 'cron',
      scheduledTimeMs: 300001,
    });

    expect(result).toBe(expected);
    expect(state.sql.some(sql =>
      sql.includes('INSERT OR IGNORE INTO ai_backlog_jobs')
    )).toBe(true);
    expect(state.sql.some(sql =>
      sql.includes('WHERE dispatch_id = ?')
    )).toBe(true);
  });

  it('reserves candidates and preserves batch order', async () => {
    state.allResults = [
      {
        job_id: 'job-1',
        candidate_id: 'candidate-1',
        ordinal: 0,
        status: 'pending',
      },
      {
        job_id: 'job-1',
        candidate_id: 'candidate-2',
        ordinal: 1,
        status: 'pending',
      },
    ] as AIBacklogJobItemRow[];

    const { env, batch } = makeEnv(state);

    const rows = await reserveCandidatesForAiBacklogJob(
      env,
      'job-1',
      ['candidate-1', 'candidate-2', 'candidate-1'],
    );

    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]![0]).toHaveLength(4);
    expect(rows.map(row => row.candidate_id)).toEqual([
      'candidate-1',
      'candidate-2',
    ]);
    expect(state.sql.some(sql =>
      sql.includes('processing_job_id = ?')
    )).toBe(true);
  });

  it('returns a lease token only after an atomic claim succeeds', async () => {
    const { env } = makeEnv(state);

    const token = await claimAiBacklogJobLease(env, 'job-1', 300);

    expect(token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    state.runChanges = 0;

    const blocked = await claimAiBacklogJobLease(env, 'job-1', 300);

    expect(blocked).toBeNull();
  });

  it('stores score output immediately as a durable checkpoint', async () => {
    const { env } = makeEnv(state);

    const ok = await checkpointAiBacklogJobItem(env, {
      jobId: 'job-1',
      candidateId: 'candidate-1',
      checkpoint: 'score',
      result: {
        score: 91,
        publish: true,
      },
      incrementProviderAttempt: true,
    });

    expect(ok).toBe(true);
    expect(state.sql.at(-1)).toContain('score_result_json');
    expect(state.bound.at(-1)?.[0]).toBe(
      JSON.stringify({
        score: 91,
        publish: true,
      }),
    );
    expect(state.bound.at(-1)?.[2]).toBe(1);
  });

  it('completes the job and releases candidate ownership in one batch', async () => {
    const { env, batch } = makeEnv(state);

    const ok = await completeAiBacklogJob(
      env,
      'job-1',
      'lease-token',
    );

    expect(ok).toBe(true);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]![0]).toHaveLength(2);
    expect(state.sql.some(sql =>
      sql.includes("status = 'completed'")
    )).toBe(true);
    const releaseSql = state.sql.find(sql =>
      sql.includes('SET processing_job_id = NULL')
    );

    expect(releaseSql).toContain("status = 'completed'");
    expect(releaseSql).toContain('completed_at IS NOT NULL');
    expect(state.bound.some(args =>
      args.length === 2
      && args[0] === 'job-1'
      && args[1] === 'job-1'
    )).toBe(true);
  });

  it('does not report completion when the lease token is rejected', async () => {
    state.runChanges = 0;

    const { env } = makeEnv(state);

    const ok = await completeAiBacklogJob(
      env,
      'job-1',
      'invalid-lease-token',
    );

    expect(ok).toBe(false);
  });
});
