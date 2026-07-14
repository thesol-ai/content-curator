import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  dispatchAiBacklogJob,
  getAiBacklogDispatchSlotMs,
  getAiBacklogJobBatchSize,
  isAiBacklogStageJobsEnabled,
  type AIBacklogDispatcherDependencies,
} from '../apps/worker-api/src/services/ai-backlog-dispatcher';

import type {
  AICandidateRow,
  AIBacklogJobItemRow,
  AIBacklogJobRow,
  Env,
} from '../apps/worker-api/src/types';

function makeEnv(
  overrides: Partial<Env> = {},
): Env {
  return {
    AI_SCORING_BATCH_SIZE: '10',
    ...overrides,
  } as unknown as Env;
}

function makeJob(
  overrides: Partial<AIBacklogJobRow> = {},
): AIBacklogJobRow {
  return {
    id: 'ai_job:cron:300000',
    dispatch_id: 'cron:300000',
    source: 'cron',
    status: 'pending',
    stage: 'created',
    stage_cursor: 0,
    scheduled_time_ms: 300001,
    batch_context_json: null,
    lease_token: null,
    lease_expires_at: null,
    queue_sent_at: null,
    next_run_at: null,
    delivery_attempts: 0,
    last_error: null,
    created_at: '2026-07-12 00:00:00',
    updated_at: '2026-07-12 00:00:00',
    completed_at: null,
    ...overrides,
  };
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
    source_account: 'account-1',
    source_url:
      `https://x.com/account/status/${id}`,
    post_id: id,
    published_at: 1000,
    normalized_item_json: '{}',
    dedupe_keys_json: '[]',
    priority_score: 100,
    status: 'pending',
    attempt_count: 0,
    last_error: null,
    created_at: '2026-07-12 00:00:00',
    claimed_at: null,
    scored_at: null,
    processing_job_id: null,
  };
}

function makeJobItem(
  candidateId: string,
  ordinal = 0,
): AIBacklogJobItemRow {
  return {
    job_id: 'ai_job:cron:300000',
    candidate_id: candidateId,
    ordinal,
    status: 'pending',
    score_result_json: null,
    gate_result_json: null,
    duplicate_result_json: null,
    translation_result_json: null,
    persist_result_json: null,
    provider_attempts: 0,
    last_error: null,
    created_at: '2026-07-12 00:00:00',
    updated_at: '2026-07-12 00:00:00',
    completed_at: null,
  };
}

function makeDependencies(
  overrides: Partial<
    AIBacklogDispatcherDependencies
  > = {},
): AIBacklogDispatcherDependencies {
  const candidates = [
    makeCandidate('candidate-1'),
    makeCandidate('candidate-2'),
  ];

  return {
    createOrGetJob: vi.fn(
      async () => makeJob(),
    ),
    getJobItems: vi.fn(
      async () => [],
    ),
    reserveCandidates: vi.fn(async (
      _env,
      _jobId,
      _leaseToken,
      candidateIds,
    ) => candidateIds.map(
      (candidateId, index) =>
        makeJobItem(candidateId, index),
    )),
    fetchCandidates: vi.fn(
      async () => candidates,
    ),
    selectCandidates: vi.fn((
      rows,
      limit,
      enabled,
    ) => ({
      selected: rows.slice(0, limit),
      stats: {
        enabled,
        inputCount: rows.length,
        outputCount: Math.min(
          rows.length,
          limit,
        ),
        sourceIdCount: 1,
        accountCount: 1,
        unknownSourceIdCount: 0,
        unknownAccountCount: 0,
        selectedBySourceId: {
          'source-1': Math.min(
            rows.length,
            limit,
          ),
        },
        selectedByAccount: {
          'account-1': Math.min(
            rows.length,
            limit,
          ),
        },
        selectedByBucket: {
          'source-1::account-1':
            Math.min(rows.length, limit),
        },
      },
    })),
    claimJobLease: vi.fn(
      async () => 'dispatch-lease',
    ),
    releaseJobLease: vi.fn(
      async () => true,
    ),
    completeJob: vi.fn(
      async () => true,
    ),
    ...overrides,
  };
}

describe('ai-backlog-dispatcher', () => {
  it('is disabled unless explicitly enabled', () => {
    expect(
      isAiBacklogStageJobsEnabled(makeEnv()),
    ).toBe(false);

    expect(
      isAiBacklogStageJobsEnabled(
        makeEnv({
          AI_BACKLOG_STAGE_JOBS_ENABLED:
            'true',
        }),
      ),
    ).toBe(true);
  });

  it('parses and clamps dispatcher configuration', () => {
    expect(
      getAiBacklogJobBatchSize(
        makeEnv({
          AI_BACKLOG_JOB_BATCH_SIZE: '12',
        }),
      ),
    ).toBe(12);

    expect(
      getAiBacklogJobBatchSize(
        makeEnv({
          AI_BACKLOG_JOB_BATCH_SIZE: '999',
        }),
      ),
    ).toBe(50);

    expect(
      getAiBacklogDispatchSlotMs(
        makeEnv({
          AI_BACKLOG_JOB_DISPATCH_SLOT_MINUTES:
            '7',
        }),
      ),
    ).toBe(7 * 60 * 1000);
  });

  it('does not create a job while disabled', async () => {
    const dependencies = makeDependencies();

    const result = await dispatchAiBacklogJob(
      makeEnv(),
      {
        scheduledTimeMs: 300001,
      },
      dependencies,
    );

    expect(result.reason).toBe(
      'stage_jobs_disabled',
    );

    expect(
      dependencies.createOrGetJob,
    ).not.toHaveBeenCalled();
  });

  it('does not reopen a completed slot job', async () => {
    const dependencies = makeDependencies({
      createOrGetJob: vi.fn(async () =>
        makeJob({
          status: 'completed',
          stage: 'completed',
          completed_at:
            '2026-07-12 00:01:00',
        }),
      ),
    });

    const result = await dispatchAiBacklogJob(
      makeEnv({
        AI_BACKLOG_STAGE_JOBS_ENABLED:
          'true',
      }),
      {
        scheduledTimeMs: 300001,
      },
      dependencies,
    );

    expect(result.reason).toBe(
      'existing_job_completed',
    );

    expect(
      dependencies.claimJobLease,
    ).not.toHaveBeenCalled();
  });

  it('reuses existing items before claiming a lease', async () => {
    const existingItems = [
      makeJobItem('candidate-existing'),
    ];

    const dependencies = makeDependencies({
      getJobItems: vi.fn(
        async () => existingItems,
      ),
    });

    const result = await dispatchAiBacklogJob(
      makeEnv({
        AI_BACKLOG_STAGE_JOBS_ENABLED:
          'true',
      }),
      {
        scheduledTimeMs: 300001,
      },
      dependencies,
    );

    expect(result.reusedExistingJob).toBe(true);
    expect(result.candidateIds).toEqual([
      'candidate-existing',
    ]);

    expect(
      dependencies.claimJobLease,
    ).not.toHaveBeenCalled();

    expect(
      dependencies.fetchCandidates,
    ).not.toHaveBeenCalled();
  });

  it('does not fetch when the dispatch lease is owned', async () => {
    const dependencies = makeDependencies({
      claimJobLease: vi.fn(
        async () => null,
      ),
    });

    const result = await dispatchAiBacklogJob(
      makeEnv({
        AI_BACKLOG_STAGE_JOBS_ENABLED:
          'true',
      }),
      {
        scheduledTimeMs: 300001,
      },
      dependencies,
    );

    expect(result.reason).toBe(
      'dispatch_lease_unavailable',
    );

    expect(
      dependencies.fetchCandidates,
    ).not.toHaveBeenCalled();
  });

  it('rechecks items after acquiring the lease', async () => {
    const existingItems = [
      makeJobItem('candidate-raced'),
    ];

    const getJobItems = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(existingItems);

    const dependencies = makeDependencies({
      getJobItems,
    });

    const result = await dispatchAiBacklogJob(
      makeEnv({
        AI_BACKLOG_STAGE_JOBS_ENABLED:
          'true',
      }),
      {
        scheduledTimeMs: 300001,
      },
      dependencies,
    );

    expect(result.reusedExistingJob).toBe(true);
    expect(result.candidateIds).toEqual([
      'candidate-raced',
    ]);

    expect(
      dependencies.releaseJobLease,
    ).toHaveBeenCalledWith(
      expect.anything(),
      'ai_job:cron:300000',
      'dispatch-lease',
      'dispatch_existing_items',
    );

    expect(
      dependencies.fetchCandidates,
    ).not.toHaveBeenCalled();
  });

  it('completes an empty job while holding its lease', async () => {
    const dependencies = makeDependencies({
      fetchCandidates: vi.fn(
        async () => [],
      ),
    });

    const result = await dispatchAiBacklogJob(
      makeEnv({
        AI_BACKLOG_STAGE_JOBS_ENABLED:
          'true',
      }),
      {
        scheduledTimeMs: 300001,
      },
      dependencies,
    );

    expect(result.reason).toBe(
      'no_candidates',
    );

    expect(
      dependencies.completeJob,
    ).toHaveBeenCalledWith(
      expect.anything(),
      'ai_job:cron:300000',
      'dispatch-lease',
    );
  });

  it('reserves one batch and releases its lease', async () => {
    const dependencies = makeDependencies();

    const result = await dispatchAiBacklogJob(
      makeEnv({
        AI_BACKLOG_STAGE_JOBS_ENABLED:
          'true',
        AI_BACKLOG_JOB_BATCH_SIZE: '2',
        AI_FAIR_SOURCE_PICKER_ENABLED:
          'true',
      }),
      {
        scheduledTimeMs: 300001,
        categoryId: 'crypto',
      },
      dependencies,
    );

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.dispatchId).toBe(
      'cron:300000:category:crypto',
    );
    expect(result.selectedCount).toBe(2);
    expect(result.reservedCount).toBe(2);

    expect(result.candidateIds).toEqual([
      'candidate-1',
      'candidate-2',
    ]);

    expect(
      dependencies.reserveCandidates,
    ).toHaveBeenCalledWith(
      expect.anything(),
      'ai_job:cron:300000',
      'dispatch-lease',
      [
        'candidate-1',
        'candidate-2',
      ],
    );

    expect(
      dependencies.releaseJobLease,
    ).toHaveBeenCalledWith(
      expect.anything(),
      'ai_job:cron:300000',
      'dispatch-lease',
      'dispatch_complete',
    );
  });

  it('completes the job after reservation conflict', async () => {
    const dependencies = makeDependencies({
      reserveCandidates: vi.fn(
        async () => [],
      ),
    });

    const result = await dispatchAiBacklogJob(
      makeEnv({
        AI_BACKLOG_STAGE_JOBS_ENABLED:
          'true',
      }),
      {
        scheduledTimeMs: 300001,
      },
      dependencies,
    );

    expect(result.reason).toBe(
      'reservation_conflict',
    );

    expect(
      dependencies.completeJob,
    ).toHaveBeenCalledWith(
      expect.anything(),
      'ai_job:cron:300000',
      'dispatch-lease',
    );
  });


  it(
    'reuses durable items found after an empty reservation result',
    async () => {
      const lateVisibleItems = [
        makeJobItem(
          'candidate-late-visible',
          0,
        ),
      ];

      let reservationAttempted = false;

      const getJobItems = vi.fn(
        async () => (
          reservationAttempted
            ? lateVisibleItems
            : []
        ),
      );

      const reserveCandidates = vi.fn(
        async () => {
          reservationAttempted = true;
          return [];
        },
      );

      const dependencies = makeDependencies({
        getJobItems,
        reserveCandidates,
      });

      const result = await dispatchAiBacklogJob(
        makeEnv({
          AI_BACKLOG_STAGE_JOBS_ENABLED:
            'true',
        }),
        {
          scheduledTimeMs: 300001,
        },
        dependencies,
      );

      expect(result.ok).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.reason).toBe(
        'existing_job_reused',
      );
      expect(result.reusedExistingJob).toBe(true);
      expect(result.reservedCount).toBe(1);
      expect(result.candidateIds).toEqual([
        'candidate-late-visible',
      ]);

      expect(
        getJobItems.mock.calls.length,
      ).toBeGreaterThanOrEqual(2);

      expect(
        dependencies.releaseJobLease,
      ).toHaveBeenCalledWith(
        expect.anything(),
        'ai_job:cron:300000',
        'dispatch-lease',
        'dispatch_complete',
      );

      expect(
        dependencies.completeJob,
      ).not.toHaveBeenCalled();
    },
  );

it('keeps each job scoped to one category', async () => {
  const candidates = [
    makeCandidate('crypto-1', 'crypto'),
    makeCandidate('design-1', 'design'),
    makeCandidate('crypto-2', 'crypto'),
  ];

  const dependencies = makeDependencies({
    fetchCandidates: vi.fn(
      async () => candidates,
    ),
  });

  const result = await dispatchAiBacklogJob(
    makeEnv({
      AI_BACKLOG_STAGE_JOBS_ENABLED:
        'true',
      AI_BACKLOG_JOB_BATCH_SIZE: '10',
    }),
    {
      scheduledTimeMs: 300001,
    },
    dependencies,
  );

  expect(result.candidateIds).toEqual([
    'crypto-1',
    'crypto-2',
  ]);

  expect(
    dependencies.reserveCandidates,
  ).toHaveBeenCalledWith(
    expect.anything(),
    'ai_job:cron:300000',
    'dispatch-lease',
    [
      'crypto-1',
      'crypto-2',
    ],
  );
});

});
