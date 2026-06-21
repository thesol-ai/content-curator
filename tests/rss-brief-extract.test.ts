import { describe, expect, it } from 'vitest';
import { chooseExtraction, looksPaywalled } from '../apps/worker-api/src/services/rss-content-extractor';
import {
  clampCaption,
  hasLongVerbatimOverlap,
  sanitizeBrief,
  withAttribution,
} from '../apps/worker-api/src/services/rss-brief';

describe('chooseExtraction', () => {
  it('uses feed content when long enough', () => {
    expect(chooseExtraction('x'.repeat(600), 500)).toBe('feed');
  });
  it('needs Jina when feed content is short', () => {
    expect(chooseExtraction('short summary', 500)).toBe('needs_jina');
    expect(chooseExtraction(undefined, 500)).toBe('needs_jina');
  });
});

describe('looksPaywalled', () => {
  it('detects paywall/login markers', () => {
    expect(looksPaywalled('Please Subscribe to continue reading the rest')).toBe(true);
    expect(looksPaywalled('Sign in to read this exclusive report')).toBe(true);
  });
  it('passes real article text', () => {
    expect(looksPaywalled('Ethereum validators processed a record number of transactions today.')).toBe(false);
  });
});

describe('hasLongVerbatimOverlap', () => {
  it('flags a 12+ word verbatim run copied from source', () => {
    const source = 'The sandwich bot was drained of seven point five million dollars in an ironic exploit overnight.';
    const brief = 'گزارش: The sandwich bot was drained of seven point five million dollars in an ironic exploit overnight.';
    expect(hasLongVerbatimOverlap(brief, source)).toBe(true);
  });
  it('does not flag an original rewrite', () => {
    const source = 'The sandwich bot was drained of seven point five million dollars in an ironic exploit overnight.';
    const brief = 'یک ربات آربیتراژ معروف هدف یک سوءاستفاده قرار گرفت و میلیون‌ها دلار از دست داد.';
    expect(hasLongVerbatimOverlap(brief, source)).toBe(false);
  });
});

describe('clampCaption', () => {
  it('clamps to max on a word boundary', () => {
    const out = clampCaption('one two three four five six', 12);
    expect(out.length).toBeLessThanOrEqual(12);
    expect(out).toBe('one two');
  });
});

describe('withAttribution', () => {
  it('always appends source label and url', () => {
    const out = withAttribution('متن بریف فارسی', 'CoinDesk', 'https://coindesk.com/x');
    expect(out).toContain('منبع: CoinDesk');
    expect(out).toContain('https://coindesk.com/x');
  });
});

describe('sanitizeBrief', () => {
  const source = 'A long English source article about a crypto exploit and its market impact today.';

  it('returns a clean draft for a valid original brief', () => {
    const draft = sanitizeBrief(
      { captionShort: 'تیتر', captionFull: 'یک خلاصه تحلیلی فارسی کاملاً اصیل درباره رویداد بازار رمزارز.', hashtags: ['#crypto', ''] },
      source,
    );
    expect(draft).not.toBeNull();
    expect(draft!.hashtags).toEqual(['#crypto']);
  });

  it('rejects when caption is too short', () => {
    expect(sanitizeBrief({ captionFull: 'کوتاه' }, source)).toBeNull();
  });

  it('rejects when the brief copies a long verbatim run from the source', () => {
    const copied = 'A long English source article about a crypto exploit and its market impact today indeed.';
    expect(sanitizeBrief({ captionFull: copied }, source)).toBeNull();
  });
});
