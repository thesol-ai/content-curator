import type {
  AIBacklogJobRow,
  Env,
} from '../types';

import {
  getNextRunnableAiBacklogJob,
  recoverExpiredAiBacklogJobLeases,
  recoverStaleEmptyAiBacklogJobs,
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
  recoveredEmptyJobs?: number;
  jobId?: string;
  reason?: string;
  error?: string;
  step?: AIBacklogJobStepResult;
}

export interface AIBacklogJobWorkerDependencies {
  recoverExpiredLeases:
    typeof recoverExpiredAiBacklogJobLeases;

  recoverStaleEmptyJobs?:
    typeof recoverStaleEmptyAiBacklogJobs;

  getNextJob:
    typeof getNextRunnableAiBacklogJob;

  runStep:
    typeof runAiBacklogJobStep;
}

const DEFAULT_DEPENDENCIES:
  AIBacklogJobWorkerDependencies = {
    recoverExpiredLeases:
      recoverExpiredAiBacklogJobLeases,

    recoverStaleEmptyJobs:
      recoverStaleEmptyAiBacklogJobs,

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

function recoveryMetadata(
  recoveredLeases: number,
  recoveredEmptyJobs: number,
): Pick<
  AIBacklogJobWorkerResult,
  'recoveredLeases' | 'recoveredEmptyJobs'
> {
  return recoveredEmptyJobs > 0
    ? {
        recoveredLeases,
        recoveredEmptyJobs,
      }
    : {
        recoveredLeases,
      };
}

function skippedResult(
  reason: string,
  recoveredLeases = 0,
  recoveredEmptyJobs = 0,
): AIBacklogJobWorkerResult {
  return {
    ok: true,
    skipped: true,
    ...recoveryMetadata(
      recoveredLeases,
      recoveredEmptyJobs,
    ),
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

  let recoveredEmptyJobs = 0;

  if (dependencies.recoverStaleEmptyJobs) {
    try {
      recoveredEmptyJobs =
        await dependencies
          .recoverStaleEmptyJobs(env);
    } catch (error) {
      return {
        ok: false,
        skipped: true,
        ...recoveryMetadata(
          recoveredLeases,
          recoveredEmptyJobs,
        ),
        error:
          `empty_job_recovery_failed:${errorMessage(error)}`,
      };
    }
  }

  let job: AIBacklogJobRow | null;

  try {
    job =
      await dependencies.getNextJob(env);
  } catch (error) {
    return {
      ok: false,
      skipped: true,
      ...recoveryMetadata(
        recoveredLeases,
        recoveredEmptyJobs,
      ),
      error:
        `job_lookup_failed:${errorMessage(error)}`,
    };
  }

  if (!job) {
    return skippedResult(
      'no_runnable_job',
      recoveredLeases,
      recoveredEmptyJobs,
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
      ...recoveryMetadata(
        recoveredLeases,
        recoveredEmptyJobs,
      ),
      jobId: job.id,
      error:
        `job_step_exception:${errorMessage(error)}`,
    };
  }

  return {
    ok: step.ok,
    skipped: false,
    ...recoveryMetadata(
      recoveredLeases,
      recoveredEmptyJobs,
    ),
    jobId: job.id,
    reason:
      step.reason,
    error:
      step.error,
    step,
  };
}
