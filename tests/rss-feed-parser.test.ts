import { describe, expect, it } from 'vitest';
import { parseRssFeed } from '../apps/worker-api/src/services/rss-feed-parser';

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:dc="http://purl.org/dc/elements/1.1/"
     xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Test Feed</title>
    <item>
      <title><![CDATA[Ethereum's biggest bot drained of $7.5 million]]></title>
      <link>https://www.coindesk.com/tech/2026/06/21/sandwich-bot?utm_source=rss</link>
      <guid isPermaLink="false">c7396e71-7640</guid>
      <pubDate>Sun, 21 Jun 2026 07:12:35 +0000</pubDate>
      <dc:creator>Shaurya Malwa</dc:creator>
      <description>Short summary &amp; teaser.</description>
      <content:encoded><![CDATA[<p>Full article body with <a href="x">link</a>.</p><img src="https://cdn.example.com/a.jpg"/>]]></content:encoded>
      <media:content url="https://cdn.example.com/lead.jpg" medium="image" type="image/jpeg"/>
    </item>
    <item>
      <title>Here's what happened in crypto today</title>
      <link>https://cointelegraph.com/news/what-happened?utm_medium=rss</link>
      <guid>1</guid>
      <pubDate>Sun, 21 Jun 2026 04:36:29 GMT</pubDate>
      <description>Summary only.</description>
      <enclosure url="https://s3.example.com/cover.jpg" type="image/jpeg" length="0"/>
    </item>
  </channel>
</rss>`;

describe('parseRssFeed', () => {
  it('parses all items', () => {
    expect(parseRssFeed(FEED)).toHaveLength(2);
  });

  it('unwraps CDATA in title and content', () => {
    const [a] = parseRssFeed(FEED);
    expect(a.title).toBe("Ethereum's biggest bot drained of $7.5 million");
    expect(a.contentEncoded).toContain('Full article body');
  });

  it('decodes HTML entities in description', () => {
    const [a] = parseRssFeed(FEED);
    expect(a.description).toBe('Short summary & teaser.');
  });

  it('keeps guid as string even when numeric (Cointelegraph guid=1)', () => {
    const [, b] = parseRssFeed(FEED);
    expect(b.guid).toBe('1');
  });

  it('extracts media:content image as a candidate', () => {
    const [a] = parseRssFeed(FEED);
    expect(a.imageCandidates).toContain('https://cdn.example.com/lead.jpg');
  });

  it('extracts enclosure image as a candidate', () => {
    const [, b] = parseRssFeed(FEED);
    expect(b.imageCandidates).toContain('https://s3.example.com/cover.jpg');
  });

  it('falls back to first <img> in content', () => {
    const [a] = parseRssFeed(FEED);
    expect(a.imageCandidates).toContain('https://cdn.example.com/a.jpg');
  });

  it('captures dc:creator as author', () => {
    expect(parseRssFeed(FEED)[0].author).toBe('Shaurya Malwa');
  });

  it('returns [] for invalid XML', () => {
    expect(parseRssFeed('<rss><channel><item>')).toEqual([]);
    expect(parseRssFeed('not xml at all')).toEqual([]);
    expect(parseRssFeed('')).toEqual([]);
  });

  it('returns [] when there are no items', () => {
    expect(parseRssFeed('<rss><channel><title>x</title></channel></rss>')).toEqual([]);
  });

  it('handles a single item (not wrapped in array)', () => {
    const single = `<rss><channel><item><title>One</title><link>https://x.com/a</link></item></channel></rss>`;
    expect(parseRssFeed(single)).toHaveLength(1);
  });
});
