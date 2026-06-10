import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeItem } from '../apps/worker-api/src/services/apify-client';
import { extractMediaTypes, resolveMedia } from '../apps/worker-api/src/services/media-resolver';
import { prepareTelegramCaptions, publishToTelegram } from '../apps/worker-api/src/services/telegram-publisher';
import type { ChannelRow, Env } from '../apps/worker-api/src/types';
import {
  instagramCarouselPost,
  twitterVideoPost,
} from './fixtures/apify-fixtures';

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
    STREAM_TRANSCODE_ENABLED: 'false',
    DB: settingsDb(),
    ...overrides,
  } as Env;
}

function channel(overrides: Partial<ChannelRow> = {}): ChannelRow {
  return {
    id: 'channel_fa',
    category_id: 'crypto',
    telegram_chat_id: '@thesolxcrypto_fa',
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
    channel_label: 'Crypto FA',
    source_enabled: 1,
    source_label_override: null,
    signature_enabled: 1,
    signature_text: '— The Sol Crypto',
    channel_id_footer_enabled: 1,
    channel_id_footer_text: null,
    disable_link_preview: 1,
    semantic_dedupe_enabled: 1,
    semantic_dedupe_window_hours: 24,
    max_posts_per_source_per_day: null,
    editorial_mode: 'news',
    audience_level: 'intermediate',
    caption_style: 'contextual',
    creativity_level: 0.2,
    caption_max_chars: 900,
    caption_short_max_chars: 220,
    language_prompt: null,
    terminology_notes: null,
    forbidden_phrases: null,
    ...overrides,
  };
}

function jsonBody(call: FetchCall): any {
  return JSON.parse(String(call.init?.body));
}

function visibleTextWithoutHref(html: string): string {
  return html.replace(/href="[^"]+"/g, '');
}

describe('media QA acceptance coverage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('publishes a single image as sendPhoto with formatted source/signature/footer caption', async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Response.json({
        ok: true,
        result: {
          message_id: 301,
          photo: [{ file_id: 'small' }, { file_id: 'photo-file-id' }],
        },
      });
    }));

    const sourceUrl = 'https://x.com/Cointelegraph/status/123?utm=raw';
    const result = await publishToTelegram(env(), {
      chatId: '@thesolxcrypto_fa',
      captionShort: 'خبر کوتاه',
      captionFull: `خبر کوتاه درباره بازار\n\n${sourceUrl}`,
      sourceUrl,
      method: 'sendPhoto',
      language: 'fa',
      channel: channel(),
      mediaUrls: ['https://cdn.test/photo.jpg'],
      mediaTypes: ['image'],
    });

    expect(result).toMatchObject({ ok: true, messageId: '301' });
    expect(result.mediaResults?.[0]).toMatchObject({
      mediaIndex: 0,
      status: 'uploaded',
      telegramFileId: 'photo-file-id',
      telegramMessageId: '301',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/sendPhoto');

    const payload = jsonBody(calls[0]);
    expect(payload.caption).toContain('<a href="https://x.com/Cointelegraph/status/123?utm=raw">منبع</a>');
    expect(payload.caption).toContain('— The Sol Crypto');
    expect(payload.caption).toContain('@thesolxcrypto_fa');
    expect(visibleTextWithoutHref(payload.caption)).not.toContain('https://x.com/Cointelegraph/status/123');
    expect(payload.parse_mode).toBe('HTML');
  });

  it('publishes a single video as sendVideo and sends a follow-up full caption without link preview when media caption is short', async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/sendVideo')) {
        return Response.json({ ok: true, result: { message_id: 401, video: { file_id: 'video-file-id' } } });
      }
      return Response.json({ ok: true, result: { message_id: 402 } });
    }));

    const sourceUrl = 'https://x.com/Cointelegraph/status/456';
    const longBody = 'تحلیل ویدئویی '.repeat(95);
    const result = await publishToTelegram(env(), {
      chatId: '@thesolxcrypto_fa',
      captionShort: 'خلاصه ویدئو',
      captionFull: longBody,
      sourceUrl,
      method: 'sendVideo',
      language: 'fa',
      channel: channel(),
      mediaUrls: ['https://cdn.test/video.mp4'],
      thumbnailUrls: ['https://cdn.test/thumb.jpg'],
      mediaTypes: ['video'],
    });

    expect(result).toMatchObject({ ok: true, messageId: '401' });
    expect(calls.map(call => call.url)).toEqual([
      expect.stringContaining('/sendVideo'),
      expect.stringContaining('/sendMessage'),
    ]);

    const videoPayload = jsonBody(calls[0]);
    expect(videoPayload.caption.length).toBeLessThanOrEqual(1024);
    expect(videoPayload.caption).toContain('<a href="https://x.com/Cointelegraph/status/456">منبع</a>');
    expect(videoPayload.caption).toContain('— The Sol Crypto');
    expect(videoPayload.caption).toContain('@thesolxcrypto_fa');
    expect(videoPayload).not.toHaveProperty('thumbnail');

    const followUpPayload = jsonBody(calls[1]);
    expect(followUpPayload.text.length).toBeLessThanOrEqual(4096);
    expect(followUpPayload.text).toContain('<a href="https://x.com/Cointelegraph/status/456">منبع</a>');
    expect(followUpPayload.link_preview_options).toEqual({ is_disabled: true });
  });

  it('publishes a media group from normalized Apify media and sends a follow-up full caption without preview', async () => {
    const item = normalizeItem(instagramCarouselPost, 'instagram');
    expect(item).not.toBeNull();
    const media = resolveMedia(item!.media, 'preferred');
    expect(media.method).toBe('sendMediaGroup');

    const calls: FetchCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/sendMediaGroup')) {
        return Response.json({ ok: true, result: [{ message_id: 501 }, { message_id: 502 }] });
      }
      return Response.json({ ok: true, result: { message_id: 503 } });
    }));

    const result = await publishToTelegram(env(), {
      chatId: '@thesolxcrypto_fa',
      captionShort: 'کاروسل کوتاه',
      captionFull: 'متن کامل کاروسل '.repeat(100),
      sourceUrl: item!.sourceUrl,
      method: media.method,
      language: 'fa',
      channel: channel(),
      mediaUrls: media.mediaUrls,
      thumbnailUrls: media.thumbnailUrls,
      mediaTypes: extractMediaTypes(item!.media, 'preferred'),
    });

    expect(result).toMatchObject({ ok: true, allMessageIds: ['501', '502'] });
    expect(calls.map(call => call.url)).toEqual([
      expect.stringContaining('/sendMediaGroup'),
      expect.stringContaining('/sendMessage'),
    ]);

    const groupPayload = jsonBody(calls[0]);
    expect(groupPayload.media).toHaveLength(2);
    expect(groupPayload.media[0]).toMatchObject({ type: 'photo', parse_mode: 'HTML' });
    expect(groupPayload.media[1]).toMatchObject({ type: 'video', supports_streaming: true });
    expect(groupPayload.media[0].caption.length).toBeLessThanOrEqual(1024);
    expect(groupPayload.media[0].caption).toContain('<a href=');

    const followUpPayload = jsonBody(calls[1]);
    expect(followUpPayload.link_preview_options).toEqual({ is_disabled: true });
    expect(visibleTextWithoutHref(followUpPayload.text)).not.toContain(item!.sourceUrl);
  });

  it('partially publishes a binary media group when one media item is broken and partial publish is enabled', async () => {
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
        const form = init?.body as FormData;
        expect(form).toBeInstanceOf(FormData);
        expect(form.get('media')).toBeTruthy();
        return Response.json({
          ok: true,
          result: [
            { message_id: 601, photo: [{ file_id: 'a-small' }, { file_id: 'a-large' }] },
            { message_id: 602, photo: [{ file_id: 'c-small' }, { file_id: 'c-large' }] },
          ],
        });
      }
      throw new Error('unexpected fetch: ' + url);
    }));

    const result = await publishToTelegram(env({ MEDIA_PROCESSING_MODE: 'binary_upload' }), {
      chatId: '@thesolxcrypto_fa',
      captionShort: 'گروه مدیا',
      captionFull: 'گروه مدیا کامل',
      sourceUrl: 'https://x.com/Cointelegraph/status/789',
      method: 'sendMediaGroup',
      language: 'fa',
      channel: channel(),
      mediaUrls: ['https://cdn.test/a.jpg', 'https://cdn.test/b.jpg', 'https://cdn.test/c.jpg'],
      mediaTypes: ['image', 'image', 'image'],
    });

    expect(result.ok).toBe(true);
    expect(result.captionError).toContain('partial_media_group');
    expect(result.partialMedia).toMatchObject({ originalCount: 3, publishedCount: 2, failedCount: 1, failedIndexes: [1] });
    expect(result.mediaResults).toEqual([
      expect.objectContaining({ mediaIndex: 0, status: 'uploaded', telegramFileId: 'a-large', telegramMessageId: '601' }),
      expect.objectContaining({ mediaIndex: 1, status: 'expired', error: 'not_found: HTTP 404' }),
      expect.objectContaining({ mediaIndex: 2, status: 'uploaded', telegramFileId: 'c-large', telegramMessageId: '602' }),
    ]);
  });

  it('fails a broken binary media group safely when partial publish is disabled', async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push({ url });
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
      chatId: '@thesolxcrypto_fa',
      captionShort: 'گروه مدیا',
      captionFull: 'گروه مدیا کامل',
      sourceUrl: 'https://x.com/Cointelegraph/status/790',
      method: 'sendMediaGroup',
      language: 'fa',
      channel: channel(),
      mediaUrls: ['https://cdn.test/a.jpg', 'https://cdn.test/b.jpg'],
      mediaTypes: ['image', 'image'],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('media_group_partial_publish_disabled');
    expect(result.partialMedia).toMatchObject({ originalCount: 2, publishedCount: 1, failedCount: 1, failedIndexes: [1] });
    expect(calls.some(call => call.url.includes('/sendMediaGroup'))).toBe(false);
  });

  it('keeps source/signature/footer atomic in prepared media captions', () => {
    const captions = prepareTelegramCaptions({
      chatId: '@thesolxcrypto_fa',
      captionShort: 'کوتاه',
      captionFull: 'الف'.repeat(1300),
      sourceUrl: 'https://x.com/Cointelegraph/status/900',
      method: 'sendPhoto',
      language: 'fa',
      channel: channel({ signature_text: '— The Sol Crypto\nدنبال‌کردن تحلیل‌ها' }),
      mediaUrls: ['https://cdn.test/photo.jpg'],
      mediaTypes: ['image'],
    });

    expect(captions.mediaHtml.length).toBeLessThanOrEqual(1024);
    expect(captions.mediaHtml).toContain('<a href="https://x.com/Cointelegraph/status/900">منبع</a>');
    expect(captions.mediaHtml).toContain('— The Sol Crypto');
    expect(captions.mediaHtml).toContain('@thesolxcrypto_fa');
    expect(captions.sendFullFollowUp).toBe(true);
  });

  it('documents real Apify video query shape by normalizing a Twitter video fixture', () => {
    const item = normalizeItem(twitterVideoPost, 'x');
    expect(item).not.toBeNull();
    expect(item!.media).toHaveLength(1);
    expect(item!.media[0]).toMatchObject({ type: 'video', thumbnailUrl: 'https://pbs.twimg.com/media/thumb.jpg' });
    const media = resolveMedia(item!.media, 'optional');
    expect(media.method).toBe('sendVideo');
  });
});
