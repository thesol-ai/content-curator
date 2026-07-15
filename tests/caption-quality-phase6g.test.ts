import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  applyPersianCaptionQualityGuard,
} from '../apps/worker-api/src/services/story-quality-guard';

import type {
  TranslationOutput,
} from '../apps/worker-api/src/types';

function t(
  captionFull: string,
  captionShort = '',
): TranslationOutput {
  return {
    captionShort,
    captionFull,
    hashtags: [],
  };
}

describe(
  'Persian caption quality guard (Phase 6G)',
  () => {
    it('passes a concrete caption', () => {
      const result =
        applyPersianCaptionQualityGuard(
          'fa',
          t(
            'نوبیتکس در پی هک ۸۱.۷ میلیون دلار از دست داد.',
          ),
          'Nobitex lost $81.7 million after a hack.',
        );

      expect(result.ok).toBe(true);
    });

    it('rejects banned filler with no material signal', () => {
      const result =
        applyPersianCaptionQualityGuard(
          'fa',
          t(
            'این خبر نشان‌دهنده پذیرش نهادی است.',
          ),
          'A protocol announced an integration.',
        );

      expect(result.ok).toBe(false);
      expect(result.reason).toBe(
        'caption_generic_filler',
      );
    });

    it('keeps filler-flavored text with a material crypto signal', () => {
      const result =
        applyPersianCaptionQualityGuard(
          'fa',
          t(
            'ورود ۱۲۰ میلیون دلار به ETF؛ گامی در جهت پذیرش بیشتر.',
          ),
          'ETF saw $120 million net inflows.',
        );

      expect(result.ok).toBe(true);
    });

    it('does not reject numeric claims absent from the source', () => {
      const result =
        applyPersianCaptionQualityGuard(
          'fa',
          t(
            'ارزش این محصول کریپتویی به ۲ میلیارد دلار رسیده است.',
          ),
          'The company described its new crypto product.',
        );

      expect(result.ok).toBe(true);
    });

    it('accepts changed amounts, percentages, counts, and versions', () => {
      const result =
        applyPersianCaptionQualityGuard(
          'fa',
          t(
            'نسخه ۵ بیت‌کوین شامل ۴۲۰۰ واحد با نرخ ۶۵ درصد و قیمت ۵۵ دلار است.',
          ),
          'Version V4 contains 4,201 units at 64% and $50.',
        );

      expect(result.ok).toBe(true);
    });

    it('still catches year mismatch', () => {
      const result =
        applyPersianCaptionQualityGuard(
          'fa',
          t(
            'در سال ۲۰۲۴ این قانون تغییر کرد.',
          ),
          'In 2026 the rule changed.',
        );

      expect(result.ok).toBe(false);
      expect(result.reason).toBe(
        'caption_year_mismatch',
      );
    });

    it('is a no-op for non-Persian languages', () => {
      const result =
        applyPersianCaptionQualityGuard(
          'en',
          t(
            'This is worth $2 billion not in source.',
          ),
          'no figures',
        );

      expect(result.ok).toBe(true);
    });
  },
);
