import { describe, expect, it } from 'vitest';
import { getCategoryPolicy } from '../apps/worker-api/src/categories/registry';
import { getPreAiContentRejectReason } from '../apps/worker-api/src/services/content-policy';

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

function item(overrides: Partial<any>) {
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

describe('category policy registry', () => {
  it('resolves crypto to the crypto policy and unknown categories to the default policy', () => {
    expect(getCategoryPolicy('crypto').id).toBe('crypto');
    expect(getCategoryPolicy(' Crypto ').id).toBe('crypto');
    expect(getCategoryPolicy('unregistered').id).toBe('default');
    expect(getCategoryPolicy(null).id).toBe('default');
  });

  it('keeps crypto pre-AI delegation available without broad relevance filtering', () => {
    const cryptoCategory = { ...baseCategory, id: 'crypto', text_only_policy: 'penalize' } as any;
    const movieCategory = { ...baseCategory, id: 'unregistered' } as any;

    const genericCybersecurity = item({
      sourceAccount: 'DefiLlama',
      text: 'A weekly cybersecurity report counted dozens of cyberattacks and lower total losses than previous peaks.',
    });

    expect(getPreAiContentRejectReason(genericCybersecurity, cryptoCategory))
      .toBeNull();

    expect(getPreAiContentRejectReason(genericCybersecurity, movieCategory))
      .toBeNull();
  });

  it('keeps concrete crypto items allowed through the delegated crypto policy', () => {
    const cryptoCategory = { ...baseCategory, id: 'crypto', text_only_policy: 'penalize' } as any;

    expect(getPreAiContentRejectReason(item({
      sourceAccount: 'CryptoQuant',
      text: 'Bitcoin funding rate turned negative and open interest fell after BTC rejected resistance near $104,000.',
    }), cryptoCategory)).toBeNull();
  });
});
