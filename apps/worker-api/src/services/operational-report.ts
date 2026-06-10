import type { Env } from '../types';

type ReportWindow = {
  key: string;
  label: string;
  hours: number;
};

const REPORT_WINDOWS: ReportWindow[] = [
  { key: '24h', label: '۲۴ ساعت گذشته', hours: 24 },
  { key: '7d', label: '۷ روز گذشته', hours: 7 * 24 },
  { key: '15d', label: '۱۵ روز گذشته', hours: 15 * 24 },
  { key: '30d', label: '۳۰ روز گذشته', hours: 30 * 24 },
  { key: '180d', label: '۶ ماه گذشته', hours: 180 * 24 },
];

type CountRow = { status: string; count: number };
type AIUsageRow = {
  provider: string;
  purpose: string;
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
};

type PipelineRow = {
  runs: number;
  fetched: number;
  duplicate: number;
  fresh: number;
  ai_selected: number;
  ai_rejected: number;
  queued: number;
  processing: number;
  failed: number;
  last_run_at: string | null;
};

type SourceRow = {
  source_account: string;
  total: number;
  selected: number;
  rejected: number;
  queued: number;
};

type ApifyTaskRow = {
  id: string;
  apify_task_id: string | null;
};

type ApifyRun = {
  task_id: string;
  started_at: string;
  usage_usd: number;
};

export async function buildOperationalReport(env: Env, url: URL): Promise<object> {
  const rawCategory = url.searchParams.get('category') ?? url.searchParams.get('category_id');
  const categoryId = rawCategory && isValidReportId(rawCategory) ? rawCategory : undefined;

  const windows = await Promise.all(
    REPORT_WINDOWS.map(window => buildWindowReport(env, window, categoryId))
  );

  const current = await buildCurrentState(env, categoryId);
  const apify = await buildApifyReport(env, REPORT_WINDOWS);

  return {
    read_only: true,
    generated_at: new Date().toISOString(),
    currency: 'USD',
    category_id: categoryId ?? null,
    windows,
    current,
    apify,
  };
}

async function buildWindowReport(env: Env, window: ReportWindow, categoryId?: string): Promise<object> {
  const modifier = `-${window.hours} hours`;

  const categoryFilter = categoryId ? ' AND category_id=?' : '';
  const categoryParams = categoryId ? [categoryId] : [];

  const queueCategoryJoin = categoryId ? 'JOIN discovery_items di ON di.id = pq.item_id' : '';
  const queueCategoryFilter = categoryId ? ' AND di.category_id=?' : '';
  const queueCategoryParams = categoryId ? [categoryId] : [];

  const [aiRows, pipeline, publishRows, itemRows, sourceRows] = await Promise.all([
    safeAll<AIUsageRow>(env, `
      SELECT
        provider,
        purpose,
        model,
        COUNT(*) AS calls,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens
      FROM ai_usage
      WHERE status='success'
        AND created_at >= datetime('now', ?)
      GROUP BY provider, purpose, model
      ORDER BY provider, purpose, model
    `, [modifier]),

    safeFirst<PipelineRow>(env, `
      SELECT
        COUNT(*) AS runs,
        COALESCE(SUM(items_fetched), 0) AS fetched,
        COALESCE(SUM(items_duplicate), 0) AS duplicate,
        COALESCE(SUM(items_new), 0) AS fresh,
        COALESCE(SUM(items_ai_selected), 0) AS ai_selected,
        COALESCE(SUM(items_ai_rejected), 0) AS ai_rejected,
        COALESCE(SUM(items_queued), 0) AS queued,
        COALESCE(SUM(CASE WHEN status='processing' THEN 1 ELSE 0 END), 0) AS processing,
        COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END), 0) AS failed,
        MAX(created_at) AS last_run_at
      FROM discovery_runs
      WHERE created_at >= datetime('now', ?)
      ${categoryFilter}
    `, [modifier, ...categoryParams], emptyPipeline()),

    safeAll<CountRow>(env, `
      SELECT pq.status AS status, COUNT(*) AS count
      FROM publish_queue pq
      ${queueCategoryJoin}
      WHERE (
        pq.created_at >= datetime('now', ?)
        OR pq.published_at >= CAST(strftime('%s','now', ?) AS INTEGER)
      )
      ${queueCategoryFilter}
      GROUP BY pq.status
      ORDER BY count DESC, pq.status
    `, [modifier, modifier, ...queueCategoryParams]),

    safeAll<CountRow>(env, `
      SELECT status, COUNT(*) AS count
      FROM discovery_items
      WHERE created_at >= datetime('now', ?)
      ${categoryFilter}
      GROUP BY status
      ORDER BY count DESC, status
    `, [modifier, ...categoryParams]),

    safeAll<SourceRow>(env, `
      SELECT
        COALESCE(NULLIF(source_account,''), '__unknown__') AS source_account,
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status='ai_selected' THEN 1 ELSE 0 END), 0) AS selected,
        COALESCE(SUM(CASE WHEN status='ai_rejected' THEN 1 ELSE 0 END), 0) AS rejected,
        COALESCE(SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END), 0) AS queued
      FROM discovery_items
      WHERE created_at >= datetime('now', ?)
      ${categoryFilter}
      GROUP BY COALESCE(NULLIF(source_account,''), '__unknown__')
      ORDER BY total DESC, source_account
      LIMIT 20
    `, [modifier, ...categoryParams]),
  ]);

  const pipe = normalizePipeline(pipeline);
  const ai = buildAICostReport(aiRows, window.hours);

  return {
    key: window.key,
    label: window.label,
    hours: window.hours,
    ai,
    pipeline: {
      ...pipe,
      duplicate_rate_pct: pipe.fetched > 0 ? pct(pipe.duplicate, pipe.fetched) : null,
      fresh_rate_pct: pipe.fetched > 0 ? pct(pipe.fresh, pipe.fetched) : null,
      ai_select_rate_pct: pipe.ai_selected + pipe.ai_rejected > 0
        ? pct(pipe.ai_selected, pipe.ai_selected + pipe.ai_rejected)
        : null,
      queued_rate_of_fresh_pct: pipe.fresh > 0 ? pct(pipe.queued, pipe.fresh) : null,
    },
    publish: countRowsToObject(publishRows),
    discovery_items: countRowsToObject(itemRows),
    top_sources: sourceRows.map(row => ({
      source_account: row.source_account,
      total: toCount(row.total),
      selected: toCount(row.selected),
      rejected: toCount(row.rejected),
      queued: toCount(row.queued),
      select_rate_pct: toCount(row.total) > 0 ? pct(toCount(row.selected), toCount(row.total)) : null,
    })),
  };
}

async function buildCurrentState(env: Env, categoryId?: string): Promise<object> {
  const categoryFilter = categoryId ? ' AND category_id=?' : '';
  const categoryParams = categoryId ? [categoryId] : [];
  const queueCategoryJoin = categoryId ? 'JOIN discovery_items di ON di.id = pq.item_id' : '';
  const queueCategoryFilter = categoryId ? ' AND di.category_id=?' : '';
  const queueCategoryParams = categoryId ? [categoryId] : [];

  const [publishActive, backlogStatuses, backlogTopAccounts, stuckRuns, recentErrors] = await Promise.all([
    safeAll<CountRow>(env, `
      SELECT pq.status AS status, COUNT(*) AS count
      FROM publish_queue pq
      ${queueCategoryJoin}
      WHERE pq.status IN ('scheduled','retry','publishing','failed')
      ${queueCategoryFilter}
      GROUP BY pq.status
      ORDER BY count DESC, pq.status
    `, queueCategoryParams),

    safeAll<CountRow>(env, `
      SELECT status, COUNT(*) AS count
      FROM ai_candidate_queue
      WHERE 1=1
      ${categoryFilter}
      GROUP BY status
      ORDER BY count DESC, status
    `, categoryParams),

    safeAll<{ source_account: string; count: number }>(env, `
      SELECT COALESCE(NULLIF(source_account,''), '__unknown__') AS source_account, COUNT(*) AS count
      FROM ai_candidate_queue
      WHERE status='pending'
      ${categoryFilter}
      GROUP BY COALESCE(NULLIF(source_account,''), '__unknown__')
      ORDER BY count DESC, source_account
      LIMIT 20
    `, categoryParams),

    safeAll<any>(env, `
      SELECT id, category_id, platform, apify_dataset_id, status, error_message, created_at
      FROM discovery_runs
      WHERE status='processing'
        AND created_at < datetime('now','-30 minutes')
        ${categoryFilter}
      ORDER BY created_at ASC
      LIMIT 20
    `, categoryParams),

    safeAll<any>(env, `
      SELECT id, category_id, platform, apify_dataset_id, status, error_message, created_at
      FROM discovery_runs
      WHERE status='failed'
        AND created_at >= datetime('now','-24 hours')
        ${categoryFilter}
      ORDER BY created_at DESC
      LIMIT 20
    `, categoryParams),
  ]);

  return {
    publish_queue_active: countRowsToObject(publishActive),
    ai_candidate_backlog: countRowsToObject(backlogStatuses),
    top_pending_accounts: backlogTopAccounts.map(row => ({
      source_account: row.source_account,
      count: toCount(row.count),
    })),
    stuck_processing_runs: stuckRuns,
    recent_failed_runs: recentErrors,
  };
}

function buildAICostReport(rows: AIUsageRow[], hours: number): object {
  const pricedRows = rows.map(row => {
    const rate = getAIRate(row.provider, row.model);
    const inputTokens = toCount(row.input_tokens);
    const outputTokens = toCount(row.output_tokens);
    const cost = inputTokens * rate.inputPerMillion / 1_000_000
      + outputTokens * rate.outputPerMillion / 1_000_000;

    return {
      provider: row.provider,
      purpose: row.purpose,
      model: row.model,
      calls: toCount(row.calls),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      input_usd_per_1m: rate.inputPerMillion,
      output_usd_per_1m: rate.outputPerMillion,
      cost_usd: round(cost, 6),
      projected_monthly_usd: hours > 0 ? round(cost / hours * 24 * 30, 2) : null,
    };
  });

  const total = pricedRows.reduce((sum, row: any) => sum + Number(row.cost_usd ?? 0), 0);

  return {
    total_cost_usd: round(total, 6),
    projected_monthly_usd: hours > 0 ? round(total / hours * 24 * 30, 2) : null,
    rows: pricedRows,
  };
}

function getAIRate(provider: string, model: string): { inputPerMillion: number; outputPerMillion: number } {
  const p = String(provider ?? '').toLowerCase();
  const m = String(model ?? '').toLowerCase();

  if ((p === 'anthropic' || p === 'claude') && m.includes('haiku')) {
    return { inputPerMillion: 1, outputPerMillion: 5 };
  }

  if (p === 'gemini' && m.includes('2.5-flash-lite')) {
    return { inputPerMillion: 0.10, outputPerMillion: 0.40 };
  }

  if (p === 'gemini') {
    return { inputPerMillion: 0.10, outputPerMillion: 0.40 };
  }

  return { inputPerMillion: 0, outputPerMillion: 0 };
}

async function buildApifyReport(env: Env, windows: ReportWindow[]): Promise<object> {
  const intervalHours = Math.max(1, Number((env as any).APIFY_ROTATION_INTERVAL_HOURS ?? 3) || 3);
  const sourceCountRow = await safeFirst<{ count: number }>(env, `
    SELECT COUNT(*) AS count
    FROM apify_sources
    WHERE enabled=1
      AND apify_task_id IS NOT NULL
      AND apify_task_id != ''
  `, [], { count: 0 });

  const activeSources = toCount(sourceCountRow.count);
  const projectedRunsPerMonth = Math.round(activeSources * (24 / intervalHours) * 30);

  const base = {
    available: false,
    active_sources: activeSources,
    rotation_interval_hours: intervalHours,
    projected_runs_per_month: projectedRunsPerMonth,
    windows: [],
    avg_cost_per_run_usd: null,
    projected_monthly_cost_usd: null,
  };

  const token = String((env as any).APIFY_TOKEN ?? '').trim();
  if (!token) {
    return {
      ...base,
      reason: 'apify_token_not_configured',
    };
  }

  const tasks = await safeAll<ApifyTaskRow>(env, `
    SELECT id, apify_task_id
    FROM apify_sources
    WHERE enabled=1
      AND apify_task_id IS NOT NULL
      AND apify_task_id != ''
    ORDER BY id
    LIMIT 50
  `);

  if (tasks.length === 0) {
    return {
      ...base,
      reason: 'no_enabled_apify_tasks',
    };
  }

  try {
    const maxHours = Math.max(...windows.map(w => w.hours));
    const since = new Date(Date.now() - maxHours * 3_600_000);
    const runs: ApifyRun[] = [];

    for (const task of tasks) {
      if (!task.apify_task_id) continue;
      const taskRuns = await fetchApifyTaskRunsSince(token, task.apify_task_id, since);
      runs.push(...taskRuns);
    }

    const byWindow = windows.map(window => {
      const cutoff = Date.now() - window.hours * 3_600_000;
      const selected = runs.filter(run => Date.parse(run.started_at) >= cutoff);
      const cost = selected.reduce((sum, run) => sum + run.usage_usd, 0);
      const avg = selected.length > 0 ? cost / selected.length : null;

      return {
        key: window.key,
        label: window.label,
        hours: window.hours,
        runs: selected.length,
        cost_usd: round(cost, 6),
        avg_cost_per_run_usd: avg === null ? null : round(avg, 6),
        projected_monthly_usd: window.hours > 0 ? round(cost / window.hours * 24 * 30, 2) : null,
      };
    });

    const allCost = runs.reduce((sum, run) => sum + run.usage_usd, 0);
    const avgCostPerRun = runs.length > 0 ? allCost / runs.length : null;

    return {
      available: true,
      active_sources: activeSources,
      rotation_interval_hours: intervalHours,
      projected_runs_per_month: projectedRunsPerMonth,
      fetched_runs: runs.length,
      avg_cost_per_run_usd: avgCostPerRun === null ? null : round(avgCostPerRun, 6),
      projected_monthly_cost_usd: avgCostPerRun === null ? null : round(avgCostPerRun * projectedRunsPerMonth, 2),
      windows: byWindow,
    };
  } catch (error) {
    return {
      ...base,
      reason: 'apify_usage_fetch_failed',
      error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    };
  }
}

async function fetchApifyTaskRunsSince(token: string, taskId: string, since: Date): Promise<ApifyRun[]> {
  const runs: ApifyRun[] = [];
  const limit = 1000;
  const maxPages = 10;
  const sinceMs = since.getTime();

  for (let page = 0; page < maxPages; page++) {
    const offset = page * limit;
    const url = `https://api.apify.com/v2/actor-tasks/${encodeURIComponent(taskId)}/runs?token=${encodeURIComponent(token)}&limit=${limit}&offset=${offset}&desc=1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Apify task runs ${taskId} HTTP ${res.status}`);

    const body: any = await res.json().catch(() => null);
    const items: any[] = Array.isArray(body?.data?.items) ? body.data.items : [];
    if (items.length === 0) break;

    let reachedOlderThanWindow = false;

    for (const item of items) {
      const startedAt = String(item?.startedAt ?? item?.createdAt ?? '');
      const startedMs = Date.parse(startedAt);
      if (!Number.isFinite(startedMs)) continue;

      if (startedMs < sinceMs) {
        reachedOlderThanWindow = true;
        continue;
      }

      runs.push({
        task_id: taskId,
        started_at: startedAt,
        usage_usd: Number(item?.usageTotalUsd ?? item?.usageUsd ?? 0) || 0,
      });
    }

    if (reachedOlderThanWindow || items.length < limit) break;
  }

  return runs;
}

function normalizePipeline(row: PipelineRow): PipelineRow {
  return {
    runs: toCount(row.runs),
    fetched: toCount(row.fetched),
    duplicate: toCount(row.duplicate),
    fresh: toCount(row.fresh),
    ai_selected: toCount(row.ai_selected),
    ai_rejected: toCount(row.ai_rejected),
    queued: toCount(row.queued),
    processing: toCount(row.processing),
    failed: toCount(row.failed),
    last_run_at: row.last_run_at ?? null,
  };
}

function emptyPipeline(): PipelineRow {
  return {
    runs: 0,
    fetched: 0,
    duplicate: 0,
    fresh: 0,
    ai_selected: 0,
    ai_rejected: 0,
    queued: 0,
    processing: 0,
    failed: 0,
    last_run_at: null,
  };
}

async function safeFirst<T>(env: Env, sql: string, binds: unknown[], fallback: T): Promise<T> {
  try {
    const stmt = env.DB.prepare(sql);
    const row = binds.length > 0 ? await stmt.bind(...binds).first<T>() : await stmt.first<T>();
    return row ?? fallback;
  } catch (error) {
    console.warn('[OperationalReport] safeFirst failed:', error instanceof Error ? error.message : String(error));
    return fallback;
  }
}

async function safeAll<T>(env: Env, sql: string, binds: unknown[] = []): Promise<T[]> {
  try {
    const stmt = env.DB.prepare(sql);
    const result = binds.length > 0 ? await stmt.bind(...binds).all<T>() : await stmt.all<T>();
    return (result.results ?? []) as T[];
  } catch (error) {
    console.warn('[OperationalReport] safeAll failed:', error instanceof Error ? error.message : String(error));
    return [];
  }
}

function countRowsToObject(rows: CountRow[], key = 'status'): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const name = String((row as any)[key] ?? 'unknown');
    out[name] = toCount(row.count);
  }
  return out;
}

function toCount(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function pct(part: number, total: number): number {
  if (total <= 0) return 0;
  return round((part / total) * 100, 2);
}

function round(value: number, digits: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function isValidReportId(id: string): boolean {
  return /^[\w-]{1,64}$/.test(id);
}
