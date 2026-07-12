import type {
  AIBacklogJobRow,
  Env,
} from '../types';

import {
  getNextRunnableAiBacklogJob,
  recoverExpiredAiBacklogJobLeases,
} from './ai-backlog-jobs';

import {
  isAiBacklogStageJobsEnabled,
} from './ai-backlog-dispatcher';

import {
  runAiBacklogJobStep,
  type AIBacklogJobStepResult,
} from './ai-backlog-stage-runner';

export interface AIBacklogJobWorkerResult {
  ok: boolean;
  skipped: boolean;
  recoveredLeases: number;
  jobId?: string;
  reason?: string;
  error?: string;
  step?: AIBacklogJobStepResult;
}

export interface AIBacklogJobWorkerDependencies {
  recoverExpiredLeases:
    typeof recoverExpiredAiBacklogJobLeases;

  getNextJob:
    typeof getNextRunnableAiBacklogJob;

  runStep:
    typeof runAiBacklogJobStep;
}

const DEFAULT_DEPENDENCIES:
  AIBacklogJobWorkerDependencies = {
    recoverExpiredLeases:
      recoverExpiredAiBacklogJobLeases,

    getNextJob:
      getNextRunnableAiBacklogJob,

    runStep:
      runAiBacklogJobStep,
  };

function errorMessage(
  error: unknown,
): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

function skippedResult(
  reason: string,
  recoveredLeases = 0,
): AIBacklogJobWorkerResult {
  return {
    ok: true,
    skipped: true,
    recoveredLeases,
    reason,
  };
}

export async function runAiBacklogJobWorker(
  env: Env,
  dependencies:
    AIBacklogJobWorkerDependencies =
      DEFAULT_DEPENDENCIES,
): Promise<AIBacklogJobWorkerResult> {
  if (!isAiBacklogStageJobsEnabled(env)) {
    return skippedResult(
      'stage_jobs_disabled',
    );
  }

  let recoveredLeases = 0;

  try {
    recoveredLeases =
      await dependencies
        .recoverExpiredLeases(env);
  } catch (error) {
    return {
      ok: false,
      skipped: true,
      recoveredLeases: 0,
      error:
        `lease_recovery_failed:${errorMessage(error)}`,
    };
  }

  let job: AIBacklogJobRow | null;

  try {
    job =
      await dependencies.getNextJob(env);
  } catch (error) {
    return {
      ok: false,
      skipped: true,
      recoveredLeases,
      error:
        `job_lookup_failed:${errorMessage(error)}`,
    };
  }

  if (!job) {
    return skippedResult(
      'no_runnable_job',
      recoveredLeases,
    );
  }

  let step: AIBacklogJobStepResult;

  try {
    step =
      await dependencies.runStep(
        env,
        job.id,
      );
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      recoveredLeases,
      jobId: job.id,
      error:
        `job_step_exception:${errorMessage(error)}`,
    };
  }

  return {
    ok: step.ok,
    skipped: false,
    recoveredLeases,
    jobId: job.id,
    reason:
      step.reason,
    error:
      step.error,
    step,
  };
}
