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
  it('sends a compact main menu to allowed admins', async () => {
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
    expect(fetchMock.mock.calls[0][0]).toContain('/sendMessage');
    expect(payload.chat_id).toBe(222);
    expect(payload.text).toContain('پنل مدیریت محتوا');
    expect(payload.reply_markup.inline_keyboard[0][0].callback_data).toBe('report:menu');

    vi.unstubAllGlobals();
  });

  it('edits the message into the report section menu on report callbacks', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await handleTelegramAdminBot(makeReq({
      callback_query: {
        id: 'cb_1',
        data: 'report:menu',
        from: { id: 111 },
        message: {
          message_id: 333,
          chat: { id: 222 },
        },
      },
    }), makeEnv());

    const body: any = await res.json();

    expect(res.status).toBe(200);
    expect(body.handled).toBe('report:overview');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain('/answerCallbackQuery');
    expect(fetchMock.mock.calls[1][0]).toContain('/editMessageText');

    const payload = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(payload.chat_id).toBe(222);
    expect(payload.message_id).toBe(333);
    expect(payload.text).toContain('خلاصه عملیات');
    expect(payload.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data)).toContain('report:costs');
    expect(payload.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data)).toContain('report:pipeline');

    vi.unstubAllGlobals();
  });

  it('edits the message into a selected report section', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await handleTelegramAdminBot(makeReq({
      callback_query: {
        id: 'cb_2',
        data: 'report:costs',
        from: { id: 111 },
        message: {
          message_id: 333,
          chat: { id: 222 },
        },
      },
    }), makeEnv());

    const body: any = await res.json();

    expect(res.status).toBe(200);
    expect(body.handled).toBe('report:costs');

    const payload = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(payload.text).toContain('گزارش هزینه‌ها');
    expect(payload.text).not.toContain('گزارش قیف محتوا');

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
    expect(payload.text).toContain('user_id شما');
    expect(payload.text).toContain('<code>999</code>');
    expect(payload.text).not.toContain('گزارش‌ها');

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
