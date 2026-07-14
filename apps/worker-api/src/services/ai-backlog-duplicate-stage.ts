import type {
  AICandidateRow,
  AIGateResult,
  AIBacklogJobItemRow,
  Env,
  NormalizedItem,
} from '../types';

import {
  checkpointAiBacklogJobDuplicates,
  failAiBacklogJobItem,
  getAiBacklogJobCandidates,
} from './ai-backlog-jobs';

import {
  runDuplicateAiJudgeForSurvivors,
  type DuplicateAiJudgeResult,
} from './duplicate-ai-judge';

import type {
  AIBacklogStageHandler,
  AIBacklogStageHandlerContext,
  AIBacklogStageHandlerResult,
} from './ai-backlog-stage-runner';

interface GateCheckpointPayload {
  evaluation: unknown;
  rejectReason: string | null;
  similarTopicRejected: boolean;
}

export interface DuplicateCheckpointPayload {
  ai: AIGateResult;
  rejected: boolean;
  rejectReason: string | null;
  judge: DuplicateAiJudgeResult | null;
  skippedByGate: boolean;
}

interface DuplicateEntry {
  jobItem: AIBacklogJobItemRow;
  row: AICandidateRow;
  item: NormalizedItem;
  ai: AIGateResult;
  gate: GateCheckpointPayload;
  existing: boolean;
}

export interface AIBacklogDuplicateStageDependencies {
  loadCandidates:
    typeof getAiBacklogJobCandidates;

  checkpointDuplicates:
    typeof checkpointAiBacklogJobDuplicates;

  failItem:
    typeof failAiBacklogJobItem;

  loadChannelId: (
    env: Env,
    categoryId: string,
  ) => Promise<string | null>;

  runJudge:
    typeof runDuplicateAiJudgeForSurvivors;
}

const DEFAULT_DEPENDENCIES:
  AIBacklogDuplicateStageDependencies = {
    loadCandidates:
      getAiBacklogJobCandidates,

    checkpointDuplicates:
      checkpointAiBacklogJobDuplicates,

    failItem:
      failAiBacklogJobItem,

    loadChannelId: async (
      env,
      categoryId,
    ) => {
      const row = await env.DB.prepare(`
        SELECT id
        FROM channels
        WHERE category_id = ?
          AND enabled = 1
        LIMIT 1
      `).bind(
        categoryId,
      ).first<{
        id: string;
      }>();

      return row?.id ?? null;
    },

    runJudge:
      runDuplicateAiJudgeForSurvivors,
  };

function parseCandidateItem(
  row: AICandidateRow,
): NormalizedItem | null {
  try {
    const item = JSON.parse(
      row.normalized_item_json,
    ) as NormalizedItem;

    if (
      !item
      || !item.sourceUrl
      || !item.postId
      || !Array.isArray(item.media)
    ) {
      return null;
    }

    return item;
  } catch {
    return null;
  }
}

function parseScore(
  value: string | null,
): AIGateResult | null {
  if (!value) return null;

  try {
    const result = JSON.parse(
      value,
    ) as AIGateResult;

    if (
      !result
      || typeof result.publish
        !== 'boolean'
      || !Number.isFinite(
        Number(result.score),
      )
      || typeof result.topicFingerprint
        !== 'string'
      || !Array.isArray(
        result.riskFlags,
      )
    ) {
      return null;
    }

    return result;
  } catch {
    return null;
  }
}

function parseGate(
  value: string | null,
): GateCheckpointPayload | null {
  if (!value) return null;

  try {
    const result = JSON.parse(
      value,
    ) as GateCheckpointPayload;

    if (
      !result
      || !Object.prototype.hasOwnProperty.call(
        result,
        'rejectReason',
      )
    ) {
      return null;
    }

    return result;
  } catch {
    return null;
  }
}

function completedDuplicateCount(
  items: AIBacklogJobItemRow[],
): number {
  return items.filter(
    item =>
      item.status === 'failed'
      || item.duplicate_result_json
        !== null,
  ).length;
}

function applyDuplicateJudgeResult(
  ai: AIGateResult,
  judge: DuplicateAiJudgeResult,
): AIGateResult {
  return {
    ...ai,
    riskFlags: Array.from(
      new Set([
        ...(ai.riskFlags ?? []),
        'ai_duplicate_judge',
        `ai_duplicate_confidence:${judge.confidence.toFixed(2)}`,
      ]),
    ).slice(0, 10),
  };
}

async function failItem(
  context: AIBacklogStageHandlerContext,
  item: AIBacklogJobItemRow,
  reason: string,
  dependencies:
    AIBacklogDuplicateStageDependencies,
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
      `duplicate_item_fail_rejected:${item.candidate_id}`,
    );
  }
}

export async function runAiBacklogDuplicateStage(
  context: AIBacklogStageHandlerContext,
  dependencies:
    AIBacklogDuplicateStageDependencies =
      DEFAULT_DEPENDENCIES,
): Promise<AIBacklogStageHandlerResult> {
  const initialCompleted =
    completedDuplicateCount(
      context.items,
    );

  if (
    initialCompleted
    === context.items.length
  ) {
    return {
      stageCursor: initialCompleted,
      batchContext: {
        total: context.items.length,
        reused:
          context.items.filter(
            item =>
              item.duplicate_result_json
              !== null,
          ).length,
        checkedNow: 0,
        duplicateRejected: 0,
        gateRejected: 0,
        failed:
          context.items.filter(
            item =>
              item.status === 'failed',
          ).length,
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

  const entries: DuplicateEntry[] = [];
  let completed = initialCompleted;
  let failedNow = 0;

  for (const item of context.items) {
    if (item.status === 'failed') {
      continue;
    }

    const row = candidateById.get(
      item.candidate_id,
    );

    if (!row) {
      if (item.duplicate_result_json) {
        throw new Error(
          `checkpoint_candidate_missing:${item.candidate_id}`,
        );
      }

      await failItem(
        context,
        item,
        'candidate_missing_for_duplicate',
        dependencies,
      );

      completed++;
      failedNow++;
      continue;
    }

    const normalized =
      parseCandidateItem(row);

    if (!normalized) {
      if (item.duplicate_result_json) {
        throw new Error(
          `checkpoint_candidate_invalid:${item.candidate_id}`,
        );
      }

      await failItem(
        context,
        item,
        'invalid_candidate_payload',
        dependencies,
      );

      completed++;
      failedNow++;
      continue;
    }

    const ai = parseScore(
      item.score_result_json,
    );

    if (!ai) {
      if (item.duplicate_result_json) {
        throw new Error(
          `checkpoint_score_invalid:${item.candidate_id}`,
        );
      }

      await failItem(
        context,
        item,
        'score_checkpoint_missing',
        dependencies,
      );

      completed++;
      failedNow++;
      continue;
    }

    const gate = parseGate(
      item.gate_result_json,
    );

    if (!gate) {
      if (item.duplicate_result_json) {
        throw new Error(
          `checkpoint_gate_invalid:${item.candidate_id}`,
        );
      }

      await failItem(
        context,
        item,
        'gate_checkpoint_missing',
        dependencies,
      );

      completed++;
      failedNow++;
      continue;
    }

    entries.push({
      jobItem: item,
      row,
      item: normalized,
      ai,
      gate,
      existing:
        item.duplicate_result_json
        !== null,
    });
  }

  const unresolved =
    entries.filter(
      entry => !entry.existing,
    );

  if (unresolved.length === 0) {
    if (
      completed
      !== context.items.length
    ) {
      throw new Error(
        `duplicate_stage_incomplete:${context.items.length - completed}`,
      );
    }

    return {
      stageCursor: completed,
      batchContext: {
        total: context.items.length,
        reused: entries.length,
        checkedNow: 0,
        duplicateRejected: 0,
        gateRejected: 0,
        failed: failedNow,
      },
    };
  }

  const categoryIds = new Set(
    entries.map(
      entry =>
        entry.row.category_id,
    ),
  );

  if (categoryIds.size !== 1) {
    for (const entry of unresolved) {
      await failItem(
        context,
        entry.jobItem,
        'mixed_candidate_categories',
        dependencies,
      );

      completed++;
      failedNow++;
    }

    if (
      completed
      !== context.items.length
    ) {
      throw new Error(
        'mixed_candidate_categories',
      );
    }

    return {
      stageCursor: completed,
      batchContext: {
        total: context.items.length,
        reused:
          entries.length
          - unresolved.length,
        checkedNow: 0,
        duplicateRejected: 0,
        gateRejected: 0,
        failed: failedNow,
        reason:
          'mixed_candidate_categories',
      },
    };
  }

  const categoryId =
    entries[0]!.row.category_id;

  const allSurvivors =
    entries.filter(
      entry =>
        entry.gate.rejectReason
        === null,
    );

  const unresolvedSurvivors =
    allSurvivors.filter(
      entry => !entry.existing,
    );

  let rejected =
    new Map<
      number,
      DuplicateAiJudgeResult
    >();

  if (unresolvedSurvivors.length > 0) {
    const channelId =
      await dependencies.loadChannelId(
        context.env,
        categoryId,
      );

    rejected =
      await dependencies.runJudge(
        context.env,
        {
          categoryId,
          channelId,
          candidates:
            allSurvivors.map(
              entry => ({
                index:
                  entry.jobItem.ordinal,
                item:
                  entry.item,
                ai:
                  entry.ai,
              }),
            ),
        },
      );
  }

  const checkpoints = unresolved.map(
    entry => {
      if (
        entry.gate.rejectReason
        !== null
      ) {
        const payload:
          DuplicateCheckpointPayload = {
            ai: entry.ai,
            rejected: true,
            rejectReason:
              entry.gate.rejectReason,
            judge: null,
            skippedByGate: true,
          };

        return {
          candidateId:
            entry.jobItem.candidate_id,
          result: payload,
        };
      }

      const judge =
        rejected.get(
          entry.jobItem.ordinal,
        ) ?? null;

      const payload:
        DuplicateCheckpointPayload = {
          ai: judge
            ? applyDuplicateJudgeResult(
                entry.ai,
                judge,
              )
            : entry.ai,
          rejected: judge !== null,
          rejectReason: judge
            ? 'similar_ai_duplicate_recent_channel'
            : null,
          judge,
          skippedByGate: false,
        };

      return {
        candidateId:
          entry.jobItem.candidate_id,
        result: payload,
      };
    },
  );

  const checkpointed =
    await dependencies
      .checkpointDuplicates(
        context.env,
        context.job.id,
        checkpoints,
      );

  if (
    checkpointed
    !== checkpoints.length
  ) {
    throw new Error(
      `duplicate_checkpoint_incomplete:${checkpointed}/${checkpoints.length}`,
    );
  }

  completed += checkpointed;

  if (
    completed
    !== context.items.length
  ) {
    throw new Error(
      `duplicate_stage_incomplete:${context.items.length - completed}`,
    );
  }

  return {
    stageCursor: completed,
    batchContext: {
      total: context.items.length,
      reused:
        entries.length
        - unresolved.length,
      checkedNow: checkpointed,
      duplicateRejected:
        checkpoints.filter(
          checkpoint => {
            const result =
              checkpoint.result as DuplicateCheckpointPayload;

            return result.judge !== null;
          },
        ).length,
      gateRejected:
        checkpoints.filter(
          checkpoint => {
            const result =
              checkpoint.result as DuplicateCheckpointPayload;

            return result.skippedByGate;
          },
        ).length,
      failed: failedNow,
    },
  };
}

export function createAiBacklogDuplicateStageHandler(
  dependencies:
    AIBacklogDuplicateStageDependencies =
      DEFAULT_DEPENDENCIES,
): AIBacklogStageHandler {
  return context =>
    runAiBacklogDuplicateStage(
      context,
      dependencies,
    );
}
