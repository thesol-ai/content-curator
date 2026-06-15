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

function makeEnv() {
  const sources = SOURCE_IDS.map(id => ({
    id,
    label: id,
    category_id: 'crypto',
    platform: 'x',
    apify_task_id: `task_${id}`,
  }));

  return {
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
}

function combinedSearch(plan: any): string {
  const terms = plan.inputOverride.searchTerms;
  expect(Array.isArray(terms)).toBe(true);
  return terms.map(String).join(' ');
}

describe('generic low-quality exclusions for crypto source queries', () => {
  it('adds broad anti-marketing exclusions to every crypto rotation query', async () => {
    const result = await runApifyRotation(makeEnv(), { force: true, dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.plans).toHaveLength(SOURCE_IDS.length);

    for (const plan of result.plans) {
      const query = combinedSearch(plan);
      expect(query).toContain('-giveaway');
      expect(query).toContain('-campaign');
      expect(query).toContain('-voucher');
      expect(query).toContain('-"get access"');
      expect(query).toContain('-"watch the full interview"');
      expect(query).toContain('-"retail access"');
      expect(query).toContain('-"private assets"');
    }
  });
});
