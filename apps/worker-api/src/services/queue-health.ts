// ══════════════════════════════════════════════════════════════
// services/queue-health.ts
// Phase 6E/6F — Read-only queue-health telemetry + pure decision helpers.
//
// This module never mutates state. It answers: "is the near-term publish
// queue healthy, lean, or starving?" and exposes PURE helpers the scheduled
// controller uses to decide how hard to drain / whether to trigger an early
// source rotation. All controller behavior is feature-flagged in index.ts;
// this file only computes numbers.
// ══════════════════════════════════════════════════════════════

import type { Env } from '../types';

export type QueueState = 'healthy' | 'lean' | 'starving';

export interface QueueHealthThresholds {
  /** Minimum scheduled posts that should exist in the next 6h to be "healthy". */
  minScheduledNext6h: number;
  /** Below this, the channel is considered "starving". */
  starvingScheduledNext6h: number;
}

export interface QueueHealthInputs {
  scheduledNext6h: number;
  scheduledNext24h: number;
  totalScheduled: number;
  pendingCandidates: number;
  lastPublishedAgoMin: number | null;
  rotationAgeMin: number | null;
}

export interface QueueHealth extends QueueHealthInputs {
  channelId: string;
  state: QueueState;
  /** True when rows exist far in the future but the near window is thin. */
  backloaded: boolean;
}

// ── Config helpers ────────────────────────────────────────────

export function isQueueHealthControllerEnabled(env: Env): boolean {
  return String((env as any).QUEUE_HEALTH_CONTROLLER_ENABLED ?? '').toLowerCase() === 'true';
}

export function getQueueHealthThresholds(env: Env): QueueHealthThresholds {
  const minNext6h = clampInt(Number((env as any).QUEUE_HEALTH_MIN_SCHEDULED_NEXT_6H ?? 3), 0, 1000, 3);
  // "starving" defaults to half the healthy floor (at least 1) unless overridden.
  const starvingRaw = (env as any).QUEUE_HEALTH_STARVING_SCHEDULED_NEXT_6H;
  const starving = starvingRaw != null && String(starvingRaw).trim() !== ''
    ? clampInt(Number(starvingRaw), 0, 1000, 1)
    : Math.max(1, Math.floor(minNext6h / 2));
  return { minScheduledNext6h: minNext6h, starvingScheduledNext6h: Math.min(starving, minNext6h) };
}

export function getStarvingMaxBatches(env: Env, normalMaxBatches: number): number {
  const v = clampInt(Number((env as any).QUEUE_HEALTH_STARVING_MAX_BATCHES ?? 3), 1, 10, 3);
  return Math.max(normalMaxBatches, v);
}

export function getStarvingScoringCallBonus(env: Env): number {
  return clampInt(Number((env as any).QUEUE_HEALTH_STARVING_SCORING_CALL_BONUS ?? 50), 0, 1000, 50);
}

// ── Pure classification ───────────────────────────────────────

/**
 * Pure: classify queue state from gathered inputs.
 * - starving: near-6h window at/under the starving floor
 * - lean:     near-6h window under the healthy floor (but above starving)
 * - healthy:  near-6h window at/above the healthy floor
 */
export function classifyQueueHealth(
  inputs: QueueHealthInputs,
  thresholds: QueueHealthThresholds,
): QueueState {
  const n6 = Math.max(0, inputs.scheduledNext6h);
  if (n6 <= thresholds.starvingScheduledNext6h) return 'starving';
  if (n6 < thresholds.minScheduledNext6h) return 'lean';
  return 'healthy';
}

/**
 * Pure: a queue is "backloaded" when it has plenty of total scheduled rows but
 * the near window is thin. This distinguishes "truly empty" from
 * "scheduled too far into the future" (the rule-gate MAX(scheduled_at) issue).
 */
export function isBackloaded(inputs: QueueHealthInputs, thresholds: QueueHealthThresholds): boolean {
  return inputs.scheduledNext6h < thresholds.minScheduledNext6h
    && inputs.totalScheduled >= thresholds.minScheduledNext6h * 2;
}

/** Pure: how many scoring batches to run this tick given queue state. */
export function decideDrainBatches(state: QueueState, normalMaxBatches: number, starvingMaxBatches: number): number {
  return state === 'starving' ? Math.max(normalMaxBatches, starvingMaxBatches) : normalMaxBatches;
}

/** Pure: should the controller trigger an early single-source rotation? */
export function shouldTriggerEarlyRotation(health: QueueHealth): boolean {
  return health.state === 'starving' && health.pendingCandidates <= 0;
}

// ── Read-only gatherers ───────────────────────────────────────

export async function getQueueHealth(env: Env, channelId: string): Promise<QueueHealth> {
  const thresholds = getQueueHealthThresholds(env);
  const inputs = await gatherQueueHealthInputs(env, channelId);
  return {
    channelId,
    ...inputs,
    state: classifyQueueHealth(inputs, thresholds),
    backloaded: isBackloaded(inputs, thresholds),
  };
}

async function gatherQueueHealthInputs(env: Env, channelId: string): Promise<QueueHealthInputs> {
  const empty: QueueHealthInputs = {
    scheduledNext6h: 0,
    scheduledNext24h: 0,
    totalScheduled: 0,
    pendingCandidates: 0,
    lastPublishedAgoMin: null,
    rotationAgeMin: null,
  };
  if (!env.DB) return empty;

  try {
    const queue = await env.DB.prepare(`
      SELECT
        SUM(CASE WHEN scheduled_at <= unixepoch('now','+6 hours') THEN 1 ELSE 0 END) AS next_6h,
        SUM(CASE WHEN scheduled_at <= unixepoch('now','+24 hours') THEN 1 ELSE 0 END) AS next_24h,
        COUNT(*) AS total
      FROM publish_queue
      WHERE channel_id = ? AND status IN ('scheduled','retry')
    `).bind(channelId).first<{ next_6h: number | null; next_24h: number | null; total: number | null }>();

    const lastPub = await env.DB.prepare(`
      SELECT MAX(published_at) AS last_at FROM publish_queue
      WHERE channel_id = ? AND status = 'published'
    `).bind(channelId).first<{ last_at: number | null }>();

    // Phase 6F fix: scope pending candidates to THIS channel's category so a
    // multi-category future doesn't let another category's backlog mask this
    // channel's starvation.
    const chanCat = await env.DB.prepare(
      `SELECT category_id FROM channels WHERE id = ?`,
    ).bind(channelId).first<{ category_id: string | null }>();
    const categoryId = chanCat?.category_id ?? null;

    const pending = categoryId
      ? await env.DB.prepare(
          `SELECT COUNT(*) AS cnt FROM ai_candidate_queue WHERE status = 'pending' AND category_id = ?`,
        ).bind(categoryId).first<{ cnt: number | null }>()
      : await env.DB.prepare(
          `SELECT COUNT(*) AS cnt FROM ai_candidate_queue WHERE status = 'pending'`,
        ).first<{ cnt: number | null }>();

    const rotation = await env.DB.prepare(`
      SELECT MAX(created_at) AS last_at FROM run_events WHERE event_type = 'apify.rotation.task_started'
    `).first<{ last_at: string | null }>();

    const nowSec = Math.floor(Date.now() / 1000);
    const lastPubAt = Number(lastPub?.last_at ?? 0);
    const lastPublishedAgoMin = lastPubAt > 0 ? Math.round((nowSec - lastPubAt) / 60) : null;

    let rotationAgeMin: number | null = null;
    if (rotation?.last_at) {
      const ms = Date.parse(String(rotation.last_at).replace(' ', 'T') + 'Z');
      if (Number.isFinite(ms)) rotationAgeMin = Math.round((Date.now() - ms) / 60000);
    }

    return {
      scheduledNext6h: Number(queue?.next_6h ?? 0),
      scheduledNext24h: Number(queue?.next_24h ?? 0),
      totalScheduled: Number(queue?.total ?? 0),
      pendingCandidates: Number(pending?.cnt ?? 0),
      lastPublishedAgoMin,
      rotationAgeMin,
    };
  } catch (err) {
    console.warn('[QueueHealth] gather skipped:', err instanceof Error ? err.message : String(err));
    return empty;
  }
}

/** Read-only report across all enabled channels of a category (admin endpoint). */
export async function buildQueueHealthReport(env: Env, categoryId?: string): Promise<{
  generatedAt: string;
  thresholds: QueueHealthThresholds;
  channels: QueueHealth[];
}> {
  const thresholds = getQueueHealthThresholds(env);
  let channels: Array<{ id: string }> = [];
  try {
    const rows = categoryId
      ? await env.DB.prepare('SELECT id FROM channels WHERE enabled=1 AND category_id=?').bind(categoryId).all<{ id: string }>()
      : await env.DB.prepare('SELECT id FROM channels WHERE enabled=1').all<{ id: string }>();
    channels = rows.results ?? [];
  } catch (err) {
    console.warn('[QueueHealth] channel load skipped:', err instanceof Error ? err.message : String(err));
  }

  const health: QueueHealth[] = [];
  for (const ch of channels) health.push(await getQueueHealth(env, ch.id));

  return { generatedAt: new Date().toISOString(), thresholds, channels: health };
}

// ── small util ────────────────────────────────────────────────

function clampInt(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
