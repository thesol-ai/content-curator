// ══════════════════════════════════════════════════════════════
// services/rejection-funnel.ts
// Phase 6E — Read-only "where are candidates lost?" funnel.
//
// Aggregates discovery_runs (fetch/new/duplicate) and run_item_events
// (per-phase reject reasons) into a single funnel so an operator can answer
// "why is the queue empty?" at a glance. Pure shaping is split out for tests.
// ══════════════════════════════════════════════════════════════

import type { Env } from '../types';

export interface FunnelStageCount {
  reason: string;
  count: number;
}

export interface RejectionFunnel {
  generatedAt: string;
  categoryId: string | null;
  windowHours: number;
  totals: {
    fetched: number;
    new: number;
    duplicate: number;
    queued: number;
    published: number;
    failed: number;
  };
  rejections: {
    preAi: FunnelStageCount[];
    ai: FunnelStageCount[];
    storyTheme: FunnelStageCount[];
    ruleGate: FunnelStageCount[];
    other: FunnelStageCount[];
  };
}

interface RawEventRow {
  status: string | null;
  reject_reason: string | null;
  count: number;
}

const STORY_THEME_REASONS = new Set([
  'similar_topic_recent_channel',
  'similar_story_cluster_recent_channel',
  'story_duplicate_recent_channel',
]);

/**
 * Pure: bucket run_item_event rows into funnel stages.
 * Stage assignment is by status/reason, not row order, so it is stable.
 */
export function shapeFunnelRejections(rows: RawEventRow[]): RejectionFunnel['rejections'] {
  const preAi = new Map<string, number>();
  const ai = new Map<string, number>();
  const storyTheme = new Map<string, number>();
  const ruleGate = new Map<string, number>();
  const other = new Map<string, number>();

  for (const row of rows) {
    const reason = String(row.reject_reason ?? '').trim() || '(none)';
    const status = String(row.status ?? '').trim();
    const n = Number(row.count) || 0;
    if (n <= 0) continue;

    if (status === 'rule_gate_rejected') {
      bump(ruleGate, reason, n);
    } else if (status === 'story_duplicate_rejected' || STORY_THEME_REASONS.has(reason) || reason.startsWith('theme_daily_cap') || reason.startsWith('iran_audience_')) {
      bump(storyTheme, reason, n);
    } else if (status === 'ai_rejected') {
      // pre-AI deterministic rejects are recorded with reasons prefixed pre_ai_ or stale_*
      if (reason.startsWith('pre_ai_') || reason.startsWith('stale')) bump(preAi, reason, n);
      else bump(ai, reason, n);
    } else if (status === 'translation_missing') {
      bump(other, 'translation_missing', n);
    } else if (status && status !== 'ai_selected' && status !== 'queue_created') {
      bump(other, `${status}:${reason}`, n);
    }
  }

  return {
    preAi: toSorted(preAi),
    ai: toSorted(ai),
    storyTheme: toSorted(storyTheme),
    ruleGate: toSorted(ruleGate),
    other: toSorted(other),
  };
}

export async function buildRejectionFunnel(
  env: Env,
  opts: { categoryId?: string; windowHours?: number } = {},
): Promise<RejectionFunnel> {
  const windowHours = clampInt(opts.windowHours ?? 24, 1, 720, 24);
  const categoryId = opts.categoryId && /^[\w-]{1,64}$/.test(opts.categoryId) ? opts.categoryId : null;

  const totals = { fetched: 0, new: 0, duplicate: 0, queued: 0, published: 0, failed: 0 };
  let rejections: RejectionFunnel['rejections'] = { preAi: [], ai: [], storyTheme: [], ruleGate: [], other: [] };

  if (env.DB) {
    try {
      const runRow = categoryId
        ? await env.DB.prepare(`
            SELECT COALESCE(SUM(items_fetched),0) f, COALESCE(SUM(items_new),0) n, COALESCE(SUM(items_duplicate),0) d,
                   COALESCE(SUM(items_queued),0) q
            FROM discovery_runs
            WHERE category_id=? AND created_at > datetime('now','-' || ? || ' hours')
          `).bind(categoryId, String(windowHours)).first<any>()
        : await env.DB.prepare(`
            SELECT COALESCE(SUM(items_fetched),0) f, COALESCE(SUM(items_new),0) n, COALESCE(SUM(items_duplicate),0) d,
                   COALESCE(SUM(items_queued),0) q
            FROM discovery_runs
            WHERE created_at > datetime('now','-' || ? || ' hours')
          `).bind(String(windowHours)).first<any>();

      totals.fetched = Number(runRow?.f ?? 0);
      totals.new = Number(runRow?.n ?? 0);
      totals.duplicate = Number(runRow?.d ?? 0);

      // Phase 6E fix: run_item_events has no category_id, so when filtering by
      // category we join through discovery_runs(run_id). publish_queue likewise
      // joins through discovery_items(item_id). When no category is given we
      // keep the cheaper unfiltered queries (identical to before).
      const eventRows = categoryId
        ? await env.DB.prepare(`
            SELECT e.status AS status, e.reject_reason AS reject_reason, COUNT(*) AS count
            FROM run_item_events e
            JOIN discovery_runs r ON r.id = e.run_id
            WHERE e.created_at > datetime('now','-' || ? || ' hours') AND r.category_id = ?
            GROUP BY e.status, e.reject_reason
          `).bind(String(windowHours), categoryId).all<RawEventRow>()
        : await env.DB.prepare(`
            SELECT status, reject_reason, COUNT(*) AS count
            FROM run_item_events
            WHERE created_at > datetime('now','-' || ? || ' hours')
            GROUP BY status, reject_reason
          `).bind(String(windowHours)).all<RawEventRow>();

      const rows = eventRows.results ?? [];
      rejections = shapeFunnelRejections(rows);

      for (const r of rows) {
        const status = String(r.status ?? '');
        const n = Number(r.count) || 0;
        if (status === 'queue_created') totals.queued += n;
      }

      const pub = categoryId
        ? await env.DB.prepare(`
            SELECT
              (SELECT COUNT(*) FROM publish_queue q JOIN discovery_items d ON d.id=q.item_id
                 WHERE q.status='published' AND d.category_id=?
                   AND q.published_at >= unixepoch('now','-' || ? || ' hours')) AS published,
              (SELECT COUNT(*) FROM publish_queue q JOIN discovery_items d ON d.id=q.item_id
                 WHERE q.status='failed' AND d.category_id=?
                   AND q.created_at > datetime('now','-' || ? || ' hours')) AS failed
          `).bind(categoryId, String(windowHours), categoryId, String(windowHours)).first<{ published: number | null; failed: number | null }>()
        : await env.DB.prepare(`
            SELECT
              (SELECT COUNT(*) FROM publish_queue
                 WHERE status='published' AND published_at >= unixepoch('now','-' || ? || ' hours')) AS published,
              (SELECT COUNT(*) FROM publish_queue
                 WHERE status='failed' AND created_at > datetime('now','-' || ? || ' hours')) AS failed
          `).bind(String(windowHours), String(windowHours)).first<{ published: number | null; failed: number | null }>();
      totals.published = Number(pub?.published ?? 0);
      totals.failed = Number(pub?.failed ?? 0);
    } catch (err) {
      console.warn('[RejectionFunnel] build skipped:', err instanceof Error ? err.message : String(err));
    }
  }

  return { generatedAt: new Date().toISOString(), categoryId, windowHours, totals, rejections };
}

function bump(map: Map<string, number>, key: string, n: number): void {
  map.set(key, (map.get(key) ?? 0) + n);
}

function toSorted(map: Map<string, number>): FunnelStageCount[] {
  return Array.from(map.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}

function clampInt(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
