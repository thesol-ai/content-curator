import { describe, expect, it } from 'vitest';
import {
  buildMediaGroupPayload,
  detectMediaType,
  extractMediaTypes,
  isVideoDefinitelyRejected,
  resolveMedia,
  safeTruncate,
  sanitizeCaptionText,
} from '../apps/worker-api/src/services/media-resolver';
import type { MediaItem } from '../apps/worker-api/src/types';

describe('media-resolver baseline', () => {
  it('returns sendMessage when media is disabled or absent', () => {
    expect(resolveMedia([], 'optional')).toMatchObject({ method: 'sendMessage', mediaUrls: [] });
    expect(resolveMedia([{ type: 'image', url: 'https://cdn.test/a.jpg' }], 'disabled'))
      .toMatchObject({ method: 'sendMessage', mediaUrls: [] });
  });

  it('selects sendPhoto for a single image', () => {
    const result = resolveMedia([{ type: 'image', url: 'https://cdn.test/a.jpg' }], 'optional');
    expect(result).toEqual({
      method: 'sendPhoto',
      mediaUrls: ['https://cdn.test/a.jpg'],
      thumbnailUrls: [''],
      useShortCaption: true,
    });
  });

  it('selects sendVideo with thumbnail for a single accepted video', () => {
    const result = resolveMedia([
      { type: 'video', url: 'https://cdn.test/v.mp4', thumbnailUrl: 'https://cdn.test/t.jpg', sizeMb: 12, durationSec: 30 },
    ], 'optional');
    expect(result.method).toBe('sendVideo');
    expect(result.mediaUrls).toEqual(['https://cdn.test/v.mp4']);
    expect(result.thumbnailUrls).toEqual(['https://cdn.test/t.jpg']);
  });

  it('filters videos only when they are definitely too large or too long', () => {
    const unknownVideo: MediaItem = { type: 'video', url: 'https://cdn.test/unknown.mp4' };
    const largeVideo: MediaItem = { type: 'video', url: 'https://cdn.test/large.mp4', sizeMb: 51 };
    const longVideo: MediaItem = { type: 'video', url: 'https://cdn.test/long.mp4', durationSec: 301 };

    expect(isVideoDefinitelyRejected(unknownVideo)).toBe(false);
    expect(isVideoDefinitelyRejected(largeVideo)).toBe(true);
    expect(isVideoDefinitelyRejected(longVideo)).toBe(true);
  });

  it('supports partial album baseline by filtering definitely rejected videos', () => {
    const media: MediaItem[] = [
      { type: 'image', url: 'https://cdn.test/a.jpg' },
      { type: 'video', url: 'https://cdn.test/too-large.mp4', sizeMb: 100 },
      { type: 'video', url: 'https://cdn.test/ok.mp4', thumbnailUrl: 'https://cdn.test/ok.jpg' },
    ];

    const result = resolveMedia(media, 'optional');
    expect(result.method).toBe('sendMediaGroup');
    expect(result.mediaUrls).toEqual(['https://cdn.test/a.jpg', 'https://cdn.test/ok.mp4']);
    expect(extractMediaTypes(media, 'optional')).toEqual(['image', 'video']);
  });

  it('builds direct Telegram media group payload with sanitized first caption', () => {
    const payload = buildMediaGroupPayload(
      ['https://cdn.test/a.jpg', 'https://cdn.test/v.mp4'],
      ['image', 'video'],
      'Caption with <b>tag</b> & entity'
    ) as Array<Record<string, unknown>>;

    expect(payload).toHaveLength(2);
    expect(payload[0]).toMatchObject({
      type: 'photo',
      media: 'https://cdn.test/a.jpg',
      caption: 'Caption with &lt;b&gt;tag&lt;/b&gt; &amp; entity',
      parse_mode: 'HTML',
    });
    expect(payload[1]).toMatchObject({
      type: 'video',
      media: 'https://cdn.test/v.mp4',
      supports_streaming: true,
    });
  });

  it('detects media type from URL extension and truncates without cutting HTML entities', () => {
    expect(detectMediaType('https://cdn.test/video.MP4?x=1')).toBe('video');
    expect(detectMediaType('https://cdn.test/image.jpg')).toBe('image');
    expect(sanitizeCaptionText('<hello> & world')).toBe('&lt;hello&gt; &amp; world');
    expect(safeTruncate('hello &amp; goodbye', 10)).toBe('hello…');
  });
});
