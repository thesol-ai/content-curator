import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getCategoryPolicy, getCategorySourceStrategy } from '../apps/worker-api/src/categories/registry';
import { defaultCategoryPolicy } from '../apps/worker-api/src/categories/default/policy';
import { buildDefaultScoringPolicy } from '../apps/worker-api/src/categories/default/prompts';
import { defaultSourceStrategy } from '../apps/worker-api/src/categories/default/sources';
import { getPreAiContentRejectReason } from '../apps/worker-api/src/services/content-policy';
import { runApifyRotation } from '../apps/worker-api/src/services/apify-rotation-runner';

const baseCategory = {
  label: 'Unregistered',
  prompt_profile: 'default_editorial',
  custom_prompt: null,
  score_threshold: 75,
  freshness_hours: 24,
  media_mode: 'optional',
  language_targets: '["fa"]',
  editorial_guidelines: null,
  selection_criteria: null,
  rejection_criteria: null,
  required_context: null,
  avoid_duplicate_people_stories: 1,
  allow_replies: 1,
  allow_retweets: 1,
  allow_quotes: 1,
  text_only_policy: 'allow',
  min_score_for_text_only: null,
  min_score_for_media: null,
  enabled: 1,
} as any;

function item(overrides: Partial<any> = {}) {
  return {
    sourceUrl: 'https://x.com/example/status/1',
    postId: '1',
    platform: 'x',
    sourceAccount: 'DefiLlama',
    publishedAt: Math.floor(Date.now() / 1000),
    text: '',
    media: [],
    engagementLikes: 0,
    engagementShares: 0,
    engagementViews: 0,
    mediaUrlExpiresSoon: false,
    isReply: false,
    isRetweet: false,
    isQuote: false,
    ...overrides,
  } as any;
}

function makeEnvWithFutureSourceOnly() {
  const sources = [{
    id: 'src_unregistered_x_news_text',
    label: 'unregistered-x-news-text',
    category_id: 'unregistered',
    platform: 'x',
    apify_task_id: 'task_movie',
  }];

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

describe('default category module and template safety', () => {
  it('resolves unknown categories to explicit default policy and source strategy modules', () => {
    expect(getCategoryPolicy('unregistered')).toBe(defaultCategoryPolicy);
    expect(getCategoryPolicy(null)).toBe(defaultCategoryPolicy);
    expect(getCategorySourceStrategy('unregistered')).toBe(defaultSourceStrategy);
    expect(getCategorySourceStrategy(null)).toBe(defaultSourceStrategy);
  });

  it('keeps default policy no-op and does not inject crypto scoring policy', () => {
    const movieCategory = { ...baseCategory, id: 'unregistered' } as any;

    expect(defaultCategoryPolicy.id).toBe('default');
    expect(defaultCategoryPolicy.getPreAiRejectReason).toBeUndefined();
    expect(buildDefaultScoringPolicy(movieCategory)).toBe('');
    expect(getCategoryPolicy('unregistered').buildScoringPolicy?.(movieCategory)).toBe('');
  });

  it('does not apply crypto pre-AI policy to unknown/default categories', () => {
    const movieCategory = { ...baseCategory, id: 'unregistered' } as any;

    const genericCybersecurity = item({
      sourceAccount: 'DefiLlama',
      text: 'A weekly cybersecurity report counted dozens of cyberattacks and lower total losses than previous peaks.',
    });

    expect(getPreAiContentRejectReason(genericCybersecurity, movieCategory)).toBeNull();
  });

  it('keeps default source strategy as safe no-op and rotation skips future category sources', async () => {
    const futureMovieSource = {
      id: 'src_unregistered_x_news_text',
      label: 'unregistered-x-news-text',
      category_id: 'unregistered',
      platform: 'x',
      apify_task_id: 'task_movie',
    } as any;

    expect(defaultSourceStrategy.canHandleSource(futureMovieSource)).toBe(false);
    expect(defaultSourceStrategy.buildRotationPlan(futureMovieSource, 123)).toBeNull();
    expect(defaultSourceStrategy.buildRotationAttempts?.({
      source: futureMovieSource,
      cohortName: 'none',
      cohortIndex: null,
      accounts: [],
      inputOverride: {},
    })).toEqual([]);

    const result = await runApifyRotation(makeEnvWithFutureSourceOnly(), { force: true, dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.plans).toEqual([]);
  });

  it('ships category module docs and copy-only templates without compiling live behavior', () => {
    const root = process.cwd();

    expect(existsSync(join(root, 'apps/worker-api/src/categories/README.md'))).toBe(true);
    expect(existsSync(join(root, 'apps/worker-api/src/categories/_template/README.md'))).toBe(true);
    expect(existsSync(join(root, 'apps/worker-api/src/categories/_template/policy.ts.template'))).toBe(true);
    expect(existsSync(join(root, 'apps/worker-api/src/categories/_template/prompts.ts.template'))).toBe(true);
    expect(existsSync(join(root, 'apps/worker-api/src/categories/_template/sources.ts.template'))).toBe(true);
    expect(existsSync(join(root, 'apps/worker-api/src/categories/_template/article.ts.template'))).toBe(true);
  });
});
