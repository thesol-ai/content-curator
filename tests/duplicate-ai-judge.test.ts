import { describe, expect, it } from 'vitest';
import {
  scoreDuplicateAiJudgeLocalPair,
  shapeDuplicateAiJudgePayload,
  shouldRejectDuplicateAiJudgeResult,
} from '../apps/worker-api/src/services/duplicate-ai-judge';

function item(overrides: any = {}) {
  return {
    platform: 'x',
    sourceAccount: 'CoinDesk',
    sourceUrl: 'https://x.com/coindesk/status/1',
    postId: '1',
    publishedAt: 1,
    text: 'Alpha Protocol lost $12.4M after a vault exploit. The team disabled withdrawals.',
    media: [],
    engagementLikes: 0,
    engagementShares: 0,
    engagementViews: 0,
    mediaUrlExpiresSoon: false,
    ...overrides,
  };
}

function ai(overrides: any = {}) {
  return {
    publish: true,
    score: 88,
    riskLevel: 'low',
    riskFlags: [],
    topicFingerprint: 'alpha-protocol-vault-exploit',
    publishPriority: 'normal',
    translations: {},
    storyKey: 'alpha_protocol|vault|exploit|2026-06-21',
    storyFields: {
      primaryEntities: ['Alpha Protocol', 'Vault'],
      eventType: 'exploit',
      canonicalDate: '2026-06-21',
    },
    ...overrides,
  };
}

describe('duplicate AI judge helpers', () => {
  it('rejects only high-confidence duplicate decisions', () => {
    expect(shouldRejectDuplicateAiJudgeResult({
      index: 0,
      decision: 'duplicate',
      confidence: 0.91,
      matchedPriorId: 'q1',
      reason: 'same event',
    }, 0.78)).toBe(true);

    expect(shouldRejectDuplicateAiJudgeResult({
      index: 0,
      decision: 'near_duplicate',
      confidence: 0.77,
      matchedPriorId: 'q1',
      reason: 'uncertain',
    }, 0.78)).toBe(false);

    expect(shouldRejectDuplicateAiJudgeResult({
      index: 0,
      decision: 'material_followup',
      confidence: 0.95,
      matchedPriorId: 'q1',
      reason: 'new recovery update',
    }, 0.78)).toBe(false);
  });

  it('shapes compact batched payload with candidates and previous posts', () => {
    const payload = shapeDuplicateAiJudgePayload({
      maxTextChars: 40,
      candidates: [{
        index: 3,
        item: item(),
        ai: ai(),
      }],
      priors: [{
        priorId: 'queue_1',
        sourceAccount: 'WuBlockchain',
        sourceUrl: 'https://x.com/wu/status/2',
        text: 'Alpha Protocol reports a $12.4M vault exploit and pauses withdrawals.',
        captionShort: 'Alpha Protocol exploit.',
        topicFingerprint: 'alpha-protocol-vault-exploit',
        storyKey: 'alpha_protocol|exploit|2026-06-21',
        eventType: 'exploit',
        canonicalDate: '2026-06-21',
        publishedAt: 123,
      }],
    }) as any;

    expect(payload.new_items).toHaveLength(1);
    expect(payload.previous_items).toHaveLength(1);
    expect(payload.new_items[0].index).toBe(3);
    expect(payload.previous_items[0].prior_id).toBe('queue_1');
    expect(payload.previous_items[0].text.length).toBeLessThanOrEqual(40);
  });

  it('prefilters the same numeric research story despite different source wording and AI keys', () => {
    const result = scoreDuplicateAiJudgeLocalPair(
      {
        index: 0,
        item: item({
          sourceAccount: 'Cointelegraph',
          sourceUrl: 'https://x.com/cointelegraph/status/2',
          text: 'Ethereum energy use has fallen more than 99.9% since the Merge, according to a new Cambridge study.',
        }),
        ai: ai({
          topicFingerprint: 'ethereum-merge-energy-reduction-study',
          storyKey: 'cambridge_university|ethereum|protocol_environmental_impact|2026-07-11',
          storyFields: {
            primaryEntities: [
              'Cambridge University',
              'Ethereum',
            ],
            eventType: 'protocol_environmental_impact',
            canonicalDate: '2026-07-11',
          },
        }),
      },
      {
        priorId: 'queue_eth_prior',
        sourceAccount: 'WuBlockchain',
        sourceUrl: 'https://x.com/wublockchain/status/1',
        text: 'Cambridge reports Ethereum annual power use fell to 7.87 GWh after the Merge, down more than 99.9%.',
        captionShort: 'Ethereum power use fell over 99.9% after the Merge.',
        topicFingerprint: 'ethereum-post-merge-energy-consumption',
        storyKey: 'cambridge_centre_for_alternative_finance|ethereum|protocol_efficiency|2026-07-10',
        eventType: 'protocol_efficiency',
        canonicalDate: '2026-07-10',
        publishedAt: 1,
      },
    );

    expect(result.score).toBeGreaterThanOrEqual(0.30);
  });

  it('prefilters the same product capability without requiring a shared material number', () => {
    const result = scoreDuplicateAiJudgeLocalPair(
      {
        index: 0,
        item: item({
          sourceAccount: 'CoinDesk',
          sourceUrl: 'https://x.com/coindesk/status/4',
          text: 'Kraken plans to introduce agentic trading where AI agents execute trades for users.',
        }),
        ai: ai({
          topicFingerprint: 'kraken-ai-agentic-trading',
          storyKey: 'ai_agents|kraken|exchange_feature|2026-07-10',
          storyFields: {
            primaryEntities: ['Kraken', 'AI agents'],
            eventType: 'exchange_feature',
            canonicalDate: '2026-07-10',
          },
        }),
      },
      {
        priorId: 'queue_kraken_prior',
        sourceAccount: 'WuBlockchain',
        sourceUrl: 'https://x.com/wublockchain/status/3',
        text: 'Kraken is developing AI-powered automated trading that monitors crypto markets and executes trades based on user goals.',
        captionShort: 'Kraken is developing AI automated trading.',
        topicFingerprint: 'kraken-ai-automated-trading',
        storyKey: 'kraken|ai_agents|automated_trading|2026-07-10',
        eventType: 'product_development',
        canonicalDate: '2026-07-10',
        publishedAt: 1,
      },
    );

    expect(result.score).toBeGreaterThanOrEqual(0.30);
  });

  it('does not prefilter unrelated stories merely because they mention the same crypto asset', () => {
    const result = scoreDuplicateAiJudgeLocalPair(
      {
        index: 0,
        item: item({
          sourceUrl: 'https://x.com/source/status/6',
          text: 'Bitcoin ETF inflows reached $500 million after a strong trading session.',
        }),
        ai: ai({
          topicFingerprint: 'bitcoin-etf-inflows',
          storyKey: 'bitcoin_etf|inflows|2026-07-11',
          storyFields: {
            primaryEntities: ['Bitcoin', 'ETF'],
            eventType: 'etf_flow',
            canonicalDate: '2026-07-11',
          },
        }),
      },
      {
        priorId: 'queue_btc_prior',
        sourceAccount: 'OtherSource',
        sourceUrl: 'https://x.com/source/status/5',
        text: 'Bitcoin mining difficulty rose to a record after the latest adjustment.',
        captionShort: 'Bitcoin mining difficulty reached a record.',
        topicFingerprint: 'bitcoin-mining-difficulty',
        storyKey: 'bitcoin|mining_difficulty|2026-07-11',
        eventType: 'network_metric',
        canonicalDate: '2026-07-11',
        publishedAt: 1,
      },
    );

    expect(result.score).toBeLessThan(0.30);
  });

});
