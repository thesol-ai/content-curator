import { describe, expect, it } from 'vitest';
import {
  orderAttemptsByYield,
  decideAttemptBudget,
  getMaxAttemptsPerSlot,
  isAdaptiveAttemptSelectionEnabled,
  getSecondAttemptDailyBudget,
  type AttemptYieldStat,
} from '../apps/worker-api/src/services/apify-rotation-runner';

const ATTEMPTS = [
  { attempt: 'primary' },
  { attempt: 'same_accounts_profile_7d' },
  { attempt: 'source_rescue_pool_7d' },
];

describe('Apify cost-control flag defaults', () => {
  it('defaults to ONE paid attempt per slot', () => {
    expect(getMaxAttemptsPerSlot({} as any)).toBe(1);
  });
  it('adaptive selection is on by default, off only when explicitly false', () => {
    expect(isAdaptiveAttemptSelectionEnabled({} as any)).toBe(true);
    expect(isAdaptiveAttemptSelectionEnabled({ APIFY_ADAPTIVE_ATTEMPT_SELECTION_ENABLED: 'false' } as any)).toBe(false);
  });
  it('second-attempt daily budget defaults to 0 (never)', () => {
    expect(getSecondAttemptDailyBudget({} as any)).toBe(0);
    expect(getSecondAttemptDailyBudget({ APIFY_SECOND_ATTEMPT_DAILY_BUDGET: '5' } as any)).toBe(5);
  });
  it('legacy chain restorable via APIFY_MAX_ATTEMPTS_PER_SLOT', () => {
    expect(getMaxAttemptsPerSlot({ APIFY_MAX_ATTEMPTS_PER_SLOT: '3' } as any)).toBe(3);
  });
});

describe('decideAttemptBudget — single attempt by default', () => {
  it('runs exactly one paid attempt by default (not starving)', () => {
    const b = decideAttemptBudget({
      baseMaxAttempts: 1, totalAttempts: 3,
      queueStarving: false, secondAttemptDailyBudget: 0, secondAttemptDailyUsed: 0,
    });
    expect(b.maxAttempts).toBe(1);
    expect(b.usesSecondAttemptBudget).toBe(false);
  });

  it('still ONE attempt while starving when budget is 0', () => {
    const b = decideAttemptBudget({
      baseMaxAttempts: 1, totalAttempts: 3,
      queueStarving: true, secondAttemptDailyBudget: 0, secondAttemptDailyUsed: 0,
    });
    expect(b.maxAttempts).toBe(1);
    expect(b.usesSecondAttemptBudget).toBe(false);
  });

  it('allows a SECOND attempt only when starving AND budget remains', () => {
    const b = decideAttemptBudget({
      baseMaxAttempts: 1, totalAttempts: 3,
      queueStarving: true, secondAttemptDailyBudget: 5, secondAttemptDailyUsed: 0,
    });
    expect(b.maxAttempts).toBe(2);
    expect(b.usesSecondAttemptBudget).toBe(true);
  });

  it('blocks the second attempt when the daily budget is exhausted', () => {
    const b = decideAttemptBudget({
      baseMaxAttempts: 1, totalAttempts: 3,
      queueStarving: true, secondAttemptDailyBudget: 5, secondAttemptDailyUsed: 5,
    });
    expect(b.maxAttempts).toBe(1);
    expect(b.usesSecondAttemptBudget).toBe(false);
  });

  it('does not grant a second attempt when not starving even if budget is free', () => {
    const b = decideAttemptBudget({
      baseMaxAttempts: 1, totalAttempts: 3,
      queueStarving: false, secondAttemptDailyBudget: 5, secondAttemptDailyUsed: 0,
    });
    expect(b.maxAttempts).toBe(1);
  });

  it('never exceeds the number of available attempts', () => {
    const b = decideAttemptBudget({
      baseMaxAttempts: 1, totalAttempts: 1,
      queueStarving: true, secondAttemptDailyBudget: 5, secondAttemptDailyUsed: 0,
    });
    expect(b.maxAttempts).toBe(1); // only one attempt exists → no second
    expect(b.usesSecondAttemptBudget).toBe(false);
  });

  it('explicit multi-attempt mode (base>=2) restores legacy chain without budget', () => {
    const b = decideAttemptBudget({
      baseMaxAttempts: 3, totalAttempts: 3,
      queueStarving: false, secondAttemptDailyBudget: 0, secondAttemptDailyUsed: 0,
    });
    expect(b.maxAttempts).toBe(3);
    expect(b.usesSecondAttemptBudget).toBe(false);
  });
});

describe('orderAttemptsByYield — adaptive selection picks higher-yield attempt', () => {
  const minSample = 3;

  it('moves the higher healthy-yield attempt to the front', () => {
    // primary is dry (0/5), fallback is healthy (4/5) → fallback should win
    const stats = new Map<string, AttemptYieldStat>([
      ['primary', { healthy: 0, total: 5 }],
      ['same_accounts_profile_7d', { healthy: 4, total: 5 }],
    ]);
    const out = orderAttemptsByYield(ATTEMPTS, stats, minSample);
    expect(out[0].attempt).toBe('same_accounts_profile_7d');
  });

  it('keeps primary first when primary has the better yield', () => {
    const stats = new Map<string, AttemptYieldStat>([
      ['primary', { healthy: 5, total: 5 }],
      ['same_accounts_profile_7d', { healthy: 1, total: 5 }],
    ]);
    const out = orderAttemptsByYield(ATTEMPTS, stats, minSample);
    expect(out[0].attempt).toBe('primary');
  });

  it('ignores attempts with insufficient history (safe fallback default order)', () => {
    // fallback looks great but only has 2 runs (< minSample) → not trusted
    const stats = new Map<string, AttemptYieldStat>([
      ['primary', { healthy: 3, total: 5 }],
      ['same_accounts_profile_7d', { healthy: 2, total: 2 }],
    ]);
    const out = orderAttemptsByYield(ATTEMPTS, stats, minSample);
    expect(out[0].attempt).toBe('primary');
  });

  it('returns original order when no attempt has enough history', () => {
    const stats = new Map<string, AttemptYieldStat>([
      ['primary', { healthy: 1, total: 1 }],
    ]);
    const out = orderAttemptsByYield(ATTEMPTS, stats, minSample);
    expect(out.map(a => a.attempt)).toEqual(ATTEMPTS.map(a => a.attempt));
  });

  it('is stable for equal yields (preserves default order)', () => {
    const stats = new Map<string, AttemptYieldStat>([
      ['primary', { healthy: 2, total: 4 }],
      ['same_accounts_profile_7d', { healthy: 2, total: 4 }],
    ]);
    const out = orderAttemptsByYield(ATTEMPTS, stats, minSample);
    expect(out[0].attempt).toBe('primary');
    expect(out[1].attempt).toBe('same_accounts_profile_7d');
  });

  it('combined: single-attempt budget + adaptive ordering = one paid event on the BEST attempt', () => {
    const stats = new Map<string, AttemptYieldStat>([
      ['primary', { healthy: 0, total: 6 }],
      ['same_accounts_profile_7d', { healthy: 5, total: 6 }],
    ]);
    const ordered = orderAttemptsByYield(ATTEMPTS, stats, minSample);
    const budget = decideAttemptBudget({
      baseMaxAttempts: 1, totalAttempts: ordered.length,
      queueStarving: false, secondAttemptDailyBudget: 0, secondAttemptDailyUsed: 0,
    });
    const toRun = ordered.slice(0, budget.maxAttempts);
    expect(toRun).toHaveLength(1);
    expect(toRun[0].attempt).toBe('same_accounts_profile_7d'); // dry primary skipped entirely
  });
});
