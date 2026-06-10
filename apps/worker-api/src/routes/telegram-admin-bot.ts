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

type AdminScreen =
  | 'scope_categories'
  | 'scope_channels'
  | 'scope_platforms'
  | 'command_center'
  | 'monitoring'
  | 'reporting'
  | 'costs'
  | 'ai_costs'
  | 'operations'
  | 'settings'
  | 'audit'
  | 'help';

type AdminSession = {
  categoryId?: string;
  channelId?: string;
  platform?: string;
  screen?: AdminScreen;
};

type ChannelRow = {
  id: string;
  category_id: string;
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
    await recordAdminAudit(env, actorId, 'access_denied', {}, 'denied');
    return Response.json({ ok: true, ignored: true, reason: 'user_not_allowed', user_id: actorId ?? null });
  }

  if (update.callback_query?.id) {
    await answerCallbackQuery(env, update.callback_query.id);
  }

  const text = update.message?.text?.trim() ?? '';
  const callbackData = update.callback_query?.data?.trim() ?? '';

  if (callbackData) {
    await handleLegacyCallback(env, chatId, actorId, callbackData);
    return Response.json({ ok: true, handled: 'legacy_callback' });
  }

  if (text === '⬅️ Back') {
    const handled = await handleBack(env, chatId);
    await recordAdminAudit(env, actorId, 'back', await loadSession(env, chatId), handled);
    return Response.json({ ok: true, handled });
  }

  if (text === '/start') {
    if (await shouldSuppressDuplicateStart(env, chatId)) {
      return Response.json({ ok: true, handled: 'duplicate_start_suppressed' });
    }

    const handled = await sendEntry(env, chatId);
    await recordAdminAudit(env, actorId, 'start', await loadSession(env, chatId), handled);
    return Response.json({ ok: true, handled });
  }

  if (text === '/menu' || text === '🏠 Home') {
    const handled = await sendEntry(env, chatId);
    await recordAdminAudit(env, actorId, 'home', await loadSession(env, chatId), handled);
    return Response.json({ ok: true, handled });
  }

  if (text === '/scope' || text === '📌 Change Scope' || text === '📂 Change Category') {
    await saveSession(env, chatId, {
      categoryId: undefined,
      channelId: undefined,
      platform: 'all',
      screen: 'scope_categories',
    });
    await sendTelegramMessage(env, chatId, buildCategoryPickerText(), await categoryKeyboard(env));
    return Response.json({ ok: true, handled: 'scope_categories' });
  }

  const categoryId = parseCategoryButton(text);
  if (categoryId) {
    await saveSession(env, chatId, {
      categoryId,
      channelId: undefined,
      platform: 'all',
      screen: 'scope_channels',
    });
    await sendTelegramMessage(env, chatId, buildChannelPickerText(categoryId), await channelKeyboard(env, categoryId));
    return Response.json({ ok: true, handled: 'scope_channels' });
  }

  if (text === '📣 Change Channel') {
    const session = await loadSession(env, chatId);
    if (!session.categoryId) {
      await saveSession(env, chatId, { screen: 'scope_categories' });
      await sendTelegramMessage(env, chatId, buildCategoryPickerText(), await categoryKeyboard(env));
      return Response.json({ ok: true, handled: 'scope_categories' });
    }

    await saveSession(env, chatId, { channelId: undefined, platform: 'all', screen: 'scope_channels' });
    await sendTelegramMessage(env, chatId, buildChannelPickerText(session.categoryId), await channelKeyboard(env, session.categoryId));
    return Response.json({ ok: true, handled: 'scope_channels' });
  }

  if (text === '🌐 Change Platform') {
    const session = await loadSession(env, chatId);
    const scoped = await requireScope(env, chatId, session);
    if (!scoped) return Response.json({ ok: true, handled: 'scope_required' });

    await saveSession(env, chatId, { screen: 'scope_platforms' });
    await sendTelegramMessage(env, chatId, buildPlatformPickerText(scoped), await platformKeyboard(env, scoped.categoryId, scoped.channelId));
    return Response.json({ ok: true, handled: 'scope_platforms' });
  }

  if (text.startsWith('📣 ')) {
    const channelId = sanitizeCallbackId(text.slice('📣 '.length).trim(), 'crypto_fa_pilot');
    const session = await loadSession(env, chatId);
    const channelCategory = await getChannelCategory(env, channelId);
    const categoryIdForChannel = channelCategory ?? session.categoryId ?? 'crypto';

    await saveSession(env, chatId, {
      categoryId: categoryIdForChannel,
      channelId,
      platform: 'all',
      screen: 'scope_platforms',
    });
    await sendTelegramMessage(
      env,
      chatId,
      buildPlatformPickerText({ categoryId: categoryIdForChannel, channelId, platform: 'all' }),
      await platformKeyboard(env, categoryIdForChannel, channelId),
    );
    return Response.json({ ok: true, handled: 'scope_platforms' });
  }

  const platform = parsePlatformButton(text);
  if (platform) {
    const session = await loadSession(env, chatId);
    const scoped = await requireScope(env, chatId, session);
    if (!scoped) return Response.json({ ok: true, handled: 'scope_required' });

    const next = { ...scoped, platform };
    await saveSession(env, chatId, { ...next, screen: 'command_center' });
    await sendTelegramMessage(env, chatId, buildCommandCenterText(next), commandCenterKeyboard());
    return Response.json({ ok: true, handled: 'command_center' });
  }

  if (text === '🟢 Monitoring') {
    const scoped = await requireScope(env, chatId, await loadSession(env, chatId));
    if (!scoped) return Response.json({ ok: true, handled: 'scope_required' });

    await saveSession(env, chatId, { ...scoped, screen: 'monitoring' });
    await sendTelegramMessage(env, chatId, buildMonitoringText(scoped), monitoringKeyboard());
    return Response.json({ ok: true, handled: 'monitoring' });
  }

  if (text === '📈 Reporting' || text === '📊 Reports') {
    const scoped = await requireScope(env, chatId, await loadSession(env, chatId));
    if (!scoped) return Response.json({ ok: true, handled: 'scope_required' });

    await saveSession(env, chatId, { ...scoped, screen: 'reporting' });
    await sendTelegramMessage(env, chatId, buildReportingText(scoped), reportingKeyboard());
    return Response.json({ ok: true, handled: 'reporting' });
  }

  if (text === '🛠 Operations') {
    const scoped = await requireScope(env, chatId, await loadSession(env, chatId));
    if (!scoped) return Response.json({ ok: true, handled: 'scope_required' });

    await saveSession(env, chatId, { ...scoped, screen: 'operations' });
    await sendTelegramMessage(env, chatId, buildOperationsText(scoped), operationsKeyboard());
    return Response.json({ ok: true, handled: 'operations' });
  }

  if (text === '⚙️ Settings') {
    const scoped = await requireScope(env, chatId, await loadSession(env, chatId));
    if (!scoped) return Response.json({ ok: true, handled: 'scope_required' });

    await saveSession(env, chatId, { ...scoped, screen: 'settings' });
    await sendTelegramMessage(env, chatId, buildSettingsText(scoped), settingsKeyboard());
    return Response.json({ ok: true, handled: 'settings' });
  }

  if (text === '🧾 Audit Log') {
    const scoped = await requireScope(env, chatId, await loadSession(env, chatId));
    if (!scoped) return Response.json({ ok: true, handled: 'scope_required' });

    await saveSession(env, chatId, { ...scoped, screen: 'audit' });
    await sendTelegramMessage(env, chatId, buildAuditText(scoped), auditKeyboard());
    return Response.json({ ok: true, handled: 'audit' });
  }

  if (text === '❓ Help') {
    const scoped = await requireScope(env, chatId, await loadSession(env, chatId));
    if (!scoped) return Response.json({ ok: true, handled: 'scope_required' });

    await saveSession(env, chatId, { ...scoped, screen: 'help' });
    await sendTelegramMessage(env, chatId, buildHelpText(scoped), helpKeyboard());
    return Response.json({ ok: true, handled: 'help' });
  }

  const monitoringSection = parseMonitoringButton(text);
  if (monitoringSection) {
    const scoped = await requireScope(env, chatId, await loadSession(env, chatId));
    if (!scoped) return Response.json({ ok: true, handled: 'scope_required' });

    await saveSession(env, chatId, { ...scoped, screen: 'monitoring' });
    await sendReportSection(env, chatId, monitoringSection, scoped, monitoringKeyboard());
    await recordAdminAudit(env, actorId, `view:${monitoringSection}`, scoped, 'ok');
    return Response.json({ ok: true, handled: `monitoring:${monitoringSection}` });
  }

  if (text === '💸 Costs') {
    const scoped = await requireScope(env, chatId, await loadSession(env, chatId));
    if (!scoped) return Response.json({ ok: true, handled: 'scope_required' });

    await saveSession(env, chatId, { ...scoped, screen: 'costs' });
    await sendTelegramMessage(env, chatId, buildCostMenuText(scoped), costMenuKeyboard());
    return Response.json({ ok: true, handled: 'costs_menu' });
  }

  if (text === '🤖 AI Providers') {
    const scoped = await requireScope(env, chatId, await loadSession(env, chatId));
    if (!scoped) return Response.json({ ok: true, handled: 'scope_required' });

    await saveSession(env, chatId, { ...scoped, screen: 'ai_costs' });
    await sendTelegramMessage(env, chatId, buildAIProviderMenuText(scoped), aiProviderCostKeyboard());
    return Response.json({ ok: true, handled: 'ai_costs_menu' });
  }

  const costSection = parseCostSectionButton(text);
  if (costSection) {
    const scoped = await requireScope(env, chatId, await loadSession(env, chatId));
    if (!scoped) return Response.json({ ok: true, handled: 'scope_required' });

    const screen: AdminScreen = costSection === 'costs_anthropic' || costSection === 'costs_gemini' ? 'ai_costs' : 'costs';
    const keyboard = screen === 'ai_costs' ? aiProviderCostKeyboard() : costMenuKeyboard();
    await saveSession(env, chatId, { ...scoped, screen });
    await sendReportSection(env, chatId, costSection, scoped, keyboard);
    return Response.json({ ok: true, handled: `report:${costSection}` });
  }

  const reportSection = parseReportingButton(text);
  if (reportSection) {
    const scoped = await requireScope(env, chatId, await loadSession(env, chatId));
    if (!scoped) return Response.json({ ok: true, handled: 'scope_required' });

    await saveSession(env, chatId, { ...scoped, screen: 'reporting' });
    await sendReportSection(env, chatId, reportSection, scoped, reportingKeyboard());
    return Response.json({ ok: true, handled: `report:${reportSection}` });
  }

  const operationText = parseOperationButton(text);
  if (operationText) {
    const scoped = await requireScope(env, chatId, await loadSession(env, chatId));
    if (!scoped) return Response.json({ ok: true, handled: 'scope_required' });

    await saveSession(env, chatId, { ...scoped, screen: 'operations' });
    await sendTelegramMessage(env, chatId, buildOperationReadOnlyText(operationText, scoped), operationsKeyboard());
    await recordAdminAudit(env, actorId, `operation_preview:${operationText}`, scoped, 'read_only');
    return Response.json({ ok: true, handled: 'operation_read_only' });
  }

  const settingsText = parseSettingsButton(text, await loadSession(env, chatId));
  if (settingsText) {
    await saveSession(env, chatId, { screen: 'settings' });
    await sendTelegramMessage(env, chatId, settingsText, settingsKeyboard());
    return Response.json({ ok: true, handled: 'settings_detail' });
  }

  const auditText = parseAuditButton(text);
  if (auditText) {
    await saveSession(env, chatId, { screen: 'audit' });
    await sendTelegramMessage(env, chatId, auditText, auditKeyboard());
    return Response.json({ ok: true, handled: 'audit_detail' });
  }

  const handled = await sendEntry(env, chatId);
  return Response.json({ ok: true, handled: `fallback:${handled}` });
}

async function handleLegacyCallback(
  env: Env,
  chatId: string | number,
  actorId: number | null,
  callbackData: string,
): Promise<void> {
  if (callbackData === 'home') {
    await sendEntry(env, chatId);
    return;
  }

  if (callbackData === 'channels' || callbackData === 'report:menu') {
    await saveSession(env, chatId, { screen: 'scope_categories' });
    await sendTelegramMessage(env, chatId, buildCategoryPickerText(), await categoryKeyboard(env));
    return;
  }

  if (callbackData.startsWith('channel:')) {
    const channelId = sanitizeCallbackId(callbackData.slice('channel:'.length), 'crypto_fa_pilot');
    const categoryId = await getChannelCategory(env, channelId) ?? 'crypto';
    await saveSession(env, chatId, { categoryId, channelId, platform: 'all', screen: 'scope_platforms' });
    await sendTelegramMessage(env, chatId, buildPlatformPickerText({ categoryId, channelId, platform: 'all' }), await platformKeyboard(env, categoryId, channelId));
    return;
  }

  if (callbackData.startsWith('reports:')) {
    const [, channelId = 'crypto_fa_pilot', platform = 'all'] = callbackData.split(':');
    const categoryId = await getChannelCategory(env, channelId) ?? 'crypto';
    const scoped = { categoryId, channelId, platform: sanitizeCallbackId(platform, 'all') };
    await saveSession(env, chatId, { ...scoped, screen: 'reporting' });
    await sendTelegramMessage(env, chatId, buildReportingText(scoped), reportingKeyboard());
    return;
  }

  if (callbackData.startsWith('report:')) {
    const [, sectionRaw, channelId = 'crypto_fa_pilot', platform = 'all'] = callbackData.split(':');
    const categoryId = await getChannelCategory(env, channelId) ?? 'crypto';
    const section = normalizeOperationalReportSection(sectionRaw);
    const scoped = { categoryId, channelId, platform: sanitizeCallbackId(platform, 'all') };
    await saveSession(env, chatId, { ...scoped, screen: 'reporting' });
    await sendReportSection(env, chatId, section, scoped, reportingKeyboard());
    await recordAdminAudit(env, actorId, `legacy:${section}`, scoped, 'ok');
    return;
  }

  await sendEntry(env, chatId);
}

async function handleBack(env: Env, chatId: string | number): Promise<string> {
  const session = await loadSession(env, chatId);
  const scoped = scopedFromSession(session);

  if (session.screen === 'ai_costs' && scoped) {
    await saveSession(env, chatId, { ...scoped, screen: 'costs' });
    await sendTelegramMessage(env, chatId, buildCostMenuText(scoped), costMenuKeyboard());
    return 'back:costs';
  }

  if (session.screen === 'costs' && scoped) {
    await saveSession(env, chatId, { ...scoped, screen: 'reporting' });
    await sendTelegramMessage(env, chatId, buildReportingText(scoped), reportingKeyboard());
    return 'back:reporting';
  }

  if ((session.screen === 'monitoring' || session.screen === 'reporting' || session.screen === 'operations' || session.screen === 'settings' || session.screen === 'audit' || session.screen === 'help') && scoped) {
    await saveSession(env, chatId, { ...scoped, screen: 'command_center' });
    await sendTelegramMessage(env, chatId, buildCommandCenterText(scoped), commandCenterKeyboard());
    return 'back:command_center';
  }

  if (session.screen === 'command_center' && scoped) {
    await saveSession(env, chatId, { ...scoped, screen: 'scope_platforms' });
    await sendTelegramMessage(env, chatId, buildPlatformPickerText(scoped), await platformKeyboard(env, scoped.categoryId, scoped.channelId));
    return 'back:scope_platforms';
  }

  if (session.screen === 'scope_platforms' && session.categoryId) {
    await saveSession(env, chatId, { ...session, channelId: undefined, platform: 'all', screen: 'scope_channels' });
    await sendTelegramMessage(env, chatId, buildChannelPickerText(session.categoryId), await channelKeyboard(env, session.categoryId));
    return 'back:scope_channels';
  }

  if (session.screen === 'scope_channels') {
    await saveSession(env, chatId, { categoryId: undefined, channelId: undefined, platform: 'all', screen: 'scope_categories' });
    await sendTelegramMessage(env, chatId, buildCategoryPickerText(), await categoryKeyboard(env));
    return 'back:scope_categories';
  }

  await saveSession(env, chatId, { categoryId: undefined, channelId: undefined, platform: 'all', screen: 'scope_categories' });
  await sendTelegramMessage(env, chatId, buildCategoryPickerText(), await categoryKeyboard(env));
  return 'back:scope_categories';
}

async function sendEntry(env: Env, chatId: string | number): Promise<string> {
  const session = await loadSession(env, chatId);
  const scoped = scopedFromSession(session);

  if (scoped) {
    await saveSession(env, chatId, { ...scoped, screen: 'command_center' });
    await sendTelegramMessage(env, chatId, buildCommandCenterText(scoped), commandCenterKeyboard());
    return 'command_center';
  }

  await saveSession(env, chatId, {
    categoryId: undefined,
    channelId: undefined,
    platform: 'all',
    screen: 'scope_categories',
  });
  await sendTelegramMessage(env, chatId, buildCategoryPickerText(), await categoryKeyboard(env));
  return 'scope_categories';
}

async function requireScope(env: Env, chatId: string | number, session: AdminSession): Promise<Required<Pick<AdminSession, 'categoryId' | 'channelId' | 'platform'>> | null> {
  const scoped = scopedFromSession(session);
  if (scoped) return scoped;

  await saveSession(env, chatId, {
    categoryId: undefined,
    channelId: undefined,
    platform: 'all',
    screen: 'scope_categories',
  });
  await sendTelegramMessage(env, chatId, buildScopeRequiredText(), await categoryKeyboard(env));
  return null;
}

function scopedFromSession(session: AdminSession): Required<Pick<AdminSession, 'categoryId' | 'channelId' | 'platform'>> | null {
  if (!session.categoryId || !session.channelId) return null;
  return {
    categoryId: session.categoryId,
    channelId: session.channelId,
    platform: session.platform ?? 'all',
  };
}

async function sendReportSection(
  env: Env,
  chatId: string | number,
  section: OperationalReportSection,
  scoped: Required<Pick<AdminSession, 'categoryId' | 'channelId' | 'platform'>>,
  keyboard: object,
): Promise<void> {
  const reportUrl = new URL('https://telegram-admin.local/internal/report/ops');
  reportUrl.searchParams.set('category_id', sanitizeCallbackId(scoped.categoryId, 'crypto'));
  reportUrl.searchParams.set('channel_id', sanitizeCallbackId(scoped.channelId, 'crypto_fa_pilot'));
  reportUrl.searchParams.set('platform', sanitizeCallbackId(scoped.platform, 'all'));

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

function buildScopeRequiredText(): string {
  return [
    '📌 <b>Select Scope First</b>',
    '',
    'Choose a category and channel once. All monitoring and reporting sections will reuse that scope.',
  ].join('\n');
}

function buildCategoryPickerText(): string {
  return [
    '📂 <b>Select Category</b>',
    '',
    'Everything starts from category and channel.',
    'Future languages and channels will hang off this scope.',
  ].join('\n');
}

function buildChannelPickerText(categoryId: string): string {
  return [
    '📣 <b>Select Channel</b>',
    '',
    `<b>Category</b>: <code>${escapeHtml(categoryId)}</code>`,
    '',
    'Choose the publishing channel for this session.',
  ].join('\n');
}

function buildPlatformPickerText(scoped: Required<Pick<AdminSession, 'categoryId' | 'channelId' | 'platform'>>): string {
  return [
    '🌐 <b>Select Platform</b>',
    '',
    scopeLines(scoped),
    '',
    'Choose platform scope. Use All Platforms when the section should aggregate everything.',
  ].join('\n');
}

function buildCommandCenterText(scoped: Required<Pick<AdminSession, 'categoryId' | 'channelId' | 'platform'>>): string {
  return [
    '📊 <b>Content Command Center</b>',
    '',
    scopeLines(scoped),
    '',
    'Choose an area. The selected scope is reused everywhere until you change it.',
  ].join('\n');
}

function buildMonitoringText(scoped: Required<Pick<AdminSession, 'categoryId' | 'channelId' | 'platform'>>): string {
  return [
    '🟢 <b>Monitoring</b>',
    '',
    scopeLines(scoped),
    '',
    'Live operational checks and alerts.',
  ].join('\n');
}

function buildReportingText(scoped: Required<Pick<AdminSession, 'categoryId' | 'channelId' | 'platform'>>): string {
  return [
    '📈 <b>Reporting</b>',
    '',
    scopeLines(scoped),
    '',
    'Historical analytics for the selected scope.',
  ].join('\n');
}

function buildCostMenuText(scoped: Required<Pick<AdminSession, 'categoryId' | 'channelId' | 'platform'>>): string {
  return [
    '💸 <b>Costs</b>',
    '',
    scopeLines(scoped),
    '',
    'Costs are split by summary, providers, Apify, trends, and budget watch.',
  ].join('\n');
}

function buildAIProviderMenuText(scoped: Required<Pick<AdminSession, 'categoryId' | 'channelId' | 'platform'>>): string {
  return [
    '🤖 <b>AI Provider Costs</b>',
    '',
    scopeLines(scoped),
    '',
    'AI cost is currently global unless ai_usage is enriched with channel/category/platform fields.',
  ].join('\n');
}

function buildOperationsText(scoped: Required<Pick<AdminSession, 'categoryId' | 'channelId' | 'platform'>>): string {
  return [
    '🛠 <b>Operations</b>',
    '',
    scopeLines(scoped),
    '',
    'Read-only for now. Destructive or mutating actions require confirmation and audit logging before activation.',
  ].join('\n');
}

function buildSettingsText(scoped: Required<Pick<AdminSession, 'categoryId' | 'channelId' | 'platform'>>): string {
  return [
    '⚙️ <b>Settings</b>',
    '',
    scopeLines(scoped),
    '',
    'Configuration overview. Editing is intentionally not enabled here yet.',
  ].join('\n');
}

function buildAuditText(scoped: Required<Pick<AdminSession, 'categoryId' | 'channelId' | 'platform'>>): string {
  return [
    '🧾 <b>Audit Log</b>',
    '',
    scopeLines(scoped),
    '',
    'View audit categories. Persistent admin action history can be expanded with a dedicated audit table.',
  ].join('\n');
}

function buildHelpText(scoped: Required<Pick<AdminSession, 'categoryId' | 'channelId' | 'platform'>>): string {
  return [
    '❓ <b>Help</b>',
    '',
    scopeLines(scoped),
    '',
    '🟢 Monitoring: live health and alerts',
    '📈 Reporting: historical analytics',
    '🛠 Operations: controlled actions, currently read-only',
    '⚙️ Settings: configuration overview',
    '🧾 Audit Log: admin activity and access attempts',
    '',
    'Use 📌 Change Scope to select another category/channel/platform.',
  ].join('\n');
}

function buildOperationReadOnlyText(operation: string, scoped: Required<Pick<AdminSession, 'categoryId' | 'channelId' | 'platform'>>): string {
  return [
    '⚠️ <b>Operation Not Armed</b>',
    '',
    scopeLines(scoped),
    '',
    `<b>Requested</b>: ${escapeHtml(operation)}`,
    '',
    'This command is intentionally read-only in this patch.',
    'Next step for real operations: confirmation screen + audit record + idempotent server-side action.',
  ].join('\n');
}

function scopeLines(scoped: Required<Pick<AdminSession, 'categoryId' | 'channelId' | 'platform'>>): string {
  return [
    `<b>Category</b>: <code>${escapeHtml(scoped.categoryId)}</code>`,
    `<b>Channel</b>: <code>${escapeHtml(scoped.channelId)}</code>`,
    `<b>Platform</b>: <code>${escapeHtml(scoped.platform)}</code>`,
  ].join('\n');
}

function commandCenterKeyboard(): object {
  return replyKeyboard([
    ['🟢 Monitoring', '📈 Reporting'],
    ['🛠 Operations', '⚙️ Settings'],
    ['🧾 Audit Log', '❓ Help'],
    ['📌 Change Scope'],
  ]);
}

function monitoringKeyboard(): object {
  return replyKeyboard([
    ['🟢 Status', '📬 Queue'],
    ['🚨 Failures', '🕷 Apify Runtime'],
    ['🤖 AI Health', '💰 Cost Watch'],
    ['📡 Source Health', '⏱ Scheduler'],
    ['⬅️ Back', '🏠 Home'],
  ]);
}

function reportingKeyboard(): object {
  return replyKeyboard([
    ['📊 Overview', '🔄 Funnel'],
    ['📬 Publishing', '💸 Costs'],
    ['🏆 Sources', '🧠 AI Quality'],
    ['📰 Editorial', '📈 Market Snapshot'],
    ['🌐 Change Platform', '📌 Change Scope'],
    ['⬅️ Back', '🏠 Home'],
  ]);
}

function costMenuKeyboard(): object {
  return replyKeyboard([
    ['💸 Summary'],
    ['🤖 AI Providers', '🕷 Apify'],
    ['📊 Cost Trend', '🚨 Budget Alerts'],
    ['⬅️ Back', '📈 Reporting'],
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

function operationsKeyboard(): object {
  return replyKeyboard([
    ['🧠 Drain Backlog', '🔁 Retry Failed'],
    ['📬 Publish Due', '📈 Force Snapshot'],
    ['🕷 Run Apify Rotation', '🧹 Cleanup Queue'],
    ['⏸ Pause Publishing', '▶️ Resume Publishing'],
    ['⬅️ Back', '🏠 Home'],
  ]);
}

function settingsKeyboard(): object {
  return replyKeyboard([
    ['📣 Channels', '🌐 Platforms'],
    ['📡 Sources', '💰 Budgets'],
    ['⏱ Schedules', '🤖 AI Limits'],
    ['👥 Admin Access'],
    ['⬅️ Back', '🏠 Home'],
  ]);
}

function auditKeyboard(): object {
  return replyKeyboard([
    ['👁 Views', '🛠 Operation Events'],
    ['🚨 Error Events', '🔐 Access Denied'],
    ['⬅️ Back', '🏠 Home'],
  ]);
}

function helpKeyboard(): object {
  return replyKeyboard([
    ['📎 Current Scope', '📖 Button Guide'],
    ['🆘 Troubleshooting'],
    ['⬅️ Back', '🏠 Home'],
  ]);
}

async function categoryKeyboard(env: Env): Promise<object> {
  const rows = await safeAll<{ category_id: string }>(env, `
    SELECT DISTINCT category_id
    FROM (
      SELECT category_id FROM channels WHERE enabled=1
      UNION
      SELECT category_id FROM source_accounts WHERE enabled=1
      UNION
      SELECT category_id FROM apify_sources WHERE enabled=1
      UNION
      SELECT category_id FROM discovery_runs
      UNION
      SELECT category_id FROM discovery_items
    )
    WHERE category_id IS NOT NULL
      AND category_id != ''
    ORDER BY category_id
    LIMIT 20
  `);

  const categories = rows.map(row => row.category_id).filter(Boolean);
  const unique = categories.length > 0 ? categories : ['crypto'];

  return replyKeyboard([
    ...unique.map(category => [`📂 ${category}`]),
    ['🏠 Home'],
  ]);
}

async function channelKeyboard(env: Env, categoryId: string): Promise<object> {
  const rows = await safeAll<ChannelRow>(env, `
    SELECT id, category_id
    FROM channels
    WHERE enabled=1
      AND category_id=?
    ORDER BY id
    LIMIT 20
  `, [categoryId]);

  const channels = rows.length > 0 ? rows : [{ id: 'crypto_fa_pilot', category_id: categoryId }];
  return replyKeyboard([
    ...channels.map(row => [`📣 ${row.id}`]),
    ['⬅️ Back', '📂 Change Category'],
    ['🏠 Home'],
  ]);
}

async function platformKeyboard(env: Env, categoryId: string, channelId: string): Promise<object> {
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
    ['📌 Change Scope', '🏠 Home'],
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

function parseCategoryButton(text: string): string | null {
  if (!text.startsWith('📂 ')) return null;
  return sanitizeCallbackId(text.slice('📂 '.length).trim(), 'crypto');
}

function parsePlatformButton(text: string): string | null {
  if (text === '🌐 All Platforms') return 'all';
  if (text === '𝕏 X / Twitter') return 'x';
  if (text === '📸 Instagram') return 'instagram';
  if (text === '💼 LinkedIn') return 'linkedin';
  if (text.startsWith('🌐 ')) return sanitizeCallbackId(text.slice('🌐 '.length).trim(), 'all');
  return null;
}

function parseMonitoringButton(text: string): OperationalReportSection | null {
  const map: Record<string, OperationalReportSection> = {
    '🟢 Status': 'monitoring_status',
    '📬 Queue': 'queue_health',
    '🚨 Failures': 'failures',
    '🕷 Apify Runtime': 'apify',
    '🤖 AI Health': 'monitoring_ai',
    '💰 Cost Watch': 'cost_watch',
    '📡 Source Health': 'source_health',
    '⏱ Scheduler': 'scheduler',
  };
  return map[text] ?? null;
}

function parseReportingButton(text: string): OperationalReportSection | null {
  const normalized = text.replace(/^●\s*/, '').trim();
  const map: Record<string, OperationalReportSection> = {
    '📊 Overview': 'overview',
    '🔄 Funnel': 'pipeline',
    '📬 Publish': 'publish',
    '📬 Publishing': 'publish',
    '🏆 Sources': 'sources',
    '🧠 AI Quality': 'ai_quality',
    '📰 Editorial': 'editorial',
    '📈 Market Snapshot': 'market_snapshot',
  };
  return map[normalized] ?? null;
}

function parseCostSectionButton(text: string): OperationalReportSection | null {
  const normalized = text.replace(/^●\s*/, '').trim();
  const map: Record<string, OperationalReportSection> = {
    '💸 Summary': 'costs',
    '🟣 Anthropic': 'costs_anthropic',
    '🔵 Gemini': 'costs_gemini',
    '🕷 Apify': 'costs_apify',
    '📊 Cost Trend': 'cost_trend',
    '🚨 Budget Alerts': 'budget_alerts',
  };
  return map[normalized] ?? null;
}

function parseOperationButton(text: string): string | null {
  const map: Record<string, string> = {
    '🧠 Drain Backlog': 'Drain AI Backlog',
    '🔁 Retry Failed': 'Retry Failed Runs',
    '📬 Publish Due': 'Publish Due Now',
    '📈 Force Snapshot': 'Force Market Snapshot',
    '🕷 Run Apify Rotation': 'Run Apify Rotation',
    '🧹 Cleanup Queue': 'Cleanup Old Queue',
    '⏸ Pause Publishing': 'Pause Publishing',
    '▶️ Resume Publishing': 'Resume Publishing',
  };
  return map[text] ?? null;
}

function parseSettingsButton(text: string, session: AdminSession): string | null {
  const scoped = scopedFromSession(session);
  const scope = scoped ? scopeLines(scoped) : 'No scope selected.';

  const map: Record<string, string> = {
    '📣 Channels': ['📣 <b>Channels</b>', '', scope, '', 'Current channel scope is session-based. Use 📌 Change Scope to switch category/channel.'].join('\n'),
    '🌐 Platforms': ['🌐 <b>Platforms</b>', '', scope, '', 'Platform scope can be All Platforms or a specific source platform.'].join('\n'),
    '📡 Sources': ['📡 <b>Sources</b>', '', scope, '', 'Source health and source rotation are available under Monitoring. Editing sources is intentionally not enabled in Telegram.'].join('\n'),
    '💰 Budgets': ['💰 <b>Budgets</b>', '', scope, '', 'Budget thresholds are not persisted yet. Use Cost Watch and Budget Alerts as read-only previews.'].join('\n'),
    '⏱ Schedules': ['⏱ <b>Schedules</b>', '', scope, '', 'Cron, publishing, backlog drain, market snapshot, and Apify rotation are monitored from existing runtime config.'].join('\n'),
    '🤖 AI Limits': ['🤖 <b>AI Limits</b>', '', scope, '', 'AI limits are configured through Worker environment variables. Telegram editing is not enabled.'].join('\n'),
    '👥 Admin Access': ['👥 <b>Admin Access</b>', '', `Your selected scope:\n${scope}`, '', 'Access is controlled by TELEGRAM_ADMIN_ALLOWED_USER_IDS. Add/remove users outside Telegram until audit-backed writes exist.'].join('\n'),
    '📎 Current Scope': ['📎 <b>Current Scope</b>', '', scope].join('\n'),
    '📖 Button Guide': ['📖 <b>Button Guide</b>', '', 'Start with category/channel/platform. Then use Monitoring for live status, Reporting for analysis, Operations for read-only action previews, Settings for config overview.'].join('\n'),
    '🆘 Troubleshooting': ['🆘 <b>Troubleshooting</b>', '', 'If the bot opens the wrong section, use 📌 Change Scope. If reports are stale, check Scheduler and Failures under Monitoring.'].join('\n'),
  };

  return map[text] ?? null;
}

function parseAuditButton(text: string): string | null {
  const map: Record<string, string> = {
    '👁 Views': ['👁 <b>View Events</b>', '', 'Read-only placeholder. Add a persistent audit table to list recent admin views.'].join('\n'),
    '🛠 Operation Events': ['🛠 <b>Operation Events</b>', '', 'Operations are currently read-only. Real operations must record actor, scope, operation, confirmation, and result.'].join('\n'),
    '🚨 Error Events': ['🚨 <b>Error Events</b>', '', 'Use Monitoring → Failures for current pipeline errors. Persistent admin error audit can be added later.'].join('\n'),
    '🔐 Access Denied': ['🔐 <b>Access Denied</b>', '', 'Unauthorized attempts are logged to Worker logs. Persistent audit storage can be added with a dedicated table.'].join('\n'),
  };
  return map[text] ?? null;
}

function platformLabel(platform: string): string {
  const p = String(platform).toLowerCase();
  if (p === 'x' || p === 'twitter') return '𝕏 X / Twitter';
  if (p === 'instagram') return '📸 Instagram';
  if (p === 'linkedin') return '💼 LinkedIn';
  return `🌐 ${platform}`;
}

async function getChannelCategory(env: Env, channelId: string): Promise<string | null> {
  const row = await safeFirst<{ category_id: string } | null>(env, `
    SELECT category_id
    FROM channels
    WHERE id=?
      AND enabled=1
    LIMIT 1
  `, [channelId], null);

  return row?.category_id ?? null;
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
  const next = {
    ...current,
    ...patch,
  };

  for (const key of ['categoryId', 'channelId', 'platform', 'screen'] as const) {
    if (Object.prototype.hasOwnProperty.call(patch, key) && patch[key] === undefined) {
      delete next[key];
    }
  }

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

async function recordAdminAudit(
  env: Env,
  actorId: number | null,
  action: string,
  scope: unknown,
  result: string,
): Promise<void> {
  try {
    await env.DB.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value=excluded.value,
        updated_at=CURRENT_TIMESTAMP
    `).bind(
      `telegram_admin:last_audit:${actorId ?? 'unknown'}`,
      JSON.stringify({
        actor_id: actorId,
        action,
        scope,
        result,
        at: new Date().toISOString(),
      }),
    ).run();
  } catch {
    // Audit is best-effort and must never break the admin bot.
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
