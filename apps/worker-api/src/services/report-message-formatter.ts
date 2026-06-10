type AnyRecord = Record<string, any>;

export type OperationalReportSection =
  | 'overview'
  | 'costs'
  | 'pipeline'
  | 'publish'
  | 'apify'
  | 'health'
  | 'sources';

export function normalizeOperationalReportSection(value: unknown): OperationalReportSection {
  const raw = String(value ?? '').trim();
  if (
    raw === 'overview' ||
    raw === 'costs' ||
    raw === 'pipeline' ||
    raw === 'publish' ||
    raw === 'apify' ||
    raw === 'health' ||
    raw === 'sources'
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
  else if (normalized === 'pipeline') appendPipeline(lines, report);
  else if (normalized === 'publish') appendPublish(lines, report);
  else if (normalized === 'apify') appendApify(lines, report);
  else if (normalized === 'health') appendHealth(lines, report);
  else if (normalized === 'sources') appendSources(lines, report);

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


function appendOverview(lines: string[], report: AnyRecord): void {
  const w24 = findWindow(report, '24h');
  const w7 = findWindow(report, '7d');
  const current = report.current ?? {};
  const activeQueue = current.publish_queue_active ?? {};
  const backlog = current.ai_candidate_backlog ?? {};
  const stuckRuns = Array.isArray(current.stuck_processing_runs) ? current.stuck_processing_runs : [];
  const recentFailed = Array.isArray(current.recent_failed_runs) ? current.recent_failed_runs : [];
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
  lines.push('💰 <b>Cost Windows</b>');
  lines.push('');

  for (const window of getWindows(report)) {
    const apify = findApifyWindow(report, String(window.key));
    lines.push(`🕒 <b>${windowLabel(window)}</b>`);
    lines.push(`- AI spent: <b>${usd(window.ai?.total_cost_usd)}</b>`);
    lines.push(`- AI monthly projection: <b>${usd(window.ai?.projected_monthly_usd)}</b>`);
    if (apify) {
      lines.push(`- Apify spent: <b>${usd(apify.cost_usd)}</b>`);
      lines.push(`- Apify monthly projection: <b>${usd(apify.projected_monthly_usd)}</b>`);
      lines.push(`- Apify runs: <b>${int(apify.runs)}</b>`);
    }
    lines.push('');
  }
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
  const stuckRuns = Array.isArray(current.stuck_processing_runs) ? current.stuck_processing_runs : [];
  const failedRuns = Array.isArray(current.recent_failed_runs) ? current.recent_failed_runs : [];

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
  const sources = Array.isArray(window?.top_sources) ? window.top_sources : [];

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

function sectionTitle(section: OperationalReportSection): string {
  const titles: Record<OperationalReportSection, string> = {
    overview: 'Overview',
    costs: 'Costs',
    pipeline: 'Content Funnel',
    publish: 'Publish Queue',
    apify: 'Apify',
    health: 'System State',
    sources: 'Top Sources',
  };
  return titles[section];
}

function sectionIcon(section: OperationalReportSection): string {
  const icons: Record<OperationalReportSection, string> = {
    overview: '📊',
    costs: '💸',
    pipeline: '🔄',
    publish: '📬',
    apify: '🕷',
    health: '🩺',
    sources: '🏆',
  };
  return icons[section];
}

function getWindows(report: AnyRecord): AnyRecord[] {
  return Array.isArray(report.windows) ? report.windows : [];
}

function findWindow(report: AnyRecord, key: string): AnyRecord | undefined {
  return getWindows(report).find(row => String(row.key) === key);
}

function findApifyWindow(report: AnyRecord, key: string): AnyRecord | undefined {
  const windows = Array.isArray(report.apify?.windows) ? report.apify.windows : [];
  return windows.find((row: AnyRecord) => String(row.key) === key);
}


function scopeText(report: AnyRecord): string {
  const channel = report.channel_id ? String(report.channel_id) : 'all';
  const category = report.category_id ? String(report.category_id) : 'all';
  const platform = report.platform ? String(report.platform) : 'all';
  return `<b>${escapeHtml(channel)}</b> · ${escapeHtml(category)} · ${escapeHtml(platform)}`;
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

function providerIcon(provider: unknown): string {
  const p = String(provider ?? '').toLowerCase();
  if (p.includes('anthropic') || p.includes('claude')) return '🟣';
  if (p.includes('gemini') || p.includes('google')) return '🔵';
  return '⚪️';
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
