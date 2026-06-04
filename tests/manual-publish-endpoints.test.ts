import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleAdmin } from '../apps/worker-api/src/routes/admin';
import { publishDueItems, publishQueueItem } from '../apps/worker-api/src/services/curation-orchestrator';
import type { ChannelRow, Env } from '../apps/worker-api/src/types';

interface DbCall {
  sql: string;
  values: unknown[];
  kind: 'all' | 'first' | 'run';
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function request(path: string, method: string, body?: unknown): Request {
  return new Request(`https://worker.test${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function channel(overrides: Partial<ChannelRow> = {}): ChannelRow {
  return {
    id: 'channel_fa',
    category_id: 'crypto',
    telegram_chat_id: '@channel_fa',
    language: 'fa',
    timezone: 'Asia/Tehran',
    allowed_windows: '[]',
    blocked_windows: '[]',
    max_per_day: 10,
    max_per_hour: 2,
    min_gap_minutes: 30,
    publish_enabled: 1,
    enabled: 1,
    custom_instructions: null,
    tone_profile: 'neutral',
    channel_label: null,
    source_enabled: 1,
    source_label_override: null,
    signature_enabled: 0,
    signature_text: null,
    channel_id_footer_enabled: 0,
    channel_id_footer_text: null,
    disable_link_preview: 1,
    semantic_dedupe_enabled: 1,
    semantic_dedupe_window_hours: 24,
    max_posts_per_source_per_day: null,
    ...overrides,
  };
}

function queueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'q_1',
    item_id: 'item_1',
    channel_id: 'channel_fa',
    language: 'fa',
    source_url: 'https://x.com/source/status/1',
    caption_short: 'کپشن کوتاه',
    caption_full: 'کپشن کامل',
    telegram_method: 'sendMessage',
    media_urls: '[]',
    thumbnail_urls: '[]',
    media_types: '[]',
    scheduled_at: 1_700_000_000,
    status: 'scheduled',
    retry_count: 0,
    telegram_chat_id: '@channel_fa',
    max_per_hour: 2,
    min_gap_minutes: 30,
    publish_enabled: 1,
    enabled: 1,
    ...overrides,
  };
}

function envWithDb(options: {
  settings?: Record<string, string>;
  dueIds?: string[];
  row?: Record<string, unknown> | null;
  channel?: ChannelRow | null;
  envOverrides?: Partial<Env>;
} = {}) {
  const calls: DbCall[] = [];
  const settings = options.settings ?? { telegram_publish_enabled: 'true' };
  const row = options.row === undefined ? queueRow() : options.row;
  const ch = options.channel === undefined ? channel() : options.channel;
  const dueIds = options.dueIds ?? [];

  const db = {
    prepare: vi.fn((sql: string) => {
      const make = (values: unknown[] = []) => ({
        all: vi.fn(async () => {
          calls.push({ sql, values, kind: 'all' });
          if (sql.includes('SELECT key, value FROM settings')) {
            return { results: Object.entries(settings).map(([key, value]) => ({ key, value })) };
          }
          if (sql.includes('SELECT q.id') && sql.includes('FROM publish_queue q')) {
            return { results: dueIds.map(id => ({ id })) };
          }
          if (sql.includes('telegram_file_id')) return { results: [] };
          return { results: [] };
        }),
        first: vi.fn(async () => {
          calls.push({ sql, values, kind: 'first' });
          if (sql.includes('FROM publish_queue q') && sql.includes('WHERE q.id=?')) return row;
          if (sql.includes('SELECT COUNT(*) as cnt')) return { cnt: 0 };
          if (sql.includes('SELECT published_at')) return null;
          if (sql.includes('SELECT * FROM channels WHERE id=?')) return ch;
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
      TELEGRAM_FINAL_PUBLISH_ENABLED: 'true',
      TELEGRAM_PUBLISH_SCHEDULER_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: '123:test-token',
      MEDIA_PROCESSING_MODE: 'direct_url',
      MEDIA_GROUP_PARTIAL_PUBLISH_ENABLED: 'true',
      ...options.envOverrides,
    } as unknown as Env,
    calls,
  };
}

function jsonBody(call: FetchCall): any {
  return JSON.parse(String(call.init?.body));
}

describe('manual publish endpoints and shared queue publish path', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps cron publish blocked by scheduler while manual publish/due can bypass only the scheduler flag', async () => {
    const cron = envWithDb({
      dueIds: ['q_1'],
      envOverrides: { TELEGRAM_PUBLISH_SCHEDULER_ENABLED: 'false' },
    });

    await expect(publishDueItems(cron.env)).resolves.toEqual({ published: 0, failed: 0, skipped: 0 });
    expect(cron.calls.some(call => call.sql.includes('SELECT q.id'))).toBe(false);

    const manual = envWithDb({
      dueIds: [],
      envOverrides: { TELEGRAM_PUBLISH_SCHEDULER_ENABLED: 'false' },
    });
    await expect(publishDueItems(manual.env, { limit: 2, requireScheduler: false }))
      .resolves.toEqual({ published: 0, failed: 0, skipped: 0 });
    expect(manual.calls.some(call => call.sql.includes('SELECT q.id'))).toBe(true);
  });

  it('publishes a single queue item through the shared publisher path', async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ ok: true, result: { message_id: 42 } });
    }));

    const { env, calls: dbCalls } = envWithDb();
    const result = await publishQueueItem(env, 'q_1', { now: 1_700_000_100 });

    expect(result).toMatchObject({ ok: true, status: 'published', telegramMessageId: '42' });
    expect(calls[0].url).toContain('/sendMessage');
    expect(jsonBody(calls[0])).toMatchObject({
      chat_id: '@channel_fa',
      link_preview_options: { is_disabled: true },
    });
    expect(dbCalls.some(call => call.sql.includes("UPDATE publish_queue SET status='publishing'"))).toBe(true);
    expect(dbCalls.some(call => call.sql.includes("UPDATE publish_queue SET status='published'"))).toBe(true);
  });

  it('POST /internal/queue/:id/publish-now allows failed items and returns the final queue status', async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ ok: true, result: { message_id: 77 } });
    }));

    const { env } = envWithDb({ row: queueRow({ status: 'failed', retry_count: 2 }) });
    const res = await handleAdmin(request('/internal/queue/q_1/publish-now', 'POST'), env, {} as ExecutionContext);
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, queueId: 'q_1', published: true, status: 'published', telegramMessageId: '77' });
    expect(calls[0].url).toContain('/sendMessage');
  });

  it('POST /internal/publish/due accepts a manual limit and returns due counters', async () => {
    const { env, calls } = envWithDb({ dueIds: [] });
    const res = await handleAdmin(request('/internal/publish/due', 'POST', { limit: 3 }), env, {} as ExecutionContext);
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, published: 0, failed: 0, skipped: 0 });
    const dueCall = calls.find(call => call.sql.includes('SELECT q.id'));
    expect(dueCall?.values).toEqual([expect.any(Number), 3]);
  });
});
