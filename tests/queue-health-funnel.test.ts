import { describe, expect, it } from 'vitest';
import {
  classifyQueueHealth,
  decideDrainBatches,
  getQueueHealthThresholds,
  isBackloaded,
  shouldTriggerEarlyRotation,
  type QueueHealth,
  type QueueHealthInputs,
} from '../apps/worker-api/src/services/queue-health';
import { shapeFunnelRejections } from '../apps/worker-api/src/services/rejection-funnel';
import type { Env } from '../apps/worker-api/src/types';

function inputs(overrides: Partial<QueueHealthInputs> = {}): QueueHealthInputs {
  return {
    scheduledNext6h: 5,
    scheduledNext24h: 8,
    totalScheduled: 8,
    pendingCandidates: 0,
    lastPublishedAgoMin: 10,
    rotationAgeMin: 30,
    ...overrides,
  };
}

describe('queue-health classification (Phase 6E)', () => {
  const thresholds = { minScheduledNext6h: 3, starvingScheduledNext6h: 1 };

  it('is healthy when near window meets the floor', () => {
    expect(classifyQueueHealth(inputs({ scheduledNext6h: 3 }), thresholds)).toBe('healthy');
  });

  it('is lean between starving and healthy', () => {
    expect(classifyQueueHealth(inputs({ scheduledNext6h: 2 }), thresholds)).toBe('lean');
  });

  it('is starving at/under the starving floor', () => {
    expect(classifyQueueHealth(inputs({ scheduledNext6h: 1 }), thresholds)).toBe('starving');
    expect(classifyQueueHealth(inputs({ scheduledNext6h: 0 }), thresholds)).toBe('starving');
  });

  it('detects backloaded queue (many total, thin near window)', () => {
    expect(isBackloaded(inputs({ scheduledNext6h: 1, totalScheduled: 20 }), thresholds)).toBe(true);
    expect(isBackloaded(inputs({ scheduledNext6h: 5, totalScheduled: 20 }), thresholds)).toBe(false);
  });

  it('decides more batches only when starving', () => {
    expect(decideDrainBatches('healthy', 1, 3)).toBe(1);
    expect(decideDrainBatches('lean', 1, 3)).toBe(1);
    expect(decideDrainBatches('starving', 1, 3)).toBe(3);
    // never reduces below normal
    expect(decideDrainBatches('starving', 4, 3)).toBe(4);
  });

  it('only triggers early rotation when starving AND no pending candidates', () => {
    const base: QueueHealth = { channelId: 'c', state: 'starving', backloaded: false, ...inputs({ scheduledNext6h: 0, pendingCandidates: 0 }) };
    expect(shouldTriggerEarlyRotation(base)).toBe(true);
    expect(shouldTriggerEarlyRotation({ ...base, pendingCandidates: 5 })).toBe(false);
    expect(shouldTriggerEarlyRotation({ ...base, state: 'lean' })).toBe(false);
  });

  it('derives starving floor from min when not explicitly set', () => {
    const env = { QUEUE_HEALTH_MIN_SCHEDULED_NEXT_6H: '4' } as unknown as Env;
    const t = getQueueHealthThresholds(env);
    expect(t.minScheduledNext6h).toBe(4);
    expect(t.starvingScheduledNext6h).toBe(2);
  });
});

describe('rejection funnel shaping (Phase 6E)', () => {
  it('buckets reasons into correct funnel stages by status/reason', () => {
    const rows = [
      { status: 'ai_rejected', reject_reason: 'pre_ai_non_crypto', count: 10 },
      { status: 'ai_rejected', reject_reason: 'stale_before_ai', count: 4 },
      { status: 'ai_rejected', reject_reason: 'low_substance', count: 7 },
      { status: 'ai_rejected', reject_reason: 'iran_audience_project_marketing', count: 5 },
      { status: 'ai_rejected', reject_reason: 'theme_daily_cap:theme:crypto-etf', count: 3 },
      { status: 'story_duplicate_rejected', reject_reason: 'story_duplicate_recent_channel', count: 6 },
      { status: 'rule_gate_rejected', reject_reason: 'daily_quota_exceeded', count: 2 },
      { status: 'translation_missing', reject_reason: null, count: 1 },
      { status: 'queue_created', reject_reason: null, count: 9 },
      { status: 'ai_selected', reject_reason: null, count: 9 },
    ];

    const out = shapeFunnelRejections(rows);

    expect(out.preAi.find(r => r.reason === 'pre_ai_non_crypto')?.count).toBe(10);
    expect(out.preAi.find(r => r.reason === 'stale_before_ai')?.count).toBe(4);
    expect(out.ai.find(r => r.reason === 'low_substance')?.count).toBe(7);
    expect(out.storyTheme.find(r => r.reason === 'iran_audience_project_marketing')?.count).toBe(5);
    expect(out.storyTheme.find(r => r.reason.startsWith('theme_daily_cap'))?.count).toBe(3);
    expect(out.storyTheme.find(r => r.reason === 'story_duplicate_recent_channel')?.count).toBe(6);
    expect(out.ruleGate.find(r => r.reason === 'daily_quota_exceeded')?.count).toBe(2);
    expect(out.other.find(r => r.reason === 'translation_missing')?.count).toBe(1);
    // queue_created / ai_selected are not rejections
    expect(out.other.find(r => r.reason.includes('queue_created'))).toBeUndefined();
  });

  it('sorts each stage by count descending and ignores zero counts', () => {
    const out = shapeFunnelRejections([
      { status: 'ai_rejected', reject_reason: 'a', count: 1 },
      { status: 'ai_rejected', reject_reason: 'b', count: 9 },
      { status: 'ai_rejected', reject_reason: 'c', count: 0 },
    ]);
    expect(out.ai.map(r => r.reason)).toEqual(['b', 'a']);
  });
});

