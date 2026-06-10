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

            if (sql.includes('FROM channels')) {
              return { category_id: 'crypto' };
            }

            return null;
          },
          all: async () => {
            if (sql.includes('FROM channels')) {
              return { results: [{ id: 'crypto_fa_pilot', category_id: 'crypto' }] };
            }

            if (sql.includes('SELECT DISTINCT platform')) {
              return { results: [{ platform: 'x' }, { platform: 'instagram' }, { platform: 'linkedin' }] };
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

describe('telegram admin bot', () => {
  it('sends a visual home menu to allowed admins', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await handleTelegramAdminBot(makeReq({
      message: {
        text: '/start',
        chat: { id: 222 },
        from: { id: 111 },
      },
    }), makeEnv());

    const body: any = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.handled).toBe('home');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(fetchMock.mock.calls[0][0]).toContain('/sendMessage');
    expect(payload.chat_id).toBe(222);
    expect(payload.text).toContain('✨ <b>Content Command Center</b>');
    expect(payload.reply_markup.keyboard[0][0].text).toBe('📊 Open Reports');
    expect(payload.reply_markup.resize_keyboard).toBe(true);

    vi.unstubAllGlobals();
  });

  it('sends channel selection as a new reply-keyboard message', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await handleTelegramAdminBot(makeReq({
      message: {
        text: '📊 Open Reports',
        chat: { id: 222 },
        from: { id: 111 },
      },
    }), makeEnv());

    const body: any = await res.json();

    expect(res.status).toBe(200);
    expect(body.handled).toBe('channels');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(fetchMock.mock.calls[0][0]).toContain('/sendMessage');
    expect(payload.text).toContain('📣 <b>Select Channel</b>');
    expect(payload.reply_markup.keyboard.flat().map((b: any) => b.text)).toContain('📣 crypto_fa_pilot');

    vi.unstubAllGlobals();
  });

  it('sends platform selection after channel selection', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await handleTelegramAdminBot(makeReq({
      message: {
        text: '📣 crypto_fa_pilot',
        chat: { id: 222 },
        from: { id: 111 },
      },
    }), makeEnv());

    const body: any = await res.json();

    expect(res.status).toBe(200);
    expect(body.handled).toBe('platforms');

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.text).toContain('🌐 <b>Select Platform</b>');
    expect(payload.reply_markup.keyboard.flat().map((b: any) => b.text)).toContain('🌐 All Platforms');
    expect(payload.reply_markup.keyboard.flat().map((b: any) => b.text)).toContain('𝕏 X / Twitter');

    vi.unstubAllGlobals();
  });

  it('sends report section picker after platform selection', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const env = makeEnv();

    await handleTelegramAdminBot(makeReq({
      message: {
        text: '📣 crypto_fa_pilot',
        chat: { id: 222 },
        from: { id: 111 },
      },
    }), env);

    fetchMock.mockClear();

    const res = await handleTelegramAdminBot(makeReq({
      message: {
        text: '𝕏 X / Twitter',
        chat: { id: 222 },
        from: { id: 111 },
      },
    }), env);

    const body: any = await res.json();

    expect(res.status).toBe(200);
    expect(body.handled).toBe('report_picker');

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.text).toContain('🧭 <b>Select Report Section</b>');
    expect(payload.reply_markup.keyboard.flat().map((b: any) => b.text)).toContain('● ✨ Overview');
    expect(payload.reply_markup.keyboard.flat().map((b: any) => b.text)).toContain('💸 Costs');

    vi.unstubAllGlobals();
  });

  it('sends a new report message for selected sections', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const env = makeEnv();

    const res = await handleTelegramAdminBot(makeReq({
      message: {
        text: '💸 Costs',
        chat: { id: 222 },
        from: { id: 111 },
      },
    }), env);

    const body: any = await res.json();

    expect(res.status).toBe(200);
    expect(body.handled).toBe('report:costs');

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(fetchMock.mock.calls[0][0]).toContain('/sendMessage');
    expect(payload.text).toContain('💸 <b>Costs</b>');
    expect(payload.reply_markup.keyboard.flat().map((b: any) => b.text)).toContain('🔄 Funnel');

    vi.unstubAllGlobals();
  });

  it('shows unauthorized users their Telegram user_id for onboarding', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await handleTelegramAdminBot(makeReq({
      message: {
        text: '/start',
        chat: { id: 222 },
        from: { id: 999 },
      },
    }), makeEnv());

    const body: any = await res.json();

    expect(res.status).toBe(200);
    expect(body.ignored).toBe(true);
    expect(body.reason).toBe('user_not_allowed');
    expect(body.user_id).toBe(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.chat_id).toBe(222);
    expect(payload.text).toContain('🪪 Your Telegram user_id');
    expect(payload.text).toContain('<code>999</code>');
    expect(payload.text).not.toContain('Open Reports');

    vi.unstubAllGlobals();
  });

  it('rejects invalid webhook secrets', async () => {
    const res = await handleTelegramAdminBot(makeReq({
      message: {
        text: '/start',
        chat: { id: 222 },
        from: { id: 111 },
      },
    }, 'wrong-secret'), makeEnv());

    expect(res.status).toBe(401);
  });
});
