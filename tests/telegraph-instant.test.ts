import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  buildLinkedTelegramCaptionHtml,
  buildTelegraphArticleDraft,
} from '../apps/worker-api/src/services/telegraph-instant';

describe(
  'Telegraph Instant article policy',
  () => {
    it(
      'does not create an article for title plus one body paragraph',
      () => {
        const draft =
          buildTelegraphArticleDraft(
            'عنوان\n\nخلاصه خبر.',
            'عنوان\n\nفقط یک پاراگراف بدنه.',
            'https://example.com/source',
          );

        expect(
          draft.eligible,
        ).toBe(false);

        expect(
          draft.reason,
        ).toBe(
          'single_body_paragraph',
        );

        expect(
          draft.bodyParagraphCount,
        ).toBe(1);
      },
    );

    it(
      'creates an article for title plus two body paragraphs',
      () => {
        const draft =
          buildTelegraphArticleDraft(
            'عنوان\n\nخلاصه خبر.',
            [
              'عنوان',
              '',
              'پاراگراف اول خبر.',
              '',
              'پاراگراف دوم خبر.',
            ].join('\n'),
            'https://example.com/source',
          );

        expect(
          draft.eligible,
        ).toBe(true);

        expect(
          draft.reason,
        ).toBe('eligible');

        expect(
          draft.bodyParagraphCount,
        ).toBe(2);

        expect(
          draft.content,
        ).toContainEqual({
          tag: 'p',
          children: [
            'پاراگراف اول خبر.',
          ],
        });
      },
    );

    it(
      'does not create an article when short and full captions are identical',
      () => {
        const caption =
          'عنوان\n\nیک پاراگراف کوتاه.';

        const draft =
          buildTelegraphArticleDraft(
            caption,
            caption,
            'https://example.com/source',
          );

        expect(
          draft.eligible,
        ).toBe(false);

        expect(
          draft.reason,
        ).toBe(
          'same_short_and_full',
        );
      },
    );

    it(
      'matches the paragraph shape of Telegram post 1508',
      () => {
        const shortCaption =
          '📊 خروج ۱.۸ میلیارد دلار USDC از بایننس در سه ماهه دوم ۲۰۲۶\n\n'
          + 'صرافی بایننس در سه ماهه دوم سال ۲۰۲۶ شاهد خروج خالص ۱.۸ میلیارد دلار استیبل‌کوین USDC بوده است.';

        const fullCaption =
          [
            '📊 خروج ۱.۸ میلیارد دلار USDC از بایننس در سه ماهه دوم ۲۰۲۶',
            '',
            'صرافی بایننس در سه ماهه دوم سال ۲۰۲۶ شاهد خروج خالص ۱.۸ میلیارد دلار استیبل‌کوین USDC بوده است.',
            '',
            'این خروج سرمایه همزمان با چالش‌های بایننس در دریافت مجوز MiCA رخ داده است.',
          ].join('\n');

        const draft =
          buildTelegraphArticleDraft(
            shortCaption,
            fullCaption,
            'https://x.com/example/status/1508',
          );

        expect(
          draft.eligible,
        ).toBe(true);

        expect(
          draft.bodyParagraphCount,
        ).toBe(2);
      },
    );

    it(
      'builds a safe HTML caption with a linked خبر کامل',
      () => {
        const result =
          buildLinkedTelegramCaptionHtml(
            'عنوان & خلاصه <خبر>',
            'https://telegra.ph/Test-Page-01-01',
          );

        expect(result).toContain(
          'عنوان &amp; خلاصه &lt;خبر&gt;',
        );

        expect(result).toContain(
          '<a href="https://telegra.ph/Test-Page-01-01">خبر کامل</a>',
        );
      },
    );
  },
);
