import { describe, expect, it } from 'vitest';
import { runApifyRotation } from '../apps/worker-api/src/services/apify-rotation-runner';

const SOURCE_IDS = [
  'src_crypto_x_news_media',
  'src_crypto_x_news_text',
  'src_crypto_x_voices_media',
  'src_crypto_x_voices_text',
  'src_market_trending_x_media',
  'src_market_trending_x_text',
];

const EXPECTED_MAX_ITEMS_BY_SOURCE: Record<string, number> = {
  src_crypto_x_news_media: 18,
  src_crypto_x_news_text: 18,
  src_crypto_x_voices_media: 8,
  src_crypto_x_voices_text: 16,
  src_market_trending_x_media: 10,
  src_market_trending_x_text: 10,
};

function makeEnv() {
  const sources = SOURCE_IDS.map(id => ({
    id,
    label: id,
    category_id: 'crypto',
    platform: 'x',
    apify_task_id: `task_${id}`,
  }));

  const env = {
    APIFY_ROTATION_ENABLED: 'true',
    APIFY_ROTATION_INTERVAL_HOURS: '3',
    APIFY_ROTATION_MAX_SOURCES_PER_TICK: '2',
    APIFY_ROTATION_WAIT_FOR_FINISH_SECONDS: '60',
    DB: {
      prepare: (sql: string) => {
        const stmt = {
          bind: () => stmt,
          first: async () => null,
          all: async () => {
            if (sql.includes('FROM apify_sources')) return { results: sources };
            return { results: [] };
          },
          run: async () => ({ meta: { changes: 1 } }),
        };
        return stmt;
      },
    },
  } as any;

  return env;
}

function bySource(result: any, sourceId: string): any {
  const plan = result.plans.find((p: any) => p.sourceId === sourceId);
  if (!plan) throw new Error(`missing plan for ${sourceId}`);
  return plan;
}

describe('Phase 10 crypto input quality Apify rotation queries', () => {
  it('keeps rotation bounded with existing six source ids and lower noisy-source maxItems', async () => {
    const result = await runApifyRotation(makeEnv(), { force: true, dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.plans).toHaveLength(6);
    expect(result.plans.map((p: any) => p.sourceId).sort()).toEqual([...SOURCE_IDS].sort());

    for (const plan of result.plans) {
      const query = String(plan.inputOverride.query);

      expect(plan.inputOverride.maxItems).toBe(EXPECTED_MAX_ITEMS_BY_SOURCE[plan.sourceId]);
      expect(plan.inputOverride.maxItems).toBeLessThanOrEqual(18);
      expect(plan.inputOverride.queryType).toBe('Latest');
      expect(plan.inputOverride.lang).toBe('en');
      expect(plan.inputOverride.query).toBe(plan.inputOverride.twitterContent);
      expect(plan.inputOverride.searchTerms).toBeUndefined();
      expect(String(plan.inputOverride.since_time)).toMatch(/^\d{10}$/);

      expect(query).toContain('from:');
      expect((query.match(/-filter:replies/g) ?? []).length).toBe(1);
      expect((query.match(/\blang:en\b/g) ?? []).length).toBe(1);
      expect((query.match(/min_faves:/g) ?? []).length).toBeLessThanOrEqual(1);
    }
  });

  it('uses clean trusted-profile primaries while preserving strict security gates', async () => {
    const result = await runApifyRotation(makeEnv(), { force: true, dryRun: true });

    const newsText = bySource(result, 'src_crypto_x_news_text');
    expect(newsText.cohortName).toContain('core_news_text');
    expect(String(newsText.inputOverride.query)).toContain('from:');
    expect(String(newsText.inputOverride.query)).toContain('-filter:media');
    expect(String(newsText.inputOverride.query)).not.toContain('crypto OR bitcoin');
    expect(String(newsText.inputOverride.query)).not.toContain('stablecoin');
    expect(String(newsText.inputOverride.query)).toContain('-giveaway');
    expect(String(newsText.inputOverride.query)).toContain('-campaign');

    const newsMedia = bySource(result, 'src_crypto_x_news_media');
    expect(String(newsMedia.inputOverride.query)).toContain('filter:media');
    expect(String(newsMedia.inputOverride.query)).not.toContain('digital asset');
    expect(String(newsMedia.inputOverride.query)).toContain('-voucher');

    const voicesText = bySource(result, 'src_crypto_x_voices_text');
    expect(voicesText.cohortName).toContain('expert_signals_text');
    expect(String(voicesText.inputOverride.query)).toContain('from:');
    expect(String(voicesText.inputOverride.query)).not.toContain('USDT');
    expect(String(voicesText.inputOverride.query)).not.toContain('from:whale_alert');

    const security = bySource(result, 'src_crypto_x_voices_media');
    expect(security.cohortName).toContain('security_alert_text');
    expect(security.accounts).toEqual(['zachxbt', 'PeckShieldAlert', 'SlowMist_Team', 'CyversAlerts']);
    expect(String(security.inputOverride.query)).toContain('"crypto hack"');
    expect(String(security.inputOverride.query)).toContain('"DeFi hack"');
    expect(String(security.inputOverride.query)).toContain('"protocol exploit"');
    expect(String(security.inputOverride.query)).toContain('"smart contract exploit"');
    expect(String(security.inputOverride.query)).toContain('crypto OR DeFi OR protocol');
    expect(String(security.inputOverride.query)).not.toContain('hack OR hacked OR exploit');
    expect(String(security.inputOverride.query)).toContain('-pypi');
    expect(String(security.inputOverride.query)).toContain('-npm');
    expect(String(security.inputOverride.query)).toContain('-python');
    expect(String(security.inputOverride.query)).toContain('-bun');

    const market = bySource(result, 'src_market_trending_x_text');
    expect(market.cohortName).toContain('market_impact_text');
    expect(String(market.inputOverride.query)).toContain('from:');
    expect(String(market.inputOverride.query)).not.toContain('ETF OR "spot ETF"');
    expect(String(market.inputOverride.query)).toContain('-giveaway');

    const tokenProject = bySource(result, 'src_market_trending_x_media');
    expect(tokenProject.cohortName).toContain('token_project_watch_text');
    expect(String(tokenProject.inputOverride.query)).toContain('from:');
    expect(String(tokenProject.inputOverride.query)).not.toContain('"mainnet" OR "testnet"');
    expect(String(tokenProject.inputOverride.query)).toContain('-"get access"');
  });
});
