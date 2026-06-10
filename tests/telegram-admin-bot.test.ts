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
  return {
    ENVIRONMENT: 'production',
    TELEGRAM_ADMIN_BOT_ENABLED: 'true',
    TELEGRAM_ADMIN_BOT_SECRET: 'test-secret',
    TELEGRAM_ADMIN_ALLOWED_USER_IDS: '111',
    TELEGRAM_BOT_TOKEN: 'telegram-token',
    APIFY_ROTATION_INTERVAL_HOURS: '3',
    DB: {
      prepare: (_sql: string) => {
        const stmt = {
          bind: (..._args: unknown[]) => stmt,
          first: async () => ({ count: 0 }),
          all: async () => ({ results: [] }),
          run: async () => { throw new Error('bot test must not write db'); },
        };
        return stmt;
      },
    },
  } as any;
}

describe('telegram admin bot', () => {
  it('sends the read-only menu to allowed admins', async () => {
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
    expect(body.handled).toBe('menu');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.chat_id).toBe(222);
    expect(payload.text).toContain('پنل مدیریت محتوا');
    expect(payload.reply_markup.inline_keyboard[0][0].callback_data).toBe('report:ops');

    vi.unstubAllGlobals();
  });

  it('ignores unauthorized Telegram users without sending messages', async () => {
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
    expect(fetchMock).not.toHaveBeenCalled();

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
