import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  parseAiBacklogStageRetryDirective,
  runAiBacklogJobStep,
  type AIBacklogStageHandlers,
} from '../apps/worker-api/src/services/ai-backlog-stage-runner';

import type {
  AIBacklogJobItemRow,
  AIBacklogJobRow,
  Env,
} from '../apps/worker-api/src/types';

interface MockState {
  job: AIBacklogJobRow;
  items: AIBacklogJobItemRow[];
  bound: unknown[][];
}

function makeJob(): AIBacklogJobRow {
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
    lease_expires_at:
      '2099-01-01 00:00:00',
    queue_sent_at: null,
    next_run_at: null,
    delivery_attempts: 1,
    last_error: null,
    created_at:
      '2026-07-12 00:00:00',
    updated_at:
      '2026-07-12 00:00:00',
    completed_at: null,
  };
}

function makeItem(): AIBacklogJobItemRow {
  return {
    job_id: 'job-1',
    candidate_id: 'candidate-1',
    ordinal: 0,
    status: 'pending',
    score_result_json: null,
    gate_result_json: null,
    duplicate_result_json: null,
    translation_result_json: null,
    persist_result_json: null,
    provider_attempts: 0,
    translation_failures: 0,
    last_error: null,
    created_at:
      '2026-07-12 00:00:00',
    updated_at:
      '2026-07-12 00:00:00',
    completed_at: null,
  };
}

function makeEnv(
  state: MockState,
): Env {
  const prepare = vi.fn(
    (_sql: string) => {
      const statement: {
        bind: (
          ...args: unknown[]
        ) => unknown;
        run: () => Promise<unknown>;
        first: () => Promise<unknown>;
        all: () => Promise<unknown>;
      } = {
        bind: (...args: unknown[]) => {
          state.bound.push(args);
          return statement;
        },

        run: async () => ({
          success: true,
          meta: {
            changes: 1,
          },
          results: [],
        }),

        first: async () =>
          state.job,

        all: async () => ({
          success: true,
          results:
            state.items,
          meta: {},
        }),
      };

      return statement;
    },
  );

  return {
    DB: {
      prepare,
      batch: vi.fn(
        async (
          statements: unknown[],
        ) => statements.map(
          () => ({
            success: true,
            meta: {
              changes: 1,
            },
            results: [],
          }),
        ),
      ),
    },
  } as unknown as Env;
}

function makeHandlers():
  AIBacklogStageHandlers {
  const empty = vi.fn(
    async () => ({}),
  );

  return {
    score: vi.fn(
      async () => {
        throw new Error(
          'stage_retry_at_ms:1783900800000:translation_retry:1',
        );
      },
    ),
    gate: empty,
    duplicate: empty,
    translation: empty,
    persist: empty,
  };
}

describe(
  'ai backlog stage retry',
  () => {
    it('parses a durable retry directive', () => {
      expect(
        parseAiBacklogStageRetryDirective(
          'stage_retry_at_ms:1783900800000:translation_retry:2',
        ),
      ).toEqual({
        nextRunAt:
          '2026-07-13 00:00:00',
        reason:
          'translation_retry:2',
      });

      expect(
        parseAiBacklogStageRetryDirective(
          'stage_retry_at_ms:bad:error',
        ),
      ).toBeNull();

      expect(
        parseAiBacklogStageRetryDirective(
          'provider_failure',
        ),
      ).toBeNull();
    });

    it('releases the job with a delayed retry', async () => {
      const state: MockState = {
        job: makeJob(),
        items: [makeItem()],
        bound: [],
      };

      const result =
        await runAiBacklogJobStep(
          makeEnv(state),
          'job-1',
          makeHandlers(),
        );

      expect(result).toEqual({
        ok: true,
        progressed: false,
        completed: false,
        jobId: 'job-1',
        previousStage: 'created',
        reason:
          'stage_retry_scheduled',
        error:
          'translation_retry:1',
      });

      expect(
        state.bound.some(
          args =>
            args[0]
              === '2026-07-13 00:00:00'
            && args[1]
              === 'stage_retry:translation_retry:1',
        ),
      ).toBe(true);
    });
  },
);
