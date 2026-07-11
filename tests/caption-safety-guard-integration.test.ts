import { describe, expect, it } from 'vitest';

import { applyPersianCaptionQualityGuard } from '../apps/worker-api/src/services/story-quality-guard';

const mismatchedTranslation = {
  captionShort:
    'عنوان کوتاه خبر\n\nمتن خبر شامل ۱۲۰ میلیون دلار است.',
  captionFull:
    'عنوان متفاوت خبر\n\nمتن کامل خبر شامل ۱۲۰ میلیون دلار است.',
  hashtags: [],
};

describe('caption safety guard integration', () => {
  it('keeps strict safety disabled unless explicitly enabled', () => {
    const decision = applyPersianCaptionQualityGuard(
      'fa',
      mismatchedTranslation,
      'The report says $120 million.',
      {
        safetyEnabled: false,
      },
    );

    expect(decision.ok).toBe(true);
  });

  it('rejects mismatched canonical titles when strict safety is enabled', () => {
    const decision = applyPersianCaptionQualityGuard(
      'fa',
      mismatchedTranslation,
      'The report says $120 million.',
      {
        safetyEnabled: true,
      },
    );

    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe('caption_title_mismatch');
  });
});
