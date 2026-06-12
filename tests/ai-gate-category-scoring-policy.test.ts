import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCategoryPolicy } from '../apps/worker-api/src/categories/registry';
import { buildCryptoScoringPolicy } from '../apps/worker-api/src/categories/crypto/prompts';
import { runAIGate } from '../apps/worker-api/src/services/ai-gate';
import type { CategoryRow, Env } from '../apps/worker-api/src/types';

const baseCategory = {
  label: 'Test',
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

function env(): Env {
  return {
    APIFY_CURATION_DRY_RUN: 'false',
    ANTHROPIC_API_KEY: 'test-anthropic-key',
    AI_SCORING_MODEL: 'claude-test',
    AI_MAX_CALLS_PER_DAY: '0',
    AI_DAILY_TOKEN_BUDGET: '0',
    AI_MAX_TEXT_CHARS_PER_ITEM: '400',
    AI_MAX_OUTPUT_TOKENS: '2048',
    AI_MAX_RETRIES: '0',
    TRANSLATION_PROVIDER: 'gemini',
    TRANSLATION_MODEL: 'gemini-test',
  } as Env;
}

function item(overrides: Partial<any> = {}) {
  return {
    sourceUrl: 'https://x.com/example/status/1',
    postId: '1',
    platform: 'x',
    sourceAccount: 'CryptoQuant',
    publishedAt: Math.floor(Date.now() / 1000),
    text: 'Bitcoin funding rate turned negative and open interest fell after BTC rejected resistance near $104,000.',
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

function category(overrides: Partial<CategoryRow> = {}): CategoryRow {
  return {
    ...baseCategory,
    id: 'crypto',
    label: 'Crypto',
    prompt_profile: 'crypto_editorial',
    text_only_policy: 'penalize',
    ...overrides,
  } as CategoryRow;
}

async function captureScoringSystem(categoryRow: CategoryRow): Promise<string> {
  let capturedSystem = '';

  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    capturedSystem = String(body.system ?? '');

    return Response.json({
      usage: { input_tokens: 10, output_tokens: 10 },
      content: [{
        text: JSON.stringify({
          items: [{
            url: 'https://x.com/example/status/1',
            post_id: '1',
            publish: false,
            score: 0,
            risk_level: 'medium',
            risk_flags: ['test_reject'],
            topic_fingerprint: 'test-topic',
            publish_priority: 'low',
          }],
        }),
      }],
    });
  }));

  await runAIGate(env(), [item()], categoryRow, [], []);

  return capturedSystem;
}

describe('category scoring policy registry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exposes the crypto scoring policy through the category registry only for crypto', () => {
    expect(buildCryptoScoringPolicy()).toContain('CRYPTO HARD GATE');
    expect(getCategoryPolicy('crypto').buildScoringPolicy?.(category())).toContain('CRYPTO HARD GATE');
    expect(getCategoryPolicy('unregistered').buildScoringPolicy?.(category({ id: 'unregistered', label: 'Unregistered' })) ?? '').toBe('');
  });

  it('injects the crypto scoring policy into scoring prompts for crypto categories', async () => {
    const system = await captureScoringSystem(category());

    expect(system).toContain('CRYPTO HARD GATE');
    expect(system).toContain('EDITORIAL SUBSTANCE GATE');
    expect(system).toContain('missing_explicit_crypto_relevance');
    expect(system).toContain('low_substance_market_commentary');
  });

  it('does not inject the crypto scoring policy for non-crypto categories', async () => {
    const system = await captureScoringSystem(category({
      id: 'unregistered',
      label: 'Unregistered',
      prompt_profile: 'default_editorial',
    }));

    expect(system).not.toContain('CRYPTO HARD GATE');
    expect(system).not.toContain('EDITORIAL SUBSTANCE GATE');
  });

  it('preserves category custom_prompt priority while appending category scoring policy', async () => {
    const system = await captureScoringSystem(category({
      custom_prompt: 'CUSTOM PROFILE SENTINEL',
    }));

    expect(system).toContain('CUSTOM PROFILE SENTINEL');
    expect(system).toContain('CRYPTO HARD GATE');
  });
});
