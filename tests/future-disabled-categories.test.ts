import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getCategoryPolicy, getCategorySourceStrategy } from '../apps/worker-api/src/categories/registry';
import { moviePolicy } from '../apps/worker-api/src/categories/movie/policy';
import { gamingPolicy } from '../apps/worker-api/src/categories/gaming/policy';
import { aiCategoryPolicy } from '../apps/worker-api/src/categories/ai/policy';
import { buildMovieScoringPolicy } from '../apps/worker-api/src/categories/movie/prompts';
import { buildGamingScoringPolicy } from '../apps/worker-api/src/categories/gaming/prompts';
import { buildAiScoringPolicy } from '../apps/worker-api/src/categories/ai/prompts';
import { movieSourceStrategy, MOVIE_DISABLED_SOURCE_IDS } from '../apps/worker-api/src/categories/movie/sources';
import { gamingSourceStrategy, GAMING_DISABLED_SOURCE_IDS } from '../apps/worker-api/src/categories/gaming/sources';
import { aiSourceStrategy, AI_DISABLED_SOURCE_IDS } from '../apps/worker-api/src/categories/ai/sources';
import { getPreAiContentRejectReason } from '../apps/worker-api/src/services/content-policy';
import { runApifyRotation } from '../apps/worker-api/src/services/apify-rotation-runner';

const categories = [
  {
    id: 'movie',
    policy: moviePolicy,
    sourceStrategy: movieSourceStrategy,
    sourceIds: MOVIE_DISABLED_SOURCE_IDS,
    sourceId: 'src_movie_x_news_text',
    channelId: 'movie_fa_dry_run',
    buildPrompt: buildMovieScoringPolicy,
    expectedTerms: ['MOVIES & CINEMA CATEGORY GUIDANCE', 'trailer', 'box-office'],
  },
  {
    id: 'gaming',
    policy: gamingPolicy,
    sourceStrategy: gamingSourceStrategy,
    sourceIds: GAMING_DISABLED_SOURCE_IDS,
    sourceId: 'src_gaming_x_news_text',
    channelId: 'gaming_fa_dry_run',
    buildPrompt: buildGamingScoringPolicy,
    expectedTerms: ['GAMING CATEGORY GUIDANCE', 'studios', 'esports'],
  },
  {
    id: 'ai',
    policy: aiCategoryPolicy,
    sourceStrategy: aiSourceStrategy,
    sourceIds: AI_DISABLED_SOURCE_IDS,
    sourceId: 'src_ai_x_news_text',
    channelId: 'ai_fa_dry_run',
    buildPrompt: buildAiScoringPolicy,
    expectedTerms: ['ARTIFICIAL INTELLIGENCE CATEGORY GUIDANCE', 'benchmark', 'safety'],
  },
];

const baseCategory = {
  label: 'Future category',
  prompt_profile: 'default_editorial',
  custom_prompt: null,
  score_threshold: 78,
  freshness_hours: 72,
  media_mode: 'optional',
  language_targets: '["fa"]',
  editorial_guidelines: null,
  selection_criteria: null,
  rejection_criteria: null,
  required_context: null,
  avoid_duplicate_people_stories: 1,
  allow_replies: 0,
  allow_retweets: 1,
  allow_quotes: 1,
  text_only_policy: 'allow',
  min_score_for_text_only: null,
  min_score_for_media: null,
  enabled: 0,
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

function source(categoryId: string, sourceId: string) {
  return {
    id: sourceId,
    label: `${categoryId} disabled source`,
    category_id: categoryId,
    platform: 'x',
    apify_task_id: `task_${categoryId}`,
  } as any;
}

function makeEnvWithFutureSourcesOnly() {
  const sources = categories.map(c => source(c.id, c.sourceId));

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

describe('disabled future non-crypto categories rollout safety', () => {
  it('registers movie, gaming, and ai as non-crypto category policies', () => {
    for (const c of categories) {
      const categoryRow = { ...baseCategory, id: c.id } as any;
      const prompt = c.buildPrompt(categoryRow);

      expect(getCategoryPolicy(c.id)).toBe(c.policy);
      expect(c.policy.id).toBe(c.id);

      for (const expected of c.expectedTerms) {
        expect(prompt).toContain(expected);
      }

      expect(prompt).not.toContain('CRYPTO HARD GATE');
      expect(prompt).not.toContain('missing_explicit_crypto_relevance');
      expect(prompt).not.toContain('low_substance_market_commentary');
      expect(getCategoryPolicy(c.id).buildScoringPolicy?.(categoryRow)).toBe(prompt);
    }
  });

  it('does not apply crypto pre-AI rejects to future non-crypto categories', () => {
    const genericCybersecurity = item({
      sourceAccount: 'DefiLlama',
      text: 'A weekly cybersecurity report counted dozens of cyberattacks and lower total losses than previous peaks.',
    });

    for (const c of categories) {
      expect(getPreAiContentRejectReason(genericCybersecurity, {
        ...baseCategory,
        id: c.id,
      } as any)).toBeNull();
    }
  });

  it('keeps every future category source strategy disabled and unable to produce rotation plans', async () => {
    for (const c of categories) {
      const s = source(c.id, c.sourceId);
      const strategy = getCategorySourceStrategy(c.id);

      expect(strategy).toBe(c.sourceStrategy);
      expect([...c.sourceIds]).toEqual([c.sourceId]);
      expect(strategy.canHandleSource(s)).toBe(false);
      expect(strategy.buildRotationPlan(s, 123)).toBeNull();
      expect(strategy.buildRotationAttempts?.({
        source: s,
        cohortName: 'none',
        cohortIndex: null,
        accounts: [],
        inputOverride: {},
      })).toEqual([]);
    }

    const result = await runApifyRotation(makeEnvWithFutureSourcesOnly(), { force: true, dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.plans).toEqual([]);
  });

  it('seeds all future categories, channels, and Apify sources as disabled-only placeholders', () => {
    const sql = readFileSync('migrations/0018_future_disabled_categories_seed.sql', 'utf8');

    for (const c of categories) {
      expect(sql).toContain(`'${c.id}'`);
      expect(sql).toContain(`'${c.channelId}'`);
      expect(sql).toContain(`'${c.sourceId}'`);
    }

    expect(sql).toContain("'DISABLED_REPLACE_BEFORE_ENABLE'");
    expect(sql).toContain("'PLACEHOLDER_REPLACE_BEFORE_ENABLE'");
    expect(sql).toContain('"dry_run_only":true');
    expect(sql).toContain('"note":"Do not enable in Phase 05."');

    expect((sql.match(/publish_enabled,\s*enabled/g) ?? []).length).toBe(1);
    expect((sql.match(/0,\s*0\s*\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect((sql.match(/enabled,\s*apify_actor_id/g) ?? []).length).toBe(1);
  });

  it('does not introduce live publishing, runtime, scheduler, Telegram, market snapshot, or crypto changes in the migration', () => {
    const sql = readFileSync('migrations/0018_future_disabled_categories_seed.sql', 'utf8');

    expect(sql).not.toContain('telegram_publish_enabled');
    expect(sql).not.toContain('apify_curation_enabled');
    expect(sql).not.toContain('MARKET_SNAPSHOT_ENABLED');
    expect(sql).not.toContain('TELEGRAM_BOT_TOKEN');
    expect(sql).not.toContain('INTERNAL_API_SECRET');
    expect(sql).not.toContain('crypto_fa_pilot');
    expect(sql).not.toContain('src_crypto');
  });
});
