import {
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import {
  makeTestDb,
  type FakeD1,
} from './helpers/fake-d1';

import {
  dispatchAiBacklogJob,
} from '../apps/worker-api/src/services/ai-backlog-dispatcher';

import {
  runAiBacklogCronTick,
} from '../apps/worker-api/src/services/ai-backlog-cron';

import {
  getNextRunnableAiBacklogJob,
  recoverExpiredAiBacklogJobLeases,
  recoverStaleEmptyAiBacklogJobs,
  reserveCandidatesForAiBacklogJob,
} from '../apps/worker-api/src/services/ai-backlog-jobs';

import {
  runAiBacklogJobStep,
  type AIBacklogStageHandler,
  type AIBacklogStageHandlers,
} from '../apps/worker-api/src/services/ai-backlog-stage-runner';

import {
  runAiBacklogJobWorker,
  type AIBacklogJobWorkerDependencies,
} from '../apps/worker-api/src/services/ai-backlog-worker';

import type {
  Env,
} from '../apps/worker-api/src/types';

let db: FakeD1;
let env: Env;

beforeEach(() => {
  db = makeTestDb();

  env = {
    DB: db,
    AI_BACKLOG_STAGE_JOBS_ENABLED: 'true',
    AI_BACKLOG_JOB_BATCH_SIZE: '8',
    AI_BACKLOG_JOB_DISPATCH_SLOT_MINUTES: '1',
    AI_SCORING_BATCH_SIZE: '8',
    AI_FAIR_SOURCE_PICKER_ENABLED: 'false',
    AI_CANDIDATE_MAX_AGE_HOURS: '96',
    AI_CANDIDATE_MAX_ATTEMPTS: '2',
  } as unknown as Env;
});

function sqlEscape(value: string): string {
  return value.replaceAll("'", "''");
}

function insertCandidate(
  candidateId: string,
  processingJobId: string | null = null,
  priority = 100,
): void {
  const normalizedItem = {
    platform: 'x',
    sourceAccount: 'recovery-source',
    sourceUrl:
      `https://x.com/test/status/${candidateId}`,
    postId: candidateId,
    publishedAt: 1784050000,
    text: `Recovery candidate ${candidateId}`,
    media: [],
    engagementLikes: 0,
    engagementShares: 0,
    engagementViews: 0,
    isReply: false,
    isRetweet: false,
    isQuote: false,
    mediaUrlExpiresSoon: false,
  };

  const processingValue = processingJobId === null
    ? 'NULL'
    : `'${sqlEscape(processingJobId)}'`;

  db.exec(`
    INSERT INTO ai_candidate_queue (
      id,
      source_id,
      run_id,
      category_id,
      platform,
      source_account,
      source_url,
      post_id,
      published_at,
      normalized_item_json,
      dedupe_keys_json,
      priority_score,
      status,
      attempt_count,
      processing_job_id,
      created_at
    )
    VALUES (
      '${sqlEscape(candidateId)}',
      'source-recovery',
      NULL,
      'crypto',
      'x',
      'recovery-source',
      'https://x.com/test/status/${sqlEscape(candidateId)}',
      '${sqlEscape(candidateId)}',
      1784050000,
      '${sqlEscape(JSON.stringify(normalizedItem))}',
      '["url:${sqlEscape(candidateId)}"]',
      ${priority},
      'pending',
      0,
      ${processingValue},
      CURRENT_TIMESTAMP
    );
  `);
}

function insertEmptyJob(
  jobId: string,
  stage: 'created' | 'claimed',
  ageMinutes: number,
  options: {
    status?: 'pending' | 'processing';
    leaseToken?: string | null;
    leaseExpiresAt?: string | null;
    updatedAgeMinutes?: number;
  } = {},
): void {
  const status = options.status ?? 'pending';
  const leaseToken = options.leaseToken == null
    ? 'NULL'
    : `'${sqlEscape(options.leaseToken)}'`;
  const leaseExpiresAt = options.leaseExpiresAt == null
    ? 'NULL'
    : `'${sqlEscape(options.leaseExpiresAt)}'`;
  const updatedAgeMinutes =
    options.updatedAgeMinutes ?? ageMinutes;

  db.exec(`
    INSERT INTO ai_backlog_jobs (
      id,
      dispatch_id,
      source,
      status,
      stage,
      stage_cursor,
      scheduled_time_ms,
      lease_token,
      lease_expires_at,
      delivery_attempts,
      last_error,
      created_at,
      updated_at
    )
    VALUES (
      '${sqlEscape(jobId)}',
      'recovery:${sqlEscape(jobId)}',
      'regression',
      '${status}',
      '${stage}',
      0,
      1784050000000,
      ${leaseToken},
      ${leaseExpiresAt},
      371,
      'job_has_no_items',
      datetime('now', '-${ageMinutes} minutes'),
      datetime('now', '-${updatedAgeMinutes} minutes')
    );
  `);
}

function insertJobItem(
  jobId: string,
  candidateId: string,
): void {
  db.exec(`
    INSERT INTO ai_backlog_job_items (
      job_id,
      candidate_id,
      ordinal,
      status,
      provider_attempts
    )
    VALUES (
      '${sqlEscape(jobId)}',
      '${sqlEscape(candidateId)}',
      0,
      'pending',
      0
    );
  `);
}

function makeHandlers(): AIBacklogStageHandlers {
  const completeStage: AIBacklogStageHandler =
    async ({ items }) => ({
      stageCursor: items.length,
    });

  return {
    score: completeStage,
    gate: completeStage,
    duplicate: completeStage,
    translation: completeStage,
    persist: completeStage,
  };
}

function makeWorkerDependencies():
  AIBacklogJobWorkerDependencies {
  const handlers = makeHandlers();

  return {
    recoverExpiredLeases:
      recoverExpiredAiBacklogJobLeases,
    recoverStaleEmptyJobs:
      recoverStaleEmptyAiBacklogJobs,
    getNextJob:
      getNextRunnableAiBacklogJob,
    runStep: (stepEnv, jobId) =>
      runAiBacklogJobStep(
        stepEnv,
        jobId,
        handlers,
      ),
  };
}

function readJobStatus(jobId: string): {
  status: string;
  stage: string;
  last_error: string | null;
  completed_at: string | null;
} | undefined {
  return db.get(`
    SELECT
      status,
      stage,
      last_error,
      completed_at
    FROM ai_backlog_jobs
    WHERE id = '${sqlEscape(jobId)}'
  `);
}

describe('AI backlog stale empty-job recovery', () => {
  it(
    'quarantines a poison job and dispatches pending candidates in the same cron tick',
    async () => {
      insertEmptyJob('job-poison', 'claimed', 10);

      for (let index = 0; index < 9; index++) {
        insertCandidate(
          `candidate-${index}`,
          null,
          100 - index,
        );
      }

      const workerDependencies =
        makeWorkerDependencies();

      const result = await runAiBacklogCronTick(
        env,
        Date.now(),
        {
          runWorker: stepEnv =>
            runAiBacklogJobWorker(
              stepEnv,
              workerDependencies,
            ),
          inspectQueueHealth: async () => ({
            enabled: false,
          }),
          dispatchJob: dispatchAiBacklogJob,
        },
      );

      expect(result.ok).toBe(true);
      expect(
        result.workerBefore?.recoveredEmptyJobs,
      ).toBe(1);
      expect(result.workerBefore?.reason).toBe(
        'no_runnable_job',
      );
      expect(result.dispatch?.reservedCount).toBe(8);
      expect(result.workerAfter?.step?.action).toBe(
        'score',
      );
      expect(result.workerAfter?.step?.nextStage).toBe(
        'scored',
      );

      expect(readJobStatus('job-poison')).toEqual({
        status: 'failed',
        stage: 'claimed',
        last_error:
          'stale_empty_job_quarantined',
        completed_at: null,
      });

      const newJobId = result.dispatch?.jobId;
      expect(newJobId).toBeTruthy();

      const newJob = db.get<{
        status: string;
        stage: string;
        item_count: number;
      }>(`
        SELECT
          job.status,
          job.stage,
          (
            SELECT COUNT(*)
            FROM ai_backlog_job_items AS item
            WHERE item.job_id = job.id
          ) AS item_count
        FROM ai_backlog_jobs AS job
        WHERE job.id = '${sqlEscape(newJobId!)}'
      `);

      expect(newJob).toEqual({
        status: 'pending',
        stage: 'scored',
        item_count: 8,
      });

      const reservedCount = db.get<{
        total: number;
      }>(`
        SELECT COUNT(*) AS total
        FROM ai_candidate_queue
        WHERE processing_job_id =
          '${sqlEscape(newJobId!)}'
      `);

      expect(reservedCount?.total).toBe(8);

      const remainingCount = db.get<{
        total: number;
      }>(`
        SELECT COUNT(*) AS total
        FROM ai_candidate_queue
        WHERE status = 'pending'
          AND processing_job_id IS NULL
      `);

      expect(remainingCount?.total).toBe(1);
    },
  );

  it(
    'does not select or quarantine a fresh empty job',
    async () => {
      insertEmptyJob('job-fresh', 'created', 0);

      expect(
        await getNextRunnableAiBacklogJob(env),
      ).toBeNull();

      expect(
        await recoverStaleEmptyAiBacklogJobs(env),
      ).toBe(0);

      expect(readJobStatus('job-fresh')?.status)
        .toBe('pending');
    },
  );

  it(
    'does not quarantine an old job that was updated recently',
    async () => {
      insertEmptyJob(
        'job-recently-touched',
        'claimed',
        20,
        { updatedAgeMinutes: 1 },
      );

      expect(
        await recoverStaleEmptyAiBacklogJobs(env),
      ).toBe(0);

      expect(
        readJobStatus('job-recently-touched')
          ?.status,
      ).toBe('pending');
    },
  );

  it(
    'does not quarantine a job with an active lease',
    async () => {
      insertEmptyJob(
        'job-active-lease',
        'claimed',
        10,
        {
          status: 'processing',
          leaseToken: 'active-lease-token',
          leaseExpiresAt: '2999-01-01 00:00:00',
        },
      );

      expect(
        await recoverStaleEmptyAiBacklogJobs(env),
      ).toBe(0);

      expect(
        readJobStatus('job-active-lease')
          ?.status,
      ).toBe('processing');
    },
  );

  it(
    'blocks reservation after the dispatch lease expires',
    async () => {
      const jobId = 'job-expired-dispatch-lease';
      const candidateId =
        'candidate-expired-dispatch-lease';
      const leaseToken = 'expired-dispatch-lease';

      insertEmptyJob(
        jobId,
        'claimed',
        10,
        {
          status: 'processing',
          leaseToken,
          leaseExpiresAt: '2000-01-01 00:00:00',
        },
      );

      insertCandidate(candidateId);

      const reserved =
        await reserveCandidatesForAiBacklogJob(
          env,
          jobId,
          leaseToken,
          [candidateId],
        );

      expect(reserved).toEqual([]);

      const candidate = db.get<{
        processing_job_id: string | null;
      }>(`
        SELECT processing_job_id
        FROM ai_candidate_queue
        WHERE id = '${sqlEscape(candidateId)}'
      `);

      expect(
        candidate?.processing_job_id ?? null,
      ).toBeNull();

      const itemCount = db.get<{
        total: number;
      }>(`
        SELECT COUNT(*) AS total
        FROM ai_backlog_job_items
        WHERE job_id = '${sqlEscape(jobId)}'
      `);

      expect(itemCount?.total).toBe(0);
    },
  );

  it(
    'blocks a late dispatcher after empty-job quarantine',
    async () => {
      const jobId = 'job-late-dispatcher';
      const candidateId = 'candidate-late-dispatcher';
      const leaseToken = 'stale-dispatch-lease';

      insertEmptyJob(
        jobId,
        'claimed',
        10,
        {
          status: 'processing',
          leaseToken,
          leaseExpiresAt: '2000-01-01 00:00:00',
        },
      );

      insertCandidate(candidateId);

      expect(
        await recoverExpiredAiBacklogJobLeases(env),
      ).toBe(1);

      db.exec(`
        UPDATE ai_backlog_jobs
        SET
          created_at = datetime('now', '-10 minutes'),
          updated_at = datetime('now', '-10 minutes')
        WHERE id = '${sqlEscape(jobId)}';
      `);

      expect(
        await recoverStaleEmptyAiBacklogJobs(env),
      ).toBe(1);

      const reserved =
        await reserveCandidatesForAiBacklogJob(
          env,
          jobId,
          leaseToken,
          [candidateId],
        );

      expect(reserved).toEqual([]);

      const candidate = db.get<{
        processing_job_id: string | null;
      }>(`
        SELECT processing_job_id
        FROM ai_candidate_queue
        WHERE id = '${sqlEscape(candidateId)}'
      `);

      expect(
        candidate?.processing_job_id ?? null,
      ).toBeNull();

      const itemCount = db.get<{
        total: number;
      }>(`
        SELECT COUNT(*) AS total
        FROM ai_backlog_job_items
        WHERE job_id = '${sqlEscape(jobId)}'
      `);

      expect(itemCount?.total).toBe(0);
    },
  );

  it(
    'does not quarantine a job that already has an item',
    async () => {
      insertEmptyJob('job-with-item', 'claimed', 10);
      insertCandidate(
        'candidate-with-item',
        'job-with-item',
      );
      insertJobItem(
        'job-with-item',
        'candidate-with-item',
      );

      expect(
        await recoverStaleEmptyAiBacklogJobs(env),
      ).toBe(0);

      expect(
        (await getNextRunnableAiBacklogJob(env))?.id,
      ).toBe('job-with-item');
    },
  );

  it(
    'does not quarantine or release candidate ownership when no job item exists',
    async () => {
      insertEmptyJob(
        'job-owned-without-item',
        'claimed',
        10,
      );
      insertCandidate(
        'candidate-owned',
        'job-owned-without-item',
      );

      expect(
        await recoverStaleEmptyAiBacklogJobs(env),
      ).toBe(0);
      expect(
        await getNextRunnableAiBacklogJob(env),
      ).toBeNull();

      const candidate = db.get<{
        processing_job_id: string | null;
      }>(`
        SELECT processing_job_id
        FROM ai_candidate_queue
        WHERE id = 'candidate-owned'
      `);

      expect(candidate?.processing_job_id).toBe(
        'job-owned-without-item',
      );
    },
  );

  it(
    'quarantines multiple stale poison jobs once and is idempotent',
    async () => {
      insertEmptyJob('job-poison-a', 'created', 10);
      insertEmptyJob('job-poison-b', 'claimed', 12);

      expect(
        await recoverStaleEmptyAiBacklogJobs(env),
      ).toBe(2);
      expect(
        await recoverStaleEmptyAiBacklogJobs(env),
      ).toBe(0);

      expect(readJobStatus('job-poison-a')?.status)
        .toBe('failed');
      expect(readJobStatus('job-poison-b')?.status)
        .toBe('failed');
    },
  );
});
