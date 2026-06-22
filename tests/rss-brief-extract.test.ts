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

  it('returns a clean draft for a valid title + caption RSS post', () => {
    const draft = sanitizeBrief(
      {
        captionShort: 'هک تازه در بازار رمزارز دوباره ریسک امنیتی را پررنگ کرد',
        captionFull: 'هک تازه در بازار رمزارز دوباره ریسک امنیتی را پررنگ کرد\\n\\nطبق گزارش منبع، یک سرویس مرتبط با معاملات رمزارزی هدف سوءاستفاده قرار گرفته و بخشی از دارایی‌ها از دست رفته است. این اتفاق دوباره نشان می‌دهد مدیریت کلید، قرارداد هوشمند و کنترل دسترسی هنوز نقطه ضعف مهم بازار است.',
        hashtags: ['#crypto', 'security', ''],
      },
      source,
    );

    expect(draft).not.toBeNull();
    expect(draft!.hashtags).toEqual(['crypto', 'security']);
    expect(draft!.captionFull).not.toContain('http');
    expect(draft!.captionFull).not.toContain('منبع:');
  });

  it('rejects when caption is too short', () => {
    expect(sanitizeBrief({ captionFull: 'کوتاه' }, source)).toBeNull();
  });

  it('rejects when the brief copies a long verbatim run from the source', () => {
    const copied = 'A long English source article about a crypto exploit and its market impact today indeed.';
    expect(sanitizeBrief({ captionFull: copied }, source)).toBeNull();
  });

  it('accepts a title + short caption style for RSS posts', () => {
    const draft = sanitizeBrief(
      {
        captionShort: 'قانون MiCA فشار تازه‌ای روی پلتفرم‌های کوچک رمزارزی می‌آورد',
        captionFull: 'قانون MiCA فشار تازه‌ای روی پلتفرم‌های کوچک رمزارزی می‌آورد\\n\\nطبق گزارش منبع، پلتفرم‌های کوچک اروپایی برای ادامه فعالیت باید بخشی از عملیات نگهداری و تسویه دارایی را به ارائه‌دهندگان مجاز بسپارند. این تغییر هزینه و وابستگی عملیاتی آن‌ها را بیشتر می‌کند.',
        hashtags: ['crypto', 'regulation'],
      },
      source,
    );

    expect(draft).not.toBeNull();
    expect(draft!.captionFull).not.toContain('http');
    expect(draft!.captionFull).not.toContain('منبع:');
  });

  it('rejects RSS briefs that look like broken legal bullet translations', () => {
    const draft = sanitizeBrief(
      {
        captionShort: 'متن بد',
        captionFull: '• BitGo و Bielik نمونه عملی جدیدی از مدل‌های تطابق پس از MiCA نشان می‌دهند\\n• این مدل کاهش استقلال عملیاتی را نتیجه می‌دهد و به رانندگی‌های ارائه‌دهنده بستگی دارد',
        hashtags: ['crypto'],
      },
      source,
    );

    expect(draft).toBeNull();
  });

  it('rejects source links or manual source attribution inside caption body', () => {
    const draft = sanitizeBrief(
      {
        captionShort: 'خبر تازه بازار رمزارز با جزئیات بیشتر منتشر شد',
        captionFull: 'خبر تازه بازار رمزارز با جزئیات بیشتر منتشر شد\\n\\nمتن خبر کوتاه و قابل فهم است.\\n\\nمنبع: https://example.com/story',
        hashtags: ['crypto'],
      },
      source,
    );

    expect(draft).toBeNull();
  });
});
