// ══════════════════════════════════════════════════════════════
// services/source-reputation.ts
// Phase 6I (observe-only foundation) — per-source performance + a pure
// reputation score, computed read-only from run_item_events and
// publish_queue⋈discovery_items. This intentionally does NOT influence any
// pipeline decision yet; it gives the operator a correct working report
// (their ad-hoc source-performance query failed on wrong column names) and
// the metrics a future active reputation layer would weight.
// ══════════════════════════════════════════════════════════════

import type { Env } from '../types';

export interface SourceMetrics {
  sourceAccount: string;
  aiSelected: number;
  aiRejected: number;
  queued: number;
  published: number;
}

export interface SourceReputationRow extends SourceMetrics {
  /** published / (aiSelected + aiRejected), 0..1 */
  acceptanceRate: number;
  /** published share of the whole channel, 0..1 */
  dominanceShare: number;
  /** 0..100 reputation (see computeSourceReputation) */
  reputation: number;
}

export interface SourceBucketRow {
  sourceAccount: string;
  sourceId: string;
  published: number;
}

export interface SourcePerformanceReport {
  generatedAt: string;
  categoryId: string | null;
  windowHours: number;
  totalPublished: number;
  sources: SourceReputationRow[];
  /** account + source_id (bucket) published breakdown, e.g. CoinDesk inside src_crypto_x_news_text */
  publishedByBucket: SourceBucketRow[];
}

/**
 * Pure reputation score (0..100). Rewards sources that get accepted and
 * published; penalises high rejection and excessive dominance so no single
 * outlet is implicitly trusted to fill the channel.
 *
 *   acceptance = published / max(selected+rejected, 1)
 *   penalty for dominance above an even share is applied softly.
 */
export function computeSourceReputation(m: SourceMetrics, totalPublished: number): number {
  const gated = m.aiSelected + m.aiRejected;
  const acceptance = gated > 0 ? m.published / gated : 0;
  const dominance = totalPublished > 0 ? m.published / totalPublished : 0;
  // Soft dominance penalty: only bites past ~25% of the channel.
  const dominancePenalty = Math.max(0, dominance - 0.25);
  const raw = 0.8 * acceptance + 0.2 * Math.min(1, m.published / 10) - 0.6 * dominancePenalty;
  return Math.round(Math.max(0, Math.min(1, raw)) * 100);
}

function normalizeAccount(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/^@+/, '');
}

/**
 * Pure shaping: merge per-source event counts and published counts into rows,
 * compute derived metrics, and sort by published desc. Split out for tests.
 */
export function shapeSourcePerformance(
  eventCounts: Array<{ source_account: string; status: string; count: number }>,
  publishedCounts: Array<{ source_account: string; count: number }>,
): { totalPublished: number; sources: SourceReputationRow[] } {
  const metrics = new Map<string, SourceMetrics>();
  const get = (acct: string): SourceMetrics => {
    const key = normalizeAccount(acct);
    let m = metrics.get(key);
    if (!m) { m = { sourceAccount: key, aiSelected: 0, aiRejected: 0, queued: 0, published: 0 }; metrics.set(key, m); }
    return m;
  };

  for (const r of eventCounts) {
    const n = Number(r.count) || 0;
    if (n <= 0 || !r.source_account) continue;
    const m = get(r.source_account);
    if (r.status === 'ai_selected') m.aiSelected += n;
    else if (r.status === 'ai_rejected') m.aiRejected += n;
    else if (r.status === 'queue_created') m.queued += n;
  }
  for (const r of publishedCounts) {
    const n = Number(r.count) || 0;
    if (n <= 0 || !r.source_account) continue;
    get(r.source_account).published += n;
  }

  const totalPublished = Array.from(metrics.values()).reduce((s, m) => s + m.published, 0);

  const sources: SourceReputationRow[] = Array.from(metrics.values()).map(m => {
    const gated = m.aiSelected + m.aiRejected;
    return {
      ...m,
      acceptanceRate: gated > 0 ? round2(m.published / gated) : 0,
      dominanceShare: totalPublished > 0 ? round2(m.published / totalPublished) : 0,
      reputation: computeSourceReputation(m, totalPublished),
    };
  }).sort((a, b) => b.published - a.published || b.reputation - a.reputation);

  return { totalPublished, sources };
}

export async function buildSourcePerformanceReport(
  env: Env,
  opts: { categoryId?: string; windowHours?: number } = {},
): Promise<SourcePerformanceReport> {
  const windowHours = clampInt(opts.windowHours ?? 48, 1, 720, 48);
  const categoryId = opts.categoryId && /^[\w-]{1,64}$/.test(opts.categoryId) ? opts.categoryId : null;

  let eventCounts: Array<{ source_account: string; status: string; count: number }> = [];
  let publishedCounts: Array<{ source_account: string; count: number }> = [];
  let bucketRows: Array<{ source_account: string; source_id: string | null; count: number }> = [];

  if (env.DB) {
    try {
      // Phase 6I fix: category-filter via joins (run_item_events/publish_queue
      // carry no category_id). Unfiltered path preserved when no category given.
      const ev = categoryId
        ? await env.DB.prepare(`
            SELECT e.source_account AS source_account, e.status AS status, COUNT(*) AS count
            FROM run_item_events e
            JOIN discovery_runs r ON r.id = e.run_id
            WHERE e.created_at > datetime('now','-' || ? || ' hours')
              AND r.category_id = ?
              AND e.status IN ('ai_selected','ai_rejected','queue_created')
            GROUP BY e.source_account, e.status
          `).bind(String(windowHours), categoryId).all<{ source_account: string; status: string; count: number }>()
        : await env.DB.prepare(`
            SELECT source_account, status, COUNT(*) AS count
            FROM run_item_events
            WHERE created_at > datetime('now','-' || ? || ' hours')
              AND status IN ('ai_selected','ai_rejected','queue_created')
            GROUP BY source_account, status
          `).bind(String(windowHours)).all<{ source_account: string; status: string; count: number }>();
      eventCounts = ev.results ?? [];

      // Review fix: a "published in the last N hours" window must filter on
      // published_at (when it actually went out), not created_at (when the row
      // was queued). Also expose a source_account + source_id (bucket) level so
      // operators can see e.g. CoinDesk inside src_crypto_x_news_text.
      const pub = categoryId
        ? await env.DB.prepare(`
            SELECT d.source_account AS source_account, c.source_id AS source_id, COUNT(*) AS count
            FROM publish_queue q
            JOIN discovery_items d ON d.id = q.item_id
            LEFT JOIN ai_candidate_queue c ON c.id = q.candidate_id
            WHERE q.status = 'published'
              AND q.published_at >= unixepoch('now','-' || ? || ' hours')
              AND d.category_id = ?
            GROUP BY d.source_account, c.source_id
          `).bind(String(windowHours), categoryId).all<{ source_account: string; source_id: string | null; count: number }>()
        : await env.DB.prepare(`
            SELECT d.source_account AS source_account, c.source_id AS source_id, COUNT(*) AS count
            FROM publish_queue q
            JOIN discovery_items d ON d.id = q.item_id
            LEFT JOIN ai_candidate_queue c ON c.id = q.candidate_id
            WHERE q.status = 'published'
              AND q.published_at >= unixepoch('now','-' || ? || ' hours')
            GROUP BY d.source_account, c.source_id
          `).bind(String(windowHours)).all<{ source_account: string; source_id: string | null; count: number }>();
      bucketRows = pub.results ?? [];
      // collapse bucket rows to account-level for the main `sources` table
      const byAccount = new Map<string, number>();
      for (const r of bucketRows) {
        const n = Number(r.count) || 0;
        byAccount.set(r.source_account, (byAccount.get(r.source_account) ?? 0) + n);
      }
      publishedCounts = Array.from(byAccount.entries()).map(([source_account, count]) => ({ source_account, count }));
    } catch (err) {
      console.warn('[SourceReputation] report skipped:', err instanceof Error ? err.message : String(err));
    }
  }

  const { totalPublished, sources } = shapeSourcePerformance(eventCounts, publishedCounts);
  const publishedByBucket = shapeBucketBreakdown(bucketRows);
  return { generatedAt: new Date().toISOString(), categoryId, windowHours, totalPublished, sources, publishedByBucket };
}

/** Pure: account+bucket published breakdown, sorted by published desc. */
export function shapeBucketBreakdown(
  rows: Array<{ source_account: string; source_id: string | null; count: number }>,
): SourceBucketRow[] {
  const map = new Map<string, SourceBucketRow>();
  for (const r of rows) {
    const n = Number(r.count) || 0;
    if (n <= 0 || !r.source_account) continue;
    const account = normalizeAccount(r.source_account);
    const sourceId = String(r.source_id ?? 'unknown');
    const key = `${account}::${sourceId}`;
    const existing = map.get(key);
    if (existing) existing.published += n;
    else map.set(key, { sourceAccount: account, sourceId, published: n });
  }
  return Array.from(map.values()).sort((a, b) => b.published - a.published);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clampInt(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
