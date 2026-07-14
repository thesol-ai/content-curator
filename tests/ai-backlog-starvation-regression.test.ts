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
  type AIBacklogStageHandlers,
} from '../apps/worker-api/src/services/ai-backlog-stage-runner';

import {
  runAiBacklogJobWorker,
  type AIBacklogJobWorkerDependencies,
} from '../apps/worker-api/src/services/ai-backlog-worker';

import type {
  AIBacklogJobStage,
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

function insertJob(
  jobId: string,
  candidateId: string,
  stage: AIBacklogJobStage,
  itemStatus: string,
  createdAt: string,
): void {
  const normalizedItem = {
    platform: 'x',
    sourceAccount: 'regression-source',
    sourceUrl:
      `https://example.com/${candidateId}`,
    postId: candidateId,
    publishedAt: 1783800000,
    text: 'Regression candidate',
    media: [],
    engagementLikes: 0,
    engagementShares: 0,
    engagementViews: 0,
    isReply: false,
    isRetweet: false,
    isQuote: false,
    mediaUrlExpiresSoon: false,
  };

  const normalizedJson =
    JSON.stringify(normalizedItem)
      .replaceAll("'", "''");

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
      'source-regression',
      NULL,
      'crypto',
      'x',
      'regression-source',
      'https://example.com/${candidateId}',
      '${candidateId}',
      1783800000,
      '${normalizedJson}',
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
      delivery_attempts,
      created_at,
      updated_at
    )
    VALUES (
      '${jobId}',
      'regression:${jobId}',
      'regression',
      'pending',
      '${stage}',
      0,
      1783800000000,
      0,
      '${createdAt}',
      '${createdAt}'
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
      '${itemStatus}',
      1
    );
  `);
}

describe(
  'AI backlog starvation regression',
  () => {
    it(
      'does not let a repeatedly failing translated job starve a scored job',
      async () => {
        /*
         * The follower is older, but the blocker is
         * further ahead in the pipeline.
         */
        insertJob(
          'job-follower',
          'candidate-follower',
          'scored',
          'scored',
          '2026-07-13 18:35:00',
        );

        insertJob(
          'job-blocker',
          'candidate-blocker',
          'translated',
          'translated',
          '2026-07-13 18:36:00',
        );

        const handlers:
          AIBacklogStageHandlers = {
          score: async ({ items }) => ({
            stageCursor: items.length,
          }),

          gate: async ({ items }) => ({
            stageCursor: items.length,
          }),

          duplicate: async ({ items }) => ({
            stageCursor: items.length,
          }),

          translation: async ({ items }) => ({
            stageCursor: items.length,
          }),

          persist: async ({
            job,
            items,
          }) => {
            if (
              job.id === 'job-blocker'
            ) {
              throw new Error(
                'forced_persist_failure',
              );
            }

            return {
              stageCursor: items.length,
            };
          },
        };

        const dependencies:
          AIBacklogJobWorkerDependencies = {
          recoverExpiredLeases:
            recoverExpiredAiBacklogJobLeases,

          getNextJob:
            getNextRunnableAiBacklogJob,

          runStep: (
            stepEnv,
            jobId,
          ) =>
            runAiBacklogJobStep(
              stepEnv,
              jobId,
              handlers,
            ),
        };

        const first =
          await runAiBacklogJobWorker(
            env,
            dependencies,
          );

        expect(first.jobId).toBe(
          'job-blocker',
        );

        expect(first.ok).toBe(false);

        const second =
          await runAiBacklogJobWorker(
            env,
            dependencies,
          );

        /*
         * Desired behavior:
         * after the blocker fails once, another runnable
         * job must get a chance to progress.
         *
         * Without the cooldown, the blocker is selected
         * again and this assertion fails.
         */
        expect(second.jobId).toBe(
          'job-follower',
        );
      },

    );

    it(
      'lets another job run immediately after recovering an expired blocker lease',
      async () => {
        insertJob(
          'job-recovered-follower',
          'candidate-recovered-follower',
          'scored',
          'scored',
          '2026-07-13 18:35:00',
        );

        insertJob(
          'job-recovered-blocker',
          'candidate-recovered-blocker',
          'translated',
          'translated',
          '2026-07-13 18:36:00',
        );

        db.exec(`
          UPDATE ai_backlog_jobs
          SET
            status = 'processing',
            lease_token = 'expired-lease-token',
            lease_expires_at =
              '2000-01-01 00:00:00'
          WHERE id =
            'job-recovered-blocker';
        `);

        const handlers:
          AIBacklogStageHandlers = {
          score: async ({ items }) => ({
            stageCursor: items.length,
          }),

          gate: async ({ items }) => ({
            stageCursor: items.length,
          }),

          duplicate: async ({ items }) => ({
            stageCursor: items.length,
          }),

          translation: async ({ items }) => ({
            stageCursor: items.length,
          }),

          persist: async ({ items }) => ({
            stageCursor: items.length,
          }),
        };

        const dependencies:
          AIBacklogJobWorkerDependencies = {
          recoverExpiredLeases:
            recoverExpiredAiBacklogJobLeases,

          getNextJob:
            getNextRunnableAiBacklogJob,

          runStep: (
            stepEnv,
            jobId,
          ) =>
            runAiBacklogJobStep(
              stepEnv,
              jobId,
              handlers,
            ),
        };

        const first =
          await runAiBacklogJobWorker(
            env,
            dependencies,
          );

        expect(first.recoveredLeases).toBe(1);

        /*
         * The recovered blocker must yield for one turn.
         * Otherwise its more advanced stage keeps it ahead
         * of the scored follower indefinitely.
         */
        expect(first.jobId).toBe(
          'job-recovered-follower',
        );

        /*
         * The blocker must remain retryable. This verifies
         * that the fix delays it instead of dropping it.
         */
        db.exec(`
          UPDATE ai_backlog_jobs
          SET next_run_at =
            '2000-01-01 00:00:00'
          WHERE id =
            'job-recovered-blocker';
        `);

        const second =
          await runAiBacklogJobWorker(
            env,
            dependencies,
          );

        expect(second.jobId).toBe(
          'job-recovered-blocker',
        );
      },
    );
  },
);
