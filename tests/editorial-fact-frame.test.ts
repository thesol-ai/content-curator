import { describe, expect, it } from 'vitest';
import {
  buildTranslationSystem,
  buildTranslationUser,
  parseEditorialFactFrame,
  type TranslationTarget,
} from '../apps/worker-api/src/services/ai-gate';
import type {
  CategoryRow,
  EditorialFactFrame,
  NormalizedItem,
} from '../apps/worker-api/src/types';

function item(overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    platform: 'rss',
    sourceAccount: 'example',
    sourceUrl: 'https://example.com/news/1',
    postId: 'news-1',
    publishedAt: 1_700_000_000,
    text: 'Company X said its product could launch in Q4.',
    fullText: 'The CEO said the schedule remains conditional and no exact release date has been confirmed.',
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
    captionStyle: 'straight_news',
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
    id: 'general',
    label: 'General',
    prompt_profile: 'default_editorial',
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
  };
}

describe('editorial fact frame', () => {
  it('parses and sanitizes a valid Claude editorial frame', () => {
    const frame = parseEditorialFactFrame({
      headline_fact: '  The CEO said the product could launch in Q4.  ',
      claim_type: 'forecast',
      attribution: 'The CEO',
      must_include: ['Company X', 'Q4', 'Company X'],
      forbidden_inferences: [
        'The launch is confirmed.',
        'An exact release date is known.',
      ],
    });

    expect(frame).toEqual({
      headlineFact: 'The CEO said the product could launch in Q4.',
      claimType: 'forecast',
      attribution: 'The CEO',
      mustInclude: ['Company X', 'Q4'],
      forbiddenInferences: [
        'The launch is confirmed.',
        'An exact release date is known.',
      ],
    });
  });

  it('returns null when no usable headline fact exists', () => {
    expect(parseEditorialFactFrame(null)).toBeNull();
    expect(parseEditorialFactFrame({ headline_fact: '   ' })).toBeNull();
  });

  it('passes the frame and fuller source context to Gemini', () => {
    const source = item();
    const frame: EditorialFactFrame = {
      headlineFact: 'The CEO said the product could launch in Q4.',
      claimType: 'forecast',
      attribution: 'The CEO',
      mustInclude: ['Company X', 'Q4'],
      forbiddenInferences: ['The launch is confirmed.'],
    };

    const user = buildTranslationUser(
      [source],
      [target()],
      1200,
      new Map([[source.postId, frame]]),
    );

    expect(user).toContain(
      '"headline_fact":"The CEO said the product could launch in Q4."',
    );
    expect(user).toContain('"claim_type":"forecast"');
    expect(user).toContain('"attribution":"The CEO"');
    expect(user).toContain(
      'The CEO said the schedule remains conditional',
    );
  });

  it('tells the writer to use the frame without copying it mechanically', () => {
    const system = buildTranslationSystem([target()], category());

    expect(system).toContain(
      'treat it as a factual boundary for the rewrite',
    );
    expect(system).toContain(
      'Do not translate headline_fact word-for-word',
    );
    expect(system).toContain(
      'Never turn an opinion, forecast, allegation, or estimate into a confirmed fact',
    );
  });
});
