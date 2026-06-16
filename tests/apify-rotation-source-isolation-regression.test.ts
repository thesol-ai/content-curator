import { describe, expect, it } from 'vitest';
import { runApifyRotation } from '../apps/worker-api/src/services/apify-rotation-runner';

const CURRENT_ROTATION_SOURCE_IDS = [
  'src_crypto_x_news_media',
  'src_crypto_x_news_text',
  'src_crypto_x_voices_media',
  'src_crypto_x_voices_text',
  'src_market_trending_x_media',
  'src_market_trending_x_text',
];

function makeEnv(extraSources: any[] = []) {
  const sources = [
    ...CURRENT_ROTATION_SOURCE_IDS.map(id => ({
      id,
      label: id,
      category_id: 'crypto',
      platform: 'x',
      apify_task_id: `task_${id}`,
    })),
    ...extraSources,
  ];

  return {
    APIFY_ROTATION_ENABLED: 'true',
    APIFY_ROTATION_INTERVAL_HOURS: '3',
    APIFY_ROTATION_MAX_SOURCES_PER_TICK: '20',
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

function searchTermsFor(plan: any): string[] {
  const terms = plan.inputOverride.searchTerms;
  expect(Array.isArray(terms)).toBe(true);
  return terms.map(String);
}

describe('Apify rotation source isolation regression safety net', () => {
  it('ignores unknown or future-category source ids instead of planning them', async () => {
    const result = await runApifyRotation(makeEnv([
      {
        id: 'src_movie_x_news_text',
        label: 'movie-x-news-text',
        category_id: 'movie',
        platform: 'x',
        apify_task_id: 'task_movie',
      },
    ]), { force: true, dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.plans.map((p: any) => p.sourceId).sort())
      .toEqual([...CURRENT_ROTATION_SOURCE_IDS].sort());
    expect(result.plans.some((p: any) => p.sourceId === 'src_movie_x_news_text'))
      .toBe(false);
  });

  it('preserves reply exclusion and latest English discovery inputs for all current X rotation plans', async () => {
    const result = await runApifyRotation(makeEnv(), { force: true, dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.plans).toHaveLength(CURRENT_ROTATION_SOURCE_IDS.length);

    for (const plan of result.plans) {
      const terms = searchTermsFor(plan);
      const query = terms[0] ?? '';

      expect(plan.inputOverride.query).toBeUndefined();
      expect(plan.inputOverride.twitterContent).toBe('');
      expect(plan.inputOverride.queryType).toBe('Latest');
      expect(plan.inputOverride.lang).toBe('en');
      expect(String(plan.inputOverride.since_time)).toMatch(/^\d{10}$/);

      expect(query).toContain('from:');
      expect(query).not.toContain('since:');
      expect(query).not.toContain('until:');
      expect((query.match(/-filter:replies/g) ?? []).length).toBe(1);
      expect((query.match(/\blang:en\b/g) ?? []).length).toBe(1);
    }
  });
});
