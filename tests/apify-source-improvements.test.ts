import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleAdmin } from '../apps/worker-api/src/routes/admin';
import { handleApifyWebhook } from '../apps/worker-api/src/routes/apify-webhook';
import { runCuration } from '../apps/worker-api/src/services/curation-orchestrator';
import type { ApifySourceRow, CategoryRow, Env } from '../apps/worker-api/src/types';

interface DbCall {
  sql: string;
  values: unknown[];
  kind: 'all' | 'first' | 'run';
}

function request(path: string, method: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://worker.test${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function source(overrides: Partial<ApifySourceRow> = {}): ApifySourceRow {
  return {
    id: 'src_crypto',
    category_id: 'crypto',
    platform: 'x',
    apify_dataset_id: 'OLDDATASET123',
    label: 'Crypto X',
    enabled: 1,
    apify_actor_id: 'kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest',
    apify_task_id: 'thesol~crypto-latest',
    last_dataset_id: null,
    source_config: '{}',
    ...overrides,
  };
}

function category(overrides: Partial<CategoryRow> = {}): CategoryRow {
  return {
    id: 'crypto',
    label: 'Crypto',
    prompt_profile: 'crypto_editorial',
    custom_prompt: null,
    score_threshold: 75,
    freshness_hours: 24,
    media_mode: 'optional',
    language_targets: '["fa"]',
    editorial_guidelines: null,
    selection_criteria: null,
    rejection_criteria: null,
    required_context: null,
    avoid_duplicate_people_stories: 1,
    allow_replies: 0,
    allow_retweets: 1,
    allow_quotes: 1,
    text_only_policy: 'allow',
    min_score_for_text_only: null,
    min_score_for_media: null,
    enabled: 1,
    ...overrides,
  };
}

function envWithDb(options: {
  sources?: ApifySourceRow[];
  category?: CategoryRow | null;
  settings?: Record<string, string>;
} = {}) {
  const calls: DbCall[] = [];
  const sources = options.sources ?? [source()];
  const cat = options.category === undefined ? category() : options.category;
  const settings = options.settings ?? { apify_curation_enabled: 'true', apify_curation_dry_run: 'true' };

  const db = {
    prepare: vi.fn((sql: string) => {
      const make = (values: unknown[] = []) => ({
        all: vi.fn(async () => {
          calls.push({ sql, values, kind: 'all' });
          if (sql.includes('SELECT key, value FROM settings')) {
            return { results: Object.entries(settings).map(([key, value]) => ({ key, value })) };
          }
          if (sql.includes('FROM apify_sources') && sql.includes('enabled=1')) return { results: sources };
          return { results: [] };
        }),
        first: vi.fn(async () => {
          calls.push({ sql, values, kind: 'first' });
          if (sql.includes('FROM categories WHERE id=?')) return cat;
          return null;
        }),
        run: vi.fn(async () => {
          calls.push({ sql, values, kind: 'run' });
          return { meta: { changes: 1 } };
        }),
      });
      return {
        bind: vi.fn((...values: unknown[]) => make(values)),
        ...make(),
      };
    }),
  };

  return {
    env: {
      DB: db,
      APIFY_TOKEN: 'apify-token-placeholder',
      APIFY_CURATION_ENABLED: 'true',
      APIFY_CURATION_DRY_RUN: 'true',
      APIFY_MAX_ITEMS_PER_SOURCE: '10',
    } as unknown as Env,
    calls,
  };
}

describe('Apify source task bindings and webhook scoping', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('scopes webhook curation by source_id, fetches the webhook dataset, and records last_dataset_id', async () => {
    const fetches: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      fetches.push(url);
      return Response.json([]);
    }));

    const { env, calls } = envWithDb({
      sources: [
        source({ id: 'src_crypto', apify_dataset_id: 'OLDDATASET123' }),
        source({ id: 'src_design', category_id: 'design', apify_dataset_id: 'DESIGNDATA123' }),
      ],
    });

    const results = await runCuration(env, { sourceId: 'src_crypto', datasetId: 'NEWDATASET123' }, { forceCurationEnabled: true, curationDryRun: true });

    expect(results).toHaveLength(1);
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toContain('/datasets/NEWDATASET123/items');
    expect(calls.some(call => call.sql.includes('UPDATE apify_sources SET last_dataset_id=') && call.values[0] === 'NEWDATASET123' && call.values[1] === 'src_crypto')).toBe(true);
    expect(calls.some(call => call.sql.includes('INSERT OR IGNORE INTO discovery_runs') && call.values.includes('NEWDATASET123'))).toBe(true);
  });

  it('treats unknown source_id as a safe no-op and does not fetch Apify', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    const { env } = envWithDb({ sources: [source({ id: 'src_known' })] });
    const results = await runCuration(env, { sourceId: 'src_missing', datasetId: 'NEWDATASET123' }, { forceCurationEnabled: true });

    expect(results).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('stores actor/task metadata and source_config when creating an Apify source', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...values: unknown[]) => ({
          run: vi.fn(async () => { calls.push({ sql, values }); return { meta: { changes: 1 } }; }),
          all: vi.fn(async () => ({ results: [] })),
          first: vi.fn(async () => null),
        })),
        run: vi.fn(async () => ({ meta: { changes: 1 } })),
        all: vi.fn(async () => ({ results: [] })),
        first: vi.fn(async () => null),
      })),
    };

    const res = await handleAdmin(request('/internal/apify-sources', 'POST', {
      category_id: 'crypto',
      platform: 'x',
      apify_dataset_id: 'DATASET12345',
      label: 'Crypto X task',
      apify_actor_id: 'kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest',
      apify_task_id: 'thesol~crypto-latest',
      source_config: { query: 'from:Cointelegraph filter:images', maxItems: 10 },
    }), { DB: db } as unknown as Env, {} as ExecutionContext);

    expect(res.status).toBe(200);
    const insert = calls.find(call => call.sql.includes('INSERT INTO apify_sources'));
    expect(insert?.values).toContain('kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest');
    expect(insert?.values).toContain('thesol~crypto-latest');
    expect(insert?.values).toContain(JSON.stringify({ query: 'from:Cointelegraph filter:images', maxItems: 10 }));
  });

  it('updates Apify source metadata through PATCH', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...values: unknown[]) => ({
          run: vi.fn(async () => { calls.push({ sql, values }); return { meta: { changes: 1 } }; }),
          all: vi.fn(async () => ({ results: [] })),
          first: vi.fn(async () => null),
        })),
        run: vi.fn(async () => ({ meta: { changes: 1 } })),
        all: vi.fn(async () => ({ results: [] })),
        first: vi.fn(async () => null),
      })),
    };

    const res = await handleAdmin(request('/internal/apify-sources/src_crypto', 'PATCH', {
      enabled: false,
      apify_task_id: 'thesol~crypto-updated',
      last_dataset_id: 'LASTDATASET1',
      source_config: '{"mode":"latest"}',
    }), { DB: db } as unknown as Env, {} as ExecutionContext);

    expect(res.status).toBe(200);
    const update = calls.find(call => call.sql.includes('UPDATE apify_sources SET'));
    expect(update?.values).toContain(0);
    expect(update?.values).toContain('thesol~crypto-updated');
    expect(update?.values).toContain('LASTDATASET1');
    expect(update?.values).toContain('{"mode":"latest"}');
  });

  it('rejects invalid source_id webhook requests before scheduling curation', async () => {
    const waitUntil = vi.fn();
    const res = await handleApifyWebhook(
      request('/webhook/apify?source_id=bad/source', 'POST', { datasetId: 'DATASET12345' }, { 'x-webhook-secret': 'secret' }),
      { INTERNAL_API_SECRET: 'secret' } as unknown as Env,
      { waitUntil } as unknown as ExecutionContext,
    );
    const body = await res.json() as any;

    expect(res.status).toBe(400);
    expect(body.error).toBe('invalid_source_id');
    expect(waitUntil).not.toHaveBeenCalled();
  });
});
