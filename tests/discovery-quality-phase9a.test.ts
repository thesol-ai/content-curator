import { describe, expect, it, vi } from 'vitest';
import { buildTranslationSystem, type TranslationTarget } from '../apps/worker-api/src/services/ai-gate';
import { findRecentStoryDuplicate, normalizeStoryFingerprint } from '../apps/worker-api/src/services/story-dedupe';
import type { CategoryRow, Env } from '../apps/worker-api/src/types';

function target(): TranslationTarget {
  return {
    key: 'channel:crypto_fa_pilot',
    language: 'fa',
    label: 'crypto_fa_pilot',
    toneProfile: 'neutral',
    customInstructions: '',
    channelId: 'crypto_fa_pilot',
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
    allow_replies: 0,
    allow_retweets: 1,
    allow_quotes: 1,
    text_only_policy: 'allow',
    min_score_for_text_only: null,
    min_score_for_media: null,
    enabled: 1,
  } as CategoryRow;
}

describe('Phase 9A discovery quality', () => {
  it('locks Persian caption start without static caption injection', () => {
    const system = buildTranslationSystem([target()], category());

    expect(system).toContain('Optional leading emoji is allowed');
    expect(system).toContain('first real word after any emoji');
    expect(system).toContain('MUST be Persian');
    expect(system).toContain('Do not use a fixed or static prefix');
    expect(system).toContain('Do not force emojis');
  });

  it('normalizes only useful story fingerprints', () => {
    expect(normalizeStoryFingerprint('mastercard-ai-agent-payments')).toBe('mastercard-ai-agent-payments');
    expect(normalizeStoryFingerprint('crypto-news')).toBeNull();
    expect(normalizeStoryFingerprint('fp-123456789')).toBeNull();
    expect(normalizeStoryFingerprint('ns-123456789')).toBeNull();
  });

  it('finds a recent scheduled or published story duplicate', async () => {
    const first = vi.fn(async () => ({
      queue_id: 'q_1',
      item_id: 'item_1',
      status: 'published',
      published_at: 1781150000,
      scheduled_at: 1781150000,
      source_account: 'CoinDesk',
    }));

    const env = {
      DB: {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({ first })),
        })),
      },
    } as unknown as Env;

    const result = await findRecentStoryDuplicate(env, 'crypto_fa_pilot', 'mastercard-ai-agent-payments', 72);

    expect(result.duplicate).toBe(true);
    expect(result.queueId).toBe('q_1');
    expect(result.sourceAccount).toBe('CoinDesk');
  });
});
