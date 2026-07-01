import { describe, expect, it } from 'vitest';
import { computeCandidatePriorityScore } from '../apps/worker-api/src/services/curation-orchestrator';
import type { NormalizedItem } from '../apps/worker-api/src/types';

function item(overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    platform: 'x',
    sourceAccount: 'example',
    sourceUrl: 'https://x.com/example/status/1',
    postId: '1',
    publishedAt: Math.floor(Date.now() / 1000),
    text: 'Generic crypto market update.',
    media: [],
    engagementLikes: 0,
    engagementShares: 0,
    engagementViews: 0,
    mediaUrlExpiresSoon: false,
    isReply: false,
    isRetweet: false,
    isQuote: false,
    ...overrides,
  };
}

describe('crypto X candidate priority scoring', () => {
  it('prioritizes important crypto events over generic viral engagement', () => {
    const important = computeCandidatePriorityScore(item({
      sourceAccount: 'WuBlockchain',
      text: 'SEC opens review of spot Ethereum ETF staking proposal as ETH market awaits regulatory decision.',
      engagementViews: 4_000,
      engagementLikes: 35,
      engagementShares: 12,
    }));

    const viralGeneric = computeCandidatePriorityScore(item({
      sourceAccount: 'randomtrader',
      text: 'Which coin are you bullish on today?',
      engagementViews: 200_000,
      engagementLikes: 2_500,
      engagementShares: 200,
    }));

    expect(important).toBeGreaterThan(viralGeneric);
  });

  it('penalizes obvious promotional campaigns even with high engagement', () => {
    const promo = computeCandidatePriorityScore(item({
      sourceAccount: 'crypto_promo',
      text: 'Massive airdrop giveaway. Claim your reward now and tag a friend to win.',
      engagementViews: 500_000,
      engagementLikes: 10_000,
      engagementShares: 1_000,
    }));

    const factual = computeCandidatePriorityScore(item({
      sourceAccount: 'Lookonchain',
      text: 'Large BTC whale moved funds to an exchange as Bitcoin liquidity tightened during market volatility.',
      engagementViews: 8_000,
      engagementLikes: 80,
      engagementShares: 25,
    }));

    expect(factual).toBeGreaterThan(promo);
  });

  it('boosts media-backed priority-asset posts without relying only on engagement', () => {
    const mediaBacked = computeCandidatePriorityScore(item({
      sourceAccount: 'CoinDesk',
      text: 'Bitcoin ETF flows turned positive after several days of outflows.',
      media: [{ type: 'image', url: 'https://example.com/chart.jpg' }],
      engagementViews: 1_000,
      engagementLikes: 10,
      engagementShares: 3,
    }));

    const plain = computeCandidatePriorityScore(item({
      sourceAccount: 'unknown',
      text: 'Crypto market update with no clear asset or concrete event.',
      engagementViews: 1_000,
      engagementLikes: 10,
      engagementShares: 3,
    }));

    expect(mediaBacked).toBeGreaterThan(plain);
  });
});
