import type {
  Env,
} from '../types';

import {
  dispatchAiBacklogJob,
  isAiBacklogStageJobsEnabled,
  type DispatchAiBacklogJobResult,
} from './ai-backlog-dispatcher';

import {
  runAiBacklogJobWorker,
  type AIBacklogJobWorkerResult,
} from './ai-backlog-worker';

import {
  getQueueHealth,
  isQueueHealthControllerEnabled,
  shouldTriggerEarlyRotation,
  type QueueHealth,
} from './queue-health';

import {
  getRotationSlotMinutes,
  getStarvationRotationSourceId,
  runApifyRotation,
} from './apify-rotation-runner';

export interface AIBacklogQueueHealthResult {
  enabled: boolean;
  channelId?: string;
  state?: QueueHealth['state'];
  scheduledNext6h?: number;
  pendingCandidates?: number;
  backloaded?: boolean;
  rotationAttempted?: boolean;
  rotationFired?: number;
  rotationSourceId?: string | null;
  rotationReason?: string;
  error?: string;
}

export interface AIBacklogCronTickResult {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  error?: string;
  workerBefore?: AIBacklogJobWorkerResult;
  queueHealth?: AIBacklogQueueHealthResult;
  dispatch?: DispatchAiBacklogJobResult;
  workerAfter?: AIBacklogJobWorkerResult;
}

export interface AIBacklogQueueHealthDependencies {
  getHealth:
    typeof getQueueHealth;

  getRotationSourceId:
    typeof getStarvationRotationSourceId;

  runRotation:
    typeof runApifyRotation;
}

const DEFAULT_QUEUE_HEALTH_DEPENDENCIES:
  AIBacklogQueueHealthDependencies = {
    getHealth:
      getQueueHealth,

    getRotationSourceId:
      getStarvationRotationSourceId,

    runRotation:
      runApifyRotation,
  };

export interface AIBacklogCronDependencies {
  runWorker:
    typeof runAiBacklogJobWorker;

  inspectQueueHealth:
    typeof inspectAiBacklogQueueHealth;

  dispatchJob:
    typeof dispatchAiBacklogJob;
}

const DEFAULT_DEPENDENCIES:
  AIBacklogCronDependencies = {
    runWorker:
      runAiBacklogJobWorker,

    inspectQueueHealth:
      inspectAiBacklogQueueHealth,

    dispatchJob:
      dispatchAiBacklogJob,
  };

function errorMessage(
  error: unknown,
): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

function queueHealthChannelId(
  env: Env,
): string {
  return String(
    env.QUEUE_HEALTH_CHANNEL_ID
    ?? env.MARKET_SNAPSHOT_CHANNEL_ID
    ?? 'crypto_fa_pilot',
  ).trim() || 'crypto_fa_pilot';
}

export async function inspectAiBacklogQueueHealth(
  env: Env,
  dependencies:
    AIBacklogQueueHealthDependencies =
      DEFAULT_QUEUE_HEALTH_DEPENDENCIES,
): Promise<AIBacklogQueueHealthResult> {
  if (
    !isQueueHealthControllerEnabled(
      env,
    )
  ) {
    return {
      enabled: false,
    };
  }

  const channelId =
    queueHealthChannelId(env);

  let health: QueueHealth;

  try {
    health =
      await dependencies.getHealth(
        env,
        channelId,
      );
  } catch (error) {
    return {
      enabled: true,
      channelId,
      error:
        `queue_health_failed:${errorMessage(error)}`,
    };
  }

  const result:
    AIBacklogQueueHealthResult = {
      enabled: true,
      channelId,
      state: health.state,
      scheduledNext6h:
        health.scheduledNext6h,
      pendingCandidates:
        health.pendingCandidates,
      backloaded:
        health.backloaded,
      rotationAttempted: false,
      rotationFired: 0,
    };

  const rotationEnabled =
    env.APIFY_ROTATION_ENABLED
      === 'true';

  const fixedScheduleEnabled =
    String(
      (
        env as Env & {
          APIFY_CRYPTO_V2_FIXED_SCHEDULE_ENABLED?:
            string;
        }
      )
        .APIFY_CRYPTO_V2_FIXED_SCHEDULE_ENABLED
      ?? '',
    ).toLowerCase() === 'true';

  const rotationOldEnough =
    health.rotationAgeMin === null
    || health.rotationAgeMin
      >= getRotationSlotMinutes(env);

  if (!rotationEnabled) {
    return {
      ...result,
      rotationReason:
        'rotation_disabled',
    };
  }

  if (fixedScheduleEnabled) {
    return {
      ...result,
      rotationReason:
        'fixed_schedule_enabled',
    };
  }

  if (
    !shouldTriggerEarlyRotation(
      health,
    )
  ) {
    return {
      ...result,
      rotationReason:
        'queue_does_not_require_rotation',
    };
  }

  if (!rotationOldEnough) {
    return {
      ...result,
      rotationReason:
        'rotation_cooldown',
    };
  }

  try {
    const sourceId =
      await dependencies
        .getRotationSourceId(env);

    const rotation =
      await dependencies.runRotation(
        env,
        {
          force: true,
          maxSources: 1,
          queueStarving: true,
          ...(
            sourceId
              ? {
                  onlySourceId:
                    sourceId,
                }
              : {}
          ),
        },
      );

    return {
      ...result,
      rotationAttempted: true,
      rotationFired:
        rotation.plans.length,
      rotationSourceId:
        sourceId,
      rotationReason:
        rotation.reason
        ?? (
          rotation.skipped
            ? 'rotation_skipped'
            : 'starvation_rotation'
        ),
    };
  } catch (error) {
    return {
      ...result,
      rotationAttempted: true,
      error:
        `adaptive_rotation_failed:${errorMessage(error)}`,
    };
  }
}

export async function runAiBacklogCronTick(
  env: Env,
  scheduledTimeMs: number,
  dependencies:
    AIBacklogCronDependencies =
      DEFAULT_DEPENDENCIES,
): Promise<AIBacklogCronTickResult> {
  if (!isAiBacklogStageJobsEnabled(env)) {
    return {
      ok: true,
      skipped: true,
      reason: 'stage_jobs_disabled',
    };
  }

  let workerBefore:
    AIBacklogJobWorkerResult;

  try {
    workerBefore =
      await dependencies.runWorker(env);
  } catch (error) {
    return {
      ok: false,
      skipped: true,
      error:
        `worker_before_exception:${errorMessage(error)}`,
    };
  }

  if (!workerBefore.ok) {
    return {
      ok: false,
      skipped:
        workerBefore.skipped,
      reason:
        workerBefore.reason,
      error:
        workerBefore.error
        ?? 'worker_before_failed',
      workerBefore,
    };
  }

  if (!workerBefore.skipped) {
    return {
      ok: true,
      skipped: false,
      reason:
        workerBefore.step?.completed
          ? 'existing_job_completed'
          : 'existing_job_progressed',
      workerBefore,
    };
  }

  if (
    workerBefore.reason
    !== 'no_runnable_job'
  ) {
    return {
      ok: true,
      skipped: true,
      reason:
        workerBefore.reason
        ?? 'worker_skipped',
      workerBefore,
    };
  }

  let queueHealth:
    AIBacklogQueueHealthResult;

  try {
    queueHealth =
      await dependencies
        .inspectQueueHealth(env);
  } catch (error) {
    queueHealth = {
      enabled:
        isQueueHealthControllerEnabled(
          env,
        ),
      error:
        `queue_health_exception:${errorMessage(error)}`,
    };
  }

  let dispatch:
    DispatchAiBacklogJobResult;

  try {
    dispatch =
      await dependencies.dispatchJob(
        env,
        {
          scheduledTimeMs,
          platformAllowlist: ['x'],
        },
      );
  } catch (error) {
    return {
      ok: false,
      skipped: true,
      error:
        `dispatch_exception:${errorMessage(error)}`,
      workerBefore,
      queueHealth,
    };
  }

  if (!dispatch.ok) {
    return {
      ok: false,
      skipped:
        dispatch.skipped,
      reason:
        dispatch.reason,
      error:
        dispatch.error
        ?? 'dispatch_failed',
      workerBefore,
      queueHealth,
      dispatch,
    };
  }

  if (
    dispatch.reservedCount
      <= 0
  ) {
    return {
      ok: true,
      skipped: true,
      reason:
        dispatch.reason
        ?? 'no_x_candidates',
      workerBefore,
      queueHealth,
      dispatch,
    };
  }

  let workerAfter:
    AIBacklogJobWorkerResult;

  try {
    workerAfter =
      await dependencies.runWorker(env);
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      error:
        `worker_after_exception:${errorMessage(error)}`,
      workerBefore,
      queueHealth,
      dispatch,
    };
  }

  return {
    ok:
      workerAfter.ok,
    skipped: false,
    reason:
      workerAfter.reason
      ?? 'x_job_dispatched',
    error:
      workerAfter.error,
    workerBefore,
    queueHealth,
    dispatch,
    workerAfter,
  };
}
