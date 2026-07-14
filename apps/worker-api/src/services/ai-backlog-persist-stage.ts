import type {
  AICandidateRow,
  AIGateResult,
  AIBacklogJobItemRow,
  CategoryRow,
  ChannelRow,
  Env,
  NormalizedItem,
} from '../types';

import {
  persistCandidateDecision,
  type CandidateEvaluation,
} from './backlog-drain';

import {
  checkpointAiBacklogJobItem,
  failAiBacklogJobItem,
  getAiBacklogJobCandidates,
} from './ai-backlog-jobs';

import type {
  TranslationCheckpointPayload,
} from './ai-backlog-translation-stage';

import type {
  AIBacklogStageHandler,
  AIBacklogStageHandlerContext,
  AIBacklogStageHandlerResult,
} from './ai-backlog-stage-runner';

interface GateCheckpointPayload {
  evaluation: CandidateEvaluation;
  rejectReason: string | null;
  similarTopicRejected: boolean;
}

interface ParsedCandidate {
  row: AICandidateRow;
  item: NormalizedItem;
  keys: string[];
}

interface PersistEntry {
  jobItem: AIBacklogJobItemRow;
  candidate: ParsedCandidate;
  translation: TranslationCheckpointPayload;
  evaluation: CandidateEvaluation;
}

export interface PersistedCandidateState {
  candidateStatus: string;
  queueCount: number;
}

export interface PersistCheckpointPayload {
  candidateStatus: string;
  selected: number;
  rejected: number;
  queued: number;
  recovered: boolean;
}

export interface AIBacklogPersistStageDependencies {
  loadCandidates:
    typeof getAiBacklogJobCandidates;

  checkpointPersist:
    typeof checkpointAiBacklogJobItem;

  failItem:
    typeof failAiBacklogJobItem;

  loadCategory: (
    env: Env,
    categoryId: string,
  ) => Promise<CategoryRow | null>;

  loadChannels: (
    env: Env,
    categoryId: string,
  ) => Promise<ChannelRow[]>;

  loadPersistedState: (
    env: Env,
    jobId: string,
    candidateId: string,
  ) => Promise<PersistedCandidateState | null>;

  recoverQueuedCandidateStatus: (
    env: Env,
    jobId: string,
    candidateId: string,
  ) => Promise<boolean>;

  persistDecision:
    typeof persistCandidateDecision;
}

const DEFAULT_DEPENDENCIES:
  AIBacklogPersistStageDependencies = {
    loadCandidates:
      getAiBacklogJobCandidates,

    checkpointPersist:
      checkpointAiBacklogJobItem,

    failItem:
      failAiBacklogJobItem,

    loadCategory: async (
      env,
      categoryId,
    ) => env.DB.prepare(`
      SELECT *
      FROM categories
      WHERE id = ?
        AND enabled = 1
      LIMIT 1
    `).bind(
      categoryId,
    ).first<CategoryRow>(),

    loadChannels: async (
      env,
      categoryId,
    ) => {
      const rows = await env.DB.prepare(`
        SELECT *
        FROM channels
        WHERE category_id = ?
          AND enabled = 1
      `).bind(
        categoryId,
      ).all<ChannelRow>();

      return rows.results ?? [];
    },

    loadPersistedState: async (
      env,
      jobId,
      candidateId,
    ) => {
      const row = await env.DB.prepare(`
        SELECT
          candidate.status
            AS candidate_status,
          (
            SELECT COUNT(*)
            FROM publish_queue
            WHERE candidate_id =
              candidate.id
          ) AS queue_count
        FROM ai_candidate_queue
          AS candidate
        WHERE candidate.id = ?
          AND candidate.processing_job_id = ?
        LIMIT 1
      `).bind(
        candidateId,
        jobId,
      ).first<{
        candidate_status: string;
        queue_count: number;
      }>();

      if (!row) return null;

      return {
        candidateStatus:
          String(
            row.candidate_status ?? '',
          ),
        queueCount:
          Number(
            row.queue_count ?? 0,
          ),
      };
    },

    recoverQueuedCandidateStatus: async (
      env,
      jobId,
      candidateId,
    ) => {
      const result = await env.DB.prepare(`
        UPDATE ai_candidate_queue
        SET
          status = 'queued',
          last_error = NULL,
          claimed_at = NULL,
          scored_at = COALESCE(
            scored_at,
            CURRENT_TIMESTAMP
          )
        WHERE id = ?
          AND processing_job_id = ?
          AND status != 'queued'
          AND EXISTS (
            SELECT 1
            FROM publish_queue
            WHERE candidate_id = ?
          )
      `).bind(
        candidateId,
        jobId,
        candidateId,
      ).run();

      return Number(
        result.meta.changes ?? 0,
      ) > 0;
    },

    persistDecision:
      persistCandidateDecision,
  };

const TERMINAL_PERSIST_STATUSES =
  new Set([
    'queued',
    'ai_rejected',
    'ai_selected',
    'needs_translation',
  ]);

function parseCandidate(
  row: AICandidateRow,
): ParsedCandidate | null {
  try {
    const item = JSON.parse(
      row.normalized_item_json,
    ) as NormalizedItem;

    const keys = JSON.parse(
      row.dedupe_keys_json,
    ) as string[];

    if (
      !item
      || !item.sourceUrl
      || !item.postId
      || !Array.isArray(item.media)
      || !Array.isArray(keys)
    ) {
      return null;
    }

    return {
      row,
      item,
      keys,
    };
  } catch {
    return null;
  }
}

function isAiResult(
  value: unknown,
): value is AIGateResult {
  if (
    !value
    || typeof value !== 'object'
  ) {
    return false;
  }

  const result =
    value as AIGateResult;

  return (
    typeof result.publish === 'boolean'
    && Number.isFinite(
      Number(result.score),
    )
    && typeof result.topicFingerprint
      === 'string'
    && Array.isArray(
      result.riskFlags,
    )
    && typeof result.translations
      === 'object'
    && result.translations !== null
  );
}

function isCandidateEvaluation(
  value: unknown,
): value is CandidateEvaluation {
  if (
    !value
    || typeof value !== 'object'
  ) {
    return false;
  }

  const evaluation =
    value as CandidateEvaluation;

  return (
    typeof evaluation.itemId
      === 'string'
    && Object.prototype.hasOwnProperty.call(
      evaluation,
      'recentTopicDuplicate',
    )
    && Object.prototype.hasOwnProperty.call(
      evaluation,
      'storyKeyRejectReason',
    )
  );
}

function parseGateCheckpoint(
  value: string | null,
): GateCheckpointPayload | null {
  if (!value) return null;

  try {
    const checkpoint = JSON.parse(
      value,
    ) as GateCheckpointPayload;

    if (
      !checkpoint
      || !isCandidateEvaluation(
        checkpoint.evaluation,
      )
      || !Object.prototype.hasOwnProperty.call(
        checkpoint,
        'rejectReason',
      )
    ) {
      return null;
    }

    return checkpoint;
  } catch {
    return null;
  }
}

function parseTranslationCheckpoint(
  value: string | null,
): TranslationCheckpointPayload | null {
  if (!value) return null;

  try {
    const checkpoint = JSON.parse(
      value,
    ) as TranslationCheckpointPayload;

    if (
      !checkpoint
      || !isAiResult(checkpoint.ai)
      || typeof checkpoint.rejected
        !== 'boolean'
      || typeof checkpoint.skipped
        !== 'boolean'
      || !Object.prototype.hasOwnProperty.call(
        checkpoint,
        'rejectReason',
      )
    ) {
      return null;
    }

    return checkpoint;
  } catch {
    return null;
  }
}

function parsePersistCheckpoint(
  value: string | null,
): PersistCheckpointPayload | null {
  if (!value) return null;

  try {
    const checkpoint = JSON.parse(
      value,
    ) as PersistCheckpointPayload;

    if (
      !checkpoint
      || typeof checkpoint.candidateStatus
        !== 'string'
      || !Number.isFinite(
        Number(checkpoint.selected),
      )
      || !Number.isFinite(
        Number(checkpoint.rejected),
      )
      || !Number.isFinite(
        Number(checkpoint.queued),
      )
      || typeof checkpoint.recovered
        !== 'boolean'
    ) {
      return null;
    }

    return checkpoint;
  } catch {
    return null;
  }
}

type TerminalPersistedCandidateState =
  PersistedCandidateState & {
    candidateStatus:
      | 'queued'
      | 'ai_rejected'
      | 'ai_selected'
      | 'needs_translation';
  };

function needsQueuedStateRecovery(
  state:
    PersistedCandidateState | null,
): state is PersistedCandidateState {
  return Boolean(
    state
    && state.queueCount > 0
    && state.candidateStatus
      !== 'queued',
  );
}

function isTerminalPersistState(
  state:
    PersistedCandidateState | null,
): state is TerminalPersistedCandidateState {
  return Boolean(
    state
    && TERMINAL_PERSIST_STATUSES.has(
      state.candidateStatus,
    ),
  );
}

function recoveredPayload(
  state: PersistedCandidateState,
): PersistCheckpointPayload {
  if (
    state.candidateStatus
    === 'ai_rejected'
  ) {
    return {
      candidateStatus:
        state.candidateStatus,
      selected: 0,
      rejected: 1,
      queued: 0,
      recovered: true,
    };
  }

  return {
    candidateStatus:
      state.candidateStatus,
    selected: 1,
    rejected: 0,
    queued:
      state.candidateStatus
        === 'queued'
        ? Math.max(
            1,
            state.queueCount,
          )
        : Math.max(
            0,
            state.queueCount,
          ),
    recovered: true,
  };
}

async function failItem(
  context:
    AIBacklogStageHandlerContext,
  item: AIBacklogJobItemRow,
  reason: string,
  dependencies:
    AIBacklogPersistStageDependencies,
): Promise<void> {
  const failed =
    await dependencies.failItem(
      context.env,
      context.job.id,
      item.candidate_id,
      reason,
    );

  if (!failed) {
    throw new Error(
      `persist_item_fail_rejected:${item.candidate_id}`,
    );
  }
}

async function checkpointPersist(
  context:
    AIBacklogStageHandlerContext,
  candidateId: string,
  payload:
    PersistCheckpointPayload,
  dependencies:
    AIBacklogPersistStageDependencies,
): Promise<void> {
  const checkpointed =
    await dependencies.checkpointPersist(
      context.env,
      {
        jobId:
          context.job.id,
        candidateId,
        checkpoint: 'persist',
        result: payload,
      },
    );

  if (!checkpointed) {
    throw new Error(
      `persist_checkpoint_rejected:${candidateId}`,
    );
  }
}

export async function runAiBacklogPersistStage(
  context:
    AIBacklogStageHandlerContext,
  dependencies:
    AIBacklogPersistStageDependencies =
      DEFAULT_DEPENDENCIES,
): Promise<AIBacklogStageHandlerResult> {
  let completed = 0;
  let reused = 0;
  let failedNow = 0;
  let selected = 0;
  let rejected = 0;
  let queued = 0;
  let recovered = 0;

  const unresolvedItems:
    AIBacklogJobItemRow[] = [];

  for (const item of context.items) {
    if (item.status === 'failed') {
      completed++;
      failedNow++;
      continue;
    }

    if (
      item.persist_result_json
      !== null
    ) {
      const checkpoint =
        parsePersistCheckpoint(
          item.persist_result_json,
        );

      if (!checkpoint) {
        throw new Error(
          `persist_checkpoint_invalid:${item.candidate_id}`,
        );
      }

      completed++;
      reused++;
      selected +=
        checkpoint.selected;
      rejected +=
        checkpoint.rejected;
      queued += checkpoint.queued;

      if (checkpoint.recovered) {
        recovered++;
      }

      continue;
    }

    unresolvedItems.push(item);
  }

  if (
    completed
    === context.items.length
  ) {
    return {
      stageCursor: completed,
      batchContext: {
        total: context.items.length,
        reused,
        persistedNow: 0,
        selected,
        rejected,
        queued,
        recovered,
        failed: failedNow,
      },
    };
  }

  const candidates =
    await dependencies.loadCandidates(
      context.env,
      context.job.id,
    );

  const candidateById = new Map(
    candidates.map(
      candidate => [
        candidate.id,
        candidate,
      ],
    ),
  );

  const entries:
    PersistEntry[] = [];

  for (const jobItem of unresolvedItems) {
    const row = candidateById.get(
      jobItem.candidate_id,
    );

    if (!row) {
      await failItem(
        context,
        jobItem,
        'candidate_missing_for_persist',
        dependencies,
      );

      completed++;
      failedNow++;
      continue;
    }

    const candidate =
      parseCandidate(row);

    if (!candidate) {
      await failItem(
        context,
        jobItem,
        'invalid_candidate_payload',
        dependencies,
      );

      completed++;
      failedNow++;
      continue;
    }

    const gate =
      parseGateCheckpoint(
        jobItem.gate_result_json,
      );

    if (!gate) {
      await failItem(
        context,
        jobItem,
        'gate_checkpoint_missing',
        dependencies,
      );

      completed++;
      failedNow++;
      continue;
    }

    const translation =
      parseTranslationCheckpoint(
        jobItem.translation_result_json,
      );

    if (!translation) {
      await failItem(
        context,
        jobItem,
        'translation_checkpoint_missing',
        dependencies,
      );

      completed++;
      failedNow++;
      continue;
    }

    entries.push({
      jobItem,
      candidate,
      translation,
      evaluation:
        gate.evaluation,
    });
  }

  if (entries.length === 0) {
    if (
      completed
      !== context.items.length
    ) {
      throw new Error(
        `persist_stage_incomplete:${context.items.length - completed}`,
      );
    }

    return {
      stageCursor: completed,
      batchContext: {
        total: context.items.length,
        reused,
        persistedNow: 0,
        selected,
        rejected,
        queued,
        recovered,
        failed: failedNow,
      },
    };
  }

  const categoryIds = new Set(
    entries.map(
      entry =>
        entry.candidate.row.category_id,
    ),
  );

  if (categoryIds.size !== 1) {
    for (const entry of entries) {
      await failItem(
        context,
        entry.jobItem,
        'mixed_candidate_categories',
        dependencies,
      );

      completed++;
      failedNow++;
    }

    return {
      stageCursor: completed,
      batchContext: {
        total: context.items.length,
        reused,
        persistedNow: 0,
        selected,
        rejected,
        queued,
        recovered,
        failed: failedNow,
        reason:
          'mixed_candidate_categories',
      },
    };
  }

  const categoryId =
    entries[0]!.candidate.row
      .category_id;

  const category =
    await dependencies.loadCategory(
      context.env,
      categoryId,
    );

  if (!category) {
    for (const entry of entries) {
      await failItem(
        context,
        entry.jobItem,
        'category_not_found',
        dependencies,
      );

      completed++;
      failedNow++;
    }

    return {
      stageCursor: completed,
      batchContext: {
        total: context.items.length,
        reused,
        persistedNow: 0,
        selected,
        rejected,
        queued,
        recovered,
        failed: failedNow,
        reason:
          'category_not_found',
      },
    };
  }

  const channels =
    await dependencies.loadChannels(
      context.env,
      categoryId,
    );

  let persistedNow = 0;

  for (const entry of entries) {
    const candidateId =
      entry.jobItem.candidate_id;

    let existingState =
      await dependencies
        .loadPersistedState(
          context.env,
          context.job.id,
          candidateId,
        );

    if (
      needsQueuedStateRecovery(
        existingState,
      )
    ) {
      const repaired =
        await dependencies
          .recoverQueuedCandidateStatus(
            context.env,
            context.job.id,
            candidateId,
          );

      if (!repaired) {
        throw new Error(
          `persist_queue_recovery_rejected:${candidateId}`,
        );
      }

      existingState =
        await dependencies
          .loadPersistedState(
            context.env,
            context.job.id,
            candidateId,
          );

      if (
        !existingState
        || existingState.candidateStatus
          !== 'queued'
        || existingState.queueCount < 1
      ) {
        throw new Error(
          `persist_queue_recovery_incomplete:${candidateId}`,
        );
      }
    }

    if (
      isTerminalPersistState(
        existingState,
      )
    ) {
      const payload =
        recoveredPayload(
          existingState,
        );

      await checkpointPersist(
        context,
        candidateId,
        payload,
        dependencies,
      );

      completed++;
      recovered++;
      selected += payload.selected;
      rejected += payload.rejected;
      queued += payload.queued;
      continue;
    }

    const counts =
      await dependencies.persistDecision(
        context.env,
        channels,
        category,
        entry.candidate,
        entry.translation.ai,
        entry.evaluation,
        entry.translation.rejectReason,
      );

    const persistedState =
      await dependencies
        .loadPersistedState(
          context.env,
          context.job.id,
          candidateId,
        );

    if (
      !isTerminalPersistState(
        persistedState,
      )
    ) {
      throw new Error(
        `persist_state_not_terminal:${candidateId}:${persistedState?.candidateStatus ?? 'missing'}`,
      );
    }

    const payload:
      PersistCheckpointPayload = {
        candidateStatus:
          persistedState.candidateStatus,
        selected:
          counts.selected,
        rejected:
          counts.rejected,
        queued:
          counts.queued,
        recovered: false,
      };

    await checkpointPersist(
      context,
      candidateId,
      payload,
      dependencies,
    );

    completed++;
    persistedNow++;
    selected += counts.selected;
    rejected += counts.rejected;
    queued += counts.queued;
  }

  if (
    completed
    !== context.items.length
  ) {
    throw new Error(
      `persist_stage_incomplete:${context.items.length - completed}`,
    );
  }

  return {
    stageCursor: completed,
    batchContext: {
      total: context.items.length,
      reused,
      persistedNow,
      selected,
      rejected,
      queued,
      recovered,
      failed: failedNow,
    },
  };
}

export function createAiBacklogPersistStageHandler(
  dependencies:
    AIBacklogPersistStageDependencies =
      DEFAULT_DEPENDENCIES,
): AIBacklogStageHandler {
  return context =>
    runAiBacklogPersistStage(
      context,
      dependencies,
    );
}
