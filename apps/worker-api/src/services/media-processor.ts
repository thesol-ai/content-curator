// ══════════════════════════════════════════════════════════════
// services/media-processor.ts
// قلب سیستم مدیا — دانلود، اعتبارسنجی، و آپلود binary به Telegram
//
// سه حالت عملکرد (MEDIA_PROCESSING_MODE):
//   direct_url    → URL مستقیم (سریع، ریسک expiry)
//   binary_upload → دانلود + multipart upload (توصیه می‌شود)
//   r2_storage    → دانلود → R2 → URL پایدار (بهترین)
//
// مشکل اصلی که این فایل حل می‌کند:
//   - CDN URLs اینستاگرام/لینکدین expire می‌شوند
//   - Telegram گاهی نمی‌تواند URL های خارجی را fetch کند
//   - ویدئو بدون thumbnail ضعیف است
//   - یک مدیای خراب کل album را fail می‌کند
// ══════════════════════════════════════════════════════════════

import type { Env, ProcessedMedia, MediaProcessingStatus, ThumbnailStatus } from '../types';

// ── Constants ─────────────────────────────────────────────────

const DEFAULT_MAX_DOWNLOAD_MB = 50;
const DEFAULT_DOWNLOAD_TIMEOUT = 60;
const TELEGRAM_THUMBNAIL_MAX_BYTES = 200 * 1024; // Telegram Bot API: JPEG thumbnail < 200KB
const TELEGRAM_THUMBNAIL_MAX_DIMENSION = 320;

// Content-Type های معتبر برای Telegram
const VALID_IMAGE_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif',
  'image/webp', 'image/bmp',
]);
const VALID_VIDEO_TYPES = new Set([
  'video/mp4', 'video/mpeg', 'video/quicktime',
  'video/x-msvideo', 'video/webm', 'video/3gpp',
]);

// ── Public API ────────────────────────────────────────────────

export type ProcessingMode = 'direct_url' | 'binary_upload' | 'r2_storage';

export function getProcessingMode(env: Env): ProcessingMode {
  const mode = env.MEDIA_PROCESSING_MODE?.toLowerCase();
  if (mode === 'binary_upload') return 'binary_upload';
  if (mode === 'r2_storage') return 'r2_storage';
  return 'direct_url';
}

/**
 * پردازش یک media item
 * بر اساس mode، blob دانلود می‌کند یا URL را برمی‌گرداند
 */
export async function processMediaItem(
  env: Env,
  mediaUrl: string,
  mediaType: 'image' | 'video',
  thumbnailUrl?: string,
  existingFileId?: string
): Promise<ProcessedMedia> {
  const mode = getProcessingMode(env);

  // اگر telegram_file_id موجود است، نیازی به دانلود نیست
  if (existingFileId) {
    return {
      telegramFileId: existingFileId,
      mimeType: mediaType === 'video' ? 'video/mp4' : 'image/jpeg',
      sizeBytes: 0,
      ok: true,
      status: 'uploaded',
    };
  }

  if (mode === 'direct_url') {
    // فقط URL را اعتبارسنجی می‌کنیم (HEAD request)
    const valid = await validateUrlHead(mediaUrl, mediaType, env);
    return {
      stableUrl: mediaUrl,
      mimeType: valid.mimeType ?? (mediaType === 'video' ? 'video/mp4' : 'image/jpeg'),
      sizeBytes: valid.sizeBytes ?? 0,
      ok: valid.ok,
      error: valid.error,
      status: valid.ok ? 'ready' : 'failed',
    };
  }

  // binary_upload یا r2_storage — باید دانلود کنیم
  const maxMb = parseInt(env.MEDIA_MAX_DOWNLOAD_MB || String(DEFAULT_MAX_DOWNLOAD_MB), 10);
  const timeoutSec = parseInt(env.MEDIA_DOWNLOAD_TIMEOUT_SEC || String(DEFAULT_DOWNLOAD_TIMEOUT), 10);

  const downloaded = await downloadMedia(mediaUrl, maxMb, timeoutSec);
  if (!downloaded.ok || !downloaded.blob) {
    return {
      mimeType: 'application/octet-stream',
      sizeBytes: 0,
      ok: false,
      error: downloaded.error,
      status: downloaded.status,
    };
  }

  // اعتبارسنجی MIME type
  const mimeType = downloaded.mimeType ?? '';
  const isImageMime = VALID_IMAGE_TYPES.has(mimeType) || mimeType.startsWith('image/');
  const isVideoMime = VALID_VIDEO_TYPES.has(mimeType) || mimeType.startsWith('video/');

  if (mediaType === 'image' && !isImageMime) {
    console.warn(`[MediaProcessor] Unexpected MIME for image: ${mimeType} — ${mediaUrl.slice(0, 60)}`);
  }
  if (mediaType === 'video' && !isVideoMime) {
    console.warn(`[MediaProcessor] Unexpected MIME for video: ${mimeType} — ${mediaUrl.slice(0, 60)}`);
  }

  const result: ProcessedMedia = {
    blob: downloaded.blob,
    mimeType: downloaded.mimeType ?? (mediaType === 'video' ? 'video/mp4' : 'image/jpeg'),
    sizeBytes: downloaded.blob.size,
    ok: true,
    status: 'ready',
  };

  // دانلود و validate thumbnail فقط برای video و فقط برای multipart upload.
  // Telegram thumbnail باید JPEG، کمتر از 200KB و حداکثر 320x320 باشد.
  if (mediaType === 'video') {
    if (thumbnailUrl) {
      const thumb = await downloadTelegramThumbnail(thumbnailUrl);
      result.thumbnailStatus = thumb.validation.status;
      if (thumb.validation.error) result.thumbnailError = thumb.validation.error;
      if (thumb.blob) result.thumbnailBlob = thumb.blob;
    } else {
      result.thumbnailStatus = 'missing';
      result.thumbnailError = 'thumbnail_url_missing';
    }
  }

  // اگر mode=r2_storage، در R2 ذخیره کن
  if (mode === 'r2_storage' && env.MEDIA_BUCKET) {
    const stored = await storeInR2(env, downloaded.blob, downloaded.mimeType ?? 'application/octet-stream');
    if (stored.ok && stored.url) {
      result.blob = undefined; // blob را دیگر نگه نمی‌داریم
      result.stableUrl = stored.url;
    }
  }

  return result;
}

/**
 * پردازش batch از media items برای یک پست
 * ترتیب را حفظ می‌کند و خطاها را per-item ثبت می‌کند
 */
export async function processMediaBatch(
  env: Env,
  items: Array<{
    url: string;
    type: 'image' | 'video';
    thumbnailUrl?: string;
    telegramFileId?: string;
  }>
): Promise<ProcessedMedia[]> {
  const results: ProcessedMedia[] = [];

  for (const item of items) {
    try {
      const result = await processMediaItem(
        env,
        item.url,
        item.type,
        item.thumbnailUrl,
        item.telegramFileId
      );
      results.push(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[MediaProcessor] Error processing ${item.url.slice(0, 60)}: ${msg}`);
      results.push({
        mimeType: 'application/octet-stream',
        sizeBytes: 0,
        ok: false,
        error: `unexpected: ${msg.slice(0, 200)}`,
        status: 'failed',
      });
    }
  }

  return results;
}

// ── Download helpers ──────────────────────────────────────────

interface DownloadResult {
  ok: boolean;
  blob?: Blob;
  mimeType?: string;
  error?: string;
  status: MediaProcessingStatus;
}

async function downloadMedia(
  url: string,
  maxMb: number,
  timeoutSec: number
): Promise<DownloadResult> {
  const maxBytes = maxMb * 1024 * 1024;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': 'TelegramBot/1.0 (compatible; content-curator)',
        'Accept': 'image/*, video/*, */*',
      },
      signal: AbortSignal.timeout(timeoutSec * 1000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.includes('timeout') || msg.includes('TimeoutError');
    return {
      ok: false,
      error: `fetch_error: ${msg.slice(0, 200)}`,
      status: isTimeout ? 'failed' : 'failed',
    };
  }

  if (!res.ok) {
    if (res.status === 403 || res.status === 401) {
      return { ok: false, error: `auth_required: HTTP ${res.status}`, status: 'expired' };
    }
    if (res.status === 404 || res.status === 410) {
      return { ok: false, error: `not_found: HTTP ${res.status}`, status: 'expired' };
    }
    return { ok: false, error: `http_error: ${res.status}`, status: 'failed' };
  }

  // بررسی Content-Length قبل از دانلود
  const contentLength = parseInt(res.headers.get('content-length') ?? '0', 10);
  if (contentLength > maxBytes) {
    return {
      ok: false,
      error: `too_large: ${Math.round(contentLength / 1024 / 1024)}MB > ${maxMb}MB`,
      status: 'too_large',
    };
  }

  const mimeType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';

  let blob: Blob;
  try {
    blob = await res.blob();
  } catch (err) {
    return { ok: false, error: 'blob_read_error', status: 'failed' };
  }

  if (blob.size > maxBytes) {
    return {
      ok: false,
      error: `too_large: ${Math.round(blob.size / 1024 / 1024)}MB > ${maxMb}MB`,
      status: 'too_large',
    };
  }

  if (blob.size === 0) {
    return { ok: false, error: 'empty_response', status: 'failed' };
  }

  return { ok: true, blob, mimeType: mimeType || blob.type, status: 'ready' };
}

export interface ThumbnailValidationResult {
  ok: boolean;
  status: ThumbnailStatus;
  error?: string;
  width?: number;
  height?: number;
  mimeType?: string;
}

export interface ThumbnailDownloadResult {
  blob?: Blob;
  validation: ThumbnailValidationResult;
}

export async function downloadTelegramThumbnail(url: string): Promise<ThumbnailDownloadResult> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'TelegramBot/1.0 (compatible; content-curator)' },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return {
        validation: {
          ok: false,
          status: 'download_failed',
          error: `thumbnail_http_${res.status}`,
        },
      };
    }

    const mimeType = (res.headers.get('content-type') ?? '').split(';')[0]?.toLowerCase() ?? '';
    const blob = await res.blob();
    const validation = await validateTelegramThumbnailBlob(blob, mimeType);

    if (!validation.ok) {
      console.warn(`[MediaProcessor] Invalid video thumbnail skipped: ${validation.error ?? validation.status}`);
      return { validation };
    }

    return { blob, validation };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      validation: {
        ok: false,
        status: 'download_failed',
        error: `thumbnail_fetch_error: ${msg.slice(0, 160)}`,
      },
    };
  }
}

export async function validateTelegramThumbnailBlob(
  blob: Blob,
  declaredMimeType?: string
): Promise<ThumbnailValidationResult> {
  if (blob.size === 0) {
    return { ok: false, status: 'invalid_image', error: 'thumbnail_empty' };
  }

  if (blob.size > TELEGRAM_THUMBNAIL_MAX_BYTES) {
    return {
      ok: false,
      status: 'too_large',
      error: `thumbnail_too_large: ${blob.size} > ${TELEGRAM_THUMBNAIL_MAX_BYTES}`,
    };
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const mimeType = (declaredMimeType || blob.type || '').toLowerCase();
  const hasJpegMagic = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const declaresJpeg = mimeType === 'image/jpeg' || mimeType === 'image/jpg';

  if (!hasJpegMagic || (mimeType && !declaresJpeg)) {
    return {
      ok: false,
      status: 'unsupported_format',
      error: `thumbnail_must_be_jpeg: ${mimeType || 'unknown'}`,
      mimeType,
    };
  }

  const dimensions = readJpegDimensions(bytes);
  if (!dimensions) {
    return {
      ok: false,
      status: 'invalid_image',
      error: 'thumbnail_jpeg_dimensions_unreadable',
      mimeType: 'image/jpeg',
    };
  }

  if (dimensions.width > TELEGRAM_THUMBNAIL_MAX_DIMENSION || dimensions.height > TELEGRAM_THUMBNAIL_MAX_DIMENSION) {
    return {
      ok: false,
      status: 'invalid_dimensions',
      error: `thumbnail_dimensions_too_large: ${dimensions.width}x${dimensions.height} > ${TELEGRAM_THUMBNAIL_MAX_DIMENSION}x${TELEGRAM_THUMBNAIL_MAX_DIMENSION}`,
      width: dimensions.width,
      height: dimensions.height,
      mimeType: 'image/jpeg',
    };
  }

  return {
    ok: true,
    status: 'valid',
    width: dimensions.width,
    height: dimensions.height,
    mimeType: 'image/jpeg',
  };
}

function readJpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;

  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }

    let marker = bytes[offset + 1] ?? 0;
    while (marker === 0xff && offset + 2 < bytes.length) {
      offset++;
      marker = bytes[offset + 1] ?? 0;
    }

    // Standalone markers without segment length.
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }

    if (offset + 4 >= bytes.length) return undefined;
    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
    if (length < 2 || offset + 2 + length > bytes.length) return undefined;

    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isSof) {
      if (length < 7) return undefined;
      const height = ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0);
      const width = ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0);
      if (!width || !height) return undefined;
      return { width, height };
    }

    offset += 2 + length;
  }

  return undefined;
}

// ── URL validation (HEAD request) ─────────────────────────────

interface HeadResult {
  ok: boolean;
  mimeType?: string;
  sizeBytes?: number;
  error?: string;
}

async function validateUrlHead(
  url: string,
  _mediaType: 'image' | 'video',
  _env: Env
): Promise<HeadResult> {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': 'TelegramBot/1.0 (compatible; content-curator)' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return { ok: false, error: `HEAD ${res.status}` };
    }

    const mimeType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim();
    const contentLength = parseInt(res.headers.get('content-length') ?? '0', 10);

    return {
      ok: true,
      mimeType,
      sizeBytes: contentLength || undefined,
    };
  } catch (err) {
    // HEAD ممکن است توسط بعضی CDN ها block شود — عدم موفقیت به معنای invalid نیست
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[MediaProcessor] HEAD validation failed (non-fatal): ${msg.slice(0, 100)}`);
    return { ok: true, mimeType: undefined }; // مشکوک اما به Telegram اجازه می‌دهیم امتحان کند
  }
}

// ── R2 Storage ────────────────────────────────────────────────

interface R2StoreResult {
  ok: boolean;
  url?: string;
  key?: string;
  error?: string;
}

async function storeInR2(
  env: Env,
  blob: Blob,
  mimeType: string
): Promise<R2StoreResult> {
  if (!env.MEDIA_BUCKET) {
    return { ok: false, error: 'R2 bucket not configured' };
  }

  try {
    const ext = mimeTypeToExtension(mimeType);
    const key = `media/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

    await env.MEDIA_BUCKET.put(key, blob, {
      httpMetadata: { contentType: mimeType },
    });

    const baseUrl = env.R2_PUBLIC_BASE_URL?.replace(/\/$/, '') ?? '';
    const url = baseUrl ? `${baseUrl}/${key}` : key;

    return { ok: true, url, key };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `r2_error: ${msg.slice(0, 200)}` };
  }
}

// ── Telegram Binary Upload ────────────────────────────────────
// این توابع از telegram-publisher.ts استفاده می‌شوند

/**
 * ساخت FormData برای آپلود binary یک photo به Telegram
 */
export function buildPhotoForm(
  chatId: string,
  blob: Blob,
  caption: string
): FormData {
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  form.append('photo', blob, 'photo.jpg');
  return form;
}

/**
 * ساخت FormData برای آپلود binary یک video به Telegram
 * شامل thumbnail اگر موجود باشد
 */
export function buildVideoForm(
  chatId: string,
  videoBlob: Blob,
  caption: string,
  thumbnailBlob?: Blob,
  supportsStreaming = true
): FormData {
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  form.append('supports_streaming', supportsStreaming ? 'true' : 'false');
  form.append('video', videoBlob, detectVideoFilename(videoBlob));

  if (thumbnailBlob) {
    form.append('thumbnail', thumbnailBlob, 'thumbnail.jpg');
  }

  return form;
}

/**
 * ساخت FormData برای sendMediaGroup با binary files
 * هر فایل به صورت attach://fieldN ارجاع داده می‌شود
 */
export function buildMediaGroupForm(
  chatId: string,
  items: Array<{
    blob?: Blob;
    stableUrl?: string;
    telegramFileId?: string;
    type: 'image' | 'video';
    thumbnailBlob?: Blob;
  }>,
  captionShort: string
): { form: FormData; mediaJson: string } {
  const form = new FormData();
  form.append('chat_id', chatId);

  const mediaJson = items.map((item, i) => {
    const entry: Record<string, any> = {
      type: item.type === 'video' ? 'video' : 'photo',
    };

    if (item.telegramFileId) {
      // از file_id cached استفاده کن
      entry.media = item.telegramFileId;
    } else if (item.blob) {
      // binary upload با attach:// reference
      const fieldName = `file${i}`;
      const filename = item.type === 'video'
        ? detectVideoFilename(item.blob)
        : `photo${i}.jpg`;
      form.append(fieldName, item.blob, filename);
      entry.media = `attach://${fieldName}`;
    } else if (item.stableUrl) {
      // URL پایدار (از R2 یا URL مستقیم)
      entry.media = item.stableUrl;
    }

    if (item.type === 'video') {
      entry.supports_streaming = true;
      if (item.thumbnailBlob) {
        const thumbField = `thumb${i}`;
        form.append(thumbField, item.thumbnailBlob, `thumb${i}.jpg`);
        entry.thumbnail = `attach://${thumbField}`;
      }
    }

    // فقط اولین آیتم caption دارد
    if (i === 0) {
      entry.caption = captionShort.slice(0, 1024);
      entry.parse_mode = 'HTML';
    }

    return entry;
  });

  form.append('media', JSON.stringify(mediaJson));
  return { form, mediaJson: JSON.stringify(mediaJson) };
}

// ── Helpers ───────────────────────────────────────────────────

function mimeTypeToExtension(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/gif': 'gif', 'image/webp': 'webp',
    'video/mp4': 'mp4', 'video/mpeg': 'mpg', 'video/quicktime': 'mov',
    'video/webm': 'webm', 'video/3gpp': '3gp',
  };
  return map[mime] ?? mime.split('/')[1] ?? 'bin';
}

function detectVideoFilename(blob: Blob): string {
  const type = blob.type?.toLowerCase() ?? '';
  if (type.includes('mp4')) return 'video.mp4';
  if (type.includes('quicktime') || type.includes('mov')) return 'video.mov';
  if (type.includes('webm')) return 'video.webm';
  return 'video.mp4'; // پیش‌فرض — Telegram ترجیح می‌دهد
}
