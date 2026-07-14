import type {
  AICandidateRow,
  AIBacklogJobItemRow,
  AIBacklogJobRow,
  AIBacklogJobStage,
  Env,
} from '../types';

const DEFAULT_SLOT_MS = 5 * 60 * 1000;
const DEFAULT_LEASE_SECONDS = 5 * 60;

export type AIBacklogCheckpoint =
  | 'score'
  | 'gate'
  | 'duplicate'
  | 'translation'
  | 'persist';

interface CreateJobInput {
  dispatchId: string;
  source: string;
  scheduledTimeMs?: number | null;
}

interface CheckpointInput {
  jobId: string;
  candidateId: string;
  checkpoint: AIBacklogCheckpoint;
  result: unknown;
  lastError?: string | null;
  incrementProviderAttempt?: boolean;
}

const CHECKPOINT_COLUMNS: Record<
  AIBacklogCheckpoint,
  { column: string; status: string }
> = {
  score: {
    column: 'score_result_json',
    status: 'scored',
  },
  gate: {
    column: 'gate_result_json',
    status: 'gated',
  },
  duplicate: {
    column: 'duplicate_result_json',
    status: 'duplicate_checked',
  },
  translation: {
    column: 'translation_result_json',
    status: 'translated',
  },
  persist: {
    column: 'persist_result_json',
    status: 'persisted',
  },
};

function safePositiveInteger(
  value: number,
  fallback: number,
  max: number,
): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.min(Math.floor(value), max));
}

export function buildAiBacklogDispatchId(
  scheduledTimeMs: number,
  slotMs = DEFAULT_SLOT_MS,
): string {
  const safeSlotMs = safePositiveInteger(
    slotMs,
    DEFAULT_SLOT_MS,
    24 * 60 * 60 * 1000,
  );

  const safeTime = Number.isFinite(scheduledTimeMs)
    ? Math.max(0, Math.floor(scheduledTimeMs))
    : 0;

  const slotStart = Math.floor(safeTime / safeSlotMs) * safeSlotMs;

  return `cron:${slotStart}`;
}

export function buildAiBacklogJobId(dispatchId: string): string {
  const normalized = String(dispatchId ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9:_-]+/g, '_')
    .slice(0, 100);

  if (!normalized) {
    throw new Error('dispatch_id_required');
  }

  return `ai_job:${normalized}`;
}

export async function createOrGetAiBacklogJob(
  env: Env,
  input: CreateJobInput,
): Promise<AIBacklogJobRow | null> {
  const dispatchId = String(input.dispatchId ?? '').trim();
  const source = String(input.source ?? '').trim();

  if (!dispatchId) throw new Error('dispatch_id_required');
  if (!source) throw new Error('job_source_required');

  const jobId = buildAiBacklogJobId(dispatchId);

  await env.DB.prepare(`
    INSERT OR IGNORE INTO ai_backlog_jobs (
      id,
      dispatch_id,
      source,
      status,
      stage,
      scheduled_time_ms,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, 'pending', 'created', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).bind(
    jobId,
    dispatchId,
    source,
    input.scheduledTimeMs ?? null,
  ).run();

  return env.DB.prepare(`
    SELECT *
    FROM ai_backlog_jobs
    WHERE dispatch_id = ?
    LIMIT 1
  `).bind(dispatchId).first<AIBacklogJobRow>();
}

export async function reserveCandidatesForAiBacklogJob(
  env: Env,
  jobId: string,
  candidateIds: string[],
): Promise<AIBacklogJobItemRow[]> {
  const uniqueIds = Array.from(
    new Set(
      candidateIds
        .map(id => String(id ?? '').trim())
        .filter(Boolean),
    ),
  );

  if (uniqueIds.length === 0) return [];

  const statements: D1PreparedStatement[] = [];

  uniqueIds.forEach((candidateId, ordinal) => {
    statements.push(
      env.DB.prepare(`
        UPDATE ai_candidate_queue
        SET processing_job_id = ?
        WHERE id = ?
          AND status IN ('pending', 'needs_translation')
          AND (
            processing_job_id IS NULL
            OR processing_job_id = ?
          )
      `).bind(jobId, candidateId, jobId),
    );

    statements.push(
      env.DB.prepare(`
        INSERT OR IGNORE INTO ai_backlog_job_items (
          job_id,
          candidate_id,
          ordinal,
          status,
          created_at,
          updated_at
        )
        SELECT ?, id, ?, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        FROM ai_candidate_queue
        WHERE id = ?
          AND processing_job_id = ?
      `).bind(jobId, ordinal, candidateId, jobId),
    );
  });

  await env.DB.batch(statements);

  const rows = await env.DB.prepare(`
    SELECT *
    FROM ai_backlog_job_items
    WHERE job_id = ?
    ORDER BY ordinal ASC
  `).bind(jobId).all<AIBacklogJobItemRow>();

  return rows.results ?? [];
}

export async function claimAiBacklogJobLease(
  env: Env,
  jobId: string,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
): Promise<string | null> {
  const safeLeaseSeconds = safePositiveInteger(
    leaseSeconds,
    DEFAULT_LEASE_SECONDS,
    60 * 60,
  );

  const leaseToken = crypto.randomUUID();

  const result = await env.DB.prepare(`
    UPDATE ai_backlog_jobs
    SET
      status = 'processing',
      stage = CASE
        WHEN stage = 'created' THEN 'claimed'
        ELSE stage
      END,
      lease_token = ?,
      lease_expires_at = datetime('now', ?),
      delivery_attempts = delivery_attempts + 1,
      last_error = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND completed_at IS NULL
      AND status IN ('pending', 'processing', 'paused')
      AND (
        lease_expires_at IS NULL
        OR lease_expires_at <= CURRENT_TIMESTAMP
      )
  `).bind(
    leaseToken,
    `+${safeLeaseSeconds} seconds`,
    jobId,
  ).run();

  return (result.meta.changes ?? 0) > 0
    ? leaseToken
    : null;
}

export async function renewAiBacklogJobLease(
  env: Env,
  jobId: string,
  leaseToken: string,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
): Promise<boolean> {
  const safeLeaseSeconds = safePositiveInteger(
    leaseSeconds,
    DEFAULT_LEASE_SECONDS,
    60 * 60,
  );

  const result = await env.DB.prepare(`
    UPDATE ai_backlog_jobs
    SET
      lease_expires_at = datetime('now', ?),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND lease_token = ?
      AND status = 'processing'
      AND completed_at IS NULL
  `).bind(
    `+${safeLeaseSeconds} seconds`,
    jobId,
    leaseToken,
  ).run();

  return (result.meta.changes ?? 0) > 0;
}

export async function advanceAiBacklogJobStage(
  env: Env,
  jobId: string,
  leaseToken: string,
  stage: AIBacklogJobStage,
  stageCursor = 0,
  batchContext: unknown = null,
): Promise<boolean> {
  const safeCursor = Number.isFinite(stageCursor)
    ? Math.max(0, Math.floor(stageCursor))
    : 0;

  const result = await env.DB.prepare(`
    UPDATE ai_backlog_jobs
    SET
      stage = ?,
      stage_cursor = ?,
      batch_context_json = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND lease_token = ?
      AND status = 'processing'
      AND completed_at IS NULL
  `).bind(
    stage,
    safeCursor,
    batchContext == null ? null : JSON.stringify(batchContext),
    jobId,
    leaseToken,
  ).run();

  return (result.meta.changes ?? 0) > 0;
}

export async function checkpointAiBacklogJobItem(
  env: Env,
  input: CheckpointInput,
): Promise<boolean> {
  const config = CHECKPOINT_COLUMNS[input.checkpoint];

  const result = await env.DB.prepare(`
    UPDATE ai_backlog_job_items
    SET
      ${config.column} = ?,
      status = ?,
      provider_attempts = provider_attempts + ?,
      last_error = ?,
      completed_at = CASE
        WHEN ? = 'persisted' THEN CURRENT_TIMESTAMP
        ELSE completed_at
      END,
      updated_at = CURRENT_TIMESTAMP
    WHERE job_id = ?
      AND candidate_id = ?
  `).bind(
    JSON.stringify(input.result ?? null),
    config.status,
    input.incrementProviderAttempt ? 1 : 0,
    input.lastError ?? null,
    config.status,
    input.jobId,
    input.candidateId,
  ).run();

  return (result.meta.changes ?? 0) > 0;
}

export async function releaseAiBacklogJobLease(
  env: Env,
  jobId: string,
  leaseToken: string,
  reason: string,
  nextRunAt: string | null = null,
): Promise<boolean> {
  const result = await env.DB.prepare(`
    UPDATE ai_backlog_jobs
    SET
      status = 'pending',
      lease_token = NULL,
      lease_expires_at = NULL,
      next_run_at = ?,
      last_error = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND lease_token = ?
      AND completed_at IS NULL
  `).bind(
    nextRunAt,
    String(reason ?? '').slice(0, 500),
    jobId,
    leaseToken,
  ).run();

  return (result.meta.changes ?? 0) > 0;
}

export async function completeAiBacklogJob(
  env: Env,
  jobId: string,
  leaseToken: string,
): Promise<boolean> {
  const statements = [
    env.DB.prepare(`
      UPDATE ai_backlog_jobs
      SET
        status = 'completed',
        stage = 'completed',
        lease_token = NULL,
        lease_expires_at = NULL,
        next_run_at = NULL,
        last_error = NULL,
        updated_at = CURRENT_TIMESTAMP,
        completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND lease_token = ?
        AND completed_at IS NULL
    `).bind(jobId, leaseToken),

    env.DB.prepare(`
      UPDATE ai_candidate_queue
      SET processing_job_id = NULL
      WHERE processing_job_id = ?
        AND EXISTS (
          SELECT 1
          FROM ai_backlog_jobs
          WHERE id = ?
            AND status = 'completed'
            AND completed_at IS NOT NULL
        )
    `).bind(jobId, jobId),
  ];

  const results = await env.DB.batch(statements);
  const jobResult = results[0];

  return (jobResult?.meta.changes ?? 0) > 0;
}

export async function getAiBacklogJobById(
  env: Env,
  jobId: string,
): Promise<AIBacklogJobRow | null> {
  return env.DB.prepare(`
    SELECT *
    FROM ai_backlog_jobs
    WHERE id = ?
    LIMIT 1
  `).bind(jobId).first<AIBacklogJobRow>();
}

export async function getNextRunnableAiBacklogJob(
  env: Env,
): Promise<AIBacklogJobRow | null> {
  return env.DB.prepare(`
    SELECT *
    FROM ai_backlog_jobs
    WHERE status = 'pending'
      AND completed_at IS NULL
      AND (
        next_run_at IS NULL
        OR next_run_at <= CURRENT_TIMESTAMP
      )
    ORDER BY
      CASE stage
        WHEN 'persisted' THEN 0
        WHEN 'translated' THEN 1
        WHEN 'duplicate_checked' THEN 2
        WHEN 'gated' THEN 3
        WHEN 'scored' THEN 4
        WHEN 'claimed' THEN 5
        ELSE 6
      END,
      created_at ASC
    LIMIT 1
  `).first<AIBacklogJobRow>();
}

export async function recoverExpiredAiBacklogJobLeases(
  env: Env,
): Promise<number> {
  const result = await env.DB.prepare(`
    UPDATE ai_backlog_jobs
    SET
      status = 'pending',
      lease_token = NULL,
      lease_expires_at = NULL,
      next_run_at = datetime(
        'now',
        '+2 minutes'
      ),
      last_error = 'recovered_expired_lease',
      updated_at = CURRENT_TIMESTAMP
    WHERE status = 'processing'
      AND completed_at IS NULL
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at <= CURRENT_TIMESTAMP
  `).run();

  return result.meta.changes ?? 0;
}

export async function markAiBacklogJobFailed(
  env: Env,
  jobId: string,
  leaseToken: string,
  reason: string,
): Promise<boolean> {
  const result = await env.DB.prepare(`
    UPDATE ai_backlog_jobs
    SET
      status = 'failed',
      lease_token = NULL,
      lease_expires_at = NULL,
      next_run_at = NULL,
      last_error = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND lease_token = ?
      AND completed_at IS NULL
  `).bind(
    String(reason ?? '').slice(0, 500),
    jobId,
    leaseToken,
  ).run();

  return (result.meta.changes ?? 0) > 0;
}



export interface AIBacklogScoreCheckpointInput {
  candidateId: string;
  result: unknown;
}

export interface AIBacklogProviderFailureResult {
  updated: boolean;
  failed: boolean;
}

export async function getAiBacklogJobCandidates(
  env: Env,
  jobId: string,
): Promise<AICandidateRow[]> {
  const rows = await env.DB.prepare(`
    SELECT candidate.*
    FROM ai_backlog_job_items AS job_item
    JOIN ai_candidate_queue AS candidate
      ON candidate.id = job_item.candidate_id
    WHERE job_item.job_id = ?
      AND candidate.processing_job_id = ?
    ORDER BY job_item.ordinal ASC
  `).bind(
    jobId,
    jobId,
  ).all<AICandidateRow>();

  return rows.results ?? [];
}

export async function checkpointAiBacklogJobScores(
  env: Env,
  jobId: string,
  checkpoints: AIBacklogScoreCheckpointInput[],
): Promise<number> {
  if (checkpoints.length === 0) return 0;

  const statements = checkpoints.map(checkpoint =>
    env.DB.prepare(`
      UPDATE ai_backlog_job_items
      SET
        score_result_json = ?,
        status = 'scored',
        provider_attempts = provider_attempts + 1,
        last_error = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ?
        AND candidate_id = ?
        AND score_result_json IS NULL
        AND status != 'failed'
    `).bind(
      JSON.stringify(checkpoint.result ?? null),
      jobId,
      checkpoint.candidateId,
    )
  );

  const results = await env.DB.batch(statements);

  return results.reduce(
    (total, result) =>
      total + Number(result.meta.changes ?? 0),
    0,
  );
}

export async function failAiBacklogJobItem(
  env: Env,
  jobId: string,
  candidateId: string,
  reason: string,
): Promise<boolean> {
  const safeReason = String(reason ?? '')
    .slice(0, 500);

  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE ai_backlog_job_items
      SET
        status = 'failed',
        last_error = ?,
        updated_at = CURRENT_TIMESTAMP,
        completed_at = CURRENT_TIMESTAMP
      WHERE job_id = ?
        AND candidate_id = ?
        AND status != 'failed'
    `).bind(
      safeReason,
      jobId,
      candidateId,
    ),

    env.DB.prepare(`
      UPDATE ai_candidate_queue
      SET
        status = 'failed',
        last_error = ?,
        scored_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND processing_job_id = ?
    `).bind(
      safeReason,
      candidateId,
      jobId,
    ),
  ]);

  return Number(
    results[0]?.meta.changes ?? 0,
  ) > 0;
}

export async function recordAiBacklogProviderFailure(
  env: Env,
  jobId: string,
  candidateId: string,
  reason: string,
  maxAttempts: number,
): Promise<AIBacklogProviderFailureResult> {
  const safeReason = String(reason ?? '')
    .slice(0, 500);

  const safeMaxAttempts = Number.isFinite(maxAttempts)
    ? Math.max(1, Math.min(Math.floor(maxAttempts), 20))
    : 2;

  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE ai_backlog_job_items
      SET
        provider_attempts = provider_attempts + 1,
        status = CASE
          WHEN provider_attempts + 1 >= ?
            THEN 'failed'
          ELSE status
        END,
        last_error = ?,
        completed_at = CASE
          WHEN provider_attempts + 1 >= ?
            THEN CURRENT_TIMESTAMP
          ELSE completed_at
        END,
        updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ?
        AND candidate_id = ?
        AND score_result_json IS NULL
        AND status != 'failed'
    `).bind(
      safeMaxAttempts,
      safeReason,
      safeMaxAttempts,
      jobId,
      candidateId,
    ),

    env.DB.prepare(`
      UPDATE ai_candidate_queue
      SET
        status = 'failed',
        last_error = ?,
        scored_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND processing_job_id = ?
        AND EXISTS (
          SELECT 1
          FROM ai_backlog_job_items
          WHERE job_id = ?
            AND candidate_id = ?
            AND status = 'failed'
        )
    `).bind(
      safeReason,
      candidateId,
      jobId,
      jobId,
      candidateId,
    ),
  ]);

  return {
    updated:
      Number(results[0]?.meta.changes ?? 0) > 0,
    failed:
      Number(results[1]?.meta.changes ?? 0) > 0,
  };
}



export interface AIBacklogTranslationFailureResult {
  updated: boolean;
  failed: boolean;
  failures: number;
}

export async function recordAiBacklogTranslationFailure(
  env: Env,
  jobId: string,
  candidateId: string,
  reason: string,
  maxFailures: number,
): Promise<AIBacklogTranslationFailureResult> {
  const safeReason = String(reason ?? '')
    .slice(0, 500);

  const safeMaxFailures =
    Number.isFinite(maxFailures)
      ? Math.max(
          1,
          Math.min(
            Math.floor(maxFailures),
            20,
          ),
        )
      : 3;

  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE ai_backlog_job_items
      SET
        translation_failures =
          translation_failures + 1,
        provider_attempts =
          provider_attempts + 1,
        status = CASE
          WHEN translation_failures + 1 >= ?
            THEN 'failed'
          ELSE status
        END,
        last_error = ?,
        completed_at = CASE
          WHEN translation_failures + 1 >= ?
            THEN CURRENT_TIMESTAMP
          ELSE completed_at
        END,
        updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ?
        AND candidate_id = ?
        AND translation_result_json IS NULL
        AND status != 'failed'
    `).bind(
      safeMaxFailures,
      safeReason,
      safeMaxFailures,
      jobId,
      candidateId,
    ),

    env.DB.prepare(`
      UPDATE ai_candidate_queue
      SET
        status = 'failed',
        last_error = ?,
        scored_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND processing_job_id = ?
        AND EXISTS (
          SELECT 1
          FROM ai_backlog_job_items
          WHERE job_id = ?
            AND candidate_id = ?
            AND status = 'failed'
        )
    `).bind(
      safeReason,
      candidateId,
      jobId,
      jobId,
      candidateId,
    ),
  ]);

  const row = await env.DB.prepare(`
    SELECT
      status,
      translation_failures
    FROM ai_backlog_job_items
    WHERE job_id = ?
      AND candidate_id = ?
    LIMIT 1
  `).bind(
    jobId,
    candidateId,
  ).first<{
    status: string;
    translation_failures: number;
  }>();

  return {
    updated:
      Number(
        results[0]?.meta.changes ?? 0,
      ) > 0,
    failed:
      row?.status === 'failed',
    failures:
      Number(
        row?.translation_failures ?? 0,
      ),
  };
}

export interface AIBacklogDuplicateCheckpointInput {
  candidateId: string;
  result: unknown;
}

export async function checkpointAiBacklogJobDuplicates(
  env: Env,
  jobId: string,
  checkpoints:
    AIBacklogDuplicateCheckpointInput[],
): Promise<number> {
  if (checkpoints.length === 0) return 0;

  const statements = checkpoints.map(
    checkpoint => env.DB.prepare(`
      UPDATE ai_backlog_job_items
      SET
        duplicate_result_json = ?,
        status = 'duplicate_checked',
        last_error = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ?
        AND candidate_id = ?
        AND duplicate_result_json IS NULL
        AND status != 'failed'
    `).bind(
      JSON.stringify(
        checkpoint.result ?? null,
      ),
      jobId,
      checkpoint.candidateId,
    ),
  );

  const results =
    await env.DB.batch(statements);

  return results.reduce(
    (total, result) =>
      total
      + Number(
          result.meta.changes ?? 0,
        ),
    0,
  );
}



export interface AIBacklogTranslationCheckpointInput {
  candidateId: string;
  result: unknown;
}

export async function checkpointAiBacklogJobTranslations(
  env: Env,
  jobId: string,
  checkpoints:
    AIBacklogTranslationCheckpointInput[],
): Promise<number> {
  if (checkpoints.length === 0) return 0;

  const statements = checkpoints.map(
    checkpoint => env.DB.prepare(`
      UPDATE ai_backlog_job_items
      SET
        translation_result_json = ?,
        status = 'translated',
        last_error = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ?
        AND candidate_id = ?
        AND translation_result_json IS NULL
        AND status != 'failed'
    `).bind(
      JSON.stringify(
        checkpoint.result ?? null,
      ),
      jobId,
      checkpoint.candidateId,
    ),
  );

  const results =
    await env.DB.batch(statements);

  return results.reduce(
    (total, result) =>
      total
      + Number(
          result.meta.changes ?? 0,
        ),
    0,
  );
}



export async function getAiBacklogJobItems(
  env: Env,
  jobId: string,
): Promise<AIBacklogJobItemRow[]> {
  const rows = await env.DB.prepare(`
    SELECT *
    FROM ai_backlog_job_items
    WHERE job_id = ?
    ORDER BY ordinal ASC
  `).bind(jobId).all<AIBacklogJobItemRow>();

  return rows.results ?? [];
}
