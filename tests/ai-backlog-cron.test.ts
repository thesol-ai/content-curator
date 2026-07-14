import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  inspectAiBacklogQueueHealth,
  runAiBacklogCronTick,
  type AIBacklogCronDependencies,
  type AIBacklogQueueHealthDependencies,
} from '../apps/worker-api/src/services/ai-backlog-cron';

import type {
  AIBacklogJobWorkerResult,
} from '../apps/worker-api/src/services/ai-backlog-worker';

import type {
  DispatchAiBacklogJobResult,
} from '../apps/worker-api/src/services/ai-backlog-dispatcher';

import type {
  QueueHealth,
} from '../apps/worker-api/src/services/queue-health';

import type {
  Env,
} from '../apps/worker-api/src/types';

function makeEnv(
  enabled = true,
  overrides:
    Partial<Env> = {},
): Env {
  return {
    AI_BACKLOG_STAGE_JOBS_ENABLED:
      enabled
        ? 'true'
        : 'false',
    ...overrides,
  } as unknown as Env;
}

function noWorkResult():
  AIBacklogJobWorkerResult {
  return {
    ok: true,
    skipped: true,
    recoveredLeases: 0,
    reason: 'no_runnable_job',
  };
}

function progressedResult(
  jobId = 'job-existing',
): AIBacklogJobWorkerResult {
  return {
    ok: true,
    skipped: false,
    recoveredLeases: 0,
    jobId,
    step: {
      ok: true,
      progressed: true,
      completed: false,
      jobId,
      action: 'score',
      previousStage: 'created',
      nextStage: 'scored',
    },
  };
}

function dispatchedResult():
  DispatchAiBacklogJobResult {
  return {
    ok: true,
    skipped: false,
    dispatchId:
      'cron:300000',
    jobId:
      'job-new',
    reusedExistingJob: false,
    candidatePoolSize: 1,
    selectedCount: 1,
    reservedCount: 1,
    candidateIds: [
      'candidate-x',
    ],
  };
}

function disabledHealth() {
  return {
    enabled: false,
  } as const;
}

function makeDependencies(
  overrides:
    Partial<AIBacklogCronDependencies> = {},
): AIBacklogCronDependencies {
  return {
    runWorker:
      vi.fn(
        async () =>
          noWorkResult(),
      ),

    inspectQueueHealth:
      vi.fn(
        async () =>
          disabledHealth(),
      ),

    dispatchJob:
      vi.fn(
        async () =>
          dispatchedResult(),
      ),

    ...overrides,
  };
}

function health(
  overrides:
    Partial<QueueHealth> = {},
): QueueHealth {
  return {
    channelId:
      'crypto_fa_pilot',
    state:
      'healthy',
    scheduledNext6h: 5,
    scheduledNext24h: 8,
    totalScheduled: 8,
    pendingCandidates: 4,
    lastPublishedAgoMin: 10,
    rotationAgeMin: 60,
    backloaded: false,
    ...overrides,
  };
}

describe(
  'AI backlog cron tick',
  () => {
    it('is inert while staged jobs are disabled', async () => {
      const dependencies =
        makeDependencies();

      const result =
        await runAiBacklogCronTick(
          makeEnv(false),
          300000,
          dependencies,
        );

      expect(result).toEqual({
        ok: true,
        skipped: true,
        reason:
          'stage_jobs_disabled',
      });

      expect(
        dependencies.runWorker,
      ).not.toHaveBeenCalled();

      expect(
        dependencies.inspectQueueHealth,
      ).not.toHaveBeenCalled();

      expect(
        dependencies.dispatchJob,
      ).not.toHaveBeenCalled();
    });

    it('progresses an existing job before queue inspection', async () => {
      const dependencies =
        makeDependencies({
          runWorker:
            vi.fn(
              async () =>
                progressedResult(),
            ),
        });

      const result =
        await runAiBacklogCronTick(
          makeEnv(),
          300000,
          dependencies,
        );

      expect(result.ok).toBe(true);

      expect(result.reason).toBe(
        'existing_job_progressed',
      );

      expect(
        dependencies.runWorker,
      ).toHaveBeenCalledTimes(1);

      expect(
        dependencies.inspectQueueHealth,
      ).not.toHaveBeenCalled();

      expect(
        dependencies.dispatchJob,
      ).not.toHaveBeenCalled();
    });

    it('inspects queue health before dispatching X', async () => {
      const order: string[] = [];

      const runWorker =
        vi.fn()
          .mockImplementationOnce(
            async () => {
              order.push(
                'worker-before',
              );

              return noWorkResult();
            },
          )
          .mockImplementationOnce(
            async () => {
              order.push(
                'worker-after',
              );

              return progressedResult(
                'job-new',
              );
            },
          );

      const inspectQueueHealth =
        vi.fn(
          async () => {
            order.push(
              'queue-health',
            );

            return {
              enabled: true,
              channelId:
                'crypto_fa_pilot',
              state:
                'starving' as const,
              scheduledNext6h: 0,
              pendingCandidates: 1,
              backloaded: false,
              rotationAttempted: false,
              rotationFired: 0,
              rotationReason:
                'queue_does_not_require_rotation',
            };
          },
        );

      const dispatchJob =
        vi.fn(
          async () => {
            order.push(
              'dispatch',
            );

            return dispatchedResult();
          },
        );

      const result =
        await runAiBacklogCronTick(
          makeEnv(),
          300000,
          {
            runWorker,
            inspectQueueHealth,
            dispatchJob,
          },
        );

      expect(result.ok).toBe(true);
      expect(result.skipped).toBe(false);

      expect(order).toEqual([
        'worker-before',
        'queue-health',
        'dispatch',
        'worker-after',
      ]);

      expect(
        dispatchJob,
      ).toHaveBeenCalledWith(
        expect.anything(),
        {
          scheduledTimeMs:
            300000,
          platformAllowlist: [
            'x',
          ],
        },
      );

      expect(
        result.queueHealth,
      ).toEqual(
        expect.objectContaining({
          enabled: true,
          state:
            'starving',
        }),
      );
    });

    it('does not run another stage when no X candidates exist', async () => {
      const runWorker =
        vi.fn(
          async () =>
            noWorkResult(),
        );

      const dispatchJob =
        vi.fn(
          async () => ({
            ...dispatchedResult(),
            skipped: true,
            reason:
              'no_candidates',
            candidatePoolSize: 0,
            selectedCount: 0,
            reservedCount: 0,
            candidateIds: [],
          }),
        );

      const result =
        await runAiBacklogCronTick(
          makeEnv(),
          300000,
          makeDependencies({
            runWorker,
            dispatchJob,
          }),
        );

      expect(result.ok).toBe(true);
      expect(result.skipped).toBe(true);

      expect(result.reason).toBe(
        'no_candidates',
      );

      expect(
        runWorker,
      ).toHaveBeenCalledTimes(1);
    });

    it('continues dispatch when queue inspection fails', async () => {
      const runWorker =
        vi.fn()
          .mockResolvedValueOnce(
            noWorkResult(),
          )
          .mockResolvedValueOnce(
            progressedResult(
              'job-new',
            ),
          );

      const dispatchJob =
        vi.fn(
          async () =>
            dispatchedResult(),
        );

      const result =
        await runAiBacklogCronTick(
          makeEnv(),
          300000,
          makeDependencies({
            runWorker,
            dispatchJob,
            inspectQueueHealth:
              vi.fn(
                async () => {
                  throw new Error(
                    'db_unavailable',
                  );
                },
              ),
          }),
        );

      expect(result.ok).toBe(true);

      expect(
        result.queueHealth?.error,
      ).toBe(
        'queue_health_exception:db_unavailable',
      );

      expect(
        dispatchJob,
      ).toHaveBeenCalledTimes(1);
    });
  },
);

describe(
  'staged queue health inspection',
  () => {
    it('is inert when the controller is disabled', async () => {
      const dependencies:
        AIBacklogQueueHealthDependencies = {
          getHealth:
            vi.fn(),

          getRotationSourceId:
            vi.fn(),

          runRotation:
            vi.fn(),
        };

      const result =
        await inspectAiBacklogQueueHealth(
          makeEnv(),
          dependencies,
        );

      expect(result).toEqual({
        enabled: false,
      });

      expect(
        dependencies.getHealth,
      ).not.toHaveBeenCalled();
    });

    it('does not rotate a healthy queue', async () => {
      const dependencies:
        AIBacklogQueueHealthDependencies = {
          getHealth:
            vi.fn(
              async () =>
                health(),
            ),

          getRotationSourceId:
            vi.fn(),

          runRotation:
            vi.fn(),
        };

      const result =
        await inspectAiBacklogQueueHealth(
          makeEnv(
            true,
            {
              QUEUE_HEALTH_CONTROLLER_ENABLED:
                'true',
              APIFY_ROTATION_ENABLED:
                'true',
            },
          ),
          dependencies,
        );

      expect(result).toEqual(
        expect.objectContaining({
          enabled: true,
          state:
            'healthy',
          rotationAttempted: false,
          rotationReason:
            'queue_does_not_require_rotation',
        }),
      );

      expect(
        dependencies.runRotation,
      ).not.toHaveBeenCalled();
    });

    it('triggers one starvation rotation when no candidates exist', async () => {
      const dependencies:
        AIBacklogQueueHealthDependencies = {
          getHealth:
            vi.fn(
              async () =>
                health({
                  state:
                    'starving',
                  scheduledNext6h: 0,
                  pendingCandidates: 0,
                  rotationAgeMin: 60,
                }),
            ),

          getRotationSourceId:
            vi.fn(
              async () =>
                'crypto_v2_news_a',
            ),

          runRotation:
            vi.fn(
              async () => ({
                ok: true,
                skipped: false,
                bucket: 1,
                rotationRunId:
                  'rotation-1',
                plans: [
                  {
                    sourceId:
                      'crypto_v2_news_a',
                  },
                ],
              } as any),
            ),
        };

      const result =
        await inspectAiBacklogQueueHealth(
          makeEnv(
            true,
            {
              QUEUE_HEALTH_CONTROLLER_ENABLED:
                'true',
              APIFY_ROTATION_ENABLED:
                'true',
            },
          ),
          dependencies,
        );

      expect(result).toEqual(
        expect.objectContaining({
          enabled: true,
          state:
            'starving',
          rotationAttempted: true,
          rotationFired: 1,
          rotationSourceId:
            'crypto_v2_news_a',
          rotationReason:
            'starvation_rotation',
        }),
      );

      expect(
        dependencies.runRotation,
      ).toHaveBeenCalledWith(
        expect.anything(),
        {
          force: true,
          maxSources: 1,
          queueStarving: true,
          onlySourceId:
            'crypto_v2_news_a',
        },
      );
    });
  },
);
