import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishToTelegram } from '../apps/worker-api/src/services/telegram-publisher';
import type { Env } from '../apps/worker-api/src/types';

function settingsDb(settings: Record<string, string> = { telegram_publish_enabled: 'true' }): any {
  return {
    prepare: vi.fn(() => ({
      all: vi.fn(async () => ({
        results: Object.entries(settings).map(([key, value]) => ({ key, value })),
      })),
    })),
  };
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    TELEGRAM_FINAL_PUBLISH_ENABLED: 'true',
    TELEGRAM_PUBLISH_SCHEDULER_ENABLED: 'true',
    TELEGRAM_BOT_TOKEN: '123:test-token',
    MEDIA_PROCESSING_MODE: 'direct_url',
    MEDIA_GROUP_PARTIAL_PUBLISH_ENABLED: 'true',
    DB: settingsDb(),
    ...overrides,
  } as Env;
}

describe('telegram publisher method safety regression', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fails safely for unknown Telegram methods without calling Telegram', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await publishToTelegram(env(), {
      chatId: '@test_channel',
      captionShort: 'Short',
      captionFull: 'Full',
      sourceUrl: 'https://x.com/example/status/1',
      method: 'sendRichMessage' as any,
      language: 'fa',
      mediaUrls: [],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Unknown method: sendRichMessage');
    expect(result.errorType).toBe('unknown');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the publish kill-switch ahead of method handling', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await publishToTelegram(env({
      TELEGRAM_FINAL_PUBLISH_ENABLED: 'false',
    }), {
      chatId: '@test_channel',
      captionShort: 'Short',
      captionFull: 'Full',
      sourceUrl: 'https://x.com/example/status/1',
      method: 'sendRichMessage' as any,
      language: 'fa',
      mediaUrls: [],
    });

    expect(result).toMatchObject({ ok: true, messageId: 'disabled_skip' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
