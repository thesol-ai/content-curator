import type { Env } from '../types';
import { recordRunEvent } from './run-events';
import { runCuration } from './curation-orchestrator';

export type ApifyDatasetJobStatus = 'ready' | 'processing' | 'completed' | 'failed';

export interface ApifyDatasetJob {
  id: string;
  source_id: string;
  dataset_id: string;
  actor_run_id: string | null;
  rotation_run_id: string | null;
  category_id: string | null;
  platform: string | null;
  status: ApifyDatasetJobStatus;
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

export interface RecordApifyDatasetJobInput {
  sourceId: string;
  datasetId: string;
  actorRunId?: string | null;
  rotationRunId?: string | null;
  categoryId?: string | null;
  platform?: string | null;
}

export function isDatasetJobProcessorEnabled(env: Env): boolean {
  return String((env as any).APIFY_DATASET_JOB_PROCESSOR_ENABLED ?? '').toLowerCase() === 'true';
}

export function isDirectPostRotationCurationEnabled(env: Env): boolean {
  return String((env as any).APIFY_POST_ROTATION_DIRECT_CURATION_ENABLED ?? 'true').toLowerCase() === 'true';
}

export function isWebhookDirectCurationEnabled(env: Env): boolean {
  return String((env as any).APIFY_WEBHOOK_DIRECT_CURATION_ENABLED ?? 'true').toLowerCase() === 'true';
}

export function getDatasetJobMaxAttempts(env: Env): number {
  const n = Number((env as any).APIFY_DATASET_JOB_MAX_ATTEMPTS ?? 3);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 10) : 3;
}

export function getDatasetJobStaleMinutes(env: Env): number {
  const n = Number((env as any).APIFY_DATASET_JOB_STALE_MINUTES ?? 15);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 120) : 15;
}

export async function recordApifyDatasetJob(
  env: Env,
  input: RecordApifyDatasetJobInput,
): Promise<{ inserted: boolean; id: string | null }> {
  try {
    const sourceId = sanitizeId(input.sourceId);
    const datasetId = sanitizeDatasetId(input.datasetId);
    if (!sourceId || !datasetId) return { inserted: false, id: null };

    const id = makeJobId();

    const insert = await env.DB.prepare(`
      INSERT OR IGNORE INTO apify_dataset_jobs (
        id, source_id, dataset_id, actor_run_id, rotation_run_id,
        category_id, platform, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).bind(
      id,
      sourceId,
      datasetId,
      input.actorRunId ?? null,
      input.rotationRunId ?? null,
      input.categoryId ?? null,
      input.platform ?? null,
    ).run();

    const inserted = (insert.meta.changes ?? 0) > 0;

    if (!inserted) {
      await env.DB.prepare(`
        UPDATE apify_dataset_jobs
        SET actor_run_id=COALESCE(actor_run_id, ?),
            rotation_run_id=COALESCE(rotation_run_id, ?),
            category_id=COALESCE(category_id, ?),
            platform=COALESCE(platform, ?),
            updated_at=CURRENT_TIMESTAMP
        WHERE source_id=? AND dataset_id=?
      `).bind(
        input.actorRunId ?? null,
        input.rotationRunId ?? null,
        input.categoryId ?? null,
        input.platform ?? null,
        sourceId,
        datasetId,
      ).run();
    }

    const row = await env.DB.prepare(`
      SELECT id FROM apify_dataset_jobs
      WHERE source_id=? AND dataset_id=?
      LIMIT 1
    `).bind(sourceId, datasetId).first<{ id: string }>();

    await recordRunEvent(env, {
      runId: input.rotationRunId ?? `apify_dataset_job_${Date.now()}`,
      eventType: inserted ? 'apify.dataset_job.created' : 'apify.dataset_job.seen_existing',
      phase: 'apify_dataset_job',
      sourceId,
      datasetId,
      actorRunId: input.actorRunId ?? undefined,
      categoryId: input.categoryId ?? undefined,
      platform: input.platform ?? undefined,
      metadata: { jobId: row?.id ?? id },
    });

    return { inserted, id: row?.id ?? id };
  } catch (err) {
    console.warn('[ApifyDatasetJobs] record skipped:', err instanceof Error ? err.message : String(err));
    return { inserted: false, id: null };
  }
}

export async function recoverStaleApifyDatasetJobs(env: Env): Promise<number> {
  const staleMinutes = getDatasetJobStaleMinutes(env);
  const maxAttempts = getDatasetJobMaxAttempts(env);

  const res = await env.DB.prepare(`
    UPDATE apify_dataset_jobs
    SET status=CASE WHEN attempt_count < ? THEN 'ready' ELSE 'failed' END,
        last_error=CASE WHEN attempt_count < ? THEN 'recovered_stale_processing' ELSE 'max_attempts_after_stale_processing' END,
        claimed_at=NULL,
        updated_at=CURRENT_TIMESTAMP
    WHERE status='processing'
      AND claimed_at <= datetime('now', ?)
  `).bind(maxAttempts, maxAttempts, `-${staleMinutes} minutes`).run();

  return res.meta.changes ?? 0;
}

export async function claimNextApifyDatasetJob(env: Env): Promise<ApifyDatasetJob | null> {
  await recoverStaleApifyDatasetJobs(env);

  const maxAttempts = getDatasetJobMaxAttempts(env);

  const rows = await env.DB.prepare(`
    SELECT *
    FROM apify_dataset_jobs
    WHERE status IN ('ready', 'failed')
      AND attempt_count < ?
    ORDER BY created_at ASC
    LIMIT 5
  `).bind(maxAttempts).all<ApifyDatasetJob>();

  for (const row of rows.results ?? []) {
    const claimed = await env.DB.prepare(`
      UPDATE apify_dataset_jobs
      SET status='processing',
          attempt_count=attempt_count + 1,
          claimed_at=CURRENT_TIMESTAMP,
          last_error=NULL,
          updated_at=CURRENT_TIMESTAMP
      WHERE id=?
        AND status IN ('ready', 'failed')
        AND attempt_count < ?
    `).bind(row.id, maxAttempts).run();

    if ((claimed.meta.changes ?? 0) > 0) {
      const fresh = await env.DB.prepare(`
        SELECT * FROM apify_dataset_jobs WHERE id=? LIMIT 1
      `).bind(row.id).first<ApifyDatasetJob>();

      return fresh ?? null;
    }
  }

  return null;
}

export async function completeApifyDatasetJob(
  env: Env,
  jobId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await env.DB.prepare(`
    UPDATE apify_dataset_jobs
    SET status='completed',
        completed_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP,
        last_error=NULL
    WHERE id=?
  `).bind(jobId).run();

  await recordRunEvent(env, {
    runId: jobId,
    eventType: 'apify.dataset_job.completed',
    phase: 'apify_dataset_job',
    metadata,
  });
}

export async function failApifyDatasetJob(
  env: Env,
  job: ApifyDatasetJob,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);

  await env.DB.prepare(`
    UPDATE apify_dataset_jobs
    SET status='failed',
        last_error=?,
        claimed_at=NULL,
        updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).bind(message.slice(0, 1000), job.id).run();

  await recordRunEvent(env, {
    runId: job.id,
    eventType: 'apify.dataset_job.failed',
    phase: 'apify_dataset_job',
    severity: 'error',
    sourceId: job.source_id,
    datasetId: job.dataset_id,
    message: message.slice(0, 1000),
    metadata: { attemptCount: job.attempt_count },
  });
}


export interface RunNextApifyDatasetJobResult {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  jobId?: string;
  sourceId?: string;
  datasetId?: string;
  error?: string;
  curationRuns?: Array<{
    runId: string | null;
    ok: boolean;
    categoryId: string | null;
    platform: string | null;
    itemsNew: number;
    itemsAiSelected: number;
    itemsQueued: number;
    errors: number;
  }>;
}

export async function runNextApifyDatasetJob(env: Env): Promise<RunNextApifyDatasetJobResult> {
  if (!isDatasetJobProcessorEnabled(env)) {
    return { ok: true, skipped: true, reason: 'processor_disabled' };
  }

  const job = await claimNextApifyDatasetJob(env);
  if (!job) {
    return { ok: true, skipped: true, reason: 'no_ready_dataset_job' };
  }

  await recordRunEvent(env, {
    runId: job.id,
    eventType: 'apify.dataset_job.claimed',
    phase: 'apify_dataset_job',
    sourceId: job.source_id,
    datasetId: job.dataset_id,
    actorRunId: job.actor_run_id ?? undefined,
    categoryId: job.category_id ?? undefined,
    platform: job.platform ?? undefined,
    metadata: { attemptCount: job.attempt_count },
  });

  try {
    const results = await runCuration(
      env,
      { sourceId: job.source_id, datasetId: job.dataset_id },
      { forceCurationEnabled: true },
    );

    const curationRuns = results.map((r: any) => ({
      runId: r.runId ?? null,
      ok: Boolean(r.ok),
      categoryId: r.categoryId ?? null,
      platform: r.platform ?? null,
      itemsNew: Number(r.itemsNew ?? 0),
      itemsAiSelected: Number(r.itemsAiSelected ?? 0),
      itemsQueued: Number(r.itemsQueued ?? 0),
      errors: Array.isArray(r.errors) ? r.errors.length : 0,
    }));

    const failed = results.filter((r: any) => !r.ok);

    if (results.length === 0 || failed.length > 0) {
      const message = results.length === 0
        ? 'curation_returned_no_results'
        : `curation_failed:${failed.map((r: any) => r.runId ?? r.categoryId ?? 'unknown').join(',')}`;

      await failApifyDatasetJob(env, job, new Error(message));

      return {
        ok: false,
        skipped: false,
        reason: 'curation_failed',
        jobId: job.id,
        sourceId: job.source_id,
        datasetId: job.dataset_id,
        error: message,
        curationRuns,
      };
    }

    await completeApifyDatasetJob(env, job.id, { curationRuns });

    return {
      ok: true,
      skipped: false,
      jobId: job.id,
      sourceId: job.source_id,
      datasetId: job.dataset_id,
      curationRuns,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failApifyDatasetJob(env, job, err);

    return {
      ok: false,
      skipped: false,
      reason: 'curation_exception',
      jobId: job.id,
      sourceId: job.source_id,
      datasetId: job.dataset_id,
      error: message,
    };
  }
}

function makeJobId(): string {
  return `apify_ds_job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeId(value: unknown): string | null {
  const v = String(value ?? '').trim();
  return /^[\w-]{1,128}$/.test(v) ? v : null;
}

function sanitizeDatasetId(value: unknown): string | null {
  const v = String(value ?? '').trim();
  return /^[A-Za-z0-9]{8,40}$/.test(v) ? v : null;
}
