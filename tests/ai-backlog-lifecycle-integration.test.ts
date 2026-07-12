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
  getNextRunnableAiBacklogJob,
  recoverExpiredAiBacklogJobLeases,
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
  AIBacklogJobStage,
  AIBacklogJobStatus,
  Env,
} from '../apps/worker-api/src/types';

let db: FakeD1;
let env: Env;

beforeEach(() => {
  db = makeTestDb();

  env = {
    DB: db,
    AI_BACKLOG_STAGE_JOBS_ENABLED: 'true',
  } as unknown as Env;
});

function insertDurableJob(
  jobId = 'job-integration-1',
  candidateId = 'candidate-integration-1',
): void {
  const normalizedItem = {
    platform: 'x',
    sourceAccount: 'integration-source',
    sourceUrl:
      `https://example.com/${candidateId}`,
    postId: candidateId,
    publishedAt: 1783800000,
    text: 'Integration candidate',
    media: [],
    engagementLikes: 0,
    engagementShares: 0,
    engagementViews: 0,
    isReply: false,
    isRetweet: false,
    isQuote: false,
    mediaUrlExpiresSoon: false,
  };

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
      processing_job_id
    )
    VALUES (
      '${candidateId}',
      'source-integration',
      NULL,
      'crypto',
      'x',
      'integration-source',
      'https://example.com/${candidateId}',
      '${candidateId}',
      1783800000,
      '${JSON.stringify(normalizedItem).replaceAll("'", "''")}',
      '["url:${candidateId}"]',
      100,
      'pending',
      0,
      '${jobId}'
    );

    INSERT INTO ai_backlog_jobs (
      id,
      dispatch_id,
      source,
      status,
      stage,
      stage_cursor,
      scheduled_time_ms,
      delivery_attempts
    )
    VALUES (
      '${jobId}',
      'integration:slot:1',
      'integration',
      'pending',
      'created',
      0,
      1783800000000,
      0
    );

    INSERT INTO ai_backlog_job_items (
      job_id,
      candidate_id,
      ordinal,
      status,
      provider_attempts
    )
    VALUES (
      '${jobId}',
      '${candidateId}',
      0,
      'pending',
      0
    );
  `);
}

function checkpointHandler(
  itemStatus:
    | 'scored'
    | 'gated'
    | 'duplicate_checked'
    | 'translated'
    | 'persisted',
  column:
    | 'score_result_json'
    | 'gate_result_json'
    | 'duplicate_result_json'
    | 'translation_result_json'
    | 'persist_result_json',
): AIBacklogStageHandler {
  return async ({
    env: handlerEnv,
    job,
    items,
  }) => {
    for (const item of items) {
      const result = await handlerEnv.DB.prepare(`
        UPDATE ai_backlog_job_items
        SET
          status = ?,
          ${column} = ?,
          completed_at = CASE
            WHEN ? = 'persisted'
              THEN CURRENT_TIMESTAMP
            ELSE completed_at
          END,
          updated_at = CURRENT_TIMESTAMP
        WHERE job_id = ?
          AND candidate_id = ?
          AND status != 'failed'
      `).bind(
        itemStatus,
        JSON.stringify({
          stage: itemStatus,
          candidateId: item.candidate_id,
        }),
        itemStatus,
        job.id,
        item.candidate_id,
      ).run();

      if (
        Number(result.meta.changes ?? 0)
        !== 1
      ) {
        throw new Error(
          `checkpoint_failed:${itemStatus}:${item.candidate_id}`,
        );
      }

      if (itemStatus === 'persisted') {
        await handlerEnv.DB.prepare(`
          UPDATE ai_candidate_queue
          SET
            status = 'queued',
            last_error = NULL
          WHERE id = ?
            AND processing_job_id = ?
        `).bind(
          item.candidate_id,
          job.id,
        ).run();
      }
    }

    return {
      stageCursor: items.length,
      batchContext: {
        checkpoint: itemStatus,
        itemCount: items.length,
      },
    };
  };
}

function makeHandlers():
  AIBacklogStageHandlers {
  return {
    score:
      checkpointHandler(
        'scored',
        'score_result_json',
      ),

    gate:
      checkpointHandler(
        'gated',
        'gate_result_json',
      ),

    duplicate:
      checkpointHandler(
        'duplicate_checked',
        'duplicate_result_json',
      ),

    translation:
      checkpointHandler(
        'translated',
        'translation_result_json',
      ),

    persist:
      checkpointHandler(
        'persisted',
        'persist_result_json',
      ),
  };
}

function readJob(
  jobId = 'job-integration-1',
): {
  status: AIBacklogJobStatus;
  stage: AIBacklogJobStage;
  lease_token: string | null;
  completed_at: string | null;
} {
  const row = db.get<{
    status: AIBacklogJobStatus;
    stage: AIBacklogJobStage;
    lease_token: string | null;
    completed_at: string | null;
  }>(`
    SELECT
      status,
      stage,
      lease_token,
      completed_at
    FROM ai_backlog_jobs
    WHERE id = '${jobId}'
  `);

  if (!row) {
    throw new Error(
      `job_not_found:${jobId}`,
    );
  }

  return row;
}

describe(
  'AI backlog durable lifecycle with real SQLite',
  () => {
    it('advances one stage per worker invocation and completes the job', async () => {
      insertDurableJob();

      const handlers = makeHandlers();

      const dependencies:
        AIBacklogJobWorkerDependencies = {
          recoverExpiredLeases:
            recoverExpiredAiBacklogJobLeases,

          getNextJob:
            getNextRunnableAiBacklogJob,

          runStep: (
            stepEnv,
            jobId,
          ) => runAiBacklogJobStep(
            stepEnv,
            jobId,
            handlers,
          ),
        };

      const expectedStages:
        AIBacklogJobStage[] = [
          'scored',
          'gated',
          'duplicate_checked',
          'translated',
          'persisted',
          'completed',
        ];

      for (
        const expectedStage
        of expectedStages
      ) {
        const result =
          await runAiBacklogJobWorker(
            env,
            dependencies,
          );

        expect(result.ok).toBe(true);
        expect(result.skipped).toBe(false);
        expect(result.jobId).toBe(
          'job-integration-1',
        );

        const job = readJob();

        expect(job.stage).toBe(
          expectedStage,
        );

        expect(job.lease_token).toBeNull();
      }

      const completedJob = readJob();

      expect(completedJob.status).toBe(
        'completed',
      );

      expect(
        completedJob.completed_at,
      ).not.toBeNull();

      const item = db.get<{
        status: string;
        completed_at: string | null;
      }>(`
        SELECT
          status,
          completed_at
        FROM ai_backlog_job_items
        WHERE job_id =
          'job-integration-1'
          AND candidate_id =
          'candidate-integration-1'
      `);

      expect(item?.status).toBe(
        'persisted',
      );

      expect(
        item?.completed_at,
      ).not.toBeNull();

      const candidate = db.get<{
        status: string;
        processing_job_id: string | null;
      }>(`
        SELECT
          status,
          processing_job_id
        FROM ai_candidate_queue
        WHERE id =
          'candidate-integration-1'
      `);

      expect(candidate?.status).toBe(
        'queued',
      );

      expect(
        candidate?.processing_job_id,
      ).toBeNull();

      const noMoreWork =
        await runAiBacklogJobWorker(
          env,
          dependencies,
        );

      expect(noMoreWork).toEqual({
        ok: true,
        skipped: true,
        recoveredLeases: 0,
        reason: 'no_runnable_job',
      });
    });

    it('recovers an expired lease and makes the job runnable again', async () => {
      insertDurableJob(
        'job-expired-1',
        'candidate-expired-1',
      );

      db.exec(`
        UPDATE ai_backlog_jobs
        SET
          status = 'processing',
          stage = 'scored',
          lease_token = 'expired-token',
          lease_expires_at =
            '2000-01-01 00:00:00'
        WHERE id = 'job-expired-1';

        UPDATE ai_backlog_job_items
        SET
          status = 'scored',
          score_result_json =
            '{"score":90}'
        WHERE job_id = 'job-expired-1';
      `);

      const recovered =
        await recoverExpiredAiBacklogJobLeases(
          env,
        );

      expect(recovered).toBe(1);

      const job = readJob(
        'job-expired-1',
      );

      expect(job.status).toBe(
        'pending',
      );

      expect(job.stage).toBe(
        'scored',
      );

      expect(job.lease_token).toBeNull();

      const next =
        await getNextRunnableAiBacklogJob(
          env,
        );

      expect(next?.id).toBe(
        'job-expired-1',
      );

      expect(next?.stage).toBe(
        'scored',
      );
    });

    it('rolls back a failed FakeD1 batch atomically', async () => {
      db.exec(`
        CREATE TABLE batch_atomicity_test (
          id TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);

      const first = db.prepare(`
        INSERT INTO batch_atomicity_test (
          id,
          value
        )
        VALUES (?, ?)
      `).bind(
        'row-1',
        'first',
      );

      const duplicate = db.prepare(`
        INSERT INTO batch_atomicity_test (
          id,
          value
        )
        VALUES (?, ?)
      `).bind(
        'row-1',
        'duplicate',
      );

      await expect(
        db.batch([
          first,
          duplicate,
        ]),
      ).rejects.toThrow();

      const count = db.get<{
        count: number;
      }>(`
        SELECT COUNT(*) AS count
        FROM batch_atomicity_test
      `);

      expect(count?.count).toBe(0);
    });
  },
);
