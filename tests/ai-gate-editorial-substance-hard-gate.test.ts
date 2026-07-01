import { describe, expect, it } from 'vitest';
import { applyPostScoringHardGate } from '../apps/worker-api/src/services/ai-gate';

const cryptoCategory = {
  id: 'crypto',
  label: 'Crypto',
  score_threshold: 75,
  allow_replies: 0,
  allow_retweets: 1,
  allow_quotes: 1,
  text_only_policy: 'penalize',
  media_mode: 'optional',
} as any;

function item(overrides: Partial<any>) {
  return {
    sourceUrl: 'https://x.com/example/status/1',
    postId: '1',
    platform: 'x',
    sourceAccount: 'glassnode',
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

describe('crypto editorial substance hard gate after AI scoring', () => {
  it('does not override Claude publish=true for vague crypto market commentary', () => {
    const result = applyPostScoringHardGate([{
      publish: true,
      score: 92,
      riskLevel: 'low',
      riskFlags: [],
      topicFingerprint: 'bitcoin-options-market-sentiment',
      publishPriority: 'high',
      translations: {},
    }], [item({
      text: 'Bitcoin recently broke its February low and bounced from its June low. Glassnode options data offers a deeper picture of trader positioning, expectations for future volatility, and overall market sentiment, which may provide clues about Bitcoin short-term and medium-term trend.',
    })], cryptoCategory)[0];

    expect(result.publish).toBe(true);
    expect(result.score).toBe(92);
    expect(result.riskFlags).not.toContain('hard_gate_after_ai');
    expect(result.riskFlags).not.toContain('pre_ai_low_substance_market_commentary');
  });

  it('keeps concrete crypto market analysis publishable after AI scoring', () => {
    const result = applyPostScoringHardGate([{
      publish: true,
      score: 88,
      riskLevel: 'low',
      riskFlags: [],
      topicFingerprint: 'bitcoin-etf-outflows',
      publishPriority: 'normal',
      translations: {},
    }], [item({
      text: 'Spot Bitcoin ETFs saw $90 million in net outflows while Ethereum ETFs lost $11 million in a single trading day.',
    })], cryptoCategory)[0];

    expect(result.publish).toBe(true);
    expect(result.score).toBe(88);
    expect(result.riskFlags).not.toContain('pre_ai_low_substance_market_commentary');
  });
});
