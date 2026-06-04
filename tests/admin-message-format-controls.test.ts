import { describe, expect, it, vi } from 'vitest';
import { handleAdmin } from '../apps/worker-api/src/routes/admin';
import type { Env } from '../apps/worker-api/src/types';

function request(path: string, method: string, body?: unknown): Request {
  return new Request(`https://worker.test${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function envWithCapturedDb() {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn((...values: unknown[]) => ({
        run: vi.fn(async () => {
          calls.push({ sql, values });
          return { meta: { changes: 1 } };
        }),
        all: vi.fn(async () => ({ results: [] })),
        first: vi.fn(async () => ({ n: 0 })),
      })),
      run: vi.fn(async () => {
        calls.push({ sql, values: [] });
        return { meta: { changes: 1 } };
      }),
      all: vi.fn(async () => ({ results: [] })),
      first: vi.fn(async () => ({ n: 0 })),
    })),
  };
  return { env: { DB: db } as unknown as Env, calls };
}

async function readJson(res: Response): Promise<any> {
  return res.json();
}

describe('message format channel admin fields', () => {
  it('persists message format controls when creating a channel', async () => {
    const { env, calls } = envWithCapturedDb();

    const res = await handleAdmin(request('/internal/channels', 'POST', {
      id: 'crypto_fa',
      category_id: 'crypto',
      telegram_chat_id: '@thesolxcrypto_fa',
      language: 'fa',
      source_enabled: false,
      source_label_override: 'اصل خبر',
      signature_enabled: true,
      signature_text: 'The Sol Crypto',
      channel_id_footer_enabled: 'true',
      channel_id_footer_text: '@thesolxcrypto_fa',
      disable_link_preview: 'true',
      semantic_dedupe_enabled: 1,
      semantic_dedupe_window_hours: 48,
      max_posts_per_source_per_day: 3,
    }), env, {} as ExecutionContext);

    expect(res.status).toBe(200);
    expect(calls[0].sql).toContain('source_enabled');
    expect(calls[0].sql).toContain('source_label_override');
    expect(calls[0].sql).toContain('signature_enabled');
    expect(calls[0].sql).toContain('channel_id_footer_enabled');
    expect(calls[0].sql).toContain('disable_link_preview');
    expect(calls[0].sql).toContain('semantic_dedupe_enabled');
    expect(calls[0].sql).toContain('max_posts_per_source_per_day');
    expect(calls[0].values).toContain(0); // source_enabled false
    expect(calls[0].values).toContain('اصل خبر');
    expect(calls[0].values).toContain('The Sol Crypto');
    expect(calls[0].values).toContain('@thesolxcrypto_fa');
    expect(calls[0].values).toContain(48);
    expect(calls[0].values).toContain(3);
  });

  it('uses production-safe defaults for message format controls when creating a channel', async () => {
    const { env, calls } = envWithCapturedDb();

    const res = await handleAdmin(request('/internal/channels', 'POST', {
      id: 'crypto_en',
      category_id: 'crypto',
      telegram_chat_id: '@thesolxcrypto_en',
      language: 'en',
    }), env, {} as ExecutionContext);

    expect(res.status).toBe(200);
    expect(calls[0].values).toContain(1); // source_enabled default and disable_link_preview default
    expect(calls[0].values).toContain(24); // semantic_dedupe_window_hours default
  });

  it('updates message format controls through PATCH with boolean coercion', async () => {
    const { env, calls } = envWithCapturedDb();

    const res = await handleAdmin(request('/internal/channels/crypto_fa', 'PATCH', {
      source_enabled: 'false',
      source_label_override: 'منبع',
      signature_enabled: 'true',
      signature_text: '— The Sol Crypto',
      channel_id_footer_enabled: 1,
      channel_id_footer_text: '@thesolxcrypto_fa',
      disable_link_preview: true,
      semantic_dedupe_enabled: 0,
      semantic_dedupe_window_hours: 72,
      max_posts_per_source_per_day: null,
    }), env, {} as ExecutionContext);

    expect(res.status).toBe(200);
    expect(calls[0].sql).toContain('source_enabled=?');
    expect(calls[0].sql).toContain('signature_enabled=?');
    expect(calls[0].sql).toContain('channel_id_footer_enabled=?');
    expect(calls[0].sql).toContain('disable_link_preview=?');
    expect(calls[0].sql).toContain('semantic_dedupe_window_hours=?');
    expect(calls[0].values).toEqual([
      0,
      'منبع',
      1,
      '— The Sol Crypto',
      1,
      '@thesolxcrypto_fa',
      1,
      0,
      72,
      null,
      'crypto_fa',
    ]);
  });

  it('rejects overlong message format text fields', async () => {
    const { env, calls } = envWithCapturedDb();

    const res = await handleAdmin(request('/internal/channels/crypto_fa', 'PATCH', {
      source_label_override: 'x'.repeat(33),
    }), env, {} as ExecutionContext);

    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({ ok: false, error: 'source_label_override_too_long' });
    expect(calls.length).toBe(0);
  });

  it('rejects out-of-range semantic controls', async () => {
    const { env, calls } = envWithCapturedDb();

    const res = await handleAdmin(request('/internal/channels/crypto_fa', 'PATCH', {
      semantic_dedupe_window_hours: 999,
    }), env, {} as ExecutionContext);

    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({ ok: false, error: 'semantic_dedupe_window_hours_out_of_range' });
    expect(calls.length).toBe(0);
  });
});
