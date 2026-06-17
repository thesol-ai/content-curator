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
    return Response.json(await routeScoped(env, chatId, 'monitoring', 'monitoring',
      (scoped) => ({ text: buildMonitoringText(scoped), keyboard: monitoringKeyboard() })));
  }

  if (text === '📈 Reporting' || text === '/report' || text === '/ops' || text === '📊 Open Reports' || text === '📊 Reports') {
    return Response.json(await routeScoped(env, chatId, 'reports', 'reports',
      (scoped) => ({ text: buildReportSectionsText(scoped), keyboard: reportSectionKeyboard() })));
  }

  if (text === '⚙️ Settings') {
    return Response.json(await routeScoped(env, chatId, 'settings', 'settings',
      (scoped) => ({ text: buildSettingsText(scoped), keyboard: settingsKeyboard() })));
  }

  if (text === '❓ Help') {
    return Response.json(await routeScoped(env, chatId, 'help', 'help',
      (scoped) => ({ text: buildHelpText(scoped), keyboard: helpKeyboard() })));
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
    return Response.json(await routeScoped(env, chatId, 'costs', 'costs_menu',
      (scoped) => ({ text: buildCostMenuText(scoped), keyboard: costMenuKeyboard() })));
  }

  if (text === '🤖 AI Providers') {
    return Response.json(await routeScoped(env, chatId, 'costs', 'costs_menu',
      (scoped) => ({ text: buildCostMenuText(scoped), keyboard: costMenuKeyboard() })));
  }

  const costSection = parseCostSectionButton(text);
  if (costSection) {
    return Response.json(await routeReportSection(env, chatId, 'costs', costSection, costMenuKeyboard()));
  }

  if (text === '📬 Publishing') {
    return Response.json(await routeScoped(env, chatId, 'reports', 'report:publish_queue',
      async (scoped) => ({ text: await buildPublishingQueueText(env, scoped), keyboard: reportSectionKeyboard() })));
  }

  const section = parseSectionButton(text);
  if (section) {
    return Response.json(await routeReportSection(env, chatId, 'reports', section, reportSectionKeyboard()));
  }

  const reportingDetail = parseReportingDetailButton(text);
  if (reportingDetail) {
    const scoped = await requireScope(env, chatId);
    if (!scoped) return Response.json({ ok: true, handled: 'scope_required' });

    const report = await buildScopedOperationalReport(env, scoped);
    await saveSession(env, chatId, { ...scoped, screen: 'reports' });
    await sendTelegramMessage(env, chatId, await buildReportingDetailText(reportingDetail, report, scoped, env), reportSectionKeyboard());
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

/**
 * Collapses the repeated "require scope → save screen → render" ritual that was
 * duplicated ~15× in the router. Behavior is identical to the old inline blocks:
 * if scope is missing it returns the scope_required marker; otherwise it saves
 * the screen, sends the text+keyboard, and returns the handled id.
 *
 * `render` may be sync or async and returns { text, keyboard }.
 */
/**
 * Variant for the "parse a section button → render a report section" branches.
 * Preserves the old behavior: scope-guard, save screen, call sendReportSection
 * with the given keyboard, return `report:<section>`.
 */
async function routeReportSection(
  env: Env,
  chatId: string | number,
  screen: AdminScreen,
  section: OperationalReportSection,
  keyboard: object,
): Promise<{ ok: true; handled: string }> {
  const scoped = await requireScope(env, chatId);
  if (!scoped) return { ok: true, handled: 'scope_required' };

  await saveSession(env, chatId, { ...scoped, screen });
  await sendReportSection(env, chatId, section, scoped, keyboard);
  return { ok: true, handled: `report:${section}` };
}

async function routeScoped(
  env: Env,
  chatId: string | number,
  screen: AdminScreen,
  handledId: string,
  render: (scoped: ScopedSession) => { text: string; keyboard: object } | Promise<{ text: string; keyboard: object }>,
): Promise<{ ok: true; handled: string }> {
  const scoped = await requireScope(env, chatId);
  if (!scoped) return { ok: true, handled: 'scope_required' };

  await saveSession(env, chatId, { ...scoped, screen });
  const { text, keyboard } = await render(scoped);
  await sendTelegramMessage(env, chatId, text, keyboard);
  return { ok: true, handled: handledId };
}

async function sendReportSection(
  env: Env,
  chatId: string | number,
  section: OperationalReportSection,
  scope: ScopedSession,
  keyboard: object = reportSectionKeyboard(),
): Promise<void> {
  await sendTypingAction(env, chatId);
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

function formatTehranDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date).replace(',', '');
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
    ['⬅️ Back'],
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
    ['⬅️ Back'],
    ['🏠 Home'],
  ]);
}

function reportSectionKeyboard(): object {
  return replyKeyboard([
    ['🧾 Channel Audit', '📜 Channel Logs'],
    ['📊 Overview', '💸 Costs'],
    ['🔄 Funnel', '📬 Publishing'],
    ['🩺 System', '🏆 Sources'],
    ['🩺 Publisher Diagnostics', '🧪 Data Validation'],
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
    '🩺 System': 'health',
    '🏆 Sources': 'sources',
  };
  return map[normalized] ?? null;
}

type ReportingDetail = 'channel_audit' | 'channel_logs' | 'publisher_diagnostics' | 'data_validation' | 'ai_quality' | 'editorial' | 'market_snapshot';

function parseReportingDetailButton(text: string): ReportingDetail | null {
  const map: Record<string, ReportingDetail> = {
    '🧾 Channel Audit': 'channel_audit',
    '📜 Channel Logs': 'channel_logs',
    '🩺 Publisher Diagnostics': 'publisher_diagnostics',
    '🧪 Data Validation': 'data_validation',
    '🧠 AI Quality': 'ai_quality',
    '📰 Editorial': 'editorial',
    '📈 Market Snapshot': 'market_snapshot',
  };
  return map[text] ?? null;
}

async function buildReportingDetailText(detail: ReportingDetail, report: any, scope: ScopedSession, env: Env): Promise<string> {
  if (detail === 'channel_audit') return buildChannelAuditText(report, scope);
  if (detail === 'channel_logs') return buildChannelLogsText(env, report, scope);
  if (detail === 'publisher_diagnostics') return buildPublisherDiagnosticsText(env, report, scope);
  if (detail === 'data_validation') return buildDataValidationText(env, report, scope);
  if (detail === 'ai_quality') return buildAIQualityText(report, scope);
  if (detail === 'editorial') return buildEditorialText(report, scope);
  return buildMarketSnapshotText(report, scope, env);
}

type ChannelPublishConfig = {
  id?: string;
  category_id?: string;
  timezone?: string;
  max_per_day?: number;
  max_per_hour?: number;
  min_gap_minutes?: number;
};

type ScheduledPostRow = {
  id: string;
  scheduled_at: number | null;
  status: string;
  retry_count?: number | null;
  source_account?: string | null;
  post_id?: string | null;
};

async function buildPublishingQueueText(env: Env, scope: ScopedSession): Promise<string> {
  const channel = await safeFirst<ChannelPublishConfig | null>(env, `
    SELECT id, category_id, timezone, max_per_day, max_per_hour, min_gap_minutes
    FROM channels
    WHERE id=?
    LIMIT 1
  `, [scope.channelId], null);

  const maxPerDay = positiveNumber(channel?.max_per_day);
  const maxPerHour = positiveNumber(channel?.max_per_hour);
  const minGap = positiveNumber(channel?.min_gap_minutes);
  const timezone = String(channel?.timezone ?? 'Asia/Tehran');

  const activeCounts = await safeAll<{ status: string; count: number }>(env, `
    SELECT status, COUNT(*) AS count
    FROM publish_queue
    WHERE channel_id=?
      AND status IN ('scheduled','retry','publishing','failed')
    GROUP BY status
    ORDER BY status
  `, [scope.channelId]);

  const nowUnix = Math.floor(Date.now() / 1000);
  const oneHourAgo = nowUnix - 3600;
  const dayStart = nowUnix - 24 * 3600;

  const published24 = await safeFirst<{ count: number }>(env, `
    SELECT COUNT(*) AS count
    FROM publish_queue
    WHERE channel_id=?
      AND status='published'
      AND published_at >= ?
  `, [scope.channelId, dayStart], { count: 0 });

  const publishedHour = await safeFirst<{ count: number }>(env, `
    SELECT COUNT(*) AS count
    FROM publish_queue
    WHERE channel_id=?
      AND status='published'
      AND published_at >= ?
  `, [scope.channelId, oneHourAgo], { count: 0 });

  const nextRows = await safeAll<ScheduledPostRow>(env, `
    SELECT
      pq.id,
      pq.scheduled_at,
      pq.status,
      pq.retry_count,
      COALESCE(NULLIF(di.source_account,''), '__unknown__') AS source_account,
      di.post_id AS post_id
    FROM publish_queue pq
    LEFT JOIN discovery_items di ON di.id = pq.item_id
    WHERE pq.channel_id=?
      AND pq.status IN ('scheduled','retry','publishing')
      AND (?='all' OR di.platform=?)
    ORDER BY COALESCE(pq.scheduled_at, 0) ASC, pq.created_at ASC
    LIMIT 12
  `, [scope.channelId, scope.platform, scope.platform]);

  const counts = countRowsToSimpleObject(activeCounts);
  const remainingDay = maxPerDay === null ? null : Math.max(0, maxPerDay - Number(published24.count ?? 0));
  const remainingHour = maxPerHour === null ? null : Math.max(0, maxPerHour - Number(publishedHour.count ?? 0));
  const dueNow = nextRows.filter(row => Number(row.scheduled_at ?? 0) > 0 && Number(row.scheduled_at) <= nowUnix).length;

  const lines = [
    '📬 <b>Publishing Queue</b>',
    '',
    scopeLine(scope),
    `<b>Time</b>: ${escapeHtml(formatTehranDate(new Date().toISOString()))}`,
    '',
    '📬 <b>Queue Now</b>',
    `- scheduled: <b>${int(counts.scheduled)}</b>`,
    `- publishing: <b>${int(counts.publishing)}</b>`,
    `- retry: <b>${int(counts.retry)}</b>`,
    `- failed: <b>${int(counts.failed)}</b>`,
    `- due now: <b>${int(dueNow)}</b>`,
    '',
    '📏 <b>Capacity</b>',
    `- max/day: <b>${maxPerDay === null ? 'n/a' : int(maxPerDay)}</b>`,
    `- published last 24h: <b>${int(published24.count)}</b>`,
    `- remaining 24h capacity: <b>${remainingDay === null ? 'n/a' : int(remainingDay)}</b>`,
    `- max/hour: <b>${maxPerHour === null ? 'n/a' : int(maxPerHour)}</b>`,
    `- published last hour: <b>${int(publishedHour.count)}</b>`,
    `- remaining hourly capacity: <b>${remainingHour === null ? 'n/a' : int(remainingHour)}</b>`,
    `- min gap: <b>${minGap === null ? 'n/a' : int(minGap)} min</b>`,
    '',
    '🗓 <b>Next Scheduled Posts</b>',
  ];

  if (nextRows.length === 0) {
    lines.push('- no scheduled posts found for this scope');
  } else {
    for (const row of nextRows.slice(0, 10)) {
      const when = row.scheduled_at ? formatTehranDate(new Date(Number(row.scheduled_at) * 1000).toISOString()) : 'unscheduled';
      const due = Number(row.scheduled_at ?? 0) <= nowUnix ? ' · due' : '';
      const source = trimSource(row.source_account ?? '__unknown__');
      lines.push(`- ${escapeHtml(when)} · ${escapeHtml(row.status)}${due} · ${source}`);
    }

    if (nextRows.length > 10) {
      lines.push(`- ${int(nextRows.length - 10)} more hidden`);
    }
  }

  lines.push('');
  lines.push('If scheduled items do not publish when due, check the publisher logs and Telegram bot secret next.');

  return lines.join('\n');
}

function countRowsToSimpleObject(rows: Array<{ status: string; count: number }>): Record<string, number> {
  return rows.reduce((acc: Record<string, number>, row) => {
    acc[String(row.status)] = Number(row.count ?? 0);
    return acc;
  }, {});
}

function positiveNumber(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

type ValidationIssue = {
  severity: 'ok' | 'warning' | 'error';
  label: string;
  detail: string;
};

async function buildDataValidationText(env: Env, report: any, scope: ScopedSession): Promise<string> {
  const channel = await safeFirst<any>(env, `
    SELECT id, category_id, telegram_chat_id, language, timezone, allowed_windows, blocked_windows,
           max_per_day, max_per_hour, min_gap_minutes, publish_enabled, enabled
    FROM channels
    WHERE id=?
    LIMIT 1
  `, [scope.channelId], null);

  const nowUnix = Math.floor(Date.now() / 1000);
  const oneHourAgo = nowUnix - 3600;
  const last24h = nowUnix - 24 * 3600;

  const [
    activeQueueRows,
    queueIntegrityRows,
    nextRows,
    published24,
    publishedHour,
    discoveryRows,
    itemRows,
    aiRows,
  ] = await Promise.all([
    safeAll<{ status: string; count: number }>(env, `
      SELECT status, COUNT(*) AS count
      FROM publish_queue
      WHERE channel_id=?
        AND status IN ('scheduled','retry','publishing','failed')
      GROUP BY status
      ORDER BY status
    `, [scope.channelId]),

    safeAll<{ issue: string; count: number }>(env, `
      SELECT issue, COUNT(*) AS count
      FROM (
        SELECT 'missing_scheduled_at' AS issue FROM publish_queue
        WHERE channel_id=? AND status IN ('scheduled','retry','publishing') AND (scheduled_at IS NULL OR scheduled_at <= 0)

        UNION ALL

        SELECT 'missing_item_join' AS issue FROM publish_queue pq
        LEFT JOIN discovery_items di ON di.id = pq.item_id
        WHERE pq.channel_id=? AND di.id IS NULL

        UNION ALL

        SELECT 'missing_caption' AS issue FROM publish_queue
        WHERE channel_id=? AND status IN ('scheduled','retry','publishing')
          AND COALESCE(caption_short, caption_full, '') = ''

        UNION ALL

        SELECT 'bad_status' AS issue FROM publish_queue
        WHERE channel_id=? AND status NOT IN ('scheduled','retry','publishing','published','failed','skipped')
      )
      GROUP BY issue
      ORDER BY issue
    `, [scope.channelId, scope.channelId, scope.channelId, scope.channelId]),

    safeAll<any>(env, `
      SELECT pq.id, pq.status, pq.scheduled_at, pq.created_at
      FROM publish_queue pq
      LEFT JOIN discovery_items di ON di.id = pq.item_id
      WHERE pq.channel_id=?
        AND pq.status IN ('scheduled','retry','publishing')
        AND (?='all' OR di.platform=?)
      ORDER BY COALESCE(pq.scheduled_at, 0) ASC, pq.created_at ASC
      LIMIT 30
    `, [scope.channelId, scope.platform, scope.platform]),

    safeFirst<{ count: number }>(env, `
      SELECT COUNT(*) AS count
      FROM publish_queue
      WHERE channel_id=?
        AND status='published'
        AND published_at >= ?
    `, [scope.channelId, last24h], { count: 0 }),

    safeFirst<{ count: number }>(env, `
      SELECT COUNT(*) AS count
      FROM publish_queue
      WHERE channel_id=?
        AND status='published'
        AND published_at >= ?
    `, [scope.channelId, oneHourAgo], { count: 0 }),

    safeFirst<any>(env, `
      SELECT
        COUNT(*) AS runs,
        COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END), 0) AS failed,
        MAX(created_at) AS last_run_at
      FROM discovery_runs
      WHERE category_id=?
        AND (?='all' OR platform=?)
        AND created_at >= datetime('now','-24 hours')
    `, [scope.categoryId, scope.platform, scope.platform], { runs: 0, failed: 0, last_run_at: null }),

    safeAll<{ status: string; count: number }>(env, `
      SELECT status, COUNT(*) AS count
      FROM discovery_items
      WHERE category_id=?
        AND (?='all' OR platform=?)
        AND created_at >= datetime('now','-24 hours')
      GROUP BY status
      ORDER BY status
    `, [scope.categoryId, scope.platform, scope.platform]),

    safeFirst<any>(env, `
      SELECT
        COUNT(*) AS calls,
        COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END), 0) AS success,
        COALESCE(SUM(CASE WHEN status!='success' THEN 1 ELSE 0 END), 0) AS failed
      FROM ai_usage
      WHERE created_at >= datetime('now','-24 hours')
    `, [], { calls: 0, success: 0, failed: 0 }),
  ]);

  const activeQueue = countRowsToSimpleObject(activeQueueRows);
  const integrity = countIssueRowsToObject(queueIntegrityRows);
  const maxPerDay = positiveNumber(channel?.max_per_day);
  const maxPerHour = positiveNumber(channel?.max_per_hour);
  const minGap = positiveNumber(channel?.min_gap_minutes);
  const channelFound = Boolean(channel?.id);
  const publishEnabled = isTruthy(channel?.publish_enabled);
  const channelEnabled = isTruthy(channel?.enabled);
  const chatConfigured = Boolean(String(channel?.telegram_chat_id ?? '').trim());
  const activeScheduled = Number(activeQueue.scheduled ?? 0) + Number(activeQueue.retry ?? 0) + Number(activeQueue.publishing ?? 0);
  const dueNow = nextRows.filter(row => Number(row.scheduled_at ?? 0) > 0 && Number(row.scheduled_at) <= nowUnix).length;
  const spacingViolations = countSpacingViolations(nextRows, minGap);
  const overDailyCapacity = maxPerDay === null ? false : Number(published24.count ?? 0) > maxPerDay;
  const overHourlyCapacity = maxPerHour === null ? false : Number(publishedHour.count ?? 0) > maxPerHour;

  const issues: ValidationIssue[] = [
    check(channelFound, 'channel row exists', channelFound ? scope.channelId : 'missing channel config'),
    check(channelEnabled, 'channel enabled', `enabled=${formatOptional(channel?.enabled)}`),
    check(publishEnabled, 'channel publish enabled', `publish_enabled=${formatOptional(channel?.publish_enabled)}`),
    check(chatConfigured, 'telegram chat configured', chatConfigured ? 'telegram_chat_id is set' : 'telegram_chat_id missing'),
    check(maxPerDay !== null && maxPerDay > 0, 'daily capacity configured', `max_per_day=${formatOptional(channel?.max_per_day)}`),
    check(maxPerHour !== null && maxPerHour > 0, 'hourly capacity configured', `max_per_hour=${formatOptional(channel?.max_per_hour)}`),
    check(minGap !== null && minGap >= 0, 'min gap configured', `min_gap_minutes=${formatOptional(channel?.min_gap_minutes)}`),
    check(Number(integrity.missing_scheduled_at ?? 0) === 0, 'queue scheduled_at integrity', `${int(integrity.missing_scheduled_at)} invalid row(s)`),
    check(Number(integrity.missing_item_join ?? 0) === 0, 'queue item joins', `${int(integrity.missing_item_join)} missing discovery item(s)`),
    check(Number(integrity.missing_caption ?? 0) === 0, 'queue captions', `${int(integrity.missing_caption)} missing caption row(s)`),
    check(Number(integrity.bad_status ?? 0) === 0, 'queue statuses', `${int(integrity.bad_status)} bad status row(s)`),
    check(spacingViolations === 0, 'scheduled spacing', `${int(spacingViolations)} min-gap violation(s) in next 30`),
    check(!overDailyCapacity, 'daily capacity usage', `published24=${int(published24.count)} max/day=${maxPerDay === null ? 'n/a' : int(maxPerDay)}`),
    check(!overHourlyCapacity, 'hourly capacity usage', `publishedHour=${int(publishedHour.count)} max/hour=${maxPerHour === null ? 'n/a' : int(maxPerHour)}`),
  ];

  const errorCount = issues.filter(issue => issue.severity === 'error').length;
  const warningCount = issues.filter(issue => issue.severity === 'warning').length;
  const overall = errorCount > 0 ? 'Needs Fix' : warningCount > 0 ? 'Warnings' : 'OK';

  const lines = [
    '🧪 <b>Data Validation</b>',
    '',
    scopeLine(scope),
    `<b>Time</b>: ${escapeHtml(formatTehranDate(new Date().toISOString()))}`,
    '',
    `Overall: <b>${escapeHtml(overall)}</b>`,
    `Errors: <b>${int(errorCount)}</b> · Warnings: <b>${int(warningCount)}</b>`,
    '',
    '📣 <b>Channel Config</b>',
    `- timezone: <code>${escapeHtml(channel?.timezone ?? 'n/a')}</code>`,
    `- language: <code>${escapeHtml(channel?.language ?? 'n/a')}</code>`,
    `- allowed windows: <code>${escapeHtml(channel?.allowed_windows ?? 'n/a')}</code>`,
    `- blocked windows: <code>${escapeHtml(channel?.blocked_windows ?? 'n/a')}</code>`,
    '',
    '📬 <b>Queue Checks</b>',
    `- active scheduled/retry/publishing: <b>${int(activeScheduled)}</b>`,
    `- due now: <b>${int(dueNow)}</b>`,
    `- published last 24h: <b>${int(published24.count)}</b>`,
    `- published last hour: <b>${int(publishedHour.count)}</b>`,
    `- next rows scanned: <b>${int(nextRows.length)}</b>`,
    '',
    '🔎 <b>Validation Results</b>',
  ];

  for (const issue of issues) {
    lines.push(`${validationIcon(issue.severity)} <b>${escapeHtml(issue.label)}</b> — ${escapeHtml(issue.detail)}`);
  }

  lines.push('');
  lines.push('🧠 <b>Pipeline 24h</b>');
  lines.push(`- discovery runs: <b>${int(discoveryRows.runs)}</b>`);
  lines.push(`- failed discovery runs: <b>${int(discoveryRows.failed)}</b>`);
  lines.push(`- last run: <code>${escapeHtml(discoveryRows.last_run_at ?? 'n/a')}</code>`);
  lines.push(`- discovery item statuses: ${escapeHtml(formatStatusCounts(itemRows))}`);
  lines.push(`- AI calls: <b>${int(aiRows.calls)}</b> · success <b>${int(aiRows.success)}</b> · failed <b>${int(aiRows.failed)}</b>`);
  lines.push('');
  lines.push('This view is read-only and does not change queue or settings.');

  return lines.join('\n');
}

function check(ok: boolean, label: string, detail: string): ValidationIssue {
  return {
    severity: ok ? 'ok' : 'error',
    label,
    detail,
  };
}

function validationIcon(severity: ValidationIssue['severity']): string {
  if (severity === 'error') return '🚨';
  if (severity === 'warning') return '⚠️';
  return '✅';
}

function countIssueRowsToObject(rows: Array<{ issue: string; count: number }>): Record<string, number> {
  return rows.reduce((acc: Record<string, number>, row) => {
    acc[String(row.issue)] = Number(row.count ?? 0);
    return acc;
  }, {});
}

function countSpacingViolations(rows: any[], minGapMinutes: number | null): number {
  if (minGapMinutes === null || minGapMinutes <= 0) return 0;

  const sorted = rows
    .map(row => Number(row.scheduled_at ?? 0))
    .filter(value => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);

  let violations = 0;
  const minSeconds = minGapMinutes * 60;
  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const previous = sorted[i - 1];
    if (current !== undefined && previous !== undefined && current - previous < minSeconds) violations++;
  }
  return violations;
}

function formatStatusCounts(rows: Array<{ status: string; count: number }>): string {
  if (rows.length === 0) return 'none';
  return rows.map(row => `${row.status}:${int(row.count)}`).join(' · ');
}

type ChannelLogEntry = {
  ts: number;
  source: 'publish_queue' | 'discovery_run' | 'run_event';
  severity: 'info' | 'warning' | 'error';
  title: string;
  detail?: string | null;
};

async function buildChannelLogsText(env: Env, report: any, scope: ScopedSession): Promise<string> {
  const [publishRows, discoveryRows, runEventRows] = await Promise.all([
    safeAll<any>(env, `
      SELECT
        pq.id,
        pq.status,
        pq.scheduled_at,
        pq.published_at,
        pq.retry_count,
        pq.publish_error,
        pq.telegram_message_id,
        COALESCE(NULLIF(di.source_account,''), '__unknown__') AS source_account,
        di.platform AS platform
      FROM publish_queue pq
      LEFT JOIN discovery_items di ON di.id = pq.item_id
      WHERE pq.channel_id=?
        AND (?='all' OR di.platform=?)
      ORDER BY COALESCE(pq.published_at, pq.scheduled_at, CAST(strftime('%s', pq.created_at) AS INTEGER), 0) DESC
      LIMIT 18
    `, [scope.channelId, scope.platform, scope.platform]),

    safeAll<any>(env, `
      SELECT id, category_id, platform, status, error_message, items_fetched, items_ai_selected, items_queued, created_at, completed_at
      FROM discovery_runs
      WHERE category_id=?
        AND (?='all' OR platform=?)
      ORDER BY created_at DESC
      LIMIT 12
    `, [scope.categoryId, scope.platform, scope.platform]),

    safeAll<any>(env, `
      SELECT event_type, phase, severity, message, source_id, dataset_id, created_at
      FROM run_events
      WHERE created_at >= datetime('now','-48 hours')
        AND (
          message LIKE ?
          OR source_id LIKE ?
          OR dataset_id LIKE ?
          OR event_type LIKE ?
        )
      ORDER BY created_at DESC
      LIMIT 12
    `, [
      `%${scope.categoryId}%`,
      `%${scope.categoryId}%`,
      `%${scope.categoryId}%`,
      `%${scope.categoryId}%`,
    ]),
  ]);

  const entries: ChannelLogEntry[] = [
    ...publishRows.map(row => publishQueueLogEntry(row)),
    ...discoveryRows.map(row => discoveryRunLogEntry(row)),
    ...runEventRows.map(row => runEventLogEntry(row)),
  ]
    .filter(entry => Number.isFinite(entry.ts) && entry.ts > 0)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 20);

  const failedPublish = publishRows.filter(row => row.status === 'failed').length;
  const overdue = publishRows.filter(row => {
    const scheduledAt = Number(row.scheduled_at ?? 0);
    return row.status !== 'published' && scheduledAt > 0 && Math.floor(Date.now() / 1000) - scheduledAt >= 15 * 60;
  }).length;
  const failedDiscovery = discoveryRows.filter(row => row.status === 'failed').length;
  const errorEvents = runEventRows.filter(row => String(row.severity ?? '').toLowerCase() === 'error').length;

  const lines = [
    '📜 <b>Channel Logs</b>',
    '',
    scopeLine(scope),
    `<b>Time</b>: ${escapeHtml(formatTehranDate(new Date().toISOString()))}`,
    '',
    '📌 <b>Summary 48h</b>',
    `- publish rows scanned: <b>${int(publishRows.length)}</b>`,
    `- overdue publish rows: <b>${int(overdue)}</b>`,
    `- failed publish rows: <b>${int(failedPublish)}</b>`,
    `- failed discovery runs: <b>${int(failedDiscovery)}</b>`,
    `- error run events: <b>${int(errorEvents)}</b>`,
    '',
    '🧾 <b>Timeline</b>',
  ];

  if (entries.length === 0) {
    lines.push('- no recent channel log entries found');
  } else {
    for (const entry of entries) {
      const icon = logSeverityIcon(entry.severity);
      const when = escapeHtml(formatTehranDate(new Date(entry.ts * 1000).toISOString()));
      lines.push(`${icon} <b>${when}</b> · ${escapeHtml(entry.title)}`);
      if (entry.detail) lines.push(`  <code>${escapeHtml(String(entry.detail).slice(0, 180))}</code>`);
    }
  }

  lines.push('');
  lines.push('This view is read-only. It does not retry or mutate queue rows.');

  return lines.join('\n');
}

function publishQueueLogEntry(row: any): ChannelLogEntry {
  const status = String(row.status ?? 'unknown');
  const ts = Number(row.published_at ?? row.scheduled_at ?? 0);
  const source = trimSource(row.source_account ?? '__unknown__');
  const retry = Number(row.retry_count ?? 0);
  const title = `publish ${status} · ${source} · ${formatQueueId(row.id)}`;

  return {
    ts,
    source: 'publish_queue',
    severity: status === 'failed' ? 'error' : retry > 0 ? 'warning' : 'info',
    title,
    detail: row.publish_error ?? (row.telegram_message_id ? `telegram_message_id=${row.telegram_message_id}` : null),
  };
}

function discoveryRunLogEntry(row: any): ChannelLogEntry {
  const ts = parseSqliteDateToUnix(row.completed_at ?? row.created_at);
  const status = String(row.status ?? 'unknown');
  return {
    ts,
    source: 'discovery_run',
    severity: status === 'failed' ? 'error' : status === 'processing' ? 'warning' : 'info',
    title: `discovery ${status} · ${escapeHtml(row.platform ?? 'n/a')} · ${formatQueueId(row.id)}`,
    detail: row.error_message ?? `fetched=${int(row.items_fetched)} selected=${int(row.items_ai_selected)} queued=${int(row.items_queued)}`,
  };
}

function runEventLogEntry(row: any): ChannelLogEntry {
  const severity = normalizeLogSeverity(row.severity);
  return {
    ts: parseSqliteDateToUnix(row.created_at),
    source: 'run_event',
    severity,
    title: `event ${String(row.event_type ?? 'unknown')} · ${String(row.phase ?? 'n/a')}`,
    detail: row.message ?? row.source_id ?? row.dataset_id ?? null,
  };
}

function normalizeLogSeverity(value: unknown): ChannelLogEntry['severity'] {
  const raw = String(value ?? '').toLowerCase();
  if (raw === 'error' || raw === 'fatal') return 'error';
  if (raw === 'warn' || raw === 'warning') return 'warning';
  return 'info';
}

function logSeverityIcon(severity: ChannelLogEntry['severity']): string {
  if (severity === 'error') return '🚨';
  if (severity === 'warning') return '⚠️';
  return 'ℹ️';
}

function parseSqliteDateToUnix(value: unknown): number {
  const raw = String(value ?? '').trim();
  if (!raw) return 0;
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z';
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

type PublisherDiagnosticsChannelRow = {
  id?: string;
  telegram_chat_id?: string | null;
  publish_enabled?: number | string | boolean | null;
  max_per_day?: number | null;
  max_per_hour?: number | null;
  min_gap_minutes?: number | null;
  timezone?: string | null;
};

type PublishFailureRow = {
  id: string;
  status: string;
  scheduled_at: number | null;
  retry_count: number | null;
  publish_error: string | null;
  source_account?: string | null;
  post_id?: string | null;
  created_at?: string | null;
};

async function buildPublisherDiagnosticsText(env: Env, report: any, scope: ScopedSession): Promise<string> {
  const channel = await safeFirst<PublisherDiagnosticsChannelRow | null>(env, `
    SELECT id, telegram_chat_id, publish_enabled, max_per_day, max_per_hour, min_gap_minutes, timezone
    FROM channels
    WHERE id=?
    LIMIT 1
  `, [scope.channelId], null);

  const nowUnix = Math.floor(Date.now() / 1000);
  const dueRows = await safeAll<PublishFailureRow>(env, `
    SELECT
      pq.id,
      pq.status,
      pq.scheduled_at,
      pq.retry_count,
      pq.publish_error,
      COALESCE(NULLIF(di.source_account,''), '__unknown__') AS source_account,
      di.post_id AS post_id,
      pq.created_at AS created_at
    FROM publish_queue pq
    LEFT JOIN discovery_items di ON di.id = pq.item_id
    WHERE pq.channel_id=?
      AND pq.status IN ('scheduled','retry','publishing')
      AND pq.scheduled_at <= ?
      AND (?='all' OR di.platform=?)
    ORDER BY pq.scheduled_at ASC
    LIMIT 20
  `, [scope.channelId, nowUnix, scope.platform, scope.platform]);

  const overdueRows = dueRows.filter(row => Number(row.scheduled_at ?? 0) > 0 && nowUnix - Number(row.scheduled_at) >= 15 * 60);

  const failedRows = await safeAll<PublishFailureRow>(env, `
    SELECT
      pq.id,
      pq.status,
      pq.scheduled_at,
      pq.retry_count,
      pq.publish_error,
      COALESCE(NULLIF(di.source_account,''), '__unknown__') AS source_account,
      di.post_id AS post_id,
      pq.created_at AS created_at
    FROM publish_queue pq
    LEFT JOIN discovery_items di ON di.id = pq.item_id
    WHERE pq.channel_id=?
      AND pq.status='failed'
      AND (?='all' OR di.platform=?)
    ORDER BY COALESCE(pq.scheduled_at, 0) DESC, pq.created_at DESC
    LIMIT 8
  `, [scope.channelId, scope.platform, scope.platform]);

  const lastPublished = await safeAll<any>(env, `
    SELECT
      pq.id,
      pq.published_at,
      pq.telegram_message_id,
      COALESCE(NULLIF(di.source_account,''), '__unknown__') AS source_account,
      di.post_id AS post_id
    FROM publish_queue pq
    LEFT JOIN discovery_items di ON di.id = pq.item_id
    WHERE pq.channel_id=?
      AND pq.status='published'
      AND (?='all' OR di.platform=?)
    ORDER BY COALESCE(pq.published_at, 0) DESC
    LIMIT 5
  `, [scope.channelId, scope.platform, scope.platform]);

  const publishEnvEnabled = env.TELEGRAM_FINAL_PUBLISH_ENABLED === 'true';
  const schedulerEnvEnabled = env.TELEGRAM_PUBLISH_SCHEDULER_ENABLED === 'true';
  const dueLimit = Number((env as any).TELEGRAM_PUBLISH_DUE_LIMIT ?? 0);
  const channelEnabled = isTruthy(channel?.publish_enabled);
  const chatConfigured = Boolean(String(channel?.telegram_chat_id ?? '').trim());

  const diagnosis = diagnosePublisher({
    publishEnvEnabled,
    schedulerEnvEnabled,
    channelEnabled,
    chatConfigured,
    dueNow: dueRows.length,
    overdue: overdueRows.length,
    failed: failedRows.length,
  });

  const lines = [
    '🩺 <b>Publisher Diagnostics</b>',
    '',
    scopeLine(scope),
    `<b>Time</b>: ${escapeHtml(formatTehranDate(new Date().toISOString()))}`,
    '',
    '🚦 <b>Publish Switches</b>',
    `- TELEGRAM_FINAL_PUBLISH_ENABLED: <b>${publishEnvEnabled ? 'true' : 'false'}</b>`,
    `- TELEGRAM_PUBLISH_SCHEDULER_ENABLED: <b>${schedulerEnvEnabled ? 'true' : 'false'}</b>`,
    `- channel publish_enabled: <b>${channelEnabled ? 'true' : 'false'}</b>`,
    `- Telegram chat id: <b>${chatConfigured ? 'configured' : 'missing'}</b>`,
    `- due limit/tick: <b>${Number.isFinite(dueLimit) && dueLimit > 0 ? int(dueLimit) : 'n/a'}</b>`,
    '',
    '📬 <b>Due Queue</b>',
    `- due now: <b>${int(dueRows.length)}</b>`,
    `- overdue 15m+: <b>${int(overdueRows.length)}</b>`,
    `- failed rows: <b>${int(failedRows.length)}</b>`,
    '',
    '🧠 <b>Diagnosis</b>',
    ...diagnosis.map(line => `- ${line}`),
    '',
    '⏰ <b>Due / Overdue Items</b>',
  ];

  if (dueRows.length === 0) {
    lines.push('- no due items found');
  } else {
    for (const row of dueRows.slice(0, 8)) {
      const secondsLate = Math.max(0, nowUnix - Number(row.scheduled_at ?? nowUnix));
      lines.push(`- ${escapeHtml(formatAge(secondsLate))} late · ${escapeHtml(row.status)} · ${formatQueueId(row.id)} · ${trimSource(row.source_account)}`);
    }
  }

  lines.push('');
  lines.push('✅ <b>Last Published</b>');
  if (lastPublished.length === 0) {
    lines.push('- no published rows found for this scope');
  } else {
    for (const row of lastPublished.slice(0, 5)) {
      const when = row.published_at ? formatTehranDate(new Date(Number(row.published_at) * 1000).toISOString()) : 'unknown';
      const tg = row.telegram_message_id ? ` · tg ${escapeHtml(row.telegram_message_id)}` : '';
      lines.push(`- ${escapeHtml(when)} · ${formatQueueId(row.id)}${tg} · ${trimSource(row.source_account)}`);
    }
  }

  lines.push('');
  lines.push('🚨 <b>Recent Failed Queue Rows</b>');
  if (failedRows.length === 0) {
    lines.push('- no failed rows found');
  } else {
    for (const row of failedRows.slice(0, 5)) {
      lines.push(`- ${formatQueueId(row.id)} · retry <b>${int(row.retry_count)}</b> · ${trimSource(row.source_account)}`);
      if (row.publish_error) lines.push(`  <code>${escapeHtml(String(row.publish_error).slice(0, 180))}</code>`);
    }
  }

  return lines.join('\n');
}

function diagnosePublisher(input: {
  publishEnvEnabled: boolean;
  schedulerEnvEnabled: boolean;
  channelEnabled: boolean;
  chatConfigured: boolean;
  dueNow: number;
  overdue: number;
  failed: number;
}): string[] {
  const lines: string[] = [];

  if (!input.publishEnvEnabled) lines.push('final publish is disabled by env');
  if (!input.schedulerEnvEnabled) lines.push('publish scheduler is disabled by env');
  if (!input.channelEnabled) lines.push('channel publishing is disabled');
  if (!input.chatConfigured) lines.push('channel telegram_chat_id is missing');

  if (input.dueNow === 0) {
    lines.push('no due posts right now; scheduled posts may simply be for the future');
  } else if (input.overdue > 0) {
    lines.push('due posts are overdue; inspect publisher logs and Telegram send errors');
  } else {
    lines.push('due posts exist and are recent; wait for the next scheduler tick or inspect logs if they stay due');
  }

  if (input.failed > 0) lines.push('failed publish rows exist; open failed row details in the database/logs');

  if (lines.length === 0) lines.push('no obvious blocker detected from queue metadata');

  return lines;
}

function isTruthy(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function formatQueueId(value: unknown): string {
  const raw = String(value ?? '');
  if (!raw) return '<code>unknown</code>';
  const compact = raw.length > 14 ? `${raw.slice(0, 6)}…${raw.slice(-6)}` : raw;
  return `<code>${escapeHtml(compact)}</code>`;
}

function formatAge(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  if (safe < 60) return `${safe}s`;
  if (safe < 3600) return `${Math.floor(safe / 60)}m`;
  if (safe < 86400) return `${Math.floor(safe / 3600)}h ${Math.floor((safe % 3600) / 60)}m`;
  return `${Math.floor(safe / 86400)}d ${Math.floor((safe % 86400) / 3600)}h`;
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
    'Channel-level snapshot for queue, funnel, and source performance.',
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

const TELEGRAM_MAX_MESSAGE = 4096;

/**
 * Splits text into <=4096-char chunks on line boundaries (Telegram's hard cap).
 * A single line longer than the cap is hard-split as a last resort.
 */
function splitForTelegram(text: string, max = TELEGRAM_MAX_MESSAGE): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (line.length > max) {
      if (current) { chunks.push(current); current = ''; }
      for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max));
      continue;
    }
    if ((current ? current.length + 1 : 0) + line.length > max) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** One POST to Telegram with a single 429 retry honoring retry_after. */
async function telegramPost(token: string, method: string, payload: object): Promise<Response> {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  let res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (res.status === 429) {
    const info = await res.clone().json().catch(() => null) as any;
    const retryAfter = Number(info?.parameters?.retry_after ?? 1);
    await new Promise(r => setTimeout(r, Math.min(retryAfter, 5) * 1000));
    res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
  }
  return res;
}

async function sendTelegramMessage(env: Env, chatId: string | number, text: string, replyMarkup?: object): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not configured');

  // Long messages (logs/audit) must be split at Telegram's 4096-char limit.
  const chunks = splitForTelegram(text);

  for (let i = 0; i < chunks.length; i++) {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text: chunks[i],
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    // Attach the keyboard only to the LAST chunk so controls stay at the bottom.
    if (replyMarkup && i === chunks.length - 1) payload.reply_markup = replyMarkup;

    const res = await telegramPost(token, 'sendMessage', payload);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Telegram sendMessage failed ${res.status}: ${body.slice(0, 300)}`);
    }
  }
}

/** Shows "typing…" so heavy report builds feel responsive. Best-effort. */
async function sendTypingAction(env: Env, chatId: string | number): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
  }).catch(() => undefined);
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
