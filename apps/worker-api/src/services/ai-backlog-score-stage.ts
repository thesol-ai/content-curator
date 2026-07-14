import type {
  AICandidateRow,
  AIGateResult,
  AIBacklogJobItemRow,
  CategoryRow,
  ChannelRow,
  Env,
  NormalizedItem,
} from '../types';

import { scoreItems } from './ai-gate';

import {
  checkpointAiBacklogJobScores,
  failAiBacklogJobItem,
  getAiBacklogJobCandidates,
  getAiBacklogJobItems,
  recordAiBacklogProviderFailure,
} from './ai-backlog-jobs';

import type {
  AIBacklogStageHandler,
  AIBacklogStageHandlerContext,
  AIBacklogStageHandlerResult,
} from './ai-backlog-stage-runner';

interface PreparedScoreCandidate {
  row: AICandidateRow;
  item: NormalizedItem;
}

export interface AIBacklogScoreStageDependencies {
  loadCandidates:
    typeof getAiBacklogJobCandidates;
  loadJobItems:
    typeof getAiBacklogJobItems;
  checkpointScores:
    typeof checkpointAiBacklogJobScores;
  failItem:
    typeof failAiBacklogJobItem;
  recordProviderFailure:
    typeof recordAiBacklogProviderFailure;
  loadCategory: (
    env: Env,
    categoryId: string,
  ) => Promise<CategoryRow | null>;
  loadChannels: (
    env: Env,
    categoryId: string,
  ) => Promise<ChannelRow[]>;
  loadWhitelist: (
    env: Env,
    categoryId: string,
  ) => Promise<string[]>;
  score: typeof scoreItems;
}

const DEFAULT_DEPENDENCIES:
  AIBacklogScoreStageDependencies = {
    loadCandidates: getAiBacklogJobCandidates,
    loadJobItems: getAiBacklogJobItems,
    checkpointScores:
      checkpointAiBacklogJobScores,
    failItem: failAiBacklogJobItem,
    recordProviderFailure:
      recordAiBacklogProviderFailure,

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

    loadWhitelist: async (
      env,
      categoryId,
    ) => {
      const rows = await env.DB.prepare(`
        SELECT account_handle
        FROM source_accounts
        WHERE category_id = ?
          AND enabled = 1
          AND trust_level IN ('high', 'medium')
      `).bind(
        categoryId,
      ).all<{
        account_handle: string;
      }>();

      return (rows.results ?? []).map(
        row => row.account_handle,
      );
    },

    score: scoreItems,
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

function providerAttemptLimit(
  env: Env,
): number {
  const parsed = Number.parseInt(
    env.AI_CANDIDATE_MAX_ATTEMPTS ?? '2',
    10,
  );

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 2;
  }

  return Math.max(
    1,
    Math.min(Math.floor(parsed), 20),
  );
}

function resultFlags(
  result: AIGateResult | undefined,
): string[] {
  return Array.isArray(result?.riskFlags)
    ? result.riskFlags.map(String)
    : [];
}

function hasResultFlag(
  result: AIGateResult | undefined,
  expected: string,
): boolean {
  return resultFlags(result).some(
    flag =>
      flag === expected
      || flag.startsWith(`${expected}:`),
  );
}

function isBudgetBlocked(
  result: AIGateResult | undefined,
): boolean {
  return hasResultFlag(
    result,
    'ai_budget_exceeded',
  );
}

function needsProviderRetry(
  result: AIGateResult | undefined,
): boolean {
  if (!result) return true;

  return hasResultFlag(result, 'not_scored')
    || hasResultFlag(result, 'scoring_error');
}

function completedScoreCount(
  items: AIBacklogJobItemRow[],
): number {
  return items.filter(
    item =>
      item.status === 'failed'
      || item.score_result_json !== null,
  ).length;
}

function unresolvedScoreItems(
  items: AIBacklogJobItemRow[],
): AIBacklogJobItemRow[] {
  return items.filter(
    item =>
      item.status !== 'failed'
      && item.score_result_json === null,
  );
}

function errorMessage(
  error: unknown,
): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

async function failPreparedItems(
  context: AIBacklogStageHandlerContext,
  prepared: PreparedScoreCandidate[],
  reason: string,
  dependencies:
    AIBacklogScoreStageDependencies,
): Promise<void> {
  for (const candidate of prepared) {
    await dependencies.failItem(
      context.env,
      context.job.id,
      candidate.row.id,
      reason,
    );
  }
}

async function recordProviderFailures(
  context: AIBacklogStageHandlerContext,
  candidateIds: string[],
  reason: string,
  dependencies:
    AIBacklogScoreStageDependencies,
): Promise<void> {
  const maxAttempts =
    providerAttemptLimit(context.env);

  for (const candidateId of candidateIds) {
    await dependencies.recordProviderFailure(
      context.env,
      context.job.id,
      candidateId,
      reason,
      maxAttempts,
    );
  }
}

export async function runAiBacklogScoreStage(
  context: AIBacklogStageHandlerContext,
  dependencies:
    AIBacklogScoreStageDependencies =
      DEFAULT_DEPENDENCIES,
): Promise<AIBacklogStageHandlerResult> {
  const missingItems =
    unresolvedScoreItems(context.items);

  if (missingItems.length === 0) {
    return {
      stageCursor:
        completedScoreCount(context.items),
      batchContext: {
        total: context.items.length,
        reused: context.items.filter(
          item =>
            item.score_result_json !== null,
        ).length,
        scoredNow: 0,
        failed: context.items.filter(
          item => item.status === 'failed',
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

  const prepared: PreparedScoreCandidate[] = [];
  let invalidCount = 0;

  for (const jobItem of missingItems) {
    const row = candidateById.get(
      jobItem.candidate_id,
    );

    if (!row) {
      await dependencies.failItem(
        context.env,
        context.job.id,
        jobItem.candidate_id,
        'candidate_missing_for_job',
      );

      invalidCount++;
      continue;
    }

    const item = parseCandidateItem(row);

    if (!item) {
      await dependencies.failItem(
        context.env,
        context.job.id,
        row.id,
        'invalid_candidate_payload',
      );

      invalidCount++;
      continue;
    }

    prepared.push({
      row,
      item,
    });
  }

  if (prepared.length === 0) {
    const refreshed =
      await dependencies.loadJobItems(
        context.env,
        context.job.id,
      );

    return {
      stageCursor:
        completedScoreCount(refreshed),
      batchContext: {
        total: refreshed.length,
        reused: 0,
        scoredNow: 0,
        failed: refreshed.filter(
          item => item.status === 'failed',
        ).length,
        invalid: invalidCount,
      },
    };
  }

  const categoryIds = new Set(
    prepared.map(
      candidate =>
        candidate.row.category_id,
    ),
  );

  if (categoryIds.size !== 1) {
    await failPreparedItems(
      context,
      prepared,
      'mixed_candidate_categories',
      dependencies,
    );

    const refreshed =
      await dependencies.loadJobItems(
        context.env,
        context.job.id,
      );

    return {
      stageCursor:
        completedScoreCount(refreshed),
      batchContext: {
        total: refreshed.length,
        reused: 0,
        scoredNow: 0,
        failed: refreshed.filter(
          item => item.status === 'failed',
        ).length,
        invalid: invalidCount,
        reason: 'mixed_candidate_categories',
      },
    };
  }

  const categoryId =
    prepared[0]!.row.category_id;

  const category =
    await dependencies.loadCategory(
      context.env,
      categoryId,
    );

  if (!category) {
    await failPreparedItems(
      context,
      prepared,
      'category_not_found',
      dependencies,
    );

    const refreshed =
      await dependencies.loadJobItems(
        context.env,
        context.job.id,
      );

    return {
      stageCursor:
        completedScoreCount(refreshed),
      batchContext: {
        total: refreshed.length,
        reused: 0,
        scoredNow: 0,
        failed: refreshed.filter(
          item => item.status === 'failed',
        ).length,
        invalid: invalidCount,
        reason: 'category_not_found',
      },
    };
  }

  const channels =
    await dependencies.loadChannels(
      context.env,
      categoryId,
    );

  const whitelist =
    await dependencies.loadWhitelist(
      context.env,
      categoryId,
    );

  const attributionItems = prepared.map(
    candidate => ({
      sourceAccount:
        candidate.item.sourceAccount,
      sourceId:
        candidate.row.source_id ?? null,
      candidateId:
        candidate.row.id,
      discoveryItemId:
        `candidate_${candidate.row.id}`,
      channelId:
        channels[0]?.id ?? null,
    }),
  );

  let results: AIGateResult[];

  try {
    results = await dependencies.score(
      context.env,
      prepared.map(
        candidate => candidate.item,
      ),
      category,
      whitelist,
      channels,
      attributionItems,
    );
  } catch (error) {
    const message = errorMessage(error);

    await recordProviderFailures(
      context,
      prepared.map(
        candidate => candidate.row.id,
      ),
      `scoring_error:${message}`,
      dependencies,
    );

    const refreshed =
      await dependencies.loadJobItems(
        context.env,
        context.job.id,
      );

    const unresolved =
      unresolvedScoreItems(refreshed);

    if (unresolved.length > 0) {
      throw new Error(
        `scoring_error_retry:${message}`,
      );
    }

    return {
      stageCursor:
        completedScoreCount(refreshed),
      batchContext: {
        total: refreshed.length,
        reused: 0,
        scoredNow: 0,
        failed: refreshed.filter(
          item => item.status === 'failed',
        ).length,
        invalid: invalidCount,
        providerError: message,
      },
    };
  }

  const checkpoints: Array<{
    candidateId: string;
    result: AIGateResult;
  }> = [];

  const retryCandidates: Array<{
    candidateId: string;
    reason: string;
  }> = [];

  const budgetBlockedIds: string[] = [];

  for (
    let index = 0;
    index < prepared.length;
    index++
  ) {
    const candidate = prepared[index]!;
    const result = results[index];

    if (isBudgetBlocked(result)) {
      budgetBlockedIds.push(
        candidate.row.id,
      );
      continue;
    }

    if (needsProviderRetry(result)) {
      retryCandidates.push({
        candidateId:
          candidate.row.id,
        reason: result
          ? `scoring_incomplete:${resultFlags(
              result,
            ).join(',') || 'unknown'}`
          : 'scoring_result_missing',
      });

      continue;
    }

    checkpoints.push({
      candidateId:
        candidate.row.id,
      result: result!,
    });
  }

  const checkpointed =
    await dependencies.checkpointScores(
      context.env,
      context.job.id,
      checkpoints,
    );

  if (checkpointed !== checkpoints.length) {
    throw new Error(
      `score_checkpoint_incomplete:${checkpointed}/${checkpoints.length}`,
    );
  }

  for (const retry of retryCandidates) {
    await dependencies.recordProviderFailure(
      context.env,
      context.job.id,
      retry.candidateId,
      retry.reason,
      providerAttemptLimit(context.env),
    );
  }

  const refreshed =
    await dependencies.loadJobItems(
      context.env,
      context.job.id,
    );

  if (budgetBlockedIds.length > 0) {
    throw new Error(
      `ai_budget_exceeded:${budgetBlockedIds.length}`,
    );
  }

  const unresolved =
    unresolvedScoreItems(refreshed);

  if (unresolved.length > 0) {
    throw new Error(
      `score_stage_incomplete:${unresolved.length}`,
    );
  }

  return {
    stageCursor:
      completedScoreCount(refreshed),
    batchContext: {
      total: refreshed.length,
      reused:
        context.items.filter(
          item =>
            item.score_result_json !== null,
        ).length,
      scoredNow: checkpointed,
      failed: refreshed.filter(
        item => item.status === 'failed',
      ).length,
      invalid: invalidCount,
    },
  };
}

export function createAiBacklogScoreStageHandler(
  dependencies:
    AIBacklogScoreStageDependencies =
      DEFAULT_DEPENDENCIES,
): AIBacklogStageHandler {
  return context =>
    runAiBacklogScoreStage(
      context,
      dependencies,
    );
}
