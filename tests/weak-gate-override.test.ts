import { describe, expect, it } from 'vitest';
import {
  isSoftEditorialGateReject,
  resolveCandidateRejectReason,
  shouldOverrideSoftEditorialReject,
  type CandidateEvaluation,
} from '../apps/worker-api/src/services/backlog-drain';
import type {
  AIGateResult,
  CategoryRow,
  NormalizedItem,
} from '../apps/worker-api/src/types';

function category(overrides: Partial<CategoryRow> = {}): CategoryRow {
  return {
    score_threshold: 75,
    media_mode: 'disabled',
    text_only_policy: 'allow',
    min_score_for_text_only: 0,
    min_score_for_media: 0,
    ...overrides,
  } as CategoryRow;
}

function item(): NormalizedItem {
  return {
    media: [],
  } as unknown as NormalizedItem;
}

function ai(overrides: Partial<AIGateResult> = {}): AIGateResult {
  return {
    publish: true,
    score: 85,
    riskLevel: 'low',
    riskFlags: [],
    topicFingerprint: 'generic-story-fingerprint',
    publishPriority: 'normal',
    translations: {},
    ...overrides,
  };
}

function evaluation(
  overrides: Partial<CandidateEvaluation> = {},
): CandidateEvaluation {
  return {
    itemId: 'item_test',
    storyClusterKey: null,
    themeKey: null,
    recentTopicDuplicate: false,
    recentStoryClusterDuplicate: false,
    themeCapRejectReason: null,
    audienceRejectReason: null,
    storyKey: null,
    storyKeyRejectReason: null,
    ...overrides,
  };
}

describe('safe weak post-AI gate override', () => {
  it('never hides an exact same-batch topic duplicate behind a theme cap', () => {
    const reason = resolveCandidateRejectReason(
      evaluation({
        themeKey: 'theme:any',
        themeCapRejectReason: 'theme_daily_cap:theme:any',
      }),
      ai(),
      category(),
      item(),
      true,
    );

    expect(reason).toBe('similar_topic_in_run');
  });

  it('never hides below-threshold quality rejection behind a theme cap', () => {
    const reason = resolveCandidateRejectReason(
      evaluation({
        themeKey: 'theme:any',
        themeCapRejectReason: 'theme_daily_cap:theme:any',
      }),
      ai({ score: 74 }),
      category(),
      item(),
      false,
    );

    expect(reason).toBe('below_threshold');
  });

  it('keeps semantic duplicate evidence hard', () => {
    const semanticReason = 'similar_semantic_story_recent_channel';

    expect(isSoftEditorialGateReject(semanticReason)).toBe(false);

    expect(resolveCandidateRejectReason(
      evaluation({ storyKeyRejectReason: semanticReason }),
      ai(),
      category(),
      item(),
      false,
    )).toBe(semanticReason);
  });

  it('recognizes editorial capacity gates without topic-specific names', () => {
    expect(isSoftEditorialGateReject('theme_daily_cap:theme:anything')).toBe(true);
    expect(isSoftEditorialGateReject('audience_profile_requires_material_impact')).toBe(true);
    expect(isSoftEditorialGateReject('similar_story_key_recent_channel')).toBe(false);
  });

  it('overrides a strong clean candidate only when every target queue is starving', () => {
    expect(shouldOverrideSoftEditorialReject({
      enabled: true,
      rejectReason: 'theme_daily_cap:theme:anything',
      ai: ai({ score: 80 }),
      queueStarving: true,
      categoryScoreThreshold: 75,
      scoreMargin: 5,
    })).toBe(true);
  });

  it('does not override candidates below the safety margin', () => {
    expect(shouldOverrideSoftEditorialReject({
      enabled: true,
      rejectReason: 'theme_daily_cap:theme:anything',
      ai: ai({ score: 79 }),
      queueStarving: true,
      categoryScoreThreshold: 75,
      scoreMargin: 5,
    })).toBe(false);
  });

  it('does not override semantic duplicates or hard-quality risk flags', () => {
    expect(shouldOverrideSoftEditorialReject({
      enabled: true,
      rejectReason: 'similar_semantic_story_recent_channel',
      ai: ai({ score: 95 }),
      queueStarving: true,
      categoryScoreThreshold: 75,
      scoreMargin: 5,
    })).toBe(false);

    expect(shouldOverrideSoftEditorialReject({
      enabled: true,
      rejectReason: 'audience_profile_requires_material_impact',
      ai: ai({
        score: 95,
        riskFlags: ['low_substance_market_commentary'],
      }),
      queueStarving: true,
      categoryScoreThreshold: 75,
      scoreMargin: 5,
    })).toBe(false);
  });
});
