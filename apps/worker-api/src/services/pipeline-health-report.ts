// IMPROVEMENT #10: observability — single pipeline health report.
//
// Replaces the ad-hoc D1 queries we ran by hand during debugging with one
// endpoint that returns the whole funnel + cost/health signals as JSON.
//
// WIRING (do this in routeRequest, behind your existing internal-secret auth):
//   import { buildPipelineHealthReport } from './services/pipeline-health-report';
//   if (url.pathname === '/admin/pipeline-health' && isInternalAuthed(request, env)) {
//     return Response.json(await buildPipelineHealthReport(env));
//   }
//
// IMPORTANT: this is READ-ONLY. It must sit behind the same auth as other
// /admin routes — do NOT expose publicly (it reveals operational internals).
// This file has not been integration-tested against your live D1; review the
// column names against your schema before wiring.

import type { Env } from '../types';

export interface PipelineHealthReport {
  generatedAt: string;
  windowHours: number;
  funnel: {
    fetched: number;
    newItems: number;
    duplicates: number;
    aiSelected: number;
    queued: number;
    duplicateRatio: number; // duplicates / fetched
  };
  attempts: Array<{ attempt: string; runs: number; healthy: number; avgRealRaw: number; avgMock: number }>;
  reprocessHotspots: Array<{ datasetId: string; runCount: number; duplicates: number }>;
  rejectReasons: Array<{ reason: string; count: number }>;
  translationMissing: number;
  queueStatus: Array<{ status: string; count: number }>;
  queryErrors: string[]; // v4: surfaced so schema mismatches are visible
  alerts: string[];
}

// v4.1: collect query errors per-call (not module-level) so concurrent health
// requests can't interleave each other's error lists. A monitoring tool that
// hides its own failures is worse than useless, so errors surface in the report.
async function q<T = Record<string, unknown>>(
  env: Env, errors: string[], label: string, sql: string, ...binds: unknown[]
): Promise<T[]> {
  try {
    const stmt = binds.length ? env.DB.prepare(sql).bind(...binds) : env.DB.prepare(sql);
    const res = await stmt.all<T>();
    return res.results ?? [];
  } catch (err) {
    errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export async function buildPipelineHealthReport(env: Env, windowHours = 6, categoryId?: string): Promise<PipelineHealthReport> {
  const w = String(windowHours);
  const queryErrors: string[] = []; // v4.1: per-call, not module-level
  // v4: optional category scoping so multi-category setups don't mix funnels.
  const catFilter = categoryId ? ' AND category_id = ?' : '';
  const catBind: unknown[] = categoryId ? [categoryId] : [];

  // Funnel from discovery_runs
  const funnelRows = await q<{ fetched: number; new_items: number; dup: number; sel: number; queued: number }>(
    env, queryErrors, 'funnel',
    `SELECT SUM(items_fetched) AS fetched, SUM(items_new) AS new_items,
            SUM(items_duplicate) AS dup, SUM(items_ai_selected) AS sel, SUM(items_queued) AS queued
     FROM discovery_runs
     WHERE created_at >= datetime('now','-' || ? || ' hours')${catFilter}`,
    w, ...catBind,
  );
  const f = funnelRows[0] ?? { fetched: 0, new_items: 0, dup: 0, sel: 0, queued: 0 };
  const fetched = Number(f.fetched) || 0;
  const duplicates = Number(f.dup) || 0;

  // Attempt health
  const attempts = await q<{ attempt: string; runs: number; healthy: number; avg_real: number; avg_mock: number }>(
    env, queryErrors, 'attempts',
    `SELECT json_extract(metadata_json,'$.attempt') AS attempt,
            COUNT(*) AS runs,
            SUM(CASE WHEN json_extract(metadata_json,'$.datasetHealth.realRawCount') > 0 THEN 1 ELSE 0 END) AS healthy,
            AVG(json_extract(metadata_json,'$.datasetHealth.realRawCount')) AS avg_real,
            AVG(json_extract(metadata_json,'$.datasetHealth.actorMockCount')) AS avg_mock
     FROM run_events
     WHERE event_type='apify.rotation.task_started'
       AND created_at >= datetime('now','-' || ? || ' hours')
     GROUP BY attempt ORDER BY runs DESC`,
    w,
  );

  // Reprocess hotspots
  const hotspots = await q<{ ds: string; run_count: number; dup: number }>(
    env, queryErrors, 'hotspots',
    `SELECT apify_dataset_id AS ds, COUNT(*) AS run_count, SUM(items_duplicate) AS dup
     FROM discovery_runs
     WHERE created_at >= datetime('now','-' || ? || ' hours')${catFilter}
     GROUP BY apify_dataset_id HAVING COUNT(*) > 1
     ORDER BY run_count DESC LIMIT 10`,
    w, ...catBind,
  );

  // Reject reasons
  const rejects = await q<{ reject_reason: string; count: number }>(
    env, queryErrors, 'rejects',
    `SELECT reject_reason, COUNT(*) AS count
     FROM discovery_items
     WHERE created_at >= datetime('now','-' || ? || ' hours') AND status='ai_rejected'${catFilter}
     GROUP BY reject_reason ORDER BY count DESC LIMIT 20`,
    w, ...catBind,
  );

  // Translation missing
  const tm = await q<{ count: number }>(
    env, queryErrors, 'translation_missing',
    `SELECT COUNT(*) AS count FROM run_item_events
     WHERE status='translation_missing' AND created_at >= datetime('now','-' || ? || ' hours')`,
    w,
  );

  // Queue status
  const queue = await q<{ status: string; count: number }>(
    env, queryErrors, 'queue',
    `SELECT status, COUNT(*) AS count FROM ai_candidate_queue
     WHERE created_at >= datetime('now','-' || ? || ' hours')${catFilter}
     GROUP BY status ORDER BY count DESC`,
    w, ...catBind,
  );

  const duplicateRatio = fetched > 0 ? duplicates / fetched : 0;

  // Alerts — the thresholds we cared about during debugging.
  const alerts: string[] = [];
  if (duplicateRatio > 0.8) alerts.push(`HIGH duplicate ratio: ${(duplicateRatio * 100).toFixed(0)}%`);
  if (hotspots.some(h => Number(h.run_count) > 5)) alerts.push('Dataset reprocessing detected (>5 runs on one dataset)');
  if ((Number(f.queued) || 0) === 0) alerts.push(`Zero items queued in last ${w}h`);
  if ((Number(tm[0]?.count) || 0) > 5) alerts.push(`translation_missing elevated: ${tm[0]?.count}`);
  const primary = attempts.find(a => a.attempt === 'primary');
  if (primary && Number(primary.avg_mock) > Number(primary.avg_real)) {
    alerts.push('Primary attempt still mock-dominated');
  }
  if (queryErrors.length > 0) alerts.push(`report_query_failed: ${queryErrors.length} query(ies)`);

  return {
    generatedAt: new Date().toISOString(),
    windowHours,
    funnel: {
      fetched,
      newItems: Number(f.new_items) || 0,
      duplicates,
      aiSelected: Number(f.sel) || 0,
      queued: Number(f.queued) || 0,
      duplicateRatio: Math.round(duplicateRatio * 1000) / 1000,
    },
    attempts: attempts.map(a => ({
      attempt: String(a.attempt ?? 'unknown'),
      runs: Number(a.runs) || 0,
      healthy: Number(a.healthy) || 0,
      avgRealRaw: Math.round((Number(a.avg_real) || 0) * 100) / 100,
      avgMock: Math.round((Number(a.avg_mock) || 0) * 100) / 100,
    })),
    reprocessHotspots: hotspots.map(h => ({
      datasetId: String(h.ds ?? ''),
      runCount: Number(h.run_count) || 0,
      duplicates: Number(h.dup) || 0,
    })),
    rejectReasons: rejects.map(r => ({ reason: String(r.reject_reason ?? 'unknown'), count: Number(r.count) || 0 })),
    translationMissing: Number(tm[0]?.count) || 0,
    queueStatus: queue.map(s => ({ status: String(s.status ?? 'unknown'), count: Number(s.count) || 0 })),
    queryErrors: [...queryErrors],
    alerts,
  };
}
