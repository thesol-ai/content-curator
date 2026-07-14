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
  emptyPublishQueueStarvationSnapshot,
  evaluateCandidateDb,
  getPublishQueueStarvationSnapshot,
  getWeakPostAiGateOverrideScoreMargin,
  isWeakPostAiGateOverrideEnabled,
  maybeOverrideSoftEditorialReject,
  resolveCandidateRejectReason,
  type CandidateEvaluation,
  type PublishQueueStarvationSnapshot,
} from './backlog-drain';

import {
  checkpointAiBacklogJobItem,
  failAiBacklogJobItem,
  getAiBacklogJobCandidates,
} from './ai-backlog-jobs';

import {
  findSimilarTopicInRunRejections,
} from './content-policy';

import {
  getCryptoThemeDailyCap,
} from './story-quality-guard';

import {
  isFollowUpEventType,
  isSemanticStoryHeuristicRejectEnabled,
  isStoryFollowupAllowEnabled,
  isStoryIntelligenceRejectActive,
  shouldRejectBySemanticStorySimilarity,
} from './story-intelligence';

import type {
  AIBacklogStageHandler,
  AIBacklogStageHandlerContext,
  AIBacklogStageHandlerResult,
} from './ai-backlog-stage-runner';

interface ParsedCandidate {
  row: AICandidateRow;
  item: NormalizedItem;
  keys: string[];
}

interface GateCheckpointPayload {
  evaluation: CandidateEvaluation;
  rejectReason: string | null;
  similarTopicRejected: boolean;
}

interface GateEntry {
  jobItem: AIBacklogJobItemRow;
  candidate: ParsedCandidate;
  ai: AIGateResult;
  existingGate: GateCheckpointPayload | null;
}

interface SemanticSeen {
  storyKey: string | null;
  fields: AIGateResult['storyFields'] | null;
  topicFingerprint: string | null;
  eventType: string | null;
  text: string | null;
}

export interface AIBacklogGateStageDependencies {
  loadCandidates:
    typeof getAiBacklogJobCandidates;

  checkpointGate:
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

  evaluateCandidate:
    typeof evaluateCandidateDb;

  resolveReject:
    typeof resolveCandidateRejectReason;

  overrideReject:
    typeof maybeOverrideSoftEditorialReject;

  loadQueueSnapshot: (
    env: Env,
    channels: ChannelRow[],
  ) => Promise<PublishQueueStarvationSnapshot>;

  findSimilarTopicRejects:
    typeof findSimilarTopicInRunRejections;
}

const DEFAULT_DEPENDENCIES:
  AIBacklogGateStageDependencies = {
    loadCandidates:
      getAiBacklogJobCandidates,

    checkpointGate:
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

    evaluateCandidate:
      evaluateCandidateDb,

    resolveReject:
      resolveCandidateRejectReason,

    overrideReject:
      maybeOverrideSoftEditorialReject,

    loadQueueSnapshot:
      getPublishQueueStarvationSnapshot,

    findSimilarTopicRejects:
      findSimilarTopicInRunRejections,
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

function parseScore(
  value: string | null,
): AIGateResult | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(
      value,
    ) as AIGateResult;

    if (
      !parsed
      || typeof parsed.publish !== 'boolean'
      || !Number.isFinite(
        Number(parsed.score),
      )
      || typeof parsed.topicFingerprint
        !== 'string'
      || !Array.isArray(parsed.riskFlags)
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function parseGate(
  value: string | null,
): GateCheckpointPayload | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(
      value,
    ) as GateCheckpointPayload;

    if (
      !parsed
      || !parsed.evaluation
      || !Object.prototype.hasOwnProperty.call(
        parsed,
        'rejectReason',
      )
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function normalizeFingerprint(
  value: unknown,
): string | null {
  const fingerprint = String(
    value ?? '',
  )
    .trim()
    .toLowerCase();

  if (!fingerprint) return null;

  if (
    fingerprint.startsWith('ns-')
    || fingerprint.startsWith('fp-')
    || fingerprint.startsWith('err-')
    || fingerprint.startsWith('budget-')
  ) {
    return null;
  }

  return fingerprint;
}

function completedGateCount(
  items: AIBacklogJobItemRow[],
): number {
  return items.filter(
    item =>
      item.status === 'failed'
      || item.gate_result_json !== null,
  ).length;
}

function addAcceptedDecision(
  entry: GateEntry,
  evaluation: CandidateEvaluation,
  seenFingerprints: Set<string>,
  seenStoryClusters: Set<string>,
  seenStoryKeys: Set<string>,
  seenSemanticStories: SemanticSeen[],
  themeBatchCounts: Map<string, number>,
): void {
  const fingerprint = normalizeFingerprint(
    entry.ai.topicFingerprint,
  );

  if (fingerprint) {
    seenFingerprints.add(
      fingerprint,
    );
  }

  if (evaluation.storyClusterKey) {
    seenStoryClusters.add(
      evaluation.storyClusterKey,
    );
  }

  if (evaluation.storyKey) {
    seenStoryKeys.add(
      evaluation.storyKey,
    );
  }

  seenSemanticStories.push({
    storyKey:
      evaluation.storyKey,
    fields:
      entry.ai.storyFields ?? null,
    topicFingerprint:
      entry.ai.topicFingerprint ?? null,
    eventType:
      entry.ai.storyFields?.eventType
      ?? null,
    text:
      entry.candidate.item.text ?? null,
  });

  if (evaluation.themeKey) {
    themeBatchCounts.set(
      evaluation.themeKey,
      (
        themeBatchCounts.get(
          evaluation.themeKey,
        ) ?? 0
      ) + 1,
    );
  }
}

async function failJobItem(
  context: AIBacklogStageHandlerContext,
  jobItem: AIBacklogJobItemRow,
  reason: string,
  dependencies:
    AIBacklogGateStageDependencies,
): Promise<void> {
  const failed = await dependencies.failItem(
    context.env,
    context.job.id,
    jobItem.candidate_id,
    reason,
  );

  if (!failed) {
    throw new Error(
      `gate_item_fail_rejected:${jobItem.candidate_id}`,
    );
  }
}

export async function runAiBacklogGateStage(
  context: AIBacklogStageHandlerContext,
  dependencies:
    AIBacklogGateStageDependencies =
      DEFAULT_DEPENDENCIES,
): Promise<AIBacklogStageHandlerResult> {
  const initialCompleted =
    completedGateCount(context.items);

  if (
    initialCompleted
    === context.items.length
  ) {
    return {
      stageCursor: initialCompleted,
      batchContext: {
        total: context.items.length,
        reused: context.items.filter(
          item =>
            item.gate_result_json
            !== null,
        ).length,
        gatedNow: 0,
        failed: context.items.filter(
          item =>
            item.status === 'failed',
        ).length,
      },
    };
  }

  const rows =
    await dependencies.loadCandidates(
      context.env,
      context.job.id,
    );

  const candidateById = new Map(
    rows.map(
      row => [row.id, row],
    ),
  );

  const entries: GateEntry[] = [];
  let completed = initialCompleted;
  let invalid = 0;

  for (const jobItem of context.items) {
    if (jobItem.status === 'failed') {
      continue;
    }

    const row = candidateById.get(
      jobItem.candidate_id,
    );

    if (!row) {
      if (jobItem.gate_result_json) {
        throw new Error(
          `checkpoint_candidate_missing:${jobItem.candidate_id}`,
        );
      }

      await failJobItem(
        context,
        jobItem,
        'candidate_missing_for_gate',
        dependencies,
      );

      completed++;
      invalid++;
      continue;
    }

    const candidate =
      parseCandidate(row);

    if (!candidate) {
      if (jobItem.gate_result_json) {
        throw new Error(
          `checkpoint_candidate_invalid:${jobItem.candidate_id}`,
        );
      }

      await failJobItem(
        context,
        jobItem,
        'invalid_candidate_payload',
        dependencies,
      );

      completed++;
      invalid++;
      continue;
    }

    const ai = parseScore(
      jobItem.score_result_json,
    );

    if (!ai) {
      if (jobItem.gate_result_json) {
        throw new Error(
          `checkpoint_score_invalid:${jobItem.candidate_id}`,
        );
      }

      await failJobItem(
        context,
        jobItem,
        'score_checkpoint_missing',
        dependencies,
      );

      completed++;
      invalid++;
      continue;
    }

    const existingGate = parseGate(
      jobItem.gate_result_json,
    );

    if (
      jobItem.gate_result_json
      && !existingGate
    ) {
      throw new Error(
        `gate_checkpoint_invalid:${jobItem.candidate_id}`,
      );
    }

    entries.push({
      jobItem,
      candidate,
      ai,
      existingGate,
    });
  }

  if (entries.length === 0) {
    if (completed !== context.items.length) {
      throw new Error(
        `gate_stage_incomplete:${context.items.length - completed}`,
      );
    }

    return {
      stageCursor: completed,
      batchContext: {
        total: context.items.length,
        reused: 0,
        gatedNow: 0,
        failed: completed,
        invalid,
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
      if (entry.existingGate) continue;

      await failJobItem(
        context,
        entry.jobItem,
        'mixed_candidate_categories',
        dependencies,
      );

      completed++;
    }

    if (completed !== context.items.length) {
      throw new Error(
        'mixed_candidate_categories',
      );
    }

    return {
      stageCursor: completed,
      batchContext: {
        total: context.items.length,
        reused: entries.filter(
          entry => entry.existingGate,
        ).length,
        gatedNow: 0,
        failed: completed,
        invalid,
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
      if (entry.existingGate) continue;

      await failJobItem(
        context,
        entry.jobItem,
        'category_not_found',
        dependencies,
      );

      completed++;
    }

    if (completed !== context.items.length) {
      throw new Error(
        'category_not_found',
      );
    }

    return {
      stageCursor: completed,
      batchContext: {
        total: context.items.length,
        reused: entries.filter(
          entry => entry.existingGate,
        ).length,
        gatedNow: 0,
        failed: completed,
        invalid,
        reason: 'category_not_found',
      },
    };
  }

  const channels =
    await dependencies.loadChannels(
      context.env,
      categoryId,
    );

  const similarTopicRejects =
    channels.some(
      channel =>
        channel.semantic_dedupe_enabled
        !== 0,
    )
      ? dependencies.findSimilarTopicRejects(
          entries.map(
            entry =>
              entry.candidate.item,
          ),
          entries.map(
            entry => entry.ai,
          ),
          category.score_threshold,
        )
      : new Set<number>();

  const weakOverrideEnabled =
    isWeakPostAiGateOverrideEnabled(
      context.env,
    );

  const queueSnapshot =
    weakOverrideEnabled
      ? await dependencies.loadQueueSnapshot(
          context.env,
          channels,
        )
      : emptyPublishQueueStarvationSnapshot();

  const weakOverrideMargin =
    getWeakPostAiGateOverrideScoreMargin(
      context.env,
    );

  const seenFingerprints =
    new Set<string>();

  const seenStoryClusters =
    new Set<string>();

  const seenStoryKeys =
    new Set<string>();

  const seenSemanticStories:
    SemanticSeen[] = [];

  const themeBatchCounts =
    new Map<string, number>();

  let gatedNow = 0;
  let reused = 0;
  let rejectedNow = 0;
  let rejectedReused = 0;

  for (
    let index = 0;
    index < entries.length;
    index++
  ) {
    const entry = entries[index]!;

    if (entry.existingGate) {
      reused++;

      if (
        entry.existingGate.rejectReason
        === null
      ) {
        addAcceptedDecision(
          entry,
          entry.existingGate.evaluation,
          seenFingerprints,
          seenStoryClusters,
          seenStoryKeys,
          seenSemanticStories,
          themeBatchCounts,
        );
      } else {
        rejectedReused++;
      }

      continue;
    }

    const evaluation =
      await dependencies.evaluateCandidate(
        context.env,
        channels,
        entry.candidate,
        entry.ai,
      );

    const fingerprint =
      normalizeFingerprint(
        entry.ai.topicFingerprint,
      );

    if (
      !evaluation.recentTopicDuplicate
      && fingerprint
      && seenFingerprints.has(
        fingerprint,
      )
    ) {
      evaluation.recentTopicDuplicate =
        true;
    }

    if (
      !evaluation
        .recentStoryClusterDuplicate
      && evaluation.storyClusterKey
      && seenStoryClusters.has(
        evaluation.storyClusterKey,
      )
    ) {
      evaluation
        .recentStoryClusterDuplicate =
        true;
    }

    if (
      !evaluation.storyKeyRejectReason
      && evaluation.storyKey
      && isStoryIntelligenceRejectActive(
        context.env,
      )
      && seenStoryKeys.has(
        evaluation.storyKey,
      )
      && !(
        isStoryFollowupAllowEnabled(
          context.env,
        )
        && isFollowUpEventType(
          entry.ai.storyFields?.eventType,
        )
      )
    ) {
      evaluation.storyKeyRejectReason =
        'similar_story_key_recent_channel';
    }

    if (
      !evaluation.storyKeyRejectReason
      && isStoryIntelligenceRejectActive(
        context.env,
      )
      && isSemanticStoryHeuristicRejectEnabled(
        context.env,
      )
    ) {
      const current = {
        storyKey:
          evaluation.storyKey,
        fields:
          entry.ai.storyFields ?? null,
        topicFingerprint:
          entry.ai.topicFingerprint
          ?? null,
        eventType:
          entry.ai.storyFields
            ?.eventType
          ?? null,
        text:
          entry.candidate.item.text
          ?? null,
      };

      for (
        const prior
        of seenSemanticStories
      ) {
        if (
          shouldRejectBySemanticStorySimilarity({
            rejectEnabled: true,
            current,
            prior,
            followupAllowEnabled:
              isStoryFollowupAllowEnabled(
                context.env,
              ),
          })
        ) {
          evaluation.storyKeyRejectReason =
            'similar_semantic_story_recent_batch';
          break;
        }
      }
    }

    if (
      !evaluation.themeCapRejectReason
      && evaluation.themeKey
    ) {
      const cap =
        getCryptoThemeDailyCap(
          evaluation.themeKey,
          context.env,
        );

      if (
        cap != null
        && (
          themeBatchCounts.get(
            evaluation.themeKey,
          ) ?? 0
        ) >= cap
      ) {
        evaluation.themeCapRejectReason =
          `theme_daily_cap:${evaluation.themeKey}`;
      }
    }

    let rejectReason =
      dependencies.resolveReject(
        evaluation,
        entry.ai,
        category,
        entry.candidate.item,
        similarTopicRejects.has(index),
      );

    rejectReason =
      await dependencies.overrideReject(
        context.env,
        category,
        entry.candidate,
        entry.ai,
        evaluation,
        rejectReason,
        {
          enabled:
            weakOverrideEnabled,
          scoreMargin:
            weakOverrideMargin,
          snapshot:
            queueSnapshot,
        },
      );

    const payload:
      GateCheckpointPayload = {
        evaluation,
        rejectReason,
        similarTopicRejected:
          similarTopicRejects.has(index),
      };

    const checkpointed =
      await dependencies.checkpointGate(
        context.env,
        {
          jobId:
            context.job.id,
          candidateId:
            entry.jobItem.candidate_id,
          checkpoint: 'gate',
          result: payload,
        },
      );

    if (!checkpointed) {
      throw new Error(
        `gate_checkpoint_rejected:${entry.jobItem.candidate_id}`,
      );
    }

    completed++;
    gatedNow++;

    if (rejectReason !== null) {
      rejectedNow++;
    }

    if (rejectReason === null) {
      addAcceptedDecision(
        entry,
        evaluation,
        seenFingerprints,
        seenStoryClusters,
        seenStoryKeys,
        seenSemanticStories,
        themeBatchCounts,
      );
    }
  }

  if (completed !== context.items.length) {
    throw new Error(
      `gate_stage_incomplete:${context.items.length - completed}`,
    );
  }

  return {
    stageCursor: completed,
    batchContext: {
      total: context.items.length,
      reused,
      gatedNow,
      rejected:
        rejectedNow + rejectedReused,
      invalid,
    },
  };
}

export function createAiBacklogGateStageHandler(
  dependencies:
    AIBacklogGateStageDependencies =
      DEFAULT_DEPENDENCIES,
): AIBacklogStageHandler {
  return context =>
    runAiBacklogGateStage(
      context,
      dependencies,
    );
}
