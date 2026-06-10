type AnyRecord = Record<string, any>;

export type OperationalReportSection =
  | 'overview'
  | 'costs'
  | 'costs_anthropic'
  | 'costs_gemini'
  | 'costs_apify'
  | 'cost_trend'
  | 'budget_alerts'
  | 'pipeline'
  | 'publish'
  | 'apify'
  | 'health'
  | 'sources'
  | 'monitoring_status'
  | 'queue_health'
  | 'failures'
  | 'monitoring_ai'
  | 'cost_watch'
  | 'source_health'
  | 'scheduler'
  | 'ai_quality'
  | 'editorial'
  | 'market_snapshot';

export function normalizeOperationalReportSection(value: unknown): OperationalReportSection {
  const raw = String(value ?? '').trim();
  if (
    raw === 'overview' ||
    raw === 'costs' ||
    raw === 'costs_anthropic' ||
    raw === 'costs_gemini' ||
    raw === 'costs_apify' ||
    raw === 'cost_trend' ||
    raw === 'budget_alerts' ||
    raw === 'pipeline' ||
    raw === 'publish' ||
    raw === 'apify' ||
    raw === 'health' ||
    raw === 'sources' ||
    raw === 'monitoring_status' ||
    raw === 'queue_health' ||
    raw === 'failures' ||
    raw === 'monitoring_ai' ||
    raw === 'cost_watch' ||
    raw === 'source_health' ||
    raw === 'scheduler' ||
    raw === 'ai_quality' ||
    raw === 'editorial' ||
    raw === 'market_snapshot'
  ) {
    return raw;
  }
  return 'overview';
}

export function formatOperationalReportForTelegram(
  report: AnyRecord,
  section: OperationalReportSection = 'overview',
): string {
  const normalized = normalizeOperationalReportSection(section);
  const lines: string[] = [];

  appendHeader(lines, report, normalized);

  if (normalized === 'overview') appendOverview(lines, report);
  else if (normalized === 'costs') appendCosts(lines, report);
  else if (normalized === 'costs_anthropic') appendProviderCosts(lines, report, 'anthropic');
  else if (normalized === 'costs_gemini') appendProviderCosts(lines, report, 'gemini');
  else if (normalized === 'costs_apify') appendApifyCosts(lines, report);
  else if (normalized === 'cost_trend') appendCostTrend(lines, report);
  else if (normalized === 'budget_alerts') appendBudgetAlerts(lines, report);
  else if (normalized === 'pipeline') appendPipeline(lines, report);
  else if (normalized === 'publish') appendPublish(lines, report);
  else if (normalized === 'apify') appendApify(lines, report);
  else if (normalized === 'health') appendHealth(lines, report);
  else if (normalized === 'sources') appendSources(lines, report);
  else if (normalized === 'monitoring_status') appendMonitoringStatus(lines, report);
  else if (normalized === 'queue_health') appendQueueHealth(lines, report);
  else if (normalized === 'failures') appendFailures(lines, report);
  else if (normalized === 'monitoring_ai') appendMonitoringAI(lines, report);
  else if (normalized === 'cost_watch') appendCostWatch(lines, report);
  else if (normalized === 'source_health') appendSourceHealth(lines, report);
  else if (normalized === 'scheduler') appendScheduler(lines, report);
  else if (normalized === 'ai_quality') appendAIQuality(lines, report);
  else if (normalized === 'editorial') appendEditorial(lines, report);
  else if (normalized === 'market_snapshot') appendMarketSnapshot(lines, report);

  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.length <= 3900 ? text : text.slice(0, 3850) + '\n\n…output truncated.';
}

function appendHeader(lines: string[], report: AnyRecord, section: OperationalReportSection): void {
  lines.push(`${sectionIcon(section)} <b>${sectionTitle(section)}</b>`);
  lines.push('');
  lines.push(`<b>Scope</b>: ${scopeText(report)}`);
  lines.push(`<b>Time</b>: ${escapeHtml(formatTehranDate(report.generated_at ?? new Date().toISOString()))}`);
  lines.push('');
}

function appendMonitoringStatus(lines: string[], report: AnyRecord): void {
  const current = report.current ?? {};
  const queue = current.publish_queue_active ?? {};
  const backlog = current.ai_candidate_backlog ?? {};
  const stuckRuns = arrayOf(current.stuck_processing_runs);
  const failedRuns = arrayOf(current.recent_failed_runs);
  const w24 = findWindow(report, '24h');
  const apify = report.apify ?? {};

  const state = failedRuns.length > 0 || stuckRuns.length > 0
    ? 'Warning'
    : intNumber(backlog.failed) > 0
      ? 'Warning'
      : 'OK';

  lines.push('📌 <b>Live Summary</b>');
  lines.push(`- overall: <b>${escapeHtml(state)}</b>`);
  lines.push(`- publishing: <b>${int(queue.scheduled)}</b> scheduled · <b>${int(queue.failed)}</b> failed`);
  lines.push(`- AI backlog: <b>${int(backlog.queued)}</b> queued · <b>${int(backlog.failed)}</b> failed`);
  lines.push(`- stuck runs: <b>${stuckRuns.length}</b>`);
  lines.push(`- recent failures: <b>${failedRuns.length}</b>`);
  lines.push(`- Apify: <b>${apify.available ? 'active' : 'inactive'}</b>`);
  lines.push('');

  if (w24) {
    lines.push('🗓 <b>Last 24h</b>');
    lines.push(`- fetched: <b>${int(w24.pipeline?.fetched)}</b> · fresh <b>${int(w24.pipeline?.fresh)}</b>`);
    lines.push(`- selected/rejected: <b>${int(w24.pipeline?.ai_selected)}</b> / <b>${int(w24.pipeline?.ai_rejected)}</b>`);
    lines.push(`- published: <b>${int(w24.publish?.published)}</b>`);
    lines.push(`- estimated cost: <b>${usd(totalWindowCost(report, '24h'))}</b>`);
  }
}

function appendQueueHealth(lines: string[], report: AnyRecord): void {
  const current = report.current ?? {};
  const queue = current.publish_queue_active ?? {};
  const backlog = current.ai_candidate_backlog ?? {};
  const pendingAccounts = arrayOf(current.top_pending_accounts);

  lines.push('📬 <b>Publish Queue</b>');
  lines.push(`- scheduled: <b>${int(queue.scheduled)}</b>`);
  lines.push(`- retry: <b>${int(queue.retry)}</b>`);
  lines.push(`- failed: <b>${int(queue.failed)}</b>`);
  lines.push('');

  lines.push('🧠 <b>AI Backlog</b>');
  lines.push(`- queued: <b>${int(backlog.queued)}</b>`);
  lines.push(`- pending: <b>${int(backlog.pending)}</b>`);
  lines.push(`- rejected: <b>${int(backlog.ai_rejected)}</b>`);
  lines.push(`- failed: <b>${int(backlog.failed)}</b>`);

  if (pendingAccounts.length > 0) {
    lines.push('');
    lines.push('📌 <b>Top Pending Accounts</b>');
    for (const row of pendingAccounts.slice(0, 5)) {
      lines.push(`- ${escapeHtml(row.source_account ?? '__unknown__')}: <b>${int(row.count)}</b>`);
    }
  }
}

function appendFailures(lines: string[], report: AnyRecord): void {
  const current = report.current ?? {};
  const stuckRuns = arrayOf(current.stuck_processing_runs);
  const failedRuns = arrayOf(current.recent_failed_runs);

  lines.push('🚨 <b>Failure Board</b>');
  lines.push(`- stuck processing runs: <b>${stuckRuns.length}</b>`);
  lines.push(`- failed runs last 24h: <b>${failedRuns.length}</b>`);
  lines.push('');

  if (failedRuns.length === 0 && stuckRuns.length === 0) {
    lines.push('No active failed or stuck runs in the current report. Astonishingly civilized.');
    return;
  }

  if (failedRuns.length > 0) {
    lines.push('🚨 <b>Recent Failed Runs</b>');
    for (const run of failedRuns.slice(0, 8)) {
      lines.push(`- <code>${escapeHtml(run.id)}</code> · ${escapeHtml(run.platform ?? 'n/a')} · ${escapeHtml(run.created_at ?? '')}`);
      if (run.error_message) lines.push(`  <code>${escapeHtml(String(run.error_message).slice(0, 120))}</code>`);
    }
    lines.push('');
  }

  if (stuckRuns.length > 0) {
    lines.push('⏳ <b>Stuck Processing</b>');
    for (const run of stuckRuns.slice(0, 8)) {
      lines.push(`- <code>${escapeHtml(run.id)}</code> · ${escapeHtml(run.platform ?? 'n/a')} · ${escapeHtml(run.created_at ?? '')}`);
    }
  }
}

function appendMonitoringAI(lines: string[], report: AnyRecord): void {
  const w24 = findWindow(report, '24h');
  const w7 = findWindow(report, '7d');
  const rows24 = aiRows(w24);
  const rows7 = aiRows(w7);

  lines.push('🤖 <b>Provider Health</b>');
  lines.push('AI usage is read from successful ai_usage rows. Provider error telemetry needs failed-call tracking.');
  lines.push('');

  appendProviderHealthLine(lines, 'anthropic', rows24, rows7);
  appendProviderHealthLine(lines, 'gemini', rows24, rows7);
}

function appendProviderHealthLine(lines: string[], provider: 'anthropic' | 'gemini', rows24: AnyRecord[], rows7: AnyRecord[]): void {
  const r24 = providerStats(rows24.filter(row => matchesAIProvider(row.provider, provider)));
  const r7 = providerStats(rows7.filter(row => matchesAIProvider(row.provider, provider)));

  lines.push(`${providerIconName(provider)} <b>${providerDisplayName(provider)}</b>`);
  lines.push(`- 24h calls: <b>${int(r24.calls)}</b> · cost <b>${usd(r24.cost)}</b>`);
  lines.push(`- 7d calls: <b>${int(r7.calls)}</b> · cost <b>${usd(r7.cost)}</b>`);
  lines.push(`- avg cost/call 24h: <b>${usd(r24.calls > 0 ? r24.cost / r24.calls : 0)}</b>`);
  lines.push('');
}

function appendCostWatch(lines: string[], report: AnyRecord): void {
  const w24 = findWindow(report, '24h');
  const w7 = findWindow(report, '7d');
  const apify = report.apify ?? {};
  const ai24 = Number(w24?.ai?.total_cost_usd ?? 0);
  const apify24 = Number(findApifyWindow(report, '24h')?.cost_usd ?? 0);
  const aiMonthly = Number(w24?.ai?.projected_monthly_usd ?? 0);
  const apifyMonthly = Number(apify.projected_monthly_cost_usd ?? findApifyWindow(report, '24h')?.projected_monthly_usd ?? 0);

  lines.push('💰 <b>Cost Watch</b>');
  lines.push(`- 24h total: <b>${usd(ai24 + apify24)}</b>`);
  lines.push(`- AI monthly projection: <b>${usd(aiMonthly)}</b>`);
  lines.push(`- Apify monthly projection: <b>${usd(apifyMonthly)}</b>`);
  lines.push(`- total monthly projection: <b>${usd(aiMonthly + apifyMonthly)}</b>`);
  lines.push('');

  if (w7) {
    lines.push('📆 <b>Last 7d</b>');
    lines.push(`- AI: <b>${usd(w7.ai?.total_cost_usd)}</b>`);
    lines.push(`- Apify: <b>${usd(findApifyWindow(report, '7d')?.cost_usd)}</b>`);
  }

  lines.push('');
  lines.push('🚨 <b>Budget Status</b>');
  lines.push('- warning/critical thresholds are not persisted yet');
  lines.push('- add budget settings before enabling hard alerts');
}

function appendSourceHealth(lines: string[], report: AnyRecord): void {
  const w7 = findWindow(report, '7d') ?? findWindow(report, '24h') ?? getWindows(report)[0];
  const sources = arrayOf(w7?.top_sources);
  const current = report.current ?? {};
  const pending = arrayOf(current.top_pending_accounts);

  lines.push('📡 <b>Source Health</b>');
  lines.push(`<b>Window</b>: ${escapeHtml(windowLabel(w7))}`);
  lines.push('');

  if (sources.length === 0) {
    lines.push('No source data found for this scope.');
    return;
  }

  const sorted = [...sources].sort((a, b) => Number(b.select_rate_pct ?? 0) - Number(a.select_rate_pct ?? 0));
  const best = sorted[0];
  const weakest = sorted[sorted.length - 1];

  lines.push('📌 <b>Summary</b>');
  lines.push(`- active sources in window: <b>${sources.length}</b>`);
  lines.push(`- best source: <b>${escapeHtml(best?.source_account ?? '__unknown__')}</b> (${pctText(best?.select_rate_pct)})`);
  lines.push(`- weakest source: <b>${escapeHtml(weakest?.source_account ?? '__unknown__')}</b> (${pctText(weakest?.select_rate_pct)})`);
  lines.push(`- pending source accounts: <b>${pending.length}</b>`);
  lines.push('');

  lines.push('🏆 <b>Top Sources</b>');
  for (const row of sorted.slice(0, 5)) {
    lines.push(`- ${escapeHtml(row.source_account ?? '__unknown__')}: total <b>${int(row.total)}</b> · selected <b>${int(row.selected)}</b> · rate <b>${pctText(row.select_rate_pct)}</b>`);
  }
}

function appendScheduler(lines: string[], report: AnyRecord): void {
  const apify = report.apify ?? {};
  const current = report.current ?? {};
  const queue = current.publish_queue_active ?? {};
  const backlog = current.ai_candidate_backlog ?? {};

  lines.push('⏱ <b>Scheduler</b>');
  lines.push('- Worker cron telemetry is not stored directly in this report.');
  lines.push('- This view summarizes scheduled subsystems from current state.');
  lines.push('');

  lines.push('📌 <b>Subsystems</b>');
  lines.push(`- publishing queue: <b>${int(queue.scheduled)}</b> scheduled`);
  lines.push(`- backlog drain candidates: <b>${int(backlog.queued)}</b> queued`);
  lines.push(`- Apify rotation: <b>${apify.available ? 'active' : 'inactive'}</b>`);
  lines.push(`- Apify interval hours: <b>${int(apify.rotation_interval_hours)}</b>`);
  lines.push(`- market snapshot: <b>configured outside report</b>`);
}

function appendOverview(lines: string[], report: AnyRecord): void {
  const w24 = findWindow(report, '24h');
  const w7 = findWindow(report, '7d');
  const current = report.current ?? {};
  const activeQueue = current.publish_queue_active ?? {};
  const backlog = current.ai_candidate_backlog ?? {};
  const stuckRuns = arrayOf(current.stuck_processing_runs);
  const recentFailed = arrayOf(current.recent_failed_runs);
  const apify = report.apify ?? {};

  lines.push('📌 <b>Snapshot</b>');
  lines.push('');

  if (w24) {
    lines.push('🗓 <b>Last 24h</b>');
    lines.push(`- Cost: AI <b>${usd(w24.ai?.total_cost_usd)}</b> · Apify <b>${usd(findApifyWindow(report, '24h')?.cost_usd)}</b>`);
    lines.push(`- Content: fresh <b>${int(w24.pipeline?.fresh)}</b> · duplicate <b>${int(w24.pipeline?.duplicate)}</b>`);
    lines.push(`- AI: selected <b>${int(w24.pipeline?.ai_selected)}</b> · rejected <b>${int(w24.pipeline?.ai_rejected)}</b>`);
    lines.push(`- Publish: sent <b>${int(w24.publish?.published)}</b> · scheduled <b>${int(w24.publish?.scheduled)}</b>`);
    lines.push('');
  }

  if (w7) {
    lines.push('📆 <b>Last 7d</b>');
    lines.push(`- AI cost: <b>${usd(w7.ai?.total_cost_usd)}</b>`);
    lines.push(`- Fresh content: <b>${int(w7.pipeline?.fresh)}</b>`);
    lines.push(`- AI selected: <b>${int(w7.pipeline?.ai_selected)}</b>`);
    lines.push(`- Published: <b>${int(w7.publish?.published)}</b>`);
    lines.push('');
  }

  lines.push('🧭 <b>Current State</b>');
  lines.push(`- Publish queue: <b>${int(activeQueue.scheduled)}</b> scheduled`);
  lines.push(`- AI backlog: <b>${int(backlog.queued)}</b> queued`);
  lines.push(`- Stuck runs: <b>${stuckRuns.length}</b>`);
  lines.push(`- Recent failures: <b>${recentFailed.length}</b>`);
  lines.push(`- Apify monthly projection: <b>${usd(apify.projected_monthly_cost_usd)}</b>`);
}

function appendCosts(lines: string[], report: AnyRecord): void {
  lines.push('💸 <b>Cost Summary</b>');
  lines.push('');
  lines.push('AI scope: global unless ai_usage is enriched with channel/category/platform');
  lines.push('Apify scope: selected category/platform');
  lines.push('');

  const windows = ['24h', '7d', '30d']
    .map(key => findWindow(report, key))
    .filter(Boolean) as AnyRecord[];

  for (const window of windows) {
    const apify = findApifyWindow(report, String(window.key));
    const aiCost = Number(window.ai?.total_cost_usd ?? 0);
    const apifyCost = Number(apify?.cost_usd ?? 0);

    lines.push(`🕒 <b>${windowLabel(window)}</b>`);
    lines.push(`- AI: <b>${usd(aiCost)}</b>`);
    lines.push(`- Apify: <b>${usd(apifyCost)}</b>`);
    lines.push(`- Total: <b>${usd(aiCost + apifyCost)}</b>`);
    lines.push('');
  }
}

function appendProviderCosts(lines: string[], report: AnyRecord, provider: 'anthropic' | 'gemini'): void {
  const w24 = findWindow(report, '24h');
  const w7 = findWindow(report, '7d');
  const rows24 = aiRowsForProvider(w24, provider);
  const rows7 = aiRowsForProvider(w7, provider);
  const stat24 = providerStats(rows24);
  const stat7 = providerStats(rows7);

  lines.push(`${providerIconName(provider)} <b>${providerDisplayName(provider)} Cost</b>`);
  lines.push('');
  lines.push('AI scope: global unless ai_usage is enriched with channel/category/platform');
  lines.push('');

  lines.push('📌 <b>Summary</b>');
  lines.push(`- 24h: <b>${usd(stat24.cost)}</b> · calls <b>${int(stat24.calls)}</b>`);
  lines.push(`- 7d: <b>${usd(stat7.cost)}</b> · calls <b>${int(stat7.calls)}</b>`);
  lines.push(`- 7d tokens: in <b>${int(stat7.inputTokens)}</b> · out <b>${int(stat7.outputTokens)}</b>`);
  lines.push('');

  appendProviderWindow(lines, '🕒 Last 24h', rows24);
  appendProviderWindow(lines, '📆 Last 7d', rows7);

  const modelRows = rows7.length > 0 ? rows7 : rows24;
  if (modelRows.length > 0) {
    lines.push('🧾 <b>Main models</b>');
    for (const row of modelRows.slice(0, 3)) {
      lines.push(`- ${escapeHtml(row.model ?? 'unknown')} · ${escapeHtml(row.purpose ?? 'n/a')} · <b>${usd(row.cost_usd)}</b>`);
    }
  }
}

function appendProviderWindow(lines: string[], title: string, rows: AnyRecord[]): void {
  const stats = providerStats(rows);
  lines.push(`<b>${title}</b>`);

  if (rows.length === 0) {
    lines.push('- no usage');
    lines.push('');
    return;
  }

  lines.push(`- spent: <b>${usd(stats.cost)}</b>`);
  lines.push(`- monthly projection: <b>${usd(stats.projected)}</b>`);
  lines.push(`- calls: <b>${int(stats.calls)}</b>`);
  lines.push(`- tokens: in <b>${int(stats.inputTokens)}</b> · out <b>${int(stats.outputTokens)}</b>`);
  lines.push('');
}

function appendApifyCosts(lines: string[], report: AnyRecord): void {
  const apify = report.apify ?? {};

  lines.push('🕷 <b>Apify Cost</b>');
  lines.push('');
  lines.push('Apify scope: selected category/platform');
  lines.push('');

  if (!apify.available) {
    lines.push('- status: <b>inactive</b>');
    lines.push(`- reason: <code>${escapeHtml(apify.reason ?? 'unknown')}</code>`);
    return;
  }

  lines.push('📌 <b>Summary</b>');
  lines.push(`- active_sources: <b>${int(apify.active_sources)}</b>`);
  lines.push(`- avg_cost_per_run: <b>${usd(apify.avg_cost_per_run_usd)}</b>`);
  lines.push(`- monthly projection: <b>${usd(apify.projected_monthly_cost_usd)}</b>`);
  lines.push('');

  const windows = ['24h', '7d', '30d']
    .map(key => findApifyWindow(report, key))
    .filter(Boolean) as AnyRecord[];

  for (const row of windows) {
    lines.push(`🕒 <b>${windowLabel(row)}</b>`);
    lines.push(`- spent: <b>${usd(row.cost_usd)}</b>`);
    lines.push(`- runs: <b>${int(row.runs)}</b>`);
    lines.push(`- monthly projection: <b>${usd(row.projected_monthly_usd)}</b>`);
    lines.push('');
  }
}

function appendCostTrend(lines: string[], report: AnyRecord): void {
  lines.push('📊 <b>Cost Trend</b>');
  lines.push('');
  lines.push('Window trend is estimated from existing report windows.');

  for (const window of getWindows(report)) {
    const apify = findApifyWindow(report, String(window.key));
    const total = Number(window.ai?.total_cost_usd ?? 0) + Number(apify?.cost_usd ?? 0);
    lines.push(`- ${windowLabel(window)}: total <b>${usd(total)}</b> · AI <b>${usd(window.ai?.total_cost_usd)}</b> · Apify <b>${usd(apify?.cost_usd)}</b>`);
  }
}

function appendBudgetAlerts(lines: string[], report: AnyRecord): void {
  const w24 = findWindow(report, '24h');
  const apify = report.apify ?? {};
  const aiMonthly = Number(w24?.ai?.projected_monthly_usd ?? 0);
  const apifyMonthly = Number(apify.projected_monthly_cost_usd ?? 0);

  lines.push('🚨 <b>Budget Alerts</b>');
  lines.push('');
  lines.push(`- AI monthly projection: <b>${usd(aiMonthly)}</b>`);
  lines.push(`- Apify monthly projection: <b>${usd(apifyMonthly)}</b>`);
  lines.push(`- total monthly projection: <b>${usd(aiMonthly + apifyMonthly)}</b>`);
  lines.push('');
  lines.push('Thresholds are not persisted yet. Add budget settings before turning this into a hard alert system.');
}

function appendPipeline(lines: string[], report: AnyRecord): void {
  lines.push('🔄 <b>Funnel by Window</b>');
  lines.push('');

  for (const window of getWindows(report)) {
    const p = window.pipeline ?? {};
    lines.push(`🕒 <b>${windowLabel(window)}</b>`);
    lines.push(`- fetched: <b>${int(p.fetched)}</b>`);
    lines.push(`- fresh: <b>${int(p.fresh)}</b> (${pctText(p.fresh_rate_pct)})`);
    lines.push(`- duplicate: <b>${int(p.duplicate)}</b> (${pctText(p.duplicate_rate_pct)})`);
    lines.push(`- selected/rejected: <b>${int(p.ai_selected)}</b> / <b>${int(p.ai_rejected)}</b>`);
    lines.push(`- queued: <b>${int(p.queued)}</b>`);
    lines.push('');
  }
}

function appendPublish(lines: string[], report: AnyRecord): void {
  const current = report.current ?? {};
  const activeQueue = current.publish_queue_active ?? {};

  lines.push('📬 <b>Queue Now</b>');
  lines.push(`- scheduled: <b>${int(activeQueue.scheduled)}</b>`);
  lines.push(`- retry: <b>${int(activeQueue.retry)}</b>`);
  lines.push(`- failed: <b>${int(activeQueue.failed)}</b>`);
  lines.push('');

  lines.push('🚀 <b>Publish History</b>');
  const windows = getWindows(report);
  for (const window of windows.slice(0, 3)) {
    const publish = window.publish ?? {};
    lines.push(`- ${windowLabel(window)}: sent <b>${int(publish.published)}</b> · scheduled <b>${int(publish.scheduled)}</b> · failed <b>${int(publish.failed)}</b>`);
  }

  if (windows.length > 3) {
    lines.push(`- ${windows.length - 3} older windows hidden to keep this readable.`);
  }
}

function appendApify(lines: string[], report: AnyRecord): void {
  const apify = report.apify ?? {};

  lines.push('🕷 <b>Runtime</b>');
  lines.push(`- status: <b>${apify.available ? 'active' : 'inactive'}</b>`);
  lines.push(`- active_sources: <b>${int(apify.active_sources)}</b>`);
  lines.push(`- interval_hours: <b>${int(apify.rotation_interval_hours)}</b>`);
  lines.push(`- projected_runs_month: <b>${int(apify.projected_runs_per_month)}</b>`);
  lines.push(`- avg_cost_per_run: <b>${usd(apify.avg_cost_per_run_usd)}</b>`);
  lines.push(`- projected_monthly_cost: <b>${usd(apify.projected_monthly_cost_usd)}</b>`);
  lines.push('');

  if (!apify.available) {
    lines.push(`- reason: <code>${escapeHtml(apify.reason ?? 'unknown')}</code>`);
    return;
  }

  lines.push('📊 <b>Windows</b>');
  const windows = Array.isArray(apify.windows) ? apify.windows : [];
  for (const row of windows.slice(0, 3)) {
    lines.push(`- ${windowLabel(row)}: <b>${int(row.runs)}</b> runs · <b>${usd(row.cost_usd)}</b>`);
  }

  if (windows.length > 3) {
    lines.push(`- ${windows.length - 3} older windows hidden.`);
  }
}

function appendHealth(lines: string[], report: AnyRecord): void {
  const current = report.current ?? {};
  const backlog = current.ai_candidate_backlog ?? {};
  const stuckRuns = arrayOf(current.stuck_processing_runs);
  const failedRuns = arrayOf(current.recent_failed_runs);

  lines.push('🩺 <b>Attention Board</b>');
  lines.push('Only actionable system state is shown here.');
  lines.push('');

  lines.push('🧠 <b>AI Backlog</b>');
  lines.push(`- queued: <b>${int(backlog.queued)}</b>`);
  lines.push(`- pending: <b>${int(backlog.pending)}</b>`);
  lines.push(`- rejected: <b>${int(backlog.ai_rejected)}</b>`);
  lines.push(`- failed: <b>${int(backlog.failed)}</b>`);
  lines.push('');

  lines.push('⚙️ <b>Processing</b>');
  lines.push(`- stuck_runs: <b>${stuckRuns.length}</b>`);
  lines.push(stuckRuns.length > 0 ? '- action: inspect backlog drain / run_events' : '- action: none');
  for (const run of stuckRuns.slice(0, 3)) {
    lines.push(`  - <code>${escapeHtml(run.id)}</code>`);
  }

  lines.push('');
  lines.push('🚨 <b>Failures</b>');
  lines.push(`- recent_failed_runs: <b>${failedRuns.length}</b>`);
  lines.push(failedRuns.length > 0 ? '- action: inspect failed datasets / Apify task mapping' : '- action: none');
  for (const run of failedRuns.slice(0, 3)) {
    lines.push(`  - <code>${escapeHtml(run.id)}</code>`);
  }
}

function appendSources(lines: string[], report: AnyRecord): void {
  const window = findWindow(report, '7d') ?? findWindow(report, '24h') ?? getWindows(report)[0];
  const sources = arrayOf(window?.top_sources);

  lines.push(`🪟 <b>Window</b>: ${escapeHtml(windowLabel(window))}`);
  lines.push('');

  if (sources.length === 0) {
    lines.push('No source data found.');
    return;
  }

  for (const [index, row] of sources.slice(0, 10).entries()) {
    const source = trimSource(row.source_account);
    lines.push(`🏷 <b>${pad2(index + 1)}. ${source}</b>`);
    lines.push(`- total <b>${int(row.total)}</b> · selected <b>${int(row.selected)}</b> · rate <b>${pctText(row.select_rate_pct)}</b>`);
    if (index < Math.min(sources.length, 10) - 1) lines.push('');
  }
}

function appendAIQuality(lines: string[], report: AnyRecord): void {
  const windows = ['24h', '7d'].map(key => findWindow(report, key)).filter(Boolean) as AnyRecord[];

  lines.push('🧠 <b>AI Quality</b>');
  lines.push('Selection/rejection quality is inferred from pipeline counters. Reason-level rejection taxonomy is not stored yet.');
  lines.push('');

  for (const window of windows) {
    const p = window.pipeline ?? {};
    const selected = intNumber(p.ai_selected);
    const rejected = intNumber(p.ai_rejected);
    const total = selected + rejected;

    lines.push(`🕒 <b>${windowLabel(window)}</b>`);
    lines.push(`- selected: <b>${int(selected)}</b>`);
    lines.push(`- rejected: <b>${int(rejected)}</b>`);
    lines.push(`- select rate: <b>${pctText(total > 0 ? selected / total * 100 : null)}</b>`);
    lines.push('');
  }

  lines.push('📌 <b>Next telemetry to add</b>');
  lines.push('- rejection_reason');
  lines.push('- quality_score distribution');
  lines.push('- provider failure/timeout counters');
}

function appendEditorial(lines: string[], report: AnyRecord): void {
  const w24 = findWindow(report, '24h');
  const w7 = findWindow(report, '7d');

  lines.push('📰 <b>Editorial Output</b>');
  lines.push('Editorial quality metrics are partially inferred from publishing counters.');
  lines.push('');

  if (w24) {
    lines.push('🗓 <b>Last 24h</b>');
    lines.push(`- published: <b>${int(w24.publish?.published)}</b>`);
    lines.push(`- scheduled: <b>${int(w24.publish?.scheduled)}</b>`);
    lines.push(`- failed: <b>${int(w24.publish?.failed)}</b>`);
    lines.push('');
  }

  if (w7) {
    lines.push('📆 <b>Last 7d</b>');
    lines.push(`- published: <b>${int(w7.publish?.published)}</b>`);
    lines.push(`- failed: <b>${int(w7.publish?.failed)}</b>`);
    lines.push('');
  }

  lines.push('📌 <b>Next telemetry to add</b>');
  lines.push('- avg caption length');
  lines.push('- media vs text-only ratio');
  lines.push('- translation fallback count');
  lines.push('- caption risk flags');
}

function appendMarketSnapshot(lines: string[], report: AnyRecord): void {
  lines.push('📈 <b>Market Snapshot</b>');
  lines.push('');
  lines.push('Market snapshot publishing is configured outside the operational report payload.');
  lines.push('');
  lines.push('Recommended telemetry to add:');
  lines.push('- enabled/disabled');
  lines.push('- last snapshot time');
  lines.push('- next slot');
  lines.push('- fallback provider used');
  lines.push('- last publish result');
  lines.push('');
  lines.push(`Current report scope: ${scopeText(report)}`);
}

function aiRows(window: AnyRecord | undefined): AnyRecord[] {
  return Array.isArray(window?.ai?.rows) ? window.ai.rows : [];
}

function aiRowsForProvider(window: AnyRecord | undefined, provider: 'anthropic' | 'gemini'): AnyRecord[] {
  return aiRows(window).filter((row: AnyRecord) => matchesAIProvider(row.provider, provider));
}

function providerStats(rows: AnyRecord[]): {
  cost: number;
  projected: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
} {
  return {
    cost: rows.reduce((sum: number, row: AnyRecord) => sum + Number(row.cost_usd ?? 0), 0),
    projected: rows.reduce((sum: number, row: AnyRecord) => sum + Number(row.projected_monthly_usd ?? 0), 0),
    calls: rows.reduce((sum: number, row: AnyRecord) => sum + Number(row.calls ?? 0), 0),
    inputTokens: rows.reduce((sum: number, row: AnyRecord) => sum + Number(row.input_tokens ?? 0), 0),
    outputTokens: rows.reduce((sum: number, row: AnyRecord) => sum + Number(row.output_tokens ?? 0), 0),
  };
}

function matchesAIProvider(value: unknown, provider: 'anthropic' | 'gemini'): boolean {
  const raw = String(value ?? '').toLowerCase();
  if (provider === 'anthropic') return raw === 'anthropic' || raw === 'claude' || raw.includes('anthropic');
  return raw === 'gemini' || raw.includes('gemini') || raw.includes('google');
}

function providerDisplayName(provider: 'anthropic' | 'gemini'): string {
  return provider === 'anthropic' ? 'Anthropic / Claude' : 'Gemini';
}

function providerIconName(provider: 'anthropic' | 'gemini'): string {
  return provider === 'anthropic' ? '🟣' : '🔵';
}

function totalWindowCost(report: AnyRecord, key: string): number {
  const window = findWindow(report, key);
  const apify = findApifyWindow(report, key);
  return Number(window?.ai?.total_cost_usd ?? 0) + Number(apify?.cost_usd ?? 0);
}

function sectionTitle(section: OperationalReportSection): string {
  const titles: Record<OperationalReportSection, string> = {
    overview: 'Overview',
    costs: 'Cost Summary',
    costs_anthropic: 'Anthropic / Claude',
    costs_gemini: 'Gemini',
    costs_apify: 'Apify Cost',
    cost_trend: 'Cost Trend',
    budget_alerts: 'Budget Alerts',
    pipeline: 'Content Funnel',
    publish: 'Publishing',
    apify: 'Apify Runtime',
    health: 'System State',
    sources: 'Sources',
    monitoring_status: 'System Status',
    queue_health: 'Queue Health',
    failures: 'Failures',
    monitoring_ai: 'AI Health',
    cost_watch: 'Cost Watch',
    source_health: 'Source Health',
    scheduler: 'Scheduler',
    ai_quality: 'AI Quality',
    editorial: 'Editorial Output',
    market_snapshot: 'Market Snapshot',
  };
  return titles[section];
}

function sectionIcon(section: OperationalReportSection): string {
  const icons: Record<OperationalReportSection, string> = {
    overview: '📊',
    costs: '💸',
    costs_anthropic: '🟣',
    costs_gemini: '🔵',
    costs_apify: '🕷',
    cost_trend: '📊',
    budget_alerts: '🚨',
    pipeline: '🔄',
    publish: '📬',
    apify: '🕷',
    health: '🩺',
    sources: '🏆',
    monitoring_status: '🟢',
    queue_health: '📬',
    failures: '🚨',
    monitoring_ai: '🤖',
    cost_watch: '💰',
    source_health: '📡',
    scheduler: '⏱',
    ai_quality: '🧠',
    editorial: '📰',
    market_snapshot: '📈',
  };
  return icons[section];
}

function getWindows(report: AnyRecord): AnyRecord[] {
  return Array.isArray(report.windows) ? report.windows : [];
}

function findWindow(report: AnyRecord, key: string): AnyRecord | undefined {
  return getWindows(report).find((row: AnyRecord) => String(row.key) === key);
}

function findApifyWindow(report: AnyRecord, key: string): AnyRecord | undefined {
  const windows = Array.isArray(report.apify?.windows) ? report.apify.windows : [];
  return windows.find((row: AnyRecord) => String(row.key) === key);
}

function scopeText(report: AnyRecord): string {
  const channel = report.channel_id ? String(report.channel_id) : 'all';
  const category = report.category_id ? String(report.category_id) : 'all';
  const platform = report.platform ? String(report.platform) : 'all';
  return `<b>${escapeHtml(category)}</b> · <code>${escapeHtml(channel)}</code> · ${escapeHtml(platform)}`;
}

function windowLabel(window: AnyRecord | undefined): string {
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

function arrayOf(value: unknown): AnyRecord[] {
  return Array.isArray(value) ? value as AnyRecord[] : [];
}

function intNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function trimSource(value: unknown): string {
  const raw = String(value ?? '__unknown__').replace(/\s+/g, '');
  return escapeHtml(raw.length > 18 ? raw.slice(0, 17) + '…' : raw);
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function formatTehranDate(value: unknown): string {
  const raw = safeText(value);
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return raw;

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second} Tehran`;
}

function int(value: unknown): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '0';
  return Math.max(0, Math.floor(n)).toLocaleString('en-US');
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
