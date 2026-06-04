import { describe, expect, it, vi } from 'vitest';
import { handleAdmin } from '../apps/worker-api/src/routes/admin';
import type { ChannelRow, Env } from '../apps/worker-api/src/types';

function request(path: string, method = 'GET'): Request {
  return new Request(`https://worker.test${path}`, { method });
}

function channel(overrides: Partial<ChannelRow> = {}): ChannelRow {
  return {
    id: 'channel_fa',
    category_id: 'crypto',
    telegram_chat_id: '@thesolxcrypto_fa',
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
    signature_enabled: 1,
    signature_text: '— The Sol Crypto',
    channel_id_footer_enabled: 1,
    channel_id_footer_text: null,
    disable_link_preview: 1,
    semantic_dedupe_enabled: 1,
    semantic_dedupe_window_hours: 24,
    max_posts_per_source_per_day: null,
    ...overrides,
  };
}

function queueRow(overrides: Record<string, unknown> = {}) {
  const sourceUrl = 'https://x.com/VitalikButerin/status/123?ref=raw';
  return {
    id: 'q_1',
    item_id: 'item_1',
    channel_id: 'channel_fa',
    language: 'fa',
    source_url: sourceUrl,
    caption_short: 'کپشن کوتاه',
    caption_full: `متن اصلی خبر\n\nمنبع: ${sourceUrl}`,
    telegram_method: 'sendMessage',
    media_urls: '[]',
    thumbnail_urls: '[]',
    media_types: '[]',
    scheduled_at: 1_700_000_000,
    status: 'scheduled',
    retry_count: 0,
    ...overrides,
  };
}

function envWithDb(options: {
  row?: Record<string, unknown> | null;
  channel?: ChannelRow | null;
} = {}) {
  const row = options.row === undefined ? queueRow() : options.row;
  const ch = options.channel === undefined ? channel() : options.channel;
  const calls: Array<{ sql: string; values: unknown[]; kind: 'first' | 'all' | 'run' }> = [];

  const db = {
    prepare: vi.fn((sql: string) => {
      const make = (values: unknown[] = []) => ({
        first: vi.fn(async () => {
          calls.push({ sql, values, kind: 'first' });
          if (sql.includes('SELECT * FROM publish_queue WHERE id=?')) return row;
          if (sql.includes('SELECT * FROM channels WHERE id=?')) return ch;
          return null;
        }),
        all: vi.fn(async () => {
          calls.push({ sql, values, kind: 'all' });
          return { results: [] };
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
    env: { DB: db } as unknown as Env,
    calls,
  };
}

describe('queue preview endpoint', () => {
  it('uses the backend Telegram formatter and hides the raw source URL from visible message text', async () => {
    const sourceUrl = 'https://x.com/VitalikButerin/status/123?ref=raw';
    const { env } = envWithDb();

    const res = await handleAdmin(request('/internal/queue/q_1/preview'), env, {} as ExecutionContext);
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.method).toBe('sendMessage');
    expect(body.captions.full_html).toContain('<a href="https://x.com/VitalikButerin/status/123?ref=raw">منبع</a>');
    expect(body.captions.full_html.replace(/href="[^"]+"/g, '')).not.toContain(sourceUrl);
    expect(body.captions.full_html).toContain('— The Sol Crypto');
    expect(body.captions.full_html).toContain('@thesolxcrypto_fa');
    expect(body.telegram_preview.payload).toMatchObject({
      chat_id: '@thesolxcrypto_fa',
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
    expect(body.warnings).not.toContain('raw_source_url_visible');
  });

  it('previews paused channels without enabling publish behavior', async () => {
    const { env } = envWithDb({ channel: channel({ publish_enabled: 0 }) });

    const res = await handleAdmin(request('/internal/queue/q_1/preview'), env, {} as ExecutionContext);
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body.channel.publish_enabled).toBe(0);
    expect(body.telegram_preview.payload.link_preview_options).toEqual({ is_disabled: true });
  });

  it('previews media group payloads and follow-up messages using the same formatted captions', async () => {
    const { env } = envWithDb({
      row: queueRow({
        telegram_method: 'sendMediaGroup',
        caption_short: 'خلاصه آلبوم',
        caption_full: 'x'.repeat(1300),
        media_urls: JSON.stringify(['https://cdn.test/a.jpg', 'https://cdn.test/b.mp4']),
        media_types: JSON.stringify(['image', 'video']),
      }),
    });

    const res = await handleAdmin(request('/internal/queue/q_1/preview'), env, {} as ExecutionContext);
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body.telegram_preview.method).toBe('sendMediaGroup');
    expect(body.telegram_preview.payload.media[0]).toMatchObject({
      type: 'photo',
      media: 'https://cdn.test/a.jpg',
      parse_mode: 'HTML',
    });
    expect(body.telegram_preview.payload.media[1]).toMatchObject({
      type: 'video',
      supports_streaming: true,
    });
    expect(body.captions.send_full_follow_up).toBe(true);
    expect(body.telegram_preview.follow_up).toMatchObject({
      chat_id: '@thesolxcrypto_fa',
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  });

  it('returns 404 for missing queue items', async () => {
    const { env } = envWithDb({ row: null });
    const res = await handleAdmin(request('/internal/queue/missing/preview'), env, {} as ExecutionContext);
    const body = await res.json() as any;

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: 'queue_item_not_found' });
  });
});
