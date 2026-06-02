import { describe, expect, it } from 'vitest';
import { runAIGate } from '../apps/worker-api/src/services/ai-gate';
import type { CategoryRow, ChannelRow, Env, NormalizedItem } from '../apps/worker-api/src/types';

function env(): Env {
  return {
    APIFY_CURATION_DRY_RUN: 'true',
    AI_SCORING_MODEL: 'claude-haiku-4-5-20251001',
    TRANSLATION_PROVIDER: 'gemini',
    TRANSLATION_MODEL: 'gemini-2.5-flash-lite',
    AI_MAX_TEXT_CHARS_PER_ITEM: '400',
    AI_MAX_RETRIES: '1',
  } as unknown as Env;
}

function category(overrides: Partial<CategoryRow> = {}): CategoryRow {
  return {
    id: 'crypto',
    label: 'Crypto',
    prompt_profile: 'crypto_editorial',
    custom_prompt: null,
    score_threshold: 75,
    freshness_hours: 24,
    media_mode: 'optional',
    language_targets: '["fa","en"]',
    enabled: 1,
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

function item(): NormalizedItem {
  return {
    platform: 'x',
    sourceAccount: 'coindesk',
    sourceUrl: 'https://x.com/coindesk/status/1',
    postId: '1',
    publishedAt: Math.floor(Date.now() / 1000),
    text: 'Bitcoin ETF update with market context.',
    media: [],
    engagementLikes: 10,
    engagementShares: 2,
    engagementViews: 100,
    mediaUrlExpiresSoon: false,
  };
}

describe('phase 8 AI prompt/channel target wiring', () => {
  it('keeps language-level translation keys when channels have no custom AI context', async () => {
    const [result] = await runAIGate(env(), [item()], category(), [], [channel()]);
    expect(Object.keys(result.translations).sort()).toEqual(['en', 'fa']);
  });

  it('adds channel-specific translation keys only for channels with custom tone/instructions/label', async () => {
    const [result] = await runAIGate(env(), [item()], category(), [], [
      channel({ id: 'crypto_fa' }),
      channel({ id: 'crypto_fa_pro', custom_instructions: 'Use an analytical tone for professional traders.', tone_profile: 'analytical', channel_label: 'Crypto Pro FA' }),
    ]);

    expect(result.translations.fa).toBeTruthy();
    expect(result.translations.en).toBeTruthy();
    expect(result.translations['channel:crypto_fa']).toBeUndefined();
    expect(result.translations['channel:crypto_fa_pro']).toBeTruthy();
  });
});
