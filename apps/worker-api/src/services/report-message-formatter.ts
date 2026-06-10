type AnyRecord = Record<string, any>;

export function formatOperationalReportForTelegram(report: AnyRecord): string {
  const generatedAt = safeText(report.generated_at ?? new Date().toISOString());
  const categoryId = report.category_id ? safeText(report.category_id) : 'همه دسته‌ها';
  const windows = Array.isArray(report.windows) ? report.windows : [];
  const apifyWindows = new Map<string, AnyRecord>(
    Array.isArray(report.apify?.windows)
      ? report.apify.windows.map((row: AnyRecord) => [String(row.key), row])
      : []
  );

  const lines: string[] = [
    '📊 <b>گزارش عملیات</b>',
    `دسته: <code>${escapeHtml(categoryId)}</code>`,
    `زمان تولید: <code>${escapeHtml(generatedAt)}</code>`,
    '',
  ];

  for (const window of windows) {
    const key = String(window.key ?? '');
    const apify = apifyWindows.get(key);
    const ai = window.ai ?? {};
    const pipeline = window.pipeline ?? {};
    const publish = window.publish ?? {};

    lines.push(`⏱ <b>${escapeHtml(window.label ?? key)}</b>`);

    lines.push(
      `💵 AI: <b>${usd(ai.total_cost_usd)}</b> / پیش‌بینی ماهانه: <b>${usd(ai.projected_monthly_usd)}</b>`
    );

    if (apify) {
      lines.push(
        `🕷 Apify: <b>${usd(apify.cost_usd)}</b> / runs: <b>${int(apify.runs)}</b> / ماهانه: <b>${usd(apify.projected_monthly_usd)}</b>`
      );
    }

    lines.push(
      `🔁 اسکرپ: <b>${int(pipeline.fetched)}</b> | جدید: <b>${int(pipeline.fresh)}</b> | تکراری: <b>${int(pipeline.duplicate)}</b> (${pctText(pipeline.duplicate_rate_pct)})`
    );

    lines.push(
      `🤖 AI قبول/رد: <b>${int(pipeline.ai_selected)}</b>/<b>${int(pipeline.ai_rejected)}</b> | queued: <b>${int(pipeline.queued)}</b>`
    );

    lines.push(
      `📬 انتشار: published <b>${int(publish.published)}</b> | scheduled <b>${int(publish.scheduled)}</b> | failed <b>${int(publish.failed)}</b>`
    );

    lines.push('');
  }

  const current = report.current ?? {};
  const activeQueue = current.publish_queue_active ?? {};
  const backlog = current.ai_candidate_backlog ?? {};
  const stuckRuns = Array.isArray(current.stuck_processing_runs) ? current.stuck_processing_runs : [];
  const recentFailed = Array.isArray(current.recent_failed_runs) ? current.recent_failed_runs : [];

  lines.push('📌 <b>وضعیت فعلی</b>');
  lines.push(
    `صف انتشار: scheduled <b>${int(activeQueue.scheduled)}</b> | retry <b>${int(activeQueue.retry)}</b> | failed <b>${int(activeQueue.failed)}</b>`
  );
  lines.push(
    `Backlog: pending <b>${int(backlog.pending)}</b> | queued <b>${int(backlog.queued)}</b> | rejected <b>${int(backlog.ai_rejected)}</b> | failed <b>${int(backlog.failed)}</b>`
  );
  lines.push(
    `گیرکرده processing: <b>${stuckRuns.length}</b> | failed اخیر: <b>${recentFailed.length}</b>`
  );

  if (Array.isArray(current.top_pending_accounts) && current.top_pending_accounts.length > 0) {
    lines.push('');
    lines.push('🏷 <b>Top pending sources</b>');
    for (const row of current.top_pending_accounts.slice(0, 5)) {
      lines.push(`• ${escapeHtml(row.source_account ?? '__unknown__')}: <b>${int(row.count)}</b>`);
    }
  }

  const apifySummary = report.apify ?? {};
  lines.push('');
  lines.push('🕷 <b>Apify</b>');
  lines.push(
    `active sources: <b>${int(apifySummary.active_sources)}</b> | projected runs/month: <b>${int(apifySummary.projected_runs_per_month)}</b>`
  );

  if (apifySummary.available) {
    lines.push(
      `avg/run: <b>${usd(apifySummary.avg_cost_per_run_usd)}</b> | projected/month: <b>${usd(apifySummary.projected_monthly_cost_usd)}</b>`
    );
  } else {
    lines.push(`status: <code>${escapeHtml(apifySummary.reason ?? 'unavailable')}</code>`);
  }

  const text = lines.join('\n').trim();
  return text.length <= 3900 ? text : text.slice(0, 3850) + '\n\n…خروجی کوتاه شد.';
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
