// ══════════════════════════════════════════════════════════════
// services/media-resolver.ts — v3
// تعیین روش ارسال media به Telegram
// ══════════════════════════════════════════════════════════════

import type { MediaItem, MediaResolution } from '../types';

const MAX_VIDEO_MB   = 50;
const MAX_VIDEO_SEC  = 300;
const MAX_ALBUM_SIZE = 10;

export function resolveMedia(
  media: MediaItem[],
  mediaMode: 'preferred' | 'optional' | 'disabled'
): MediaResolution {
  if (mediaMode === 'disabled' || media.length === 0) {
    return { method: 'sendMessage', mediaUrls: [], thumbnailUrls: [], useShortCaption: false };
  }

  const valid = media.filter(m => m.url?.startsWith('http'));
  if (valid.length === 0) {
    return { method: 'sendMessage', mediaUrls: [], thumbnailUrls: [], useShortCaption: false };
  }

  if (valid.length === 1) {
    const item = valid[0]!;
    if (item.type === 'video') {
      if (isVideoDefinitelyRejected(item)) {
        return { method: 'sendMessage', mediaUrls: [], thumbnailUrls: [], useShortCaption: false };
      }
      return {
        method: 'sendVideo',
        mediaUrls: [item.url],
        thumbnailUrls: [item.thumbnailUrl ?? ''],
        useShortCaption: true,
      };
    }
    return {
      method: 'sendPhoto',
      mediaUrls: [item.url],
      thumbnailUrls: [''],
      useShortCaption: true,
    };
  }

  // Multi-media — فیلتر ویدئوهای مطمئناً reject‌شده
  const filtered = valid.filter(m => m.type !== 'video' || !isVideoDefinitelyRejected(m));
  if (filtered.length === 0) {
    return { method: 'sendMessage', mediaUrls: [], thumbnailUrls: [], useShortCaption: false };
  }
  if (filtered.length === 1) {
    const item = filtered[0]!;
    if (item.type === 'video') {
      return {
        method: 'sendVideo',
        mediaUrls: [item.url],
        thumbnailUrls: [item.thumbnailUrl ?? ''],
        useShortCaption: true,
      };
    }
    return {
      method: 'sendPhoto',
      mediaUrls: [item.url],
      thumbnailUrls: [''],
      useShortCaption: true,
    };
  }

  const capped = filtered.slice(0, MAX_ALBUM_SIZE);
  return {
    method: 'sendMediaGroup',
    mediaUrls: capped.map(m => m.url),
    thumbnailUrls: capped.map(m => m.thumbnailUrl ?? ''),
    useShortCaption: true,
  };
}

export function extractMediaTypes(
  media: MediaItem[],
  mediaMode: 'preferred' | 'optional' | 'disabled'
): Array<'image' | 'video'> {
  if (mediaMode === 'disabled') return [];
  return media
    .filter(m => m.url?.startsWith('http'))
    .filter(m => m.type !== 'video' || !isVideoDefinitelyRejected(m))
    .slice(0, MAX_ALBUM_SIZE)
    .map(m => m.type === 'video' ? 'video' : 'image');
}

export function buildMediaGroupPayload(
  mediaUrls: string[],
  mediaTypes: Array<'image' | 'video'>,
  captionShort: string
): object[] {
  const safeCaption = sanitizeCaptionText(captionShort).slice(0, 1024);
  return mediaUrls.map((url, i) => {
    const type = mediaTypes[i] ?? detectMediaType(url);
    const entry: any = {
      type: type === 'video' ? 'video' : 'photo',
      media: url,
      ...(type === 'video' ? { supports_streaming: true } : {}),
    };
    if (i === 0) {
      entry.caption = safeCaption;
      entry.parse_mode = 'HTML';
    }
    return entry;
  });
}

export function detectMediaType(url: string): 'image' | 'video' {
  const path = url.toLowerCase().split('?')[0] ?? '';
  const videoExts = ['.mp4', '.mov', '.webm', '.avi', '.mkv', '.m4v', '.3gp'];
  return videoExts.some(ext => path.endsWith(ext)) ? 'video' : 'image';
}

/** reject فقط اگر مطمئناً بیش از حد بزرگ یا طولانی باشد */
export function isVideoDefinitelyRejected(item: MediaItem): boolean {
  if (item.sizeMb !== undefined && item.sizeMb > MAX_VIDEO_MB) return true;
  if (item.durationSec !== undefined && item.durationSec > MAX_VIDEO_SEC) return true;
  return false;
}

export function sanitizeCaptionText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function safeTruncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  let truncated = text.slice(0, maxLen - 1);
  const lastAmp = truncated.lastIndexOf('&');
  if (lastAmp >= 0 && !truncated.slice(lastAmp).includes(';')) {
    truncated = truncated.slice(0, lastAmp);
  }
  return truncated.trimEnd() + '…';
}
