import { describe, expect, it } from 'vitest';
import { handleAdmin } from '../apps/worker-api/src/routes/admin';

function request(path: string): Request {
  return new Request(`http://localhost${path}`, { method: 'GET' });
}

function makeOperationalReportEnv() {
  const sqls: string[] = [];
  const binds: unknown[][] = [];

  const env = {
    APIFY_ROTATION_INTERVAL_HOURS: '3',
    DB: {
      prepare: (sql: string) => {
        sqls.push(sql);
        const stmt = {
          bind: (...args: unknown[]) => {
            binds.push(args);
            return stmt;
          },
          first: async () => firstForSql(sql),
          all: async () => ({ results: allForSql(sql) }),
          run: async () => { throw new Error('operational report must be read-only'); },
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
  if (sql.includes('COUNT(*) AS count') && sql.includes('FROM apify_sources')) {
    return { count: 6 };
  }

  if (sql.includes('FROM discovery_runs') && sql.includes('SUM(items_fetched)')) {
    return {
      runs: 4,
      fetched: 120,
      duplicate: 80,
      fresh: 40,
      ai_selected: 10,
      ai_rejected: 20,
      queued: 8,
      processing: 0,
      failed: 1,
      last_run_at: '2026-06-10 10:00:00',
    };
  }

  return null;
}

function allForSql(sql: string): any[] {
  if (sql.includes('FROM ai_usage')) {
    return [
      {
        provider: 'anthropic',
        purpose: 'scoring',
        model: 'claude-haiku-4-5-20251001',
        calls: 10,
        input_tokens: 100000,
        output_tokens: 10000,
      },
      {
        provider: 'gemini',
        purpose: 'translation',
        model: 'gemini-2.5-flash-lite',
        calls: 4,
        input_tokens: 50000,
        output_tokens: 20000,
      },
    ];
  }

  if (sql.includes('FROM publish_queue pq') && sql.includes("status IN ('scheduled','retry','publishing','failed')")) {
    return [
      { status: 'scheduled', count: 30 },
      { status: 'failed', count: 1 },
    ];
  }

  if (sql.includes('FROM publish_queue pq') && sql.includes('GROUP BY pq.status')) {
    return [
      { status: 'published', count: 20 },
      { status: 'scheduled', count: 5 },
    ];
  }

  if (sql.includes('FROM discovery_items') && sql.includes('GROUP BY status')) {
    return [
      { status: 'ai_selected', count: 10 },
      { status: 'ai_rejected', count: 20 },
    ];
  }

  if (sql.includes('FROM discovery_items') && sql.includes('source_account')) {
    return [
      { source_account: 'CoinDesk', total: 12, selected: 4, rejected: 8, queued: 3 },
    ];
  }

  if (sql.includes('FROM ai_candidate_queue') && sql.includes("status='pending'")) {
    return [
      { source_account: 'Cointelegraph', count: 7 },
    ];
  }

  if (sql.includes('FROM ai_candidate_queue') && sql.includes('GROUP BY status')) {
    return [
      { status: 'pending', count: 7 },
      { status: 'failed', count: 2 },
    ];
  }

  if (sql.includes('FROM discovery_runs') && sql.includes("status='processing'")) {
    return [];
  }

  if (sql.includes('FROM discovery_runs') && sql.includes("status='failed'")) {
    return [
      { id: 'run_failed', category_id: 'crypto', platform: 'x', apify_dataset_id: 'ds', status: 'failed', error_message: 'boom', created_at: '2026-06-10 10:00:00' },
    ];
  }

  return [];
}

describe('operational report endpoint', () => {
  it('returns multi-window cost, funnel, queue, and Apify projection data', async () => {
    const env = makeOperationalReportEnv();
    const res = await handleAdmin(request('/internal/report/ops?category=crypto'), env, {} as ExecutionContext);
    const body: any = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.read_only).toBe(true);
    expect(body.category_id).toBe('crypto');

    expect(body.windows).toHaveLength(5);
    expect(body.windows[0].key).toBe('24h');
    expect(body.windows[0].ai.rows).toHaveLength(2);
    expect(body.windows[0].ai.total_cost_usd).toBeGreaterThan(0);
    expect(body.windows[0].pipeline.fetched).toBe(120);
    expect(body.windows[0].pipeline.duplicate_rate_pct).toBe(66.67);
    expect(body.windows[0].publish.published).toBe(20);

    expect(body.current.publish_queue_active.scheduled).toBe(30);
    expect(body.current.ai_candidate_backlog.pending).toBe(7);
    expect(body.current.top_pending_accounts[0].source_account).toBe('Cointelegraph');

    expect(body.apify.available).toBe(false);
    expect(body.apify.reason).toBe('apify_token_not_configured');
    expect(body.apify.active_sources).toBe(6);
    expect(body.apify.projected_runs_per_month).toBe(1440);
  });

  it('uses SELECT-only queries', async () => {
    const env = makeOperationalReportEnv();
    await handleAdmin(request('/internal/report/ops?category=crypto'), env, {} as ExecutionContext);

    expect(env.__sqls.length).toBeGreaterThan(0);
    for (const sql of env.__sqls) {
      expect(sql).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/i);
    }

    expect(env.__binds.flat()).toContain('crypto');
  });
});
