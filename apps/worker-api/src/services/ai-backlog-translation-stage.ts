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
  attachTranslations,
} from './ai-gate';

import {
  getRssBriefPreflightRejectReason,
} from './backlog-drain';

import type {
  DuplicateCheckpointPayload,
} from './ai-backlog-duplicate-stage';

import {
  checkpointAiBacklogJobTranslations,
  failAiBacklogJobItem,
  getAiBacklogJobCandidates,
  recordAiBacklogTranslationFailure,
} from './ai-backlog-jobs';

import {
  enrichAndBriefRssSurvivors,
} from './rss-brief';

import type {
  AIBacklogStageHandler,
  AIBacklogStageHandlerContext,
  AIBacklogStageHandlerResult,
} from './ai-backlog-stage-runner';

export type TranslationCheckpointMode =
  | 'skipped'
  | 'translation'
  | 'rss_brief';

export interface TranslationCheckpointPayload {
  ai: AIGateResult;
  rejected: boolean;
  rejectReason: string | null;
  skipped: boolean;
  mode: TranslationCheckpointMode;
}

interface ParsedCandidate {
  row: AICandidateRow;
  item: NormalizedItem;
  keys: string[];
}

interface TranslationEntry {
  jobItem: AIBacklogJobItemRow;
  candidate: ParsedCandidate;
  decision: DuplicateCheckpointPayload;
}

export interface AIBacklogTranslationStageDependencies {
  loadCandidates:
    typeof getAiBacklogJobCandidates;

  checkpointTranslations:
    typeof checkpointAiBacklogJobTranslations;

  failItem:
    typeof failAiBacklogJobItem;

  recordFailure:
    typeof recordAiBacklogTranslationFailure;

  now: () => number;

  loadCategory: (
    env: Env,
    categoryId: string,
  ) => Promise<CategoryRow | null>;

  loadChannels: (
    env: Env,
    categoryId: string,
  ) => Promise<ChannelRow[]>;

  translate:
    typeof attachTranslations;

  briefRss:
    typeof enrichAndBriefRssSurvivors;

  preflightRss:
    typeof getRssBriefPreflightRejectReason;
}

const DEFAULT_DEPENDENCIES:
  AIBacklogTranslationStageDependencies = {
    loadCandidates:
      getAiBacklogJobCandidates,

    checkpointTranslations:
      checkpointAiBacklogJobTranslations,

    failItem:
      failAiBacklogJobItem,

    recordFailure:
      recordAiBacklogTranslationFailure,

    now:
      Date.now,

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

    translate:
      attachTranslations,

    briefRss:
      enrichAndBriefRssSurvivors,

    preflightRss:
      getRssBriefPreflightRejectReason,
  };

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

function parseDuplicateDecision(
  value: string | null,
): DuplicateCheckpointPayload | null {
  if (!value) return null;

  try {
    const decision = JSON.parse(
      value,
    ) as DuplicateCheckpointPayload;

    if (
      !decision
      || !isAiResult(decision.ai)
      || typeof decision.rejected
        !== 'boolean'
      || !Object.prototype.hasOwnProperty.call(
        decision,
        'rejectReason',
      )
    ) {
      return null;
    }

    return decision;
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
      || ![
        'skipped',
        'translation',
        'rss_brief',
      ].includes(checkpoint.mode)
    ) {
      return null;
    }

    return checkpoint;
  } catch {
    return null;
  }
}

function errorMessage(
  error: unknown,
): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

export function isRetryableTranslationResult(
  result: AIGateResult,
): boolean {
  const flags = Array.isArray(
    result.riskFlags,
  )
    ? result.riskFlags.map(String)
    : [];

  const missingFlag = flags.some(
    flag =>
      flag === 'translation_missing'
      || flag.startsWith(
        'translation_missing:',
      ),
  );

  const hasTranslations =
    Object.keys(
      result.translations ?? {},
    ).length > 0;

  const terminalReason =
    typeof result.translationTerminalReason
      === 'string'
    && result.translationTerminalReason
      .trim().length > 0;

  return (
    !terminalReason
    && (
      missingFlag
      || !hasTranslations
    )
  );
}

export function getAiBacklogTranslationMaxFailures(
  env: Env,
): number {
  const parsed = Number.parseInt(
    env.AI_BACKLOG_TRANSLATION_MAX_FAILURES
    ?? '3',
    10,
  );

  if (
    !Number.isFinite(parsed)
    || parsed <= 0
  ) {
    return 3;
  }

  return Math.max(
    1,
    Math.min(
      Math.floor(parsed),
      20,
    ),
  );
}

export function getAiBacklogTranslationRetrySeconds(
  env: Env,
  failureCount: number,
  deferred = false,
): number {
  const parsedBase = Number.parseInt(
    env.AI_BACKLOG_TRANSLATION_RETRY_BASE_SECONDS
    ?? '60',
    10,
  );

  const parsedMax = Number.parseInt(
    env.AI_BACKLOG_TRANSLATION_RETRY_MAX_SECONDS
    ?? '3600',
    10,
  );

  const base =
    Number.isFinite(parsedBase)
    && parsedBase > 0
      ? Math.max(
          10,
          Math.min(
            Math.floor(parsedBase),
            3600,
          ),
        )
      : 60;

  const maximum =
    Number.isFinite(parsedMax)
    && parsedMax > 0
      ? Math.max(
          base,
          Math.min(
            Math.floor(parsedMax),
            21600,
          ),
        )
      : 3600;

  const exponent = Math.max(
    0,
    Math.min(
      Math.floor(failureCount) - 1,
      10,
    ),
  );

  const normalRetry = Math.min(
    maximum,
    base * Math.pow(
      2,
      exponent,
    ),
  );

  if (deferred) {
    return Math.max(
      normalRetry,
      Math.min(
        maximum,
        3600,
      ),
    );
  }

  return normalRetry;
}

async function failItem(
  context: AIBacklogStageHandlerContext,
  item: AIBacklogJobItemRow,
  reason: string,
  dependencies:
    AIBacklogTranslationStageDependencies,
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
      `translation_item_fail_rejected:${item.candidate_id}`,
    );
  }
}

async function checkpointBatch(
  context: AIBacklogStageHandlerContext,
  checkpoints: Array<{
    candidateId: string;
    result: TranslationCheckpointPayload;
  }>,
  dependencies:
    AIBacklogTranslationStageDependencies,
): Promise<number> {
  if (checkpoints.length === 0) {
    return 0;
  }

  const checkpointed =
    await dependencies
      .checkpointTranslations(
        context.env,
        context.job.id,
        checkpoints,
      );

  if (
    checkpointed
    !== checkpoints.length
  ) {
    throw new Error(
      `translation_checkpoint_incomplete:${checkpointed}/${checkpoints.length}`,
    );
  }

  return checkpointed;
}

function buildSkippedCheckpoint(
  entry: TranslationEntry,
  rejectReason:
    string | null = null,
): {
  candidateId: string;
  result: TranslationCheckpointPayload;
} {
  return {
    candidateId:
      entry.jobItem.candidate_id,

    result: {
      ai:
        entry.decision.ai,
      rejected: true,
      rejectReason:
        rejectReason
        ?? entry.decision.rejectReason
        ?? 'rejected_before_translation',
      skipped: true,
      mode: 'skipped',
    },
  };
}

function buildTranslatedCheckpoint(
  entry: TranslationEntry,
  ai: AIGateResult,
  mode:
    Exclude<
      TranslationCheckpointMode,
      'skipped'
    >,
): {
  candidateId: string;
  result: TranslationCheckpointPayload;
} {
  return {
    candidateId:
      entry.jobItem.candidate_id,

    result: {
      ai,
      rejected: false,
      rejectReason: null,
      skipped: false,
      mode,
    },
  };
}

export async function runAiBacklogTranslationStage(
  context: AIBacklogStageHandlerContext,
  dependencies:
    AIBacklogTranslationStageDependencies =
      DEFAULT_DEPENDENCIES,
): Promise<AIBacklogStageHandlerResult> {
  let completed = 0;
  let reused = 0;
  let failedNow = 0;

  const unresolvedItems:
    AIBacklogJobItemRow[] = [];

  for (const item of context.items) {
    if (item.status === 'failed') {
      completed++;
      continue;
    }

    if (
      item.translation_result_json
      !== null
    ) {
      const checkpoint =
        parseTranslationCheckpoint(
          item.translation_result_json,
        );

      if (!checkpoint) {
        throw new Error(
          `translation_checkpoint_invalid:${item.candidate_id}`,
        );
      }

      completed++;
      reused++;
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
        translatedNow: 0,
        skippedNow: 0,
        preflightRejected: 0,
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

  const entries:
    TranslationEntry[] = [];

  for (const jobItem of unresolvedItems) {
    const row = candidateById.get(
      jobItem.candidate_id,
    );

    if (!row) {
      await failItem(
        context,
        jobItem,
        'candidate_missing_for_translation',
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

    const decision =
      parseDuplicateDecision(
        jobItem.duplicate_result_json,
      );

    if (!decision) {
      await failItem(
        context,
        jobItem,
        'duplicate_checkpoint_missing',
        dependencies,
      );

      completed++;
      failedNow++;
      continue;
    }

    entries.push({
      jobItem,
      candidate,
      decision,
    });
  }

  if (entries.length === 0) {
    if (
      completed
      !== context.items.length
    ) {
      throw new Error(
        `translation_stage_incomplete:${context.items.length - completed}`,
      );
    }

    return {
      stageCursor: completed,
      batchContext: {
        total: context.items.length,
        reused,
        translatedNow: 0,
        skippedNow: 0,
        preflightRejected: 0,
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
        translatedNow: 0,
        skippedNow: 0,
        preflightRejected: 0,
        failed: failedNow,
        reason:
          'mixed_candidate_categories',
      },
    };
  }

  const categoryId =
    entries[0]!.candidate.row.category_id;

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
        translatedNow: 0,
        skippedNow: 0,
        preflightRejected: 0,
        failed: failedNow,
        reason: 'category_not_found',
      },
    };
  }

  const channels =
    await dependencies.loadChannels(
      context.env,
      categoryId,
    );

  let skippedNow = 0;
  let translatedNow = 0;
  let preflightRejected = 0;

  const rejectedEntries =
    entries.filter(
      entry =>
        entry.decision.rejected
        || entry.decision.rejectReason
          !== null,
    );

  const rejectedCheckpoints =
    rejectedEntries.map(
      entry =>
        buildSkippedCheckpoint(entry),
    );

  completed += await checkpointBatch(
    context,
    rejectedCheckpoints,
    dependencies,
  );

  skippedNow +=
    rejectedCheckpoints.length;

  const survivors =
    entries.filter(
      entry =>
        !entry.decision.rejected
        && entry.decision.rejectReason
          === null,
    );

  const nonRss =
    survivors.filter(
      entry =>
        entry.candidate.item.platform
        !== 'rss',
    );

  const rssCandidates =
    survivors.filter(
      entry =>
        entry.candidate.item.platform
        === 'rss',
    );

  const retryFailures = new Map<
    string,
    {
      entry: TranslationEntry;
      reason: string;
    }
  >();

  let deferredRetry = false;

  let deferredReason:
    string | null = null;

  const addRetryFailure = (
    entry: TranslationEntry,
    reason: string,
  ): void => {
    const candidateId =
      entry.jobItem.candidate_id;

    if (
      retryFailures.has(
        candidateId,
      )
    ) {
      return;
    }

    retryFailures.set(
      candidateId,
      {
        entry,
        reason:
          String(
            reason ?? '',
          ).slice(
            0,
            500,
          ),
      },
    );
  };

  if (nonRss.length > 0) {
    try {
      const translated =
        await dependencies.translate(
          context.env,
          nonRss.map(
            entry =>
              entry.candidate.item,
          ),
          nonRss.map(
            entry =>
              entry.decision.ai,
          ),
          category,
          channels,
          nonRss.map(
            entry => ({
              sourceAccount:
                entry.candidate.item
                  .sourceAccount,
              sourceId:
                entry.candidate.row
                  .source_id
                ?? null,
              candidateId:
                entry.candidate.row.id,
              discoveryItemId:
                `candidate_${entry.candidate.row.id}`,
              channelId:
                channels[0]?.id
                ?? null,
            }),
          ),
        );

      if (
        translated.length
        !== nonRss.length
      ) {
        throw new Error(
          `translation_result_count_mismatch:${translated.length}/${nonRss.length}`,
        );
      }

      const checkpoints:
        Array<{
          candidateId: string;
          result:
            TranslationCheckpointPayload;
        }> = [];

      nonRss.forEach(
        (entry, index) => {
          const translatedResult =
            translated[index]!;

          if (
            isRetryableTranslationResult(
              translatedResult,
            )
          ) {
            addRetryFailure(
              entry,
              'translation_missing_after_provider',
            );

            return;
          }

          checkpoints.push(
            buildTranslatedCheckpoint(
              entry,
              translatedResult,
              'translation',
            ),
          );
        },
      );

      const count =
        await checkpointBatch(
          context,
          checkpoints,
          dependencies,
        );

      completed += count;
      translatedNow += count;
    } catch (error) {
      const reason =
        `translation_error:${errorMessage(error)}`;

      for (
        const entry
        of nonRss
      ) {
        addRetryFailure(
          entry,
          reason,
        );
      }
    }
  }

  const rssBriefable:
    TranslationEntry[] = [];

  const rssPreflightCheckpoints:
    Array<{
      candidateId: string;
      result:
        TranslationCheckpointPayload;
    }> = [];

  for (const entry of rssCandidates) {
    try {
      const rejectReason =
        await dependencies.preflightRss(
          context.env,
          channels,
          entry.candidate,
          entry.decision.ai,
        );

      if (rejectReason) {
        rssPreflightCheckpoints.push(
          buildSkippedCheckpoint(
            entry,
            rejectReason,
          ),
        );

        preflightRejected++;
      } else {
        rssBriefable.push(entry);
      }
    } catch (error) {
      addRetryFailure(
        entry,
        `rss_preflight_error:${errorMessage(error)}`,
      );
    }
  }

  const preflightCount =
    await checkpointBatch(
      context,
      rssPreflightCheckpoints,
      dependencies,
    );

  completed += preflightCount;
  skippedNow += preflightCount;

  if (rssBriefable.length > 0) {
    try {
      const outcome =
        await dependencies.briefRss(
          context.env,
          rssBriefable.map(
            entry =>
              entry.candidate.item,
          ),
          rssBriefable.map(
            entry =>
              entry.decision.ai,
          ),
          category,
          channels,
          rssBriefable.map(
            entry =>
              entry.candidate.item
                .sourceAccount,
          ),
        );

      if (
        outcome.results.length
        !== rssBriefable.length
      ) {
        throw new Error(
          `rss_result_count_mismatch:${outcome.results.length}/${rssBriefable.length}`,
        );
      }

      const failedIndexes =
        new Set(
          outcome.failedIndexes,
        );

      const deferredIndexes =
        new Set(
          outcome.capDeferredIndexes,
        );

      const successfulCheckpoints =
        rssBriefable.flatMap(
          (entry, index) => {
            if (
              failedIndexes.has(index)
              || deferredIndexes.has(index)
            ) {
              return [];
            }

            return [
              buildTranslatedCheckpoint(
                entry,
                outcome.results[index]!,
                'rss_brief',
              ),
            ];
          },
        );

      const count =
        await checkpointBatch(
          context,
          successfulCheckpoints,
          dependencies,
        );

      completed += count;
      translatedNow += count;

      if (failedIndexes.size > 0) {
        for (
          const index
          of failedIndexes
        ) {
          const entry =
            rssBriefable[index];

          if (!entry) continue;

          addRetryFailure(
            entry,
            'rss_brief_unavailable',
          );
        }
      }

      if (deferredIndexes.size > 0) {
        deferredRetry = true;

        deferredReason =
          `rss_brief_daily_cap:${deferredIndexes.size}`;
      }
    } catch (error) {
      const reason =
        `rss_brief_error:${errorMessage(error)}`;

      for (
        const entry
        of rssBriefable
      ) {
        addRetryFailure(
          entry,
          reason,
        );
      }
    }
  }

  let retryableCount = 0;

  let highestFailureCount = 0;

  const retryReasons =
    new Set<string>();

  for (
    const {
      entry,
      reason,
    }
    of retryFailures.values()
  ) {
    const outcome =
      await dependencies.recordFailure(
        context.env,
        context.job.id,
        entry.jobItem.candidate_id,
        reason,
        getAiBacklogTranslationMaxFailures(
          context.env,
        ),
      );

    if (
      !outcome.updated
      && !outcome.failed
    ) {
      throw new Error(
        `translation_failure_accounting_rejected:${entry.jobItem.candidate_id}`,
      );
    }

    retryReasons.add(
      reason,
    );

    if (outcome.failed) {
      completed++;
      failedNow++;
      continue;
    }

    retryableCount++;

    highestFailureCount =
      Math.max(
        highestFailureCount,
        outcome.failures,
      );
  }

  if (
    retryableCount > 0
    || deferredRetry
  ) {
    const retrySeconds =
      getAiBacklogTranslationRetrySeconds(
        context.env,
        Math.max(
          1,
          highestFailureCount,
        ),
        deferredRetry,
      );

    const retryAtMs =
      dependencies.now()
      + retrySeconds * 1000;

    const reason = [
      retryableCount > 0
        ? `translation_retry:${retryableCount}`
        : null,
      deferredReason,
      ...retryReasons,
    ]
      .filter(Boolean)
      .join('|')
      .slice(0, 500);

    throw new Error(
      `stage_retry_at_ms:${retryAtMs}:${reason}`,
    );
  }

  if (
    completed
    !== context.items.length
  ) {
    throw new Error(
      `translation_stage_incomplete:${context.items.length - completed}`,
    );
  }

  return {
    stageCursor: completed,
    batchContext: {
      total: context.items.length,
      reused,
      translatedNow,
      skippedNow,
      preflightRejected,
      failed: failedNow,
    },
  };
}

export function createAiBacklogTranslationStageHandler(
  dependencies:
    AIBacklogTranslationStageDependencies =
      DEFAULT_DEPENDENCIES,
): AIBacklogStageHandler {
  return context =>
    runAiBacklogTranslationStage(
      context,
      dependencies,
    );
}
