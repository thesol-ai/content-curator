import { describe, expect, it } from 'vitest';
import { orderPlansForSlot } from '../apps/worker-api/src/services/apify-rotation-runner';
import { findEarliestGapSlot } from '../apps/worker-api/src/services/rule-gate';

describe('continuous rotation slot ordering (Phase 6F)', () => {
  const sources = ['a', 'b', 'c', 'd', 'e', 'f'];

  it('designates a different lead source per slot and covers all in N slots', () => {
    const leads: string[] = [];
    for (let slot = 0; slot < 6; slot++) {
      leads.push(orderPlansForSlot(sources, slot)[0]!);
    }
    expect(leads).toEqual(['a', 'b', 'c', 'd', 'e', 'f']); // even spread, no bursting
    // every source is covered exactly once across a full cycle
    expect(new Set(leads).size).toBe(6);
  });

  it('wraps deterministically and is stable for the same slot', () => {
    expect(orderPlansForSlot(sources, 7)).toEqual(orderPlansForSlot(sources, 1));
    expect(orderPlansForSlot(sources, 1)[0]).toBe('b');
  });

  it('handles single/empty source lists', () => {
    expect(orderPlansForSlot(['only'], 5)).toEqual(['only']);
    expect(orderPlansForSlot([], 5)).toEqual([]);
  });
});

describe('gap-fill scheduling (Phase 6F)', () => {
  const identity = (u: number) => u; // no window constraints for the unit test
  const MIN = 60; // seconds per minute helper

  it('returns the start slot when nothing is occupied', () => {
    expect(findEarliestGapSlot(1000, [], 30, identity)).toBe(1000);
  });

  it('fills from now forward, not after the latest occupied slot (anti back-load)', () => {
    // occupied far in the future; near window is free → schedule near now
    const start = 1000;
    const occupied = [100000, 103600, 107200];
    const slot = findEarliestGapSlot(start, occupied, 30, identity);
    expect(slot).toBe(1000); // does NOT jump to 107200+gap
  });

  it('respects min_gap against a nearby occupied slot', () => {
    const gapMin = 30; // 1800s
    const start = 1000;
    // an item at 1500 is within 1800s of 1000 → must move past 1500+1800
    const slot = findEarliestGapSlot(start, [1500], gapMin, identity);
    expect(slot).toBeGreaterThanOrEqual(1500 + gapMin * MIN);
  });

  it('finds a hole between two occupied slots when it fits', () => {
    const gapMin = 10; // 600s
    // holes: start 1000; occupied at 1000 and 5000 → after 1000+600=1600 is free (5000-1600 > 600)
    const slot = findEarliestGapSlot(1000, [1000, 5000], gapMin, identity);
    expect(slot).toBe(1600);
  });
});
