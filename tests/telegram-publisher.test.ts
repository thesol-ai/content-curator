import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishToTelegram } from '../apps/worker-api/src/services/telegram-publisher';
import type { Env, ChannelRow } from '../apps/worker-api/src/types';

interface FetchCall {
  url: string;
  init?: RequestInit;
}


function settingsDb(settings: Record<string, string> = { telegram_publish_enabled: 'true' }): any {
  return {
    prepare: vi.fn(() => ({
      all: vi.fn(async () => ({
        results: Object.entries(settings).map(([key, value]) => ({ key, value })),
      })),
    })),
  };
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    TELEGRAM_FINAL_PUBLISH_ENABLED: 'true',
    TELEGRAM_BOT_TOKEN: '123:test-token',
    MEDIA_PROCESSING_MODE: 'direct_url',
    MEDIA_GROUP_PARTIAL_PUBLISH_ENABLED: 'true',
    DB: settingsDb(),
    ...overrides,
  } as Env;
}

function channel(overrides: Partial<ChannelRow> = {}): ChannelRow {
  return {
    id: 'channel_fa',
    category_id: 'crypto',
    telegram_chat_id: '@channel',
    language: 'fa',
    timezone: 'Asia/Tehran',
    allowed_windows: '[]',
    blocked_windows: '[]',
    max_per_day: 10,
    max_per_hour: 2,
    min_gap_minutes: 30,
    publish_enabled: 1,
    enabled: 1,
    custom_instructions: null,
    tone_profile: 'neutral',
    channel_label: null,
    source_enabled: 1,
    source_label_override: null,
    signature_enabled: 0,
    signature_text: null,
    channel_id_footer_enabled: 0,
    channel_id_footer_text: null,
    disable_link_preview: 1,
    semantic_dedupe_enabled: 1,
    semantic_dedupe_window_hours: 24,
    max_posts_per_source_per_day: null,
    ...overrides,
  };
}

function jsonBody(call: FetchCall): any {
  return JSON.parse(String(call.init?.body));
}

describe('telegram-publisher baseline', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends sanitized text messages', async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ ok: true, result: { message_id: 10 } });
    }));

    const result = await publishToTelegram(env(), {
      chatId: '@channel',
      captionShort: 'short',
      captionFull: 'hello <b>world</b> & friends',
      sourceUrl: 'https://source.test/post',
      method: 'sendMessage',
      mediaUrls: [],
    });

    expect(result).toMatchObject({ ok: true, messageId: '10' });
    expect(calls[0].url).toContain('/sendMessage');
    expect(jsonBody(calls[0])).toMatchObject({
      chat_id: '@channel',
      text: 'hello &lt;b&gt;world&lt;/b&gt; &amp; friends',
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  });

  it('formats channel messages with linked source label and no raw visible source URL', async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ ok: true, result: { message_id: 11 } });
    }));

    const sourceUrl = 'https://x.com/VitalikButerin/status/123?ref=raw';
    await publishToTelegram(env(), {
      chatId: '@channel',
      captionShort: 'short',
      captionFull: `یک متن مهم

منبع: ${sourceUrl}`,
      sourceUrl,
      method: 'sendMessage',
      language: 'fa',
      channel: channel(),
      mediaUrls: [],
    });

    const text = jsonBody(calls[0]).text;
    expect(text).toContain('<a href="https://x.com/VitalikButerin/status/123?ref=raw">منبع</a>');
    expect(text.replace(/href="[^"]+"/g, '')).not.toContain('https://x.com/VitalikButerin/status/123');
    expect(jsonBody(calls[0]).link_preview_options).toEqual({ is_disabled: true });
  });


  it('sends direct media group and follow-up full caption when caption is longer than Telegram media caption limit', async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/sendMediaGroup')) {
        return Response.json({ ok: true, result: [{ message_id: 21 }, { message_id: 22 }] });
      }
      return Response.json({ ok: true, result: { message_id: 23 } });
    }));

    const longCaption = 'x'.repeat(1100);
    const result = await publishToTelegram(env(), {
      chatId: '@channel',
      captionShort: 'album short',
      captionFull: longCaption,
      sourceUrl: 'https://source.test/post',
      method: 'sendMediaGroup',
      mediaUrls: ['https://cdn.test/a.jpg', 'https://cdn.test/v.mp4'],
      mediaTypes: ['image', 'video'],
    });

    expect(result).toMatchObject({ ok: true, messageId: '21', allMessageIds: ['21', '22'] });
    expect(calls.map(call => call.url)).toEqual([
      expect.stringContaining('/sendMediaGroup'),
      expect.stringContaining('/sendMessage'),
    ]);
    const mediaPayload = jsonBody(calls[0]);
    expect(mediaPayload.media[0]).toMatchObject({ type: 'photo', caption: 'album short' });
    expect(mediaPayload.media[1]).toMatchObject({ type: 'video', supports_streaming: true });
  });

  it('falls direct_url video media errors back to sendDocument before text fallback', async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/sendVideo')) {
        return Response.json({
          ok: false,
          error_code: 400,
          description: 'Bad Request: wrong type of the web page content',
        });
      }
      if (url.includes('/sendDocument')) {
        return Response.json({ ok: true, result: { message_id: 98 } });
      }
      throw new Error('unexpected fetch: ' + url);
    }));

    const result = await publishToTelegram(env(), {
      chatId: '@channel',
      captionShort: 'video short',
      captionFull: 'video full',
      sourceUrl: 'https://source.test/video-post?x=1&y=2',
      method: 'sendVideo',
      mediaUrls: ['https://cdn.test/video.mov'],
      thumbnailUrls: ['https://cdn.test/thumb.jpg'],
    });

    expect(result).toMatchObject({ ok: true, messageId: '98', videoSentAsDocument: true });
    expect(calls.map(call => call.url)).toEqual([
      expect.stringContaining('/sendVideo'),
      expect.stringContaining('/sendDocument'),
    ]);
    expect(jsonBody(calls[0])).not.toHaveProperty('thumbnail');
    expect(jsonBody(calls[1])).toMatchObject({
      chat_id: '@channel',
      document: 'https://cdn.test/video.mov',
      caption: 'video full',
    });
  });

  it('falls back to text with source link when direct_url sendVideo and sendDocument both fail', async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/sendVideo')) {
        return Response.json({ ok: false, error_code: 400, description: 'Bad Request: wrong type of the web page content' });
      }
      if (url.includes('/sendDocument')) {
        return Response.json({ ok: false, error_code: 400, description: 'Bad Request: failed to get HTTP URL content' });
      }
      return Response.json({ ok: true, result: { message_id: 99 } });
    }));

    const result = await publishToTelegram(env(), {
      chatId: '@channel',
      captionShort: 'video short',
      captionFull: 'video full',
      sourceUrl: 'https://source.test/video-post?x=1&y=2',
      method: 'sendVideo',
      language: 'en',
      channel: channel({ language: 'en' }),
      mediaUrls: ['https://cdn.test/video.mov'],
    });

    expect(result).toMatchObject({ ok: true, messageId: '99' });
    expect(result.captionError).toContain('video_fallback_to_text_after_document_failed');
    expect(calls.map(call => call.url)).toEqual([
      expect.stringContaining('/sendVideo'),
      expect.stringContaining('/sendDocument'),
      expect.stringContaining('/sendMessage'),
    ]);
    const fallbackText = jsonBody(calls[2]).text;
    expect(fallbackText).toContain('<a href="https://source.test/video-post?x=1&amp;y=2">Source</a>');
    expect(fallbackText.replace(/href="[^"]+"/g, '')).not.toContain('https://source.test/video-post');
    expect(jsonBody(calls[2]).link_preview_options).toEqual({ is_disabled: true });
  });

  it('uses binary upload mode for photos after downloading media', async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === 'https://cdn.test/photo.jpg') {
        return new Response(new Blob(['binary-photo'], { type: 'image/jpeg' }), {
          status: 200,
          headers: { 'content-type': 'image/jpeg', 'content-length': '12' },
        });
      }
      return Response.json({ ok: true, result: { message_id: 41 } });
    }));

    const result = await publishToTelegram(env({ MEDIA_PROCESSING_MODE: 'binary_upload' }), {
      chatId: '@channel',
      captionShort: 'photo short',
      captionFull: 'photo full',
      sourceUrl: 'https://source.test/photo-post',
      method: 'sendPhoto',
      mediaUrls: ['https://cdn.test/photo.jpg'],
    });

    expect(result).toMatchObject({ ok: true, messageId: '41' });
    expect(calls[0]).toMatchObject({ url: 'https://cdn.test/photo.jpg' });
    expect(calls[1].url).toContain('/sendPhoto');
    expect(calls[1].init?.body).toBeInstanceOf(FormData);
  });

  it('does not call Cloudflare Stream when sendVideo binary upload fails and Stream is not explicitly enabled', async () => {
    const calls: FetchCall[] = [];
    const fakeMp4 = new Uint8Array([
      0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
      0x6d, 0x6f, 0x6f, 0x76, 0x6d, 0x64, 0x61, 0x74,
    ]);

    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === 'https://cdn.test/video.mp4') {
        return new Response(new Blob([fakeMp4], { type: 'video/mp4' }), {
          status: 200,
          headers: { 'content-type': 'video/mp4', 'content-length': String(fakeMp4.byteLength) },
        });
      }
      if (url.includes('/sendVideo')) {
        return Response.json({
          ok: false,
          error_code: 400,
          description: 'Bad Request: wrong type of the web page content',
        });
      }
      if (url.includes('/sendDocument')) {
        return Response.json({ ok: true, result: { message_id: 77 } });
      }
      throw new Error('unexpected fetch: ' + url);
    }));

    const result = await publishToTelegram(env({
      MEDIA_PROCESSING_MODE: 'binary_upload',
      CLOUDFLARE_ACCOUNT_ID: 'account-id',
      CLOUDFLARE_STREAM_API_TOKEN: 'token',
      STREAM_TRANSCODE_ENABLED: 'false',
    }), {
      chatId: '@channel',
      captionShort: 'video short',
      captionFull: 'video full',
      sourceUrl: 'https://source.test/video-post',
      method: 'sendVideo',
      mediaUrls: ['https://cdn.test/video.mp4'],
    });

    expect(result).toMatchObject({ ok: true, messageId: '77', videoSentAsDocument: true });
    expect(calls.map(call => call.url)).toEqual([
      'https://cdn.test/video.mp4',
      expect.stringContaining('/sendVideo'),
      expect.stringContaining('/sendDocument'),
    ]);
    expect(calls.some(call => call.url.includes('api.cloudflare.com'))).toBe(false);
  });


  it('falls binary video to text when sendVideo and sendDocument both fail', async () => {
    const calls: FetchCall[] = [];
    const fakeMp4 = new Uint8Array([
      0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
      0x6d, 0x6f, 0x6f, 0x76, 0x6d, 0x64, 0x61, 0x74,
    ]);

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
        return Response.json({ ok: false, error_code: 400, description: 'Bad Request: invalid file HTTP URL specified' });
      }
      return Response.json({ ok: true, result: { message_id: 88 } });
    }));

    const result = await publishToTelegram(env({ MEDIA_PROCESSING_MODE: 'binary_upload' }), {
      chatId: '@channel',
      captionShort: 'video short',
      captionFull: 'video full',
      sourceUrl: 'https://source.test/video-post',
      method: 'sendVideo',
      mediaUrls: ['https://cdn.test/video.mp4'],
    });

    expect(result).toMatchObject({ ok: true, messageId: '88' });
    expect(result.captionError).toContain('video_fallback_to_text_after_binary_document_failed');
    expect(calls.map(call => call.url)).toEqual([
      'https://cdn.test/video.mp4',
      expect.stringContaining('/sendVideo'),
      expect.stringContaining('/sendDocument'),
      expect.stringContaining('/sendMessage'),
    ]);
  });

  it('allows partial binary media groups by default and reports failed indexes', async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === 'https://cdn.test/a.jpg') {
        return new Response(new Blob(['image-a'], { type: 'image/jpeg' }), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      if (url === 'https://cdn.test/b.jpg') {
        return new Response('not found', { status: 404 });
      }
      if (url === 'https://cdn.test/c.jpg') {
        return new Response(new Blob(['image-c'], { type: 'image/jpeg' }), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      if (url.includes('/sendMediaGroup')) {
        return Response.json({ ok: true, result: [{ message_id: 51 }, { message_id: 52 }] });
      }
      throw new Error('unexpected fetch: ' + url);
    }));

    const result = await publishToTelegram(env({ MEDIA_PROCESSING_MODE: 'binary_upload' }), {
      chatId: '@channel',
      captionShort: 'album short',
      captionFull: 'album full',
      sourceUrl: 'https://source.test/album',
      method: 'sendMediaGroup',
      mediaUrls: ['https://cdn.test/a.jpg', 'https://cdn.test/b.jpg', 'https://cdn.test/c.jpg'],
      mediaTypes: ['image', 'image', 'image'],
    });

    expect(result).toMatchObject({
      ok: true,
      messageId: '51',
      captionError: 'partial_media_group: 1/3 failed; indexes=1',
      partialMedia: { originalCount: 3, publishedCount: 2, failedCount: 1, failedIndexes: [1] },
    });
    expect(calls.map(call => call.url)).toEqual([
      'https://cdn.test/a.jpg',
      'https://cdn.test/b.jpg',
      'https://cdn.test/c.jpg',
      expect.stringContaining('/sendMediaGroup'),
    ]);
  });

  it('fails the whole binary media group when partial publishing is disabled', async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === 'https://cdn.test/a.jpg') {
        return new Response(new Blob(['image-a'], { type: 'image/jpeg' }), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      if (url === 'https://cdn.test/b.jpg') {
        return new Response('not found', { status: 404 });
      }
      throw new Error('unexpected fetch: ' + url);
    }));

    const result = await publishToTelegram(env({
      MEDIA_PROCESSING_MODE: 'binary_upload',
      MEDIA_GROUP_PARTIAL_PUBLISH_ENABLED: 'false',
    }), {
      chatId: '@channel',
      captionShort: 'album short',
      captionFull: 'album full',
      sourceUrl: 'https://source.test/album',
      method: 'sendMediaGroup',
      mediaUrls: ['https://cdn.test/a.jpg', 'https://cdn.test/b.jpg'],
      mediaTypes: ['image', 'image'],
    });

    expect(result).toMatchObject({
      ok: false,
      errorType: 'media_error',
      partialMedia: { originalCount: 2, publishedCount: 1, failedCount: 1, failedIndexes: [1] },
    });
    expect(result.error).toContain('media_group_partial_publish_disabled');
    expect(calls.map(call => call.url)).toEqual([
      'https://cdn.test/a.jpg',
      'https://cdn.test/b.jpg',
    ]);
  });


  it('uses R2 stableUrl for single photos instead of falling back to the original source URL', async () => {
    const calls: FetchCall[] = [];
    const bucket = {
      put: vi.fn(async () => undefined),
    };

    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === 'https://cdn.test/photo.jpg') {
        return new Response(new Blob(['photo-from-cdn'], { type: 'image/jpeg' }), {
          status: 200,
          headers: { 'content-type': 'image/jpeg', 'content-length': '14' },
        });
      }
      return Response.json({ ok: true, result: { message_id: 61 } });
    }));

    const result = await publishToTelegram(env({
      MEDIA_PROCESSING_MODE: 'r2_storage',
      MEDIA_BUCKET: bucket as any,
      R2_PUBLIC_BASE_URL: 'https://media.example.com',
    }), {
      chatId: '@channel',
      captionShort: 'photo short',
      captionFull: 'photo full',
      sourceUrl: 'https://source.test/photo-post',
      method: 'sendPhoto',
      mediaUrls: ['https://cdn.test/photo.jpg'],
    });

    expect(result).toMatchObject({ ok: true, messageId: '61' });
    expect(bucket.put).toHaveBeenCalledOnce();
    expect(calls.map(call => call.url)).toEqual([
      'https://cdn.test/photo.jpg',
      expect.stringContaining('/sendPhoto'),
    ]);
    const body = jsonBody(calls[1]);
    expect(body.photo).toMatch(/^https:\/\/media\.example\.com\/media\//);
    expect(body.photo).not.toBe('https://cdn.test/photo.jpg');
    expect(calls[1].init?.body).not.toBeInstanceOf(FormData);
  });

  it('uses R2 stableUrl for single videos and falls that stable URL back to sendDocument before text', async () => {
    const calls: FetchCall[] = [];
    const bucket = {
      put: vi.fn(async () => undefined),
    };

    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === 'https://cdn.test/video.mp4') {
        return new Response(new Blob(['video-from-cdn'], { type: 'video/mp4' }), {
          status: 200,
          headers: { 'content-type': 'video/mp4', 'content-length': '14' },
        });
      }
      if (url.includes('/sendVideo')) {
        return Response.json({ ok: false, error_code: 400, description: 'Bad Request: wrong file identifier/HTTP URL specified' });
      }
      if (url.includes('/sendDocument')) {
        return Response.json({ ok: true, result: { message_id: 62 } });
      }
      throw new Error('unexpected fetch: ' + url);
    }));

    const result = await publishToTelegram(env({
      MEDIA_PROCESSING_MODE: 'r2_storage',
      MEDIA_BUCKET: bucket as any,
      R2_PUBLIC_BASE_URL: 'https://media.example.com',
    }), {
      chatId: '@channel',
      captionShort: 'video short',
      captionFull: 'video full',
      sourceUrl: 'https://source.test/video-post',
      method: 'sendVideo',
      mediaUrls: ['https://cdn.test/video.mp4'],
    });

    expect(result).toMatchObject({ ok: true, messageId: '62', videoSentAsDocument: true });
    expect(bucket.put).toHaveBeenCalledOnce();
    expect(calls.map(call => call.url)).toEqual([
      'https://cdn.test/video.mp4',
      expect.stringContaining('/sendVideo'),
      expect.stringContaining('/sendDocument'),
    ]);
    const videoPayload = jsonBody(calls[1]);
    const documentPayload = jsonBody(calls[2]);
    expect(videoPayload.video).toMatch(/^https:\/\/media\.example\.com\/media\//);
    expect(documentPayload.document).toBe(videoPayload.video);
    expect(videoPayload.video).not.toBe('https://cdn.test/video.mp4');
  });


  it('does not attach invalid thumbnails to binary sendVideo payloads', async () => {
    const calls: FetchCall[] = [];
    const fakeMp4 = new Uint8Array([
      0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
      0x6d, 0x6f, 0x6f, 0x76, 0x6d, 0x64, 0x61, 0x74,
    ]);

    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === 'https://cdn.test/video.mp4') {
        return new Response(new Blob([fakeMp4], { type: 'video/mp4' }), {
          status: 200,
          headers: { 'content-type': 'video/mp4', 'content-length': String(fakeMp4.byteLength) },
        });
      }
      if (url === 'https://cdn.test/thumb.png') {
        return new Response(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': '4' },
        });
      }
      if (url.includes('/sendVideo')) {
        return Response.json({ ok: true, result: { message_id: 61 } });
      }
      throw new Error('unexpected fetch: ' + url);
    }));

    const result = await publishToTelegram(env({ MEDIA_PROCESSING_MODE: 'binary_upload' }), {
      chatId: '@channel',
      captionShort: 'video short',
      captionFull: 'video full',
      sourceUrl: 'https://source.test/video-post',
      method: 'sendVideo',
      mediaUrls: ['https://cdn.test/video.mp4'],
      thumbnailUrls: ['https://cdn.test/thumb.png'],
    });

    expect(result).toMatchObject({ ok: true, messageId: '61' });
    expect(calls.map(call => call.url)).toEqual([
      'https://cdn.test/video.mp4',
      'https://cdn.test/thumb.png',
      expect.stringContaining('/sendVideo'),
    ]);
    const form = calls[2].init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('video')).toBeInstanceOf(Blob);
    expect(form.get('thumbnail')).toBeNull();
  });

  it('extracts Telegram file_id and message_id for a direct photo publish result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      ok: true,
      result: {
        message_id: 101,
        photo: [
          { file_id: 'small-photo-file-id' },
          { file_id: 'large-photo-file-id' },
        ],
      },
    })));

    const result = await publishToTelegram(env(), {
      chatId: '@channel',
      captionShort: 'photo short',
      captionFull: 'photo full',
      sourceUrl: 'https://source.test/photo',
      method: 'sendPhoto',
      mediaUrls: ['https://cdn.test/photo.jpg'],
    });

    expect(result).toMatchObject({
      ok: true,
      messageId: '101',
      newFileIds: [{ mediaIndex: 0, fileId: 'large-photo-file-id' }],
      mediaResults: [{
        mediaIndex: 0,
        status: 'uploaded',
        telegramFileId: 'large-photo-file-id',
        telegramMessageId: '101',
      }],
    });
  });

  it('maps binary partial media group Telegram file_ids back to original media indexes', async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === 'https://cdn.test/a.jpg') {
        return new Response(new Blob(['image-a'], { type: 'image/jpeg' }), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      if (url === 'https://cdn.test/b.jpg') {
        return new Response('not found', { status: 404 });
      }
      if (url === 'https://cdn.test/c.jpg') {
        return new Response(new Blob(['image-c'], { type: 'image/jpeg' }), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      if (url.includes('/sendMediaGroup')) {
        return Response.json({
          ok: true,
          result: [
            { message_id: 201, photo: [{ file_id: 'a-small' }, { file_id: 'a-large' }] },
            { message_id: 202, photo: [{ file_id: 'c-small' }, { file_id: 'c-large' }] },
          ],
        });
      }
      throw new Error('unexpected fetch: ' + url);
    }));

    const result = await publishToTelegram(env({ MEDIA_PROCESSING_MODE: 'binary_upload' }), {
      chatId: '@channel',
      captionShort: 'album short',
      captionFull: 'album full',
      sourceUrl: 'https://source.test/album',
      method: 'sendMediaGroup',
      mediaUrls: ['https://cdn.test/a.jpg', 'https://cdn.test/b.jpg', 'https://cdn.test/c.jpg'],
      mediaTypes: ['image', 'image', 'image'],
    });

    expect(result.partialMedia).toMatchObject({ failedIndexes: [1] });
    expect(result.newFileIds).toEqual([
      { mediaIndex: 0, fileId: 'a-large' },
      { mediaIndex: 1, fileId: 'c-large' },
    ]);
    expect(result.mediaResults).toEqual([
      expect.objectContaining({ mediaIndex: 0, status: 'uploaded', telegramFileId: 'a-large', telegramMessageId: '201' }),
      expect.objectContaining({ mediaIndex: 1, status: 'expired', error: 'not_found: HTTP 404' }),
      expect.objectContaining({ mediaIndex: 2, status: 'uploaded', telegramFileId: 'c-large', telegramMessageId: '202' }),
    ]);
  });


  it('uses Cloudflare Stream only after binary sendVideo media error and deletes Stream asset after successful Telegram send', async () => {
    const calls: FetchCall[] = [];
    const streamVideoId = 'stream-video-abc';
    const streamDownloadUrl = 'https://downloads.example.com/stream-video-abc/default.mp4';
    const fakeMp4 = new Uint8Array([
      0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
      0x6d, 0x64, 0x61, 0x74, 0x6d, 0x6f, 0x6f, 0x76,
    ]);
    let telegramVideoAttempts = 0;

    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });

      if (url === 'https://cdn.test/video.mp4') {
        return new Response(new Blob([fakeMp4], { type: 'video/mp4' }), {
          status: 200,
          headers: { 'content-type': 'video/mp4', 'content-length': String(fakeMp4.byteLength) },
        });
      }
      if (url.includes('/sendVideo')) {
        telegramVideoAttempts++;
        if (telegramVideoAttempts === 1) {
          return Response.json({ ok: false, error_code: 400, description: 'Bad Request: wrong type of the web page content' });
        }
        return Response.json({ ok: true, result: { message_id: 901, video: { file_id: 'transcoded-video-file-id' } } });
      }
      if (url.endsWith('/stream')) {
        return Response.json({ success: true, result: { uid: streamVideoId } });
      }
      if (url.endsWith(`/stream/${streamVideoId}`) && init?.method === 'DELETE') {
        return Response.json({ success: true, result: null });
      }
      if (url.endsWith(`/stream/${streamVideoId}`)) {
        return Response.json({ success: true, result: { status: { state: 'ready' } } });
      }
      if (url.endsWith(`/stream/${streamVideoId}/downloads`)) {
        return Response.json({ success: true, result: { default: { url: streamDownloadUrl } } });
      }
      if (url === streamDownloadUrl) {
        return new Response(new Blob([fakeMp4], { type: 'video/mp4' }), { status: 200, headers: { 'content-type': 'video/mp4' } });
      }
      throw new Error('unexpected fetch: ' + url);
    }));

    const result = await publishToTelegram(env({
      MEDIA_PROCESSING_MODE: 'binary_upload',
      STREAM_TRANSCODE_ENABLED: 'true',
      CLOUDFLARE_ACCOUNT_ID: 'account-id',
      CLOUDFLARE_STREAM_API_TOKEN: 'token',
      STREAM_TRANSCODE_TIMEOUT_SEC: '30',
    }), {
      chatId: '@channel',
      captionShort: 'video short',
      captionFull: 'video full',
      sourceUrl: 'https://source.test/video-post',
      method: 'sendVideo',
      mediaUrls: ['https://cdn.test/video.mp4'],
    });

    expect(result).toMatchObject({ ok: true, messageId: '901', transcodedViaStream: true });
    expect(result.mediaResults?.[0]).toMatchObject({
      mediaIndex: 0,
      status: 'uploaded',
      telegramFileId: 'transcoded-video-file-id',
      telegramMessageId: '901',
    });
    expect(calls.some(call => call.url.includes('/stream') && call.init?.method !== 'DELETE')).toBe(true);
    expect(calls).toContainEqual(expect.objectContaining({
      url: expect.stringContaining(`/stream/${streamVideoId}`),
      init: expect.objectContaining({ method: 'DELETE' }),
    }));
    expect(calls.some(call => call.url.includes('customer-account-id.cloudflarestream.com'))).toBe(false);
  });

});
