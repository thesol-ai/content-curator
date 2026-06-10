import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeVideoBlob, extractDownloadUrl, transcodeViaStream } from '../apps/worker-api/src/services/video-transcoder';
import type { Env } from '../apps/worker-api/src/types';

function asciiBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function fakeMp4(order: 'moov-before-mdat' | 'mdat-before-moov'): Blob {
  const header = new Uint8Array(12);
  header.set([0, 0, 0, 24], 0);
  header.set(asciiBytes('ftyp'), 4);
  header.set(asciiBytes('isom'), 8);

  const padding = new Uint8Array(140).fill(0);
  const atoms = order === 'moov-before-mdat'
    ? [asciiBytes('moov'), padding, asciiBytes('mdat')]
    : [asciiBytes('mdat'), padding, asciiBytes('moov')];

  return new Blob([header, ...atoms], { type: 'video/mp4' });
}

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('video-transcoder analysis baseline', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('identifies MP4-like blobs and whether moov appears before mdat', async () => {
    const streamable = await analyzeVideoBlob(fakeMp4('moov-before-mdat'));
    expect(streamable.looksLikeValidVideo).toBe(true);
    expect(streamable.mightBeStreamable).toBe(true);

    const nonStreamable = await analyzeVideoBlob(fakeMp4('mdat-before-moov'));
    expect(nonStreamable.looksLikeValidVideo).toBe(true);
    expect(nonStreamable.mightBeStreamable).toBe(false);
  });

  it('marks non-video blobs as invalid', async () => {
    const result = await analyzeVideoBlob(new Blob(['hello'], { type: 'text/plain' }));
    expect(result.looksLikeValidVideo).toBe(false);
    expect(result.mimeType).toBe('text/plain');
  });

  it('does not call Cloudflare Stream when credentials exist but STREAM_TRANSCODE_ENABLED is not true', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await transcodeViaStream({
      CLOUDFLARE_ACCOUNT_ID: 'account-id',
      CLOUDFLARE_STREAM_API_TOKEN: 'token',
    } as Env, fakeMp4('moov-before-mdat'));

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Cloudflare Stream disabled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('extracts Stream download URLs only from API-returned metadata', () => {
    expect(extractDownloadUrl({ downloads: { default: { url: 'https://media.example/video.mp4' } } })).toBe('https://media.example/video.mp4');
    expect(extractDownloadUrl({ result: { url: 'https://ignored.example/video.mp4' } })).toBeUndefined();
    expect(extractDownloadUrl({ downloads: { default: { url: 'http://not-https.example/video.mp4' } } })).toBeUndefined();
  });

  it('uses Cloudflare API-returned download URL and never fabricates customer account download URLs', async () => {
    const uploadedVideoId = 'stream-video-123';
    const apiDownloadUrl = 'https://downloads.example.com/stream-video-123/default.mp4';
    const calls: string[] = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);

      if (url.endsWith('/stream')) {
        return jsonResponse({ success: true, result: { uid: uploadedVideoId, thumbnail: 'https://thumb.example/t.jpg' } });
      }
      if (url.endsWith(`/stream/${uploadedVideoId}`)) {
        return jsonResponse({ success: true, result: { status: { state: 'ready' }, thumbnail: 'https://thumb.example/ready.jpg' } });
      }
      if (url.endsWith(`/stream/${uploadedVideoId}/downloads`)) {
        return jsonResponse({ success: true, result: { default: { url: apiDownloadUrl } } });
      }
      if (url === apiDownloadUrl) {
        return new Response(fakeMp4('moov-before-mdat'), { status: 200, headers: { 'content-type': 'video/mp4' } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await transcodeViaStream({
      STREAM_TRANSCODE_ENABLED: 'true',
      CLOUDFLARE_ACCOUNT_ID: 'account-id',
      CLOUDFLARE_STREAM_API_TOKEN: 'token',
      STREAM_TRANSCODE_TIMEOUT_SEC: '30',
    } as Env, fakeMp4('mdat-before-moov'));

    expect(result.ok).toBe(true);
    expect(result.streamVideoId).toBe(uploadedVideoId);
    expect(result.downloadUrl).toBe(apiDownloadUrl);
    expect(result.mp4Blob?.size).toBeGreaterThan(0);
    expect(calls.some((url) => url.includes('customer-account-id.cloudflarestream.com'))).toBe(false);
    expect(calls).toContain(apiDownloadUrl);
  });
});
