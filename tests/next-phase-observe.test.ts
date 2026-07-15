import { describe, expect, it } from 'vitest';
import {
  buildStoryKey,
  isStoryIntelligenceEnabled,
  isStoryIntelligenceObserveOnly,
  isUnstableFingerprint,
  normalizeEntities,
  parseStoryFields,
  summarizeStability,
} from '../apps/worker-api/src/services/story-intelligence';
import {
  computeQueueDiversity,
  shapeSourceYield,
  shapeTopicMix,
  shapeCapPreview,
} from '../apps/worker-api/src/services/observability-reports';
import { scoreCaptionQuality } from '../apps/worker-api/src/services/story-quality-guard';
import type { Env } from '../apps/worker-api/src/types';

describe('6K story intelligence (pure)', () => {
  it('normalizes + caps + sorts entities', () => {
    // first 3 valid+unique (btc, tether, zachxbt) are kept, then sorted
    expect(normalizeEntities(['$BTC', 'Tether', 'tether', 'ZachXBT', 'X', 'Monero', 'Aave']))
      .toEqual(['btc', 'tether', 'zachxbt']);
  });

  it('builds a deterministic story key, order-independent', () => {
    const a = buildStoryKey(parseStoryFields({ primary_entities: ['Tether', 'Monero', 'ZachXBT'], event_type: 'security laundering', canonical_date: '2026-06-13' }));
    const b = buildStoryKey(parseStoryFields({ primary_entities: ['ZachXBT', 'monero', 'Tether'], event_type: 'security_laundering', canonical_date: '2026-06-13T10:00:00Z' }));
    expect(a).toBe('monero|tether|zachxbt|security_laundering|2026-06-13');
    expect(a).toBe(b);
  });

  it('returns null when there is no usable entity signal', () => {
    expect(buildStoryKey(parseStoryFields({ event_type: 'etf_flows' }))).toBeNull();
    expect(parseStoryFields(null)).toBeNull();
  });

  it('classifies unstable fingerprints and summarizes', () => {
    expect(isUnstableFingerprint('fp-123')).toBe(true);
    expect(isUnstableFingerprint('ns-9')).toBe(true);
    expect(isUnstableFingerprint(null)).toBe(true);
    expect(isUnstableFingerprint('us-clarity-act-legislation')).toBe(false);
    const s = summarizeStability([{ topic_fingerprint: 'fp-1' }, { topic_fingerprint: 'real-story' }, { topic_fingerprint: null }]);
    expect(s).toEqual({ total: 3, unstable: 2, pct: 66.7 });
  });

  it('is flag-gated (enabled off, observe-only on by default)', () => {
    expect(isStoryIntelligenceEnabled({} as Env)).toBe(false);
    expect(isStoryIntelligenceObserveOnly({} as Env)).toBe(true);
    expect(isStoryIntelligenceObserveOnly({ STORY_INTELLIGENCE_OBSERVE_ONLY: 'false' } as unknown as Env)).toBe(false);
  });
});

describe('queue diversity (pure)', () => {
  it('counts unique sources/fingerprints and max source share', () => {
    const now = 1000;
    const rows = [
      { scheduled_at: now + 1000, source_account: 'CoinDesk', topic_fingerprint: 'a' },
      { scheduled_at: now + 2000, source_account: 'CoinDesk', topic_fingerprint: 'b' },
      { scheduled_at: now + 3000, source_account: 'WuBlockchain', topic_fingerprint: 'a' },
      { scheduled_at: now + 100000, source_account: 'X', topic_fingerprint: 'z' }, // beyond 24h-ish still <24h here
    ];
    const d = computeQueueDiversity(rows, now);
    // only the first 3 rows fall within 6h/24h (the 4th is +100000s, beyond both)
    expect(d.uniqueSourcesNext6h).toBe(2);     // CoinDesk, WuBlockchain
    expect(d.uniqueFingerprintsNext6h).toBe(2); // a (dedup), b
    expect(d.topSourceNext24h).toBe('CoinDesk');
    expect(d.maxSourceShareNext24h).toBe(0.67); // 2 of 3
  });
});

describe('source yield (pure)', () => {
  it('merges candidate/rejected/published into a yield table', () => {
    const items = [
      { source_account: 'A', status: 'ai_selected', count: 3 },
      { source_account: 'A', status: 'ai_rejected', count: 7 },
      { source_account: 'B', status: 'ai_rejected', count: 5 },
    ];
    const pub = [{ source_account: 'A', count: 2 }];
    const out = shapeSourceYield(items, pub);
    const a = out.find(r => r.sourceAccount === 'A')!;
    expect(a.candidates).toBe(10);
    expect(a.aiRejected).toBe(7);
    expect(a.published).toBe(2);
    expect(a.publishYield).toBe(0.2);
    expect(out[0].sourceAccount).toBe('A'); // sorted by candidates desc
  });
});

describe('topic mix + cap preview (pure)', () => {
  it('buckets published items by theme', () => {
    const rows = [
      { text: 'Bitcoin spot ETF saw $200M net inflows today', caption_full: null },
      { text: 'Tokenized stock SPCX shares now tradable, an RWA milestone', caption_full: null },
      { text: 'random unrelated note', caption_full: null },
    ];
    const mix = shapeTopicMix(rows);
    const themes = mix.map(m => m.theme);
    expect(themes).toContain('theme:crypto-etf');
    expect(themes).toContain('theme:other');
  });

  it('flags sources that would exceed the daily cap', () => {
    const rows = [{ source_account: 'CoinDesk', count: 9 }, { source_account: 'rare', count: 2 }];
    const out = shapeCapPreview(rows, 5);
    expect(out).toEqual([{ sourceAccount: 'CoinDesk', published24h: 9, cap: 5, wouldCap: 4 }]);
    expect(shapeCapPreview(rows, null)).toEqual([]); // no cap → nothing
  });
});

describe('caption quality score (pure, observe-only)', () => {
  it('does not use source-number matching in the score', () => {
    const caption =
      'بیت‌کوین ETF امروز ۲۰۰ میلیون دلار ورودی داشت.';

    const matching =
      scoreCaptionQuality(
        caption,
        'Bitcoin ETF saw $200 million inflow.',
      );

    const different =
      scoreCaptionQuality(
        caption,
        'Bitcoin ETF activity was reported.',
      );

    expect(matching.score).toBe(
      different.score,
    );

    expect(matching.score).toBeGreaterThan(
      70,
    );
  });
  it('penalizes a generic filler caption', () => {
    const s = scoreCaptionQuality('این خبر نشان‌دهنده پذیرش نهادی است.');
    expect(s.boringOrGeneric).toBe(true);
    expect(s.score).toBeLessThan(70);
  });
});
