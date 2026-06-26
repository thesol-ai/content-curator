import { describe, expect, it } from 'vitest';
import {
  isCronCoordinatorEnabled,
  pickCoordinatorPhase,
  shouldRunCoordinatorHousekeeping,
  shouldRunHeavyPhaseAfterPublish,
} from '../apps/worker-api/src/services/cron-coordinator';

describe('cron coordinator', () => {
  it('is enabled only when all fallback flags are true', () => {
    expect(isCronCoordinatorEnabled({
      RSS_FALLBACK_CRON_COORDINATOR_ENABLED: 'true',
      RSS_FALLBACK_SELECTOR_ENABLED: 'true',
      CLAUDE_SCORING_DISABLED: 'true',
    })).toBe(true);

    expect(isCronCoordinatorEnabled({
      RSS_FALLBACK_CRON_COORDINATOR_ENABLED: 'false',
      RSS_FALLBACK_SELECTOR_ENABLED: 'true',
      CLAUDE_SCORING_DISABLED: 'true',
    })).toBe(false);

    expect(isCronCoordinatorEnabled({
      RSS_FALLBACK_CRON_COORDINATOR_ENABLED: 'true',
      RSS_FALLBACK_SELECTOR_ENABLED: 'false',
      CLAUDE_SCORING_DISABLED: 'true',
    })).toBe(false);

    expect(isCronCoordinatorEnabled({
      RSS_FALLBACK_CRON_COORDINATOR_ENABLED: 'true',
      RSS_FALLBACK_SELECTOR_ENABLED: 'true',
      CLAUDE_SCORING_DISABLED: 'false',
    })).toBe(false);
  });

  it('runs heavy phase only when publish did nothing', () => {
    expect(shouldRunHeavyPhaseAfterPublish({ published: 0, failed: 0, skipped: 0 })).toBe(true);
    expect(shouldRunHeavyPhaseAfterPublish({ published: 1, failed: 0, skipped: 0 })).toBe(false);
    expect(shouldRunHeavyPhaseAfterPublish({ published: 0, failed: 1, skipped: 0 })).toBe(false);
    expect(shouldRunHeavyPhaseAfterPublish({ published: 0, failed: 0, skipped: 1 })).toBe(false);
  });

  it('rotates phases over a 30 minute window', () => {
    const step = 5 * 60 * 1000;

    expect(pickCoordinatorPhase(0 * step)).toBe('rss');
    expect(pickCoordinatorPhase(1 * step)).toBe('idle');
    expect(pickCoordinatorPhase(2 * step)).toBe('ai_drain');
    expect(pickCoordinatorPhase(3 * step)).toBe('idle');
    expect(pickCoordinatorPhase(4 * step)).toBe('rss');
    expect(pickCoordinatorPhase(5 * step)).toBe('idle');
    expect(pickCoordinatorPhase(6 * step)).toBe('rss');
  });

  it('runs housekeeping only once per hour-ish cycle', () => {
    const step = 5 * 60 * 1000;

    expect(shouldRunCoordinatorHousekeeping(10 * step)).toBe(false);
    expect(shouldRunCoordinatorHousekeeping(11 * step)).toBe(true);
    expect(shouldRunCoordinatorHousekeeping(12 * step)).toBe(false);
    expect(shouldRunCoordinatorHousekeeping(23 * step)).toBe(true);
  });
});
