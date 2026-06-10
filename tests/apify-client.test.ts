import { describe, expect, it } from 'vitest';
import { normalizeItem } from '../apps/worker-api/src/services/apify-client';
import {
  instagramCarouselPost,
  instagramCarouselWithManifestVideoPost,
  instagramReelPost,
  instagramSidecarChildrenPost,
  linkedinAlternateVideoPost,
  linkedinDocumentPost,
  linkedinDocumentWithTooManyPagesPost,
  linkedinVideoPost,
  linkedinVideoWithPostImageThumbnailPost,
  twitterVideoOnlyHlsPost,
  twitterVideoPost,
} from './fixtures/apify-fixtures';

describe('apify-client normalization baseline', () => {
  it('normalizes Twitter video and selects the highest bitrate MP4 variant', () => {
    const item = normalizeItem(twitterVideoPost, 'x');
    expect(item).not.toBeNull();
    expect(item?.platform).toBe('x');
    expect(item?.postId).toBe('1001');
    expect(item?.media).toHaveLength(1);
    expect(item?.expectedMediaCount).toBe(1);
    expect(item?.media[0]).toMatchObject({
      type: 'video',
      url: 'https://video.twimg.com/ext_tw_video/high.mp4',
      thumbnailUrl: 'https://pbs.twimg.com/media/thumb.jpg',
      durationSec: 12,
    });
  });

  it('records extraction diagnostics for unsupported Twitter HLS-only videos', () => {
    const item = normalizeItem(twitterVideoOnlyHlsPost, 'x');
    expect(item?.media).toHaveLength(0);
    expect(item?.expectedMediaCount).toBe(1);
    expect(item?.mediaWarnings?.join(' ')).toContain('no compatible mp4 variant');
    expect(item?.mediaWarnings?.join(' ')).toContain('extracted 0/1');
  });

  it('normalizes Instagram mixed carousel with thumbnails for video children', () => {
    const item = normalizeItem(instagramCarouselPost, 'instagram');
    expect(item?.mediaUrlExpiresSoon).toBe(true);
    expect(item?.expectedMediaCount).toBe(2);
    expect(item?.media).toHaveLength(2);
    expect(item?.media[0]).toMatchObject({ type: 'image', url: 'https://scontent.cdninstagram.com/image-1.jpg' });
    expect(item?.media[1]).toMatchObject({
      type: 'video',
      url: 'https://scontent.cdninstagram.com/video-1.mp4',
      thumbnailUrl: 'https://scontent.cdninstagram.com/video-1-thumb.jpg',
      durationSec: 18,
    });
  });

  it('normalizes Instagram reels as videos with thumbnails', () => {
    const item = normalizeItem(instagramReelPost, 'instagram');
    expect(item?.media).toHaveLength(1);
    expect(item?.media[0]).toMatchObject({
      type: 'video',
      url: 'https://scontent.cdninstagram.com/reel.mp4',
      thumbnailUrl: 'https://scontent.cdninstagram.com/reel-thumb.jpg',
    });
  });

  it('supports Instagram sidecarChildren and carousel_media variants while preserving order', () => {
    const sidecar = normalizeItem(instagramSidecarChildrenPost, 'instagram');
    expect(sidecar?.media.map(m => m.type)).toEqual(['image', 'video']);
    expect(sidecar?.media.map(m => m.url)).toEqual([
      'https://scontent.cdninstagram.com/sidecar-1.jpg',
      'https://scontent.cdninstagram.com/sidecar-video.mp4',
    ]);

    const manifest = normalizeItem(instagramCarouselWithManifestVideoPost, 'instagram');
    expect(manifest?.media).toHaveLength(1);
    expect(manifest?.media[0]).toMatchObject({ type: 'image', url: 'https://scontent.cdninstagram.com/ok.jpg' });
    expect(manifest?.expectedMediaCount).toBe(2);
    expect(manifest?.mediaWarnings?.join(' ')).toContain('stream manifest');
    expect(manifest?.mediaWarnings?.join(' ')).toContain('extracted 1/2');
  });

  it('normalizes LinkedIn videos and document cover pages', () => {
    const video = normalizeItem(linkedinVideoPost, 'linkedin');
    expect(video?.media).toHaveLength(1);
    expect(video?.media[0]).toMatchObject({
      type: 'video',
      url: 'https://media.licdn.com/video.mp4',
      thumbnailUrl: 'https://media.licdn.com/video-thumb.jpg',
    });

    const document = normalizeItem(linkedinDocumentPost, 'linkedin');
    expect(document?.media).toHaveLength(2);
    expect(document?.media.map(m => m.url)).toEqual([
      'https://media.licdn.com/page-1.jpg',
      'https://media.licdn.com/page-2.jpg',
    ]);
  });

  it('prefers LinkedIn postVideo over postImages when both are present', () => {
    const item = normalizeItem(linkedinVideoWithPostImageThumbnailPost, 'linkedin');
    expect(item?.media).toHaveLength(1);
    expect(item?.media[0]).toMatchObject({
      type: 'video',
      url: 'https://media.licdn.com/video-with-preview.mp4',
      thumbnailUrl: 'https://media.licdn.com/video-preview-from-postImages.jpg',
    });
  });

  it('supports alternate LinkedIn video fields and caps large document carousels with diagnostics', () => {
    const video = normalizeItem(linkedinAlternateVideoPost, 'linkedin');
    expect(video?.media).toHaveLength(1);
    expect(video?.media[0]).toMatchObject({
      type: 'video',
      url: 'https://media.licdn.com/alt-video.mp4',
      thumbnailUrl: 'https://media.licdn.com/alt-video-thumb.jpg',
      durationSec: 42,
    });

    const deck = normalizeItem(linkedinDocumentWithTooManyPagesPost, 'linkedin');
    expect(deck?.expectedMediaCount).toBe(12);
    expect(deck?.media).toHaveLength(10);
    expect(deck?.mediaWarnings?.join(' ')).toContain('expected 12 media items');
  });
});
