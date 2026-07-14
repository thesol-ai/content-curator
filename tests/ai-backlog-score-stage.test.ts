import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  runAiBacklogScoreStage,
  type AIBacklogScoreStageDependencies,
} from '../apps/worker-api/src/services/ai-backlog-score-stage';

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

function makeItem(
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
  categoryId = 'crypto',
): AICandidateRow {
  return {
    id,
    source_id: 'source-1',
    run_id: 'run-1',
    category_id: categoryId,
    platform: 'x',
    source_account: 'source-account',
    source_url:
      `https://x.com/source/status/${id}`,
    post_id: id,
    published_at: 1000,
    normalized_item_json:
      JSON.stringify(makeItem(id)),
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

function makeJobItem(
  candidateId: string,
  overrides:
    Partial<AIBacklogJobItemRow> = {},
): AIBacklogJobItemRow {
  return {
    job_id: 'job-1',
    candidate_id: candidateId,
    ordinal: 0,
    status: 'pending',
    score_result_json: null,
    gate_result_json: null,
    duplicate_result_json: null,
    translation_result_json: null,
    persist_result_json: null,
    provider_attempts: 0,
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
    stage: 'created',
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

function goodScore(
  score = 90,
): AIGateResult {
  return {
    publish: true,
    score,
    riskLevel: 'low',
    riskFlags: [],
    topicFingerprint:
      `topic-${score}`,
    publishPriority: 'high',
    translations: {},
  };
}

function makeDependencies(
  candidates: AICandidateRow[],
  overrides:
    Partial<AIBacklogScoreStageDependencies> = {},
): AIBacklogScoreStageDependencies {
  return {
    loadCandidates: vi.fn(
      async () => candidates,
    ),

    loadJobItems: vi.fn(
      async () => candidates.map(
        candidate =>
          makeJobItem(candidate.id, {
            status: 'scored',
            score_result_json:
              JSON.stringify(goodScore()),
          }),
      ),
    ),

    checkpointScores: vi.fn(
      async (
        _env,
        _jobId,
        checkpoints,
      ) => checkpoints.length,
    ),

    failItem: vi.fn(
      async () => true,
    ),

    recordProviderFailure: vi.fn(
      async () => ({
        updated: true,
        failed: false,
      }),
    ),

    loadCategory: vi.fn(
      async () => ({
        id: 'crypto',
        language_targets: '["fa"]',
      } as CategoryRow),
    ),

    loadChannels: vi.fn(
      async () => [] as ChannelRow[],
    ),

    loadWhitelist: vi.fn(
      async () => [],
    ),

    score: vi.fn(
      async (
        _env,
        items,
      ) => items.map(
        () => goodScore(),
      ),
    ),

    ...overrides,
  };
}

function makeContext(
  items: AIBacklogJobItemRow[],
) {
  return {
    env: {
      AI_CANDIDATE_MAX_ATTEMPTS: '2',
    } as unknown as Env,
    job: makeJob(),
    items,
    leaseToken: 'lease-token',
  };
}

describe('ai-backlog-score-stage', () => {
  it('reuses durable score checkpoints', async () => {
    const candidate =
      makeCandidate('candidate-1');

    const dependencies =
      makeDependencies([candidate]);

    const result =
      await runAiBacklogScoreStage(
        makeContext([
          makeJobItem(
            candidate.id,
            {
              status: 'scored',
              score_result_json:
                JSON.stringify(goodScore()),
            },
          ),
        ]),
        dependencies,
      );

    expect(result.stageCursor).toBe(1);

    expect(
      dependencies.score,
    ).not.toHaveBeenCalled();

    expect(
      dependencies.checkpointScores,
    ).not.toHaveBeenCalled();
  });

  it('scores only missing items and checkpoints them', async () => {
    const candidate =
      makeCandidate('candidate-1');

    const dependencies =
      makeDependencies([candidate]);

    const result =
      await runAiBacklogScoreStage(
        makeContext([
          makeJobItem(candidate.id),
        ]),
        dependencies,
      );

    expect(result.stageCursor).toBe(1);

    expect(
      dependencies.score,
    ).toHaveBeenCalledTimes(1);

    expect(
      dependencies.checkpointScores,
    ).toHaveBeenCalledWith(
      expect.anything(),
      'job-1',
      [
        {
          candidateId: 'candidate-1',
          result: goodScore(),
        },
      ],
    );
  });

  it('keeps partial provider results and retries only unresolved items', async () => {
    const first =
      makeCandidate('candidate-1');

    const second =
      makeCandidate('candidate-2');

    const dependencies =
      makeDependencies(
        [first, second],
        {
          score: vi.fn(
            async () => [
              goodScore(),
              {
                publish: false,
                score: 0,
                riskLevel: 'medium',
                riskFlags: [
                  'not_scored',
                ],
                topicFingerprint:
                  'not-scored',
                publishPriority: 'low',
                translations: {},
              },
            ],
          ),

          loadJobItems: vi.fn(
            async () => [
              makeJobItem(
                first.id,
                {
                  status: 'scored',
                  score_result_json:
                    JSON.stringify(
                      goodScore(),
                    ),
                },
              ),
              makeJobItem(
                second.id,
                {
                  provider_attempts: 1,
                  last_error:
                    'scoring_incomplete:not_scored',
                },
              ),
            ],
          ),
        },
      );

    await expect(
      runAiBacklogScoreStage(
        makeContext([
          makeJobItem(first.id),
          makeJobItem(second.id),
        ]),
        dependencies,
      ),
    ).rejects.toThrow(
      'score_stage_incomplete:1',
    );

    expect(
      dependencies.checkpointScores,
    ).toHaveBeenCalledWith(
      expect.anything(),
      'job-1',
      [
        {
          candidateId: first.id,
          result: goodScore(),
        },
      ],
    );

    expect(
      dependencies.recordProviderFailure,
    ).toHaveBeenCalledWith(
      expect.anything(),
      'job-1',
      second.id,
      'scoring_incomplete:not_scored',
      2,
    );
  });

  it('does not burn provider attempts when the AI budget is blocked', async () => {
    const candidate =
      makeCandidate('candidate-1');

    const dependencies =
      makeDependencies(
        [candidate],
        {
          score: vi.fn(
            async () => [{
              publish: false,
              score: 0,
              riskLevel: 'medium',
              riskFlags: [
                'ai_budget_exceeded',
              ],
              topicFingerprint:
                'budget-candidate-1',
              publishPriority: 'normal',
              translations: {},
            }],
          ),

          loadJobItems: vi.fn(
            async () => [
              makeJobItem(candidate.id),
            ],
          ),
        },
      );

    await expect(
      runAiBacklogScoreStage(
        makeContext([
          makeJobItem(candidate.id),
        ]),
        dependencies,
      ),
    ).rejects.toThrow(
      'ai_budget_exceeded:1',
    );

    expect(
      dependencies.recordProviderFailure,
    ).not.toHaveBeenCalled();

    expect(
      dependencies.checkpointScores,
    ).toHaveBeenCalledWith(
      expect.anything(),
      'job-1',
      [],
    );
  });

  it('fails invalid candidate payloads without calling AI', async () => {
    const candidate =
      makeCandidate('candidate-1');

    candidate.normalized_item_json =
      '{invalid-json';

    const dependencies =
      makeDependencies(
        [candidate],
        {
          loadJobItems: vi.fn(
            async () => [
              makeJobItem(
                candidate.id,
                {
                  status: 'failed',
                  last_error:
                    'invalid_candidate_payload',
                },
              ),
            ],
          ),
        },
      );

    const result =
      await runAiBacklogScoreStage(
        makeContext([
          makeJobItem(candidate.id),
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
      'invalid_candidate_payload',
    );

    expect(
      dependencies.score,
    ).not.toHaveBeenCalled();
  });

  it('records provider exceptions before retrying', async () => {
    const candidate =
      makeCandidate('candidate-1');

    const dependencies =
      makeDependencies(
        [candidate],
        {
          score: vi.fn(
            async () => {
              throw new Error(
                'claude_timeout',
              );
            },
          ),

          loadJobItems: vi.fn(
            async () => [
              makeJobItem(
                candidate.id,
                {
                  status: 'failed',
                  provider_attempts: 2,
                  last_error:
                    'scoring_error:claude_timeout',
                },
              ),
            ],
          ),

          recordProviderFailure: vi.fn(
            async () => ({
              updated: true,
              failed: true,
            }),
          ),
        },
      );

    const result =
      await runAiBacklogScoreStage(
        makeContext([
          makeJobItem(candidate.id),
        ]),
        dependencies,
      );

    expect(result.stageCursor).toBe(1);

    expect(
      dependencies.recordProviderFailure,
    ).toHaveBeenCalledWith(
      expect.anything(),
      'job-1',
      candidate.id,
      'scoring_error:claude_timeout',
      2,
    );
  });
});
