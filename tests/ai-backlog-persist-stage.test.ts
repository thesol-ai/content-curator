import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  runAiBacklogPersistStage,
  type AIBacklogPersistStageDependencies,
  type PersistCheckpointPayload,
} from '../apps/worker-api/src/services/ai-backlog-persist-stage';

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
    sourceAccount:
      'source-account',
    sourceUrl:
      `https://example.com/${id}`,
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
    source_account:
      'source-account',
    source_url:
      `https://example.com/${id}`,
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

function makeAi(
  id: string,
): AIGateResult {
  return {
    publish: true,
    score: 90,
    riskLevel: 'low',
    riskFlags: [],
    topicFingerprint:
      `topic-${id}`,
    publishPriority: 'high',
    translations: {
      fa: {
        captionShort:
          `Short ${id}`,
        captionFull:
          `Full ${id}`,
        hashtags: ['crypto'],
      },
    },
  };
}

function makeEvaluation(
  id: string,
): CandidateEvaluation {
  return {
    itemId: `item_${id}`,
    storyClusterKey: null,
    themeKey: null,
    recentTopicDuplicate: false,
    recentStoryClusterDuplicate: false,
    themeCapRejectReason: null,
    audienceRejectReason: null,
    storyKey: null,
    storyKeyRejectReason: null,
  };
}

function makeJobItem(
  candidateId: string,
  overrides:
    Partial<AIBacklogJobItemRow> = {},
): AIBacklogJobItemRow {
  const ai =
    makeAi(candidateId);

  return {
    job_id: 'job-1',
    candidate_id: candidateId,
    ordinal: 0,
    status: 'translated',
    score_result_json:
      JSON.stringify(ai),
    gate_result_json:
      JSON.stringify({
        evaluation:
          makeEvaluation(candidateId),
        rejectReason: null,
        similarTopicRejected: false,
      }),
    duplicate_result_json:
      JSON.stringify({
        ai,
        rejected: false,
        rejectReason: null,
        judge: null,
        skippedByGate: false,
      }),
    translation_result_json:
      JSON.stringify({
        ai,
        rejected: false,
        rejectReason: null,
        skipped: false,
        mode: 'translation',
      }),
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
    stage: 'translated',
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
      AIBacklogPersistStageDependencies
    > = {},
): AIBacklogPersistStageDependencies {
  return {
    loadCandidates: vi.fn(
      async () => candidates,
    ),

    checkpointPersist: vi.fn(
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
        language: 'fa',
      }] as ChannelRow[],
    ),

    loadPersistedState: vi.fn(
      async () => ({
        candidateStatus: 'queued',
        queueCount: 1,
      }),
    ),

    recoverQueuedCandidateStatus: vi.fn(
      async () => true,
    ),

    persistDecision: vi.fn(
      async () => ({
        selected: 1,
        rejected: 0,
        queued: 1,
      }),
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

describe(
  'ai-backlog-persist-stage',
  () => {
    it('reuses completed persist checkpoints', async () => {
      const payload:
        PersistCheckpointPayload = {
          candidateStatus: 'queued',
          selected: 1,
          rejected: 0,
          queued: 1,
          recovered: false,
        };

      const item = makeJobItem(
        'candidate-1',
        {
          status: 'persisted',
          persist_result_json:
            JSON.stringify(payload),
        },
      );

      const dependencies =
        makeDependencies([]);

      const result =
        await runAiBacklogPersistStage(
          makeContext([item]),
          dependencies,
        );

      expect(result.stageCursor).toBe(1);

      expect(
        dependencies.loadCandidates,
      ).not.toHaveBeenCalled();

      expect(
        dependencies.persistDecision,
      ).not.toHaveBeenCalled();
    });

    it('recovers a terminal candidate without persisting twice', async () => {
      const candidate =
        makeCandidate(
          'candidate-1',
        );

      const checkpointPersist =
        vi.fn(
          async () => true,
        );

      const dependencies =
        makeDependencies(
          [candidate],
          {
            checkpointPersist,

            loadPersistedState: vi.fn(
              async () => ({
                candidateStatus:
                  'queued',
                queueCount: 1,
              }),
            ),
          },
        );

      const result =
        await runAiBacklogPersistStage(
          makeContext([
            makeJobItem(
              candidate.id,
            ),
          ]),
          dependencies,
        );

      expect(result.stageCursor).toBe(1);

      expect(
        dependencies.persistDecision,
      ).not.toHaveBeenCalled();

      const payload = (
        checkpointPersist
          .mock.calls[0]![1]
          .result
      ) as PersistCheckpointPayload;

      expect(payload.recovered).toBe(
        true,
      );

      expect(payload.queued).toBe(1);
    });

    it('repairs candidate status when a queue row already exists', async () => {
      const candidate =
        makeCandidate(
          'candidate-1',
        );

      const loadPersistedState =
        vi.fn()
          .mockResolvedValueOnce({
            candidateStatus:
              'pending',
            queueCount: 1,
          })
          .mockResolvedValueOnce({
            candidateStatus:
              'queued',
            queueCount: 1,
          });

      const recoverQueuedCandidateStatus =
        vi.fn(
          async () => true,
        );

      const checkpointPersist =
        vi.fn(
          async () => true,
        );

      const dependencies =
        makeDependencies(
          [candidate],
          {
            loadPersistedState,
            recoverQueuedCandidateStatus,
            checkpointPersist,
          },
        );

      const result =
        await runAiBacklogPersistStage(
          makeContext([
            makeJobItem(
              candidate.id,
            ),
          ]),
          dependencies,
        );

      expect(result.stageCursor).toBe(1);

      expect(
        recoverQueuedCandidateStatus,
      ).toHaveBeenCalledWith(
        expect.anything(),
        'job-1',
        candidate.id,
      );

      expect(
        dependencies.persistDecision,
      ).not.toHaveBeenCalled();

      const payload = (
        checkpointPersist
          .mock.calls[0]![1]
          .result
      ) as PersistCheckpointPayload;

      expect(payload).toEqual({
        candidateStatus: 'queued',
        selected: 1,
        rejected: 0,
        queued: 1,
        recovered: true,
      });
    });

    it('rejects incomplete queued-state recovery', async () => {
      const candidate =
        makeCandidate(
          'candidate-1',
        );

      const dependencies =
        makeDependencies(
          [candidate],
          {
            loadPersistedState: vi.fn(
              async () => ({
                candidateStatus:
                  'pending',
                queueCount: 1,
              }),
            ),

            recoverQueuedCandidateStatus:
              vi.fn(
                async () => false,
              ),
          },
        );

      await expect(
        runAiBacklogPersistStage(
          makeContext([
            makeJobItem(
              candidate.id,
            ),
          ]),
          dependencies,
        ),
      ).rejects.toThrow(
        `persist_queue_recovery_rejected:${candidate.id}`,
      );

      expect(
        dependencies.persistDecision,
      ).not.toHaveBeenCalled();
    });

    it('persists and checkpoints a translated survivor', async () => {
      const candidate =
        makeCandidate(
          'candidate-1',
        );

      const loadPersistedState =
        vi.fn()
          .mockResolvedValueOnce({
            candidateStatus: 'pending',
            queueCount: 0,
          })
          .mockResolvedValueOnce({
            candidateStatus: 'queued',
            queueCount: 1,
          });

      const checkpointPersist =
        vi.fn(
          async () => true,
        );

      const dependencies =
        makeDependencies(
          [candidate],
          {
            loadPersistedState,
            checkpointPersist,
          },
        );

      const result =
        await runAiBacklogPersistStage(
          makeContext([
            makeJobItem(
              candidate.id,
            ),
          ]),
          dependencies,
        );

      expect(result.stageCursor).toBe(1);

      expect(
        dependencies.persistDecision,
      ).toHaveBeenCalledTimes(1);

      expect(
        dependencies.persistDecision,
      ).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Array),
        expect.anything(),
        expect.objectContaining({
          row:
            expect.objectContaining({
              id: candidate.id,
            }),
        }),
        expect.objectContaining({
          publish: true,
        }),
        expect.objectContaining({
          itemId:
            `item_${candidate.id}`,
        }),
        null,
      );

      const payload = (
        checkpointPersist
          .mock.calls[0]![1]
          .result
      ) as PersistCheckpointPayload;

      expect(payload.recovered).toBe(
        false,
      );

      expect(payload.queued).toBe(1);
    });

    it('persists rejection decisions', async () => {
      const candidate =
        makeCandidate(
          'candidate-1',
        );

      const item = makeJobItem(
        candidate.id,
      );

      item.translation_result_json =
        JSON.stringify({
          ai: makeAi(candidate.id),
          rejected: true,
          rejectReason:
            'below_threshold',
          skipped: true,
          mode: 'skipped',
        });

      const loadPersistedState =
        vi.fn()
          .mockResolvedValueOnce({
            candidateStatus: 'pending',
            queueCount: 0,
          })
          .mockResolvedValueOnce({
            candidateStatus:
              'ai_rejected',
            queueCount: 0,
          });

      const dependencies =
        makeDependencies(
          [candidate],
          {
            loadPersistedState,

            persistDecision: vi.fn(
              async () => ({
                selected: 0,
                rejected: 1,
                queued: 0,
              }),
            ),
          },
        );

      const result =
        await runAiBacklogPersistStage(
          makeContext([item]),
          dependencies,
        );

      expect(result.stageCursor).toBe(1);

      expect(
        dependencies.persistDecision,
      ).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Array),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        'below_threshold',
      );
    });

    it('fails items without translation checkpoints', async () => {
      const candidate =
        makeCandidate(
          'candidate-1',
        );

      const dependencies =
        makeDependencies([candidate]);

      const result =
        await runAiBacklogPersistStage(
          makeContext([
            makeJobItem(
              candidate.id,
              {
                translation_result_json:
                  null,
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
        'translation_checkpoint_missing',
      );

      expect(
        dependencies.persistDecision,
      ).not.toHaveBeenCalled();
    });

    it('rejects an incomplete persist checkpoint', async () => {
      const candidate =
        makeCandidate(
          'candidate-1',
        );

      const dependencies =
        makeDependencies(
          [candidate],
          {
            checkpointPersist: vi.fn(
              async () => false,
            ),
          },
        );

      await expect(
        runAiBacklogPersistStage(
          makeContext([
            makeJobItem(
              candidate.id,
            ),
          ]),
          dependencies,
        ),
      ).rejects.toThrow(
        `persist_checkpoint_rejected:${candidate.id}`,
      );
    });
  },
);
