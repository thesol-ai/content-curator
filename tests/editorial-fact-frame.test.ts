import { describe, expect, it } from 'vitest';

import {
  buildTranslationScoringContext,
  buildTranslationSystem,
  buildTranslationUser,
} from '../apps/worker-api/src/services/ai-gate';

import type {
  TranslationScoringContext,
  TranslationTarget,
} from '../apps/worker-api/src/services/ai-gate';

import type {
  AIGateResult,
  CategoryRow,
  NormalizedItem,
} from '../apps/worker-api/src/types';

function item(
  overrides: Partial<NormalizedItem> = {},
): NormalizedItem {
  return {
    platform: 'x',
    sourceAccount: 'example_account',
    sourceUrl: 'https://x.com/example/status/123',
    postId: '123',
    publishedAt: 1_720_000_000,
    text: 'The company said the product could launch in Q4.',
    media: [],
    engagementLikes: 0,
    engagementShares: 0,
    engagementViews: 0,
    mediaUrlExpiresSoon: false,
    ...overrides,
  };
}

function target(): TranslationTarget {
  return {
    key: 'fa',
    language: 'fa',
    label: 'Persian',
    toneProfile: 'neutral',
    customInstructions: '',
    editorialMode: 'news',
    audienceLevel: 'intermediate',
    captionStyle: 'contextual',
    creativityLevel: 0.2,
    captionMaxChars: 1200,
    captionShortMaxChars: 280,
    languagePrompt: '',
    terminologyNotes: '',
    forbiddenPhrases: [],
  };
}

function category(): CategoryRow {
  return {
    id: 'crypto',
    label: 'Crypto',
    prompt_profile: 'crypto_editorial',
    custom_prompt: null,
    score_threshold: 75,
    freshness_hours: 24,
    media_mode: 'optional',
    language_targets: '["fa"]',
    editorial_guidelines: null,
    selection_criteria: null,
    rejection_criteria: null,
    required_context: null,
    avoid_duplicate_people_stories: 1,
    enabled: 1,
  } as CategoryRow;
}

describe('Gemini-only editorial fact framing', () => {
  it('converts existing Claude scoring metadata into advisory translation context', () => {
    const result: AIGateResult = {
      publish: true,
      score: 88,
      riskLevel: 'medium',
      riskFlags: ['unverified_claims'],
      topicFingerprint: 'company-product-q4-launch',
      publishPriority: 'high',
      translations: {},
      storyKey: 'company|product_launch_forecast|2026-07-11',
      storyFields: {
        primaryEntities: ['Company X', 'Product Y'],
        eventType: 'product_launch_forecast',
        canonicalDate: '2026-07-11',
      },
    };

    expect(buildTranslationScoringContext(result)).toEqual({
      score: 88,
      risk_level: 'medium',
      risk_flags: ['unverified_claims'],
      topic_fingerprint: 'company-product-q4-launch',
      publish_priority: 'high',
      story_key: 'company|product_launch_forecast|2026-07-11',
      primary_entities: ['Company X', 'Product Y'],
      event_type: 'product_launch_forecast',
      canonical_date: '2026-07-11',
    });
  });

  it('sends context only for the items already passed to translation', () => {
    const finalItem = item({
      postId: 'final-1',
      sourceUrl: 'https://x.com/example/status/final-1',
      text: 'The CEO said Product Y could launch in Q4.',
    });

    const finalContext: TranslationScoringContext = {
      score: 88,
      risk_level: 'medium',
      risk_flags: [],
      topic_fingerprint: 'product-y-q4-forecast',
      publish_priority: 'high',
      story_key: null,
      primary_entities: ['Product Y'],
      event_type: 'product_launch_forecast',
      canonical_date: '',
    };

    const contexts = new Map<string, TranslationScoringContext>([
      [finalItem.postId, finalContext],
      [
        'rejected-1',
        {
          ...finalContext,
          topic_fingerprint: 'rejected-story',
        },
      ],
    ]);

    const user = buildTranslationUser(
      [finalItem],
      [target()],
      1200,
      contexts,
    );

    const serializedPayload = user.split('\n').at(-1);
    const payload = JSON.parse(serializedPayload ?? '[]');

    expect(payload).toHaveLength(1);
    expect(payload[0].post_id).toBe('final-1');
    expect(payload[0].scoring_context).toEqual(finalContext);
    expect(user).not.toContain('rejected-1');
    expect(user).not.toContain('rejected-story');
  });

  it('keeps the translation response schema unchanged', () => {
    const system = buildTranslationSystem([target()], category());

    expect(system).toContain(
      'privately construct an editorial fact frame',
    );
    expect(system).toContain(
      'The supplied source text is authoritative',
    );
    expect(system).toContain(
      'Do not output the editorial fact frame',
    );

    expect(system).toContain(
      '{"items":[{"post_id":"...","url":"...","translations":',
    );

    expect(system).not.toContain('"editorial_frame"');
  });

  it('works without optional story-intelligence fields', () => {
    const result: AIGateResult = {
      publish: true,
      score: 80,
      riskLevel: 'low',
      riskFlags: [],
      topicFingerprint: 'plain-topic',
      publishPriority: 'normal',
      translations: {},
    };

    expect(buildTranslationScoringContext(result)).toEqual({
      score: 80,
      risk_level: 'low',
      risk_flags: [],
      topic_fingerprint: 'plain-topic',
      publish_priority: 'normal',
      story_key: null,
      primary_entities: [],
      event_type: '',
      canonical_date: '',
    });
  });
});
