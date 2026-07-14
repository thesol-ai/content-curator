import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  runAiBacklogGateStage,
  type AIBacklogGateStageDependencies,
} from '../apps/worker-api/src/services/ai-backlog-gate-stage';

import type {
  AICandidateRow,
  AIGateResult,
  AIBacklogJobItemRow,
  AIBacklogJobRow,
  CategoryRow,
  ChannelRow,
  Env,
  NormalizedItem,
} from '../apps/worker-api/src/types';

import type {
  CandidateEvaluation,
} from '../apps/worker-api/src/services/backlog-drain';

function makeNormalizedItem(
  id: string,
): NormalizedItem {
  return {
    platform: 'x',
    sourceAccount: 'source-account',
    sourceUrl:
      `https://x.com/source/status/${id}`,
    postId: id,
    publishedAt: 1000,
    text: `Candidate ${id}`,
    media: [],
    engagementLikes: 0,
    engagementShares: 0,
    engagementViews: 0,
    isReply: false,
    isRetweet: false,
    isQuote: false,
    mediaUrlExpiresSoon: false,
  } as NormalizedItem;
}

function makeCandidate(
  id: string,
): AICandidateRow {
  return {
    id,
    source_id: 'source-1',
    run_id: 'run-1',
    category_id: 'crypto',
    platform: 'x',
    source_account: 'source-account',
    source_url:
      `https://x.com/source/status/${id}`,
    post_id: id,
    published_at: 1000,
    normalized_item_json:
      JSON.stringify(
        makeNormalizedItem(id),
      ),
    dedupe_keys_json:
      JSON.stringify([`key:${id}`]),
    priority_score: 100,
    status: 'pending',
    attempt_count: 0,
    last_error: null,
    created_at:
      '2026-07-12 00:00:00',
    claimed_at: null,
    scored_at: null,
    processing_job_id: 'job-1',
  };
}

function makeScore(
  fingerprint = 'shared-topic',
): AIGateResult {
  return {
    publish: true,
    score: 90,
    riskLevel: 'low',
    riskFlags: [],
    topicFingerprint: fingerprint,
    publishPriority: 'high',
    translations: {},
  };
}

function makeEvaluation(
  overrides:
    Partial<CandidateEvaluation> = {},
): CandidateEvaluation {
  return {
    itemId: 'candidate_item',
    storyClusterKey: null,
    themeKey: null,
    recentTopicDuplicate: false,
    recentStoryClusterDuplicate: false,
    themeCapRejectReason: null,
    audienceRejectReason: null,
    storyKey: null,
    storyKeyRejectReason: null,
    ...overrides,
  };
}

function makeJobItem(
  candidateId: string,
  overrides:
    Partial<AIBacklogJobItemRow> = {},
): AIBacklogJobItemRow {
  return {
    job_id: 'job-1',
    candidate_id: candidateId,
    ordinal: 0,
    status: 'scored',
    score_result_json:
      JSON.stringify(makeScore()),
    gate_result_json: null,
    duplicate_result_json: null,
    translation_result_json: null,
    persist_result_json: null,
    provider_attempts: 1,
    last_error: null,
    created_at:
      '2026-07-12 00:00:00',
    updated_at:
      '2026-07-12 00:00:00',
    completed_at: null,
    ...overrides,
  };
}

function makeJob(): AIBacklogJobRow {
  return {
    id: 'job-1',
    dispatch_id: 'cron:300000',
    source: 'cron',
    status: 'processing',
    stage: 'scored',
    stage_cursor: 0,
    scheduled_time_ms: 300000,
    batch_context_json: null,
    lease_token: 'lease-token',
    lease_expires_at:
      '2099-01-01 00:00:00',
    queue_sent_at: null,
    next_run_at: null,
    delivery_attempts: 1,
    last_error: null,
    created_at:
      '2026-07-12 00:00:00',
    updated_at:
      '2026-07-12 00:00:00',
    completed_at: null,
  };
}

function makeDependencies(
  candidates: AICandidateRow[],
  overrides:
    Partial<AIBacklogGateStageDependencies>
      = {},
): AIBacklogGateStageDependencies {
  return {
    loadCandidates: vi.fn(
      async () => candidates,
    ),

    checkpointGate: vi.fn(
      async () => true,
    ),

    failItem: vi.fn(
      async () => true,
    ),

    loadCategory: vi.fn(
      async () => ({
        id: 'crypto',
        score_threshold: 75,
      } as CategoryRow),
    ),

    loadChannels: vi.fn(
      async () => [{
        id: 'crypto-fa',
        enabled: 1,
        semantic_dedupe_enabled: 1,
      }] as ChannelRow[],
    ),

    evaluateCandidate: vi.fn(
      async () => makeEvaluation(),
    ),

    resolveReject: vi.fn(
      evaluation =>
        evaluation.recentTopicDuplicate
          ? 'similar_topic_recent_channel'
          : null,
    ),

    overrideReject: vi.fn(
      async (
        _env,
        _category,
        _candidate,
        _ai,
        _evaluation,
        rejectReason,
      ) => rejectReason,
    ),

    loadQueueSnapshot: vi.fn(
      async () => ({
        allEnabledChannelsStarving: false,
        minScheduledNext6h: 4,
        channels: [],
      }),
    ),

    findSimilarTopicRejects: vi.fn(
      () => new Set<number>(),
    ),

    ...overrides,
  };
}

function makeContext(
  items: AIBacklogJobItemRow[],
) {
  return {
    env: {} as Env,
    job: makeJob(),
    items,
    leaseToken: 'lease-token',
  };
}

describe('ai-backlog-gate-stage', () => {
  it('reuses completed gate checkpoints', async () => {
    const payload = {
      evaluation: makeEvaluation(),
      rejectReason: null,
      similarTopicRejected: false,
    };

    const item = makeJobItem(
      'candidate-1',
      {
        status: 'gated',
        gate_result_json:
          JSON.stringify(payload),
      },
    );

    const dependencies =
      makeDependencies([]);

    const result =
      await runAiBacklogGateStage(
        makeContext([item]),
        dependencies,
      );

    expect(result.stageCursor).toBe(1);

    expect(
      dependencies.loadCandidates,
    ).not.toHaveBeenCalled();

    expect(
      dependencies.evaluateCandidate,
    ).not.toHaveBeenCalled();
  });

  it('evaluates and checkpoints one candidate', async () => {
    const candidate =
      makeCandidate('candidate-1');

    const dependencies =
      makeDependencies([candidate]);

    const result =
      await runAiBacklogGateStage(
        makeContext([
          makeJobItem(candidate.id),
        ]),
        dependencies,
      );

    expect(result.stageCursor).toBe(1);

    expect(
      dependencies.evaluateCandidate,
    ).toHaveBeenCalledTimes(1);

    expect(
      dependencies.checkpointGate,
    ).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        jobId: 'job-1',
        candidateId: candidate.id,
        checkpoint: 'gate',
      }),
    );
  });

  it('uses prior accepted checkpoints for intra-batch dedupe', async () => {
    const first =
      makeCandidate('candidate-1');

    const second =
      makeCandidate('candidate-2');

    const acceptedPayload = {
      evaluation: makeEvaluation(),
      rejectReason: null,
      similarTopicRejected: false,
    };

    const checkpointGate = vi.fn(
      async () => true,
    );

    const dependencies =
      makeDependencies(
        [first, second],
        {
          checkpointGate,
        },
      );

    const result =
      await runAiBacklogGateStage(
        makeContext([
          makeJobItem(
            first.id,
            {
              ordinal: 0,
              status: 'gated',
              gate_result_json:
                JSON.stringify(
                  acceptedPayload,
                ),
            },
          ),
          makeJobItem(
            second.id,
            {
              ordinal: 1,
            },
          ),
        ]),
        dependencies,
      );

    expect(result.stageCursor).toBe(2);

    const payload =
      checkpointGate.mock.calls[0]![1]
        .result as {
          evaluation:
            CandidateEvaluation;
          rejectReason:
            string | null;
        };

    expect(
      payload.evaluation
        .recentTopicDuplicate,
    ).toBe(true);

    expect(payload.rejectReason).toBe(
      'similar_topic_recent_channel',
    );
  });

  it('fails an item with no score checkpoint', async () => {
    const candidate =
      makeCandidate('candidate-1');

    const dependencies =
      makeDependencies([candidate]);

    const result =
      await runAiBacklogGateStage(
        makeContext([
          makeJobItem(
            candidate.id,
            {
              score_result_json: null,
            },
          ),
        ]),
        dependencies,
      );

    expect(result.stageCursor).toBe(1);

    expect(
      dependencies.failItem,
    ).toHaveBeenCalledWith(
      expect.anything(),
      'job-1',
      candidate.id,
      'score_checkpoint_missing',
    );

    expect(
      dependencies.evaluateCandidate,
    ).not.toHaveBeenCalled();
  });

  it('persists the resolved rejection reason', async () => {
    const candidate =
      makeCandidate('candidate-1');

    const checkpointGate = vi.fn(
      async () => true,
    );

    const dependencies =
      makeDependencies(
        [candidate],
        {
          checkpointGate,

          resolveReject: vi.fn(
            () => 'below_threshold',
          ),
        },
      );

    await runAiBacklogGateStage(
      makeContext([
        makeJobItem(candidate.id),
      ]),
      dependencies,
    );

    const payload =
      checkpointGate.mock.calls[0]![1]
        .result as {
          rejectReason:
            string | null;
        };

    expect(payload.rejectReason).toBe(
      'below_threshold',
    );
  });
});
