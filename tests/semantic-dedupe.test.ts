import { describe, expect, it } from 'vitest';
import { findSimilarTopicInRunRejections } from '../apps/worker-api/src/services/curation-orchestrator';
import type { AIGateResult, NormalizedItem } from '../apps/worker-api/src/types';

function item(sourceAccount: string): Pick<NormalizedItem, 'sourceAccount'> {
  return { sourceAccount };
}

function ai(overrides: Partial<AIGateResult> = {}): Pick<AIGateResult, 'publish' | 'riskLevel' | 'score' | 'topicFingerprint'> {
  return {
    publish: true,
    riskLevel: 'low',
    score: 85,
    topicFingerprint: 'vitalik-stablecoins',
    ...overrides,
  };
}

describe('run-level semantic dedupe', () => {
  it('rejects lower-score publishable items from the same source and topic fingerprint', () => {
    const rejected = findSimilarTopicInRunRejections(
      [item('@VitalikButerin'), item('vitalikbuterin'), item('CoinDesk')],
      [ai({ score: 82 }), ai({ score: 91 }), ai({ score: 70 })],
      75,
    );

    expect([...rejected]).toEqual([0]);
  });

  it('keeps the earliest item when scores tie for the same source and topic', () => {
    const rejected = findSimilarTopicInRunRejections(
      [item('source'), item('source'), item('source')],
      [ai({ score: 88 }), ai({ score: 88 }), ai({ score: 88 })],
      75,
    );

    expect([...rejected].sort()).toEqual([1, 2]);
  });

  it('does not let non-publishable or below-threshold items suppress publishable ones', () => {
    const rejected = findSimilarTopicInRunRejections(
      [item('source'), item('source'), item('source'), item('source')],
      [
        ai({ publish: false, score: 99 }),
        ai({ riskLevel: 'high', score: 98 }),
        ai({ score: 70 }),
        ai({ score: 80 }),
      ],
      75,
    );

    expect([...rejected]).toEqual([]);
  });

  it('scopes duplicate detection to the source account as well as the topic fingerprint', () => {
    const rejected = findSimilarTopicInRunRejections(
      [item('source-a'), item('source-b')],
      [ai({ score: 90 }), ai({ score: 80 })],
      75,
    );

    expect([...rejected]).toEqual([]);
  });

  it('does not group empty topic fingerprints', () => {
    const rejected = findSimilarTopicInRunRejections(
      [item('source'), item('source')],
      [ai({ topicFingerprint: '', score: 90 }), ai({ topicFingerprint: '   ', score: 80 })],
      75,
    );

    expect([...rejected]).toEqual([]);
  });
});
