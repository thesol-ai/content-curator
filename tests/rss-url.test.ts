import { describe, expect, it } from 'vitest';
import { canonicalArticleUrl } from '../apps/worker-api/src/services/rss-url';

describe('canonicalArticleUrl', () => {
  it('strips utm and other tracking params', () => {
    expect(canonicalArticleUrl(
      'https://cointelegraph.com/news/x?utm_source=rss&utm_medium=rss&utm_campaign=rss',
    )).toBe('https://cointelegraph.com/news/x');
  });

  it('strips fbclid/gclid/igshid/ref tracking params', () => {
    expect(canonicalArticleUrl(
      'https://www.theblock.co/post/405459/title?fbclid=abc&gclid=def&ref=twitter',
    )).toBe('https://theblock.co/post/405459/title');
  });

  it('upgrades http to https', () => {
    expect(canonicalArticleUrl('http://cryptoslate.com/article'))
      .toBe('https://cryptoslate.com/article');
  });

  it('lowercases host and strips www/amp/mobile', () => {
    expect(canonicalArticleUrl('https://AMP.CoinDesk.com/tech/x'))
      .toBe('https://coindesk.com/tech/x');
    expect(canonicalArticleUrl('https://m.coindesk.com/tech/x'))
      .toBe('https://coindesk.com/tech/x');
    expect(canonicalArticleUrl('https://www.coindesk.com/tech/x'))
      .toBe('https://coindesk.com/tech/x');
  });

  it('drops fragment and trailing slash', () => {
    expect(canonicalArticleUrl('https://coindesk.com/tech/x/#section'))
      .toBe('https://coindesk.com/tech/x');
  });

  it('maps tracking variants of the same article to one key', () => {
    const a = canonicalArticleUrl('https://www.theblock.co/post/1/t?utm_source=a');
    const b = canonicalArticleUrl('http://theblock.co/post/1/t/?fbclid=z#x');
    expect(a).toBe(b);
  });

  it('keeps meaningful query params, sorted', () => {
    expect(canonicalArticleUrl('https://cryptoslate.com/?p=542739&utm_source=rss'))
      .toBe('https://cryptoslate.com/?p=542739');
  });

  it('preserves order-independence of meaningful params', () => {
    const a = canonicalArticleUrl('https://x.com/a?b=2&a=1');
    const b = canonicalArticleUrl('https://x.com/a?a=1&b=2');
    expect(a).toBe(b);
  });

  it('returns input trimmed when not a parseable absolute URL', () => {
    expect(canonicalArticleUrl('  not a url  ')).toBe('not a url');
    expect(canonicalArticleUrl('')).toBe('');
    expect(canonicalArticleUrl(null)).toBe('');
  });
});
