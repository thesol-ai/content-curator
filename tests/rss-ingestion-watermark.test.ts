import { describe, expect, it } from 'vitest';
import { filterNewByWatermark } from '../apps/worker-api/src/services/rss-ingestion';
import type { NormalizedItem } from '../apps/worker-api/src/types';

function item(url: string, publishedAt: number): NormalizedItem {
  return {
    platform: 'rss', sourceAccount: 'coindesk', sourceUrl: url, postId: url,
    publishedAt, text: 't', media: [], engagementLikes: 0, engagementShares: 0,
    engagementViews: 0, mediaUrlExpiresSoon: false,
  };
}

describe('filterNewByWatermark', () => {
  const items = [item('a', 100), item('b', 300), item('c', 200)];

  it('returns newest-first', () => {
    expect(filterNewByWatermark(items, null, 0).map(i => i.sourceUrl)).toEqual(['b', 'c', 'a']);
  });

  it('keeps only items newer than the watermark', () => {
    expect(filterNewByWatermark(items, 200, 0).map(i => i.sourceUrl)).toEqual(['b']);
  });

  it('caps to maxPerFeed', () => {
    expect(filterNewByWatermark(items, null, 2).map(i => i.sourceUrl)).toEqual(['b', 'c']);
  });

  it('returns empty when all items are at or below the watermark', () => {
    expect(filterNewByWatermark(items, 300, 0)).toEqual([]);
  });
});
