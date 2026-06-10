import type { Env } from '../types';

type Severity = 'debug' | 'info' | 'warn' | 'error';

export interface RunEventInput {
  runId: string;
  eventType: string;
  phase: string;
  severity?: Severity;
  message?: string;
  categoryId?: string;
  platform?: string;
  sourceId?: string;
  datasetId?: string;
  actorRunId?: string;
  itemId?: string;
  queueId?: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface RunItemEventInput {
  runId: string;
  itemId?: string;
  sourceUrl?: string;
  postId?: string;
  sourceAccount?: string;
  phase: string;
  status: string;
  rejectReason?: string | null;
  aiScore?: number | null;
  aiRisk?: string | null;
  mediaCount?: number;
  queueId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Best-effort structured run event logging.
 * This must never break the production pipeline.
 */
export async function recordRunEvent(env: Env, input: RunEventInput): Promise<void> {
  try {
    await env.DB.prepare(`
      INSERT INTO run_events (
        id, run_id, event_type, phase, severity, message,
        category_id, platform, source_id, dataset_id, actor_run_id,
        item_id, queue_id, provider, model, input_tokens, output_tokens,
        duration_ms, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      eventId('evt'),
      safeText(input.runId, 128),
      safeText(input.eventType, 120),
      safeText(input.phase, 160),
      safeSeverity(input.severity),
      nullableText(input.message, 2000),
      nullableText(input.categoryId, 128),
      nullableText(input.platform, 64),
      nullableText(input.sourceId, 128),
      nullableText(input.datasetId, 128),
      nullableText(input.actorRunId, 128),
      nullableText(input.itemId, 128),
      nullableText(input.queueId, 128),
      nullableText(input.provider, 80),
      nullableText(input.model, 120),
      nullableNumber(input.inputTokens),
      nullableNumber(input.outputTokens),
      nullableNumber(input.durationMs),
      safeJson(input.metadata),
    ).run();
  } catch (err) {
    console.warn('[RunEvents] recordRunEvent failed:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Best-effort item-level event logging.
 * This must never break the production pipeline.
 */
export async function recordRunItemEvent(env: Env, input: RunItemEventInput): Promise<void> {
  try {
    await env.DB.prepare(`
      INSERT INTO run_item_events (
        id, run_id, item_id, source_url, post_id, source_account,
        phase, status, reject_reason, ai_score, ai_risk, media_count,
        queue_id, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      eventId('itemevt'),
      safeText(input.runId, 128),
      nullableText(input.itemId, 128),
      nullableText(input.sourceUrl, 2000),
      nullableText(input.postId, 128),
      nullableText(input.sourceAccount, 240),
      safeText(input.phase, 160),
      safeText(input.status, 120),
      nullableText(input.rejectReason, 240),
      nullableNumber(input.aiScore),
      nullableText(input.aiRisk, 80),
      nullableNumber(input.mediaCount),
      nullableText(input.queueId, 128),
      safeJson(input.metadata),
    ).run();
  } catch (err) {
    console.warn('[RunEvents] recordRunItemEvent failed:', err instanceof Error ? err.message : String(err));
  }
}

export function sanitizeRunDebugId(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  return /^[\w-]{1,128}$/.test(raw) ? raw : null;
}

function eventId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now()}_${rand}`;
}

function safeText(value: unknown, maxLen: number): string {
  return String(value ?? '').slice(0, maxLen);
}

function nullableText(value: unknown, maxLen: number): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  return text ? text.slice(0, maxLen) : null;
}

function nullableNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeSeverity(value: unknown): Severity {
  return value === 'debug' || value === 'warn' || value === 'error' ? value : 'info';
}

function safeJson(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  try {
    return JSON.stringify(value).slice(0, 8000);
  } catch {
    return JSON.stringify({ serialization_error: true });
  }
}
