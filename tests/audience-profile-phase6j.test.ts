import { describe, expect, it } from 'vitest';
import {
  getAudienceProfileGuidance,
  isAudienceProfileScoringEnabled,
  normalizeAudienceKey,
  primaryAudienceKey,
} from '../apps/worker-api/src/services/audience-profile';
import type { Env } from '../apps/worker-api/src/types';

describe('audience profile (Phase 6J)', () => {
  it('returns Persian guidance for fa and fa-IR', () => {
    const fa = getAudienceProfileGuidance('fa');
    expect(fa).toBeTruthy();
    expect(fa).toContain('AUDIENCE PROFILE');
    expect(getAudienceProfileGuidance('fa-IR')).toBe(fa); // region suffix normalised
    expect(getAudienceProfileGuidance('FA')).toBe(fa);
  });

  it('returns null for locales without a profile yet (ar/en/ru fall back)', () => {
    expect(getAudienceProfileGuidance('ar')).toBeNull();
    expect(getAudienceProfileGuidance('en')).toBeNull();
    expect(getAudienceProfileGuidance('ru')).toBeNull();
    expect(getAudienceProfileGuidance('')).toBeNull();
  });

  it('normalises language/region keys', () => {
    expect(normalizeAudienceKey('fa-IR')).toBe('fa');
    expect(normalizeAudienceKey('EN_US')).toBe('en');
    expect(normalizeAudienceKey(null)).toBe('');
  });

  it('picks the primary audience key from language targets', () => {
    expect(primaryAudienceKey(['fa', 'en'])).toBe('fa');
    expect(primaryAudienceKey([])).toBe('fa');
    expect(primaryAudienceKey(undefined)).toBe('fa');
  });

  it('is flag-gated (default off)', () => {
    expect(isAudienceProfileScoringEnabled({} as Env)).toBe(false);
    expect(isAudienceProfileScoringEnabled({ AUDIENCE_PROFILE_SCORING_ENABLED: 'true' } as unknown as Env)).toBe(true);
  });
});
