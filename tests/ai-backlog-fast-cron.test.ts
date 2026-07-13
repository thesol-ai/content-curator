import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  runAiBacklogFastCronTick,
  type AIBacklogCronDependencies,
} from '../apps/worker-api/src/services/ai-backlog-cron';

import type {
  AIBacklogJobWorkerResult,
} from '../apps/worker-api/src/services/ai-backlog-worker';

import type {
  Env,
} from '../apps/worker-api/src/types';

function env(): Env {
  return {
    AI_BACKLOG_STAGE_JOBS_ENABLED:
      'true',
  } as unknown as Env;
}

function workerStep(
  action:
    | 'score'
    | 'gate'
    | 'duplicate'
    | 'translation'
    | 'persist',
  nextStage: string,
): AIBacklogJobWorkerResult {
  return {
    ok: true,
    skipped: false,
    recoveredLeases: 0,
    jobId: 'job-fast',
    step: {
      ok: true,
      progressed: true,
      completed: false,
      jobId: 'job-fast',
      action,
      previousStage: 'claimed',
      nextStage,
    },
  } as AIBacklogJobWorkerResult;
}

function completed():
  AIBacklogJobWorkerResult {
  return {
    ok: true,
    skipped: false,
    recoveredLeases: 0,
    jobId: 'job-fast',
    reason: 'job_completed',
    step: {
      ok: true,
      progressed: true,
      completed: true,
      jobId: 'job-fast',
      previousStage: 'persisted',
      nextStage: 'completed',
      reason: 'job_completed',
    },
  } as AIBacklogJobWorkerResult;
}

function dependencies(
  runWorker:
    AIBacklogCronDependencies['runWorker'],
): AIBacklogCronDependencies {
  return {
    runWorker,
    inspectQueueHealth:
      vi.fn(async () => ({
        enabled: false,
      })),
    dispatchJob:
      vi.fn(async () => ({
        ok: true,
        skipped: true,
        reason: 'no_candidates',
        dispatchId: 'cron:60000',
        reusedExistingJob: false,
        candidatePoolSize: 0,
        selectedCount: 0,
        reservedCount: 0,
        candidateIds: [],
      })),
  };
}

describe(
  'AI backlog fast cron',
  () => {
    it(
      'chains score into gate only',
      async () => {
        const runWorker =
          vi.fn()
            .mockResolvedValueOnce(
              workerStep(
                'score',
                'scored',
              ),
            )
            .mockResolvedValueOnce(
              workerStep(
                'gate',
                'gated',
              ),
            );

        const result =
          await runAiBacklogFastCronTick(
            env(),
            60000,
            dependencies(runWorker),
          );

        expect(runWorker)
          .toHaveBeenCalledTimes(2);

        expect(
          result.chainedWorkers[0]
            ?.step?.action,
        ).toBe('gate');
      },
    );

    it(
      'keeps duplicate isolated',
      async () => {
        const runWorker =
          vi.fn()
            .mockResolvedValueOnce(
              workerStep(
                'duplicate',
                'duplicate_checked',
              ),
            );

        const result =
          await runAiBacklogFastCronTick(
            env(),
            60000,
            dependencies(runWorker),
          );

        expect(runWorker)
          .toHaveBeenCalledTimes(1);

        expect(
          result.chainedWorkers,
        ).toHaveLength(0);
      },
    );

    it(
      'chains translation through completion',
      async () => {
        const runWorker =
          vi.fn()
            .mockResolvedValueOnce(
              workerStep(
                'translation',
                'translated',
              ),
            )
            .mockResolvedValueOnce(
              workerStep(
                'persist',
                'persisted',
              ),
            )
            .mockResolvedValueOnce(
              completed(),
            );

        const result =
          await runAiBacklogFastCronTick(
            env(),
            60000,
            dependencies(runWorker),
          );

        expect(runWorker)
          .toHaveBeenCalledTimes(3);

        expect(result.reason)
          .toBe('fast_chain_completed');
      },
    );
  },
);
