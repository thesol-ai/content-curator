import { describe, expect, it } from 'vitest';

import {
  captionsUseSameTitle,
  truncateCaptionAtBoundary,
  validateAndCompactCaption,
} from '../apps/worker-api/src/services/caption-safety';

describe('caption safety', () => {
  it('allows numeric differences by product policy', () => {
    const decision =
      validateAndCompactCaption(
        'Version V4 reported 4,201 units at $50 with a 64% rate.',
        {
          captionShort:
            'گزارش تازه بیت‌کوین\n\nنسخه ۵ شامل ۴۲۰۰ واحد با قیمت ۵۵ دلار و نرخ ۶۵ درصد است.',
          captionFull:
            'گزارش تازه بیت‌کوین\n\nنسخه ۵ شامل ۴۲۰۰ واحد با قیمت ۵۵ دلار و نرخ ۶۵ درصد است.',
          hashtags: [],
        },
        {
          shortMaxChars: 280,
          fullMaxChars: 600,
        },
      );

    expect(decision.ok).toBe(true);
  });

  it('allows word-to-digit translation without numeric gating', () => {
    const decision =
      validateAndCompactCaption(
        'Interactive Brokers added trading support for nine tokens.',
        {
          captionShort:
            'افزوده‌شدن ۹ توکن به معاملات\n\nاین کارگزاری پشتیبانی از ۹ توکن را اضافه کرد.',
          captionFull:
            'افزوده‌شدن ۹ توکن به معاملات\n\nاین کارگزاری پشتیبانی از ۹ توکن را اضافه کرد.',
          hashtags: [],
        },
        {
          shortMaxChars: 280,
          fullMaxChars: 600,
        },
      );

    expect(decision.ok).toBe(true);
  });

  it('accepts Persian digits when values match the source', () => {
    const source =
      'The company bought 108 BTC, bringing total holdings to 4,201 BTC.';

    const decision = validateAndCompactCaption(
      source,
      {
        captionShort:
          'ذخایر بیت‌کوین شرکت به ۴۲۰۱ واحد رسید\n\nاین شرکت ۱۰۸ بیت‌کوین خرید.',
        captionFull:
          'ذخایر بیت‌کوین شرکت به ۴۲۰۱ واحد رسید\n\nاین شرکت ۱۰۸ بیت‌کوین خرید.',
        hashtags: [],
      },
      {
        shortMaxChars: 280,
        fullMaxChars: 600,
      },
    );

    expect(decision.ok).toBe(true);
  });

  it('rejects different titles between short and full captions', () => {
    expect(
      captionsUseSameTitle(
        'قیمت بیت‌کوین افزایش یافت\n\nمتن کوتاه.',
        'اتریوم رشد کرد\n\nمتن کامل.',
      ),
    ).toBe(false);
  });

  it('requires attribution for risky or unverified claims', () => {
    const source =
      'BlackRock reportedly bought $86.8 million in Bitcoin.';

    const decision = validateAndCompactCaption(
      source,
      {
        captionShort:
          'بلک‌راک ۸۶.۸ میلیون دلار بیت‌کوین خرید\n\nاین خرید انجام شده است.',
        captionFull:
          'بلک‌راک ۸۶.۸ میلیون دلار بیت‌کوین خرید\n\nاین خرید انجام شده است.',
        hashtags: [],
      },
      {
        riskFlags: ['unverified_claims'],
        shortMaxChars: 280,
        fullMaxChars: 600,
      },
    );

    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe(
      'caption_missing_required_attribution',
    );
  });

  it('accepts an attributed unverified claim', () => {
    const source =
      'BlackRock reportedly bought $86.8 million in Bitcoin.';

    const decision = validateAndCompactCaption(
      source,
      {
        captionShort:
          'گزارشی از خرید ۸۶.۸ میلیون دلار بیت‌کوین توسط بلک‌راک\n\nاین ادعا هنوز به‌طور مستقل تأیید نشده است.',
        captionFull:
          'گزارشی از خرید ۸۶.۸ میلیون دلار بیت‌کوین توسط بلک‌راک\n\nاین ادعا هنوز به‌طور مستقل تأیید نشده است.',
        hashtags: [],
      },
      {
        riskFlags: ['unverified_claims'],
        shortMaxChars: 280,
        fullMaxChars: 600,
      },
    );

    expect(decision.ok).toBe(true);
  });

  it('truncates at a complete sentence boundary', () => {
    const input =
      'آپدیت‌های هفتگی پروژه‌های کریپتو\n\n' +
      'BonkDAO با یک حمله حاکمیتی روبه‌رو شد. ' +
      'Moonbeam نیز برنامه تعطیلی کامل شبکه را اعلام کرد. ' +
      'این بخش نباید نصفه منتشر شود.';

    const result = truncateCaptionAtBoundary(input, 105);

    expect(result.length).toBeLessThanOrEqual(105);
    expect(result).not.toMatch(/(?:اگر|که|برای|با|از|در|به|و|یا|اما|ولی)$/u);
    expect(result).not.toContain('Moonbeam نیز برنامه');
  });

});
