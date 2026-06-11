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
  | 'reports'
  | 'costs'
  | 'ai_costs'
  | 'settings'
  | 'help';

type AdminSession = {
  categoryId?: string;
  channelId?: string;
  platform?: string;
  screen?: AdminScreen;
};

type ScopedSession = {
  categoryId: string;
  channelId: string;
  platform: string;
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

    await startScopeSelection(env, chatId);
    return Response.json({ ok: true, handled: 'scope_categories' });
  }

  if (text === '/scope' || text === '🧭 Switch Channel / Platform' || text === '📌 Change Scope' || text === '📂 Change Category') {
    await startScopeSelection(env, chatId);
    return Response.json({ ok: true, handled: 'scope_categories' });
  }

  if (text === '/menu' || text === '🏠 Home') {
    const handled = await sendCommandCenterOrScope(env, chatId);
    return Response.json({ ok: true, handled });
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
      await startScopeSelection(env, chatId);
      return Response.json({ ok: true, handled: 'scope_categories' });
    }

    await saveSession(env, chatId, {
      channelId: undefined,
      platform: 'all',
      screen: 'scope_channels',
    });
    await sendTelegramMessage(env, chatId, buildChannelPickerText(session.categoryId), await channelKeyboard(env, session.categoryId));
    return Response.json({ ok: true, handled: 'scope_channels' });
  }

  if (text === '🌐 Change Platform') {
    const scoped = await requireScope(env, chatId);
    if (!scoped) return Response.json({ ok: true, handled: 'scope_required' });

    await saveSession(env, chatId, { screen: 'scope_platforms' });
    await sendTelegramMessage(env, chatId, buildPlatformPickerText(scoped), await platformKeyboard(env, scoped.categoryId));
    return Response.json({ ok: true, handled: 'scope_platforms' });
  }

  if (text.startsWith('📣 ')) {
    const channelId = sanitizeCallbackId(text.slice('📣 '.length).trim(), 'crypto_fa_pilot');
    const session = await loadSession(env, chatId);
    const categoryIdForChannel = await getChannelCategory(env, channelId) ?? session.categoryId ?? 'crypto';

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
      await platformKeyboard(env, categoryIdForChannel),
    );
    return Response.json({ ok: true, handled: 'scope_platforms' });
  }

  const platform = parsePlatformButton(text);
  if (platform) {
    const session = await loadSession(env, chatId);
    const scoped = completeScope({ ...session, platform });

    if (!scoped) {
      await startScopeSelection(env, chatId);
      return Response.json({ ok: true, handled: 'scope_required' });
    }

    await saveSession(env, chatId, { ...scoped, screen: 'command_center' });
    await sendTelegramMessage(env, chatId, buildCommandCenterText(scoped), commandCenterKeyboard());
    return Response.json({ ok: true, handled: 'command_center' });
  }

  if (text === '🟢 Monitoring') {
    const scoped = await requireScope(env, chatId);
    if (!scoped) return Response.json({ ok: true, handled: 'scope_required' });

    await saveSession(env, chatId, { ...scoped, screen: 'monitoring' });
    await sendTelegramMessage(env, chatId, buildMonitoringText(scoped), monitoringKeyboard());
    return Response.json({ ok: true, handled: 'monitoring' });
  }

  if (text === '📈 Reporting' || text === '/report' || text === '/ops' || text === '📊 Open Reports' || text === '📊 Reports') {
    const scoped = await requireScope(env, chatId);
    if (!scoped) return Response.json({ ok: true, handled: 'scope_required' });

    await saveSession(env, chatId, { ...scoped, screen: 'reports' });
    await sendTelegramMessage(env, chatId, buildReportSectionsText(scoped), reportSectionKeyboard());
    return Response.json({ ok: true, handled: 'reports' });
  }

  if (text === '⚙️ Settings') {
    const scoped = await requireScope(env, chatId);
    if (!scoped) return Response.json({ ok: true, handled: 'scope_required' });

    await saveSession(env, chatId, { ...scoped, screen: 'settings' });
    await sendTelegramMessage(env, chatId, buildSettingsText(scoped), settingsKeyboard());
    return Response.json({ ok: true, handled: 'settings' });
  }

  if (text === '❓ Help') {
    const scoped = await requireScope(env, chatId);
    if (!scoped) return Response.json({ ok: true, handled: 'scope_required' });

    await saveSession(env, chatId, { ...scoped, screen: 'help' });
    await sendTelegramMessage(env, chatId, buildHelpText(scoped), helpKeyboard());
    return Response.json({ ok: true, handled: 'help' });
  }

  const settingsDetailText = await buildSettingsDetailText(env, text, await loadSession(env, chatId));
  if (settingsDetailText) {
    const scoped = await requireScope(env, chatId);
    if (!scoped) return Response.json({ ok: true, handled: 'scope_required' });

    await saveSession(env, chatId, { ...scoped, screen: 'settings' });
    await sendTelegramMessage(env, chatId, settingsDetailText, settingsKeyboard());
    return Response.json({ ok: true, handled: 'settings_detail' });
  }

  const helpDetailText = buildHelpDetailText(text, completeScope(await loadSession(env, chatId)));
  if (helpDetailText) {
    const scoped = await requireScope(env, chatId);
    if (!scoped) return Response.json({ ok: true, handled: 'scope_required' });

    await saveSession(env, chatId, { ...scoped, screen: 'help' });
    await sendTelegramMessage(env, chatId, helpDetailText, helpKeyboard());
    return Response.json({ ok: true, handled: 'help_detail' });
  }

  const monitoringSection = parseMonitoringButton(text);
  if (monitoringSection) {
    const scoped = await requireScope(env, chatId);
    if (!scoped) return Response.json({ ok: true, handled: 'scope_required' });

    await saveSession(env, chatId, { ...scoped, screen: 'monitoring' });
    await sendReportSection(env, chatId, monitoringSection, scoped, monitoringKeyboard());
    return Response.json({ ok: true, handled: `monitoring:${monitoringSection}` });
  }

  const monitoringDetail = parseMonitoringDetailButton(text);
  if (monitoringDetail) {
    const scoped = await requireScope(env, chatId);
    if (!scoped) return Response.json({ ok: true, handled: 'scope_required' });

    const report = await buildScopedOperationalReport(env, scoped);
    await saveSession(env, chatId, { ...scoped, screen: 'monitoring' });
    await sendTelegramMessage(env, chatId, buildMonitoringDetailText(monitoringDetail, report, scoped), monitoringKeyboard());
    return Response.json({ ok: true, handled: `monitoring:${monitoringDetail}` });
  }

  if (text === '💸 Costs') {
    const scoped = await requireScope(env, chatId);
    if (!scoped) return Response.json({ ok: true, handled: 'scope_required' });

    await saveSession(env, chatId, { ...scoped, screen: 'costs' });
    await sendTelegramMessage(env, chatId, buildCostMenuText(scoped), costMenuKeyboard());
    return Response.json({ ok: true, handled: 'costs_menu' });
  }

  if (text === '🤖 AI Providers') {
    const scoped = await requireScope(env, chatId);
    if (!scoped) return Response.json({ ok: true, handled: 'scope_required' });

    await saveSession(env, chatId, { ...scoped, screen: 'costs' });
    await sendTelegramMessage(env, chatId, buildCostMenuText(scoped), costMenuKeyboard());
    return Response.json({ ok: true, handled: 'costs_menu' });
  }

  const costSection = parseCostSectionButton(text);
  if (costSection) {
    const scoped = await requireScope(env, chatId);
    if (!scoped) return Response.json({ ok: true, handled: 'scope_required' });

    await saveSession(env, chatId, { ...scoped, screen: 'costs' });
    await sendReportSection(env, chatId, costSection, scoped, costMenuKeyboard());
    return Response.json({ ok: true, handled: `report:${costSection}` });
  }

  const section = parseSectionButton(text);
  if (section) {
    const scoped = await requireScope(env, chatId);
    if (!scoped) return Response.json({ ok: true, handled: 'scope_required' });

    await saveSession(env, chatId, { ...scoped, screen: 'reports' });
    await sendReportSection(env, chatId, section, scoped, reportSectionKeyboard());
    return Response.json({ ok: true, handled: `report:${section}` });
  }

  const reportingDetail = parseReportingDetailButton(text);
  if (reportingDetail) {
    const scoped = await requireScope(env, chatId);
    if (!scoped) return Response.json({ ok: true, handled: 'scope_required' });

    const report = await buildScopedOperationalReport(env, scoped);
    await saveSession(env, chatId, { ...scoped, screen: 'reports' });
    await sendTelegramMessage(env, chatId, buildReportingDetailText(reportingDetail, report, scoped, env), reportSectionKeyboard());
    return Response.json({ ok: true, handled: `report:${reportingDetail}` });
  }

  const handled = await sendCommandCenterOrScope(env, chatId);
  return Response.json({ ok: true, handled: `fallback_${handled}` });
}

async function handleLegacyCallback(env: Env, chatId: string | number, callbackData: string): Promise<void> {
  if (callbackData === 'home') {
    await sendCommandCenterOrScope(env, chatId);
    return;
  }

  if (callbackData === 'channels' || callbackData === 'report:menu') {
    await startScopeSelection(env, chatId);
    return;
  }

  if (callbackData.startsWith('channel:')) {
    const channelId = sanitizeCallbackId(callbackData.slice('channel:'.length), 'crypto_fa_pilot');
    const categoryId = await getChannelCategory(env, channelId) ?? 'crypto';

    await saveSession(env, chatId, { categoryId, channelId, platform: 'all', screen: 'scope_platforms' });
    await sendTelegramMessage(env, chatId, buildPlatformPickerText({ categoryId, channelId, platform: 'all' }), await platformKeyboard(env, categoryId));
    return;
  }

  if (callbackData.startsWith('reports:')) {
    const [, channelId = 'crypto_fa_pilot', platform = 'all'] = callbackData.split(':');
    const categoryId = await getChannelCategory(env, channelId) ?? 'crypto';
    const scoped = { categoryId, channelId, platform };
    await saveSession(env, chatId, { ...scoped, screen: 'reports' });
    await sendReportSection(env, chatId, 'overview', scoped, reportSectionKeyboard());
    return;
  }

  if (callbackData.startsWith('report:')) {
    const [, sectionRaw, channelId = 'crypto_fa_pilot', platform = 'all'] = callbackData.split(':');
    const categoryId = await getChannelCategory(env, channelId) ?? 'crypto';
    const section = normalizeOperationalReportSection(sectionRaw);
    const scoped = { categoryId, channelId, platform };
    await saveSession(env, chatId, { ...scoped, screen: 'reports' });
    await sendReportSection(env, chatId, section, scoped, reportSectionKeyboard());
    return;
  }

  await sendCommandCenterOrScope(env, chatId);
}

async function handleBack(env: Env, chatId: string | number): Promise<string> {
  const session = await loadSession(env, chatId);
  const scoped = completeScope(session);

  if (session.screen === 'ai_costs' && scoped) {
    await saveSession(env, chatId, { ...scoped, screen: 'costs' });
    await sendTelegramMessage(env, chatId, buildCostMenuText(scoped), costMenuKeyboard());
    return 'back:costs';
  }

  if (session.screen === 'costs' && scoped) {
    await saveSession(env, chatId, { ...scoped, screen: 'reports' });
    await sendTelegramMessage(env, chatId, buildReportSectionsText(scoped), reportSectionKeyboard());
    return 'back:reports';
  }

  if (session.screen === 'reports' && scoped) {
    await saveSession(env, chatId, { ...scoped, screen: 'command_center' });
    await sendTelegramMessage(env, chatId, buildCommandCenterText(scoped), commandCenterKeyboard());
    return 'back:command_center';
  }

  if (session.screen === 'monitoring' && scoped) {
    await saveSession(env, chatId, { ...scoped, screen: 'command_center' });
    await sendTelegramMessage(env, chatId, buildCommandCenterText(scoped), commandCenterKeyboard());
    return 'back:command_center';
  }

  if ((session.screen === 'settings' || session.screen === 'help') && scoped) {
    await saveSession(env, chatId, { ...scoped, screen: 'command_center' });
    await sendTelegramMessage(env, chatId, buildCommandCenterText(scoped), commandCenterKeyboard());
    return 'back:command_center';
  }

  if (session.screen === 'scope_platforms' && session.categoryId) {
    await saveSession(env, chatId, { screen: 'scope_channels' });
    await sendTelegramMessage(env, chatId, buildChannelPickerText(session.categoryId), await channelKeyboard(env, session.categoryId));
    return 'back:scope_channels';
  }

  if (session.screen === 'scope_channels') {
    await startScopeSelection(env, chatId);
    return 'back:scope_categories';
  }

  if (scoped) {
    await saveSession(env, chatId, { ...scoped, screen: 'command_center' });
    await sendTelegramMessage(env, chatId, buildCommandCenterText(scoped), commandCenterKeyboard());
    return 'back:command_center';
  }

  await startScopeSelection(env, chatId);
  return 'back:scope_categories';
}

async function startScopeSelection(env: Env, chatId: string | number): Promise<void> {
  await saveSession(env, chatId, {
    categoryId: undefined,
    channelId: undefined,
    platform: 'all',
    screen: 'scope_categories',
  });
  await sendTelegramMessage(env, chatId, buildCategoryPickerText(), await categoryKeyboard(env));
}

async function sendCommandCenterOrScope(env: Env, chatId: string | number): Promise<'command_center' | 'scope_categories'> {
  const scoped = completeScope(await loadSession(env, chatId));
  if (!scoped) {
    await startScopeSelection(env, chatId);
    return 'scope_categories';
  }

  await saveSession(env, chatId, { ...scoped, screen: 'command_center' });
  await sendTelegramMessage(env, chatId, buildCommandCenterText(scoped), commandCenterKeyboard());
  return 'command_center';
}

async function requireScope(env: Env, chatId: string | number): Promise<ScopedSession | null> {
  const scoped = completeScope(await loadSession(env, chatId));
  if (scoped) return scoped;

  await startScopeSelection(env, chatId);
  return null;
}

async function sendReportSection(
  env: Env,
  chatId: string | number,
  section: OperationalReportSection,
  scope: ScopedSession,
  keyboard: object = reportSectionKeyboard(),
): Promise<void> {
  const reportUrl = new URL('https://telegram-admin.local/internal/report/ops');
  reportUrl.searchParams.set('category_id', sanitizeCallbackId(scope.categoryId, 'crypto'));
  reportUrl.searchParams.set('channel_id', sanitizeCallbackId(scope.channelId, 'crypto_fa_pilot'));
  reportUrl.searchParams.set('platform', sanitizeCallbackId(scope.platform, 'all'));

  const report = await buildOperationalReport(env, reportUrl);
  const text = formatOperationalReportForTelegram(report as any, section);
  await sendTelegramMessage(env, chatId, text, keyboard);
}

async function buildScopedOperationalReport(env: Env, scope: ScopedSession): Promise<any> {
  const reportUrl = new URL('https://telegram-admin.local/internal/report/ops');
  reportUrl.searchParams.set('category_id', sanitizeCallbackId(scope.categoryId, 'crypto'));
  reportUrl.searchParams.set('channel_id', sanitizeCallbackId(scope.channelId, 'crypto_fa_pilot'));
  reportUrl.searchParams.set('platform', sanitizeCallbackId(scope.platform, 'all'));

  return await buildOperationalReport(env, reportUrl);
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

function buildCategoryPickerText(): string {
  return [
    '📂 <b>Select Category</b>',
    '',
    'Choose the content category first. Channel and platform will use this scope.',
  ].join('\n');
}

function buildChannelPickerText(categoryId: string): string {
  return [
    '📣 <b>Select Channel</b>',
    '',
    `<b>Category</b>: ${escapeHtml(categoryId)}`,
    '',
    'Choose a publishing channel.',
  ].join('\n');
}

function buildPlatformPickerText(scope: { categoryId: string; channelId: string; platform?: string }): string {
  return [
    '🌐 <b>Select Platform</b>',
    '',
    `<b>Category</b>: ${escapeHtml(scope.categoryId)}`,
    `<b>Channel</b>: ${escapeHtml(scope.channelId)}`,
    '',
    'Choose a platform.',
  ].join('\n');
}

function buildCommandCenterText(scope: ScopedSession): string {
  return [
    '📊 <b>Content Command Center</b>',
    '',
    scopeLine(scope),
    '',
    'Choose an area. The selected scope will be reused until you change it.',
  ].join('\n');
}

function buildMonitoringText(scope: ScopedSession): string {
  return [
    '🟢 <b>Monitoring</b>',
    '',
    scopeLine(scope),
    '',
    'Live operational checks and alerts.',
  ].join('\n');
}

function buildReportSectionsText(scope: ScopedSession): string {
  return [
    '📈 <b>Reporting</b>',
    '',
    scopeLine(scope),
    '',
    'Choose a report category.',
  ].join('\n');
}

function buildCostMenuText(scope: ScopedSession): string {
  return [
    '💸 <b>Costs</b>',
    '',
    scopeLine(scope),
    '',
    'Costs are grouped so the keyboard stays readable.',
  ].join('\n');
}

function buildAIProviderMenuText(scope: ScopedSession): string {
  return [
    '🤖 <b>AI Provider Costs</b>',
    '',
    scopeLine(scope),
    '',
    'AI cost is currently global, not scoped to this channel.',
  ].join('\n');
}

function buildSettingsText(scope: ScopedSession): string {
  return [
    '⚙️ <b>Settings</b>',
    '',
    scopeLine(scope),
    '',
    'Read-only configuration overview for the selected scope.',
  ].join('\n');
}

function buildHelpText(scope: ScopedSession): string {
  return [
    '❓ <b>Help</b>',
    '',
    scopeLine(scope),
    '',
    'Use this area to understand the current scope and button behavior.',
  ].join('\n');
}

async function buildSettingsDetailText(env: Env, text: string, session: AdminSession): Promise<string | null> {
  const scoped = completeScope(session);
  if (!scoped) return null;

  if (text === '🧩 Channel Config') return buildChannelConfigText(env, scoped);
  if (text === '🌐 Platform Scope') return buildPlatformScopeText(scoped);
  if (text === '📡 Sources Config') return buildSourcesConfigText(env, scoped);
  if (text === '⏱ Schedule Config') return buildScheduleConfigText(env, scoped);
  if (text === '👥 Admin Access') return buildAdminAccessText(env);

  return null;
}

async function buildChannelConfigText(env: Env, scope: ScopedSession): Promise<string> {
  const row = await safeFirst<any>(env, `
    SELECT id, category_id, enabled, max_per_day, max_per_hour, min_gap_minutes
    FROM channels
    WHERE id=?
    LIMIT 1
  `, [scope.channelId], null);

  return [
    '🧩 <b>Channel Config</b>',
    '',
    scopeLine(scope),
    '',
    `- id: <code>${escapeHtml(row?.id ?? scope.channelId)}</code>`,
    `- category: <code>${escapeHtml(row?.category_id ?? scope.categoryId)}</code>`,
    `- enabled: <b>${formatBool(row?.enabled)}</b>`,
    `- max/day: <b>${formatOptional(row?.max_per_day)}</b>`,
    `- max/hour: <b>${formatOptional(row?.max_per_hour)}</b>`,
    `- min gap: <b>${formatOptional(row?.min_gap_minutes)} min</b>`,
  ].join('\n');
}

function buildPlatformScopeText(scope: ScopedSession): string {
  return [
    '🌐 <b>Platform Scope</b>',
    '',
    scopeLine(scope),
    '',
    `- category: <code>${escapeHtml(scope.categoryId)}</code>`,
    `- channel: <code>${escapeHtml(scope.channelId)}</code>`,
    `- platform: <code>${escapeHtml(scope.platform)}</code>`,
    '',
    'Use <b>🧭 Switch Channel / Platform</b> to switch category, channel, or platform.',
  ].join('\n');
}

async function buildSourcesConfigText(env: Env, scope: ScopedSession): Promise<string> {
  const platformFilter = scope.platform === 'all' ? '' : ' AND platform=?';
  const binds = scope.platform === 'all' ? [scope.categoryId] : [scope.categoryId, scope.platform];

  const sourceRows = await safeAll<{ platform: string; count: number }>(env, `
    SELECT platform, COUNT(*) AS count
    FROM source_accounts
    WHERE enabled=1
      AND category_id=?
      ${platformFilter}
    GROUP BY platform
    ORDER BY platform
  `, binds);

  const apifyRows = await safeAll<{ platform: string; count: number }>(env, `
    SELECT platform, COUNT(*) AS count
    FROM apify_sources
    WHERE enabled=1
      AND category_id=?
      ${platformFilter}
    GROUP BY platform
    ORDER BY platform
  `, binds);

  const lines = [
    '📡 <b>Sources Config</b>',
    '',
    scopeLine(scope),
    '',
    '<b>Source accounts</b>',
  ];

  if (sourceRows.length === 0) {
    lines.push('- none found');
  } else {
    for (const row of sourceRows) {
      lines.push(`- ${escapeHtml(row.platform)}: <b>${int(row.count)}</b>`);
    }
  }

  lines.push('');
  lines.push('<b>Apify sources</b>');

  if (apifyRows.length === 0) {
    lines.push('- none found');
  } else {
    for (const row of apifyRows) {
      lines.push(`- ${escapeHtml(row.platform)}: <b>${int(row.count)}</b>`);
    }
  }

  return lines.join('\n');
}

async function buildScheduleConfigText(env: Env, scope: ScopedSession): Promise<string> {
  const row = await safeFirst<any>(env, `
    SELECT id, max_per_day, max_per_hour, min_gap_minutes
    FROM channels
    WHERE id=?
    LIMIT 1
  `, [scope.channelId], null);

  return [
    '⏱ <b>Schedule Config</b>',
    '',
    scopeLine(scope),
    '',
    `- max/day: <b>${formatOptional(row?.max_per_day)}</b>`,
    `- max/hour: <b>${formatOptional(row?.max_per_hour)}</b>`,
    `- min gap: <b>${formatOptional(row?.min_gap_minutes)} min</b>`,
    '',
    'This is read-only in the bot.',
  ].join('\n');
}

function buildAdminAccessText(env: Env): string {
  const allowed = env.TELEGRAM_ADMIN_ALLOWED_USER_IDS
    ?.split(',')
    .map(x => x.trim())
    .filter(Boolean) ?? [];

  return [
    '👥 <b>Admin Access</b>',
    '',
    `- allowlist users: <b>${allowed.length}</b>`,
    '- mode: <b>allowlist</b>',
    '',
    'User changes are not supported from Telegram in this phase.',
  ].join('\n');
}

function buildHelpDetailText(text: string, scope: ScopedSession | null): string | null {
  if (text === '📎 Current Scope') {
    if (!scope) return null;
    return [
      '📎 <b>Current Scope</b>',
      '',
      scopeLine(scope),
      '',
      'All Monitoring, Reporting, and Cost views reuse this scope.',
    ].join('\n');
  }

  if (text === '📖 Button Guide') {
    return [
      '📖 <b>Button Guide</b>',
      '',
      '- <b>🧭 Switch Channel / Platform</b>: choose category, channel, and platform again.',
      '- <b>🟢 Monitoring</b>: live operational state.',
      '- <b>📈 Reporting</b>: historical and analytical views.',
      '- <b>⚙️ Settings</b>: read-only configuration overview.',
    ].join('\n');
  }

  if (text === '🆘 Troubleshooting') {
    return [
      '🆘 <b>Troubleshooting</b>',
      '',
      '- If data looks wrong, use <b>🧭 Switch Channel / Platform</b> first.',
      '- If buttons feel stale, send <code>/start</code>.',
      '- If access is denied, copy the Telegram user_id shown by the bot.',
    ].join('\n');
  }

  return null;
}

function scopeLine(scope: ScopedSession): string {
  return `<b>Scope</b>: ${escapeHtml(scope.categoryId)} · ${escapeHtml(scope.channelId)} · ${escapeHtml(scope.platform)}`;
}

function commandCenterKeyboard(): object {
  return replyKeyboard([
    ['🟢 Monitoring', '📈 Reporting'],
    ['⚙️ Settings', '❓ Help'],
    ['🧭 Switch Channel / Platform'],
  ]);
}

function settingsKeyboard(): object {
  return replyKeyboard([
    ['🧩 Channel Config', '🌐 Platform Scope'],
    ['📡 Sources Config', '⏱ Schedule Config'],
    ['👥 Admin Access'],
    ['⬅️ Back'],
    ['🏠 Home'],
  ]);
}

function helpKeyboard(): object {
  return replyKeyboard([
    ['📎 Current Scope', '📖 Button Guide'],
    ['🆘 Troubleshooting'],
    ['⬅️ Back', '🏠 Home'],
  ]);
}

function monitoringKeyboard(): object {
  return replyKeyboard([
    ['🟢 Status', '📬 Queue'],
    ['🚨 Failures', '🕷 Apify Runtime'],
    ['🤖 AI Health', '💰 Cost Watch'],
    ['📡 Source Health', '⏱ Scheduler'],
    ['⬅️ Back'],
    ['🏠 Home'],
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
    ...unique.map(categoryId => [`📂 ${categoryId}`]),
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

  const channels = rows.length > 0 ? rows : [{ id: 'crypto_fa_pilot', category_id: 'crypto' }];
  return replyKeyboard([
    ...channels.map(row => [`📣 ${row.id}`]),
    ['⬅️ Back', '📂 Change Category'],
    ['🏠 Home'],
  ]);
}

async function platformKeyboard(env: Env, categoryId: string): Promise<object> {
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
    ['🧾 Channel Audit'],
    ['📊 Overview', '💸 Costs'],
    ['🔄 Funnel', '📬 Publishing'],
    ['🩺 System', '🏆 Sources'],
    ['🧠 AI Quality', '📰 Editorial'],
    ['📈 Market Snapshot'],
    ['⬅️ Back'],
    ['🏠 Home'],
  ]);
}

function costMenuKeyboard(): object {
  return replyKeyboard([
    ['💸 Summary'],
    ['🟣 Anthropic', '🔵 Gemini'],
    ['🕷 Apify'],
    ['⬅️ Back'],
    ['🏠 Home'],
  ]);
}

function aiProviderCostKeyboard(): object {
  return replyKeyboard([
    ['🟣 Anthropic', '🔵 Gemini'],
    ['⬅️ Back'],
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

function parseCategoryButton(text: string): string | null {
  if (!text.startsWith('📂 ')) return null;
  const raw = text.slice('📂 '.length).trim();
  if (raw === 'Change Category') return null;
  return sanitizeCallbackId(raw, '');
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

type MonitoringDetail = 'ai_health' | 'source_health' | 'scheduler';

function parseMonitoringDetailButton(text: string): MonitoringDetail | null {
  const map: Record<string, MonitoringDetail> = {
    '🤖 AI Health': 'ai_health',
    '📡 Source Health': 'source_health',
    '⏱ Scheduler': 'scheduler',
  };
  return map[text] ?? null;
}

function buildMonitoringDetailText(detail: MonitoringDetail, report: any, scope: ScopedSession): string {
  if (detail === 'ai_health') return buildAIHealthText(report, scope);
  if (detail === 'source_health') return buildSourceHealthText(report, scope);
  return buildSchedulerText(report, scope);
}

function buildAIHealthText(report: any, scope: ScopedSession): string {
  const w24 = findWindow(report, '24h');
  const w7 = findWindow(report, '7d');
  const stats24 = aiStats(allAIRows(w24));
  const stats7 = aiStats(allAIRows(w7));

  const lines = [
    '🤖 <b>AI Health</b>',
    '',
    scopeLine(scope),
    '',
    'AI cost scope: global',
    '',
    '📌 <b>Summary</b>',
    `- 24h: <b>${usd(stats24.cost)}</b> · calls <b>${int(stats24.calls)}</b>`,
    `- 7d: <b>${usd(stats7.cost)}</b> · calls <b>${int(stats7.calls)}</b>`,
    `- 7d tokens: in <b>${int(stats7.inputTokens)}</b> · out <b>${int(stats7.outputTokens)}</b>`,
    '',
    '🧾 <b>Providers 24h</b>',
  ];

  appendProviderStatLine(lines, 'Anthropic', aiStats(providerRows(w24, 'anthropic')));
  appendProviderStatLine(lines, 'Gemini', aiStats(providerRows(w24, 'gemini')));

  lines.push('');
  lines.push('Failures: not available in the current ai_usage summary.');

  return lines.join('\n');
}

function buildSourceHealthText(report: any, scope: ScopedSession): string {
  const window = findWindow(report, '7d') ?? findWindow(report, '24h');
  const sources = Array.isArray(window?.top_sources) ? window.top_sources : [];
  const pending = Array.isArray(report.current?.top_pending_accounts) ? report.current.top_pending_accounts : [];

  const lines = [
    '📡 <b>Source Health</b>',
    '',
    scopeLine(scope),
    '',
    `<b>Window</b>: ${escapeHtml(windowLabel(window))}`,
    '',
    '🏆 <b>Top Sources</b>',
  ];

  if (sources.length === 0) {
    lines.push('- no source data found');
  } else {
    for (const row of sources.slice(0, 5)) {
      lines.push(`- ${trimSource(row.source_account)} · total <b>${int(row.total)}</b> · selected <b>${int(row.selected)}</b> · rate <b>${pctText(row.select_rate_pct)}</b>`);
    }
  }

  lines.push('');
  lines.push('📥 <b>Pending Accounts</b>');

  if (pending.length === 0) {
    lines.push('- no pending account backlog found');
  } else {
    for (const row of pending.slice(0, 5)) {
      lines.push(`- ${trimSource(row.source_account)} · pending <b>${int(row.count)}</b>`);
    }
  }

  return lines.join('\n');
}

function buildSchedulerText(report: any, scope: ScopedSession): string {
  const apify = report.apify ?? {};

  return [
    '⏱ <b>Scheduler</b>',
    '',
    scopeLine(scope),
    '',
    'Worker cron: <b>configured outside Telegram bot</b>',
    `Apify rotation: <b>${apify.available ? 'active' : 'inactive'}</b>`,
    `Apify interval: <b>${formatOptional(apify.rotation_interval_hours)}h</b>`,
    `Projected Apify runs/month: <b>${int(apify.projected_runs_per_month)}</b>`,
    `Projected Apify monthly cost: <b>${usd(apify.projected_monthly_cost_usd)}</b>`,
    '',
    'Market snapshot and backlog drain are read-only here in Phase 3.',
  ].join('\n');
}

function appendProviderStatLine(lines: string[], name: string, stats: AIStat): void {
  lines.push(`- ${escapeHtml(name)}: <b>${usd(stats.cost)}</b> · calls <b>${int(stats.calls)}</b>`);
}

type AIStat = {
  cost: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
};

function allAIRows(window: any): any[] {
  return Array.isArray(window?.ai?.rows) ? window.ai.rows : [];
}

function providerRows(window: any, provider: 'anthropic' | 'gemini'): any[] {
  return allAIRows(window).filter(row => matchesAIProvider(row.provider, provider));
}

function aiStats(rows: any[]): AIStat {
  return {
    cost: rows.reduce((sum: number, row: any) => sum + Number(row.cost_usd ?? 0), 0),
    calls: rows.reduce((sum: number, row: any) => sum + Number(row.calls ?? 0), 0),
    inputTokens: rows.reduce((sum: number, row: any) => sum + Number(row.input_tokens ?? 0), 0),
    outputTokens: rows.reduce((sum: number, row: any) => sum + Number(row.output_tokens ?? 0), 0),
  };
}

function matchesAIProvider(value: unknown, provider: 'anthropic' | 'gemini'): boolean {
  const raw = String(value ?? '').toLowerCase();
  if (provider === 'anthropic') return raw === 'anthropic' || raw === 'claude' || raw.includes('anthropic');
  return raw === 'gemini' || raw.includes('gemini') || raw.includes('google');
}

function findWindow(report: any, key: string): any | undefined {
  const windows = Array.isArray(report.windows) ? report.windows : [];
  return windows.find((row: any) => String(row.key) === key);
}

function windowLabel(window: any | undefined): string {
  const key = String(window?.key ?? '');
  const labels: Record<string, string> = {
    '24h': 'Last 24h',
    '7d': 'Last 7d',
    '15d': 'Last 15d',
    '30d': 'Last 30d',
    '180d': 'Last 6 months',
  };
  return labels[key] ?? String((window?.label ?? key) || 'unknown');
}

function trimSource(value: unknown): string {
  const raw = String(value ?? '__unknown__').replace(/\s+/g, '');
  return escapeHtml(raw.length > 24 ? raw.slice(0, 23) + '…' : raw);
}

function usd(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '$0.00';
  if (Math.abs(n) > 0 && Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function pctText(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'n/a';
  return `${n.toFixed(2)}%`;
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

type ReportingDetail = 'channel_audit' | 'ai_quality' | 'editorial' | 'market_snapshot';

function parseReportingDetailButton(text: string): ReportingDetail | null {
  const map: Record<string, ReportingDetail> = {
    '🧾 Channel Audit': 'channel_audit',
    '🧠 AI Quality': 'ai_quality',
    '📰 Editorial': 'editorial',
    '📈 Market Snapshot': 'market_snapshot',
  };
  return map[text] ?? null;
}

function buildReportingDetailText(detail: ReportingDetail, report: any, scope: ScopedSession, env: Env): string {
  if (detail === 'channel_audit') return buildChannelAuditText(report, scope);
  if (detail === 'ai_quality') return buildAIQualityText(report, scope);
  if (detail === 'editorial') return buildEditorialText(report, scope);
  return buildMarketSnapshotText(report, scope, env);
}

function buildChannelAuditText(report: any, scope: ScopedSession): string {
  const w24 = findWindow(report, '24h');
  const w7 = findWindow(report, '7d');
  const current = report.current ?? {};
  const queue = current.publish_queue_active ?? {};
  const p24 = w24?.pipeline ?? {};
  const pub24 = w24?.publish ?? {};
  const p7 = w7?.pipeline ?? {};
  const pub7 = w7?.publish ?? {};
  const sources = Array.isArray(w7?.top_sources) ? w7.top_sources : [];

  const lines = [
    '🧾 <b>Channel Audit</b>',
    '',
    scopeLine(scope),
    '',
    'This is the channel-level operational snapshot.',
    '',
    '📬 <b>Queue Now</b>',
    `- scheduled: <b>${int(queue.scheduled)}</b>`,
    `- retry: <b>${int(queue.retry)}</b>`,
    `- failed: <b>${int(queue.failed)}</b>`,
    '',
    '🔄 <b>Last 24h Funnel</b>',
    `- fetched: <b>${int(p24.fetched)}</b>`,
    `- fresh: <b>${int(p24.fresh)}</b>`,
    `- selected: <b>${int(p24.ai_selected)}</b>`,
    `- queued: <b>${int(p24.queued)}</b>`,
    `- published: <b>${int(pub24.published)}</b>`,
    '',
    '📆 <b>Last 7d</b>',
    `- fetched: <b>${int(p7.fetched)}</b>`,
    `- selected: <b>${int(p7.ai_selected)}</b>`,
    `- published: <b>${int(pub7.published)}</b>`,
    '',
    '🏆 <b>Top Sources 7d</b>',
  ];

  if (sources.length === 0) {
    lines.push('- no source data found');
  } else {
    for (const row of sources.slice(0, 3)) {
      lines.push(`- ${trimSource(row.source_account)} · selected <b>${int(row.selected)}</b> / total <b>${int(row.total)}</b>`);
    }
  }

  return lines.join('\n');
}

function buildAIQualityText(report: any, scope: ScopedSession): string {
  const w24 = findWindow(report, '24h');
  const w7 = findWindow(report, '7d');

  const lines = [
    '🧠 <b>AI Quality</b>',
    '',
    scopeLine(scope),
    '',
    'This view uses available pipeline counters. Rejection reasons are not stored yet.',
    '',
  ];

  appendAIQualityWindow(lines, '🕒 Last 24h', w24);
  appendAIQualityWindow(lines, '📆 Last 7d', w7);

  lines.push('🧾 <b>Missing data</b>');
  lines.push('- rejection reasons: not stored yet');
  lines.push('- model-level quality score: not stored yet');

  return lines.join('\n');
}

function appendAIQualityWindow(lines: string[], title: string, window: any): void {
  const p = window?.pipeline ?? {};
  const selected = Number(p.ai_selected ?? 0);
  const rejected = Number(p.ai_rejected ?? 0);
  const total = selected + rejected;
  const selectRate = total > 0 ? selected / total * 100 : null;

  lines.push(`<b>${title}</b>`);
  lines.push(`- selected: <b>${int(selected)}</b>`);
  lines.push(`- rejected: <b>${int(rejected)}</b>`);
  lines.push(`- select rate: <b>${selectRate === null ? 'n/a' : selectRate.toFixed(2) + '%'}</b>`);
  lines.push(`- queued: <b>${int(p.queued)}</b>`);
  lines.push('');
}

function buildEditorialText(report: any, scope: ScopedSession): string {
  const w24 = findWindow(report, '24h');
  const w7 = findWindow(report, '7d');
  const current = report.current ?? {};
  const activeQueue = current.publish_queue_active ?? {};

  const lines = [
    '📰 <b>Editorial Output</b>',
    '',
    scopeLine(scope),
    '',
    'This view summarizes output health. Caption-level editorial metrics are not stored yet.',
    '',
  ];

  appendEditorialWindow(lines, '🕒 Last 24h', w24);
  appendEditorialWindow(lines, '📆 Last 7d', w7);

  lines.push('📬 <b>Queue Now</b>');
  lines.push(`- scheduled: <b>${int(activeQueue.scheduled)}</b>`);
  lines.push(`- retry: <b>${int(activeQueue.retry)}</b>`);
  lines.push(`- failed: <b>${int(activeQueue.failed)}</b>`);
  lines.push('');
  lines.push('🧾 <b>Missing data</b>');
  lines.push('- average caption length: not stored yet');
  lines.push('- media/text split: not stored yet');
  lines.push('- translation fallback count: not stored yet');

  return lines.join('\n');
}

function appendEditorialWindow(lines: string[], title: string, window: any): void {
  const p = window?.publish ?? {};
  lines.push(`<b>${title}</b>`);
  lines.push(`- published: <b>${int(p.published)}</b>`);
  lines.push(`- scheduled: <b>${int(p.scheduled)}</b>`);
  lines.push(`- failed: <b>${int(p.failed)}</b>`);
  lines.push('');
}

function buildMarketSnapshotText(report: any, scope: ScopedSession, env: Env): string {
  const runtimeEnv = env as any;
  const enabled = runtimeEnv.MARKET_SNAPSHOT_ENABLED ?? 'unknown';
  const channel = runtimeEnv.MARKET_SNAPSHOT_CHANNEL_ID ?? 'not configured';
  const slots = runtimeEnv.MARKET_SNAPSHOT_SLOTS ?? 'not configured';

  return [
    '📈 <b>Market Snapshot</b>',
    '',
    scopeLine(scope),
    '',
    `- enabled: <b>${escapeHtml(enabled)}</b>`,
    `- configured channel: <code>${escapeHtml(channel)}</code>`,
    `- configured slots: <code>${escapeHtml(slots)}</code>`,
    '',
    `- current report channel: <code>${escapeHtml(report.channel_id ?? scope.channelId)}</code>`,
    '',
    'Last publish status is not stored in this report yet.',
  ].join('\n');
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

  if (text.startsWith('🌐 ')) {
    const raw = text.slice('🌐 '.length).trim();
    return /^[\w-]{1,64}$/.test(raw) ? raw : null;
  }

  return null;
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

function completeScope(session: AdminSession): ScopedSession | null {
  const categoryId = session.categoryId && sanitizeCallbackId(session.categoryId, '');
  const channelId = session.channelId && sanitizeCallbackId(session.channelId, '');
  const platform = sanitizeCallbackId(session.platform ?? 'all', 'all');

  if (!categoryId || !channelId) return null;
  return { categoryId, channelId, platform };
}

function formatBool(value: unknown): string {
  if (value === true || value === 1 || value === '1' || value === 'true') return 'true';
  if (value === false || value === 0 || value === '0' || value === 'false') return 'false';
  return 'unknown';
}

function formatOptional(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'n/a';
  return escapeHtml(value);
}

function int(value: unknown): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '0';
  return Math.max(0, Math.floor(n)).toLocaleString('en-US');
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
