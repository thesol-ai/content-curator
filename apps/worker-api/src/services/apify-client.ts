// ══════════════════════════════════════════════════════════════
// services/apify-client.ts
// Fetch + Normalize برای سه Actor:
//   - kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest
//   - apify/instagram-post-scraper
//   - harvestapi/linkedin-profile-posts
//
// مشکل کلیدی: CDN URLهای Instagram و LinkedIn expire می‌شوند.
// بنابراین priority برای این پلتفرم‌ها باید high باشد
// تا publish سریع اتفاق بیفتد.
// ══════════════════════════════════════════════════════════════

import type { NormalizedItem, MediaItem, Platform } from '../types';

const APIFY_API_BASE = 'https://api.apify.com/v2';
const FETCH_TIMEOUT_MS = 20_000;

// ── Fetch dataset from Apify ──────────────────────────────────

export async function fetchApifyDataset(
  datasetId: string,
  apifyToken: string,
  limit: number
): Promise<any[]> {
  const url =
    `${APIFY_API_BASE}/datasets/${datasetId}/items` +
    `?token=${apifyToken}&clean=true&limit=${limit}`;

  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Apify fetch failed ${res.status}: ${res.statusText}`);
  }

  const data = await res.json() as any;
  return Array.isArray(data) ? data : [];
}

// ── Normalize dispatcher ──────────────────────────────────────

export function normalizeItem(raw: any, platform: Platform): NormalizedItem | null {
  switch (platform) {
    case 'x':         return normalizeTwitterItem(raw);
    case 'instagram': return normalizeInstagramItem(raw);
    case 'linkedin':  return normalizeLinkedInItem(raw);
    case 'rss':       return normalizeRssItem(raw);
    default:          return null;
  }
}

// ══════════════════════════════════════════════════════════════
// Twitter / X — kaitoeasyapi Actor
// فیلدهای کلیدی:
//   url / twitterUrl — URL پست
//   text / full_text — متن
//   author.userName / user.screen_name — handle
//   createdAt / created_at / date — زمان
//   likeCount / favorite_count, retweetCount, viewCount
//   media[] — آرایه با {media_url_https, type, url}
//   extendedEntities.media[] — آلترناتیو برای media
// توجه: Twitter video URLs معمولاً ثابت هستند اما
//   بعضی tweet image CDN URLs ممکن است expire شوند.
// ══════════════════════════════════════════════════════════════

function normalizeTwitterItem(raw: any): NormalizedItem | null {
  const url = raw.url ?? raw.twitterUrl ?? raw.tweet_url;
  if (!url) return null;

  const postId = raw.id ?? raw.tweet_id ?? raw.id_str ?? extractLastPathSegment(url);
  if (!postId) return null;

  const publishedAt = parseTimestamp(raw.createdAt ?? raw.created_at ?? raw.date);

  return {
    platform:       'x',
    sourceAccount:  raw.author?.userName ?? raw.user?.screen_name ?? raw.authorUsername ?? '',
    sourceUrl:      url,
    postId,
    publishedAt,
    text:           cleanText(raw.text ?? raw.full_text ?? raw.content ?? ''),
    media:          extractTwitterMedia(raw),
    engagementLikes:  safeInt(raw.likeCount    ?? raw.favorite_count   ?? 0),
    engagementShares: safeInt(raw.retweetCount ?? raw.retweet_count    ?? 0),
    engagementViews:  safeInt(raw.viewCount    ?? raw.views?.count      ?? 0),
    // Twitter URLs معمولاً expire نمی‌شوند
    mediaUrlExpiresSoon: false,
  };
}

function extractTwitterMedia(raw: any): MediaItem[] {
  // Kaito Actor: media[] یا extendedEntities.media[]
  const candidates: any[] =
    raw.media ??
    raw.extendedEntities?.media ??
    raw.entities?.media ??
    [];

  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  return candidates
    .filter((m: any) => m.media_url_https ?? m.media_url ?? m.url)
    .map((m: any): MediaItem => ({
      type: (m.type === 'video' || m.type === 'animated_gif') ? 'video' : 'image',
      url:  m.media_url_https ?? m.media_url ?? m.url,
    }))
    .slice(0, 10);
}

// ══════════════════════════════════════════════════════════════
// Instagram — apify/instagram-post-scraper
// فیلدهای کلیدی:
//   url — URL پست
//   shortCode / id — پست ID
//   displayUrl — URL عکس اصلی (CDN، EXPIRE می‌شود!)
//   videoUrl — برای Reel/video (CDN، EXPIRE می‌شود!)
//   childPosts[] — carousel items، هر کدام displayUrl دارند
//   images[] — آلترناتیو برای carousel در بعضی نسخه‌ها
//   caption — متن
//   ownerUsername — handle
//   timestamp — زمان ISO
//   likesCount, videoViewCount
//
// ⚠️  CDN URLهای Instagram (scontent.cdninstagram.com)
//    ظرف چند ساعت تا ۱–۲ روز expire می‌شوند.
//    بنابراین: mediaUrlExpiresSoon = true
//    و در orchestrator باید priority=high داده شود
//    تا سریع‌تر publish شود.
// ══════════════════════════════════════════════════════════════

function normalizeInstagramItem(raw: any): NormalizedItem | null {
  const url = raw.url ?? raw.postUrl ?? raw.link;
  if (!url) return null;

  const postId = raw.shortCode ?? raw.shortcode ?? raw.id ?? extractLastPathSegment(url);
  const publishedAt = parseTimestamp(raw.timestamp ?? raw.takenAt ?? raw.date);

  const media: MediaItem[] = [];

  // ── Carousel: childPosts ──
  if (Array.isArray(raw.childPosts) && raw.childPosts.length > 0) {
    for (const child of raw.childPosts.slice(0, 10)) {
      const childUrl = child.videoUrl ?? child.displayUrl;
      if (childUrl) {
        media.push({
          type:   child.videoUrl ? 'video' : 'image',
          url:    childUrl,
          width:  child.dimensions?.width,
          height: child.dimensions?.height,
        });
      }
    }
  }

  // ── Carousel alt: images[] ──
  if (media.length === 0 && Array.isArray(raw.images) && raw.images.length > 0) {
    for (const imgUrl of raw.images.slice(0, 10)) {
      if (typeof imgUrl === 'string' && imgUrl.startsWith('http')) {
        media.push({ type: 'image', url: imgUrl });
      }
    }
  }

  // ── Single image/video ──
  if (media.length === 0) {
    const singleUrl = raw.videoUrl ?? raw.displayUrl;
    if (singleUrl) {
      media.push({
        type:   raw.videoUrl ? 'video' : 'image',
        url:    singleUrl,
        width:  raw.dimensions?.width,
        height: raw.dimensions?.height,
      });
    }
  }

  return {
    platform:       'instagram',
    sourceAccount:  raw.ownerUsername ?? raw.username ?? '',
    sourceUrl:      url,
    postId:         postId ?? url,
    publishedAt,
    text:           cleanText(raw.caption ?? raw.text ?? ''),
    media:          media.slice(0, 10),
    engagementLikes:  safeInt(raw.likesCount     ?? raw.likes         ?? 0),
    engagementShares: 0,
    engagementViews:  safeInt(raw.videoViewCount ?? raw.videoViews    ?? 0),
    // ⚠️ Instagram CDN URLs expire می‌شوند — باید سریع publish شود
    mediaUrlExpiresSoon: media.length > 0,
  };
}

// ══════════════════════════════════════════════════════════════
// LinkedIn — harvestapi/linkedin-profile-posts
// فیلدهای کلیدی:
//   linkedinUrl — URL پست (ثابت)
//   content / text — متن
//   author.linkedinUrl / author.publicIdentifier — handle
//   postedAt.timestamp — زمان (milliseconds)
//   postImages[] — [{url, width, height, expiresAt}] (EXPIRE می‌شود!)
//   postVideo — {thumbnailUrl, videoUrl} (EXPIRE می‌شود!)
//   document — {title, transcribedDocumentUrl, coverPages[{imageUrls[]}]}
//   engagement — {likes, comments, shares}
//
// ⚠️  LinkedIn media URLs دارای expiresAt هستند.
//    معمولاً ۲۴–۴۸ ساعت valid هستند.
//    بنابراین: mediaUrlExpiresSoon = true
// ══════════════════════════════════════════════════════════════

function normalizeLinkedInItem(raw: any): NormalizedItem | null {
  const url = raw.linkedinUrl ?? raw.url ?? raw.shareUrl ?? raw.socialContent?.shareUrl;
  if (!url) return null;

  const publishedAt = raw.postedAt?.timestamp
    ? Math.floor(raw.postedAt.timestamp / 1000) // ms → sec
    : parseTimestamp(raw.postedAt?.date ?? raw.date);

  const media: MediaItem[] = [];

  // ── Images ──
  if (Array.isArray(raw.postImages) && raw.postImages.length > 0) {
    for (const img of raw.postImages.slice(0, 10)) {
      const imgUrl = typeof img === 'string' ? img : img.url;
      if (imgUrl && imgUrl.startsWith('http')) {
        media.push({
          type:   'image',
          url:    imgUrl,
          width:  img.width,
          height: img.height,
        });
      }
    }
  }

  // ── Video ──
  if (media.length === 0 && raw.postVideo?.videoUrl) {
    media.push({
      type: 'video',
      url:  raw.postVideo.videoUrl,
    });
  }

  // ── Document carousel cover pages (اگر نه image و نه video داشت) ──
  if (media.length === 0 && raw.document?.coverPages?.length > 0) {
    for (const page of raw.document.coverPages.slice(0, 3)) {
      const imgUrl = page.imageUrls?.[0];
      if (imgUrl) {
        media.push({ type: 'image', url: imgUrl, width: page.width, height: page.height });
      }
    }
  }

  // author handle
  const authorHandle =
    raw.author?.publicIdentifier ??
    raw.author?.universalName ??
    raw.author?.linkedinUrl?.split('/in/')?.[1]?.split('?')[0] ??
    '';

  return {
    platform:       'linkedin',
    sourceAccount:  authorHandle,
    sourceUrl:      url,
    postId:         raw.id ?? raw.urn ?? url,
    publishedAt,
    text:           cleanText(raw.content ?? raw.text ?? raw.commentary ?? ''),
    media:          media.slice(0, 10),
    engagementLikes:  safeInt(raw.engagement?.likes      ?? raw.totalReactionCount ?? 0),
    engagementShares: safeInt(raw.engagement?.shares     ?? raw.repostsCount       ?? 0),
    engagementViews:  safeInt(raw.engagement?.impressions ?? raw.impressionsCount   ?? 0),
    // ⚠️ LinkedIn media URLs expire می‌شوند
    mediaUrlExpiresSoon: media.length > 0,
  };
}

// ══════════════════════════════════════════════════════════════
// RSS (ساده)
// ══════════════════════════════════════════════════════════════

function normalizeRssItem(raw: any): NormalizedItem | null {
  const url = raw.url ?? raw.link ?? raw.guid;
  if (!url) return null;

  return {
    platform:       'rss',
    sourceAccount:  raw.author ?? raw.creator ?? raw.feed ?? '',
    sourceUrl:      url,
    postId:         raw.guid ?? url,
    publishedAt:    parseTimestamp(raw.pubDate ?? raw.date ?? raw.published),
    text:           cleanText((raw.title ?? '') + (raw.description ? '\n' + raw.description : '')),
    media:          [],
    engagementLikes:  0,
    engagementShares: 0,
    engagementViews:  0,
    mediaUrlExpiresSoon: false,
  };
}

// ── Helpers ───────────────────────────────────────────────────

function parseTimestamp(value: any): number {
  if (!value) return Math.floor(Date.now() / 1000);
  if (typeof value === 'number') {
    // اگر milliseconds بود تبدیل به seconds کن
    return value > 1e10 ? Math.floor(value / 1000) : value;
  }
  const d = new Date(value);
  return isNaN(d.getTime()) ? Math.floor(Date.now() / 1000) : Math.floor(d.getTime() / 1000);
}

function safeInt(value: any): number {
  const n = Number(value);
  return isNaN(n) || !isFinite(n) ? 0 : Math.max(0, Math.floor(n));
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function extractLastPathSegment(url: string): string | null {
  try {
    const path = new URL(url).pathname;
    const seg = path.replace(/\/$/, '').split('/').pop();
    return seg && seg.length > 2 ? seg : null;
  } catch {
    return null;
  }
}
