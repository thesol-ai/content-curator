import { describe, expect, it } from 'vitest';
import { formatOperationalReportForTelegram } from '../apps/worker-api/src/services/report-message-formatter';

describe('report-message-formatter', () => {
  it('formats operational report JSON into Telegram-safe HTML text', () => {
    const text = formatOperationalReportForTelegram({
      generated_at: '2026-06-10T20:12:41.539Z',
      category_id: 'crypto',
      apify: {
        available: true,
        active_sources: 6,
        projected_runs_per_month: 1440,
        avg_cost_per_run_usd: 0.010623,
        projected_monthly_cost_usd: 15.3,
        windows: [
          { key: '24h', label: '۲۴ ساعت گذشته', runs: 50, cost_usd: 0.51025, projected_monthly_usd: 15.31 },
        ],
      },
      windows: [
        {
          key: '24h',
          label: '۲۴ ساعت گذشته',
          ai: { total_cost_usd: 0.255842, projected_monthly_usd: 7.68 },
          pipeline: {
            fetched: 3505,
            duplicate: 2906,
            fresh: 460,
            duplicate_rate_pct: 82.91,
            ai_selected: 29,
            ai_rejected: 133,
            queued: 29,
          },
          publish: { published: 49, scheduled: 30 },
        },
      ],
      current: {
        publish_queue_active: { scheduled: 30 },
        ai_candidate_backlog: { queued: 105, ai_rejected: 373 },
        stuck_processing_runs: [{ id: 'run_1' }],
        recent_failed_runs: [],
        top_pending_accounts: [{ source_account: 'CoinDesk', count: 4 }],
      },
    });

    expect(text).toContain('📊 <b>گزارش عملیات</b>');
    expect(text).toContain('۲۴ ساعت گذشته');
    expect(text).toContain('💵 AI: <b>$0.26</b>');
    expect(text).toContain('🕷 Apify: <b>$0.51</b>');
    expect(text).toContain('اسکرپ: <b>3,505</b>');
    expect(text).toContain('CoinDesk');
    expect(text).not.toContain('<script>');
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
    });

    expect(text.length).toBeLessThanOrEqual(3900);
    expect(text).toContain('خروجی کوتاه شد');
  });
});
