import type { Env } from '../types';

function clampInt(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function safeCategory(value: string | undefined): string | null {
  const raw = String(value ?? '').trim();
  return /^[\w-]{1,64}$/.test(raw) ? raw : null;
}

async function q<T>(
  env: Env,
  errors: string[],
  label: string,
  sql: string,
  ...binds: unknown[]
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

export interface FinalFunnelReport {
  generatedAt: string;
  categoryId: string | null;
  windowHours: number;
  summary: {
    runs: number;
    fetched: number;
    normalized: number;
    droppedNormalizeNull: number;
    droppedMissingUrl: number;
    droppedShortTextNoSignal: number;
    skippedByProcessingCap: number;
    duplicate: number;
    staleBeforeAi: number;
    waitingForAiScore: number;
    aiRejected: number;
    queued: number;
    failed: number;
    skipped: number;
    scheduled: number;
    published: number;
  };
  itemEvents: Array<{ status: string; reason: string | null; count: number }>;
  aiQueue: Array<{ status: string; reason: string | null; sourceAccount: string | null; count: number; avgPriority: number }>;
  publishQueue: Array<{ publishStatus: string | null; candidateStatus: string; sourceAccount: string | null; count: number }>;
  queryErrors: string[];
}

export async function buildFinalFunnelReport(
  env: Env,
  opts: { categoryId?: string; windowHours?: number } = {},
): Promise<FinalFunnelReport> {
  const windowHours = clampInt(Number(opts.windowHours), 1, 720, 24);
  const categoryId = safeCategory(opts.categoryId);
  const errors: string[] = [];

  const catRuns = categoryId ? ' AND d.category_id = ?' : '';
  const catBinds: unknown[] = categoryId ? [categoryId] : [];

  const runRows = await q<{ runs: number; fetched: number }>(
    env,
    errors,
    'runs',
    `
      SELECT
        COUNT(*) AS runs,
        COALESCE(SUM(d.items_fetched), 0) AS fetched
      FROM discovery_runs d
      WHERE d.created_at >= datetime('now','-' || ? || ' hours')
      ${catRuns}
    `,
    String(windowHours),
    ...catBinds,
  );

  const normalizeRows = await q<{
    normalized: number;
    dropped_null: number;
    dropped_missing_url: number;
    dropped_short: number;
    skipped_cap: number;
  }>(
    env,
    errors,
    'normalize',
    `
      SELECT
        COALESCE(SUM(CAST(json_extract(re.metadata_json, '$.normalizedCount') AS INTEGER)), 0) AS normalized,
        COALESCE(SUM(CAST(json_extract(re.metadata_json, '$.droppedNormalizeNull') AS INTEGER)), 0) AS dropped_null,
        COALESCE(SUM(CAST(json_extract(re.metadata_json, '$.droppedMissingUrl') AS INTEGER)), 0) AS dropped_missing_url,
        COALESCE(SUM(CAST(json_extract(re.metadata_json, '$.droppedShortTextNoSignal') AS INTEGER)), 0) AS dropped_short,
        COALESCE(SUM(CAST(json_extract(re.metadata_json, '$.normalizedSkippedByProcessingCap') AS INTEGER)), 0) AS skipped_cap
      FROM run_events re
      JOIN discovery_runs d ON d.id = re.run_id
      WHERE re.event_type='normalize.complete'
        AND d.created_at >= datetime('now','-' || ? || ' hours')
      ${catRuns}
    `,
    String(windowHours),
    ...catBinds,
  );

  const itemEvents = await q<{ status: string; reason: string | null; count: number }>(
    env,
    errors,
    'item_events',
    `
      SELECT
        rie.status AS status,
        rie.reject_reason AS reason,
        COUNT(*) AS count
      FROM run_item_events rie
      JOIN discovery_runs d ON d.id = rie.run_id
      WHERE d.created_at >= datetime('now','-' || ? || ' hours')
      ${catRuns}
      GROUP BY rie.status, rie.reject_reason
      ORDER BY count DESC, status, reason
    `,
    String(windowHours),
    ...catBinds,
  );

  const aiQueue = await q<{
    status: string;
    reason: string | null;
    source_account: string | null;
    count: number;
    avg_priority: number;
  }>(
    env,
    errors,
    'ai_queue',
    `
      SELECT
        CASE WHEN acq.status='pending' THEN 'waiting_for_ai_score' ELSE acq.status END AS status,
        acq.last_error AS reason,
        acq.source_account,
        COUNT(*) AS count,
        AVG(acq.priority_score) AS avg_priority
      FROM ai_candidate_queue acq
      JOIN discovery_runs d ON d.id = acq.run_id
      WHERE d.created_at >= datetime('now','-' || ? || ' hours')
      ${catRuns}
      GROUP BY acq.status, acq.last_error, acq.source_account
      ORDER BY count DESC, status, source_account
    `,
    String(windowHours),
    ...catBinds,
  );

  const publishQueue = await q<{
    publish_status: string | null;
    candidate_status: string;
    source_account: string | null;
    count: number;
  }>(
    env,
    errors,
    'publish_queue',
    `
      SELECT
        pq.status AS publish_status,
        acq.status AS candidate_status,
        acq.source_account,
        COUNT(*) AS count
      FROM ai_candidate_queue acq
      JOIN discovery_runs d ON d.id = acq.run_id
      LEFT JOIN publish_queue pq ON pq.source_url = acq.source_url
      WHERE d.created_at >= datetime('now','-' || ? || ' hours')
      ${catRuns}
      GROUP BY pq.status, acq.status, acq.source_account
      ORDER BY count DESC
    `,
    String(windowHours),
    ...catBinds,
  );

  const countItem = (status: string, reason?: string) =>
    itemEvents
      .filter(r => r.status === status && (reason ? r.reason === reason : true))
      .reduce((sum, r) => sum + Number(r.count || 0), 0);

  const countQueue = (status: string) =>
    aiQueue
      .filter(r => r.status === status)
      .reduce((sum, r) => sum + Number(r.count || 0), 0);

  const countPublish = (status: string) =>
    publishQueue
      .filter(r => r.publish_status === status)
      .reduce((sum, r) => sum + Number(r.count || 0), 0);

  const run = runRows[0] ?? { runs: 0, fetched: 0 };
  const norm = normalizeRows[0] ?? {
    normalized: 0,
    dropped_null: 0,
    dropped_missing_url: 0,
    dropped_short: 0,
    skipped_cap: 0,
  };

  return {
    generatedAt: new Date().toISOString(),
    categoryId,
    windowHours,
    summary: {
      runs: Number(run.runs) || 0,
      fetched: Number(run.fetched) || 0,
      normalized: Number(norm.normalized) || 0,
      droppedNormalizeNull: Number(norm.dropped_null) || 0,
      droppedMissingUrl: Number(norm.dropped_missing_url) || 0,
      droppedShortTextNoSignal: Number(norm.dropped_short) || 0,
      skippedByProcessingCap: Number(norm.skipped_cap) || 0,
      duplicate: countItem('duplicate', 'duplicate_dedupe_key'),
      staleBeforeAi: countItem('skipped', 'stale_before_ai'),
      waitingForAiScore: countQueue('waiting_for_ai_score'),
      aiRejected: countQueue('ai_rejected'),
      queued: countQueue('queued'),
      failed: countQueue('failed'),
      skipped: countQueue('skipped'),
      scheduled: countPublish('scheduled'),
      published: countPublish('published'),
    },
    itemEvents: itemEvents.map(r => ({
      status: String(r.status ?? 'unknown'),
      reason: r.reason ?? null,
      count: Number(r.count) || 0,
    })),
    aiQueue: aiQueue.map(r => ({
      status: String(r.status ?? 'unknown'),
      reason: r.reason ?? null,
      sourceAccount: r.source_account ?? null,
      count: Number(r.count) || 0,
      avgPriority: Math.round((Number(r.avg_priority) || 0) * 10) / 10,
    })),
    publishQueue: publishQueue.map(r => ({
      publishStatus: r.publish_status ?? null,
      candidateStatus: String(r.candidate_status ?? 'unknown'),
      sourceAccount: r.source_account ?? null,
      count: Number(r.count) || 0,
    })),
    queryErrors: errors,
  };
}
