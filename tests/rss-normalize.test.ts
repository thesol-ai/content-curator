import { describe, expect, it } from 'vitest';
import { normalizeRssItem, stripRssHtml } from '../apps/worker-api/src/services/apify-client';

function raw(overrides: any = {}) {
  return {
    title: 'Ethereum bot drained of $7.5 million',
    link: 'https://www.coindesk.com/tech/2026/06/21/sandwich-bot?utm_source=rss',
    guid: 'c7396e71-7640',
    pubDate: 'Sun, 21 Jun 2026 07:12:35 +0000',
    description: 'Short <b>summary</b> &amp; teaser.',
    contentEncoded: '<p>Full article body with much more detail than the summary.</p>',
    imageCandidates: ['https://cdn.example.com/lead.jpg'],
    author: 'Shaurya Malwa',
    ...overrides,
  };
}

describe('stripRssHtml', () => {
  it('removes tags and decodes basic entities', () => {
    expect(stripRssHtml('<p>Hello &amp; <b>world</b></p>')).toBe('Hello & world');
  });
});

describe('normalizeRssItem', () => {
  it('uses the canonical article URL for both sourceUrl and postId', () => {
    const n = normalizeRssItem(raw())!;
    expect(n.sourceUrl).toBe('https://coindesk.com/tech/2026/06/21/sandwich-bot');
    expect(n.postId).toBe(n.sourceUrl);
  });

  it('never uses guid as postId (Cointelegraph guid=1 collision)', () => {
    const n = normalizeRssItem(raw({
      guid: '1',
      link: 'https://cointelegraph.com/news/a?utm_medium=rss',
    }))!;
    expect(n.postId).toBe('https://cointelegraph.com/news/a');
    expect(n.postId).not.toBe('1');
  });

  it('prefers the canonical feed sourceAccount over the article author', () => {
    const n = normalizeRssItem(raw(), { sourceAccount: 'coindesk' })!;
    expect(n.sourceAccount).toBe('coindesk');
  });

  it('text is title + short summary (scoring input), not the full body', () => {
    const n = normalizeRssItem(raw())!;
    expect(n.text).toContain('Ethereum bot drained');
    expect(n.text).toContain('Short summary & teaser.');
    expect(n.text).not.toContain('Full article body');
  });

  it('carries stripped content:encoded as fullText for the brief step', () => {
    const n = normalizeRssItem(raw())!;
    expect(n.fullText).toBe('Full article body with much more detail than the summary.');
  });

  it('leaves fullText undefined when the feed has no content:encoded', () => {
    const n = normalizeRssItem(raw({ contentEncoded: '' }))!;
    expect(n.fullText).toBeUndefined();
  });

  it('extracts the lead image as media', () => {
    const n = normalizeRssItem(raw())!;
    expect(n.media).toEqual([{ type: 'image', url: 'https://cdn.example.com/lead.jpg' }]);
  });

  it('publishes text-only when there is no image', () => {
    const n = normalizeRssItem(raw({ imageCandidates: [] }))!;
    expect(n.media).toEqual([]);
  });

  it('returns null when there is no link', () => {
    expect(normalizeRssItem({ title: 'x' })).toBeNull();
  });
});
