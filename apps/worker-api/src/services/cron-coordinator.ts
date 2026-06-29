export type CoordinatorPhase = 'rss' | 'ai_drain' | 'idle';

export interface PublishDueSummary {
  published: number;
  failed: number;
  skipped: number;
}

const TRUE = 'true';
const FIVE_MINUTES_MS = 5 * 60 * 1000;

function isTrue(value: unknown): boolean {
  return String(value ?? '').trim().toLowerCase() === TRUE;
}

export function isCronCoordinatorEnabled(env: {
  RSS_FALLBACK_CRON_COORDINATOR_ENABLED?: string;
  RSS_FALLBACK_SELECTOR_ENABLED?: string;
  CLAUDE_SCORING_DISABLED?: string;
}): boolean {
  return (
    isTrue(env.RSS_FALLBACK_CRON_COORDINATOR_ENABLED) &&
    isTrue(env.RSS_FALLBACK_SELECTOR_ENABLED) &&
    isTrue(env.CLAUDE_SCORING_DISABLED)
  );
}

export function shouldRunHeavyPhaseAfterPublish(result: PublishDueSummary): boolean {
  return (
    Number(result.published ?? 0) === 0 &&
    Number(result.failed ?? 0) === 0 &&
    Number(result.skipped ?? 0) === 0
  );
}

export function pickCoordinatorPhase(scheduledTimeMs: number): CoordinatorPhase {
  const tickIndex = Math.floor(Number(scheduledTimeMs || 0) / FIVE_MINUTES_MS);
  const slot = ((tickIndex % 6) + 6) % 6;

  if (slot === 0 || slot === 4) return 'rss';
  if (slot === 2) return 'ai_drain';
  return 'idle';
}

export function shouldRunCoordinatorHousekeeping(scheduledTimeMs: number): boolean {
  const tickIndex = Math.floor(Number(scheduledTimeMs || 0) / FIVE_MINUTES_MS);
  const slot = ((tickIndex % 12) + 12) % 12;

  return slot === 11;
}
