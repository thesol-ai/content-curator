// ══════════════════════════════════════════════════════════════
// services/video-transcoder.ts
// Optional Cloudflare Stream fallback for video compatibility.
//
// Phase 9 rules:
//   - Stream is paid/optional and remains disabled by default.
//   - It is called only after Telegram sendVideo rejects a binary video.
//   - It never assumes customer-${accountId}.cloudflarestream.com.
//   - It only downloads MP4 from URLs returned by Cloudflare API.
//   - It does not delete Stream assets before Telegram has attempted sendVideo.
// ══════════════════════════════════════════════════════════════

import type { Env } from '../types';
import { getStreamTranscodeState } from './stream-config';

export interface TranscodeResult {
  ok: boolean;
  mp4Blob?: Blob;
  thumbnailUrl?: string;
  error?: string;
  /** Cloudflare Stream video UID, when Stream was used. */
  streamVideoId?: string;
  /** Download URL returned by Cloudflare API, if available. */
  downloadUrl?: string;
}

const STREAM_API_BASE = 'https://api.cloudflare.com/client/v4';
const DEFAULT_TRANSCODE_TIMEOUT_SEC = 120;
const DEFAULT_STREAM_POLL_INTERVAL_MS = 3000;

// ── Cloudflare Stream Transcode ───────────────────────────────

export async function transcodeViaStream(
  env: Env,
  videoBlob: Blob,
  videoFilename: string = 'video.mp4'
): Promise<TranscodeResult> {
  const streamState = getStreamTranscodeState(env);
  if (!streamState.enabled) {
    return { ok: false, error: `Cloudflare Stream disabled: ${streamState.reason}` };
  }

  const accountId = env.CLOUDFLARE_ACCOUNT_ID!.trim();
  const token = env.CLOUDFLARE_STREAM_API_TOKEN!.trim();
  const timeoutSec = parsePositiveInt(env.STREAM_TRANSCODE_TIMEOUT_SEC, DEFAULT_TRANSCODE_TIMEOUT_SEC);
  const deadline = Date.now() + timeoutSec * 1000;

  const upload = await uploadToStream(accountId, token, videoBlob, videoFilename);
  if (!upload.ok || !upload.videoId) return { ok: false, error: upload.error };

  const videoId = upload.videoId;
  let thumbnailUrl = upload.thumbnailUrl;

  try {
    const ready = await waitForStreamReady(accountId, token, videoId, deadline);
    if (!ready.ok) {
      await deleteStreamVideo(accountId, token, videoId).catch(() => {});
      return { ok: false, error: ready.error, streamVideoId: videoId };
    }
    thumbnailUrl = ready.thumbnailUrl ?? thumbnailUrl;

    const download = await waitForStreamDownloadUrl(accountId, token, videoId, deadline);
    if (!download.ok || !download.downloadUrl) {
      await deleteStreamVideo(accountId, token, videoId).catch(() => {});
      return { ok: false, error: download.error, streamVideoId: videoId };
    }

    const mp4Blob = await downloadMp4(download.downloadUrl);
    if (!mp4Blob.ok || !mp4Blob.blob) {
      await deleteStreamVideo(accountId, token, videoId).catch(() => {});
      return { ok: false, error: mp4Blob.error, streamVideoId: videoId, downloadUrl: download.downloadUrl };
    }

    return {
      ok: true,
      mp4Blob: mp4Blob.blob,
      thumbnailUrl,
      streamVideoId: videoId,
      downloadUrl: download.downloadUrl,
    };
  } catch (err) {
    await deleteStreamVideo(accountId, token, videoId).catch(() => {});
    return {
      ok: false,
      error: `Stream transcode error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
      streamVideoId: videoId,
    };
  }
}

async function uploadToStream(
  accountId: string,
  token: string,
  videoBlob: Blob,
  videoFilename: string
): Promise<{ ok: boolean; videoId?: string; thumbnailUrl?: string; error?: string }> {
  try {
    const form = new FormData();
    form.append('file', videoBlob, videoFilename);
    form.append('meta', JSON.stringify({ name: videoFilename }));

    const res = await fetch(`${STREAM_API_BASE}/accounts/${accountId}/stream`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });

    const payload = await readJsonSafe(res);
    if (!res.ok || payload?.success === false) {
      return { ok: false, error: `Stream upload failed ${res.status}: ${extractApiError(payload).slice(0, 200)}` };
    }

    const result = payload?.result ?? {};
    const videoId = typeof result.uid === 'string' ? result.uid : undefined;
    if (!videoId) return { ok: false, error: 'Stream upload returned no video ID' };

    return { ok: true, videoId, thumbnailUrl: typeof result.thumbnail === 'string' ? result.thumbnail : undefined };
  } catch (err) {
    return { ok: false, error: `Stream upload error: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}` };
  }
}

async function waitForStreamReady(
  accountId: string,
  token: string,
  videoId: string,
  deadline: number
): Promise<{ ok: boolean; thumbnailUrl?: string; error?: string }> {
  let lastState = 'unknown';

  while (Date.now() < deadline) {
    const status = await fetchStreamVideo(accountId, token, videoId);
    if (!status.ok) {
      lastState = status.error ?? 'status_fetch_failed';
      await sleep(DEFAULT_STREAM_POLL_INTERVAL_MS);
      continue;
    }

    const result = status.result ?? {};
    const state = String(result.status?.state ?? result.readyToStream ? 'ready' : 'unknown');
    lastState = state;

    if (state === 'ready' || result.readyToStream === true) {
      return { ok: true, thumbnailUrl: typeof result.thumbnail === 'string' ? result.thumbnail : undefined };
    }

    if (state === 'error') {
      const reason = result.status?.errorReasonCode ?? result.status?.errorReasonText ?? 'unknown';
      return { ok: false, error: `Stream transcode error: ${reason}` };
    }

    await sleep(DEFAULT_STREAM_POLL_INTERVAL_MS);
  }

  return { ok: false, error: `Stream transcode timed out while state=${lastState}` };
}

async function waitForStreamDownloadUrl(
  accountId: string,
  token: string,
  videoId: string,
  deadline: number
): Promise<{ ok: boolean; downloadUrl?: string; error?: string }> {
  // First inspect the video object. Some API responses include downloads metadata once ready.
  const existing = await fetchStreamVideo(accountId, token, videoId);
  const existingUrl = existing.ok ? extractDownloadUrl(existing.result) : undefined;
  if (existingUrl) return { ok: true, downloadUrl: existingUrl };

  // Request downloadable MP4 generation. Do not assume a public hostname; use only API-returned URLs.
  const created = await requestStreamDownload(accountId, token, videoId);
  if (!created.ok) return { ok: false, error: created.error };
  if (created.downloadUrl) return { ok: true, downloadUrl: created.downloadUrl };

  let lastState = 'requested';
  while (Date.now() < deadline) {
    await sleep(DEFAULT_STREAM_POLL_INTERVAL_MS);

    const status = await fetchStreamVideo(accountId, token, videoId);
    if (!status.ok) {
      lastState = status.error ?? 'status_fetch_failed';
      continue;
    }

    const url = extractDownloadUrl(status.result);
    if (url) return { ok: true, downloadUrl: url };

    lastState = extractDownloadState(status.result) ?? 'download_not_ready';
  }

  return { ok: false, error: `Stream download timed out while state=${lastState}` };
}

async function requestStreamDownload(
  accountId: string,
  token: string,
  videoId: string
): Promise<{ ok: boolean; downloadUrl?: string; error?: string }> {
  try {
    const res = await fetch(`${STREAM_API_BASE}/accounts/${accountId}/stream/${videoId}/downloads`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(30_000),
    });

    const payload = await readJsonSafe(res);
    if (!res.ok || payload?.success === false) {
      return { ok: false, error: `Stream download request failed ${res.status}: ${extractApiError(payload).slice(0, 200)}` };
    }

    return { ok: true, downloadUrl: extractDownloadUrl(payload?.result ?? payload) };
  } catch (err) {
    return { ok: false, error: `Stream download request error: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}` };
  }
}

async function fetchStreamVideo(
  accountId: string,
  token: string,
  videoId: string
): Promise<{ ok: boolean; result?: any; error?: string }> {
  try {
    const res = await fetch(`${STREAM_API_BASE}/accounts/${accountId}/stream/${videoId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await readJsonSafe(res);
    if (!res.ok || payload?.success === false) {
      return { ok: false, error: `Stream status failed ${res.status}: ${extractApiError(payload).slice(0, 200)}` };
    }
    return { ok: true, result: payload?.result ?? payload };
  } catch (err) {
    return { ok: false, error: `Stream status error: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}` };
  }
}

async function downloadMp4(url: string): Promise<{ ok: boolean; blob?: Blob; error?: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
    if (!res.ok) return { ok: false, error: `Stream MP4 download failed ${res.status}` };

    const blob = await res.blob();
    if (blob.size === 0) return { ok: false, error: 'Stream MP4 download returned empty file' };

    const contentType = res.headers.get('content-type')?.toLowerCase() ?? blob.type?.toLowerCase() ?? '';
    if (contentType && !contentType.includes('video') && !contentType.includes('octet-stream')) {
      return { ok: false, error: `Stream MP4 download returned non-video content-type: ${contentType}` };
    }

    return { ok: true, blob };
  } catch (err) {
    return { ok: false, error: `Stream MP4 download error: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}` };
  }
}

// ── Stream cleanup ────────────────────────────────────────────

export async function deleteStreamVideoFromEnv(env: Env, videoId: string): Promise<void> {
  const state = getStreamTranscodeState(env);
  if (!state.hasAccountId || !state.hasApiToken) return;
  await deleteStreamVideo(env.CLOUDFLARE_ACCOUNT_ID!.trim(), env.CLOUDFLARE_STREAM_API_TOKEN!.trim(), videoId);
}

async function deleteStreamVideo(accountId: string, token: string, videoId: string): Promise<void> {
  try {
    await fetch(`${STREAM_API_BASE}/accounts/${accountId}/stream/${videoId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch { /* ignore cleanup failures */ }
}

// ── Video blob analysis ───────────────────────────────────────

export interface BlobAnalysis {
  /** آیا فایل با magic bytes معتبر شروع می‌شود؟ */
  looksLikeValidVideo: boolean;
  /** آیا moov atom قبل از mdat است؟ (برای streaming مهم) */
  mightBeStreamable: boolean;
  /** اندازه فایل */
  sizeBytes: number;
  /** MIME type از blob */
  mimeType: string;
}

export async function analyzeVideoBlob(blob: Blob): Promise<BlobAnalysis> {
  const mimeType = blob.type?.toLowerCase() ?? '';
  const sizeBytes = blob.size;

  try {
    const header = await blob.slice(0, 12).arrayBuffer();
    const bytes = new Uint8Array(header);

    const isMp4 = bytes[4] === 0x66 && bytes[5] === 0x74 &&
                  bytes[6] === 0x79 && bytes[7] === 0x70;

    const isWebm = bytes[0] === 0x1A && bytes[1] === 0x45 &&
                   bytes[2] === 0xDF && bytes[3] === 0xA3;

    const looksLikeValidVideo = isMp4 || isWebm || mimeType.startsWith('video/');

    let mightBeStreamable = isWebm;
    if (isMp4 && sizeBytes > 100) {
      try {
        const first512 = await blob.slice(0, Math.min(512, sizeBytes)).arrayBuffer();
        const bytes512 = new Uint8Array(first512);

        for (let i = 0; i < bytes512.length - 4; i++) {
          if (bytes512[i] === 0x6D && bytes512[i+1] === 0x6F &&
              bytes512[i+2] === 0x6F && bytes512[i+3] === 0x76) {
            mightBeStreamable = true;
            break;
          }
          if (bytes512[i] === 0x6D && bytes512[i+1] === 0x64 &&
              bytes512[i+2] === 0x61 && bytes512[i+3] === 0x74) {
            mightBeStreamable = false;
            break;
          }
        }
      } catch { mightBeStreamable = true; }
    }

    return { looksLikeValidVideo, mightBeStreamable, sizeBytes, mimeType };
  } catch {
    return {
      looksLikeValidVideo: mimeType.startsWith('video/'),
      mightBeStreamable: true,
      sizeBytes,
      mimeType,
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────

export function extractDownloadUrl(source: any): string | undefined {
  if (!source || typeof source !== 'object') return undefined;

  const candidates = [
    source.downloads?.default?.url,
    source.downloads?.default?.downloadUrl,
    source.downloads?.default?.download_url,
    source.downloads?.default?.link,
    source.downloads?.url,
    source.downloads?.downloadUrl,
    source.default?.url,
    source.default?.downloadUrl,
    source.default?.download_url,
    source.url,
    source.downloadUrl,
    source.download_url,
    source.link,
  ];

  return candidates.find((value) => typeof value === 'string' && /^https:\/\//.test(value));
}

function extractDownloadState(source: any): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const candidates = [
    source.downloads?.default?.status,
    source.downloads?.default?.state,
    source.default?.status,
    source.default?.state,
    source.status,
    source.state,
  ];
  return candidates.find((value) => typeof value === 'string');
}

async function readJsonSafe(res: Response): Promise<any> {
  try { return await res.json(); } catch { return null; }
}

function extractApiError(payload: any): string {
  if (!payload) return 'no response body';
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    return payload.errors.map((e: any) => e?.message ?? String(e)).join('; ');
  }
  if (typeof payload.error === 'string') return payload.error;
  if (typeof payload.message === 'string') return payload.message;
  return JSON.stringify(payload).slice(0, 300);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
