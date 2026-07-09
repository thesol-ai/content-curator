# Decouple Apify rotation from curation

## Problem

The scheduled Worker currently runs too many heavy tasks in one cron execution:

- Apify rotation
- post-rotation curation
- publish due items
- queue-health checks
- AI candidate drain
- cleanup

Cloudflare kills the scheduled worker with `Exceeded CPU Limit`, leaving datasets unprocessed.

## Goal

Make each heavy step durable and retryable.

Apify should only create a dataset job.
Curation should process dataset jobs separately.
AI scoring should drain candidates separately.
Publishing should remain frequent and lightweight.

## New flow

1. Apify rotation finishes and returns a dataset_id.
2. Worker records an `apify_dataset_jobs` row with status `ready`.
3. Dataset processor claims one `ready` job.
4. Processor runs curation for that dataset.
5. On success, job becomes `completed`.
6. On failure, job becomes `failed` or retryable.
7. AI backlog drain runs separately with a small batch.
8. Publish due runs frequently and independently.

## Required changes

- Add migration `0022_apify_dataset_jobs.sql`
- Add service `apify-dataset-jobs.ts`
- Update `apify-rotation-runner.ts` to record dataset jobs
- Update `apify-webhook.ts` to record jobs instead of direct curation
- Update `index.ts` scheduler to process only one heavy phase per tick
- Keep admin manual endpoints, but do not rely on them operationally

## Rollout

1. Add job table and record jobs in observe mode.
2. Verify jobs are created from Apify rotation.
3. Enable dataset processor.
4. Disable direct post-rotation curation.
5. Disable webhook direct curation.
6. Monitor:
   - ready job age
   - processing job age
   - completed jobs
   - failed jobs
   - pending candidates
   - publish queue

## Rollback

Disable the new scheduler flag and restore direct curation path temporarily.
