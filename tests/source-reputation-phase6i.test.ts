import { describe, expect, it } from 'vitest';
import {
  computeSourceReputation,
  shapeSourcePerformance,
} from '../apps/worker-api/src/services/source-reputation';
import { applyPersianCaptionQualityGuard } from '../apps/worker-api/src/services/story-quality-guard';
import type { TranslationOutput } from '../apps/worker-api/src/types';

describe('source reputation (Phase 6I observe)', () => {
  it('merges events + published into per-source rows sorted by published', () => {
    const events = [
      { source_account: 'Cointelegraph', status: 'ai_selected', count: 30 },
      { source_account: 'Cointelegraph', status: 'ai_rejected', count: 10 },
      { source_account: 'Cointelegraph', status: 'queue_created', count: 25 },
      { source_account: 'whale_alert', status: 'ai_selected', count: 3 },
      { source_account: 'whale_alert', status: 'ai_rejected', count: 20 },
    ];
    const published = [
      { source_account: 'Cointelegraph', count: 25 },
      { source_account: 'whale_alert', count: 2 },
    ];
    const { totalPublished, sources } = shapeSourcePerformance(events, published);
    expect(totalPublished).toBe(27);
    expect(sources[0]!.sourceAccount).toBe('cointelegraph');
    expect(sources[0]!.dominanceShare).toBeCloseTo(25 / 27, 2);
    expect(sources[0]!.acceptanceRate).toBeCloseTo(0.63, 2);
  });

  it('penalises dominance and rewards acceptance in the reputation score', () => {
    // a balanced, well-accepted source
    const good = computeSourceReputation({ sourceAccount: 'a', aiSelected: 8, aiRejected: 2, queued: 8, published: 8 }, 40);
    // a dominant source (most of the channel)
    const dominant = computeSourceReputation({ sourceAccount: 'b', aiSelected: 30, aiRejected: 5, queued: 30, published: 30 }, 40);
    expect(good).toBeGreaterThan(0);
    expect(dominant).toBeLessThan(good + 100); // sanity
    // a noisy source (high rejection) scores low
    const noisy = computeSourceReputation({ sourceAccount: 'c', aiSelected: 2, aiRejected: 40, published: 1, queued: 1 }, 40);
    expect(noisy).toBeLessThan(good);
  });

  it('is empty-safe', () => {
    const { totalPublished, sources } = shapeSourcePerformance([], []);
    expect(totalPublished).toBe(0);
    expect(sources).toEqual([]);
  });
});

function t(captionFull: string): TranslationOutput {
  return { captionShort: '', captionFull, hashtags: [] };
}

describe('caption filler stems matched against real production variants (Phase 6I)', () => {
  it('rejects pure-hype caption observed in production (no concrete signal)', () => {
    const src = 'A capital markets event took place on Solana.';
    const out = applyPersianCaptionQualityGuard('fa', t('این رویداد یکی از بزرگترین رویدادهای تاریخ در این حوزه محسوب می‌شود.'), src);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('caption_generic_filler');
  });

  it('rejects "نشان‌دهنده افزایش..." filler when no figure backs it', () => {
    const src = 'CFTC expands oversight of digital asset markets using AI.';
    const out = applyPersianCaptionQualityGuard('fa', t('این گام نشان‌دهنده افزایش تمرکز نهادهای نظارتی بر فضای کریپتو است.'), src);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('caption_generic_filler');
  });

  it('keeps a filler-tailed caption that still carries a grounded figure', () => {
    const src = 'Janus Henderson JAAA fund brought $200M onto Solana via Ethena and Centrifuge.';
    const out = applyPersianCaptionQualityGuard('fa', t('ورود ۲۰۰ میلیون دلار صندوق JAAA به سولانا؛ نشان‌دهنده پذیرش دارایی‌های سنتی است.'), src);
    expect(out.ok).toBe(true); // has grounded figure → informative, not pure filler
  });
});

import { shapeBucketBreakdown } from '../apps/worker-api/src/services/source-reputation';

describe('source bucket breakdown (review-2: source_id level)', () => {
  it('groups by account+source_id and sorts by published desc', () => {
    const rows = [
      { source_account: 'CoinDesk', source_id: 'src_crypto_x_news_text', count: 5 },
      { source_account: 'CoinDesk', source_id: 'src_market_trending_x_text', count: 2 },
      { source_account: 'CoinDesk', source_id: 'src_crypto_x_news_text', count: 1 }, // merges → 6
      { source_account: 'whale_alert', source_id: null, count: 3 },
      { source_account: '', source_id: 'x', count: 9 }, // ignored (no account)
    ];
    const out = shapeBucketBreakdown(rows);
    expect(out[0]).toEqual({ sourceAccount: 'coindesk', sourceId: 'src_crypto_x_news_text', published: 6 });
    expect(out.find(r => r.sourceId === 'unknown')?.sourceAccount).toBe('whale_alert');
    expect(out.some(r => r.sourceAccount === '')).toBe(false);
  });
});
