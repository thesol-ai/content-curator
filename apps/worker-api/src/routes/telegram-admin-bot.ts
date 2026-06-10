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

type AdminScreen = 'home' | 'monitoring' | 'channels' | 'platforms' | 'reports' | 'costs' | 'ai_costs';

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

  if (text === '🟢 Monitoring') {
    await saveSession(env, chatId, { screen: 'monitoring' });
    await sendTelegramMessage(env, chatId, buildMonitoringText(), monitoringKeyboard());
    return Response.json({ ok: true, handled: 'monitoring' });
  }

  if (text === '📈 Reporting' || text === '/report' || text === '/ops' || text === '📊 Open Reports' || text === '📣 Change Channel' || text === '🧭 Change Scope') {
    await saveSession(env, chatId, { screen: 'channels' });
    await sendTelegramMessage(env, chatId, buildChannelPickerText(), await channelKeyboard(env));
    return Response.json({ ok: true, handled: 'channels' });
  }

  const monitoringSection = parseMonitoringButton(text);
  if (monitoringSection) {
    await saveSession(env, chatId, { screen: 'monitoring' });
    await sendReportSection(env, chatId, monitoringSection, 'crypto_fa_pilot', 'all', monitoringKeyboard());
    return Response.json({ ok: true, handled: `monitoring:${monitoringSection}` });
  }

  if (text === '📊 Reports') {
    const session = await loadSession(env, chatId);
    await saveSession(env, chatId, { screen: 'reports' });
    await sendTelegramMessage(env, chatId, buildReportSectionsText(session.channelId ?? 'crypto_fa_pilot', session.platform ?? 'all'), reportSectionKeyboard());
    return Response.json({ ok: true, handled: 'reports' });
  }

  if (text === '💸 Costs') {
    const session = await loadSession(env, chatId);
    await saveSession(env, chatId, { screen: 'costs' });
    await sendTelegramMessage(env, chatId, buildCostMenuText(session.channelId ?? 'crypto_fa_pilot', session.platform ?? 'all'), costMenuKeyboard());
    return Response.json({ ok: true, handled: 'costs_menu' });
  }

  if (text === '🤖 AI Providers') {
    const session = await loadSession(env, chatId);
    await saveSession(env, chatId, { screen: 'ai_costs' });
    await sendTelegramMessage(env, chatId, buildAIProviderMenuText(session.channelId ?? 'crypto_fa_pilot', session.platform ?? 'all'), aiProviderCostKeyboard());
    return Response.json({ ok: true, handled: 'ai_costs_menu' });
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
    await sendReportSection(env, chatId, 'overview', channelId, platform, reportSectionKeyboard());
    return Response.json({ ok: true, handled: 'report:overview' });
  }

  const costSection = parseCostSectionButton(text);
  if (costSection) {
    const session = await loadSession(env, chatId);
    const screen: AdminScreen = costSection === 'costs_anthropic' || costSection === 'costs_gemini' ? 'ai_costs' : 'costs';
    const keyboard = screen === 'ai_costs' ? aiProviderCostKeyboard() : costMenuKeyboard();
    await saveSession(env, chatId, { screen });
    await sendReportSection(env, chatId, costSection, session.channelId ?? 'crypto_fa_pilot', session.platform ?? 'all', keyboard);
    return Response.json({ ok: true, handled: `report:${costSection}` });
  }

  const section = parseSectionButton(text);
  if (section) {
    const session = await loadSession(env, chatId);
    await saveSession(env, chatId, { screen: 'reports' });
    await sendReportSection(env, chatId, section, session.channelId ?? 'crypto_fa_pilot', session.platform ?? 'all', reportSectionKeyboard());
    return Response.json({ ok: true, handled: `report:${section}` });
  }

  await saveSession(env, chatId, { screen: 'home' });
  await sendTelegramMessage(env, chatId, buildHomeText(), homeKeyboard());
  return Response.json({ ok: true, handled: 'fallback_home' });
}

async function handleLegacyCallback(env: Env, chatId: string | number, callbackData: string): Promise<void> {
  if (callbackData === 'home') {
    await saveSession(env, chatId, { screen: 'home' });
    await sendTelegramMessage(env, chatId, buildHomeText(), homeKeyboard());
    return;
  }

  if (callbackData === 'channels' || callbackData === 'report:menu') {
    await saveSession(env, chatId, { screen: 'channels' });
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
    await sendReportSection(env, chatId, 'overview', channelId, platform, reportSectionKeyboard());
    return;
  }

  if (callbackData.startsWith('report:')) {
    const [, sectionRaw, channelId = 'crypto_fa_pilot', platform = 'all'] = callbackData.split(':');
    const section = normalizeOperationalReportSection(sectionRaw);
    await saveSession(env, chatId, { channelId, platform, screen: 'reports' });
    await sendReportSection(env, chatId, section, channelId, platform, reportSectionKeyboard());
    return;
  }

  await saveSession(env, chatId, { screen: 'home' });
  await sendTelegramMessage(env, chatId, buildHomeText(), homeKeyboard());
}

async function handleBack(env: Env, chatId: string | number): Promise<string> {
  const session = await loadSession(env, chatId);
  const channelId = session.channelId ?? 'crypto_fa_pilot';
  const platform = session.platform ?? 'all';

  if (session.screen === 'ai_costs') {
    await saveSession(env, chatId, { screen: 'costs' });
    await sendTelegramMessage(env, chatId, buildCostMenuText(channelId, platform), costMenuKeyboard());
    return 'back:costs';
  }

  if (session.screen === 'costs') {
    await saveSession(env, chatId, { screen: 'reports' });
    await sendTelegramMessage(env, chatId, buildReportSectionsText(channelId, platform), reportSectionKeyboard());
    return 'back:reports';
  }

  if (session.screen === 'reports') {
    await saveSession(env, chatId, { screen: 'platforms' });
    await sendTelegramMessage(env, chatId, buildPlatformPickerText(channelId), await platformKeyboard(env, channelId));
    return 'back:platforms';
  }

  if (session.screen === 'platforms') {
    await saveSession(env, chatId, { screen: 'channels' });
    await sendTelegramMessage(env, chatId, buildChannelPickerText(), await channelKeyboard(env));
    return 'back:channels';
  }

  if (session.screen === 'channels' || session.screen === 'monitoring') {
    await saveSession(env, chatId, { screen: 'home' });
    await sendTelegramMessage(env, chatId, buildHomeText(), homeKeyboard());
    return 'back:home';
  }

  await saveSession(env, chatId, { screen: 'home' });
  await sendTelegramMessage(env, chatId, buildHomeText(), homeKeyboard());
  return 'back:home';
}

async function sendReportSection(
  env: Env,
  chatId: string | number,
  section: OperationalReportSection,
  channelId = 'crypto_fa_pilot',
  platform = 'all',
  keyboard: object = reportSectionKeyboard(),
): Promise<void> {
  const reportUrl = new URL('https://telegram-admin.local/internal/report/ops');
  reportUrl.searchParams.set('channel_id', sanitizeCallbackId(channelId, 'crypto_fa_pilot'));
  reportUrl.searchParams.set('platform', sanitizeCallbackId(platform, 'all'));

  const report = await buildOperationalReport(env, reportUrl);
  const text = formatOperationalReportForTelegram(report as any, section);
  await sendTelegramMessage(env, chatId, text, keyboard);
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
    'Choose an area. Monitoring is for live operations. Reporting is for analysis.',
  ].join('\n');
}

function buildMonitoringText(): string {
  return [
    '🟢 <b>Monitoring</b>',
    '',
    'Live operational checks and alerts.',
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

function buildReportSectionsText(channelId: string, platform: string): string {
  return [
    '📈 <b>Reporting</b>',
    '',
    `<b>Channel</b>: ${escapeHtml(channelId)}`,
    `<b>Platform</b>: ${escapeHtml(platform)}`,
    '',
    'Choose a report category.',
  ].join('\n');
}

function buildCostMenuText(channelId: string, platform: string): string {
  return [
    '💸 <b>Costs</b>',
    '',
    `<b>Channel</b>: ${escapeHtml(channelId)}`,
    `<b>Platform</b>: ${escapeHtml(platform)}`,
    '',
    'Costs are grouped so the keyboard stays readable.',
  ].join('\n');
}

function buildAIProviderMenuText(channelId: string, platform: string): string {
  return [
    '🤖 <b>AI Provider Costs</b>',
    '',
    `<b>Channel</b>: ${escapeHtml(channelId)}`,
    `<b>Platform</b>: ${escapeHtml(platform)}`,
    '',
    'AI cost is currently global, not scoped to this channel.',
  ].join('\n');
}

function homeKeyboard(): object {
  return replyKeyboard([
    ['🟢 Monitoring', '📈 Reporting'],
    ['🏠 Home'],
  ]);
}

function monitoringKeyboard(): object {
  return replyKeyboard([
    ['🟢 Status', '📬 Queue'],
    ['🚨 Failures', '🕷 Apify Runtime'],
    ['💰 Cost Watch'],
    ['⬅️ Back', '🏠 Home'],
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
  return replyKeyboard([
    ...channels.map(row => [`📣 ${row.id}`]),
    ['⬅️ Back', '🏠 Home'],
  ]);
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
  return replyKeyboard([
    ['🌐 All Platforms'],
    ...unique.map(platform => [platformLabel(platform)]),
    ['⬅️ Back', '📣 Change Channel'],
    ['🏠 Home'],
  ]);
}

function reportSectionKeyboard(): object {
  return replyKeyboard([
    ['📊 Overview', '💸 Costs'],
    ['🔄 Funnel', '📬 Publishing'],
    ['🩺 System', '🏆 Sources'],
    ['⬅️ Back', '📣 Change Channel'],
    ['🏠 Home'],
  ]);
}

function costMenuKeyboard(): object {
  return replyKeyboard([
    ['💸 Summary'],
    ['🤖 AI Providers', '🕷 Apify'],
    ['⬅️ Back', '📊 Reports'],
    ['🏠 Home'],
  ]);
}

function aiProviderCostKeyboard(): object {
  return replyKeyboard([
    ['🟣 Anthropic', '🔵 Gemini'],
    ['⬅️ Back', '💸 Costs'],
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

function parseMonitoringButton(text: string): OperationalReportSection | null {
  const map: Record<string, OperationalReportSection> = {
    '🟢 Status': 'overview',
    '📬 Queue': 'publish',
    '🚨 Failures': 'health',
    '🕷 Apify Runtime': 'apify',
    '💰 Cost Watch': 'costs',
  };
  return map[text] ?? null;
}

function parseCostSectionButton(text: string): OperationalReportSection | null {
  const normalized = text.replace(/^●\s*/, '').trim();
  const map: Record<string, OperationalReportSection> = {
    '💸 Summary': 'costs',
    '🟣 Anthropic': 'costs_anthropic',
    '🔵 Gemini': 'costs_gemini',
    '🕷 Apify': 'costs_apify',
  };
  return map[normalized] ?? null;
}

function parseSectionButton(text: string): OperationalReportSection | null {
  const normalized = text.replace(/^●\s*/, '').trim();
  const map: Record<string, OperationalReportSection> = {
    '📊 Overview': 'overview',
    '🔄 Funnel': 'pipeline',
    '📬 Publish': 'publish',
    '📬 Publishing': 'publish',
    '🩺 System': 'health',
    '🏆 Sources': 'sources',
  };
  return map[normalized] ?? null;
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

async function sendTelegramMessage(env: Env, chatId: string | number, text: string, replyMarkup?: object): Promise<void> {
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
  await saveSetting(env, sessionKey('session', chatId), JSON.stringify({ ...current, ...patch }));
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

  return raw.split(',').map(x => x.trim()).filter(Boolean).includes(String(userId));
}

function getActorId(update: TelegramUpdate): number | null {
  return update.callback_query?.from?.id ?? update.message?.from?.id ?? null;
}

function getChatId(update: TelegramUpdate): string | number | null {
  return update.callback_query?.message?.chat?.id ?? update.message?.chat?.id ?? null;
}
