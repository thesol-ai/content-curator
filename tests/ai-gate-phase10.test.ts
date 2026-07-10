import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasValidRtlCaptionLead, runAIGate } from '../apps/worker-api/src/services/ai-gate';
import type { CategoryRow, Env, NormalizedItem } from '../apps/worker-api/src/types';

function category(overrides: Partial<CategoryRow> = {}): CategoryRow {
  return {
    id: 'finance',
    label: 'Finance',
    prompt_profile: 'finance_editorial',
    custom_prompt: null,
    score_threshold: 75,
    freshness_hours: 24,
    media_mode: 'optional',
    language_targets: '["fa"]',
    enabled: 1,
    ...overrides,
  };
}

function item(overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    platform: 'x',
    sourceAccount: 'marketwatch',
    sourceUrl: 'https://x.com/marketwatch/status/123?utm_source=newsletter&ref_src=twsrc',
    postId: '123',
    publishedAt: Math.floor(Date.now() / 1000),
    text: 'Central bank rate decision and market context from a verified source.',
    media: [],
    engagementLikes: 42,
    engagementShares: 5,
    engagementViews: 900,
    mediaUrlExpiresSoon: false,
    ...overrides,
  };
}

function makeEnv(options: { callsToday?: number; tokensToday?: number } = {}) {
  const inserts: unknown[][] = [];
  const db = {
    prepare: vi.fn((sql: string) => ({
      first: vi.fn(async () => {
        if (sql.includes('FROM ai_usage')) {
          return { calls: options.callsToday ?? 0, tokens: options.tokensToday ?? 0 };
        }
        return null;
      }),
      bind: vi.fn((...values: unknown[]) => ({
        run: vi.fn(async () => {
          if (sql.includes('INSERT INTO ai_usage')) inserts.push(values);
          return { meta: { changes: 1 } };
        }),
        first: vi.fn(async () => null),
        all: vi.fn(async () => ({ results: [] })),
      })),
      run: vi.fn(async () => ({ meta: { changes: 1 } })),
      all: vi.fn(async () => ({ results: [] })),
    })),
  };

  const env = {
    DB: db,
    APIFY_CURATION_DRY_RUN: 'false',
    ANTHROPIC_API_KEY: 'anthropic-test',
    GEMINI_API_KEY: 'gemini-test',
    AI_SCORING_MODEL: 'claude-haiku-4-5-20251001',
    AI_MAX_CALLS_PER_DAY: '10',
    AI_DAILY_TOKEN_BUDGET: '50000',
    AI_MAX_TEXT_CHARS_PER_ITEM: '400',
    AI_MAX_OUTPUT_TOKENS: '2048',
    AI_MAX_RETRIES: '0',
    TRANSLATION_PROVIDER: 'gemini',
    TRANSLATION_MODEL: 'gemini-2.5-flash-lite',
  } as unknown as Env;

  return { env, inserts, db };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('phase 10 AI reliability and cost guardrails', () => {
  it('skips Claude scoring when the daily scoring call budget is exhausted', async () => {
    const { env, inserts } = makeEnv({ callsToday: 10 });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const [result] = await runAIGate(env, [item()], category(), [], []);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.publish).toBe(false);
    expect(result.riskFlags).toContain('ai_budget_exceeded');
    expect(inserts.some(values => values.includes('skipped'))).toBe(true);
  });

  it('records token usage for Claude scoring and Gemini translation', async () => {
    const { env, inserts } = makeEnv({ callsToday: 0, tokensToday: 0 });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('anthropic.com')) {
        return Response.json({
          usage: { input_tokens: 111, output_tokens: 22 },
          content: [{ text: JSON.stringify({ items: [{
            url: 'https://x.com/marketwatch/status/123',
            post_id: '123',
            publish: true,
            score: 90,
            risk_level: 'low',
            risk_flags: [],
            topic_fingerprint: 'rate-decision',
            publish_priority: 'normal',
          }] }) }],
        });
      }
      return Response.json({
        usageMetadata: { promptTokenCount: 333, candidatesTokenCount: 44 },
        candidates: [{ content: { parts: [{ text: JSON.stringify({ items: [{
          url: 'https://x.com/marketwatch/status/123',
          translations: { fa: { caption_short: 'خبر کوتاه', caption_full: 'متن کامل خبر با توضیح فارسی', hashtags: ['مالی'] } },
        }] }) }] } }],
      });
    }));

    const [result] = await runAIGate(env, [item()], category(), [], []);

    expect(result.publish).toBe(true);
    expect(result.translations.fa.captionShort).toBe('خبر کوتاه');
    expect(inserts.some(values => values.includes('anthropic') && values.includes('scoring') && values.includes(111) && values.includes(22))).toBe(true);
    expect(inserts.some(values => values.includes('gemini') && values.includes('translation') && values.includes(333) && values.includes(44))).toBe(true);
  });

  it('surfaces missing translation targets as explicit risk flags without hiding the item', async () => {
    const { env } = makeEnv({ callsToday: 0, tokensToday: 0 });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('anthropic.com')) {
        return Response.json({
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ text: JSON.stringify({ items: [{
            url: 'https://x.com/marketwatch/status/123', post_id: '123', publish: true, score: 90,
            risk_level: 'low', risk_flags: [], topic_fingerprint: 'rate-decision', publish_priority: 'normal',
          }] }) }],
        });
      }
      return Response.json({
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 },
        candidates: [{ content: { parts: [{ text: JSON.stringify({ items: [{
          url: 'https://x.com/marketwatch/status/123',
          translations: { fa: { caption_short: 'فارسی', caption_full: 'متن فارسی', hashtags: [] } },
        }] }) }] } }],
      });
    }));

    const [result] = await runAIGate(env, [item()], category({ language_targets: '["fa","en"]' }), [], []);

    expect(result.publish).toBe(true);
    expect(result.translations.fa).toBeTruthy();
    expect(result.translations.en).toBeUndefined();
    expect(result.riskFlags).toContain('translation_missing:en');
  });

  it('repairs Persian translations that start with English before publishing them', async () => {
    const { env } = makeEnv({ callsToday: 0, tokensToday: 0 });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('anthropic.com')) {
        return Response.json({
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ text: JSON.stringify({ items: [{
            url: 'https://x.com/marketwatch/status/123',
            post_id: '123',
            publish: true,
            score: 90,
            risk_level: 'low',
            risk_flags: [],
            topic_fingerprint: 'bitcoin-etf-flow',
            publish_priority: 'normal',
          }] }) }],
        });
      }

      const body = JSON.parse(String(init?.body ?? '{}'));
      const systemText = body?.system_instruction?.parts?.[0]?.text ?? '';

      if (systemText.includes('repair Telegram captions')) {
        return Response.json({
          usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 12 },
          candidates: [{ content: { parts: [{ text: JSON.stringify({
            caption_short: 'بیت‌کوین دوباره خبرساز شد',
            caption_full: 'بیت‌کوین با رشد تقاضای صندوق‌های ETF دوباره در مرکز توجه بازار قرار گرفته است.',
          }) }] } }],
        });
      }

      return Response.json({
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 },
        candidates: [{ content: { parts: [{ text: JSON.stringify({ items: [{
          url: 'https://x.com/marketwatch/status/123',
          post_id: '123',
          translations: {
            fa: {
              caption_short: 'Bitcoin دوباره خبرساز شد',
              caption_full: 'Bitcoin با رشد تقاضای صندوق‌های ETF دوباره در مرکز توجه بازار قرار گرفته است.',
              hashtags: ['کریپتو'],
            },
          },
        }] }) }] } }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const [result] = await runAIGate(env, [item()], category(), [], []);

    expect(result.publish).toBe(true);
    expect(result.translations.fa.captionShort).toBe('بیت‌کوین دوباره خبرساز شد');
    expect(result.translations.fa.captionFull).toContain('بیت‌کوین');
    expect(hasValidRtlCaptionLead(result.translations.fa.captionShort, 'fa')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('detects invalid RTL caption starts after optional emoji and punctuation', () => {
    expect(hasValidRtlCaptionLead('📊 بیت‌کوین رشد کرد', 'fa')).toBe(true);
    expect(hasValidRtlCaptionLead('📊 Bitcoin rallied', 'fa')).toBe(false);
    expect(hasValidRtlCaptionLead('$BTC rallied', 'fa')).toBe(false);
    expect(hasValidRtlCaptionLead('«بیت‌کوین» رشد کرد', 'fa')).toBe(true);

    expect(
      hasValidRtlCaptionLead(
        '📊 تیتر فارسی معتبر است.\n\nNewCompany محصول تازه‌ای معرفی کرد.',
        'fa',
      ),
    ).toBe(false);

    expect(
      hasValidRtlCaptionLead(
        '📊 تیتر فارسی معتبر است.\n\nشرکت NewCompany محصول تازه‌ای معرفی کرد.',
        'fa',
      ),
    ).toBe(true);

    expect(
      hasValidRtlCaptionLead(
        '📊 تیتر فارسی معتبر است.\n\n۲۰ شرکت در این طرح حضور دارند.',
        'fa',
      ),
    ).toBe(false);

    expect(hasValidRtlCaptionLead('Bitcoin rallied', 'en')).toBe(true);
  });

});
