import type {
  AIBacklogJobItemRow,
  AIBacklogJobRow,
  AIBacklogJobStage,
  Env,
} from '../types';

import {
  advanceAiBacklogJobStage,
  claimAiBacklogJobLease,
  completeAiBacklogJob,
  getAiBacklogJobById,
  getAiBacklogJobItems,
  releaseAiBacklogJobLease,
} from './ai-backlog-jobs';

import {
  createAiBacklogScoreStageHandler,
} from './ai-backlog-score-stage';

import {
  createAiBacklogGateStageHandler,
} from './ai-backlog-gate-stage';

import {
  createAiBacklogDuplicateStageHandler,
} from './ai-backlog-duplicate-stage';

import {
  createAiBacklogTranslationStageHandler,
} from './ai-backlog-translation-stage';

import {
  createAiBacklogPersistStageHandler,
} from './ai-backlog-persist-stage';

export type AIBacklogStageAction =
  | 'score'
  | 'gate'
  | 'duplicate'
  | 'translation'
  | 'persist';

export interface AIBacklogStageHandlerContext {
  env: Env;
  job: AIBacklogJobRow;
  items: AIBacklogJobItemRow[];
  leaseToken: string;
}

export interface AIBacklogStageHandlerResult {
  stageCursor?: number;
  batchContext?: unknown;
}

export type AIBacklogStageHandler = (
  context: AIBacklogStageHandlerContext,
) => Promise<AIBacklogStageHandlerResult>;

export interface AIBacklogStageHandlers {
  score: AIBacklogStageHandler;
  gate: AIBacklogStageHandler;
  duplicate: AIBacklogStageHandler;
  translation: AIBacklogStageHandler;
  persist: AIBacklogStageHandler;
}

export function createDefaultAiBacklogStageHandlers():
  AIBacklogStageHandlers {
  return {
    score:
      createAiBacklogScoreStageHandler(),

    gate:
      createAiBacklogGateStageHandler(),

    duplicate:
      createAiBacklogDuplicateStageHandler(),

    translation:
      createAiBacklogTranslationStageHandler(),

    persist:
      createAiBacklogPersistStageHandler(),
  };
}

export interface AIBacklogJobStepResult {
  ok: boolean;
  progressed: boolean;
  completed: boolean;
  jobId: string;
  action?: AIBacklogStageAction;
  previousStage?: AIBacklogJobStage;
  nextStage?: AIBacklogJobStage;
  reason?: string;
  error?: string;
}

const ACTION_BY_STAGE: Partial<
  Record<AIBacklogJobStage, AIBacklogStageAction>
> = {
  created: 'score',
  claimed: 'score',
  scored: 'gate',
  gated: 'duplicate',
  duplicate_checked: 'translation',
  translated: 'persist',
};

const NEXT_STAGE_BY_ACTION: Record<
  AIBacklogStageAction,
  AIBacklogJobStage
> = {
  score: 'scored',
  gate: 'gated',
  duplicate: 'duplicate_checked',
  translation: 'translated',
  persist: 'persisted',
};

const STAGE_ERROR_COOLDOWN_MS =
  2 * 60 * 1000;

function buildStageErrorRetryAt(
  nowMs = Date.now(),
): string {
  return new Date(
    nowMs + STAGE_ERROR_COOLDOWN_MS,
  )
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

export interface AIBacklogStageRetryDirective {
  nextRunAt: string;
  reason: string;
}

export function parseAiBacklogStageRetryDirective(
  message: string,
): AIBacklogStageRetryDirective | null {
  const match = String(
    message ?? '',
  ).match(
    /^stage_retry_at_ms:(\d+):([\s\S]*)$/,
  );

  if (!match) return null;

  const timestamp = Number(
    match[1],
  );

  if (
    !Number.isFinite(timestamp)
    || timestamp <= 0
  ) {
    return null;
  }

  const date = new Date(timestamp);

  if (
    !Number.isFinite(
      date.getTime(),
    )
  ) {
    return null;
  }

  return {
    nextRunAt:
      date
        .toISOString()
        .slice(0, 19)
        .replace('T', ' '),

    reason:
      String(
        match[2] ?? '',
      ).slice(0, 500),
  };
}

export async function runAiBacklogJobStep(
  env: Env,
  jobId: string,
  handlers: AIBacklogStageHandlers =
    createDefaultAiBacklogStageHandlers(),
  options: {
    leaseSeconds?: number;
  } = {},
): Promise<AIBacklogJobStepResult> {
  const leaseToken = await claimAiBacklogJobLease(
    env,
    jobId,
    options.leaseSeconds,
  );

  if (!leaseToken) {
    return {
      ok: true,
      progressed: false,
      completed: false,
      jobId,
      reason: 'lease_unavailable',
    };
  }

  let job: AIBacklogJobRow | null = null;

  try {
    job = await getAiBacklogJobById(env, jobId);

    if (!job) {
      await releaseAiBacklogJobLease(
        env,
        jobId,
        leaseToken,
        'job_not_found_after_lease',
      );

      return {
        ok: false,
        progressed: false,
        completed: false,
        jobId,
        error: 'job_not_found_after_lease',
      };
    }

    if (job.stage === 'persisted') {
      const completed = await completeAiBacklogJob(
        env,
        jobId,
        leaseToken,
      );

      return {
        ok: completed,
        progressed: completed,
        completed,
        jobId,
        previousStage: job.stage,
        nextStage: completed ? 'completed' : job.stage,
        reason: completed
          ? 'job_completed'
          : 'completion_update_rejected',
      };
    }

    if (job.stage === 'completed') {
      return {
        ok: true,
        progressed: false,
        completed: true,
        jobId,
        previousStage: job.stage,
        nextStage: job.stage,
        reason: 'already_completed',
      };
    }

    const action = ACTION_BY_STAGE[job.stage];

    if (!action) {
      await releaseAiBacklogJobLease(
        env,
        jobId,
        leaseToken,
        `unsupported_stage:${job.stage}`,
        buildStageErrorRetryAt(),
      );

      return {
        ok: false,
        progressed: false,
        completed: false,
        jobId,
        previousStage: job.stage,
        error: `unsupported_stage:${job.stage}`,
      };
    }

    const items = await getAiBacklogJobItems(env, jobId);

    if (items.length === 0) {
      await releaseAiBacklogJobLease(
        env,
        jobId,
        leaseToken,
        'job_has_no_items',
        buildStageErrorRetryAt(),
      );

      return {
        ok: false,
        progressed: false,
        completed: false,
        jobId,
        action,
        previousStage: job.stage,
        error: 'job_has_no_items',
      };
    }

    const handler = handlers[action];

    const handlerResult = await handler({
      env,
      job,
      items,
      leaseToken,
    });

    const nextStage = NEXT_STAGE_BY_ACTION[action];

    const advanced = await advanceAiBacklogJobStage(
      env,
      jobId,
      leaseToken,
      nextStage,
      handlerResult.stageCursor ?? 0,
      handlerResult.batchContext ?? null,
    );

    if (!advanced) {
      throw new Error(
        `stage_advance_rejected:${job.stage}:${nextStage}`
      );
    }

    const released = await releaseAiBacklogJobLease(
      env,
      jobId,
      leaseToken,
      `stage_complete:${action}`,
    );

    if (!released) {
      throw new Error(
        `lease_release_rejected:${job.stage}:${nextStage}`
      );
    }

    return {
      ok: true,
      progressed: true,
      completed: false,
      jobId,
      action,
      previousStage: job.stage,
      nextStage,
    };
  } catch (error) {
    const message = errorMessage(error);

    const retryDirective =
      parseAiBacklogStageRetryDirective(
        message,
      );

    const safeMessage =
      retryDirective?.reason
      || message;

    const nextRunAt =
      retryDirective?.nextRunAt
      ?? buildStageErrorRetryAt();

    await releaseAiBacklogJobLease(
      env,
      jobId,
      leaseToken,
      retryDirective
        ? `stage_retry:${safeMessage}`
        : `stage_error:${safeMessage}`,
      nextRunAt,
    );

    return {
      ok:
        retryDirective !== null,
      progressed: false,
      completed: false,
      jobId,
      previousStage: job?.stage,
      reason:
        retryDirective
          ? 'stage_retry_scheduled'
          : undefined,
      error: safeMessage,
    };
  }
}
