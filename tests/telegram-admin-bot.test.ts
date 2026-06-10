import { describe, expect, it, vi } from 'vitest';
import { handleTelegramAdminBot } from '../apps/worker-api/src/routes/telegram-admin-bot';

function makeReq(body: object, secret = 'test-secret'): Request {
  return new Request('http://localhost/telegram/admin/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secret,
    },
    body: JSON.stringify(body),
  });
}

function update(text: string, userId = 111): object {
  return {
    message: {
      text,
      chat: { id: 222 },
      from: { id: userId },
    },
  };
}

function lastPayload(fetchMock: any): any {
  return JSON.parse(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].body);
}

function buttons(payload: any): string[] {
  return payload.reply_markup.keyboard.flat().map((b: any) => b.text);
}

function makeEnv() {
  const settings = new Map<string, string>();

  return {
    ENVIRONMENT: 'production',
    TELEGRAM_ADMIN_BOT_ENABLED: 'true',
    TELEGRAM_ADMIN_BOT_SECRET: 'test-secret',
    TELEGRAM_ADMIN_ALLOWED_USER_IDS: '111',
    TELEGRAM_BOT_TOKEN: 'telegram-token',
    APIFY_ROTATION_INTERVAL_HOURS: '3',
    DB: {
      prepare: (sql: string) => {
        let bound: unknown[] = [];
        const stmt = {
          bind: (...args: unknown[]) => {
            bound = args;
            return stmt;
          },
          first: async () => {
            if (sql.includes('FROM settings')) {
              const value = settings.get(String(bound[0]));
              return value === undefined ? null : { value };
            }

            if (sql.includes('FROM channels') && sql.includes('WHERE id=?')) {
              return { id: String(bound[0]), category_id: 'crypto' };
            }

            return null;
          },
          all: async () => {
            if (sql.includes('SELECT DISTINCT category_id')) {
              return { results: [{ category_id: 'crypto' }] };
            }

            if (sql.includes('FROM channels') && sql.includes('category_id=?')) {
              return { results: [{ id: 'crypto_fa_pilot', category_id: 'crypto' }] };
            }

            if (sql.includes('SELECT DISTINCT platform')) {
              return { results: [{ platform: 'x' }, { platform: 'instagram' }, { platform: 'linkedin' }] };
            }

            if (sql.includes('FROM apify_sources')) {
              return { results: [] };
            }

            return { results: [] };
          },
          run: async () => {
            if (sql.includes('INSERT INTO settings')) {
              settings.set(String(bound[0]), String(bound[1]));
            }
            return { success: true };
          },
        };
        return stmt;
      },
    },
  } as any;
}

async function chooseScope(env: any, fetchMock: any): Promise<void> {
  await handleTelegramAdminBot(makeReq(update('/start')), env);
  await handleTelegramAdminBot(makeReq(update('📂 crypto')), env);
  await handleTelegramAdminBot(makeReq(update('📣 crypto_fa_pilot')), env);
  fetchMock.mockClear();
  await handleTelegramAdminBot(makeReq(update('𝕏 X / Twitter')), env);
}

describe('telegram admin bot command center', () => {
  it('starts with category selection before any command center area', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await handleTelegramAdminBot(makeReq(update('/start')), makeEnv());
    const body: any = await res.json();
    const payload = lastPayload(fetchMock);

    expect(res.status).toBe(200);
    expect(body.handled).toBe('scope_categories');
    expect(payload.text).toContain('📂 <b>Select Category</b>');
    expect(buttons(payload)).toContain('📂 crypto');

    vi.unstubAllGlobals();
  });

  it('selects category, then channel, then platform, then command center', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const env = makeEnv();

    let res = await handleTelegramAdminBot(makeReq(update('📂 crypto')), env);
    let body: any = await res.json();
    let payload = lastPayload(fetchMock);
    expect(body.handled).toBe('scope_channels');
    expect(payload.text).toContain('📣 <b>Select Channel</b>');
    expect(buttons(payload)).toContain('📣 crypto_fa_pilot');

    res = await handleTelegramAdminBot(makeReq(update('📣 crypto_fa_pilot')), env);
    body = await res.json();
    payload = lastPayload(fetchMock);
    expect(body.handled).toBe('scope_platforms');
    expect(payload.text).toContain('🌐 <b>Select Platform</b>');
    expect(buttons(payload)).toContain('𝕏 X / Twitter');

    res = await handleTelegramAdminBot(makeReq(update('𝕏 X / Twitter')), env);
    body = await res.json();
    payload = lastPayload(fetchMock);
    expect(body.handled).toBe('command_center');
    expect(payload.text).toContain('📊 <b>Content Command Center</b>');
    expect(payload.text).toContain('<code>crypto_fa_pilot</code>');
    expect(buttons(payload)).toContain('🟢 Monitoring');
    expect(buttons(payload)).toContain('📈 Reporting');

    vi.unstubAllGlobals();
  });

  it('reuses selected scope when opening monitoring and reporting sections', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const env = makeEnv();

    await chooseScope(env, fetchMock);
    let payload = lastPayload(fetchMock);
    expect(payload.text).toContain('Content Command Center');

    let res = await handleTelegramAdminBot(makeReq(update('🟢 Monitoring')), env);
    let body: any = await res.json();
    payload = lastPayload(fetchMock);
    expect(body.handled).toBe('monitoring');
    expect(payload.text).toContain('🟢 <b>Monitoring</b>');
    expect(buttons(payload)).toContain('🤖 AI Health');

    res = await handleTelegramAdminBot(makeReq(update('🟢 Status')), env);
    body = await res.json();
    payload = lastPayload(fetchMock);
    expect(body.handled).toBe('monitoring:monitoring_status');
    expect(payload.text).toContain('🟢 <b>System Status</b>');
    expect(payload.text).toContain('<code>crypto_fa_pilot</code>');

    res = await handleTelegramAdminBot(makeReq(update('📈 Reporting')), env);
    body = await res.json();
    payload = lastPayload(fetchMock);
    expect(body.handled).toBe('reporting');
    expect(payload.text).toContain('📈 <b>Reporting</b>');
    expect(buttons(payload)).toContain('💸 Costs');

    vi.unstubAllGlobals();
  });

  it('keeps AI Health and AI Providers as different routes', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const env = makeEnv();

    await chooseScope(env, fetchMock);

    let res = await handleTelegramAdminBot(makeReq(update('🟢 Monitoring')), env);
    await res.json();

    res = await handleTelegramAdminBot(makeReq(update('🤖 AI Health')), env);
    let body: any = await res.json();
    let payload = lastPayload(fetchMock);
    expect(body.handled).toBe('monitoring:monitoring_ai');
    expect(payload.text).toContain('🤖 <b>AI Health</b>');

    await handleTelegramAdminBot(makeReq(update('📈 Reporting')), env);
    await handleTelegramAdminBot(makeReq(update('💸 Costs')), env);

    res = await handleTelegramAdminBot(makeReq(update('🤖 AI Providers')), env);
    body = await res.json();
    payload = lastPayload(fetchMock);
    expect(body.handled).toBe('ai_costs_menu');
    expect(payload.text).toContain('🤖 <b>AI Provider Costs</b>');
    expect(buttons(payload)).toContain('🟣 Anthropic');
    expect(buttons(payload)).toContain('🔵 Gemini');

    vi.unstubAllGlobals();
  });

  it('keeps operations read-only', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const env = makeEnv();

    await chooseScope(env, fetchMock);

    let res = await handleTelegramAdminBot(makeReq(update('🛠 Operations')), env);
    let body: any = await res.json();
    let payload = lastPayload(fetchMock);
    expect(body.handled).toBe('operations');
    expect(payload.text).toContain('Read-only for now');

    res = await handleTelegramAdminBot(makeReq(update('🧠 Drain Backlog')), env);
    body = await res.json();
    payload = lastPayload(fetchMock);
    expect(body.handled).toBe('operation_read_only');
    expect(payload.text).toContain('Operation Not Armed');

    vi.unstubAllGlobals();
  });

  it('shows unauthorized users their Telegram user_id for onboarding', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await handleTelegramAdminBot(makeReq(update('/start', 999)), makeEnv());
    const body: any = await res.json();
    const payload = lastPayload(fetchMock);

    expect(res.status).toBe(200);
    expect(body.ignored).toBe(true);
    expect(body.reason).toBe('user_not_allowed');
    expect(body.user_id).toBe(999);
    expect(payload.text).toContain('🪪 Your Telegram user_id');
    expect(payload.text).toContain('<code>999</code>');

    vi.unstubAllGlobals();
  });

  it('rejects invalid webhook secrets', async () => {
    const res = await handleTelegramAdminBot(makeReq(update('/start'), 'wrong-secret'), makeEnv());
    expect(res.status).toBe(401);
  });
});
