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
            if (sql.includes('SELECT DISTINCT category_id')) {
              return { results: [{ category_id: 'crypto' }] };
            }

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

async function chooseScope(env = makeEnv()) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);

  await handleTelegramAdminBot(makeReq({
    message: { text: '/start', chat: { id: 222 }, from: { id: 111 } },
  }), env);

  await handleTelegramAdminBot(makeReq({
    message: { text: '📂 crypto', chat: { id: 222 }, from: { id: 111 } },
  }), env);

  await handleTelegramAdminBot(makeReq({
    message: { text: '📣 crypto_fa_pilot', chat: { id: 222 }, from: { id: 111 } },
  }), env);

  fetchMock.mockClear();

  return { env, fetchMock };
}

describe('telegram admin bot scoped entry', () => {
  it('starts with category selection, not the command center', async () => {
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
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    const buttons = payload.reply_markup.keyboard.flat().map((b: any) => b.text);

    expect(res.status).toBe(200);
    expect(body.handled).toBe('scope_categories');
    expect(payload.text).toContain('📂 <b>Select Category</b>');
    expect(buttons).toContain('📂 crypto');
    expect(buttons).not.toContain('🟢 Monitoring');

    vi.unstubAllGlobals();
  });

  it('opens channel selection after category selection', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await handleTelegramAdminBot(makeReq({
      message: {
        text: '📂 crypto',
        chat: { id: 222 },
        from: { id: 111 },
      },
    }), makeEnv());

    const body: any = await res.json();
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    const buttons = payload.reply_markup.keyboard.flat().map((b: any) => b.text);

    expect(body.handled).toBe('scope_channels');
    expect(payload.text).toContain('📣 <b>Select Channel</b>');
    expect(payload.text).toContain('crypto');
    expect(buttons).toContain('📣 crypto_fa_pilot');

    vi.unstubAllGlobals();
  });

  it('opens platform selection after channel selection', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const env = makeEnv();

    await handleTelegramAdminBot(makeReq({
      message: { text: '📂 crypto', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    fetchMock.mockClear();

    const res = await handleTelegramAdminBot(makeReq({
      message: {
        text: '📣 crypto_fa_pilot',
        chat: { id: 222 },
        from: { id: 111 },
      },
    }), env);

    const body: any = await res.json();
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    const buttons = payload.reply_markup.keyboard.flat().map((b: any) => b.text);

    expect(body.handled).toBe('scope_platforms');
    expect(payload.text).toContain('🌐 <b>Select Platform</b>');
    expect(payload.text).toContain('crypto_fa_pilot');
    expect(buttons).toContain('🌐 All Platforms');
    expect(buttons).toContain('𝕏 X / Twitter');

    vi.unstubAllGlobals();
  });

  it('opens the command center after platform selection and reuses the scope', async () => {
    const { env, fetchMock } = await chooseScope();

    const res = await handleTelegramAdminBot(makeReq({
      message: {
        text: '𝕏 X / Twitter',
        chat: { id: 222 },
        from: { id: 111 },
      },
    }), env);

    const body: any = await res.json();
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    const buttons = payload.reply_markup.keyboard.flat().map((b: any) => b.text);

    expect(body.handled).toBe('command_center');
    expect(payload.text).toContain('📊 <b>Content Command Center</b>');
    expect(payload.text).toContain('crypto · crypto_fa_pilot · x');
    expect(buttons).toContain('🟢 Monitoring');
    expect(buttons).toContain('📈 Reporting');
    expect(buttons).toContain('⚙️ Settings');
    expect(buttons).toContain('❓ Help');
    expect(buttons).toContain('🧭 Switch Channel / Platform');

    vi.unstubAllGlobals();
  });

  it('opens reporting from the selected scope without asking for channel again', async () => {
    const { env, fetchMock } = await chooseScope();

    await handleTelegramAdminBot(makeReq({
      message: { text: '𝕏 X / Twitter', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    fetchMock.mockClear();

    const res = await handleTelegramAdminBot(makeReq({
      message: { text: '📈 Reporting', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    const body: any = await res.json();
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    const buttons = payload.reply_markup.keyboard.flat().map((b: any) => b.text);

    expect(body.handled).toBe('reports');
    expect(payload.text).toContain('📈 <b>Reporting</b>');
    expect(payload.text).toContain('crypto · crypto_fa_pilot · x');
    expect(buttons).toContain('🧾 Channel Audit');
    expect(buttons).toContain('📊 Overview');
    expect(buttons).toContain('💸 Costs');
    expect(buttons).toContain('🧠 AI Quality');
    expect(buttons).toContain('📰 Editorial');
    expect(buttons).toContain('📈 Market Snapshot');

    vi.unstubAllGlobals();
  });

  it('opens monitoring from the selected scope', async () => {
    const { env, fetchMock } = await chooseScope();

    await handleTelegramAdminBot(makeReq({
      message: { text: '🌐 All Platforms', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    fetchMock.mockClear();

    const res = await handleTelegramAdminBot(makeReq({
      message: { text: '🟢 Monitoring', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    const body: any = await res.json();
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    const buttons = payload.reply_markup.keyboard.flat().map((b: any) => b.text);

    expect(body.handled).toBe('monitoring');
    expect(payload.text).toContain('🟢 <b>Monitoring</b>');
    expect(payload.text).toContain('crypto · crypto_fa_pilot · all');
    expect(buttons).toContain('🟢 Status');
    expect(buttons).toContain('🤖 AI Health');
    expect(buttons).toContain('📡 Source Health');
    expect(buttons).toContain('⏱ Scheduler');
    expect(buttons).toContain('💰 Cost Watch');

    vi.unstubAllGlobals();
  });

  it('opens the cost submenu using the selected scope', async () => {
    const { env, fetchMock } = await chooseScope();

    await handleTelegramAdminBot(makeReq({
      message: { text: '𝕏 X / Twitter', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    fetchMock.mockClear();

    const res = await handleTelegramAdminBot(makeReq({
      message: { text: '💸 Costs', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    const body: any = await res.json();
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    const buttons = payload.reply_markup.keyboard.flat().map((b: any) => b.text);

    expect(body.handled).toBe('costs_menu');
    expect(payload.text).toContain('💸 <b>Costs</b>');
    expect(payload.text).toContain('crypto · crypto_fa_pilot · x');
    expect(buttons).toContain('💸 Summary');
    expect(buttons).toContain('🟣 Anthropic');
    expect(buttons).toContain('🔵 Gemini');
    expect(buttons).toContain('🕷 Apify');
    expect(buttons).not.toContain('🤖 AI Providers');
    expect(buttons).not.toContain('📈 Reporting');

    vi.unstubAllGlobals();
  });





  it('opens publishing queue detail with capacity and next schedule visibility', async () => {
    const { env, fetchMock } = await chooseScope();

    await handleTelegramAdminBot(makeReq({
      message: { text: '𝕏 X / Twitter', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    fetchMock.mockClear();

    const res = await handleTelegramAdminBot(makeReq({
      message: { text: '📬 Publishing', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    const body: any = await res.json();
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);

    expect(body.handled).toBe('report:publish_queue');
    expect(payload.text).toContain('📬 <b>Publishing Queue</b>');
    expect(payload.text).toContain('Capacity');
    expect(payload.text).toContain('remaining 24h capacity');
    expect(payload.text).toContain('Next Scheduled Posts');

    vi.unstubAllGlobals();
  });

  it('opens platform scope settings detail instead of treating it as platform selection', async () => {
    const { env, fetchMock } = await chooseScope();

    await handleTelegramAdminBot(makeReq({
      message: { text: '𝕏 X / Twitter', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    fetchMock.mockClear();

    const res = await handleTelegramAdminBot(makeReq({
      message: { text: '🌐 Platform Scope', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    const body: any = await res.json();
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);

    expect(body.handled).toBe('settings_detail');
    expect(payload.text).toContain('🌐 <b>Platform Scope</b>');
    expect(payload.text).toContain('crypto · crypto_fa_pilot · x');
    expect(payload.text).not.toContain('📊 <b>Content Command Center</b>');

    vi.unstubAllGlobals();
  });

  it('keeps cost providers directly in the costs menu without a nested AI providers menu', async () => {
    const { env, fetchMock } = await chooseScope();

    await handleTelegramAdminBot(makeReq({
      message: { text: '𝕏 X / Twitter', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    fetchMock.mockClear();

    const res = await handleTelegramAdminBot(makeReq({
      message: { text: '🟣 Anthropic', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    const body: any = await res.json();
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    const buttons = payload.reply_markup.keyboard.flat().map((b: any) => b.text);

    expect(body.handled).toBe('report:costs_anthropic');
    expect(payload.text).toContain('🟣 <b>Anthropic / Claude</b>');
    expect(buttons).toContain('🟣 Anthropic');
    expect(buttons).toContain('🔵 Gemini');
    expect(buttons).not.toContain('🤖 AI Providers');
    expect(buttons).not.toContain('💸 Costs');

    vi.unstubAllGlobals();
  });

  it('opens channel audit reporting detail from the reporting menu', async () => {
    const { env, fetchMock } = await chooseScope();

    await handleTelegramAdminBot(makeReq({
      message: { text: '𝕏 X / Twitter', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    fetchMock.mockClear();

    const res = await handleTelegramAdminBot(makeReq({
      message: { text: '🧾 Channel Audit', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    const body: any = await res.json();
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);

    expect(body.handled).toBe('report:channel_audit');
    expect(payload.text).toContain('🧾 <b>Channel Audit</b>');
    expect(payload.text).toContain('Queue Now');
    expect(payload.text).toContain('Last 24h Funnel');

    vi.unstubAllGlobals();
  });

  it('opens AI quality reporting detail for the selected scope', async () => {
    const { env, fetchMock } = await chooseScope();

    await handleTelegramAdminBot(makeReq({
      message: { text: '𝕏 X / Twitter', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    fetchMock.mockClear();

    const res = await handleTelegramAdminBot(makeReq({
      message: { text: '🧠 AI Quality', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    const body: any = await res.json();
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);

    expect(body.handled).toBe('report:ai_quality');
    expect(payload.text).toContain('🧠 <b>AI Quality</b>');
    expect(payload.text).toContain('crypto · crypto_fa_pilot · x');
    expect(payload.text).toContain('select rate');

    vi.unstubAllGlobals();
  });

  it('opens editorial reporting detail for the selected scope', async () => {
    const { env, fetchMock } = await chooseScope();

    await handleTelegramAdminBot(makeReq({
      message: { text: '𝕏 X / Twitter', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    fetchMock.mockClear();

    const res = await handleTelegramAdminBot(makeReq({
      message: { text: '📰 Editorial', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    const body: any = await res.json();
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);

    expect(body.handled).toBe('report:editorial');
    expect(payload.text).toContain('📰 <b>Editorial Output</b>');
    expect(payload.text).toContain('published');
    expect(payload.text).toContain('Missing data');

    vi.unstubAllGlobals();
  });

  it('opens market snapshot reporting detail for the selected scope', async () => {
    const { env, fetchMock } = await chooseScope();

    env.MARKET_SNAPSHOT_ENABLED = 'true';
    env.MARKET_SNAPSHOT_CHANNEL_ID = 'crypto_fa_pilot';
    env.MARKET_SNAPSHOT_SLOTS = '09:05,12:35';

    await handleTelegramAdminBot(makeReq({
      message: { text: '🌐 All Platforms', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    fetchMock.mockClear();

    const res = await handleTelegramAdminBot(makeReq({
      message: { text: '📈 Market Snapshot', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    const body: any = await res.json();
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);

    expect(body.handled).toBe('report:market_snapshot');
    expect(payload.text).toContain('📈 <b>Market Snapshot</b>');
    expect(payload.text).toContain('crypto · crypto_fa_pilot · all');
    expect(payload.text).toContain('09:05,12:35');

    vi.unstubAllGlobals();
  });

  it('opens AI health monitoring detail without entering cost provider routing', async () => {
    const { env, fetchMock } = await chooseScope();

    await handleTelegramAdminBot(makeReq({
      message: { text: '𝕏 X / Twitter', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    fetchMock.mockClear();

    const res = await handleTelegramAdminBot(makeReq({
      message: { text: '🤖 AI Health', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    const body: any = await res.json();
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    const buttons = payload.reply_markup.keyboard.flat().map((b: any) => b.text);

    expect(body.handled).toBe('monitoring:ai_health');
    expect(payload.text).toContain('🤖 <b>AI Health</b>');
    expect(payload.text).toContain('AI cost scope: global');
    expect(buttons).toContain('📡 Source Health');
    expect(buttons).not.toContain('🟣 Anthropic');

    vi.unstubAllGlobals();
  });

  it('opens source health monitoring detail for the selected scope', async () => {
    const { env, fetchMock } = await chooseScope();

    await handleTelegramAdminBot(makeReq({
      message: { text: '𝕏 X / Twitter', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    fetchMock.mockClear();

    const res = await handleTelegramAdminBot(makeReq({
      message: { text: '📡 Source Health', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    const body: any = await res.json();
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);

    expect(body.handled).toBe('monitoring:source_health');
    expect(payload.text).toContain('📡 <b>Source Health</b>');
    expect(payload.text).toContain('crypto · crypto_fa_pilot · x');
    expect(payload.text).toContain('Top Sources');

    vi.unstubAllGlobals();
  });

  it('opens scheduler monitoring detail for the selected scope', async () => {
    const { env, fetchMock } = await chooseScope();

    await handleTelegramAdminBot(makeReq({
      message: { text: '🌐 All Platforms', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    fetchMock.mockClear();

    const res = await handleTelegramAdminBot(makeReq({
      message: { text: '⏱ Scheduler', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    const body: any = await res.json();
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);

    expect(body.handled).toBe('monitoring:scheduler');
    expect(payload.text).toContain('⏱ <b>Scheduler</b>');
    expect(payload.text).toContain('crypto · crypto_fa_pilot · all');
    expect(payload.text).toContain('Apify rotation');

    vi.unstubAllGlobals();
  });

  it('opens scoped settings from the command center', async () => {
    const { env, fetchMock } = await chooseScope();

    await handleTelegramAdminBot(makeReq({
      message: { text: '𝕏 X / Twitter', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    fetchMock.mockClear();

    const res = await handleTelegramAdminBot(makeReq({
      message: { text: '⚙️ Settings', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    const body: any = await res.json();
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    const buttons = payload.reply_markup.keyboard.flat().map((b: any) => b.text);

    expect(body.handled).toBe('settings');
    expect(payload.text).toContain('⚙️ <b>Settings</b>');
    expect(payload.text).toContain('crypto · crypto_fa_pilot · x');
    expect(buttons).toContain('🧩 Channel Config');
    expect(buttons).toContain('🌐 Platform Scope');
    expect(buttons).toContain('👥 Admin Access');

    vi.unstubAllGlobals();
  });

  it('opens channel settings detail as read-only text', async () => {
    const { env, fetchMock } = await chooseScope();

    await handleTelegramAdminBot(makeReq({
      message: { text: '𝕏 X / Twitter', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    fetchMock.mockClear();

    const res = await handleTelegramAdminBot(makeReq({
      message: { text: '🧩 Channel Config', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    const body: any = await res.json();
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);

    expect(body.handled).toBe('settings_detail');
    expect(payload.text).toContain('🧩 <b>Channel Config</b>');
    expect(payload.text).toContain('crypto · crypto_fa_pilot · x');
    expect(payload.text).toContain('max/day');

    vi.unstubAllGlobals();
  });

  it('opens scoped help and current scope detail', async () => {
    const { env, fetchMock } = await chooseScope();

    await handleTelegramAdminBot(makeReq({
      message: { text: '🌐 All Platforms', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    fetchMock.mockClear();

    const helpRes = await handleTelegramAdminBot(makeReq({
      message: { text: '❓ Help', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    const helpBody: any = await helpRes.json();
    const helpPayload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(helpBody.handled).toBe('help');
    expect(helpPayload.text).toContain('❓ <b>Help</b>');

    fetchMock.mockClear();

    const scopeRes = await handleTelegramAdminBot(makeReq({
      message: { text: '📎 Current Scope', chat: { id: 222 }, from: { id: 111 } },
    }), env);

    const scopeBody: any = await scopeRes.json();
    const scopePayload = JSON.parse(fetchMock.mock.calls[0][1].body);

    expect(scopeBody.handled).toBe('help_detail');
    expect(scopePayload.text).toContain('📎 <b>Current Scope</b>');
    expect(scopePayload.text).toContain('crypto · crypto_fa_pilot · all');

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
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);

    expect(res.status).toBe(200);
    expect(body.ignored).toBe(true);
    expect(body.reason).toBe('user_not_allowed');
    expect(body.user_id).toBe(999);
    expect(payload.text).toContain('🪪 Your Telegram user_id');
    expect(payload.text).toContain('<code>999</code>');

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
