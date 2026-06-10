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

type AdminScreen = 'home' | 'channels' | 'platforms' | 'reports';

type AdminSession = {
  channelId?: string;
  platform?: string;
  screen?: AdminScreen;
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

  if (callbackData) {
    await handleLegacyCallback(env, chatId, callbackData);
    return Response.json({ ok: true, handled: 'legacy_callback' });
  }


  if (text === '⬅️ Back') {
    const handled = await handleBack(env, chatId);
    return Response.json({ ok: true, handled });
  }

  if (text === '/start') {
    if (await shouldSuppressDuplicateStart(env, chatId)) {
      return Response.json({ ok: true, handled: 'duplicate_start_suppressed' });
    }

    await saveSession(env, chatId, { screen: 'home' });
    await sendTelegramMessage(env, chatId, buildHomeText(), homeKeyboard());
    return Response.json({ ok: true, handled: 'home' });
  }

  if (text === '/menu' || text === '🏠 Home') {
    await saveSession(env, chatId, { screen: 'home' });
    await sendTelegramMessage(env, chatId, buildHomeText(), homeKeyboard());
    return Response.json({ ok: true, handled: 'home' });
  }

  if (text === '/report' || text === '/ops' || text === '📊 Open Reports' || text === '📣 Change Channel' || text === '🧭 Change Scope') {
    await saveSession(env, chatId, { screen: 'channels' });
    await sendTelegramMessage(env, chatId, buildChannelPickerText(), await channelKeyboard(env));
    return Response.json({ ok: true, handled: 'channels' });
  }

  if (text.startsWith('📣 ')) {
    const channelId = sanitizeCallbackId(text.slice('📣 '.length).trim(), 'crypto_fa_pilot');
    await saveSession(env, chatId, { channelId, platform: 'all', screen: 'platforms' });
    await sendTelegramMessage(env, chatId, buildPlatformPickerText(channelId), await platformKeyboard(env, channelId));
    return Response.json({ ok: true, handled: 'platforms' });
  }

  const platform = parsePlatformButton(text);
  if (platform) {
    const session = await loadSession(env, chatId);
    const channelId = session.channelId ?? 'crypto_fa_pilot';
    await saveSession(env, chatId, { channelId, platform, screen: 'reports' });
    await sendReportSection(env, chatId, 'overview', channelId, platform);
    return Response.json({ ok: true, handled: 'report:overview' });
  }

  const section = parseSectionButton(text);
  if (section) {
    const session = await loadSession(env, chatId);
    await saveSession(env, chatId, { screen: 'reports' });
    await sendReportSection(env, chatId, section, session.channelId ?? 'crypto_fa_pilot', session.platform ?? 'all');
    return Response.json({ ok: true, handled: `report:${section}` });
  }

  await sendTelegramMessage(env, chatId, buildHomeText(), homeKeyboard());
  return Response.json({ ok: true, handled: 'fallback_home' });
}


async function handleBack(env: Env, chatId: string | number): Promise<string> {
  const session = await loadSession(env, chatId);

  if (session.screen === 'reports') {
    const channelId = session.channelId ?? 'crypto_fa_pilot';
    await saveSession(env, chatId, { screen: 'platforms' });
    await sendTelegramMessage(env, chatId, buildPlatformPickerText(channelId), await platformKeyboard(env, channelId));
    return 'back:platforms';
  }

  if (session.screen === 'platforms') {
    await saveSession(env, chatId, { screen: 'channels' });
    await sendTelegramMessage(env, chatId, buildChannelPickerText(), await channelKeyboard(env));
    return 'back:channels';
  }

  if (session.screen === 'channels') {
    await saveSession(env, chatId, { screen: 'home' });
    await sendTelegramMessage(env, chatId, buildHomeText(), homeKeyboard());
    return 'back:home';
  }

  await saveSession(env, chatId, { screen: 'home' });
  await sendTelegramMessage(env, chatId, buildHomeText(), homeKeyboard());
  return 'back:home';
}

async function handleLegacyCallback(env: Env, chatId: string | number, callbackData: string): Promise<void> {
  if (callbackData === 'home') {
    await sendTelegramMessage(env, chatId, buildHomeText(), homeKeyboard());
    return;
  }

  if (callbackData === 'channels' || callbackData === 'report:menu') {
    await sendTelegramMessage(env, chatId, buildChannelPickerText(), await channelKeyboard(env));
    return;
  }

  if (callbackData.startsWith('channel:')) {
    const channelId = sanitizeCallbackId(callbackData.slice('channel:'.length), 'crypto_fa_pilot');
    await saveSession(env, chatId, { channelId, platform: 'all', screen: 'platforms' });
    await sendTelegramMessage(env, chatId, buildPlatformPickerText(channelId), await platformKeyboard(env, channelId));
    return;
  }

  if (callbackData.startsWith('reports:')) {
    const [, channelId = 'crypto_fa_pilot', platform = 'all'] = callbackData.split(':');
    await saveSession(env, chatId, { channelId, platform, screen: 'reports' });
    await sendReportSection(env, chatId, 'overview', channelId, platform);
    return;
  }

  if (callbackData.startsWith('report:')) {
    const [, sectionRaw, channelId = 'crypto_fa_pilot', platform = 'all'] = callbackData.split(':');
    const section = normalizeOperationalReportSection(sectionRaw);
    await saveSession(env, chatId, { channelId, platform });
    await sendReportSection(env, chatId, section, channelId, platform);
    return;
  }

  await sendTelegramMessage(env, chatId, buildHomeText(), homeKeyboard());
}

async function sendReportSection(
  env: Env,
  chatId: string | number,
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
  await sendTelegramMessage(env, chatId, text, reportSectionKeyboard(section));
}

function buildUnauthorizedText(userId: number | null): string {
  return [
    '🚫 <b>Access denied</b>',
    '',
    'This bot is restricted to approved admin users.',
    '',
    `🪪 Your Telegram user_id: <code>${userId ?? 'unknown'}</code>`,
    '',
    'Ask an admin to add this ID to TELEGRAM_ADMIN_ALLOWED_USER_IDS.',
  ].join('\n');
}


function buildHomeText(): string {
  return [
    '📊 <b>Content Command Center</b>',
    '',
    'Reports by channel, platform, and section.',
    'Use the keyboard below.',
  ].join('\n');
}


function buildChannelPickerText(): string {
  return [
    '📣 <b>Select Channel</b>',
    '',
    'Choose a publishing channel.',
  ].join('\n');
}


function buildPlatformPickerText(channelId: string): string {
  return [
    '🌐 <b>Select Platform</b>',
    '',
    `<b>Channel</b>: ${escapeHtml(channelId)}`,
    '',
    'Choose a platform.',
  ].join('\n');
}

function buildReportPickerText(channelId: string, platform: string): string {
  return [
    '🧭 <b>Select Report Section</b>',
    '',
    `<b>Channel</b>: <code>${escapeHtml(channelId)}</code>`,
    `<b>Platform</b>: <code>${escapeHtml(platform)}</code>`,
    '',
    'Pick the section you want to generate.',
  ].join('\n');
}

function homeKeyboard(): object {
  return replyKeyboard([
    ['📊 Open Reports'],
    ['🏠 Home'],
  ]);
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
  const rowsForKeyboard = channels.map(row => [`📣 ${row.id}`]);
  rowsForKeyboard.push(['⬅️ Back', '🏠 Home']);

  return replyKeyboard(rowsForKeyboard);
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
  const rowsForKeyboard = [
    ['🌐 All Platforms'],
    ...unique.map(platform => [platformLabel(platform)]),
    ['⬅️ Back', '📣 Change Channel'],
    ['🏠 Home'],
  ];

  return replyKeyboard(rowsForKeyboard);
}

function reportSectionKeyboard(active: OperationalReportSection): object {
  const label = (section: OperationalReportSection, text: string) =>
    section === active ? `● ${text}` : text;

  return replyKeyboard([
    [label('overview', '📊 Overview'), label('costs', '💸 Costs')],
    [label('pipeline', '🔄 Funnel'), label('publish', '📬 Publish')],
    [label('apify', '🕷 Apify'), label('health', '🩺 System')],
    [label('sources', '🏆 Sources')],
    ['⬅️ Back', '📣 Change Channel'],
    ['🏠 Home'],
  ]);
}

function replyKeyboard(rows: string[][]): object {
  return {
    keyboard: rows.map(row => row.map(text => ({ text }))),
    resize_keyboard: true,
    one_time_keyboard: false,
    is_persistent: true,
  };
}

function platformLabel(platform: string): string {
  const p = String(platform).toLowerCase();
  if (p === 'x' || p === 'twitter') return '𝕏 X / Twitter';
  if (p === 'instagram') return '📸 Instagram';
  if (p === 'linkedin') return '💼 LinkedIn';
  return `🌐 ${platform}`;
}

function parsePlatformButton(text: string): string | null {
  if (text === '🌐 All Platforms') return 'all';
  if (text === '𝕏 X / Twitter') return 'x';
  if (text === '📸 Instagram') return 'instagram';
  if (text === '💼 LinkedIn') return 'linkedin';
  if (text.startsWith('🌐 ')) return sanitizeCallbackId(text.slice('🌐 '.length).trim(), 'all');
  return null;
}

function parseSectionButton(text: string): OperationalReportSection | null {
  const normalized = text.replace(/^●\s*/, '').trim();

  const map: Record<string, OperationalReportSection> = {
    '📊 Overview': 'overview',
    '💸 Costs': 'costs',
    '🔄 Funnel': 'pipeline',
    '📬 Publish': 'publish',
    '🕷 Apify': 'apify',
    '🩺 System': 'health',
    '🏆 Sources': 'sources',
  };

  return map[normalized] ?? null;
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

async function answerCallbackQuery(env: Env, callbackQueryId: string): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return;

  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  }).catch(() => undefined);
}

async function shouldSuppressDuplicateStart(env: Env, chatId: string | number): Promise<boolean> {
  const key = sessionKey('last_start', chatId);
  const now = Date.now();
  const row = await safeFirst<{ value: string } | null>(env, `
    SELECT value
    FROM settings
    WHERE key=?
    LIMIT 1
  `, [key], null);

  const last = Number(row?.value ?? 0);
  await saveSetting(env, key, String(now));

  return Number.isFinite(last) && last > 0 && now - last < 5000;
}

async function loadSession(env: Env, chatId: string | number): Promise<AdminSession> {
  const row = await safeFirst<{ value: string } | null>(env, `
    SELECT value
    FROM settings
    WHERE key=?
    LIMIT 1
  `, [sessionKey('session', chatId)], null);

  if (!row?.value) return {};

  try {
    const parsed = JSON.parse(row.value) as AdminSession;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function saveSession(env: Env, chatId: string | number, patch: AdminSession): Promise<void> {
  const current = await loadSession(env, chatId);
  const next = {
    ...current,
    ...patch,
  };

  await saveSetting(env, sessionKey('session', chatId), JSON.stringify(next));
}

async function saveSetting(env: Env, key: string, value: string): Promise<void> {
  try {
    await env.DB.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value=excluded.value,
        updated_at=CURRENT_TIMESTAMP
    `).bind(key, value).run();
  } catch (error) {
    console.warn('[TelegramAdminBot] saveSetting failed:', error instanceof Error ? error.message : String(error));
  }
}

function sessionKey(kind: string, chatId: string | number): string {
  return `telegram_admin:${kind}:${chatId}`;
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
