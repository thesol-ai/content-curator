import { describe, expect, it } from 'vitest';
import {
  buildTranslationResponseSchema,
  extractGeminiCandidateText,
  getGeminiFinishReason,
} from '../apps/worker-api/src/services/ai-gate';

describe('Gemini translation response handling', () => {
  it('joins all text parts before JSON parsing', () => {
    const body = {
      candidates: [{
        finishReason: 'STOP',
        content: {
          parts: [
            { text: '{"items":[{"post_id":"123",' },
            { text: '"translations":{"fa":{"caption_short":"خبر",' },
            { text: '"caption_full":"متن","hashtags":[]}}}]}' },
          ],
        },
      }],
    };

    const text = extractGeminiCandidateText(body);

    expect(JSON.parse(text)).toEqual({
      items: [{
        post_id: '123',
        translations: {
          fa: {
            caption_short: 'خبر',
            caption_full: 'متن',
            hashtags: [],
          },
        },
      }],
    });
  });

  it('ignores non-text Gemini parts', () => {
    const body = {
      candidates: [{
        content: {
          parts: [
            { text: '{"items":[]}' },
            { functionCall: { name: 'ignored' } },
          ],
        },
      }],
    };

    expect(extractGeminiCandidateText(body)).toBe('{"items":[]}');
  });

  it('reads the finish reason', () => {
    expect(getGeminiFinishReason({
      candidates: [{ finishReason: 'MAX_TOKENS' }],
    })).toBe('MAX_TOKENS');
  });

  it('requires every configured translation target in the response schema', () => {
    const schema = buildTranslationResponseSchema([
      { key: 'fa' },
      { key: 'channel:crypto_fa_pilot' },
    ] as any);

    const translations =
      (schema as any)
        .properties
        .items
        .items
        .properties
        .translations;

    expect(schema).toMatchObject({
      type: 'OBJECT',
      required: ['items'],
    });

    expect(translations.required).toEqual([
      'fa',
      'channel:crypto_fa_pilot',
    ]);

    expect(Object.keys(translations.properties)).toEqual([
      'fa',
      'channel:crypto_fa_pilot',
    ]);
  });
});
