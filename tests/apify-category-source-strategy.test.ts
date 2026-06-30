import { describe, expect, it } from 'vitest';
import { getCategorySourceStrategy } from '../apps/worker-api/src/categories/registry';
import {
  buildCryptoRotationAttempts,
  buildCryptoRotationPlan,
  CRYPTO_ROTATION_SOURCE_IDS,
  cryptoSourceStrategy,
} from '../apps/worker-api/src/categories/crypto/sources';
import { runApifyRotation } from '../apps/worker-api/src/services/apify-rotation-runner';

const CURRENT_ROTATION_SOURCE_IDS = [
  'src_crypto_x_news_media',
  'src_crypto_x_news_text',
  'src_crypto_x_voices_media',
  'src_crypto_x_voices_text',
  'src_market_trending_x_media',
  'src_market_trending_x_text',
];

// v4.1: discovery lanes were added to CRYPTO_ROTATION_SOURCE_IDS as opt-in sources.
// They only produce rotation plans when present as ENABLED apify_sources rows
// (seeded enabled=0 by default), so they are NOT in the planned-set assertions
// below — only in the registry membership check.
const DISCOVERY_ROTATION_SOURCE_IDS = [
  'src_crypto_x_discovery_latest',
  'src_crypto_x_discovery_top',
];

const V2_ROTATION_SOURCE_IDS = [
  'crypto_v2_news_a',
  'crypto_v2_news_b',
  'crypto_v2_market',
  'crypto_v2_analysts',
];

const ALL_REGISTERED_ROTATION_SOURCE_IDS = [
  ...CURRENT_ROTATION_SOURCE_IDS,
  ...DISCOVERY_ROTATION_SOURCE_IDS,
  ...V2_ROTATION_SOURCE_IDS,
];

function source(id: string, overrides: Partial<any> = {}) {
  return {
    id,
    label: id,
    category_id: 'crypto',
    platform: 'x',
    apify_task_id: `task_${id}`,
    ...overrides,
  } as any;
}

function makeEnv(extraSources: any[] = []) {
  const sources = [
    ...CURRENT_ROTATION_SOURCE_IDS.map(id => source(id)),
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

describe('category source strategy registry', () => {
  it('registers current crypto rotation source ids and gives unknown categories a no-op strategy', () => {
    expect([...CRYPTO_ROTATION_SOURCE_IDS].sort()).toEqual([...ALL_REGISTERED_ROTATION_SOURCE_IDS].sort());

    const cryptoStrategy = getCategorySourceStrategy('crypto');
    expect(cryptoStrategy.id).toBe('crypto');
    expect(cryptoStrategy.canHandleSource(source('src_crypto_x_news_text'))).toBe(true);

    const defaultStrategy = getCategorySourceStrategy('unregistered');
    expect(defaultStrategy.id).toBe('default');
    expect(defaultStrategy.canHandleSource(source('src_unregistered_x_news_text', {
      category_id: 'unregistered',
      platform: 'x',
    }))).toBe(false);
    expect(defaultStrategy.buildRotationPlan(source('src_unregistered_x_news_text', {
      category_id: 'unregistered',
      platform: 'x',
    }), 123)).toBeNull();
  });

  it('builds a crypto rotation plan for every current source id and no plan for mismatched category/platform', () => {
    for (const id of CURRENT_ROTATION_SOURCE_IDS) {
      const plan = cryptoSourceStrategy.buildRotationPlan(source(id), 123);
      expect(plan).not.toBeNull();
      expect(plan?.source.id).toBe(id);
      const terms = plan?.inputOverride.searchTerms as unknown[];
      expect(plan?.inputOverride.query).toBeUndefined();
      expect(plan?.inputOverride.twitterContent).toBe('');
      expect(Array.isArray(terms)).toBe(true);
      expect(terms.length).toBeGreaterThan(0);
      expect(plan?.inputOverride.queryType).toBe('Latest');
      expect(plan?.inputOverride.lang).toBe('en');
    }

    expect(cryptoSourceStrategy.canHandleSource(source('src_crypto_x_news_text', {
      category_id: 'unregistered',
    }))).toBe(false);

    expect(cryptoSourceStrategy.canHandleSource(source('src_crypto_x_news_text', {
      platform: 'rss',
    }))).toBe(false);

    expect(buildCryptoRotationPlan(source('src_unknown_crypto_source'), 123)).toBeNull();
  });

  it('preserves crypto fallback attempts and their safe discovery inputs', () => {
    const plan = buildCryptoRotationPlan(source('src_crypto_x_news_text'), 123);
    expect(plan).not.toBeNull();

    const attempts = buildCryptoRotationAttempts(plan!);
    expect(attempts.map(a => a.attempt)).toEqual([
      'primary',
      'same_accounts_profile_24h',
      'source_rescue_pool_24h',
    ]);

    for (const attempt of attempts) {
      const input = attempt.inputOverride;
      const terms = input.searchTerms as unknown[];
      const firstTerm = String(terms[0] ?? '');

      expect(input.query).toBeUndefined();
      expect(input.twitterContent).toBe('');
      expect(Array.isArray(terms)).toBe(true);
      expect(input.queryType).toBe('Latest');
      expect(input.lang).toBe('en');
      expect(String(input.since_time)).toMatch(/^\d{10}$/);
      expect(firstTerm).toContain('-filter:replies');
      expect(firstTerm).toContain('lang:en');
      expect(firstTerm).not.toContain('since:');
      expect(firstTerm).not.toContain('until:');
    }

    expect(attempts[1]?.inputOverride.maxItems).toBe(30);
    expect(attempts[2]?.inputOverride.maxItems).toBe(40);
    const rescueTerms = attempts[2]?.inputOverride.searchTerms as unknown[];
    expect(String(rescueTerms[0] ?? '')).toContain('"token launch"');
    expect(String(rescueTerms[0] ?? '')).toContain('-"airdrop claim"');
  });

  it('keeps runApifyRotation planning the same current crypto sources and skipping future categories', async () => {
    const result = await runApifyRotation(makeEnv([
      source('src_unregistered_x_news_text', {
        label: 'unregistered-x-news-text',
        category_id: 'unregistered',
        platform: 'x',
        apify_task_id: 'task_movie',
      }),
    ]), { force: true, dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.plans.map((p: any) => p.sourceId).sort()).toEqual([...CURRENT_ROTATION_SOURCE_IDS].sort());
    expect(result.plans.some((p: any) => p.sourceId === 'src_unregistered_x_news_text')).toBe(false);

    for (const plan of result.plans) {
      const terms = plan.inputOverride.searchTerms as unknown[];
      const firstTerm = String(terms[0] ?? '');

      expect(plan.inputOverride.query).toBeUndefined();
      expect(plan.inputOverride.twitterContent).toBe('');
      expect(plan.inputOverride.queryType).toBe('Latest');
      expect(plan.inputOverride.lang).toBe('en');
      expect(Array.isArray(terms)).toBe(true);
      expect(String(plan.inputOverride.since_time)).toMatch(/^\d{10}$/);
      expect((firstTerm.match(/-filter:replies/g) ?? []).length).toBe(1);
      expect((firstTerm.match(/\blang:en\b/g) ?? []).length).toBe(1);
      expect(firstTerm).not.toContain('since:');
      expect(firstTerm).not.toContain('until:');
    }
  });
});
