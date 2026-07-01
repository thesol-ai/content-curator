import { describe, expect, it } from 'vitest';
import { applyMustCoverCryptoAssetOverride, applyPostScoringHardGate, hasMustCoverCryptoAsset } from '../apps/worker-api/src/services/ai-gate';

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

describe('AI crypto post-scoring hard gate', () => {
  it('does not override AI approval for broad relevance after scoring', () => {
    const [result] = applyPostScoringHardGate([
      ai(),
    ], [
      item({
        sourceAccount: 'DefiLlama',
        text: 'A weekly cybersecurity report counted dozens of cyberattacks and lower total losses.',
      }),
    ], cryptoCategory);

    expect(result.publish).toBe(true);
    expect(result.score).toBe(92);
    expect(result.riskFlags).not.toContain('hard_gate_after_ai');
  });

  it('still overrides AI approval for obvious promotional campaigns', () => {
    const [result] = applyPostScoringHardGate([
      ai(),
    ], [
      item({
        sourceAccount: 'binance',
        text: 'Introducing the bStocks Trading Competition. $240,000 in token vouchers. Trade tokenized stocks to claim your share.',
      }),
    ], cryptoCategory);

    expect(result.publish).toBe(false);
    expect(result.score).toBe(0);
    expect(result.riskFlags).toContain('hard_gate_after_ai');
    expect(result.riskFlags).toContain('iran_audience_promotional_campaign');
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


describe('must-cover crypto assets', () => {
  it('detects priority crypto assets in RSS item text', () => {
    expect(hasMustCoverCryptoAsset(item({
      platform: 'rss',
      text: 'USDT liquidity on Tron increased while BTC stayed range-bound.',
    }))).toBe(true);

    expect(hasMustCoverCryptoAsset(item({
      platform: 'rss',
      text: 'A generic fintech hiring update with no major crypto asset mentioned.',
    }))).toBe(false);
  });

  it('restores publish for safe must-cover asset news rejected by scoring', () => {
    const [result] = applyMustCoverCryptoAssetOverride([
      ai({
        publish: false,
        score: 0,
        riskLevel: 'medium',
        riskFlags: ['ai_not_publish'],
        publishPriority: 'low',
      }),
    ], [
      item({
        platform: 'rss',
        text: 'USDC and USDT flows on exchanges rose as BTC volatility increased.',
      }),
    ], cryptoCategory);

    expect(result.publish).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(75);
    expect(result.riskFlags).toContain('must_cover_crypto_asset');
    expect(result.publishPriority).toBe('normal');
  });

  it('does not override high-risk must-cover asset content', () => {
    const [result] = applyMustCoverCryptoAssetOverride([
      ai({
        publish: false,
        score: 0,
        riskLevel: 'high',
        riskFlags: ['pump_and_dump'],
      }),
    ], [
      item({
        platform: 'rss',
        text: 'DOGE pump campaign promises guaranteed returns.',
      }),
    ], cryptoCategory);

    expect(result.publish).toBe(false);
  });
});
