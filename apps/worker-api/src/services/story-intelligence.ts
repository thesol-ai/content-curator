// ══════════════════════════════════════════════════════════════
// services/story-intelligence.ts   (Phase 6K — OBSERVE ONLY)
//
// Root cause of theme/story repeats: ~41% of topic_fingerprints are unstable,
// so the same story arriving from several sources with different wording is
// treated as distinct news. This module lays the groundwork to fix that with a
// *structured* story key derived from {primary_entities, event_type,
// canonical_date} the scoring model can emit.
//
// SAFETY: everything here is observe-only and flag-gated.
//   - STORY_INTELLIGENCE_ENABLED=false  → scoring prompt unchanged, no logging.
//   - When enabled it only ASKS the model for extra fields and LOGS a derived
//     story_key. It NEVER rejects on story_key in this phase (that activation
//     is a later, separately-flagged step once the key proves stable).
// The stability report below works today from existing data (no new columns).
// ══════════════════════════════════════════════════════════════

import type { Env } from '../types';

export interface StoryFields {
  primaryEntities: string[];
  eventType: string;
  canonicalDate: string;
}

export function isStoryIntelligenceEnabled(env: Env): boolean {
  return String((env as any).STORY_INTELLIGENCE_ENABLED ?? '').toLowerCase() === 'true';
}

/** When true (default), a derived story_key is only logged, never used to reject. */
export function isStoryIntelligenceObserveOnly(env: Env): boolean {
  const raw = String((env as any).STORY_INTELLIGENCE_OBSERVE_ONLY ?? '').toLowerCase();
  return raw !== 'false'; // default true
}

/** Active de-dup on story_key. Default OFF. Only meaningful when ENABLED too. */
export function isStoryIntelligenceRejectEnabled(env: Env): boolean {
  return String((env as any).STORY_INTELLIGENCE_REJECT_ENABLED ?? '').toLowerCase() === 'true';
}

/**
 * The ONLY predicate that should gate a real story_key rejection. Rejection
 * requires the full two-step opt-in: feature enabled, reject enabled, AND
 * observe-only explicitly turned off. While OBSERVE_ONLY is true (the default)
 * this returns false even if REJECT_ENABLED was flipped on — so OBSERVE_ONLY
 * acts as a genuine emergency "log but never reject" kill-switch.
 */
export function isStoryIntelligenceRejectActive(env: Env): boolean {
  return isStoryIntelligenceEnabled(env)
    && isStoryIntelligenceRejectEnabled(env)
    && !isStoryIntelligenceObserveOnly(env);
}

export function getStoryIntelligenceWindowHours(env: Env): number {
  const n = parseInt(String((env as any).STORY_INTELLIGENCE_WINDOW_HOURS ?? '48'), 10);
  return Number.isFinite(n) && n > 0 ? n : 48;
}

export function isStoryFollowupAllowEnabled(env: Env): boolean {
  const raw = String((env as any).STORY_INTELLIGENCE_FOLLOWUP_ALLOW_ENABLED ?? '').toLowerCase();
  return raw !== 'false'; // default true
}

// Follow-up event types that are materially new developments and must NOT be
// blocked even when an earlier story with the same key was published.
const FOLLOWUP_EVENT_TYPES = new Set([
  'security_recovery', 'lawsuit_update', 'etf_approval', 'etf_decision',
  'protocol_fix', 'exploit_update', 'regulatory_decision', 'court_ruling',
  'settlement', 'verdict', 'resolution', 'recovery',
]);

/** Pure: is this event_type a materially-new follow-up we should let through? */
export function isFollowUpEventType(eventType: unknown): boolean {
  const e = normalizeEventType(eventType);
  if (FOLLOWUP_EVENT_TYPES.has(e)) return true;
  // also treat any *_update / *_decision / *_recovery as follow-up
  return /(_update|_decision|_recovery|_ruling)$/.test(e);
}

/**
 * Pure decision: should we reject this item as a story-key repeat?
 * rejectEnabled + a prior key in window + (followups disabled OR not a followup).
 */
export function shouldRejectByStoryKey(args: {
  rejectEnabled: boolean;
  storyKeySeenInWindow: boolean;
  eventType: string | null | undefined;
  followupAllowEnabled: boolean;
}): boolean {
  if (!args.rejectEnabled || !args.storyKeySeenInWindow) return false;
  if (args.followupAllowEnabled && isFollowUpEventType(args.eventType)) return false;
  return true;
}

// ── Pure helpers (unit-tested) ────────────────────────────────

export function normalizeEntities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    const e = String(raw ?? '')
      .toLowerCase()
      .replace(/^\$/, '')
      .replace(/[^\p{L}\p{N} _-]/gu, '')
      .trim()
      .replace(/\s+/g, '_');
    if (e.length >= 2 && !seen.has(e)) {
      seen.add(e);
      out.push(e);
    }
    if (out.length >= 3) break; // cap at the 3 most salient entities
  }
  return out.sort();
}

function normalizeEventType(value: unknown): string {
  const e = String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .trim()
    .replace(/\s+/g, '_');
  return e.slice(0, 40) || 'unknown';
}

function normalizeCanonicalDate(value: unknown): string {
  const s = String(value ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

/** Tolerantly read the structured fields from a raw model item (may be absent). */
export function parseStoryFields(raw: any): StoryFields | null {
  if (!raw || typeof raw !== 'object') return null;
  const primaryEntities = normalizeEntities(raw.primary_entities);
  const eventType = normalizeEventType(raw.event_type);
  const canonicalDate = normalizeCanonicalDate(raw.canonical_date);
  if (primaryEntities.length === 0 && eventType === 'unknown') return null;
  return { primaryEntities, eventType, canonicalDate };
}

/**
 * Deterministic story key: sorted entities + event_type + date.
 * e.g. "monero|tether|zachxbt|security_laundering|2026-06-13".
 * Returns null when there is not enough signal to be meaningful.
 */
export function buildStoryKey(fields: StoryFields | null): string | null {
  if (!fields) return null;
  const { primaryEntities, eventType, canonicalDate } = fields;
  if (primaryEntities.length === 0) return null;
  const parts = [primaryEntities.join('|'), eventType];
  if (canonicalDate) parts.push(canonicalDate);
  return parts.join('|');
}

// ── Observe report (works today from discovery_items.topic_fingerprint) ──

export interface StoryStabilityReport {
  generatedAt: string;
  categoryId: string | null;
  windowHours: number;
  totalWithFingerprint: number;
  unstableLikeCount: number;
  unstablePct: number;
  repeatedFingerprints: Array<{ fingerprint: string; count: number }>;
  storyKey: StoryKeyMetrics | null; // populated once 6K has recorded events
}

const UNSTABLE_PREFIXES = ['ns-', 'fp-', 'err-', 'budget-'];

/** Pure: classify a fingerprint as unstable (auto-generated fallback slug). */
export function isUnstableFingerprint(fp: unknown): boolean {
  const s = String(fp ?? '').trim();
  if (!s) return true;
  return UNSTABLE_PREFIXES.some(p => s.startsWith(p));
}

export function summarizeStability(
  rows: Array<{ topic_fingerprint: string | null }>,
): { total: number; unstable: number; pct: number } {
  const total = rows.length;
  const unstable = rows.reduce((n, r) => n + (isUnstableFingerprint(r.topic_fingerprint) ? 1 : 0), 0);
  const pct = total > 0 ? Math.round((unstable / total) * 1000) / 10 : 0;
  return { total, unstable, pct };
}

export async function buildStoryStabilityReport(
  env: Env,
  opts: { categoryId?: string; windowHours?: number } = {},
): Promise<StoryStabilityReport> {
  const windowHours = clampInt(Number(opts.windowHours), 1, 720, 72);
  const categoryId = opts.categoryId && /^[\w-]{1,64}$/.test(opts.categoryId) ? opts.categoryId : null;

  let rows: Array<{ topic_fingerprint: string | null }> = [];
  let repeated: Array<{ fingerprint: string; count: number }> = [];
  if (env.DB) {
    try {
      const res = categoryId
        ? await env.DB.prepare(
            `SELECT topic_fingerprint FROM discovery_items
             WHERE category_id=? AND created_at > datetime('now','-' || ? || ' hours')`,
          ).bind(categoryId, String(windowHours)).all<{ topic_fingerprint: string | null }>()
        : await env.DB.prepare(
            `SELECT topic_fingerprint FROM discovery_items
             WHERE created_at > datetime('now','-' || ? || ' hours')`,
          ).bind(String(windowHours)).all<{ topic_fingerprint: string | null }>();
      rows = res.results ?? [];

      const rep = categoryId
        ? await env.DB.prepare(
            `SELECT topic_fingerprint AS fp, COUNT(*) AS c FROM discovery_items
             WHERE category_id=? AND created_at > datetime('now','-' || ? || ' hours')
               AND topic_fingerprint IS NOT NULL
             GROUP BY topic_fingerprint HAVING c > 1 ORDER BY c DESC LIMIT 20`,
          ).bind(categoryId, String(windowHours)).all<{ fp: string; c: number }>()
        : await env.DB.prepare(
            `SELECT topic_fingerprint AS fp, COUNT(*) AS c FROM discovery_items
             WHERE created_at > datetime('now','-' || ? || ' hours')
               AND topic_fingerprint IS NOT NULL
             GROUP BY topic_fingerprint HAVING c > 1 ORDER BY c DESC LIMIT 20`,
          ).bind(String(windowHours)).all<{ fp: string; c: number }>();
      repeated = (rep.results ?? [])
        .filter(r => !isUnstableFingerprint(r.fp))
        .map(r => ({ fingerprint: String(r.fp), count: Number(r.c) || 0 }));
    } catch (err) {
      console.warn('[StoryIntel] stability report skipped:', err instanceof Error ? err.message : String(err));
    }
  }

  const s = summarizeStability(rows);

  // story_key metrics from the queryable table (empty until 6K records events)
  let storyKeyMetrics: StoryKeyMetrics | null = null;
  if (env.DB) {
    try {
      const skRes = categoryId
        ? await env.DB.prepare(
            `SELECT story_key, event_type, status FROM story_intelligence_events
             WHERE category_id=? AND created_at > datetime('now','-' || ? || ' hours')`,
          ).bind(categoryId, String(windowHours)).all<{ story_key: string; event_type: string | null; status: string }>()
        : await env.DB.prepare(
            `SELECT story_key, event_type, status FROM story_intelligence_events
             WHERE created_at > datetime('now','-' || ? || ' hours')`,
          ).bind(String(windowHours)).all<{ story_key: string; event_type: string | null; status: string }>();
      const skRows = skRes.results ?? [];
      if (skRows.length > 0) storyKeyMetrics = shapeStoryKeyMetrics(skRows);
    } catch {
      // table may not exist yet (migration 0019 not applied) → leave null
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    categoryId,
    windowHours,
    totalWithFingerprint: s.total,
    unstableLikeCount: s.unstable,
    unstablePct: s.pct,
    repeatedFingerprints: repeated,
    storyKey: storyKeyMetrics,
  };
}

function clampInt(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

// ── Queryable store (Phase 6K — needs migration 0019) ─────────────

export interface StoryEventInput {
  categoryId: string;
  channelId?: string | null;
  storyKey: string;
  fields: StoryFields | null;
  topicFingerprint?: string | null;
  sourceId?: string | null;
  sourceAccount?: string | null;
  discoveryItemId?: string | null;
  candidateId?: string | null;
  queueId?: string | null;
  status: string; // 'scored' | 'queued' | 'published' | 'rejected'
}

/** Best-effort insert into story_intelligence_events (no-op if table absent). */
export async function recordStoryEvent(env: Env, input: StoryEventInput): Promise<void> {
  if (!env.DB || !input.storyKey) return;
  try {
    await env.DB.prepare(`
      INSERT INTO story_intelligence_events
        (id, category_id, channel_id, story_key, event_type, canonical_date,
         primary_entities_json, topic_fingerprint, source_id, source_account,
         discovery_item_id, candidate_id, queue_id, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      `si_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      input.categoryId,
      input.channelId ?? null,
      input.storyKey,
      input.fields?.eventType ?? null,
      input.fields?.canonicalDate ?? null,
      input.fields ? JSON.stringify(input.fields.primaryEntities) : null,
      input.topicFingerprint ?? null,
      input.sourceId ?? null,
      input.sourceAccount ?? null,
      input.discoveryItemId ?? null,
      input.candidateId ?? null,
      input.queueId ?? null,
      input.status,
    ).run();
  } catch (err) {
    console.warn('[StoryIntel] recordStoryEvent skipped:', err instanceof Error ? err.message : String(err));
  }
}

/** Was this story_key already published/queued for the channel within window? */
export async function storyKeySeenInWindow(
  env: Env, args: { categoryId: string; channelId?: string | null; storyKey: string; windowHours: number },
): Promise<boolean> {
  if (!env.DB || !args.storyKey) return false;
  try {
    const row = await env.DB.prepare(`
      SELECT 1 AS hit FROM story_intelligence_events
      WHERE category_id = ? AND story_key = ?
        AND (channel_id = ? OR ? IS NULL)
        AND status IN ('queued','published')
        AND created_at > datetime('now','-' || ? || ' hours')
      LIMIT 1
    `).bind(args.categoryId, args.storyKey, args.channelId ?? null, args.channelId ?? null, String(args.windowHours))
      .first<{ hit: number }>();
    return Boolean(row?.hit);
  } catch (err) {
    console.warn('[StoryIntel] storyKeySeenInWindow skipped:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

// ── Story-key report metrics (Phase 6K item 4) ────────────────────

export interface StoryKeyMetrics {
  storyKeyTotal: number;
  storyKeyUnique: number;
  storyKeyRepeated: number;
  storyKeyPresent: number;
  storyKeyMissing: number;
  missingPct: number;
  topRepeatedStoryKeys: Array<{ storyKey: string; count: number }>;
  wouldBlockCountIfRejectEnabled: number;
}

/** Pure: compute story_key metrics from event rows (status may be 'story_key_missing'). */
export function shapeStoryKeyMetrics(rows: Array<{ story_key: string; event_type: string | null; status?: string }>): StoryKeyMetrics {
  const missing = rows.filter(r => String(r.status ?? '') === 'story_key_missing' || String(r.story_key ?? '') === '__missing__');
  const present = rows.filter(r => !(String(r.status ?? '') === 'story_key_missing' || String(r.story_key ?? '') === '__missing__'));
  const counts = new Map<string, number>();
  for (const r of present) {
    const k = String(r.story_key ?? '');
    if (!k) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);
  const unique = counts.size;
  let repeated = 0;
  let wouldBlock = 0;
  const seenKey = new Set<string>();
  for (const r of present) {
    const k = String(r.story_key ?? '');
    if (!k) continue;
    if (!seenKey.has(k)) { seenKey.add(k); continue; }
    if (!isFollowUpEventType(r.event_type)) wouldBlock++;
  }
  for (const n of counts.values()) if (n > 1) repeated++;
  const top = Array.from(counts.entries())
    .filter(([, n]) => n > 1)
    .map(([storyKey, count]) => ({ storyKey, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  const presentCount = present.length;
  const missingCount = missing.length;
  const denom = presentCount + missingCount;
  return {
    storyKeyTotal: total,
    storyKeyUnique: unique,
    storyKeyRepeated: repeated,
    storyKeyPresent: presentCount,
    storyKeyMissing: missingCount,
    missingPct: denom > 0 ? Math.round((missingCount / denom) * 1000) / 10 : 0,
    topRepeatedStoryKeys: top,
    wouldBlockCountIfRejectEnabled: wouldBlock,
  };
}

// ── Retention cleanup for story_intelligence_events (cron, daily-guarded) ──

export function getStoryIntelligenceRetentionDays(env: Env): number {
  const n = parseInt(String((env as any).STORY_INTELLIGENCE_RETENTION_DAYS ?? '30'), 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

/**
 * Delete story_intelligence_events older than the retention window. Runs at most
 * once per ~20h (settings marker) and only when story intelligence is enabled.
 * The dedupe window is at most ~48h, so long-term rows have no value. Best-effort;
 * no-op if the table is missing (migration 0019 not applied) and never throws.
 */
export async function cleanupStoryIntelligenceEvents(env: Env): Promise<{ ran: boolean; deleted: number }> {
  if (!env.DB) return { ran: false, deleted: 0 };
  if (!isStoryIntelligenceEnabled(env)) return { ran: false, deleted: 0 };
  const MARKER = 'story_intelligence_events_last_cleanup';
  try {
    const last = await env.DB.prepare(`SELECT value FROM settings WHERE key=?`).bind(MARKER).first<{ value: string }>();
    const lastMs = last?.value ? Date.parse(last.value) : 0;
    if (Number.isFinite(lastMs) && Date.now() - lastMs < 20 * 60 * 60 * 1000) {
      return { ran: false, deleted: 0 }; // ran recently
    }
    const days = getStoryIntelligenceRetentionDays(env);
    const res = await env.DB.prepare(
      `DELETE FROM story_intelligence_events WHERE created_at < datetime('now','-' || ? || ' days')`,
    ).bind(String(days)).run();
    const deleted = Number((res as any)?.meta?.changes ?? 0);
    await env.DB.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).bind(MARKER, new Date().toISOString()).run();
    if (deleted > 0) console.log('[StoryIntel] retention cleanup removed', deleted, 'events older than', days, 'days');
    return { ran: true, deleted };
  } catch (err) {
    console.warn('[StoryIntel] cleanup skipped:', err instanceof Error ? err.message : String(err));
    return { ran: false, deleted: 0 };
  }
}
