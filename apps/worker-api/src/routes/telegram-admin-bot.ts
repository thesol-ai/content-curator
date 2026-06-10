import type { Env } from '../types';
import { buildOperationalReport } from '../services/operational-report';
import {
  formatOperationalReportForTelegram,
  normalizeOperationalReportSection,
  type OperationalReportSection,
} from '../services/report-message-formatter';

type TelegramUpdate = {
  update_id?: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

type TelegramMessage = {
  message_id?: number;
  text?: string;
  chat?: { id?: number | string; type?: string };
  from?: { id?: number; username?: string; first_name?: string };
};

type TelegramCallbackQuery = {
  id?: string;
  data?: string;
  message?: TelegramMessage;
  from?: { id?: number; username?: string; first_name?: string };
};

export async function handleTelegramAdminBot(req: Request, env: Env): Promise<Response> {
  if (env.TELEGRAM_ADMIN_BOT_ENABLED !== 'true') {
    return Response.json({ ok: false, error: 'telegram_admin_bot_disabled' }, { status: 404 });
  }

  if (req.method !== 'POST') {
    return Response.json({ ok: false, error: 'method_not_allowed' }, { status: 405 });
  }

  if (!verifyTelegramAdminSecret(req, env)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const update = await req.json().catch(() => null) as TelegramUpdate | null;
  if (!update || typeof update !== 'object') {
    return Response.json({ ok: false, error: 'invalid_update' }, { status: 400 });
  }

  const actorId = getActorId(update);
  const chatId = getChatId(update);

  if (!chatId) {
    return Response.json({ ok: true, ignored: true, reason: 'missing_chat_id' });
  }

  if (!isAllowedAdminUser(actorId, env)) {
    console.warn(`[TelegramAdminBot] unauthorized user_id=${actorId ?? 'unknown'}`);
    await sendTelegramMessage(env, chatId, buildUnauthorizedText(actorId), undefined);
    return Response.json({ ok: true, ignored: true, reason: 'user_not_allowed', user_id: actorId ?? null });
  }

  if (update.callback_query?.id) {
    await answerCallbackQuery(env, update.callback_query.id);
  }

  const text = update.message?.text?.trim() ?? '';
  const callbackData = update.callback_query?.data?.trim() ?? '';
  const callbackMessageId = update.callback_query?.message?.message_id;

  if (text === '/start' || text === '/menu' || callbackData === 'home') {
    await replyOrEdit(env, chatId, callbackMessageId, buildHomeText(), homeKeyboard());
    return Response.json({ ok: true, handled: 'home' });
  }

  if (text === '/report' || text === '/ops' || callbackData === 'channels' || callbackData === 'report:menu') {
    await replyOrEdit(env, chatId, callbackMessageId, buildChannelPickerText(), await channelKeyboard(env));
    return Response.json({ ok: true, handled: 'channels' });
  }

  if (callbackData.startsWith('channel:')) {
    const channelId = sanitizeCallbackId(callbackData.slice('channel:'.length), 'crypto_fa_pilot');
    await replyOrEdit(env, chatId, callbackMessageId, buildPlatformPickerText(channelId), await platformKeyboard(env, channelId));
    return Response.json({ ok: true, handled: 'platforms' });
  }

  if (callbackData.startsWith('reports:')) {
    const [, channelId = 'crypto_fa_pilot', platform = 'all'] = callbackData.split(':');
    await sendReportSection(env, chatId, callbackMessageId, 'overview', channelId, platform);
    return Response.json({ ok: true, handled: 'report:overview' });
  }

  if (callbackData.startsWith('report:')) {
    const [, sectionRaw, channelId = 'crypto_fa_pilot', platform = 'all'] = callbackData.split(':');
    const section = normalizeOperationalReportSection(sectionRaw);
    await sendReportSection(env, chatId, callbackMessageId, section, channelId, platform);
    return Response.json({ ok: true, handled: `report:${section}` });
  }

  await replyOrEdit(env, chatId, callbackMessageId, buildHomeText(), homeKeyboard());
  return Response.json({ ok: true, handled: 'fallback_home' });
}

async function sendReportSection(
  env: Env,
  chatId: string | number,
  messageId: number | undefined,
  section: OperationalReportSection,
  channelId = 'crypto_fa_pilot',
  platform = 'all',
): Promise<void> {
  const cleanChannelId = sanitizeCallbackId(channelId, 'crypto_fa_pilot');
  const cleanPlatform = sanitizeCallbackId(platform, 'all');

  const reportUrl = new URL('https://telegram-admin.local/internal/report/ops');
  reportUrl.searchParams.set('channel_id', cleanChannelId);
  reportUrl.searchParams.set('platform', cleanPlatform);

  const report = await buildOperationalReport(env, reportUrl);
  const text = formatOperationalReportForTelegram(report as any, section);
  await replyOrEdit(env, chatId, messageId, text, reportSectionKeyboard(section, cleanChannelId, cleanPlatform));
}

function buildUnauthorizedText(userId: number | null): string {
  return [
    'Access denied',
    '',
    'This bot is restricted to approved admin users.',
    '',
    `Your Telegram user_id: <code>${userId ?? 'unknown'}</code>`,
    '',
    'Ask an admin to add this ID to TELEGRAM_ADMIN_ALLOWED_USER_IDS.',
  ].join('\n');
}

function buildHomeText(): string {
  return [
    '<b>Content Admin Home</b>',
    '',
    'Select a channel, then a platform, then a report section.',
  ].join('\n');
}

function buildChannelPickerText(): string {
  return [
    '<b>Select Channel</b>',
    '',
    'Reports are scoped by channel and platform.',
  ].join('\n');
}

function buildPlatformPickerText(channelId: string): string {
  return [
    '<b>Select Platform</b>',
    '',
    `Channel: <code>${escapeHtml(channelId)}</code>`,
  ].join('\n');
}

function homeKeyboard(): object {
  return {
    inline_keyboard: [
      [{ text: 'Reports', callback_data: 'channels' }],
    ],
  };
}

async function channelKeyboard(env: Env): Promise<object> {
  const rows = await safeAll<{ id: string; category_id: string }>(env, `
    SELECT id, category_id
    FROM channels
    WHERE enabled=1
    ORDER BY id
    LIMIT 20
  `);

  const channels = rows.length > 0 ? rows : [{ id: 'crypto_fa_pilot', category_id: 'crypto' }];

  return {
    inline_keyboard: [
      ...channels.map(row => ([{
        text: row.id,
        callback_data: `channel:${row.id}`,
      }])),
      [{ text: 'Home', callback_data: 'home' }],
    ],
  };
}

async function platformKeyboard(env: Env, channelId: string): Promise<object> {
  const category = await safeFirst<{ category_id: string } | null>(env, `
    SELECT category_id
    FROM channels
    WHERE id=?
    LIMIT 1
  `, [channelId], null);

  const categoryId = category?.category_id ?? 'crypto';
  const rows = await safeAll<{ platform: string }>(env, `
    SELECT DISTINCT platform
    FROM (
      SELECT platform FROM source_accounts WHERE category_id=? AND enabled=1
      UNION
      SELECT platform FROM apify_sources WHERE category_id=? AND enabled=1
      UNION
      SELECT platform FROM discovery_runs WHERE category_id=?
      UNION
      SELECT platform FROM discovery_items WHERE category_id=?
    )
    WHERE platform IS NOT NULL
      AND platform != ''
    ORDER BY platform
    LIMIT 10
  `, [categoryId, categoryId, categoryId, categoryId]);

  const platforms = rows.map(row => row.platform).filter(Boolean);
  const unique = platforms.length > 0 ? platforms : ['x', 'instagram', 'linkedin'];

  return {
    inline_keyboard: [
      [{ text: 'All platforms', callback_data: `reports:${channelId}:all` }],
      ...unique.map(platform => ([{
        text: platformLabel(platform),
        callback_data: `reports:${channelId}:${platform}`,
      }])),
      [{ text: 'Change channel', callback_data: 'channels' }],
      [{ text: 'Home', callback_data: 'home' }],
    ],
  };
}

function reportSectionKeyboard(active: OperationalReportSection, channelId = 'crypto_fa_pilot', platform = 'all'): object {
  const label = (section: OperationalReportSection, text: string) =>
    section === active ? `● ${text}` : text;

  return {
    inline_keyboard: [
      [
        { text: label('overview', 'Overview'), callback_data: `report:overview:${channelId}:${platform}` },
        { text: label('costs', 'Costs'), callback_data: `report:costs:${channelId}:${platform}` },
      ],
      [
        { text: label('pipeline', 'Funnel'), callback_data: `report:pipeline:${channelId}:${platform}` },
        { text: label('publish', 'Publish'), callback_data: `report:publish:${channelId}:${platform}` },
      ],
      [
        { text: label('apify', 'Apify'), callback_data: `report:apify:${channelId}:${platform}` },
        { text: label('health', 'System'), callback_data: `report:health:${channelId}:${platform}` },
      ],
      [
        { text: label('sources', 'Sources'), callback_data: `report:sources:${channelId}:${platform}` },
      ],
      [
        { text: 'Change channel', callback_data: 'channels' },
        { text: 'Home', callback_data: 'home' },
      ],
    ],
  };
}

function platformLabel(platform: string): string {
  const p = String(platform).toLowerCase();
  if (p === 'x' || p === 'twitter') return 'X / Twitter';
  if (p === 'instagram') return 'Instagram';
  if (p === 'linkedin') return 'LinkedIn';
  return platform;
}

async function replyOrEdit(
  env: Env,
  chatId: string | number,
  messageId: number | undefined,
  text: string,
  replyMarkup?: object,
): Promise<void> {
  if (messageId) {
    await editTelegramMessage(env, chatId, messageId, text, replyMarkup);
    return;
  }

  await sendTelegramMessage(env, chatId, text, replyMarkup);
}

async function sendTelegramMessage(
  env: Env,
  chatId: string | number,
  text: string,
  replyMarkup?: object,
): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not configured');

  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };

  if (replyMarkup) payload.reply_markup = replyMarkup;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Telegram sendMessage failed ${res.status}: ${body.slice(0, 300)}`);
  }
}

async function editTelegramMessage(
  env: Env,
  chatId: string | number,
  messageId: number,
  text: string,
  replyMarkup?: object,
): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not configured');

  const payload: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };

  if (replyMarkup) payload.reply_markup = replyMarkup;

  const res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (body.includes('message is not modified')) return;
    throw new Error(`Telegram editMessageText failed ${res.status}: ${body.slice(0, 300)}`);
  }
}

async function answerCallbackQuery(env: Env, callbackQueryId: string): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return;

  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  }).catch(() => undefined);
}

async function safeFirst<T>(env: Env, sql: string, binds: unknown[], fallback: T): Promise<T> {
  try {
    const stmt = env.DB.prepare(sql);
    const row = binds.length > 0 ? await stmt.bind(...binds).first<T>() : await stmt.first<T>();
    return row ?? fallback;
  } catch {
    return fallback;
  }
}

async function safeAll<T>(env: Env, sql: string, binds: unknown[] = []): Promise<T[]> {
  try {
    const stmt = env.DB.prepare(sql);
    const result = binds.length > 0 ? await stmt.bind(...binds).all<T>() : await stmt.all<T>();
    return (result.results ?? []) as T[];
  } catch {
    return [];
  }
}

function sanitizeCallbackId(value: string, fallback: string): string {
  return /^[\w-]{1,64}$/.test(value) ? value : fallback;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function verifyTelegramAdminSecret(req: Request, env: Env): boolean {
  const expected = env.TELEGRAM_ADMIN_BOT_SECRET?.trim();
  if (!expected) return env.ENVIRONMENT === 'local';

  const provided =
    req.headers.get('X-Telegram-Bot-Api-Secret-Token') ??
    req.headers.get('x-telegram-bot-api-secret-token') ??
    new URL(req.url).searchParams.get('secret');

  return provided === expected;
}

function isAllowedAdminUser(userId: number | null, env: Env): boolean {
  const raw = env.TELEGRAM_ADMIN_ALLOWED_USER_IDS?.trim();
  if (!raw) return env.ENVIRONMENT === 'local';
  if (!userId) return false;

  const allowed = raw
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);

  return allowed.includes(String(userId));
}

function getActorId(update: TelegramUpdate): number | null {
  return update.callback_query?.from?.id ?? update.message?.from?.id ?? null;
}

function getChatId(update: TelegramUpdate): string | number | null {
  const chatId = update.callback_query?.message?.chat?.id ?? update.message?.chat?.id;
  return chatId ?? null;
}
