import { describe, expect, it } from 'vitest';
import { applyPostScoringHardGate } from '../apps/worker-api/src/services/ai-gate';

const cryptoCategory = {
  id: 'crypto',
  label: 'Crypto',
  allow_replies: 0,
  allow_retweets: 1,
  allow_quotes: 1,
  text_only_policy: 'penalize',
  media_mode: 'optional',
  score_threshold: 75,
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
    isReply: false,
    isRetweet: false,
    isQuote: false,
    ...overrides,
  } as any;
}

function ai(overrides: Partial<any> = {}) {
  return {
    publish: true,
    score: 92,
    riskLevel: 'low',
    riskFlags: [],
    topicFingerprint: 'ai-approved-topic',
    publishPriority: 'high',
    translations: {},
    ...overrides,
  } as any;
}

describe('AI strict crypto hard gate', () => {
  it('overrides AI approval when explicit crypto relevance is missing', () => {
    const [result] = applyPostScoringHardGate([
      ai(),
    ], [
      item({
        sourceAccount: 'DefiLlama',
        text: 'A weekly cybersecurity report counted dozens of cyberattacks and lower total losses.',
      }),
    ], cryptoCategory);

    expect(result.publish).toBe(false);
    expect(result.score).toBe(0);
    expect(result.riskFlags).toContain('hard_gate_after_ai');
    expect(result.riskFlags).toContain('missing_explicit_crypto_relevance');
  });

  it('keeps AI approval when the text has explicit crypto relevance', () => {
    const [result] = applyPostScoringHardGate([
      ai(),
    ], [
      item({
        sourceAccount: 'DefiLlama',
        text: 'A DeFi protocol exploit drained on-chain funds from user wallets.',
      }),
    ], cryptoCategory);

    expect(result.publish).toBe(true);
    expect(result.score).toBe(92);
  });
});
