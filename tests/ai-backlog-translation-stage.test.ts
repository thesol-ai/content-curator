import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  runAiBacklogTranslationStage,
  type AIBacklogTranslationStageDependencies,
  type TranslationCheckpointPayload,
} from '../apps/worker-api/src/services/ai-backlog-translation-stage';

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

function makeNormalizedItem(
  id: string,
  platform = 'x',
): NormalizedItem {
  return {
    platform,
    sourceAccount: 'source-account',
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
  platform = 'x',
): AICandidateRow {
  return {
    id,
    source_id: 'source-1',
    run_id: 'run-1',
    category_id: 'crypto',
    platform,
    source_account:
      'source-account',
    source_url:
      `https://example.com/${id}`,
    post_id: id,
    published_at: 1000,
    normalized_item_json:
      JSON.stringify(
        makeNormalizedItem(
          id,
          platform,
        ),
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
    translations: {},
  };
}

function makeTranslatedAi(
  id: string,
): AIGateResult {
  return {
    ...makeAi(id),
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

function makeDuplicateDecision(
  id: string,
  rejectReason:
    string | null = null,
) {
  return {
    ai: makeAi(id),
    rejected:
      rejectReason !== null,
    rejectReason,
    judge: null,
    skippedByGate:
      rejectReason !== null,
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
    status: 'duplicate_checked',
    score_result_json:
      JSON.stringify(
        makeAi(candidateId),
      ),
    gate_result_json:
      JSON.stringify({
        evaluation: {},
        rejectReason: null,
        similarTopicRejected: false,
      }),
    duplicate_result_json:
      JSON.stringify(
        makeDuplicateDecision(
          candidateId,
        ),
      ),
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
    stage: 'duplicate_checked',
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
      AIBacklogTranslationStageDependencies
    > = {},
): AIBacklogTranslationStageDependencies {
  return {
    loadCandidates: vi.fn(
      async () => candidates,
    ),

    checkpointTranslations: vi.fn(
      async (
        _env,
        _jobId,
        checkpoints,
      ) => checkpoints.length,
    ),

    failItem: vi.fn(
      async () => true,
    ),

    recordFailure: vi.fn(
      async () => ({
        updated: true,
        failed: false,
        failures: 1,
      }),
    ),

    now: vi.fn(
      () => 1000,
    ),

    loadCategory: vi.fn(
      async () => ({
        id: 'crypto',
        score_threshold: 75,
        language_targets: '["fa"]',
      } as CategoryRow),
    ),

    loadChannels: vi.fn(
      async () => [{
        id: 'crypto-fa',
        enabled: 1,
        language: 'fa',
      }] as ChannelRow[],
    ),

    translate: vi.fn(
      async (
        _env,
        items,
      ) => items.map(
        item =>
          makeTranslatedAi(
            item.postId,
          ),
      ),
    ),

    briefRss: vi.fn(
      async (
        _env,
        items,
      ) => ({
        results: items.map(
          item =>
            makeTranslatedAi(
              item.postId,
            ),
        ),
        failedIndexes: [],
        capDeferredIndexes: [],
      }),
    ),

    preflightRss: vi.fn(
      async () => null,
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
  'ai-backlog-translation-stage',
  () => {
    it('reuses complete translation checkpoints', async () => {
      const checkpoint:
        TranslationCheckpointPayload = {
          ai:
            makeTranslatedAi(
              'candidate-1',
            ),
          rejected: false,
          rejectReason: null,
          skipped: false,
          mode: 'translation',
        };

      const item = makeJobItem(
        'candidate-1',
        0,
        {
          status: 'translated',
          translation_result_json:
            JSON.stringify(
              checkpoint,
            ),
        },
      );

      const dependencies =
        makeDependencies([]);

      const result =
        await runAiBacklogTranslationStage(
          makeContext([item]),
          dependencies,
        );

      expect(result.stageCursor).toBe(1);

      expect(
        dependencies.loadCandidates,
      ).not.toHaveBeenCalled();

      expect(
        dependencies.translate,
      ).not.toHaveBeenCalled();
    });

    it('skips rejected items without calling a provider', async () => {
      const candidate =
        makeCandidate(
          'candidate-1',
        );

      const item = makeJobItem(
        candidate.id,
        0,
        {
          duplicate_result_json:
            JSON.stringify(
              makeDuplicateDecision(
                candidate.id,
                'below_threshold',
              ),
            ),
        },
      );

      const checkpointTranslations =
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
            checkpointTranslations,
          },
        );

      const result =
        await runAiBacklogTranslationStage(
          makeContext([item]),
          dependencies,
        );

      expect(result.stageCursor).toBe(1);

      expect(
        dependencies.translate,
      ).not.toHaveBeenCalled();

      expect(
        dependencies.briefRss,
      ).not.toHaveBeenCalled();

      const payload = (
        checkpointTranslations
          .mock.calls[0]![2][0]!
          .result
      ) as TranslationCheckpointPayload;

      expect(payload.mode).toBe(
        'skipped',
      );

      expect(payload.rejectReason).toBe(
        'below_threshold',
      );
    });

    it('translates and checkpoints non-RSS survivors', async () => {
      const candidate =
        makeCandidate(
          'candidate-1',
        );

      const checkpointTranslations =
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
            checkpointTranslations,
          },
        );

      const result =
        await runAiBacklogTranslationStage(
          makeContext([
            makeJobItem(
              candidate.id,
              0,
            ),
          ]),
          dependencies,
        );

      expect(result.stageCursor).toBe(1);

      expect(
        dependencies.translate,
      ).toHaveBeenCalledTimes(1);

      const payload = (
        checkpointTranslations
          .mock.calls[0]![2][0]!
          .result
      ) as TranslationCheckpointPayload;

      expect(payload.mode).toBe(
        'translation',
      );

      expect(
        Object.keys(
          payload.ai.translations,
        ),
      ).toContain('fa');
    });

    it('checkpoints successful RSS items before retrying failed ones', async () => {
      const first =
        makeCandidate(
          'rss-1',
          'rss',
        );

      const second =
        makeCandidate(
          'rss-2',
          'rss',
        );

      const checkpointTranslations =
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
            checkpointTranslations,

            briefRss: vi.fn(
              async () => ({
                results: [
                  makeTranslatedAi(
                    first.id,
                  ),
                  makeAi(second.id),
                ],
                failedIndexes: [1],
                capDeferredIndexes: [],
              }),
            ),
          },
        );

      await expect(
        runAiBacklogTranslationStage(
          makeContext([
            makeJobItem(
              first.id,
              0,
            ),
            makeJobItem(
              second.id,
              1,
            ),
          ]),
          dependencies,
        ),
      ).rejects.toThrow(
        'stage_retry_at_ms:61000:translation_retry:1|rss_brief_unavailable',
      );

      expect(
        checkpointTranslations,
      ).toHaveBeenCalledWith(
        expect.anything(),
        'job-1',
        [
          expect.objectContaining({
            candidateId: first.id,
          }),
        ],
      );
    });

    it('checkpoints RSS preflight rejections without paying for a brief', async () => {
      const candidate =
        makeCandidate(
          'rss-1',
          'rss',
        );

      const checkpointTranslations =
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
            checkpointTranslations,

            preflightRss: vi.fn(
              async () =>
                'rss_brief_preflight_blocked:source_daily_cap',
            ),
          },
        );

      const result =
        await runAiBacklogTranslationStage(
          makeContext([
            makeJobItem(
              candidate.id,
              0,
            ),
          ]),
          dependencies,
        );

      expect(result.stageCursor).toBe(1);

      expect(
        dependencies.briefRss,
      ).not.toHaveBeenCalled();

      const payload = (
        checkpointTranslations
          .mock.calls[0]![2][0]!
          .result
      ) as TranslationCheckpointPayload;

      expect(payload.mode).toBe(
        'skipped',
      );

      expect(payload.rejectReason).toBe(
        'rss_brief_preflight_blocked:source_daily_cap',
      );
    });

    it('isolates non-RSS failure while preserving RSS success', async () => {
      const normal =
        makeCandidate(
          'candidate-1',
        );

      const rss =
        makeCandidate(
          'rss-1',
          'rss',
        );

      const checkpointTranslations =
        vi.fn(
          async (
            _env,
            _jobId,
            checkpoints,
          ) => checkpoints.length,
        );

      const dependencies =
        makeDependencies(
          [normal, rss],
          {
            checkpointTranslations,

            translate: vi.fn(
              async () => {
                throw new Error(
                  'gemini_503',
                );
              },
            ),
          },
        );

      await expect(
        runAiBacklogTranslationStage(
          makeContext([
            makeJobItem(
              normal.id,
              0,
            ),
            makeJobItem(
              rss.id,
              1,
            ),
          ]),
          dependencies,
        ),
      ).rejects.toThrow(
        'stage_retry_at_ms:61000:translation_retry:1|translation_error:gemini_503',
      );

      expect(
        dependencies.briefRss,
      ).toHaveBeenCalledTimes(1);

      expect(
        checkpointTranslations,
      ).toHaveBeenCalledWith(
        expect.anything(),
        'job-1',
        [
          expect.objectContaining({
            candidateId: rss.id,
          }),
        ],
      );
    });
    it('uses exponential backoff for repeated failures', async () => {
      const candidate =
        makeCandidate(
          'candidate-1',
        );

      const recordFailure =
        vi.fn(
          async () => ({
            updated: true,
            failed: false,
            failures: 2,
          }),
        );

      const dependencies =
        makeDependencies(
          [candidate],
          {
            translate: vi.fn(
              async () => {
                throw new Error(
                  'gemini_503',
                );
              },
            ),

            recordFailure,

            now: vi.fn(
              () => 1000,
            ),
          },
        );

      await expect(
        runAiBacklogTranslationStage(
          makeContext([
            makeJobItem(
              candidate.id,
              0,
            ),
          ]),
          dependencies,
        ),
      ).rejects.toThrow(
        'stage_retry_at_ms:121000:translation_retry:1|translation_error:gemini_503',
      );

      expect(
        recordFailure,
      ).toHaveBeenCalledWith(
        expect.anything(),
        'job-1',
        candidate.id,
        'translation_error:gemini_503',
        3,
      );
    });

    it('fails an item when the translation limit is reached', async () => {
      const candidate =
        makeCandidate(
          'candidate-1',
        );

      const dependencies =
        makeDependencies(
          [candidate],
          {
            translate: vi.fn(
              async () => {
                throw new Error(
                  'gemini_503',
                );
              },
            ),

            recordFailure: vi.fn(
              async () => ({
                updated: true,
                failed: true,
                failures: 3,
              }),
            ),
          },
        );

      const result =
        await runAiBacklogTranslationStage(
          makeContext([
            makeJobItem(
              candidate.id,
              0,
            ),
          ]),
          dependencies,
        );

      expect(
        result.stageCursor,
      ).toBe(1);

      expect(
        result.batchContext,
      ).toEqual(
        expect.objectContaining({
          failed: 1,
        }),
      );
    });

    it('defers an RSS daily cap without counting a provider failure', async () => {
      const candidate =
        makeCandidate(
          'rss-1',
          'rss',
        );

      const recordFailure =
        vi.fn(
          async () => ({
            updated: true,
            failed: false,
            failures: 1,
          }),
        );

      const dependencies =
        makeDependencies(
          [candidate],
          {
            briefRss: vi.fn(
              async () => ({
                results: [
                  makeAi(
                    candidate.id,
                  ),
                ],
                failedIndexes: [],
                capDeferredIndexes: [0],
              }),
            ),

            recordFailure,

            now: vi.fn(
              () => 1000,
            ),
          },
        );

      await expect(
        runAiBacklogTranslationStage(
          makeContext([
            makeJobItem(
              candidate.id,
              0,
            ),
          ]),
          dependencies,
        ),
      ).rejects.toThrow(
        'stage_retry_at_ms:3601000:rss_brief_daily_cap:1',
      );

      expect(
        recordFailure,
      ).not.toHaveBeenCalled();
    });


  },
);
