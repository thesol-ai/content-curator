import { describe, expect, it } from 'vitest';
import { applyPersianCaptionQualityGuard } from '../apps/worker-api/src/services/story-quality-guard';
import type { TranslationOutput } from '../apps/worker-api/src/types';

function t(captionFull: string, captionShort = ''): TranslationOutput {
  return { captionShort, captionFull, hashtags: [] };
}

describe('Persian caption quality guard (Phase 6G)', () => {
  it('passes a concrete, source-grounded caption', () => {
    const src = 'Nobitex lost $81.7 million after a hack; funds moved to burn addresses.';
    const out = applyPersianCaptionQualityGuard('fa', t('نوبیتکس در پی هک ۸۱.۷ میلیون دلار از دست داد.'), src);
    expect(out.ok).toBe(true);
  });

  it('rejects a caption dominated by banned filler with no concrete signal', () => {
    const src = 'A protocol announced an integration.';
    const out = applyPersianCaptionQualityGuard('fa', t('این خبر نشان‌دهنده پذیرش نهادی است.'), src);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('caption_generic_filler');
  });

  it('keeps filler-flavored caption if it carries a concrete figure', () => {
    const src = 'ETF saw $120 million net inflows.';
    const out = applyPersianCaptionQualityGuard('fa', t('ورود ۱۲۰ میلیون دلار به ETF؛ گامی در جهت پذیرش بیشتر.'), src);
    expect(out.ok).toBe(true); // has a grounded figure → not pure filler
  });

  it('rejects a caption whose figures are entirely absent from the source', () => {
    const src = 'The company described its new product, with no figures.';
    const out = applyPersianCaptionQualityGuard('fa', t('این محصول ۲ میلیارد دلار ارزش‌گذاری شده است.'), src);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('caption_unsupported_exact_figure');
  });

  it('accepts when at least one figure is grounded even if another is contextual', () => {
    const src = 'Bitcoin ETF inflows hit $500 million today.';
    const out = applyPersianCaptionQualityGuard('fa', t('ورودی ETF بیت‌کوین به ۵۰۰ میلیون دلار رسید.'), src);
    expect(out.ok).toBe(true);
  });

  it('still catches year mismatch', () => {
    const src = 'In 2026 the rule changed.';
    const out = applyPersianCaptionQualityGuard('fa', t('در سال ۲۰۲۴ این قانون تغییر کرد.'), src);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('caption_year_mismatch');
  });

  it('is a no-op for non-Persian languages', () => {
    const out = applyPersianCaptionQualityGuard('en', t('This is worth $2 billion not in source.'), 'no figures');
    expect(out.ok).toBe(true);
  });
});
