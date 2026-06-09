// ══════════════════════════════════════════════════════════════
// services/candidate-queue.ts
// Durable AI candidate backlog helpers.
//
// Phase 1 introduced this service without connecting it to the pipeline.
// Phase 2 adds safe claim/release/recovery helpers used by backlog drain.
// All behavior remains inert unless AI_CANDIDATE_BACKLOG_ENABLED === 'true'.
// ══════════════════════════════════════════════════════════════

import type { Env, AICandidateRow, AICandidateEnqueueInput, AICandidateStatus } from '../types';

// ── Config helpers ────────────────────────────────────────────

export function isCandidateBacklogEnabled(env: Env): boolean {
  return env.AI_CANDIDATE_BACKLOG_ENABLED === 'true';
}

export function isFairSourcePickerEnabled(env: Env): boolean {
  return env.AI_FAIR_SOURCE_PICKER_ENABLED === 'true';
}

export function getScoringBatchSize(env: Env): number {
  const v = parseInt(env.AI_SCORING_BATCH_SIZE ?? '10', 10);
  return isNaN(v) || v <= 0 ? 10 : v;
}

export function getMaxScoringBatchesPerRun(env: Env): number {
  const v = parseInt(env.AI_MAX_SCORING_BATCHES_PER_RUN ?? '2', 10);
  return isNaN(v) || v <= 0 ? 2 : v;
}

export function getCandidateBacklogDrainLimit(env: Env): number {
  const v = parseInt(env.AI_CANDIDATE_BACKLOG_DRAIN_LIMIT ?? '20', 10);
  return isNaN(v) || v <= 0 ? 20 : v;
}

export function getMaxCandidateAttempts(env: Env): number {
  const v = parseInt(env.AI_CANDIDATE_MAX_ATTEMPTS ?? '2', 10);
  return isNaN(v) || v <= 0 ? 2 : v;
}

export function getCandidateMaxAgeHours(env: Env): number {
  const v = parseInt(env.AI_CANDIDATE_MAX_AGE_HOURS ?? '6', 10);
  return isNaN(v) || v <= 0 ? 6 : v;
}

function generateCandidateId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `cand_${ts}_${rand}`;
}

// ── Enqueue ───────────────────────────────────────────────────

export interface EnqueueResult {
  id: string;
  inserted: boolean;
  reason?: string;
}

export async function enqueueCandidates(
  env: Env,
  inputs: AICandidateEnqueueInput[],
): Promise<EnqueueResult[]> {
  const results: EnqueueResult[] = [];

  for (const input of inputs) {
    const id = generateCandidateId();
    try {
      const result = await env.DB.prepare(`
        INSERT OR IGNORE INTO ai_candidate_queue (
          id, source_id, run_id, category_id, platform,
          source_account, source_url, post_id, published_at,
          normalized_item_json, dedupe_keys_json,
          priority_score, status, attempt_count, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, CURRENT_TIMESTAMP)
      `).bind(
        id,
        input.sourceId ?? null,
        input.runId,
        input.categoryId,
        input.platform,
        input.sourceAccount,
        input.sourceUrl,
        input.postId,
        input.publishedAt,
        JSON.stringify(input.normalizedItem),
        JSON.stringify(input.dedupeKeys),
        input.priorityScore ?? 0,
      ).run();

      const inserted = (result.meta.changes ?? 0) > 0;
      results.push({ id, inserted, reason: inserted ? undefined : 'duplicate_source_url' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[CandidateQueue] enqueue failed for ${input.sourceUrl}: ${msg}`);
      results.push({ id, inserted: false, reason: `error: ${msg}` });
    }
  }

  return results;
}

// ── Status transitions ────────────────────────────────────────

export async function updateCandidateStatus(
  env: Env,
  id: string,
  newStatus: AICandidateStatus,
  opts: {
    lastError?: string;
    incrementAttempt?: boolean;
  } = {},
): Promise<void> {
  try {
    const scoredAtStatus = newStatus === 'ai_selected' || newStatus === 'ai_rejected';
    const claimStatus = newStatus === 'scoring';
    const clearClaim = newStatus !== 'scoring';

    await env.DB.prepare(`
      UPDATE ai_candidate_queue
      SET
        status        = ?,
        attempt_count = attempt_count + ?,
        last_error    = ?,
        claimed_at    = CASE
          WHEN ? THEN CURRENT_TIMESTAMP
          WHEN ? THEN NULL
          ELSE claimed_at
        END,
        scored_at     = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE scored_at END
      WHERE id = ?
    `).bind(
      newStatus,
      opts.incrementAttempt ? 1 : 0,
      opts.lastError ?? null,
      claimStatus ? 1 : 0,
      clearClaim ? 1 : 0,
      scoredAtStatus ? 1 : 0,
      id,
    ).run();
  } catch (err) {
    console.warn(`[CandidateQueue] updateCandidateStatus failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function updateCandidatesStatus(
  env: Env,
  ids: string[],
  newStatus: AICandidateStatus,
  opts: { lastError?: string } = {},
): Promise<void> {
  if (ids.length === 0) return;
  for (const id of ids) await updateCandidateStatus(env, id, newStatus, opts);
}

export async function releaseClaimedCandidatesToPending(
  env: Env,
  ids: string[],
  reason: string,
  opts: { decrementAttempt?: boolean } = {},
): Promise<void> {
  if (ids.length === 0) return;
  for (const id of ids) {
    try {
      await env.DB.prepare(`
        UPDATE ai_candidate_queue
        SET status='pending',
            last_error=?,
            claimed_at=NULL,
            attempt_count=CASE WHEN ? AND attempt_count > 0 THEN attempt_count - 1 ELSE attempt_count END
        WHERE id=? AND status='scoring'
      `).bind(reason, opts.decrementAttempt ? 1 : 0, id).run();
    } catch (err) {
      console.warn(`[CandidateQueue] releaseClaimedCandidatesToPending failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ── Fetch and claim ───────────────────────────────────────────

export async function fetchPendingCandidates(
  env: Env,
  limit: number,
  categoryId?: string,
): Promise<AICandidateRow[]> {
  try {
    const maxAgeHours = getCandidateMaxAgeHours(env);
    const maxAttempts = getMaxCandidateAttempts(env);
    const cutoff = new Date(Date.now() - maxAgeHours * 3600 * 1000).toISOString();

    if (categoryId) {
      const rows = await env.DB.prepare(`
        SELECT * FROM ai_candidate_queue
        WHERE status = 'pending'
          AND category_id = ?
          AND created_at > ?
          AND attempt_count < ?
        ORDER BY priority_score DESC, created_at ASC
        LIMIT ?
      `).bind(categoryId, cutoff, maxAttempts, limit).all<AICandidateRow>();
      return rows.results ?? [];
    }

    const rows = await env.DB.prepare(`
      SELECT * FROM ai_candidate_queue
      WHERE status = 'pending'
        AND created_at > ?
        AND attempt_count < ?
      ORDER BY priority_score DESC, created_at ASC
      LIMIT ?
    `).bind(cutoff, maxAttempts, limit).all<AICandidateRow>();
    return rows.results ?? [];
  } catch (err) {
    console.warn(`[CandidateQueue] fetchPendingCandidates failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export async function claimCandidateBatch(
  env: Env,
  candidates: AICandidateRow[],
): Promise<AICandidateRow[]> {
  const maxAttempts = getMaxCandidateAttempts(env);
  const claimed: AICandidateRow[] = [];

  for (const row of candidates) {
    try {
      const res = await env.DB.prepare(`
        UPDATE ai_candidate_queue
        SET status='scoring',
            attempt_count=attempt_count + 1,
            claimed_at=CURRENT_TIMESTAMP,
            last_error=NULL
        WHERE id=?
          AND status='pending'
          AND attempt_count < ?
      `).bind(row.id, maxAttempts).run();

      if ((res.meta.changes ?? 0) > 0) {
        claimed.push({ ...row, status: 'scoring', attempt_count: row.attempt_count + 1, claimed_at: new Date().toISOString(), last_error: null });
      }
    } catch (err) {
      console.warn(`[CandidateQueue] claimCandidateBatch failed for ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return claimed;
}

export async function countPendingCandidates(env: Env, categoryId?: string): Promise<number> {
  try {
    if (categoryId) {
      const row = await env.DB.prepare(`
        SELECT COUNT(*) as cnt FROM ai_candidate_queue
        WHERE status = 'pending' AND category_id = ?
      `).bind(categoryId).first<{ cnt: number }>();
      return row?.cnt ?? 0;
    }
    const row = await env.DB.prepare(`
      SELECT COUNT(*) as cnt FROM ai_candidate_queue WHERE status = 'pending'
    `).first<{ cnt: number }>();
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

// ── Recovery and cleanup ──────────────────────────────────────

export interface RecoverStaleScoringResult {
  recovered: number;
  failed: number;
}

export async function recoverStaleScoringCandidates(env: Env, staleMinutes = 15): Promise<RecoverStaleScoringResult> {
  const maxAttempts = getMaxCandidateAttempts(env);
  const safeMinutes = Number.isFinite(staleMinutes) && staleMinutes > 0 ? Math.floor(staleMinutes) : 15;

  try {
    const recovered = await env.DB.prepare(`
      UPDATE ai_candidate_queue
      SET status='pending',
          last_error='recovered_stale_scoring',
          claimed_at=NULL
      WHERE status='scoring'
        AND claimed_at < datetime('now', ?)
        AND attempt_count < ?
    `).bind(`-${safeMinutes} minutes`, maxAttempts).run();

    const failed = await env.DB.prepare(`
      UPDATE ai_candidate_queue
      SET status='failed',
          last_error='max_attempts_exceeded_after_stale_scoring',
          claimed_at=NULL
      WHERE status='scoring'
        AND claimed_at < datetime('now', ?)
        AND attempt_count >= ?
    `).bind(`-${safeMinutes} minutes`, maxAttempts).run();

    return { recovered: recovered.meta.changes ?? 0, failed: failed.meta.changes ?? 0 };
  } catch (err) {
    console.warn(`[CandidateQueue] recoverStaleScoringCandidates failed: ${err instanceof Error ? err.message : String(err)}`);
    return { recovered: 0, failed: 0 };
  }
}

export async function failMaxAttemptPendingCandidates(env: Env): Promise<number> {
  try {
    const maxAttempts = getMaxCandidateAttempts(env);
    const result = await env.DB.prepare(`
      UPDATE ai_candidate_queue
      SET status='failed', last_error='max_attempts_exceeded'
      WHERE status='pending'
        AND attempt_count >= ?
    `).bind(maxAttempts).run();
    return result.meta.changes ?? 0;
  } catch (err) {
    console.warn(`[CandidateQueue] failMaxAttemptPendingCandidates failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

export async function skipStaleCandidates(env: Env): Promise<number> {
  try {
    const maxAgeHours = getCandidateMaxAgeHours(env);
    const cutoff = new Date(Date.now() - maxAgeHours * 3600 * 1000).toISOString();

    const result = await env.DB.prepare(`
      UPDATE ai_candidate_queue
      SET status = 'skipped', last_error = 'stale: exceeded max age'
      WHERE status = 'pending'
        AND created_at <= ?
    `).bind(cutoff).run();

    return result.meta.changes ?? 0;
  } catch (err) {
    console.warn(`[CandidateQueue] skipStaleCandidates failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

// ── Queue stats ───────────────────────────────────────────────

export interface CandidateQueueStats {
  pending: number;
  scoring: number;
  ai_selected: number;
  ai_rejected: number;
  queued: number;
  failed: number;
  skipped: number;
}

export async function getCandidateQueueStats(env: Env): Promise<CandidateQueueStats> {
  const zero: CandidateQueueStats = {
    pending: 0, scoring: 0, ai_selected: 0,
    ai_rejected: 0, queued: 0, failed: 0, skipped: 0,
  };
  try {
    const rows = await env.DB.prepare(`
      SELECT status, COUNT(*) as cnt
      FROM ai_candidate_queue
      GROUP BY status
    `).all<{ status: string; cnt: number }>();

    const stats = { ...zero };
    for (const row of rows.results ?? []) {
      const s = row.status as AICandidateStatus;
      if (s in stats) (stats as Record<string, number>)[s] = row.cnt;
    }
    return stats;
  } catch {
    return zero;
  }
}
