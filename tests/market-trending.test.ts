import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handleAdmin } from '../apps/worker-api/src/routes/admin';

function request(path: string): Request {
  return new Request(`http://localhost${path}`, { method: 'GET' });
}

const SOURCE_DISABLED = {
  id: 'src_market_trending_x',
  category_id: 'crypto',
  platform: 'x',
  apify_dataset_id: 'PLACEHOLDER_REPLACE_BEFORE_ENABLE',
  label: 'Crypto X Market Trending',
  enabled: 0,
  apify_actor_id: null,
  apify_task_id: null,
  last_dataset_id: null,
  source_config: '{}',
  created_at: '2026-06-08 00:00:00',
};

const SOURCE_ENABLED = {
  ...SOURCE_DISABLED,
  enabled: 1,
  apify_dataset_id: 'realDataset123',
  apify_task_id: 'realTask123',
  last_dataset_id: 'lastDataset123',
};

function makeMarketTrendingEnv(options: { source?: any; noRunEvents?: boolean } = {}) {
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
          first: async () => firstForSql(sql, options),
          all: async () => ({ results: allForSql(sql, options) }),
          run: async () => { throw new Error('market trending report must be read-only'); },
        };
        return stmt;
      },
    },
    __sqls: sqls,
    __binds: binds,
  } as any;

  return env;
}

function firstForSql(sql: string, options: { source?: any }): any {
  if (sql.includes('FROM apify_sources') && sql.includes('WHERE id=?')) {
    return options.source === undefined ? SOURCE_ENABLED : options.source;
  }
  return null;
}

function allForSql(sql: string, options: { noRunEvents?: boolean }): any[] {
  if (sql.includes('FROM discovery_runs dr') && sql.includes('FROM run_events')) {
    if (options.noRunEvents) return [];
    return [
      {
        id: 'run_market_1', category_id: 'crypto', platform: 'x', apify_dataset_id: 'lastDataset123', status: 'completed',
        items_fetched: 40, items_new: 18, items_duplicate: 22, items_ai_selected: 4, items_ai_rejected: 10,
        items_queued: 4, error_message: null, created_at: '2026-06-08 08:00:00', completed_at: '2026-06-08 08:01:00',
      },
      {
        id: 'run_market_2', category_id: 'crypto', platform: 'x', apify_dataset_id: 'lastDataset123', status: 'completed',
        items_fetched: 20, items_new: 12, items_duplicate: 8, items_ai_selected: 2, items_ai_rejected: 8,
        items_queued: 2, error_message: null, created_at: '2026-06-08 12:00:00', completed_at: '2026-06-08 12:01:00',
      },
    ];
  }

  if (sql.includes('FROM discovery_runs') && sql.includes('apify_dataset_id IN')) {
    return [
      {
        id: 'run_fallback_1', category_id: 'crypto', platform: 'x', apify_dataset_id: 'realDataset123', status: 'completed',
        items_fetched: 10, items_new: 6, items_duplicate: 4, items_ai_selected: 1, items_ai_rejected: 5,
        items_queued: 1, error_message: null, created_at: '2026-06-08 08:00:00', completed_at: '2026-06-08 08:01:00',
      },
    ];
  }

  if (sql.includes('FROM discovery_items') && sql.includes('status=\'ai_rejected\'')) {
    return [{ reject_reason: 'ai_not_publish', count: 8 }];
  }

  if (sql.includes('FROM discovery_items') && sql.includes('GROUP BY COALESCE')) {
    return [
      { source_account: 'Cointelegraph', total: 8, selected: 3, rejected: 5, queued: 0 },
      { source_account: 'beincrypto', total: 4, selected: 1, rejected: 3, queued: 0 },
    ];
  }

  if (sql.includes('FROM ai_candidate_queue') && sql.includes('GROUP BY status')) {
    return [
      { status: 'pending', count: 2 },
      { status: 'failed', count: 1 },
    ];
  }

  if (sql.includes('FROM ai_candidate_queue') && sql.includes("status='pending'")) {
    return [{ source_account: 'CoinDesk', count: 2 }];
  }

  return [];
}

describe('Phase 6 market-trending source experiment', () => {
  it('seeds the market-trending source disabled by default', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0016_market_trending_source_seed.sql'), 'utf8');

    expect(sql).toContain('src_market_trending_x');
    expect(sql).toContain('Crypto X Market Trending');
    expect(sql).toContain('PLACEHOLDER_REPLACE_BEFORE_ENABLE');
    expect(sql).toMatch(/'Crypto X Market Trending',\s*\n\s*0,/m);
    expect(sql).toContain('"webhook_source_id":"src_market_trending_x"');
    expect(sql).not.toMatch(/UPDATE\s+apify_sources\s+SET\s+enabled\s*=\s*1/i);
  });

  it('documents the explicit source_id webhook and warns against generic webhooks', () => {
    const doc = readFileSync(join(process.cwd(), 'docs/market-trending-source-rollout.md'), 'utf8');

    expect(doc).toContain('source_id=src_market_trending_x');
    expect(doc).toContain('https://content-curator.thesol-ai.workers.dev/webhook/apify?source_id=src_market_trending_x&secret=YOUR_SECRET');
    expect(doc).toContain('Do not use a generic webhook without `source_id`');
    expect(doc).toContain('{"enabled":false}');
  });

  it('returns a read-only source-specific report', async () => {
    const env = makeMarketTrendingEnv({ source: SOURCE_ENABLED });
    const res = await handleAdmin(request('/internal/report/market-trending?hours=24'), env, {} as ExecutionContext);
    const body: any = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.read_only).toBe(true);
    expect(body.source.id).toBe('src_market_trending_x');
    expect(body.source.enabled).toBe(true);
    expect(body.source.webhook_url_pattern).toBe('/webhook/apify?source_id=src_market_trending_x&secret=***');
    expect(body.pipeline.runs).toBe(2);
    expect(body.pipeline.items_fetched).toBe(60);
    expect(body.pipeline.items_duplicate).toBe(30);
    expect(body.pipeline.items_ai_selected).toBe(6);
    expect(body.quality.duplicate_rate_pct).toBe(50);
    expect(body.quality.ai_select_rate_pct).toBe(25);
    expect(body.recommendation).toBe('keep');
    expect(body.backlog.status_counts.pending).toBe(2);
    expect(body.backlog.top_pending_accounts).toEqual([{ source_account: 'CoinDesk', count: 2 }]);
  });

  it('falls back to dataset matching when run_events are unavailable', async () => {
    const env = makeMarketTrendingEnv({ source: SOURCE_ENABLED, noRunEvents: true });
    const res = await handleAdmin(request('/internal/report/market-trending?hours=24'), env, {} as ExecutionContext);
    const body: any = await res.json();

    expect(res.status).toBe(200);
    expect(body.pipeline.runs).toBe(1);
    expect(body.pipeline.items_fetched).toBe(10);
    expect(body.recommendation).toBe('keep');
  });

  it('returns not_started and placeholder warning while disabled', async () => {
    const env = makeMarketTrendingEnv({ source: SOURCE_DISABLED });
    const res = await handleAdmin(request('/internal/report/market-trending'), env, {} as ExecutionContext);
    const body: any = await res.json();

    expect(res.status).toBe(200);
    expect(body.source.enabled).toBe(false);
    expect(body.source.is_placeholder).toBe(true);
    expect(body.recommendation).toBe('not_started');
    expect(body.warnings).toContain('source_disabled');
    expect(body.warnings).toContain('placeholder_dataset_id_replace_before_enable');
  });

  it('returns 404 if the migration/source seed is not present', async () => {
    const env = makeMarketTrendingEnv({ source: null });
    const res = await handleAdmin(request('/internal/report/market-trending'), env, {} as ExecutionContext);
    const body: any = await res.json();

    expect(res.status).toBe(404);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('source_not_found');
    expect(body.hint).toContain('0016_market_trending_source_seed.sql');
  });

  it('uses SELECT-only report queries and clamps hours', async () => {
    const env = makeMarketTrendingEnv({ source: SOURCE_ENABLED });
    await handleAdmin(request('/internal/report/market-trending?hours=999'), env, {} as ExecutionContext);

    for (const sql of env.__sqls) {
      expect(sql).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/i);
    }
    expect(env.__binds.flat()).toContain('-168 hours');
    expect(env.__binds.flat()).toContain('src_market_trending_x');
  });
});
