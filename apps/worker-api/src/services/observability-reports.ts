// ══════════════════════════════════════════════════════════════
// services/observability-reports.ts   (read-only, no behavior change)
//
// Phase-next observability the reviewer asked for. Every function here only
// runs SELECTs and returns shaped data; none of them mutate state or gate the
// pipeline. They give operators the visibility needed to decide WHEN to flip
// the behavioral flags and which sources/queries are worth keeping.
// ══════════════════════════════════════════════════════════════

import type { Env } from '../types';
import { buildCryptoThemeKey } from './story-quality-guard';
import { findEarliestGapSlot } from './rule-gate';

function clampInt(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

// ── 1) Queue QUALITY (diversity), not just count (#5) ─────────────

export interface QueueQualityReport {
  generatedAt: string;
  channelId: string;
  scheduledNext6h: number;
  scheduledNext24h: number;
  uniqueSourcesNext6h: number;
  uniqueFingerprintsNext6h: number;
  maxSourceShareNext24h: number; // 0..1
  topSourceNext24h: string | null;
  topSourceIdNext24h: string | null;
}

interface ScheduledRow { scheduled_at: number | null; source_account: string | null; source_id?: string | null; topic_fingerprint: string | null }

/** Pure: diversity metrics from upcoming scheduled rows. */
export function computeQueueDiversity(rows: ScheduledRow[], nowSec: number): Omit<QueueQualityReport, 'generatedAt' | 'channelId'> {
  const in6h = nowSec + 6 * 3600;
  const in24h = nowSec + 24 * 3600;
  const next6h = rows.filter(r => Number(r.scheduled_at) <= in6h);
  const next24h = rows.filter(r => Number(r.scheduled_at) <= in24h);
  const uniqSources6h = new Set(next6h.map(r => String(r.source_account ?? '')).filter(Boolean)).size;
  const uniqFp6h = new Set(next6h.map(r => String(r.topic_fingerprint ?? '')).filter(Boolean)).size;

  const shareMap = new Map<string, number>();
  const sidMap = new Map<string, number>();
  for (const r of next24h) {
    const acc = String(r.source_account ?? '');
    if (acc) shareMap.set(acc, (shareMap.get(acc) ?? 0) + 1);
    const sid = String(r.source_id ?? '');
    if (sid) sidMap.set(sid, (sidMap.get(sid) ?? 0) + 1);
  }
  let topSource: string | null = null;
  let topCount = 0;
  for (const [acc, n] of shareMap) if (n > topCount) { topCount = n; topSource = acc; }
  let topSourceId: string | null = null;
  let topSidCount = 0;
  for (const [sid, n] of sidMap) if (n > topSidCount) { topSidCount = n; topSourceId = sid; }
  const maxShare = next24h.length > 0 ? Math.round((topCount / next24h.length) * 100) / 100 : 0;

  return {
    scheduledNext6h: next6h.length,
    scheduledNext24h: next24h.length,
    uniqueSourcesNext6h: uniqSources6h,
    uniqueFingerprintsNext6h: uniqFp6h,
    maxSourceShareNext24h: maxShare,
    topSourceNext24h: topSource,
    topSourceIdNext24h: topSourceId,
  };
}

export interface QualitySteerConfig {
  minUniqueSourcesNext6h: number;
  maxSourceShareNext24h: number;
  minUniqueFingerprintsNext6h: number;
}

export function isQueueQualityControllerEnabled(env: Env): boolean {
  return String((env as any).QUEUE_QUALITY_CONTROLLER_ENABLED ?? '').toLowerCase() === 'true';
}

export function getQualitySteerConfig(env: Env): QualitySteerConfig {
  const num = (k: string, d: number) => {
    const n = parseFloat(String((env as any)[k] ?? ''));
    return Number.isFinite(n) ? n : d;
  };
  return {
    minUniqueSourcesNext6h: Math.max(1, Math.floor(num('QUEUE_QUALITY_MIN_UNIQUE_SOURCES_NEXT_6H', 2))),
    maxSourceShareNext24h: num('QUEUE_QUALITY_MAX_SOURCE_SHARE_NEXT_24H', 0.4),
    minUniqueFingerprintsNext6h: Math.max(1, Math.floor(num('QUEUE_QUALITY_MIN_UNIQUE_STORIES_NEXT_6H', 2))),
  };
}

/**
 * Pure: should rotation steer toward MORE diverse sources? True when the
 * upcoming queue is concentrated (too few unique sources/stories, or one
 * source dominates) even if the raw count looks fine. Steering, never reject.
 */
export function decideQualitySteer(
  diversity: { scheduledNext6h: number; uniqueSourcesNext6h: number; uniqueFingerprintsNext6h: number; maxSourceShareNext24h: number },
  cfg: QualitySteerConfig,
): boolean {
  if (diversity.scheduledNext6h <= 0) return false; // nothing scheduled → starvation logic handles it
  if (diversity.uniqueSourcesNext6h < cfg.minUniqueSourcesNext6h) return true;
  if (diversity.uniqueFingerprintsNext6h < cfg.minUniqueFingerprintsNext6h) return true;
  if (diversity.maxSourceShareNext24h > cfg.maxSourceShareNext24h) return true;
  return false;
}

export async function buildQueueQualityReport(env: Env, channelId: string): Promise<QueueQualityReport> {
  const base: QueueQualityReport = {
    generatedAt: new Date().toISOString(), channelId,
    scheduledNext6h: 0, scheduledNext24h: 0, uniqueSourcesNext6h: 0,
    uniqueFingerprintsNext6h: 0, maxSourceShareNext24h: 0, topSourceNext24h: null, topSourceIdNext24h: null,
  };
  if (!env.DB) return base;
  try {
    const res = await env.DB.prepare(`
      SELECT q.scheduled_at AS scheduled_at, d.source_account AS source_account,
             c.source_id AS source_id, d.topic_fingerprint AS topic_fingerprint
      FROM publish_queue q
      LEFT JOIN discovery_items d ON d.id = q.item_id
      LEFT JOIN ai_candidate_queue c ON c.id = q.candidate_id
      WHERE q.channel_id = ? AND q.status IN ('scheduled','retry')
    `).bind(channelId).all<ScheduledRow>();
    const diversity = computeQueueDiversity(res.results ?? [], Math.floor(Date.now() / 1000));
    return { ...base, ...diversity };
  } catch (err) {
    console.warn('[QueueQuality] report skipped:', err instanceof Error ? err.message : String(err));
    return base;
  }
}

// ── 2) Source YIELD per account: scraped → rejected → published (#3,#11) ──

export interface SourceYieldRow {
  sourceAccount: string;
  candidates: number;
  aiRejected: number;
  published: number;
  publishYield: number; // published / candidates, 0..1
}
export interface SourceYieldReport {
  generatedAt: string; categoryId: string | null; windowHours: number; sources: SourceYieldRow[];
}

/** Pure: merge candidate/rejected counts with published counts into a yield table. */
export function shapeSourceYield(
  itemRows: Array<{ source_account: string; status: string; count: number }>,
  publishedRows: Array<{ source_account: string; count: number }>,
): SourceYieldRow[] {
  const map = new Map<string, SourceYieldRow>();
  const get = (acc: string) => {
    let r = map.get(acc);
    if (!r) { r = { sourceAccount: acc, candidates: 0, aiRejected: 0, published: 0, publishYield: 0 }; map.set(acc, r); }
    return r;
  };
  for (const r of itemRows) {
    const acc = String(r.source_account ?? ''); if (!acc) continue;
    const n = Number(r.count) || 0;
    const row = get(acc);
    row.candidates += n;
    if (String(r.status) === 'ai_rejected') row.aiRejected += n;
  }
  for (const r of publishedRows) {
    const acc = String(r.source_account ?? ''); if (!acc) continue;
    get(acc).published += Number(r.count) || 0;
  }
  const out = Array.from(map.values());
  for (const r of out) r.publishYield = r.candidates > 0 ? Math.round((r.published / r.candidates) * 100) / 100 : 0;
  return out.sort((a, b) => b.candidates - a.candidates);
}

export async function buildSourceYieldReport(
  env: Env, opts: { categoryId?: string; windowHours?: number } = {},
): Promise<SourceYieldReport> {
  const windowHours = clampInt(Number(opts.windowHours), 1, 720, 48);
  const categoryId = opts.categoryId && /^[\w-]{1,64}$/.test(opts.categoryId) ? opts.categoryId : null;
  let itemRows: Array<{ source_account: string; status: string; count: number }> = [];
  let publishedRows: Array<{ source_account: string; count: number }> = [];
  if (env.DB) {
    try {
      const items = categoryId
        ? await env.DB.prepare(`
            SELECT source_account, status, COUNT(*) AS count FROM discovery_items
            WHERE category_id=? AND created_at > datetime('now','-' || ? || ' hours')
            GROUP BY source_account, status`).bind(categoryId, String(windowHours)).all<any>()
        : await env.DB.prepare(`
            SELECT source_account, status, COUNT(*) AS count FROM discovery_items
            WHERE created_at > datetime('now','-' || ? || ' hours')
            GROUP BY source_account, status`).bind(String(windowHours)).all<any>();
      itemRows = items.results ?? [];

      const pub = categoryId
        ? await env.DB.prepare(`
            SELECT d.source_account AS source_account, COUNT(*) AS count
            FROM publish_queue q JOIN discovery_items d ON d.id=q.item_id
            WHERE q.status='published' AND d.category_id=?
              AND q.published_at >= unixepoch('now','-' || ? || ' hours')
            GROUP BY d.source_account`).bind(categoryId, String(windowHours)).all<any>()
        : await env.DB.prepare(`
            SELECT d.source_account AS source_account, COUNT(*) AS count
            FROM publish_queue q JOIN discovery_items d ON d.id=q.item_id
            WHERE q.status='published' AND q.published_at >= unixepoch('now','-' || ? || ' hours')
            GROUP BY d.source_account`).bind(String(windowHours)).all<any>();
      publishedRows = pub.results ?? [];
    } catch (err) {
      console.warn('[SourceYield] report skipped:', err instanceof Error ? err.message : String(err));
    }
  }
  return { generatedAt: new Date().toISOString(), categoryId, windowHours, sources: shapeSourceYield(itemRows, publishedRows) };
}

// ── 3) Topic MIX of published output by theme (#12) ───────────────

export interface TopicMixReport {
  generatedAt: string; categoryId: string | null; windowHours: number;
  totalPublished: number; byTheme: Array<{ theme: string; count: number }>;
}

/** Pure: classify published captions/texts into theme buckets. */
export function shapeTopicMix(rows: Array<{ text: string | null; caption_full: string | null }>): Array<{ theme: string; count: number }> {
  const map = new Map<string, number>();
  for (const r of rows) {
    const text = String(r.text ?? r.caption_full ?? '');
    const theme = buildCryptoThemeKey(null, text) ?? 'theme:other';
    map.set(theme, (map.get(theme) ?? 0) + 1);
  }
  return Array.from(map.entries()).map(([theme, count]) => ({ theme, count })).sort((a, b) => b.count - a.count);
}

export async function buildTopicMixReport(
  env: Env, opts: { categoryId?: string; windowHours?: number } = {},
): Promise<TopicMixReport> {
  const windowHours = clampInt(Number(opts.windowHours), 1, 720, 48);
  const categoryId = opts.categoryId && /^[\w-]{1,64}$/.test(opts.categoryId) ? opts.categoryId : null;
  let rows: Array<{ text: string | null; caption_full: string | null }> = [];
  if (env.DB) {
    try {
      rows = (categoryId
        ? await env.DB.prepare(`
            SELECT d.text AS text, q.caption_full AS caption_full
            FROM publish_queue q JOIN discovery_items d ON d.id=q.item_id
            WHERE q.status='published' AND d.category_id=?
              AND q.published_at >= unixepoch('now','-' || ? || ' hours')`).bind(categoryId, String(windowHours)).all<any>()
        : await env.DB.prepare(`
            SELECT d.text AS text, q.caption_full AS caption_full
            FROM publish_queue q JOIN discovery_items d ON d.id=q.item_id
            WHERE q.status='published' AND q.published_at >= unixepoch('now','-' || ? || ' hours')`).bind(String(windowHours)).all<any>()
      ).results ?? [];
    } catch (err) {
      console.warn('[TopicMix] report skipped:', err instanceof Error ? err.message : String(err));
    }
  }
  return { generatedAt: new Date().toISOString(), categoryId, windowHours, totalPublished: rows.length, byTheme: shapeTopicMix(rows) };
}

// ── 4) Source daily-cap PREVIEW (report-only, #6) ─────────────────

export interface SourceCapPreviewRow { sourceAccount: string; published24h: number; cap: number; wouldCap: number }
export interface SourceCapPreviewReport {
  generatedAt: string; channelId: string; cap: number | null; rows: SourceCapPreviewRow[];
}

/** Pure: given published-per-source and a cap, how many would be blocked. */
export function shapeCapPreview(rows: Array<{ source_account: string; count: number }>, cap: number | null): SourceCapPreviewRow[] {
  if (!cap || cap <= 0) return [];
  return rows
    .map(r => ({ sourceAccount: String(r.source_account ?? ''), published24h: Number(r.count) || 0, cap, wouldCap: Math.max(0, (Number(r.count) || 0) - cap) }))
    .filter(r => r.sourceAccount && r.wouldCap > 0)
    .sort((a, b) => b.wouldCap - a.wouldCap);
}

export async function buildSourceCapPreview(env: Env, channelId: string): Promise<SourceCapPreviewReport> {
  const base: SourceCapPreviewReport = { generatedAt: new Date().toISOString(), channelId, cap: null, rows: [] };
  if (!env.DB) return base;
  try {
    const chan = await env.DB.prepare(
      `SELECT max_posts_per_source_per_day AS cap FROM channels WHERE id=?`,
    ).bind(channelId).first<{ cap: number | null }>();
    const cap = chan?.cap != null ? Number(chan.cap) : null;
    const pub = await env.DB.prepare(`
      SELECT d.source_account AS source_account, COUNT(*) AS count
      FROM publish_queue q JOIN discovery_items d ON d.id=q.item_id
      WHERE q.channel_id=? AND q.status='published'
        AND q.published_at >= unixepoch('now','-24 hours')
      GROUP BY d.source_account`).bind(channelId).all<{ source_account: string; count: number }>();
    return { ...base, cap, rows: shapeCapPreview(pub.results ?? [], cap) };
  } catch (err) {
    console.warn('[SourceCapPreview] report skipped:', err instanceof Error ? err.message : String(err));
    return base;
  }
}

// ── 5) AI cost by source (needs migration 0019 + AI_COST_ATTRIBUTION_ENABLED) ──

export interface AiCostBySourceRow {
  sourceAccount: string;
  sourceId: string | null;
  scoringCalls: number;
  translationCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  published: number;
  tokensPerPublished: number | null;
}
export interface AiCostBySourceReport {
  generatedAt: string; categoryId: string | null; windowHours: number;
  attributionEnabled: boolean; granularity: string; sources: AiCostBySourceRow[];
}

function costKey(account: string, sourceId: string | null): string {
  return `${account}::${sourceId ?? 'unknown'}`;
}

/** Pure: merge attribution rows + published counts into a per (account,source_id) cost table. */
export function shapeAiCostBySource(
  attrRows: Array<{ source_account: string; source_id: string | null; purpose: string; input_tokens: number; output_tokens: number }>,
  publishedRows: Array<{ source_account: string; source_id: string | null; count: number }>,
): AiCostBySourceRow[] {
  const map = new Map<string, AiCostBySourceRow>();
  const get = (acc: string, sid: string | null) => {
    const k = costKey(acc, sid);
    let r = map.get(k);
    if (!r) { r = { sourceAccount: acc, sourceId: sid ?? null, scoringCalls: 0, translationCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, published: 0, tokensPerPublished: null }; map.set(k, r); }
    return r;
  };
  for (const a of attrRows) {
    const acc = String(a.source_account ?? ''); if (!acc) continue;
    const r = get(acc, a.source_id ?? null);
    if (String(a.purpose) === 'scoring') r.scoringCalls++;
    else if (String(a.purpose) === 'translation') r.translationCalls++;
    r.inputTokens += Number(a.input_tokens) || 0;
    r.outputTokens += Number(a.output_tokens) || 0;
  }
  for (const p of publishedRows) {
    const acc = String(p.source_account ?? ''); if (!acc) continue;
    get(acc, p.source_id ?? null).published += Number(p.count) || 0;
  }
  const out = Array.from(map.values());
  for (const r of out) {
    r.totalTokens = r.inputTokens + r.outputTokens;
    r.tokensPerPublished = r.published > 0 ? Math.round(r.totalTokens / r.published) : null;
  }
  return out.sort((a, b) => b.totalTokens - a.totalTokens);
}

export async function buildAiCostBySourceReport(
  env: Env, opts: { categoryId?: string; windowHours?: number } = {},
): Promise<AiCostBySourceReport> {
  const windowHours = clampInt(Number(opts.windowHours), 1, 720, 72);
  const categoryId = opts.categoryId && /^[\w-]{1,64}$/.test(opts.categoryId) ? opts.categoryId : null;
  const attributionEnabled = String((env as any).AI_COST_ATTRIBUTION_ENABLED ?? '').toLowerCase() === 'true';
  let attrRows: any[] = [];
  let publishedRows: Array<{ source_account: string; source_id: string | null; count: number }> = [];
  if (env.DB) {
    try {
      attrRows = (categoryId
        ? await env.DB.prepare(`
            SELECT source_account, source_id, purpose, input_tokens, output_tokens FROM ai_usage_attribution
            WHERE category_id=? AND created_at > datetime('now','-' || ? || ' hours')`).bind(categoryId, String(windowHours)).all<any>()
        : await env.DB.prepare(`
            SELECT source_account, source_id, purpose, input_tokens, output_tokens FROM ai_usage_attribution
            WHERE created_at > datetime('now','-' || ? || ' hours')`).bind(String(windowHours)).all<any>()
      ).results ?? [];
    } catch { /* table missing (migration not applied) → empty */ }
    try {
      // published per (account, source_id): join through ai_candidate_queue for source_id
      publishedRows = ((categoryId
        ? await env.DB.prepare(`
            SELECT d.source_account AS source_account, c.source_id AS source_id, COUNT(*) AS count
            FROM publish_queue q
            JOIN discovery_items d ON d.id=q.item_id
            LEFT JOIN ai_candidate_queue c ON c.id=q.candidate_id
            WHERE q.status='published' AND d.category_id=?
              AND q.published_at >= unixepoch('now','-' || ? || ' hours')
            GROUP BY d.source_account, c.source_id`).bind(categoryId, String(windowHours)).all<any>()
        : await env.DB.prepare(`
            SELECT d.source_account AS source_account, c.source_id AS source_id, COUNT(*) AS count
            FROM publish_queue q
            JOIN discovery_items d ON d.id=q.item_id
            LEFT JOIN ai_candidate_queue c ON c.id=q.candidate_id
            WHERE q.status='published'
              AND q.published_at >= unixepoch('now','-' || ? || ' hours')
            GROUP BY d.source_account, c.source_id`).bind(String(windowHours)).all<any>()
      ).results) ?? [];
    } catch { /* ignore */ }
  }
  return { generatedAt: new Date().toISOString(), categoryId, windowHours, attributionEnabled, granularity: 'source_account_source_id', sources: shapeAiCostBySource(attrRows, publishedRows) };
}

// ── 6) Apify/source query yield (per source_account + source_id, with rates) ──

export interface QueryYieldRow {
  sourceAccount: string;
  sourceId: string | null;
  candidates: number;
  duplicates: number;     // pre-AI duplicate rejections
  aiRejected: number;
  published: number;
  rejectRate: number;     // aiRejected / candidates
  duplicateRate: number;  // duplicates / (candidates + duplicates)
  publishYield: number;   // published / candidates
}
export interface QueryYieldReport {
  generatedAt: string; categoryId: string | null; windowHours: number;
  granularity: string; queryLevelAvailable: boolean; note: string; sources: QueryYieldRow[];
}

/** Pure: build per (account, source_id) query-yield rows. */
export function shapeQueryYield(
  itemRows: Array<{ source_account: string; source_id: string | null; status: string; reject_reason: string | null; count: number }>,
  publishedRows: Array<{ source_account: string; source_id: string | null; count: number }>,
): QueryYieldRow[] {
  const map = new Map<string, QueryYieldRow>();
  const get = (acc: string, sid: string | null) => {
    const k = `${acc}::${sid ?? 'unknown'}`;
    let r = map.get(k);
    if (!r) { r = { sourceAccount: acc, sourceId: sid ?? null, candidates: 0, duplicates: 0, aiRejected: 0, published: 0, rejectRate: 0, duplicateRate: 0, publishYield: 0 }; map.set(k, r); }
    return r;
  };
  for (const row of itemRows) {
    const acc = String(row.source_account ?? ''); if (!acc) continue;
    const n = Number(row.count) || 0;
    const r = get(acc, row.source_id ?? null);
    const reason = String(row.reject_reason ?? '');
    const isDuplicate = /duplicate|dedupe|already/i.test(reason);
    if (isDuplicate) { r.duplicates += n; continue; } // pre-AI duplicate, not a real candidate
    r.candidates += n;
    if (String(row.status) === 'ai_rejected') r.aiRejected += n;
  }
  for (const p of publishedRows) {
    const acc = String(p.source_account ?? ''); if (!acc) continue;
    get(acc, p.source_id ?? null).published += Number(p.count) || 0;
  }
  const out = Array.from(map.values());
  for (const r of out) {
    r.rejectRate = r.candidates > 0 ? Math.round((r.aiRejected / r.candidates) * 100) / 100 : 0;
    r.duplicateRate = (r.candidates + r.duplicates) > 0 ? Math.round((r.duplicates / (r.candidates + r.duplicates)) * 100) / 100 : 0;
    r.publishYield = r.candidates > 0 ? Math.round((r.published / r.candidates) * 100) / 100 : 0;
  }
  return out.sort((a, b) => b.candidates - a.candidates);
}

export async function buildApifyQueryYieldReport(
  env: Env, opts: { categoryId?: string; windowHours?: number } = {},
): Promise<QueryYieldReport> {
  const windowHours = clampInt(Number(opts.windowHours), 1, 720, 72);
  const categoryId = opts.categoryId && /^[\w-]{1,64}$/.test(opts.categoryId) ? opts.categoryId : null;
  const note = 'Per-source yield from discovery_items. source_id resolved via ai_candidate_queue. query/cohort-level breakdown not yet stored.';
  let itemRows: any[] = [];
  let publishedRows: Array<{ source_account: string; source_id: string | null; count: number }> = [];
  if (env.DB) {
    try {
      itemRows = ((categoryId
        ? await env.DB.prepare(`
            SELECT d.source_account AS source_account, c.source_id AS source_id,
                   d.status AS status, d.reject_reason AS reject_reason, COUNT(*) AS count
            FROM discovery_items d
            LEFT JOIN ai_candidate_queue c ON c.post_id = d.post_id AND c.source_account = d.source_account
            WHERE d.category_id=? AND d.created_at > datetime('now','-' || ? || ' hours')
            GROUP BY d.source_account, c.source_id, d.status, d.reject_reason`).bind(categoryId, String(windowHours)).all<any>()
        : await env.DB.prepare(`
            SELECT d.source_account AS source_account, c.source_id AS source_id,
                   d.status AS status, d.reject_reason AS reject_reason, COUNT(*) AS count
            FROM discovery_items d
            LEFT JOIN ai_candidate_queue c ON c.post_id = d.post_id AND c.source_account = d.source_account
            WHERE d.created_at > datetime('now','-' || ? || ' hours')
            GROUP BY d.source_account, c.source_id, d.status, d.reject_reason`).bind(String(windowHours)).all<any>()
      ).results) ?? [];
    } catch (err) {
      console.warn('[QueryYield] item query skipped:', err instanceof Error ? err.message : String(err));
    }
    try {
      publishedRows = ((categoryId
        ? await env.DB.prepare(`
            SELECT d.source_account AS source_account, c.source_id AS source_id, COUNT(*) AS count
            FROM publish_queue q JOIN discovery_items d ON d.id=q.item_id
            LEFT JOIN ai_candidate_queue c ON c.id=q.candidate_id
            WHERE q.status='published' AND d.category_id=?
              AND q.published_at >= unixepoch('now','-' || ? || ' hours')
            GROUP BY d.source_account, c.source_id`).bind(categoryId, String(windowHours)).all<any>()
        : await env.DB.prepare(`
            SELECT d.source_account AS source_account, c.source_id AS source_id, COUNT(*) AS count
            FROM publish_queue q JOIN discovery_items d ON d.id=q.item_id
            LEFT JOIN ai_candidate_queue c ON c.id=q.candidate_id
            WHERE q.status='published'
              AND q.published_at >= unixepoch('now','-' || ? || ' hours')
            GROUP BY d.source_account, c.source_id`).bind(String(windowHours)).all<any>()
      ).results) ?? [];
    } catch { /* ignore */ }
  }
  return { generatedAt: new Date().toISOString(), categoryId, windowHours, granularity: 'source_account_source_id', queryLevelAvailable: false, note, sources: shapeQueryYield(itemRows, publishedRows) };
}

// ── 7) Gap-fill PREVIEW (report-only) ─────────────────────────────

export interface GapFillPreviewRow {
  queueId: string;
  currentScheduledAt: number;
  proposedScheduledAt: number;
  deltaMinutes: number;
  sourceAccount: string | null;
  captionPreview: string | null;
}
export interface GapFillPreviewReport {
  generatedAt: string; channelId: string; nowSec: number; minGapMinutes: number;
  previewAccuracy: string; note: string; movedEarlierCount: number; rows: GapFillPreviewRow[];
}

export async function buildGapFillPreview(env: Env, channelId: string): Promise<GapFillPreviewReport> {
  const nowSec = Math.floor(Date.now() / 1000);
  const base: GapFillPreviewReport = {
    generatedAt: new Date().toISOString(), channelId, nowSec, minGapMinutes: 0,
    previewAccuracy: 'min_gap_only',
    note: 'Preview applies min_gap only; channel allowed/blocked windows are NOT applied here, so proposed times are a lower bound (rule gate may push later into an allowed window).',
    movedEarlierCount: 0, rows: [],
  };
  if (!env.DB) return base;
  try {
    const chan = await env.DB.prepare(
      `SELECT min_gap_minutes AS gap FROM channels WHERE id=?`,
    ).bind(channelId).first<{ gap: number | null }>();
    const minGapMinutes = chan?.gap != null ? Number(chan.gap) : 0;

    const res = await env.DB.prepare(`
      SELECT q.id AS queueId, q.scheduled_at AS scheduled_at, q.caption_short AS caption_short,
             d.source_account AS source_account
      FROM publish_queue q LEFT JOIN discovery_items d ON d.id=q.item_id
      WHERE q.channel_id=? AND q.status IN ('scheduled','retry')
      ORDER BY q.scheduled_at ASC`).bind(channelId).all<{ queueId: string; scheduled_at: number; caption_short: string | null; source_account: string | null }>();
    const rows = res.results ?? [];

    // Simulate gap-fill: assign each post (in current order) to the earliest
    // free slot from now, against the slots already proposed in this pass.
    const identity = (u: number) => u;
    const proposed: number[] = [];
    const out: GapFillPreviewRow[] = [];
    let movedEarlier = 0;
    for (const r of rows) {
      const current = Number(r.scheduled_at) || 0;
      const slot = findEarliestGapSlot(nowSec, proposed, minGapMinutes, identity);
      proposed.push(slot);
      const deltaMinutes = Math.round((slot - current) / 60);
      if (slot < current) movedEarlier++;
      out.push({
        queueId: String(r.queueId),
        currentScheduledAt: current,
        proposedScheduledAt: slot,
        deltaMinutes,
        sourceAccount: r.source_account ?? null,
        captionPreview: r.caption_short ? String(r.caption_short).slice(0, 80) : null,
      });
    }
    return { ...base, minGapMinutes, movedEarlierCount: movedEarlier, rows: out.slice(0, 100) };
  } catch (err) {
    console.warn('[GapFillPreview] report skipped:', err instanceof Error ? err.message : String(err));
    return base;
  }
}

// ── Retention cleanup for ai_usage_attribution (cron, daily-guarded) ──

export function getAttributionRetentionDays(env: Env): number {
  const n = parseInt(String((env as any).AI_USAGE_ATTRIBUTION_RETENTION_DAYS ?? '45'), 10);
  return Number.isFinite(n) && n > 0 ? n : 45;
}

/**
 * Delete ai_usage_attribution rows older than the retention window. Runs at most
 * once per ~20h (guarded via a settings marker) and only when cost attribution
 * is enabled. Best-effort; never throws into the cron.
 */
export async function cleanupAiUsageAttribution(env: Env): Promise<{ ran: boolean; deleted: number }> {
  if (!env.DB) return { ran: false, deleted: 0 };
  if (String((env as any).AI_COST_ATTRIBUTION_ENABLED ?? '').toLowerCase() !== 'true') return { ran: false, deleted: 0 };
  const MARKER = 'ai_usage_attribution_last_cleanup';
  try {
    const last = await env.DB.prepare(`SELECT value FROM settings WHERE key=?`).bind(MARKER).first<{ value: string }>();
    const lastMs = last?.value ? Date.parse(last.value) : 0;
    if (Number.isFinite(lastMs) && Date.now() - lastMs < 20 * 60 * 60 * 1000) {
      return { ran: false, deleted: 0 }; // ran recently
    }
    const days = getAttributionRetentionDays(env);
    const res = await env.DB.prepare(
      `DELETE FROM ai_usage_attribution WHERE created_at < datetime('now','-' || ? || ' days')`,
    ).bind(String(days)).run();
    const deleted = Number((res as any)?.meta?.changes ?? 0);
    await env.DB.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).bind(MARKER, new Date().toISOString()).run();
    if (deleted > 0) console.log('[CostAttribution] retention cleanup removed', deleted, 'rows older than', days, 'days');
    return { ran: true, deleted };
  } catch (err) {
    console.warn('[CostAttribution] cleanup skipped:', err instanceof Error ? err.message : String(err));
    return { ran: false, deleted: 0 };
  }
}
