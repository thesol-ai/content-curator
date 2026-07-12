import { describe, expect, it } from 'vitest';
import {
  findMatchingTaskRun,
  isApifyRunStillActive,
  parseRotationSlotClaim,
} from '../apps/worker-api/src/services/apify-rotation-runner';

describe('Apify rotation stale claim recovery helpers', () => {
  it('ignores legacy and malformed claim values', () => {
    expect(parseRotationSlotClaim('claimed')).toBeNull();
    expect(parseRotationSlotClaim('{bad-json')).toBeNull();
    expect(parseRotationSlotClaim('{}')).toBeNull();
  });

  it('parses a durable versioned rotation claim', () => {
    const claim = parseRotationSlotClaim(JSON.stringify({
      version: 1,
      state: 'claimed',
      slot: 123,
      rotationRunId: 'rotation_123',
      claimedAt: '2026-07-12T07:00:00.000Z',
      plans: [{
        sourceId: 'crypto_v2_hourly_all',
        taskId: 'task_123',
        categoryId: 'crypto',
        platform: 'x',
      }],
    }));

    expect(claim?.slot).toBe(123);
    expect(claim?.plans[0]?.taskId).toBe('task_123');
  });

  it('matches the task run closest to the claim time', () => {
    const claimedAt = Date.parse('2026-07-12T07:00:00.000Z');

    const matched = findMatchingTaskRun([
      {
        id: 'too_old',
        status: 'SUCCEEDED',
        startedAt: '2026-07-12T06:50:00.000Z',
      },
      {
        id: 'matching',
        status: 'SUCCEEDED',
        startedAt: '2026-07-12T07:00:12.000Z',
        defaultDatasetId: 'dataset_1',
      },
      {
        id: 'later',
        status: 'SUCCEEDED',
        startedAt: '2026-07-12T07:04:00.000Z',
      },
    ], claimedAt, Date.parse('2026-07-12T07:05:00.000Z'));

    expect(matched?.id).toBe('matching');
    expect(matched?.defaultDatasetId).toBe('dataset_1');
  });

  it('does not match unrelated runs outside the recovery window', () => {
    const claimedAt = Date.parse('2026-07-12T07:00:00.000Z');

    const matched = findMatchingTaskRun([
      {
        id: 'unrelated',
        status: 'SUCCEEDED',
        startedAt: '2026-07-12T07:15:00.000Z',
      },
    ], claimedAt, Date.parse('2026-07-12T07:20:00.000Z'));

    expect(matched).toBeNull();
  });

  it('treats transitional Apify statuses as still active', () => {
    expect(isApifyRunStillActive('READY')).toBe(true);
    expect(isApifyRunStillActive('RUNNING')).toBe(true);
    expect(isApifyRunStillActive('TIMING-OUT')).toBe(true);
    expect(isApifyRunStillActive('ABORTING')).toBe(true);

    expect(isApifyRunStillActive('SUCCEEDED')).toBe(false);
    expect(isApifyRunStillActive('FAILED')).toBe(false);
    expect(isApifyRunStillActive('TIMED-OUT')).toBe(false);
    expect(isApifyRunStillActive('ABORTED')).toBe(false);
  });

});
