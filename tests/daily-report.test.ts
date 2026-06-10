import { describe, expect, it } from 'vitest';
import { handleAdmin } from '../apps/worker-api/src/routes/admin';

function request(path: string): Request {
  return new Request(`http://localhost${path}`, { method: 'GET' });
}

function makeDailyReportEnv(options: { failOptionalTables?: boolean } = {}) {
  const sqls: string[] = [];
  const binds: unknown[][] = [];

  const env = {
    AI_CANDIDATE_BACKLOG_ENABLED: 'true',
    AI_FAIR_SOURCE_PICKER_ENABLED: 'true',
    AI_MAX_CALLS_PER_DAY: '100',
    AI_DAILY_TOKEN_BUDGET: '200000',
    DB: {
      prepare: (sql: string) => {
        sqls.push(sql);
        const stmt = {
          bind: (...args: unknown[]) => {
            binds.push(args);
            return stmt;
          },
          first: async () => firstForSql(sql),
          all: async () => ({ results: allForSql(sql, options.failOptionalTables) }),
          run: async () => { throw new Error('daily report must be read-only'); },
        };
        return stmt;
      },
    },
    __sqls: sqls,
    __binds: binds,
  } as any;

  return env;
}

function firstForSql(sql: string): any {
  if (sql.includes('FROM discovery_runs') && sql.includes('SUM(items_fetched)')) {
    return {
      runs: 4,
      fetched: 96,
      duplicate: 72,
      fresh: 24,
      ai_selected: 3,
      ai_rejected: 12,
      queued: 3,
      processing: 0,
      failed: 0,
      last_run_at: '2026-06-08 04:45:26',
    };
  }
  return null;
}

function allForSql(sql: string, failOptionalTables = false): any[] {
  if (failOptionalTables && (sql.includes('ai_candidate_queue') || sql.includes('ai_usage') || sql.includes('run_events'))) {
    throw new Error('optional table missing');
  }

  if (sql.includes('FROM discovery_runs') && sql.includes('GROUP BY status')) {
    return [{ status: 'completed', count: 4 }];
  }

  if (sql.includes('FROM discovery_items') && sql.includes('GROUP BY status')) {
    return [
      { status: 'ai_rejected', count: 12 },
      { status: 'ai_selected', count: 3 },
    ];
  }

  if (sql.includes('reject_reason') && sql.includes('GROUP BY COALESCE')) {
    return [{ reject_reason: 'ai_not_publish', count: 12 }];
  }

  if (sql.includes('source_account') && sql.includes('FROM discovery_items')) {
    return [
      { source_account: 'Cointelegraph', total: 10, selected: 3, rejected: 7, queued: 0 },
      { source_account: 'scottmelker', total: 2, selected: 0, rejected: 2, queued: 0 },
    ];
  }

  if (sql.includes('FROM publish_queue pq') && sql.includes('GROUP BY pq.status')) {
    if (sql.includes('WHERE 1=1')) {
      return [
        { status: 'scheduled', count: 2 },
        { status: 'published', count: 3 },
      ];
    }
    return [{ status: 'published', count: 3 }];
  }

  if (sql.includes('FROM ai_candidate_queue') && sql.includes('GROUP BY status')) {
    return [
      { status: 'pending', count: 5 },
      { status: 'failed', count: 1 },
    ];
  }

  if (sql.includes('FROM ai_candidate_queue') && sql.includes("status='pending'")) {
    return [{ source_account: 'beincrypto', count: 5 }];
  }

  if (sql.includes('FROM ai_usage')) {
    return [
      { provider: 'anthropic', purpose: 'scoring', status: 'success', calls: 7, tokens: 12000 },
      { provider: 'gemini', purpose: 'translation', status: 'success', calls: 3, tokens: 3000 },
    ];
  }

  if (sql.includes('FROM discovery_runs') && sql.includes('ORDER BY created_at DESC') && sql.includes('LIMIT 10')) {
    return [{
      id: 'run_1', category_id: 'crypto', platform: 'x', apify_dataset_id: 'dataset_1', status: 'completed',
      items_fetched: 24, items_new: 19, items_duplicate: 5, items_ai_selected: 3, items_ai_rejected: 7,
      items_queued: 3, error_message: null, created_at: '2026-06-08 04:35:26', completed_at: '2026-06-08 04:36:26',
    }];
  }

  if (sql.includes('FROM discovery_runs') && sql.includes("status='processing'")) {
    return [];
  }

  if (sql.includes('FROM run_events') && sql.includes('GROUP BY severity')) {
    return [{ severity: 'info', count: 10 }];
  }

  return [];
}

describe('Phase 5 daily operational report', () => {
  it('returns a read-only funnel report from existing tracking tables', async () => {
    const env = makeDailyReportEnv();
    const res = await handleAdmin(request('/internal/report/daily?hours=24&category=crypto'), env, {} as ExecutionContext);
    const body: any = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.read_only).toBe(true);
    expect(body.window).toEqual({ hours: 24, category_id: 'crypto' });
    expect(body.funnel.fetched).toBe(96);
    expect(body.funnel.duplicate).toBe(72);
    expect(body.funnel.fresh).toBe(24);
    expect(body.funnel.ai_selected).toBe(3);
    expect(body.funnel.ai_rejected).toBe(12);
    expect(body.funnel.queued).toBe(3);
    expect(body.funnel.duplicate_rate_pct).toBe(75);
    expect(body.funnel.ai_select_rate_pct).toBe(20);
    expect(body.statuses.discovery_items.ai_rejected).toBe(12);
    expect(body.statuses.publish_queue_current.scheduled).toBe(2);
    expect(body.backlog.status_counts.pending).toBe(5);
    expect(body.backlog.top_pending_accounts).toEqual([{ source_account: 'beincrypto', count: 5 }]);
    expect(body.rejection_reasons).toEqual([{ reason: 'ai_not_publish', count: 12 }]);
    expect(body.source_accounts[0].source_account).toBe('Cointelegraph');
    expect(body.source_accounts[0].select_rate_pct).toBe(30);
    expect(body.ai_budget.scoring.calls).toBe(7);
    expect(body.ai_budget.scoring.calls_remaining).toBe(93);
    expect(body.ai_budget.translation.calls).toBe(3);
  });

  it('uses SELECT-only queries and parameterized category filters', async () => {
    const env = makeDailyReportEnv();
    await handleAdmin(request('/internal/report/daily?hours=999&category=crypto_main'), env, {} as ExecutionContext);

    expect(env.__sqls.length).toBeGreaterThan(0);
    for (const sql of env.__sqls) {
      expect(sql).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/i);
    }

    const flattenedBinds = env.__binds.flat();
    expect(flattenedBinds).toContain('-168 hours');
    expect(flattenedBinds).toContain('crypto_main');
  });

  it('drops unsafe category filters instead of passing them into SQL bindings', async () => {
    const env = makeDailyReportEnv();
    const res = await handleAdmin(request('/internal/report/daily?hours=0&category=crypto%27%3Bdrop'), env, {} as ExecutionContext);
    const body: any = await res.json();

    expect(res.status).toBe(200);
    expect(body.window.hours).toBe(1);
    expect(body.window.category_id).toBe(null);
    expect(env.__binds.flat()).not.toContain("crypto';drop");
  });

  it('degrades gracefully when optional backlog or usage tables are unavailable', async () => {
    const env = makeDailyReportEnv({ failOptionalTables: true });
    const res = await handleAdmin(request('/internal/report/daily'), env, {} as ExecutionContext);
    const body: any = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.window.hours).toBe(24);
    expect(body.backlog.status_counts).toEqual({});
    expect(body.ai_budget.scoring.calls).toBe(0);
    expect(body.statuses.run_events_by_severity).toEqual({});
  });
});
