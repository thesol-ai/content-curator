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

describe('phase 8 admin category/channel field wiring', () => {
  it('persists category custom_prompt when creating a category', async () => {
    const { env, calls } = envWithCapturedDb();
    const res = await handleAdmin(request('/internal/categories', 'POST', {
      id: 'finance_plus',
      label: 'Finance Plus',
      prompt_profile: 'finance_editorial',
      custom_prompt: 'Strict finance curation policy. No investment advice.',
      language_targets: ['fa'],
    }), env, {} as ExecutionContext);

    expect(res.status).toBe(200);
    expect(calls[0].sql).toContain('custom_prompt');
    expect(calls[0].values).toContain('Strict finance curation policy. No investment advice.');
  });

  it('updates category custom_prompt through PATCH', async () => {
    const { env, calls } = envWithCapturedDb();
    const res = await handleAdmin(request('/internal/categories/finance_plus', 'PATCH', {
      custom_prompt: 'Updated scoring policy',
    }), env, {} as ExecutionContext);

    expect(res.status).toBe(200);
    expect(calls[0].sql).toContain('custom_prompt=?');
    expect(calls[0].values).toEqual(['Updated scoring policy', 'finance_plus']);
  });

  it('persists channel AI context fields when creating a channel', async () => {
    const { env, calls } = envWithCapturedDb();
    const res = await handleAdmin(request('/internal/channels', 'POST', {
      id: 'crypto_fa_pro',
      category_id: 'crypto',
      telegram_chat_id: '@crypto_fa_pro',
      language: 'fa',
      custom_instructions: 'Use an analytical tone.',
      tone_profile: 'analytical',
      channel_label: 'Crypto Pro FA',
    }), env, {} as ExecutionContext);

    expect(res.status).toBe(200);
    expect(calls[0].sql).toContain('custom_instructions');
    expect(calls[0].sql).toContain('tone_profile');
    expect(calls[0].sql).toContain('channel_label');
    expect(calls[0].values).toContain('Use an analytical tone.');
    expect(calls[0].values).toContain('analytical');
    expect(calls[0].values).toContain('Crypto Pro FA');
  });

  it('updates channel AI context fields through PATCH', async () => {
    const { env, calls } = envWithCapturedDb();
    const res = await handleAdmin(request('/internal/channels/crypto_fa_pro', 'PATCH', {
      custom_instructions: 'More educational.',
      tone_profile: 'educational',
      channel_label: 'Crypto Learn FA',
    }), env, {} as ExecutionContext);

    expect(res.status).toBe(200);
    expect(calls[0].sql).toContain('custom_instructions=?');
    expect(calls[0].sql).toContain('tone_profile=?');
    expect(calls[0].sql).toContain('channel_label=?');
    expect(calls[0].values).toEqual(['More educational.', 'educational', 'Crypto Learn FA', 'crypto_fa_pro']);
  });
});
