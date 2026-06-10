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
  const lines = header(report, sectionTitle(normalized));

  if (normalized === 'overview') appendOverview(lines, report);
  else if (normalized === 'costs') appendCosts(lines, report);
  else if (normalized === 'pipeline') appendPipeline(lines, report);
  else if (normalized === 'publish') appendPublish(lines, report);
  else if (normalized === 'apify') appendApify(lines, report);
  else if (normalized === 'health') appendHealth(lines, report);
  else if (normalized === 'sources') appendSources(lines, report);

  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.length <= 3900 ? text : text.slice(0, 3850) + '\n\n…خروجی کوتاه شد.';
}

function header(report: AnyRecord, title: string): string[] {
  const categoryId = report.category_id ? safeText(report.category_id) : 'همه دسته‌ها';
  const generatedAt = formatDate(report.generated_at ?? new Date().toISOString());

  return [
    `${title}`,
    `دسته: <code>${escapeHtml(categoryId)}</code>`,
    `زمان: <code>${escapeHtml(generatedAt)}</code>`,
    '',
  ];
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

  lines.push('📌 <b>خلاصه وضعیت</b>');
  lines.push('');

  if (w24) {
    lines.push('⏱ <b>۲۴ ساعت گذشته</b>');
    lines.push(`• هزینه AI: <b>${usd(w24.ai?.total_cost_usd)}</b>`);
    lines.push(`• هزینه Apify: <b>${usd(findApifyWindow(report, '24h')?.cost_usd)}</b>`);
    lines.push(`• جدید/تکراری: <b>${int(w24.pipeline?.fresh)}</b> / <b>${int(w24.pipeline?.duplicate)}</b>`);
    lines.push(`• منتشرشده/زمان‌بندی‌شده: <b>${int(w24.publish?.published)}</b> / <b>${int(w24.publish?.scheduled)}</b>`);
    lines.push('');
  }

  if (w7) {
    lines.push('🗓 <b>۷ روز گذشته</b>');
    lines.push(`• هزینه کل AI: <b>${usd(w7.ai?.total_cost_usd)}</b>`);
    lines.push(`• محتوای تازه: <b>${int(w7.pipeline?.fresh)}</b>`);
    lines.push(`• انتخاب AI: <b>${int(w7.pipeline?.ai_selected)}</b>`);
    lines.push(`• انتشار: <b>${int(w7.publish?.published)}</b>`);
    lines.push('');
  }

  lines.push('📍 <b>الان</b>');
  lines.push(`• صف انتشار: <b>${int(activeQueue.scheduled)}</b> scheduled`);
  lines.push(`• Backlog queued: <b>${int(backlog.queued)}</b>`);
  lines.push(`• گیرکرده processing: <b>${stuckRuns.length}</b>`);
  lines.push(`• failed اخیر: <b>${recentFailed.length}</b>`);
  lines.push(`• Apify ماهانه تخمینی: <b>${usd(apify.projected_monthly_cost_usd)}</b>`);
}

function appendCosts(lines: string[], report: AnyRecord): void {
  lines.push('💵 <b>هزینه‌ها</b>');
  lines.push('');

  for (const window of getWindows(report)) {
    const apify = findApifyWindow(report, String(window.key));
    lines.push(`⏱ <b>${escapeHtml(window.label ?? window.key)}</b>`);
    lines.push(`• AI مصرف‌شده: <b>${usd(window.ai?.total_cost_usd)}</b>`);
    lines.push(`• AI ماهانه تخمینی: <b>${usd(window.ai?.projected_monthly_usd)}</b>`);
    if (apify) {
      lines.push(`• Apify مصرف‌شده: <b>${usd(apify.cost_usd)}</b>`);
      lines.push(`• Apify ماهانه تخمینی: <b>${usd(apify.projected_monthly_usd)}</b>`);
      lines.push(`• Apify runs: <b>${int(apify.runs)}</b>`);
    }
    lines.push('');
  }

  const rows = getWindows(report).flatMap((w: AnyRecord) => Array.isArray(w.ai?.rows) ? w.ai.rows : []);
  if (rows.length > 0) {
    lines.push('🤖 <b>تفکیک provider/model</b>');
    for (const row of rows.slice(0, 6)) {
      lines.push(
        `• ${escapeHtml(row.provider ?? 'unknown')} / ${escapeHtml(row.purpose ?? 'n/a')}: <b>${usd(row.cost_usd)}</b> (${int(row.calls)} calls)`
      );
    }
  }
}

function appendPipeline(lines: string[], report: AnyRecord): void {
  lines.push('🔁 <b>قیف محتوا</b>');
  lines.push('');

  for (const window of getWindows(report)) {
    const p = window.pipeline ?? {};
    lines.push(`⏱ <b>${escapeHtml(window.label ?? window.key)}</b>`);
    lines.push(`• اسکرپ‌شده: <b>${int(p.fetched)}</b>`);
    lines.push(`• تازه: <b>${int(p.fresh)}</b> (${pctText(p.fresh_rate_pct)})`);
    lines.push(`• تکراری: <b>${int(p.duplicate)}</b> (${pctText(p.duplicate_rate_pct)})`);
    lines.push(`• AI قبول/رد: <b>${int(p.ai_selected)}</b> / <b>${int(p.ai_rejected)}</b>`);
    lines.push(`• queued: <b>${int(p.queued)}</b>`);
    lines.push('');
  }
}

function appendPublish(lines: string[], report: AnyRecord): void {
  const current = report.current ?? {};
  const activeQueue = current.publish_queue_active ?? {};

  lines.push('📬 <b>صف و انتشار</b>');
  lines.push('');
  lines.push('📍 <b>وضعیت فعلی صف</b>');
  lines.push(`• scheduled: <b>${int(activeQueue.scheduled)}</b>`);
  lines.push(`• retry: <b>${int(activeQueue.retry)}</b>`);
  lines.push(`• failed: <b>${int(activeQueue.failed)}</b>`);
  lines.push('');

  for (const window of getWindows(report)) {
    const publish = window.publish ?? {};
    lines.push(`⏱ <b>${escapeHtml(window.label ?? window.key)}</b>`);
    lines.push(`• published: <b>${int(publish.published)}</b>`);
    lines.push(`• scheduled: <b>${int(publish.scheduled)}</b>`);
    lines.push(`• failed: <b>${int(publish.failed)}</b>`);
    lines.push('');
  }
}

function appendApify(lines: string[], report: AnyRecord): void {
  const apify = report.apify ?? {};

  lines.push('🕷 <b>Apify</b>');
  lines.push('');
  lines.push(`• وضعیت: <b>${apify.available ? 'فعال' : 'غیرفعال'}</b>`);
  lines.push(`• source فعال: <b>${int(apify.active_sources)}</b>`);
  lines.push(`• interval: هر <b>${int(apify.rotation_interval_hours)}</b> ساعت`);
  lines.push(`• run ماهانه تخمینی: <b>${int(apify.projected_runs_per_month)}</b>`);
  lines.push(`• میانگین هر run: <b>${usd(apify.avg_cost_per_run_usd)}</b>`);
  lines.push(`• هزینه ماهانه تخمینی: <b>${usd(apify.projected_monthly_cost_usd)}</b>`);
  lines.push('');

  if (!apify.available) {
    lines.push(`دلیل: <code>${escapeHtml(apify.reason ?? 'unknown')}</code>`);
    return;
  }

  lines.push('📊 <b>بازه‌ها</b>');
  for (const row of Array.isArray(apify.windows) ? apify.windows : []) {
    lines.push(
      `• ${escapeHtml(row.label ?? row.key)}: <b>${int(row.runs)}</b> runs / <b>${usd(row.cost_usd)}</b>`
    );
  }
}

function appendHealth(lines: string[], report: AnyRecord): void {
  const current = report.current ?? {};
  const backlog = current.ai_candidate_backlog ?? {};
  const stuckRuns = Array.isArray(current.stuck_processing_runs) ? current.stuck_processing_runs : [];
  const failedRuns = Array.isArray(current.recent_failed_runs) ? current.recent_failed_runs : [];

  lines.push('⚠️ <b>خطاها و وضعیت سلامت</b>');
  lines.push('');
  lines.push('🧠 <b>AI backlog</b>');
  lines.push(`• queued: <b>${int(backlog.queued)}</b>`);
  lines.push(`• rejected: <b>${int(backlog.ai_rejected)}</b>`);
  lines.push(`• pending: <b>${int(backlog.pending)}</b>`);
  lines.push(`• failed: <b>${int(backlog.failed)}</b>`);
  lines.push('');

  lines.push('⏳ <b>processing گیرکرده</b>');
  if (stuckRuns.length === 0) {
    lines.push('• موردی نیست.');
  } else {
    for (const run of stuckRuns.slice(0, 5)) {
      lines.push(`• <code>${escapeHtml(run.id)}</code>`);
      lines.push(`  ${escapeHtml(run.error_message ?? run.status ?? '')}`);
    }
  }

  lines.push('');
  lines.push('❌ <b>failed اخیر</b>');
  if (failedRuns.length === 0) {
    lines.push('• موردی نیست.');
  } else {
    for (const run of failedRuns.slice(0, 5)) {
      lines.push(`• <code>${escapeHtml(run.id)}</code>`);
      lines.push(`  ${escapeHtml(run.error_message ?? run.status ?? '')}`);
    }
  }
}

function appendSources(lines: string[], report: AnyRecord): void {
  const window = findWindow(report, '7d') ?? findWindow(report, '24h') ?? getWindows(report)[0];
  const sources = Array.isArray(window?.top_sources) ? window.top_sources : [];

  lines.push('🏷 <b>منابع برتر</b>');
  lines.push('');
  lines.push(`بازه: <b>${escapeHtml(window?.label ?? 'نامشخص')}</b>`);
  lines.push('');

  if (sources.length === 0) {
    lines.push('داده‌ای برای منابع برتر پیدا نشد.');
    return;
  }

  for (const row of sources.slice(0, 12)) {
    lines.push(
      `• <b>${escapeHtml(row.source_account ?? '__unknown__')}</b>: total ${int(row.total)} | selected ${int(row.selected)} | rate ${pctText(row.select_rate_pct)}`
    );
  }
}

function sectionTitle(section: OperationalReportSection): string {
  const titles: Record<OperationalReportSection, string> = {
    overview: '📌 <b>خلاصه عملیات</b>',
    costs: '💵 <b>گزارش هزینه‌ها</b>',
    pipeline: '🔁 <b>گزارش قیف محتوا</b>',
    publish: '📬 <b>گزارش صف انتشار</b>',
    apify: '🕷 <b>گزارش Apify</b>',
    health: '⚠️ <b>گزارش سلامت سیستم</b>',
    sources: '🏷 <b>گزارش منابع</b>',
  };
  return titles[section];
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

function formatDate(value: unknown): string {
  return safeText(value).replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
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
