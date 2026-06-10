import { describe, expect, it } from 'vitest';
import { formatOperationalReportForTelegram } from '../apps/worker-api/src/services/report-message-formatter';

const sampleReport = {
  generated_at: '2026-06-10T20:12:41.539Z',
  currency: 'USD',
  channel_id: 'crypto_fa_pilot',
  category_id: 'crypto',
  platform: 'x',
  current: {
    publish_queue_active: {
      scheduled: 41,
      retry: 1,
      failed: 0,
    },
    ai_candidate_backlog: {
      queued: 116,
      pending: 1,
      ai_rejected: 376,
      failed: 2,
    },
    top_pending_accounts: [
      { source_account: 'CoinDesk', count: 12 },
      { source_account: 'Cointelegraph', count: 9 },
    ],
    stuck_processing_runs: [
      { id: 'run_stuck', platform: 'x', created_at: '2026-06-10 19:00:00' },
    ],
    recent_failed_runs: [
      { id: 'run_failed', platform: 'x', created_at: '2026-06-10 19:10:00', error_message: 'Apify 404' },
    ],
  },
  apify: {
    available: true,
    active_sources: 6,
    rotation_interval_hours: 3,
    projected_runs_per_month: 1440,
    fetched_runs: 153,
    avg_cost_per_run_usd: 0.01062,
    projected_monthly_cost_usd: 15.3,
    windows: [
      { key: '24h', runs: 48, cost_usd: 0.51, projected_monthly_usd: 15.3 },
      { key: '7d', runs: 153, cost_usd: 1.63, projected_monthly_usd: 6.98 },
      { key: '30d', runs: 153, cost_usd: 1.63, projected_monthly_usd: 1.63 },
    ],
  },
  windows: [
    {
      key: '24h',
      ai: {
        total_cost_usd: 0.255842,
        projected_monthly_usd: 7.68,
        rows: [
          { provider: 'anthropic', purpose: 'scoring', model: 'claude-haiku-4-5-20251001', calls: 54, input_tokens: 147854, output_tokens: 16563, cost_usd: 0.230669, projected_monthly_usd: 6.92 },
          { provider: 'gemini', purpose: 'translation', model: 'gemini-2.5-flash-lite', calls: 43, input_tokens: 81807, output_tokens: 42481, cost_usd: 0.025173, projected_monthly_usd: 0.76 },
        ],
      },
      pipeline: {
        fetched: 3409,
        fresh: 446,
        duplicate: 2830,
        ai_selected: 30,
        ai_rejected: 134,
        queued: 30,
        fresh_rate_pct: 13.08,
        duplicate_rate_pct: 83.02,
      },
      publish: {
        published: 43,
        scheduled: 41,
        failed: 0,
      },
      top_sources: [
        { source_account: 'CoinDesk', total: 74, selected: 45, rejected: 20, queued: 9, select_rate_pct: 60.81 },
        { source_account: 'Cointelegraph', total: 297, selected: 102, rejected: 150, queued: 45, select_rate_pct: 34.34 },
      ],
    },
    {
      key: '7d',
      ai: {
        total_cost_usd: 0.930465,
        projected_monthly_usd: 3.99,
        rows: [
          { provider: 'anthropic', purpose: 'scoring', model: 'claude-haiku-4-5-20251001', calls: 191, input_tokens: 491000, output_tokens: 67163, cost_usd: 0.826814, projected_monthly_usd: 3.54 },
          { provider: 'gemini', purpose: 'translation', model: 'gemini-2.5-flash-lite', calls: 164, input_tokens: 282000, output_tokens: 188000, cost_usd: 0.103651, projected_monthly_usd: 0.44 },
        ],
      },
      pipeline: {
        fetched: 12488,
        fresh: 1660,
        duplicate: 10400,
        ai_selected: 204,
        ai_rejected: 780,
        queued: 198,
        fresh_rate_pct: 13.29,
        duplicate_rate_pct: 83.28,
      },
      publish: {
        published: 198,
        scheduled: 41,
        failed: 0,
      },
      top_sources: [
        { source_account: 'CoinDesk', total: 300, selected: 180, rejected: 80, queued: 40, select_rate_pct: 60 },
        { source_account: 'Cointelegraph', total: 900, selected: 300, rejected: 500, queued: 100, select_rate_pct: 33.33 },
      ],
    },
    {
      key: '30d',
      ai: {
        total_cost_usd: 1.3,
        projected_monthly_usd: 1.3,
        rows: [],
      },
      pipeline: {
        fetched: 20000,
        fresh: 2200,
        duplicate: 17000,
        ai_selected: 310,
        ai_rejected: 1200,
        queued: 299,
      },
      publish: {
        published: 299,
        scheduled: 41,
        failed: 0,
      },
      top_sources: [],
    },
  ],
};

describe('report-message-formatter command center sections', () => {
  it('formats system status monitoring', () => {
    const text = formatOperationalReportForTelegram(sampleReport, 'monitoring_status');

    expect(text).toContain('🟢 <b>System Status</b>');
    expect(text).toContain('<code>crypto_fa_pilot</code>');
    expect(text).toContain('Live Summary');
    expect(text).toContain('recent failures');
  });

  it('formats queue health separately', () => {
    const text = formatOperationalReportForTelegram(sampleReport, 'queue_health');

    expect(text).toContain('📬 <b>Queue Health</b>');
    expect(text).toContain('Publish Queue');
    expect(text).toContain('AI Backlog');
    expect(text).toContain('Top Pending Accounts');
  });

  it('formats cost summary and cost watch', () => {
    const costs = formatOperationalReportForTelegram(sampleReport, 'costs');
    const watch = formatOperationalReportForTelegram(sampleReport, 'cost_watch');

    expect(costs).toContain('💸 <b>Cost Summary</b>');
    expect(costs).toContain('AI scope');
    expect(costs).toContain('- Total:');

    expect(watch).toContain('💰 <b>Cost Watch</b>');
    expect(watch).toContain('total monthly projection');
  });

  it('formats provider costs compactly', () => {
    const anthropic = formatOperationalReportForTelegram(sampleReport, 'costs_anthropic');
    const gemini = formatOperationalReportForTelegram(sampleReport, 'costs_gemini');

    expect(anthropic).toContain('🟣 <b>Anthropic / Claude</b>');
    expect(anthropic).toContain('Anthropic / Claude Cost');
    expect(anthropic).toContain('Last 24h');
    expect(anthropic).toContain('Main models');

    expect(gemini).toContain('🔵 <b>Gemini</b>');
    expect(gemini).toContain('Gemini Cost');
    expect(gemini).toContain('7d tokens');
  });

  it('formats source health and AI quality', () => {
    const source = formatOperationalReportForTelegram(sampleReport, 'source_health');
    const ai = formatOperationalReportForTelegram(sampleReport, 'ai_quality');

    expect(source).toContain('📡 <b>Source Health</b>');
    expect(source).toContain('best source');
    expect(source).toContain('CoinDesk');

    expect(ai).toContain('🧠 <b>AI Quality</b>');
    expect(ai).toContain('selected');
    expect(ai).toContain('rejection_reason');
  });

  it('formats operations-adjacent reporting placeholders without lying', () => {
    const editorial = formatOperationalReportForTelegram(sampleReport, 'editorial');
    const market = formatOperationalReportForTelegram(sampleReport, 'market_snapshot');
    const budget = formatOperationalReportForTelegram(sampleReport, 'budget_alerts');

    expect(editorial).toContain('📰 <b>Editorial Output</b>');
    expect(editorial).toContain('Next telemetry to add');

    expect(market).toContain('📈 <b>Market Snapshot</b>');
    expect(market).toContain('configured outside');

    expect(budget).toContain('🚨 <b>Budget Alerts</b>');
    expect(budget).toContain('Thresholds are not persisted yet');
  });

  it('truncates very long reports to stay under Telegram message limits', () => {
    const huge = {
      ...sampleReport,
      windows: [
        {
          ...sampleReport.windows[0],
          top_sources: Array.from({ length: 500 }, (_, index) => ({
            source_account: `source_${index}`,
            total: 100,
            selected: 20,
            rejected: 80,
            queued: 0,
            select_rate_pct: 20,
          })),
        },
      ],
    };

    const text = formatOperationalReportForTelegram(huge, 'sources');
    expect(text.length).toBeLessThanOrEqual(3900);
  });
});
