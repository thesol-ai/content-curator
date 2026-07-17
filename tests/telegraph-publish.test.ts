import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type { Env } from '../apps/worker-api/src/types';
import type { PublishInput } from '../apps/worker-api/src/services/telegram-publisher';

import {
  prepareTelegraphPublishInput,
} from '../apps/worker-api/src/services/telegraph-publish';

function makeEnv(
  overrides: Record<string, unknown> = {},
): Env {
  return {
    TELEGRAPH_INSTANT_ENABLED: 'true',
    TELEGRAPH_INSTANT_CHANNEL_ALLOWLIST:
      'crypto_fa_pilot',
    TELEGRAPH_ACCESS_TOKEN:
      'test-telegraph-access-token',
    TELEGRAPH_INSTANT_TIMEOUT_MS: '5000',
    TELEGRAPH_INSTANT_AUTHOR_NAME: 'The Sol',
    TELEGRAPH_INSTANT_AUTHOR_URL:
      'https://t.me/thesolcrypto_fa',
    TELEGRAPH_INSTANT_LINK_LABEL:
      '📖 ادامه مطلب',
    ...overrides,
  } as unknown as Env;
}

function makeInput(
  overrides: Partial<PublishInput> = {},
): PublishInput {
  return {
    chatId: '@thesolcrypto_fa',
    captionShort:
      'عنوان خبر\n\nخلاصه کوتاه خبر',
    captionFull:
      'عنوان خبر\n\nپاراگراف اول\n\nپاراگراف دوم',
    sourceUrl:
      'https://example.com/original-story',
    method: 'sendPhoto',
    language: 'fa',
    mediaUrls: [
      'https://example.com/photo.jpg',
    ],
    mediaTypes: ['image'],
    channel: {
      id: 'crypto_fa_pilot',
      telegram_chat_id:
        '@thesolcrypto_fa',
      language: 'fa',
      source_enabled: 1,
      source_label_override: '🌏 Source',
      channel_id_footer_enabled: 1,
      channel_id_footer: '@thesolcrypto_fa',
    } as any,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe(
  'prepareTelegraphPublishInput',
  () => {
    it(
      'leaves the old path untouched when disabled',
      async () => {
        const input = makeInput();

        const fetchMock = vi.fn();

        vi.stubGlobal(
          'fetch',
          fetchMock,
        );

        const result =
          await prepareTelegraphPublishInput(
            makeEnv({
              TELEGRAPH_INSTANT_ENABLED:
                'false',
            }),
            input,
            {
              channelId:
                'crypto_fa_pilot',
              retryCount: 0,
            },
          );

        expect(result.applied)
          .toBe(false);

        expect(result.reason)
          .toBe('disabled');

        expect(result.input)
          .toBe(input);

        expect(fetchMock)
          .not
          .toHaveBeenCalled();
      },
    );

    it(
      'does not create duplicate Telegraph pages on retry',
      async () => {
        const input = makeInput();

        const fetchMock = vi.fn();

        vi.stubGlobal(
          'fetch',
          fetchMock,
        );

        const result =
          await prepareTelegraphPublishInput(
            makeEnv(),
            input,
            {
              channelId:
                'crypto_fa_pilot',
              retryCount: 1,
            },
          );

        expect(result.applied)
          .toBe(false);

        expect(result.reason)
          .toBe('retry');

        expect(result.input)
          .toBe(input);

        expect(fetchMock)
          .not
          .toHaveBeenCalled();
      },
    );

    it(
      'keeps a single-body-paragraph post on the old path',
      async () => {
        const input = makeInput({
          captionFull:
            'عنوان خبر\n\nفقط یک پاراگراف',
        });

        const fetchMock = vi.fn();

        vi.stubGlobal(
          'fetch',
          fetchMock,
        );

        const result =
          await prepareTelegraphPublishInput(
            makeEnv(),
            input,
            {
              channelId:
                'crypto_fa_pilot',
              retryCount: 0,
            },
          );

        expect(result.applied)
          .toBe(false);

        expect(result.reason)
          .toBe('ineligible');

        expect(result.input)
          .toBe(input);

        expect(fetchMock)
          .not
          .toHaveBeenCalled();
      },
    );

    it(
      'replaces only the publish input after Telegraph succeeds',
      async () => {
        const input = makeInput();

        const fetchMock = vi.fn()
          .mockResolvedValue(
            new Response(
              JSON.stringify({
                ok: true,
                result: {
                  path:
                    'Test-Article-07-16',
                  url:
                    'https://telegra.ph/Test-Article-07-16',
                  title:
                    'عنوان خبر',
                  views: 0,
                },
              }),
              {
                status: 200,
                headers: {
                  'Content-Type':
                    'application/json',
                },
              },
            ),
          );

        vi.stubGlobal(
          'fetch',
          fetchMock,
        );

        const result =
          await prepareTelegraphPublishInput(
            makeEnv(),
            input,
            {
              channelId:
                'crypto_fa_pilot',
              retryCount: 0,
            },
          );

        expect(result.applied)
          .toBe(true);

        expect(result.reason)
          .toBe('created');

        expect(result.input.captionFull)
          .toBe(input.captionShort);

        expect(result.input.captionShort)
          .toBe(input.captionShort);

        expect(result.input.sourceUrl)
          .toBe(
            'https://telegra.ph/Test-Article-07-16',
          );

        const captionHtml =
          result.input.captionShortHtml
          ?? '';

        expect(captionHtml)
          .toContain(
            'خلاصه کوتاه خبر\n\n'
            + '<a href="https://telegra.ph/Test-Article-07-16">'
            + '📖 ادامه مطلب</a>',
          );

        expect(captionHtml)
          .not
          .toContain(
            'خلاصه کوتاه خبر\n'
            + '<a href="https://telegra.ph/Test-Article-07-16">',
          );

        expect(captionHtml)
          .toContain(
            '📖 ادامه مطلب</a>\n\n'
            + '@thesolcrypto_fa',
          );

        expect(
          result.input.captionFullHtml,
        ).toBe(
          result.input.captionShortHtml,
        );

        expect(
          result.input.channel,
        ).toBe(input.channel);

        expect(captionHtml.length)
          .toBeLessThanOrEqual(1024);

        expect(fetchMock)
          .toHaveBeenCalledTimes(1);
      },
    );

    it(
      'fails open when Telegraph creation fails',
      async () => {
        const input = makeInput();

        vi.stubGlobal(
          'fetch',
          vi.fn().mockRejectedValue(
            new Error(
              'temporary telegraph failure',
            ),
          ),
        );

        const result =
          await prepareTelegraphPublishInput(
            makeEnv(),
            input,
            {
              channelId:
                'crypto_fa_pilot',
              retryCount: 0,
            },
          );

        expect(result.applied)
          .toBe(false);

        expect(result.reason)
          .toBe('create_failed');

        expect(result.input)
          .toBe(input);
      },
    );
  },
);
