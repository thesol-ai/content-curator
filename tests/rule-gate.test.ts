import { afterEach, describe, expect, it, vi } from 'vitest';
import { __ruleGateTest, runRuleGate } from '../apps/worker-api/src/services/rule-gate';
import type { AIGateResult, ChannelRow, Env } from '../apps/worker-api/src/types';

function ai(overrides: Partial<AIGateResult> = {}): AIGateResult {
  return {
    publish: true,
    score: 85,
    riskLevel: 'low',
    riskFlags: [],
    topicFingerprint: 'topic',
    publishPriority: 'normal',
    translations: {
      fa: { captionShort: 'کپشن', captionFull: 'کپشن کامل', hashtags: [] },
    },
    ...overrides,
  };
}

function channel(overrides: Partial<ChannelRow> = {}): ChannelRow {
  return {
    id: 'crypto_fa',
    category_id: 'crypto',
    telegram_chat_id: '@crypto_fa',
    language: 'fa',
    timezone: 'UTC',
    allowed_windows: '[]',
    blocked_windows: '[]',
    max_per_day: 10,
    max_per_hour: 2,
    min_gap_minutes: 30,
    publish_enabled: 1,
    enabled: 1,
    custom_instructions: null,
    tone_profile: 'neutral',
    channel_label: null,
    ...overrides,
  };
}

function envWithDb(firstResponses: Array<Record<string, unknown>>): Env {
  const responses = [...firstResponses];
  return {
    DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => responses.shift() ?? { cnt: 0, last_at: null }),
        })),
      })),
    },
  } as unknown as Env;
}

function unix(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

function expectUnix(resultUnix: number | undefined, iso: string): void {
  expect(resultUnix).toBe(unix(iso));
}

describe('rule-gate scheduling and quota', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects before DB access when AI did not publish, risk is high, or translation is missing', async () => {
    const env = envWithDb([]);

    await expect(runRuleGate(env, ai({ publish: false }), channel())).resolves.toMatchObject({ approved: false });
    await expect(runRuleGate(env, ai({ riskLevel: 'high' }), channel())).resolves.toMatchObject({ approved: false, reason: 'high_risk' });
    await expect(runRuleGate(env, ai({ translations: {} }), channel())).resolves.toMatchObject({ approved: false, reason: 'no_translation_for_fa' });
  });

  it('rejects when published plus scheduled items exceed daily quota for the scheduled local day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));

    const env = envWithDb([{ last_at: null }, { cnt: 2 }, { cnt: 1 }]);
    const result = await runRuleGate(env, ai(), channel({ max_per_day: 3 }));
    expect(result).toEqual({ approved: false, reason: 'daily_quota_exceeded:3/3' });
  });

  it('applies min_gap_minutes against the latest scheduled or published item', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));

    const now = Math.floor(Date.now() / 1000);
    const lastAt = now + 3600;
    const env = envWithDb([{ last_at: lastAt }, { cnt: 0 }, { cnt: 0 }]);

    const result = await runRuleGate(env, ai({ publishPriority: 'breaking' }), channel({ min_gap_minutes: 30 }));

    expect(result.approved).toBe(true);
    expect(result.scheduledAt).toBe(lastAt + 30 * 60);
  });

  it('moves candidates to the next allowed same-day window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T06:00:00Z'));

    const env = envWithDb([{ last_at: null }, { cnt: 0 }, { cnt: 0 }]);
    const result = await runRuleGate(env, ai({ publishPriority: 'breaking' }), channel({
      allowed_windows: '["09:00-17:00"]',
      min_gap_minutes: 0,
    }));

    expect(result.approved).toBe(true);
    expectUnix(result.scheduledAt, '2026-06-01T09:00:00Z');
  });

  it('supports overnight allowed windows when candidate is before the window starts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T21:50:00Z'));

    const env = envWithDb([{ last_at: null }, { cnt: 0 }, { cnt: 0 }]);
    const result = await runRuleGate(env, ai({ publishPriority: 'breaking' }), channel({
      allowed_windows: '["22:00-02:00"]',
      min_gap_minutes: 0,
    }));

    expect(result.approved).toBe(true);
    expectUnix(result.scheduledAt, '2026-06-01T22:00:00Z');
  });

  it('keeps candidates inside an overnight allowed window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T23:50:00Z'));

    const env = envWithDb([{ last_at: null }, { cnt: 0 }, { cnt: 0 }]);
    const result = await runRuleGate(env, ai({ publishPriority: 'breaking' }), channel({
      allowed_windows: '["22:00-02:00"]',
      min_gap_minutes: 0,
    }));

    expect(result.approved).toBe(true);
    expectUnix(result.scheduledAt, '2026-06-01T23:55:00Z');
  });

  it('keeps candidates in the after-midnight part of an overnight allowed window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T01:00:00Z'));

    const env = envWithDb([{ last_at: null }, { cnt: 0 }, { cnt: 0 }]);
    const result = await runRuleGate(env, ai(), channel({
      allowed_windows: '["22:00-02:00"]',
      min_gap_minutes: 0,
    }));

    expect(result.approved).toBe(true);
    expectUnix(result.scheduledAt, '2026-06-01T01:20:00Z');
  });

  it('keeps candidates before a future blocked window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T10:30:00Z'));

    const env = envWithDb([{ last_at: null }, { cnt: 0 }, { cnt: 0 }]);
    const result = await runRuleGate(env, ai(), channel({
      allowed_windows: '["08:00-23:59"]',
      blocked_windows: '["12:00-13:00"]',
      min_gap_minutes: 0,
    }));

    expect(result.approved).toBe(true);
    expectUnix(result.scheduledAt, '2026-06-01T10:50:00Z');
  });

  it('supports legacy 08:00-00:00 as an overnight allowed window ending at midnight', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T06:30:00Z'));

    const env = envWithDb([{ last_at: null }, { cnt: 0 }, { cnt: 0 }]);
    const result = await runRuleGate(env, ai({ publishPriority: 'breaking' }), channel({
      allowed_windows: '["08:00-00:00"]',
      min_gap_minutes: 0,
    }));

    expect(result.approved).toBe(true);
    expectUnix(result.scheduledAt, '2026-06-01T08:00:00Z');
  });
});

describe('rule-gate pure time helpers', () => {
  it('validates and rejects malformed or zero-length windows', () => {
    expect(__ruleGateTest.safeParseWindows('["08:00-23:59","22:00-02:00"]')).toHaveLength(2);
    expect(__ruleGateTest.safeParseWindows('["25:00-02:00","10:00-10:00","bad"]')).toHaveLength(0);
  });

  it('computes timezone day bounds using the channel timezone', () => {
    const start = __ruleGateTest.zonedLocalToUnix('Europe/Sofia', 2026, 6, 1, 0, 0, 0);
    expect(start).toBe(unix('2026-05-31T21:00:00Z'));

    const bounds = __ruleGateTest.getChannelDayBoundsForUnix(unix('2026-06-01T12:00:00Z'), 'Europe/Sofia');
    expect(bounds.startUnix).toBe(unix('2026-05-31T21:00:00Z'));
    expect(bounds.endUnix).toBe(unix('2026-06-01T21:00:00Z'));
  });
});
