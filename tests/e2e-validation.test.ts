import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeItem } from '../apps/worker-api/src/services/apify-client';
import { resolveMedia, extractMediaTypes } from '../apps/worker-api/src/services/media-resolver';
import { publishToTelegram } from '../apps/worker-api/src/services/telegram-publisher';
import type { Env } from '../apps/worker-api/src/types';
import {
  instagramCarouselPost,
  linkedinDocumentWithTooManyPagesPost,
  twitterVideoPost,
} from './fixtures/apify-fixtures';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    TELEGRAM_FINAL_PUBLISH_ENABLED: 'true',
    TELEGRAM_BOT_TOKEN: '123:test-token',
    MEDIA_PROCESSING_MODE: 'direct_url',
    MEDIA_GROUP_PARTIAL_PUBLISH_ENABLED: 'true',
    STREAM_TRANSCODE_ENABLED: 'false',
    DB: {},
    ...overrides,
  } as Env;
}

function jsonBody(call: FetchCall): any {
  return JSON.parse(String(call.init?.body));
}

describe('phase 11 end-to-end validation baseline', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes an Instagram carousel, resolves it to a media group, and publishes the expected Telegram payload', async () => {
    const item = normalizeItem(instagramCarouselPost, 'instagram');
    expect(item).not.toBeNull();
    expect(item?.media).toHaveLength(2);
    expect(item?.media[1]).toMatchObject({
      type: 'video',
      url: 'https://scontent.cdninstagram.com/video-1.mp4',
      thumbnailUrl: 'https://scontent.cdninstagram.com/video-1-thumb.jpg',
    });

    const media = resolveMedia(item!.media, 'preferred');
    expect(media.method).toBe('sendMediaGroup');
    expect(media.mediaUrls).toEqual([
      'https://scontent.cdninstagram.com/image-1.jpg',
      'https://scontent.cdninstagram.com/video-1.mp4',
    ]);
    expect(extractMediaTypes(item!.media, 'preferred')).toEqual(['image', 'video']);

    const calls: FetchCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/sendMediaGroup')) {
        return Response.json({ ok: true, result: [{ message_id: 10 }, { message_id: 11 }] });
      }
      return Response.json({ ok: true, result: { message_id: 12 } });
    }));

    const result = await publishToTelegram(env(), {
      chatId: '@stage_channel',
      captionShort: 'Carousel short caption',
      captionFull: 'x'.repeat(1100),
      sourceUrl: item!.sourceUrl,
      method: media.method,
      mediaUrls: media.mediaUrls,
      thumbnailUrls: media.thumbnailUrls,
      mediaTypes: extractMediaTypes(item!.media, 'preferred'),
    });

    expect(result.ok).toBe(true);
    expect(result.allMessageIds).toEqual(['10', '11']);
    expect(calls.map(call => call.url)).toEqual([
      expect.stringContaining('/sendMediaGroup'),
      expect.stringContaining('/sendMessage'),
    ]);
    const payload = jsonBody(calls[0]);
    expect(payload.media).toHaveLength(2);
    expect(payload.media[0]).toMatchObject({ type: 'photo' });
    expect(payload.media[1]).toMatchObject({ type: 'video', supports_streaming: true });
  });

  it('normalizes a Twitter video and validates no-cost direct video fallback to document before text', async () => {
    const item = normalizeItem(twitterVideoPost, 'x');
    expect(item).not.toBeNull();
    expect(item?.media[0]).toMatchObject({
      type: 'video',
      url: 'https://video.twimg.com/ext_tw_video/high.mp4',
      thumbnailUrl: 'https://pbs.twimg.com/media/thumb.jpg',
    });

    const media = resolveMedia(item!.media, 'optional');
    expect(media.method).toBe('sendVideo');

    const calls: FetchCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/sendVideo')) {
        return Response.json({ ok: false, error_code: 400, description: 'Bad Request: wrong type of the web page content' });
      }
      if (url.includes('/sendDocument')) {
        return Response.json({ ok: true, result: { message_id: 20, document: { file_id: 'doc-file-id' } } });
      }
      throw new Error('unexpected fetch: ' + url);
    }));

    const result = await publishToTelegram(env(), {
      chatId: '@stage_channel',
      captionShort: 'Video short',
      captionFull: 'Video full',
      sourceUrl: item!.sourceUrl,
      method: media.method,
      mediaUrls: media.mediaUrls,
      thumbnailUrls: media.thumbnailUrls,
      mediaTypes: extractMediaTypes(item!.media, 'optional'),
    });

    expect(result).toMatchObject({ ok: true, messageId: '20', videoSentAsDocument: true });
    expect(result.mediaResults?.[0]).toMatchObject({
      mediaIndex: 0,
      status: 'uploaded',
      telegramFileId: 'doc-file-id',
    });
    expect(calls.map(call => call.url)).toEqual([
      expect.stringContaining('/sendVideo'),
      expect.stringContaining('/sendDocument'),
    ]);
    expect(jsonBody(calls[0])).not.toHaveProperty('thumbnail');
  });

  it('keeps large LinkedIn document carousels capped to Telegram media group limits before publishing', async () => {
    const item = normalizeItem(linkedinDocumentWithTooManyPagesPost, 'linkedin');
    expect(item?.expectedMediaCount).toBe(12);
    expect(item?.media).toHaveLength(10);
    expect(item?.mediaWarnings?.join(' ')).toContain('expected 12 media items');

    const media = resolveMedia(item!.media, 'preferred');
    expect(media.method).toBe('sendMediaGroup');
    expect(media.mediaUrls).toHaveLength(10);
    expect(extractMediaTypes(item!.media, 'preferred')).toHaveLength(10);
  });

  it('does not call Cloudflare Stream during binary video fallback when Stream is disabled', async () => {
    const fakeMp4 = new Uint8Array([
      0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
      0x6d, 0x6f, 0x6f, 0x76, 0x6d, 0x64, 0x61, 0x74,
    ]);
    const calls: FetchCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === 'https://cdn.test/video.mp4') {
        return new Response(new Blob([fakeMp4], { type: 'video/mp4' }), {
          status: 200,
          headers: { 'content-type': 'video/mp4', 'content-length': String(fakeMp4.byteLength) },
        });
      }
      if (url.includes('/sendVideo')) {
        return Response.json({ ok: false, error_code: 400, description: 'Bad Request: wrong type of the web page content' });
      }
      if (url.includes('/sendDocument')) {
        return Response.json({ ok: true, result: { message_id: 30 } });
      }
      throw new Error('unexpected fetch: ' + url);
    }));

    const result = await publishToTelegram(env({
      MEDIA_PROCESSING_MODE: 'binary_upload',
      CLOUDFLARE_ACCOUNT_ID: 'configured-account',
      CLOUDFLARE_STREAM_API_TOKEN: 'configured-token',
      STREAM_TRANSCODE_ENABLED: 'false',
    }), {
      chatId: '@stage_channel',
      captionShort: 'short',
      captionFull: 'full',
      sourceUrl: 'https://source.test/video',
      method: 'sendVideo',
      mediaUrls: ['https://cdn.test/video.mp4'],
      mediaTypes: ['video'],
    });

    expect(result).toMatchObject({ ok: true, messageId: '30', videoSentAsDocument: true });
    expect(calls.some(call => call.url.includes('api.cloudflare.com'))).toBe(false);
  });
});
