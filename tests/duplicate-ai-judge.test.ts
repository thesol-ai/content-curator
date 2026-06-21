import { describe, expect, it } from 'vitest';
import {
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
});
