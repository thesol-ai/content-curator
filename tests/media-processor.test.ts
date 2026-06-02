import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildMediaGroupForm,
  buildPhotoForm,
  buildVideoForm,
  getProcessingMode,
  processMediaItem,
  validateTelegramThumbnailBlob,
} from '../apps/worker-api/src/services/media-processor';
import type { Env } from '../apps/worker-api/src/types';


function jpegBytes(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x00,
    0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

function jpegBlob(width = 120, height = 90): Blob {
  return new Blob([jpegBytes(width, height)], { type: 'image/jpeg' });
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    MEDIA_PROCESSING_MODE: 'direct_url',
    MEDIA_MAX_DOWNLOAD_MB: '50',
    MEDIA_DOWNLOAD_TIMEOUT_SEC: '60',
    ...overrides,
  } as Env;
}

describe('media-processor baseline', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves processing modes with direct_url fallback', () => {
    expect(getProcessingMode(env({ MEDIA_PROCESSING_MODE: 'binary_upload' }))).toBe('binary_upload');
    expect(getProcessingMode(env({ MEDIA_PROCESSING_MODE: 'r2_storage' }))).toBe('r2_storage');
    expect(getProcessingMode(env({ MEDIA_PROCESSING_MODE: 'unknown' }))).toBe('direct_url');
  });

  it('validates direct URLs with HEAD without downloading the body', async () => {
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 200,
      headers: {
        'content-type': 'image/jpeg',
        'content-length': '1234',
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await processMediaItem(env(), 'https://cdn.test/photo.jpg', 'image');

    expect(fetchMock).toHaveBeenCalledWith('https://cdn.test/photo.jpg', expect.objectContaining({ method: 'HEAD' }));
    expect(result).toMatchObject({
      ok: true,
      stableUrl: 'https://cdn.test/photo.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 1234,
      status: 'ready',
    });
  });

  it('builds photo and video upload forms', () => {
    const photo = new Blob(['photo'], { type: 'image/jpeg' });
    const video = new Blob(['video'], { type: 'video/mp4' });
    const thumb = new Blob(['thumb'], { type: 'image/jpeg' });

    const photoForm = buildPhotoForm('@channel', photo, 'caption');
    expect(photoForm.get('chat_id')).toBe('@channel');
    expect(photoForm.get('caption')).toBe('caption');
    expect(photoForm.get('photo')).toBeInstanceOf(Blob);

    const videoForm = buildVideoForm('@channel', video, 'video caption', thumb);
    expect(videoForm.get('chat_id')).toBe('@channel');
    expect(videoForm.get('supports_streaming')).toBe('true');
    expect(videoForm.get('video')).toBeInstanceOf(Blob);
    expect(videoForm.get('thumbnail')).toBeInstanceOf(Blob);
  });

  it('builds media group form with attach references, stable URLs, file IDs, thumbnails, and first caption only', () => {
    const imageBlob = new Blob(['image'], { type: 'image/jpeg' });
    const videoBlob = new Blob(['video'], { type: 'video/mp4' });
    const thumbBlob = new Blob(['thumb'], { type: 'image/jpeg' });

    const { form, mediaJson } = buildMediaGroupForm('@channel', [
      { blob: imageBlob, type: 'image' },
      { blob: videoBlob, thumbnailBlob: thumbBlob, type: 'video' },
      { stableUrl: 'https://stable.test/photo.jpg', type: 'image' },
      { telegramFileId: 'cached-file-id', type: 'video' },
    ], 'album caption');

    const media = JSON.parse(mediaJson) as Array<Record<string, unknown>>;
    expect(form.get('chat_id')).toBe('@channel');
    expect(form.get('file0')).toBeInstanceOf(Blob);
    expect(form.get('file1')).toBeInstanceOf(Blob);
    expect(form.get('thumb1')).toBeInstanceOf(Blob);
    expect(media[0]).toMatchObject({ type: 'photo', media: 'attach://file0', caption: 'album caption' });
    expect(media[1]).toMatchObject({ type: 'video', media: 'attach://file1', thumbnail: 'attach://thumb1', supports_streaming: true });
    expect(media[2]).toMatchObject({ type: 'photo', media: 'https://stable.test/photo.jpg' });
    expect(media[3]).toMatchObject({ type: 'video', media: 'cached-file-id' });
    expect(media[1]).not.toHaveProperty('caption');
  });


  it('stores downloaded media in R2 mode and returns a stableUrl without keeping the blob', async () => {
    const bucket = {
      put: vi.fn(async () => undefined),
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['photo'], { type: 'image/jpeg' }), {
      status: 200,
      headers: { 'content-type': 'image/jpeg', 'content-length': '5' },
    })));

    const result = await processMediaItem(env({
      MEDIA_PROCESSING_MODE: 'r2_storage',
      MEDIA_BUCKET: bucket as any,
      R2_PUBLIC_BASE_URL: 'https://media.example.com/',
    }), 'https://cdn.test/photo.jpg', 'image');

    expect(result.ok).toBe(true);
    expect(result.blob).toBeUndefined();
    expect(result.stableUrl).toMatch(/^https:\/\/media\.example\.com\/media\//);
    expect(result.mimeType).toBe('image/jpeg');
    expect(bucket.put).toHaveBeenCalledOnce();
  });


  it('validates Telegram video thumbnails as JPEG under 200KB and within 320x320', async () => {
    const result = await validateTelegramThumbnailBlob(jpegBlob(320, 180), 'image/jpeg');
    expect(result).toMatchObject({ ok: true, status: 'valid', width: 320, height: 180 });
  });

  it('rejects non-JPEG thumbnails instead of attaching arbitrary image blobs', async () => {
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
    const result = await validateTelegramThumbnailBlob(png, 'image/png');
    expect(result).toMatchObject({ ok: false, status: 'unsupported_format' });
  });

  it('rejects oversized thumbnails before Telegram upload', async () => {
    const large = new Blob([jpegBytes(120, 90), new Uint8Array(205 * 1024)], { type: 'image/jpeg' });
    const result = await validateTelegramThumbnailBlob(large, 'image/jpeg');
    expect(result).toMatchObject({ ok: false, status: 'too_large' });
  });

  it('rejects JPEG thumbnails larger than Telegram dimensions', async () => {
    const result = await validateTelegramThumbnailBlob(jpegBlob(640, 360), 'image/jpeg');
    expect(result).toMatchObject({ ok: false, status: 'invalid_dimensions' });
  });

  it('downloads and attaches only valid Telegram thumbnails for binary videos', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://cdn.test/video.mp4') {
        return new Response(new Blob(['video'], { type: 'video/mp4' }), {
          status: 200,
          headers: { 'content-type': 'video/mp4', 'content-length': '5' },
        });
      }
      if (url === 'https://cdn.test/thumb.jpg') {
        return new Response(jpegBlob(120, 90), {
          status: 200,
          headers: { 'content-type': 'image/jpeg', 'content-length': '23' },
        });
      }
      throw new Error('unexpected fetch: ' + url);
    }));

    const result = await processMediaItem(env({ MEDIA_PROCESSING_MODE: 'binary_upload' }),
      'https://cdn.test/video.mp4', 'video', 'https://cdn.test/thumb.jpg');

    expect(result).toMatchObject({ ok: true, thumbnailStatus: 'valid' });
    expect(result.thumbnailBlob).toBeInstanceOf(Blob);
  });

  it('skips invalid thumbnails while keeping the video media usable', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://cdn.test/video.mp4') {
        return new Response(new Blob(['video'], { type: 'video/mp4' }), {
          status: 200,
          headers: { 'content-type': 'video/mp4', 'content-length': '5' },
        });
      }
      if (url === 'https://cdn.test/thumb.png') {
        return new Response(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': '4' },
        });
      }
      throw new Error('unexpected fetch: ' + url);
    }));

    const result = await processMediaItem(env({ MEDIA_PROCESSING_MODE: 'binary_upload' }),
      'https://cdn.test/video.mp4', 'video', 'https://cdn.test/thumb.png');

    expect(result.ok).toBe(true);
    expect(result.thumbnailBlob).toBeUndefined();
    expect(result.thumbnailStatus).toBe('unsupported_format');
  });

});
