import { describe, expect, it } from 'vitest';
import { formatOperationalReportForTelegram } from '../apps/worker-api/src/services/report-message-formatter';

const sampleReport = {
  generated_at: '2026-06-10T20:12:41.539Z',
  category_id: 'crypto',
  apify: {
    available: true,
    active_sources: 6,
    rotation_interval_hours: 3,
    projected_runs_per_month: 1440,
    avg_cost_per_run_usd: 0.010623,
    projected_monthly_cost_usd: 15.3,
    windows: [
      { key: '24h', label: '۲۴ ساعت گذشته', runs: 50, cost_usd: 0.51025, projected_monthly_usd: 15.31 },
      { key: '7d', label: '۷ روز گذشته', runs: 153, cost_usd: 1.62525, projected_monthly_usd: 6.97 },
    ],
  },
  windows: [
    {
      key: '24h',
      label: '۲۴ ساعت گذشته',
      ai: {
        total_cost_usd: 0.255842,
        projected_monthly_usd: 7.68,
        rows: [{ provider: 'anthropic', purpose: 'scoring', calls: 54, cost_usd: 0.230669 }],
      },
      pipeline: {
        fetched: 3505,
        duplicate: 2906,
        fresh: 460,
        duplicate_rate_pct: 82.91,
        fresh_rate_pct: 13.12,
        ai_selected: 29,
        ai_rejected: 133,
        queued: 29,
      },
      publish: { published: 49, scheduled: 30, failed: 0 },
      top_sources: [{ source_account: 'CoinDesk', total: 10, selected: 6, select_rate_pct: 60 }],
    },
    {
      key: '7d',
      label: '۷ روز گذشته',
      ai: { total_cost_usd: 0.930465, projected_monthly_usd: 3.99 },
      pipeline: {
        fetched: 7381,
        duplicate: 5728,
        fresh: 1505,
        duplicate_rate_pct: 77.6,
        fresh_rate_pct: 20.39,
        ai_selected: 175,
        ai_rejected: 546,
        queued: 151,
      },
      publish: { published: 198, scheduled: 30, failed: 0 },
      top_sources: [{ source_account: 'Cointelegraph', total: 288, selected: 99, select_rate_pct: 34.38 }],
    },
  ],
  current: {
    publish_queue_active: { scheduled: 30, retry: 0, failed: 0 },
    ai_candidate_backlog: { queued: 105, ai_rejected: 373, pending: 0, failed: 0 },
    stuck_processing_runs: [{ id: 'run_1', error_message: 'processing phase=drain_ai_candidate_backlog' }],
    recent_failed_runs: [{ id: 'run_2', error_message: 'Apify fetch failed 404' }],
  },
};

describe('report-message-formatter', () => {
  it('formats a compact overview instead of dumping every operational section', () => {
    const text = formatOperationalReportForTelegram(sampleReport, 'overview');

    expect(text).toContain('📌 <b>خلاصه عملیات</b>');
    expect(text).toContain('۲۴ ساعت گذشته');
    expect(text).toContain('۷ روز گذشته');
    expect(text).toContain('Apify ماهانه تخمینی');
    expect(text).not.toContain('گزارش قیف محتوا');
    expect(text).not.toContain('گزارش منابع');
  });

  it('formats the costs section separately', () => {
    const text = formatOperationalReportForTelegram(sampleReport, 'costs');

    expect(text).toContain('💵 <b>گزارش هزینه‌ها</b>');
    expect(text).toContain('AI مصرف‌شده');
    expect(text).toContain('Apify مصرف‌شده');
    expect(text).toContain('anthropic');
    expect(text).not.toContain('صف و انتشار');
  });

  it('formats the pipeline section separately', () => {
    const text = formatOperationalReportForTelegram(sampleReport, 'pipeline');

    expect(text).toContain('🔁 <b>گزارش قیف محتوا</b>');
    expect(text).toContain('اسکرپ‌شده');
    expect(text).toContain('تکراری');
    expect(text).not.toContain('گزارش هزینه‌ها');
  });

  it('formats the health section separately', () => {
    const text = formatOperationalReportForTelegram(sampleReport, 'health');

    expect(text).toContain('⚠️ <b>گزارش سلامت سیستم</b>');
    expect(text).toContain('run_1');
    expect(text).toContain('run_2');
    expect(text).not.toContain('گزارش منابع');
  });

  it('truncates very long reports to stay under Telegram message limits', () => {
    const text = formatOperationalReportForTelegram({
      generated_at: 'x'.repeat(10000),
      windows: Array.from({ length: 100 }, (_, index) => ({
        key: `w${index}`,
        label: `window ${index}`,
        ai: { total_cost_usd: 1, projected_monthly_usd: 2 },
        pipeline: { fetched: 1, duplicate: 1, fresh: 1, ai_selected: 1, ai_rejected: 1, queued: 1 },
        publish: { published: 1, scheduled: 1 },
      })),
      current: {},
      apify: {},
    }, 'pipeline');

    expect(text.length).toBeLessThanOrEqual(3900);
    expect(text).toContain('خروجی کوتاه شد');
  });
});
