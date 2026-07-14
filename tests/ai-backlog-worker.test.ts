import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  runAiBacklogJobWorker,
  type AIBacklogJobWorkerDependencies,
} from '../apps/worker-api/src/services/ai-backlog-worker';

import type {
  AIBacklogJobRow,
  Env,
} from '../apps/worker-api/src/types';

import type {
  AIBacklogJobStepResult,
} from '../apps/worker-api/src/services/ai-backlog-stage-runner';

function makeJob(
  overrides:
    Partial<AIBacklogJobRow> = {},
): AIBacklogJobRow {
  return {
    id: 'job-1',
    dispatch_id: 'cron:300000',
    source: 'cron',
    status: 'pending',
    stage: 'created',
    stage_cursor: 0,
    scheduled_time_ms: 300000,
    batch_context_json: null,
    lease_token: null,
    lease_expires_at: null,
    queue_sent_at: null,
    next_run_at: null,
    delivery_attempts: 0,
    last_error: null,
    created_at:
      '2026-07-12 00:00:00',
    updated_at:
      '2026-07-12 00:00:00',
    completed_at: null,
    ...overrides,
  };
}

function makeStep(
  overrides:
    Partial<AIBacklogJobStepResult> = {},
): AIBacklogJobStepResult {
  return {
    ok: true,
    progressed: true,
    completed: false,
    jobId: 'job-1',
    action: 'score',
    previousStage: 'created',
    nextStage: 'scored',
    ...overrides,
  };
}

function makeEnv(
  enabled = true,
): Env {
  return {
    AI_BACKLOG_STAGE_JOBS_ENABLED:
      enabled ? 'true' : 'false',
  } as Env;
}

function makeDependencies(
  overrides:
    Partial<
      AIBacklogJobWorkerDependencies
    > = {},
): AIBacklogJobWorkerDependencies {
  const recoverExpiredLeases:
    AIBacklogJobWorkerDependencies[
      'recoverExpiredLeases'
    ] = vi.fn(
      async () => 0,
    );

  const getNextJob:
    AIBacklogJobWorkerDependencies[
      'getNextJob'
    ] = vi.fn(
      async () => makeJob(),
    );

  const runStep:
    AIBacklogJobWorkerDependencies[
      'runStep'
    ] = vi.fn(
      async () => makeStep(),
    );

  return {
    recoverExpiredLeases,
    getNextJob,
    runStep,
    ...overrides,
  };
}

describe(
  'ai-backlog-worker',
  () => {
    it('does nothing while staged jobs are disabled', async () => {
      const dependencies =
        makeDependencies();

      const result =
        await runAiBacklogJobWorker(
          makeEnv(false),
          dependencies,
        );

      expect(result).toEqual({
        ok: true,
        skipped: true,
        recoveredLeases: 0,
        reason:
          'stage_jobs_disabled',
      });

      expect(
        dependencies.recoverExpiredLeases,
      ).not.toHaveBeenCalled();

      expect(
        dependencies.getNextJob,
      ).not.toHaveBeenCalled();

      expect(
        dependencies.runStep,
      ).not.toHaveBeenCalled();
    });

    it('recovers expired leases before looking for work', async () => {
      const recoverExpiredLeases =
        vi.fn(async () => 2);

      const getNextJob =
        vi.fn(async () => null);

      const dependencies =
        makeDependencies({
          recoverExpiredLeases,
          getNextJob,
        });

      const result =
        await runAiBacklogJobWorker(
          makeEnv(),
          dependencies,
        );

      expect(result).toEqual({
        ok: true,
        skipped: true,
        recoveredLeases: 2,
        reason:
          'no_runnable_job',
      });

      expect(
        recoverExpiredLeases,
      ).toHaveBeenCalledTimes(1);

      expect(
        getNextJob,
      ).toHaveBeenCalledTimes(1);

      expect(
        dependencies.runStep,
      ).not.toHaveBeenCalled();
    });

    it('runs exactly one stage for one runnable job', async () => {
      const runStep =
        vi.fn(
          async () => makeStep(),
        );

      const dependencies =
        makeDependencies({
          runStep,
        });

      const result =
        await runAiBacklogJobWorker(
          makeEnv(),
          dependencies,
        );

      expect(result.ok).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.jobId).toBe(
        'job-1',
      );

      expect(result.step).toEqual(
        makeStep(),
      );

      expect(runStep).toHaveBeenCalledTimes(
        1,
      );

      expect(runStep).toHaveBeenCalledWith(
        expect.anything(),
        'job-1',
      );
    });

    it('surfaces a failed stage result without running another job', async () => {
      const failedStep =
        makeStep({
          ok: false,
          progressed: false,
          error: 'provider_failure',
        });

      const runStep =
        vi.fn(
          async () => failedStep,
        );

      const dependencies =
        makeDependencies({
          runStep,
        });

      const result =
        await runAiBacklogJobWorker(
          makeEnv(),
          dependencies,
        );

      expect(result.ok).toBe(false);
      expect(result.error).toBe(
        'provider_failure',
      );

      expect(runStep).toHaveBeenCalledTimes(
        1,
      );
    });

    it('surfaces lease recovery failures without touching jobs', async () => {
      const recoverExpiredLeases =
        vi.fn(async () => {
          throw new Error(
            'database_unavailable',
          );
        });

      const dependencies =
        makeDependencies({
          recoverExpiredLeases,
        });

      const result =
        await runAiBacklogJobWorker(
          makeEnv(),
          dependencies,
        );

      expect(result.ok).toBe(false);

      expect(result.error).toBe(
        'lease_recovery_failed:database_unavailable',
      );

      expect(
        dependencies.getNextJob,
      ).not.toHaveBeenCalled();

      expect(
        dependencies.runStep,
      ).not.toHaveBeenCalled();
    });

    it('returns a completed stage result unchanged', async () => {
      const completedStep =
        makeStep({
          action: undefined,
          progressed: true,
          completed: true,
          previousStage: 'persisted',
          nextStage: 'completed',
          reason: 'job_completed',
        });

      const dependencies =
        makeDependencies({
          getNextJob: vi.fn(
            async () => makeJob({
              stage: 'persisted',
            }),
          ),

          runStep: vi.fn(
            async () => completedStep,
          ),
        });

      const result =
        await runAiBacklogJobWorker(
          makeEnv(),
          dependencies,
        );

      expect(result.ok).toBe(true);
      expect(result.step?.completed).toBe(
        true,
      );

      expect(result.reason).toBe(
        'job_completed',
      );
    });
  },
);
