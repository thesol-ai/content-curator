import { describe, expect, it } from 'vitest';
import { handleAdmin } from '../apps/worker-api/src/routes/admin';

function request(path: string): Request {
  return new Request(`http://localhost${path}`, {
    method: 'GET',
    headers: { 'x-internal-api-secret': 'test-secret' },
  });
}

/**
 * Env that returns canned per-bucket rows for the three timeseries queries,
 * and throws on any write — proving the endpoint is read-only.
 */
function makeTimeseriesEnv() {
  const sqls: string[] = [];
  const env = {
    INTERNAL_API_SECRET: 'test-secret',
    DB: {
      prepare: (sql: string) => {
        sqls.push(sql);
        const stmt = {
          bind: () => stmt,
          first: async () => null,
          all: async () => ({ results: allForSql(sql) }),
          run: async () => { throw new Error('timeseries must be read-only'); },
        };
        return stmt;
      },
    },
    __sqls: sqls,
  } as any;
  return env;
}

function allForSql(sql: string): any[] {
  if (sql.includes('FROM discovery_items')) {
    return [
      { b: '2026-06-14', total: 10, selected: 3, rejected: 7 },
      { b: '2026-06-15', total: 12, selected: 4, rejected: 8 },
    ];
  }
  if (sql.includes('FROM publish_queue')) {
    return [
      { b: '2026-06-14', published: 2 },
      { b: '2026-06-15', published: 3 },
    ];
  }
  if (sql.includes('FROM ai_usage')) {
    return [
      { b: '2026-06-14', calls: 5, tokens: 4200 },
      { b: '2026-06-15', calls: 6, tokens: 5100 },
    ];
  }
  return [];
}

describe('GET /internal/report/timeseries', () => {
  it('merges items, published and ai usage into one sorted series', async () => {
    const env = makeTimeseriesEnv();
    const res = await handleAdmin(request('/internal/report/timeseries?bucket=day&days=30'), env, {} as any);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.read_only).toBe(true);
    expect(body.bucket).toBe('day');
    expect(Array.isArray(body.series)).toBe(true);
    expect(body.series.length).toBe(2);

    const first = body.series[0];
    expect(first.bucket).toBe('2026-06-14');
    expect(first.scraped).toBe(10);
    expect(first.selected).toBe(3);
    expect(first.rejected).toBe(7);
    expect(first.published).toBe(2);
    expect(first.ai_calls).toBe(5);
    expect(first.ai_tokens).toBe(4200);
  });

  it('clamps bucket to day/week/month and defaults invalid to day', async () => {
    const env = makeTimeseriesEnv();
    const res = await handleAdmin(request('/internal/report/timeseries?bucket=nonsense'), env, {} as any);
    const body = await res.json() as any;
    expect(body.bucket).toBe('day');
  });

  it('accepts week and month buckets', async () => {
    for (const bucket of ['week', 'month']) {
      const env = makeTimeseriesEnv();
      const res = await handleAdmin(request(`/internal/report/timeseries?bucket=${bucket}`), env, {} as any);
      const body = await res.json() as any;
      expect(body.bucket).toBe(bucket);
    }
  });
});
