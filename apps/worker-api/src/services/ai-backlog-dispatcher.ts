import type {
  AIBacklogJobItemRow,
  AIBacklogJobRow,
  Env,
} from '../types';

import {
  fetchPendingCandidates,
  getCandidateDrainPlatformAllowlist,
  getFairSourcePickerPoolMultiplier,
  getScoringBatchSize,
  isFairSourcePickerEnabled,
} from './candidate-queue';

import {
  buildAiBacklogDispatchId,
  claimAiBacklogJobLease,
  completeAiBacklogJob,
  createOrGetAiBacklogJob,
  getAiBacklogJobItems,
  releaseAiBacklogJobLease,
  reserveCandidatesForAiBacklogJob,
} from './ai-backlog-jobs';

import {
  selectCandidateBatchForScoring,
  type CandidateBatchSelection,
} from './fair-source-picker';

export interface DispatchAiBacklogJobOptions {
  scheduledTimeMs?: number;
  categoryId?: string;
  excludePlatform?: string;
  platformAllowlist?: string[];
}

export interface DispatchAiBacklogJobResult {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  error?: string;
  dispatchId: string;
  jobId?: string;
  reusedExistingJob: boolean;
  candidatePoolSize: number;
  selectedCount: number;
  reservedCount: number;
  candidateIds: string[];
  selectionStats?: CandidateBatchSelection['stats'];
}

export interface AIBacklogDispatcherDependencies {
  createOrGetJob: typeof createOrGetAiBacklogJob;
  getJobItems: typeof getAiBacklogJobItems;
  reserveCandidates: typeof reserveCandidatesForAiBacklogJob;
  fetchCandidates: typeof fetchPendingCandidates;
  selectCandidates: typeof selectCandidateBatchForScoring;
  claimJobLease: typeof claimAiBacklogJobLease;
  releaseJobLease: typeof releaseAiBacklogJobLease;
  completeJob: typeof completeAiBacklogJob;
}

const DEFAULT_DEPENDENCIES: AIBacklogDispatcherDependencies = {
  createOrGetJob: createOrGetAiBacklogJob,
  getJobItems: getAiBacklogJobItems,
  reserveCandidates: reserveCandidatesForAiBacklogJob,
  fetchCandidates: fetchPendingCandidates,
  selectCandidates: selectCandidateBatchForScoring,
  claimJobLease: claimAiBacklogJobLease,
  releaseJobLease: releaseAiBacklogJobLease,
  completeJob: completeAiBacklogJob,
};

const DISPATCH_LEASE_SECONDS = 120;

export function isAiBacklogStageJobsEnabled(
  env: Env,
): boolean {
  return env.AI_BACKLOG_STAGE_JOBS_ENABLED === 'true';
}

export function getAiBacklogJobBatchSize(
  env: Env,
): number {
  const fallback = Math.max(
    1,
    getScoringBatchSize(env),
  );

  const parsed = Number.parseInt(
    env.AI_BACKLOG_JOB_BATCH_SIZE ?? String(fallback),
    10,
  );

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.max(
    1,
    Math.min(Math.floor(parsed), 50),
  );
}

export function getAiBacklogDispatchSlotMs(
  env: Env,
): number {
  const parsed = Number.parseInt(
    env.AI_BACKLOG_JOB_DISPATCH_SLOT_MINUTES ?? '5',
    10,
  );

  const minutes = !Number.isFinite(parsed) || parsed <= 0
    ? 5
    : Math.max(1, Math.min(Math.floor(parsed), 60));

  return minutes * 60 * 1000;
}

function resolvePlatformAllowlist(
  env: Env,
  override?: string[],
): string[] {
  const values =
    override === undefined
      ? getCandidateDrainPlatformAllowlist(env)
      : override;

  return Array.from(
    new Set(
      values
        .map(value =>
          String(value)
            .trim()
            .toLowerCase(),
        )
        .filter(value =>
          /^[a-z0-9_-]+$/.test(value),
        ),
    ),
  );
}

function emptyResult(
  dispatchId: string,
  reason: string,
): DispatchAiBacklogJobResult {
  return {
    ok: true,
    skipped: true,
    reason,
    dispatchId,
    reusedExistingJob: false,
    candidatePoolSize: 0,
    selectedCount: 0,
    reservedCount: 0,
    candidateIds: [],
  };
}

function existingJobResult(
  dispatchId: string,
  job: AIBacklogJobRow,
  items: AIBacklogJobItemRow[],
): DispatchAiBacklogJobResult {
  return {
    ok: true,
    skipped: false,
    reason: 'existing_job_reused',
    dispatchId,
    jobId: job.id,
    reusedExistingJob: true,
    candidatePoolSize: items.length,
    selectedCount: items.length,
    reservedCount: items.length,
    candidateIds: items.map(
      item => item.candidate_id,
    ),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

export async function dispatchAiBacklogJob(
  env: Env,
  options: DispatchAiBacklogJobOptions = {},
  dependencies: AIBacklogDispatcherDependencies =
    DEFAULT_DEPENDENCIES,
): Promise<DispatchAiBacklogJobResult> {
  const scheduledTimeMs = Number.isFinite(
    options.scheduledTimeMs,
  )
    ? Math.max(0, Math.floor(options.scheduledTimeMs!))
    : Date.now();

  const slotDispatchId =
    buildAiBacklogDispatchId(
      scheduledTimeMs,
      getAiBacklogDispatchSlotMs(env),
    );

  const requestedCategoryId = String(
    options.categoryId ?? '',
  )
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .slice(0, 64);

  const dispatchId = requestedCategoryId
    ? `${slotDispatchId}:category:${requestedCategoryId}`
    : slotDispatchId;

  if (!isAiBacklogStageJobsEnabled(env)) {
    return emptyResult(
      dispatchId,
      'stage_jobs_disabled',
    );
  }

  const job = await dependencies.createOrGetJob(env, {
    dispatchId,
    source: 'cron',
    scheduledTimeMs,
  });

  if (!job) {
    return {
      ...emptyResult(
        dispatchId,
        'job_create_failed',
      ),
      ok: false,
    };
  }

  if (
    job.completed_at !== null
    || job.status === 'completed'
    || job.stage === 'completed'
  ) {
    return {
      ...emptyResult(
        dispatchId,
        'existing_job_completed',
      ),
      jobId: job.id,
    };
  }

  const existingBeforeLease =
    await dependencies.getJobItems(
      env,
      job.id,
    );

  if (existingBeforeLease.length > 0) {
    return existingJobResult(
      dispatchId,
      job,
      existingBeforeLease,
    );
  }

  if (
    job.status !== 'pending'
    || job.stage !== 'created'
  ) {
    return {
      ...emptyResult(
        dispatchId,
        `job_not_dispatchable:${job.status}:${job.stage}`,
      ),
      ok: false,
      jobId: job.id,
    };
  }

  const leaseToken =
    await dependencies.claimJobLease(
      env,
      job.id,
      DISPATCH_LEASE_SECONDS,
    );

  if (!leaseToken) {
    const existingAfterConflict =
      await dependencies.getJobItems(
        env,
        job.id,
      );

    if (existingAfterConflict.length > 0) {
      return existingJobResult(
        dispatchId,
        job,
        existingAfterConflict,
      );
    }

    return {
      ...emptyResult(
        dispatchId,
        'dispatch_lease_unavailable',
      ),
      jobId: job.id,
    };
  }

  try {
    const existingAfterLease =
      await dependencies.getJobItems(
        env,
        job.id,
      );

    if (existingAfterLease.length > 0) {
      const released =
        await dependencies.releaseJobLease(
          env,
          job.id,
          leaseToken,
          'dispatch_existing_items',
        );

      if (!released) {
        return {
          ...emptyResult(
            dispatchId,
            'dispatch_lease_release_failed',
          ),
          ok: false,
          jobId: job.id,
        };
      }

      return existingJobResult(
        dispatchId,
        job,
        existingAfterLease,
      );
    }

    const batchSize = getAiBacklogJobBatchSize(env);
    const fairPickerEnabled =
      isFairSourcePickerEnabled(env);

    const poolLimit = fairPickerEnabled
      ? Math.min(
          batchSize
            * getFairSourcePickerPoolMultiplier(env),
          200,
        )
      : batchSize;

    const platformAllowlist =
      resolvePlatformAllowlist(
        env,
        options.platformAllowlist,
      );

    const candidates =
      await dependencies.fetchCandidates(
        env,
        poolLimit,
        options.categoryId,
        options.excludePlatform,
        platformAllowlist,
      );

    if (candidates.length === 0) {
      const completed =
        await dependencies.completeJob(
          env,
          job.id,
          leaseToken,
        );

      return {
        ...emptyResult(
          dispatchId,
          completed
            ? 'no_candidates'
            : 'empty_job_completion_failed',
        ),
        ok: completed,
        jobId: job.id,
      };
    }

    const dispatchCategoryId =
      options.categoryId
      ?? candidates[0]?.category_id
      ?? null;

    const categoryCandidates = dispatchCategoryId
      ? candidates.filter(
          candidate =>
            candidate.category_id === dispatchCategoryId,
        )
      : [];

    const selection =
      dependencies.selectCandidates(
        categoryCandidates,
        batchSize,
        fairPickerEnabled,
      );

    if (selection.selected.length === 0) {
      const completed =
        await dependencies.completeJob(
          env,
          job.id,
          leaseToken,
        );

      return {
        ...emptyResult(
          dispatchId,
          completed
            ? 'selection_empty'
            : 'empty_job_completion_failed',
        ),
        ok: completed,
        jobId: job.id,
        candidatePoolSize: candidates.length,
        selectionStats: selection.stats,
      };
    }

    const reserved =
      await dependencies.reserveCandidates(
        env,
        job.id,
        leaseToken,
        selection.selected.map(
          candidate => candidate.id,
        ),
      );

    if (reserved.length === 0) {
      const completed =
        await dependencies.completeJob(
          env,
          job.id,
          leaseToken,
        );

      return {
        ...emptyResult(
          dispatchId,
          completed
            ? 'reservation_conflict'
            : 'reservation_conflict_cleanup_failed',
        ),
        ok: completed,
        jobId: job.id,
        candidatePoolSize: candidates.length,
        selectedCount: selection.selected.length,
        selectionStats: selection.stats,
      };
    }

    const released =
      await dependencies.releaseJobLease(
        env,
        job.id,
        leaseToken,
        'dispatch_complete',
      );

    if (!released) {
      return {
        ok: false,
        skipped: false,
        reason: 'dispatch_lease_release_failed',
        dispatchId,
        jobId: job.id,
        reusedExistingJob: false,
        candidatePoolSize: candidates.length,
        selectedCount: selection.selected.length,
        reservedCount: reserved.length,
        candidateIds: reserved.map(
          item => item.candidate_id,
        ),
        selectionStats: selection.stats,
      };
    }

    return {
      ok: true,
      skipped: false,
      dispatchId,
      jobId: job.id,
      reusedExistingJob: false,
      candidatePoolSize: candidates.length,
      selectedCount: selection.selected.length,
      reservedCount: reserved.length,
      candidateIds: reserved.map(
        item => item.candidate_id,
      ),
      selectionStats: selection.stats,
    };
  } catch (error) {
    const message = errorMessage(error);

    await dependencies.releaseJobLease(
      env,
      job.id,
      leaseToken,
      `dispatch_error:${message}`.slice(0, 500),
    );

    return {
      ...emptyResult(
        dispatchId,
        'dispatch_error',
      ),
      ok: false,
      jobId: job.id,
      error: message,
    };
  }
}
