// ══════════════════════════════════════════════════════════════
// services/media-resolver.ts
// تعیین روش ارسال media به Telegram + ساخت payload
// ══════════════════════════════════════════════════════════════

import type { MediaItem, MediaResolution } from '../types';

const MAX_VIDEO_MB   = 50;
const MAX_VIDEO_SEC  = 300;
const MAX_ALBUM_SIZE = 10;

// ── Resolve method from item.media ───────────────────────────

export function resolveMedia(
  media: MediaItem[],
  mediaMode: 'preferred' | 'optional' | 'disabled'
): MediaResolution {
  if (mediaMode === 'disabled' || media.length === 0) {
    return { method: 'sendMessage', mediaUrls: [], useShortCaption: false };
  }

  const valid = media.filter(m => m.url?.startsWith('http'));

  if (valid.length === 0) {
    return { method: 'sendMessageWithLink', mediaUrls: [], useShortCaption: false };
  }

  if (valid.length === 1) {
    const item = valid[0]!;
    if (item.type === 'video') {
      if ((item.sizeMb ?? 0) > MAX_VIDEO_MB || (item.durationSec ?? 0) > MAX_VIDEO_SEC) {
        return { method: 'sendMessageWithLink', mediaUrls: [], useShortCaption: false };
      }
      return { method: 'sendVideo', mediaUrls: [item.url], useShortCaption: true };
    }
    return { method: 'sendPhoto', mediaUrls: [item.url], useShortCaption: true };
  }

  const capped = valid.slice(0, MAX_ALBUM_SIZE);
  return {
    method: 'sendMediaGroup',
    mediaUrls: capped.map(m => m.url),
    useShortCaption: true,
  };
}

// ── Extract media types array (parallel to mediaUrls) ─────────

export function extractMediaTypes(
  media: MediaItem[],
  mediaMode: 'preferred' | 'optional' | 'disabled'
): Array<'image' | 'video'> {
  if (mediaMode === 'disabled') return [];
  return media
    .filter(m => m.url?.startsWith('http'))
    .slice(0, MAX_ALBUM_SIZE)
    .map(m => m.type === 'video' ? 'video' : 'image');
}

// ── Build Telegram sendMediaGroup payload ─────────────────────
// mediaTypes: ["image","video",...] — parallel به mediaUrls

export function buildMediaGroupPayload(
  mediaUrls: string[],
  mediaTypes: Array<'image' | 'video'>,
  captionShort: string
): object[] {
  return mediaUrls.map((url, i) => {
    const type = mediaTypes[i] ?? detectMediaType(url);
    const entry: any = {
      type: type === 'video' ? 'video' : 'photo',
      media: url,
    };
    if (i === 0) {
      entry.caption = captionShort.slice(0, 1024);
      entry.parse_mode = 'HTML';
    }
    return entry;
  });
}

// ── Detect media type from URL ────────────────────────────────

export function detectMediaType(url: string): 'image' | 'video' {
  const path = url.toLowerCase().split('?')[0] ?? '';
  const videoExts = ['.mp4', '.mov', '.webm', '.avi', '.mkv', '.m4v'];
  return videoExts.some(ext => path.endsWith(ext)) ? 'video' : 'image';
}
