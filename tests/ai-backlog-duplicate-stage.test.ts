import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  runAiBacklogDuplicateStage,
  type AIBacklogDuplicateStageDependencies,
  type DuplicateCheckpointPayload,
} from '../apps/worker-api/src/services/ai-backlog-duplicate-stage';

import type {
  AICandidateRow,
  AIGateResult,
  AIBacklogJobItemRow,
  AIBacklogJobRow,
  Env,
  NormalizedItem,
} from '../apps/worker-api/src/types';

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
    dedupe_keys_json: '[]',
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
  fingerprint = 'topic-one',
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

function makeGate(
  rejectReason: string | null = null,
) {
  return {
    evaluation: {
      itemId: 'candidate-item',
    },
    rejectReason,
    similarTopicRejected: false,
  };
}

function makeJobItem(
  candidateId: string,
  ordinal: number,
  overrides:
    Partial<AIBacklogJobItemRow> = {},
): AIBacklogJobItemRow {
  return {
    job_id: 'job-1',
    candidate_id: candidateId,
    ordinal,
    status: 'gated',
    score_result_json:
      JSON.stringify(makeScore()),
    gate_result_json:
      JSON.stringify(makeGate()),
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
    stage: 'gated',
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
    Partial<
      AIBacklogDuplicateStageDependencies
    > = {},
): AIBacklogDuplicateStageDependencies {
  return {
    loadCandidates: vi.fn(
      async () => candidates,
    ),

    checkpointDuplicates: vi.fn(
      async (
        _env,
        _jobId,
        checkpoints,
      ) => checkpoints.length,
    ),

    failItem: vi.fn(
      async () => true,
    ),

    loadChannelId: vi.fn(
      async () => 'crypto-fa',
    ),

    runJudge: vi.fn(
      async () => new Map(),
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

describe('ai-backlog-duplicate-stage', () => {
  it('reuses complete duplicate checkpoints', async () => {
    const item = makeJobItem(
      'candidate-1',
      0,
      {
        status: 'duplicate_checked',
        duplicate_result_json:
          JSON.stringify({
            rejected: false,
          }),
      },
    );

    const dependencies =
      makeDependencies([]);

    const result =
      await runAiBacklogDuplicateStage(
        makeContext([item]),
        dependencies,
      );

    expect(result.stageCursor).toBe(1);

    expect(
      dependencies.loadCandidates,
    ).not.toHaveBeenCalled();

    expect(
      dependencies.runJudge,
    ).not.toHaveBeenCalled();
  });

  it('does not call the judge for gate-rejected items', async () => {
    const candidate =
      makeCandidate('candidate-1');

    const item = makeJobItem(
      candidate.id,
      0,
      {
        gate_result_json:
          JSON.stringify(
            makeGate('below_threshold'),
          ),
      },
    );

    const checkpointDuplicates =
      vi.fn(
        async (
          _env,
          _jobId,
          checkpoints,
        ) => checkpoints.length,
      );

    const dependencies =
      makeDependencies(
        [candidate],
        {
          checkpointDuplicates,
        },
      );

    const result =
      await runAiBacklogDuplicateStage(
        makeContext([item]),
        dependencies,
      );

    expect(result.stageCursor).toBe(1);

    expect(
      dependencies.runJudge,
    ).not.toHaveBeenCalled();

    const payload =
      checkpointDuplicates
        .mock.calls[0]![2][0]!
        .result as DuplicateCheckpointPayload;

    expect(payload.rejected).toBe(true);
    expect(payload.skippedByGate).toBe(true);
    expect(payload.rejectReason).toBe(
      'below_threshold',
    );
  });

  it('checkpoints duplicate judge rejections', async () => {
    const first =
      makeCandidate('candidate-1');

    const second =
      makeCandidate('candidate-2');

    const checkpointDuplicates =
      vi.fn(
        async (
          _env,
          _jobId,
          checkpoints,
        ) => checkpoints.length,
      );

    const dependencies =
      makeDependencies(
        [first, second],
        {
          checkpointDuplicates,

          runJudge: vi.fn(
            async () => new Map([
              [
                1,
                {
                  index: 1,
                  decision: 'duplicate',
                  confidence: 0.91,
                  matchedPriorId:
                    'prior-1',
                  reason:
                    'same underlying event',
                },
              ],
            ]),
          ),
        },
      );

    const result =
      await runAiBacklogDuplicateStage(
        makeContext([
          makeJobItem(first.id, 0),
          makeJobItem(second.id, 1),
        ]),
        dependencies,
      );

    expect(result.stageCursor).toBe(2);

    const checkpoints =
      checkpointDuplicates
        .mock.calls[0]![2];

    const secondPayload =
      checkpoints[1]!.result as DuplicateCheckpointPayload;

    expect(secondPayload.rejected).toBe(
      true,
    );

    expect(secondPayload.rejectReason).toBe(
      'similar_ai_duplicate_recent_channel',
    );

    expect(
      secondPayload.ai.riskFlags,
    ).toContain(
      'ai_duplicate_judge',
    );
  });

  it('includes prior completed survivors during partial recovery', async () => {
    const first =
      makeCandidate('candidate-1');

    const second =
      makeCandidate('candidate-2');

    const runJudge = vi.fn(
      async () => new Map(),
    );

    const dependencies =
      makeDependencies(
        [first, second],
        {
          runJudge,
        },
      );

    await runAiBacklogDuplicateStage(
      makeContext([
        makeJobItem(
          first.id,
          0,
          {
            status:
              'duplicate_checked',
            duplicate_result_json:
              JSON.stringify({
                rejected: false,
              }),
          },
        ),
        makeJobItem(
          second.id,
          1,
        ),
      ]),
      dependencies,
    );

    const candidates =
      runJudge.mock.calls[0]![1]
        .candidates;

    expect(
      candidates.map(
        candidate =>
          candidate.index,
      ),
    ).toEqual([0, 1]);

    expect(
      dependencies.checkpointDuplicates,
    ).toHaveBeenCalledWith(
      expect.anything(),
      'job-1',
      [
        expect.objectContaining({
          candidateId:
            second.id,
        }),
      ],
    );
  });

  it('fails items without gate checkpoints', async () => {
    const candidate =
      makeCandidate('candidate-1');

    const dependencies =
      makeDependencies([candidate]);

    const result =
      await runAiBacklogDuplicateStage(
        makeContext([
          makeJobItem(
            candidate.id,
            0,
            {
              gate_result_json: null,
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
      'gate_checkpoint_missing',
    );

    expect(
      dependencies.runJudge,
    ).not.toHaveBeenCalled();
  });
});
