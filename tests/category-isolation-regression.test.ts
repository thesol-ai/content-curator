import { describe, expect, it } from 'vitest';
import { getPreAiContentRejectReason } from '../apps/worker-api/src/services/content-policy';
import { applyPostScoringHardGate } from '../apps/worker-api/src/services/ai-gate';

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

const cryptoCategory = {
  ...baseCategory,
  id: 'crypto',
  label: 'Crypto',
  text_only_policy: 'penalize',
} as any;

const movieCategory = {
  ...baseCategory,
  id: 'movie',
  label: 'Movies',
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

function ai(overrides: Partial<any> = {}) {
  return {
    publish: true,
    score: 91,
    riskLevel: 'low',
    riskFlags: [],
    topicFingerprint: 'ai-approved-topic',
    publishPriority: 'normal',
    translations: {},
    ...overrides,
  } as any;
}

describe('category isolation regression safety net', () => {
  it('keeps crypto-only pre-AI relevance policy scoped to the crypto category', () => {
    const genericCybersecurity = item({
      sourceAccount: 'DefiLlama',
      text: 'A weekly cybersecurity report counted dozens of cyberattacks and lower total losses than previous peaks.',
    });

    expect(getPreAiContentRejectReason(genericCybersecurity, cryptoCategory))
      .toBe('pre_ai_generic_software_security');

    expect(getPreAiContentRejectReason(genericCybersecurity, movieCategory))
      .toBeNull();
  });

  it('does not let the crypto post-AI hard gate mutate non-crypto category decisions', () => {
    const [result] = applyPostScoringHardGate([
      ai({ riskFlags: ['kept_by_non_crypto_category'] }),
    ], [
      item({
        sourceAccount: 'DefiLlama',
        text: 'A weekly cybersecurity report counted dozens of cyberattacks and lower total losses than previous peaks.',
      }),
    ], movieCategory);

    expect(result.publish).toBe(true);
    expect(result.score).toBe(91);
    expect(result.riskFlags).toEqual(['kept_by_non_crypto_category']);
  });

  it('still overrides AI approval for the same item in the crypto category', () => {
    const [result] = applyPostScoringHardGate([
      ai(),
    ], [
      item({
        sourceAccount: 'DefiLlama',
        text: 'A weekly cybersecurity report counted dozens of cyberattacks and lower total losses than previous peaks.',
      }),
    ], cryptoCategory);

    expect(result.publish).toBe(false);
    expect(result.score).toBe(0);
    expect(result.riskFlags).toContain('hard_gate_after_ai');
    expect(result.riskFlags).toContain('pre_ai_generic_software_security');
    expect(result.riskFlags).toContain('missing_explicit_crypto_relevance');
  });
});
