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
  src_crypto_x_news_media: 30,
  src_crypto_x_news_text: 30,
  src_crypto_x_voices_media: 24,
  src_crypto_x_voices_text: 24,
  src_market_trending_x_media: 20,
  src_market_trending_x_text: 20,
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

function searchTermsFor(plan: any): string[] {
  const terms = plan.inputOverride.searchTerms;
  expect(Array.isArray(terms)).toBe(true);
  return terms.map(String);
}

function combinedSearch(plan: any): string {
  return searchTermsFor(plan).join(' ');
}

describe('Phase 10 crypto input quality Apify rotation queries', () => {
  it('keeps rotation bounded with existing six source ids and current source-specific maxItems', async () => {
    const result = await runApifyRotation(makeEnv(), { force: true, dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.plans).toHaveLength(6);
    expect(result.plans.map((p: any) => p.sourceId).sort()).toEqual([...SOURCE_IDS].sort());

    for (const plan of result.plans) {
      const terms = searchTermsFor(plan);
      const query = terms[0] ?? '';

      expect(plan.inputOverride.maxItems).toBe(EXPECTED_MAX_ITEMS_BY_SOURCE[plan.sourceId]);
      expect(plan.inputOverride.maxItems).toBeLessThanOrEqual(30);
      expect(plan.inputOverride.queryType).toBe('Latest');
      expect(plan.inputOverride.lang).toBe('en');

      expect(plan.inputOverride.query).toBeUndefined();
      expect(plan.inputOverride.twitterContent).toBe('');

      if (plan.sourceId === 'src_market_trending_x_media') {
        expect(String(plan.inputOverride.since_time)).toMatch(/^\d{10}$/);
      } else {
        expect(String(plan.inputOverride.since_time)).toMatch(/^\d{10}$/);
      }

      expect(query).toContain('from:');
      if (plan.sourceId === 'src_market_trending_x_media') {
        expect(query).not.toContain('since:');
        expect(query).not.toContain('until:');
      } else {
        expect(query).not.toContain('since:');
        expect(query).not.toContain('until:');
      }
      expect((query.match(/-filter:replies/g) ?? []).length).toBe(1);
      expect((query.match(/\blang:en\b/g) ?? []).length).toBe(1);
      expect((query.match(/min_faves:/g) ?? []).length).toBe(0);
    }
  });

  it('uses clean trusted-profile primaries while preserving strict security gates', async () => {
    const result = await runApifyRotation(makeEnv(), { force: true, dryRun: true });

    const newsText = bySource(result, 'src_crypto_x_news_text');
    const newsTextQuery = combinedSearch(newsText);
    expect(newsText.cohortName).toContain('core_news_text');
    expect(newsTextQuery).toContain('from:');
    expect(newsTextQuery).toContain('-filter:media');
    expect(newsTextQuery).not.toContain('crypto OR bitcoin');
    expect(newsTextQuery).not.toContain('stablecoin');
    expect(newsTextQuery).toContain('-giveaway');
    expect(newsTextQuery).toContain('-campaign');

    const newsMedia = bySource(result, 'src_crypto_x_news_media');
    const newsMediaQuery = combinedSearch(newsMedia);
    expect(newsMediaQuery).toContain('filter:media');
    expect(newsMediaQuery).not.toContain('digital asset');
    expect(newsMediaQuery).toContain('-voucher');

    const voicesText = bySource(result, 'src_crypto_x_voices_text');
    const voicesTextQuery = combinedSearch(voicesText);
    expect(voicesText.cohortName).toContain('expert_signals_text');
    expect(voicesTextQuery).toContain('from:');
    expect(voicesTextQuery).not.toContain('USDT');
    expect(voicesTextQuery).not.toContain('from:whale_alert');

    const voicesMedia = bySource(result, 'src_crypto_x_voices_media');
    const voicesMediaQuery = combinedSearch(voicesMedia);
    expect(voicesMedia.cohortName).toContain('expert_signals_media');
    expect(voicesMedia.accounts.length).toBeGreaterThan(0);
    expect(voicesMediaQuery).toContain('from:');
    expect(voicesMediaQuery).toContain('filter:media');
    expect(voicesMediaQuery).not.toContain('-filter:media');
    expect(voicesMediaQuery).not.toContain('"crypto hack"');
    expect(voicesMediaQuery).toContain('-giveaway');
    expect(voicesMediaQuery).toContain('-campaign');

    const market = bySource(result, 'src_market_trending_x_text');
    const marketQuery = combinedSearch(market);
    expect(market.cohortName).toContain('market_impact_text');
    expect(marketQuery).toContain('from:');
    expect(marketQuery).not.toContain('ETF OR "spot ETF"');
    expect(marketQuery).toContain('-giveaway');

    const marketMedia = bySource(result, 'src_market_trending_x_media');
    const marketMediaQuery = combinedSearch(marketMedia);
    expect(marketMedia.cohortName).toContain('market_impact_media');
    expect(marketMediaQuery).toContain('from:');
    expect(marketMediaQuery).toContain('filter:media');
    expect(marketMediaQuery).not.toContain('-filter:media');
  });
});
