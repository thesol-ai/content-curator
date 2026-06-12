// ══════════════════════════════════════════════════════════════
// services/apify-client.ts — v4
// Fetch + Normalize — defensive Apify actor normalization
//
// Phase 7 focus:
//   ✓ More robust field-path handling for X/Instagram/LinkedIn
//   ✓ DASH/HLS/manifest URLs are rejected before Telegram queueing
//   ✓ Video URLs and thumbnail URLs are modeled separately
//   ✓ Expected vs extracted media counts are tracked when knowable
//   ✓ Extraction warnings are surfaced on NormalizedItem for DB logging
//   ✓ Source media order is preserved
// ══════════════════════════════════════════════════════════════

import type { NormalizedItem, MediaItem, Platform } from '../types';

const APIFY_API_BASE = 'https://api.apify.com/v2';
const FETCH_TIMEOUT_MS = 25_000;
const MAX_MEDIA_ITEMS = 10;

export async function fetchApifyDataset(
  datasetId: string,
  apifyToken: string,
  limit: number
): Promise<any[]> {
  const url =
    `${APIFY_API_BASE}/datasets/${datasetId}/items` +
    `?token=${apifyToken}&clean=true&limit=${limit}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Apify fetch failed ${res.status}: ${res.statusText}`);
  const data = await res.json() as any;
  return Array.isArray(data) ? data : [];
}

export interface ApifyDatasetFilterResult {
  realItems: any[];
  actorMockCount: number;
  actorMockSamples: Array<{
    keys: string[];
    id?: unknown;
    type?: unknown;
    textPreview?: string;
  }>;
}

export function isApifyActorMockNoResultItem(raw: any): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;

  const keys = Object.keys(raw).sort();
  const keySet = new Set(keys);
  const onlyMinimalKeys = keys.length > 0 && keys.every(key => ['id', 'text', 'type'].includes(key));

  const id = Number(raw.id);
  const text = String(raw.text ?? '').trim();
  const type = String(raw.type ?? '').trim().toLowerCase();
  const lowerText = text.toLowerCase();

  const looksLikeKaitoMock =
    lowerText.includes('from kaitoeasyapi') ||
    lowerText.includes('kaitoeasyapi') ||
    lowerText.includes('api pricing') ||
    lowerText.includes('mock data') ||
    lowerText.includes('minimum charge');

  const hasNoTweetShape =
    !keySet.has('url') &&
    !keySet.has('twitterUrl') &&
    !keySet.has('tweet_url') &&
    !keySet.has('tweetUrl') &&
    !keySet.has('permalink') &&
    !keySet.has('link') &&
    !keySet.has('author') &&
    !keySet.has('user') &&
    !keySet.has('legacy') &&
    !keySet.has('tweet') &&
    !keySet.has('data') &&
    !keySet.has('result');

  return (
    (id === -1 && looksLikeKaitoMock) ||
    (onlyMinimalKeys && looksLikeKaitoMock && hasNoTweetShape) ||
    (type.includes('mock') && hasNoTweetShape)
  );
}

export function filterApifyActorMockNoResultItems(rawItems: any[]): ApifyDatasetFilterResult {
  const realItems: any[] = [];
  const actorMockSamples: ApifyDatasetFilterResult['actorMockSamples'] = [];
  let actorMockCount = 0;

  for (const raw of rawItems) {
    if (isApifyActorMockNoResultItem(raw)) {
      actorMockCount++;
      if (actorMockSamples.length < 3) {
        actorMockSamples.push({
          keys: Object.keys(raw ?? {}).sort().slice(0, 30),
          id: raw?.id,
          type: raw?.type,
          textPreview: String(raw?.text ?? '').replace(/\s+/g, ' ').slice(0, 180),
        });
      }
      continue;
    }

    realItems.push(raw);
  }

  return { realItems, actorMockCount, actorMockSamples };
}

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
// Twitter/X — kaitoeasyapi and raw Twitter-compatible shapes
// ══════════════════════════════════════════════════════════════

function normalizeTwitterItem(raw: any): NormalizedItem | null {
  const url = firstString(
    raw.url,
    raw.twitterUrl,
    raw.tweet_url,
    raw.tweetUrl,
    raw.permalink,
    raw.link
  );
  if (!url) return null;

  const postId = firstString(
    raw.id_str,
    raw.id,
    raw.tweet_id,
    raw.tweetId,
    raw.rest_id,
    extractLastPathSegment(url)
  );
  if (!postId) return null;

  const warnings: string[] = [];
  const { media, expectedCount, warnings: mediaWarnings } = extractTwitterMedia(raw);
  warnings.push(...mediaWarnings);
  pushCountWarnings(warnings, 'x', expectedCount, media.length);

  return compactNormalized({
    platform:       'x',
    sourceAccount:  firstString(
      raw.author?.userName,
      raw.author?.username,
      raw.author?.screen_name,
      raw.user?.screen_name,
      raw.user?.username,
      raw.authorUsername,
      raw.screenName,
      raw.handle
    ) ?? '',
    sourceUrl:      url,
    postId:         String(postId),
    publishedAt:    parseTimestamp(
      raw.createdAt ?? raw.created_at ?? raw.date ?? raw.timestamp ?? raw.postedAt
    ),
    text:           cleanText(firstString(raw.text, raw.full_text, raw.content, raw.tweetText) ?? ''),
    media,
    expectedMediaCount: expectedCount,
    mediaWarnings: warnings,
    engagementLikes:  safeInt(raw.likeCount ?? raw.favorite_count ?? raw.likes ?? raw.public_metrics?.like_count ?? 0),
    engagementShares: safeInt(raw.retweetCount ?? raw.retweet_count ?? raw.retweets ?? raw.public_metrics?.retweet_count ?? 0),
    engagementViews:  safeInt(raw.viewCount ?? raw.views?.count ?? raw.public_metrics?.impression_count ?? 0),
    mediaUrlExpiresSoon: false,
    isReply: isTwitterReply(raw),
    isRetweet: isTwitterRetweet(raw),
    isQuote: isTwitterQuote(raw),
  });
}

function isTwitterReply(raw: any): boolean {
  return boolish(
    raw.isReply,
    raw.is_reply,
    raw.reply,
    raw.is_reply_status,
    raw.legacy?.is_reply
  ) || Boolean(firstString(
    raw.inReplyToStatusId,
    raw.in_reply_to_status_id,
    raw.in_reply_to_status_id_str,
    raw.inReplyToTweetId,
    raw.in_reply_to_tweet_id,
    raw.replyToTweetId,
    raw.conversation_id && raw.conversation_id !== raw.id_str && raw.conversation_id !== raw.id
      ? raw.conversation_id
      : undefined
  ));
}

function isTwitterRetweet(raw: any): boolean {
  const type = String(raw.type ?? raw.tweetType ?? raw.legacy?.retweeted_status_result?.result?.__typename ?? '').toLowerCase();
  return boolish(raw.isRetweet, raw.is_retweet, raw.retweeted, raw.isRetweeted) ||
    type.includes('retweet') ||
    Boolean(raw.retweeted_status ?? raw.retweetedStatus ?? raw.retweeted_tweet ?? raw.retweetedTweet);
}

function isTwitterQuote(raw: any): boolean {
  return boolish(raw.isQuote, raw.is_quote, raw.isQuoted, raw.quoted) ||
    Boolean(raw.quoted_status ?? raw.quotedStatus ?? raw.quoted_tweet ?? raw.quotedTweet ?? raw.quotedTweetId ?? raw.quoted_status_id);
}

function extractTwitterMedia(raw: any): ExtractionResult {
  const candidates = firstArray(
    raw.extendedEntities?.media,
    raw.extended_entities?.media,
    raw.entities?.media,
    raw.media,
    raw.attachments?.media,
    raw.legacy?.extended_entities?.media,
    raw.legacy?.entities?.media
  );

  const warnings: string[] = [];
  if (candidates.length === 0) return { media: [], expectedCount: 0, warnings };

  const results: MediaItem[] = [];

  for (const [index, m] of candidates.entries()) {
    const mediaType = String(m.type ?? m.media_type ?? m.kind ?? '').toLowerCase();
    const isVideo = mediaType === 'video' || mediaType === 'animated_gif' || !!(m.video_info ?? m.videoInfo ?? m.variants);

    if (isVideo) {
      const variants = firstArray(
        m.video_info?.variants,
        m.videoInfo?.variants,
        m.variants,
        m.videoVariants
      );

      const mp4Variants = variants
        .filter((v: any) => {
          const url = firstString(v.url, v.downloadUrl, v.src) ?? '';
          const ct = String(v.content_type ?? v.contentType ?? v.mimeType ?? '').toLowerCase();
          if (!url || isStreamUrl(url)) return false;
          return ct === 'video/mp4' || stripQuery(url).toLowerCase().endsWith('.mp4');
        })
        .sort((a: any, b: any) => Number(b.bitrate ?? b.bit_rate ?? 0) - Number(a.bitrate ?? a.bit_rate ?? 0));

      const videoUrl = firstString(mp4Variants[0]?.url, mp4Variants[0]?.downloadUrl, mp4Variants[0]?.src);
      if (!videoUrl) {
        warnings.push(`x.media[${index}]: video skipped, no compatible mp4 variant`);
        continue;
      }

      const thumbnailUrl = firstString(m.media_url_https, m.media_url, m.thumbnailUrl, m.preview_image_url, m.url);
      const durationMs = Number(m.video_info?.duration_millis ?? m.videoInfo?.durationMillis ?? m.duration_millis ?? 0);

      results.push({
        type: 'video',
        url: videoUrl,
        thumbnailUrl: thumbnailUrl && !isStreamUrl(thumbnailUrl) ? thumbnailUrl : undefined,
        width: safeOptionalInt(m.original_info?.width ?? m.sizes?.large?.w ?? m.width),
        height: safeOptionalInt(m.original_info?.height ?? m.sizes?.large?.h ?? m.height),
        durationSec: durationMs > 0 ? Math.round(durationMs / 1000) : undefined,
      });
      continue;
    }

    const imgUrl = firstString(m.media_url_https, m.media_url, m.url, m.src);
    if (!imgUrl || !imgUrl.startsWith('http') || isStreamUrl(imgUrl)) {
      warnings.push(`x.media[${index}]: image skipped, invalid image url`);
      continue;
    }

    results.push({
      type: 'image',
      url: imgUrl,
      width: safeOptionalInt(m.original_info?.width ?? m.sizes?.large?.w ?? m.width),
      height: safeOptionalInt(m.original_info?.height ?? m.sizes?.large?.h ?? m.height),
    });
  }

  return capExtraction(results, candidates.length, warnings, 'x');
}

// ══════════════════════════════════════════════════════════════
// Instagram — apify/instagram-post-scraper and common variants
// ══════════════════════════════════════════════════════════════

function normalizeInstagramItem(raw: any): NormalizedItem | null {
  const url = firstString(raw.url, raw.postUrl, raw.link, raw.shortcode_media?.url, raw.permalink);
  if (!url) return null;

  const postId = firstString(raw.shortCode, raw.shortcode, raw.id, raw.pk, extractLastPathSegment(url));
  const warnings: string[] = [];
  const { media, expectedCount, warnings: mediaWarnings } = extractInstagramMedia(raw);
  warnings.push(...mediaWarnings);
  pushCountWarnings(warnings, 'instagram', expectedCount, media.length);

  return compactNormalized({
    platform:       'instagram',
    sourceAccount:  firstString(raw.ownerUsername, raw.username, raw.owner?.username, raw.user?.username) ?? '',
    sourceUrl:      url,
    postId:         String(postId ?? url),
    publishedAt:    parseTimestamp(raw.timestamp ?? raw.takenAt ?? raw.taken_at_timestamp ?? raw.date),
    text:           cleanText(firstString(raw.caption, raw.text, raw.alt, raw.edge_media_to_caption?.edges?.[0]?.node?.text) ?? ''),
    media,
    expectedMediaCount: expectedCount,
    mediaWarnings: warnings,
    engagementLikes:  safeInt(raw.likesCount ?? raw.likes ?? raw.likeCount ?? raw.edge_media_preview_like?.count ?? 0),
    engagementShares: 0,
    engagementViews:  safeInt(raw.videoViewCount ?? raw.videoViews ?? raw.playCount ?? raw.video_view_count ?? 0),
    mediaUrlExpiresSoon: media.length > 0,
  });
}

function extractInstagramMedia(raw: any): ExtractionResult {
  const warnings: string[] = [];
  const carousel = firstArray(
    raw.childPosts,
    raw.sidecarChildren,
    raw.carouselMedia,
    raw.carousel_media,
    raw.shortcode_media?.edge_sidecar_to_children?.edges?.map((e: any) => e.node),
    raw.edge_sidecar_to_children?.edges?.map((e: any) => e.node)
  );

  let expectedCount = 0;
  const media: MediaItem[] = [];

  if (carousel.length > 0) {
    expectedCount = carousel.length;
    for (const [index, child] of carousel.entries()) {
      const item = extractInstagramSingleMedia(child, `carousel[${index}]`, warnings);
      if (item) media.push(item);
    }
    return capExtraction(media, expectedCount, warnings, 'instagram');
  }

  const images = firstArray(raw.images, raw.displayUrls, raw.imageUrls);
  if (images.length > 0) {
    expectedCount = images.length;
    for (const [index, img] of images.entries()) {
      const imgUrl = typeof img === 'string' ? img : firstString(img.url, img.displayUrl, img.src);
      if (!imgUrl || !imgUrl.startsWith('http') || isStreamUrl(imgUrl)) {
        warnings.push(`instagram.images[${index}]: image skipped, invalid image url`);
        continue;
      }
      media.push({ type: 'image', url: imgUrl });
    }
    return capExtraction(media, expectedCount, warnings, 'instagram');
  }

  const single = extractInstagramSingleMedia(raw, 'single', warnings);
  if (single) {
    expectedCount = 1;
    media.push(single);
  }
  return capExtraction(media, expectedCount, warnings, 'instagram');
}

function extractInstagramSingleMedia(node: any, label: string, warnings: string[]): MediaItem | null {
  if (!node) return null;

  const nodeType = String(node.type ?? node.__typename ?? node.productType ?? node.media_type ?? '').toLowerCase();
  const videoUrl = firstString(
    node.videoUrl,
    node.video_url,
    node.video_url_filtered,
    node.video?.url,
    node.video?.playback_url,
    node.videoResources?.[0]?.src,
    node.video_versions?.[0]?.url
  );

  const isVideo = !!videoUrl ||
    nodeType.includes('video') ||
    nodeType.includes('reel') ||
    nodeType === 'graphvideo' ||
    node.productType === 'clips';

  if (isVideo) {
    if (!videoUrl) {
      warnings.push(`instagram.${label}: video skipped, no video url`);
      return null;
    }
    if (isStreamUrl(videoUrl)) {
      warnings.push(`instagram.${label}: video skipped, stream manifest url is not Telegram-compatible`);
      return null;
    }

    const thumbnailUrl = firstString(
      node.displayUrl,
      node.display_url,
      node.thumbnailUrl,
      node.thumbnail_url,
      node.thumbnail_src,
      node.image_versions2?.candidates?.[0]?.url,
      node.display_resources?.[0]?.src
    );

    return {
      type: 'video',
      url: videoUrl,
      thumbnailUrl: thumbnailUrl && !isStreamUrl(thumbnailUrl) ? thumbnailUrl : undefined,
      width: safeOptionalInt(node.dimensions?.width ?? node.width),
      height: safeOptionalInt(node.dimensions?.height ?? node.height),
      durationSec: safeOptionalDuration(node.videoDuration ?? node.video_duration ?? node.duration),
    };
  }

  const imageUrl = firstString(
    node.displayUrl,
    node.display_url,
    node.url,
    node.thumbnail_src,
    node.image_versions2?.candidates?.[0]?.url,
    node.display_resources?.[0]?.src
  );
  if (!imageUrl || !imageUrl.startsWith('http') || isStreamUrl(imageUrl)) {
    warnings.push(`instagram.${label}: image skipped, invalid image url`);
    return null;
  }

  return {
    type: 'image',
    url: imageUrl,
    width: safeOptionalInt(node.dimensions?.width ?? node.width),
    height: safeOptionalInt(node.dimensions?.height ?? node.height),
  };
}

// ══════════════════════════════════════════════════════════════
// LinkedIn — harvestapi/linkedin-profile-posts and common variants
// ══════════════════════════════════════════════════════════════

function normalizeLinkedInItem(raw: any): NormalizedItem | null {
  const url = firstString(
    raw.linkedinUrl,
    raw.linkedin_url,
    raw.url,
    raw.shareUrl,
    raw.socialContent?.shareUrl,
    raw.permalink
  );
  if (!url) return null;

  const warnings: string[] = [];
  const { media, expectedCount, warnings: mediaWarnings } = extractLinkedInMedia(raw);
  warnings.push(...mediaWarnings);
  pushCountWarnings(warnings, 'linkedin', expectedCount, media.length);

  const authorHandle = firstString(
    raw.author?.publicIdentifier,
    raw.author?.universalName,
    raw.author?.username,
    raw.author?.linkedinUrl?.split('/in/')?.[1]?.split('?')[0]
  ) ?? '';

  return compactNormalized({
    platform:       'linkedin',
    sourceAccount:  authorHandle,
    sourceUrl:      url,
    postId:         String(firstString(raw.id, raw.urn, raw.activityUrn, url) ?? url),
    publishedAt:    raw.postedAt?.timestamp
      ? Math.floor(Number(raw.postedAt.timestamp) / 1000)
      : parseTimestamp(raw.postedAt?.date ?? raw.date ?? raw.createdAt),
    text:           cleanText(firstString(raw.content, raw.text, raw.commentary, raw.description) ?? ''),
    media,
    expectedMediaCount: expectedCount,
    mediaWarnings: warnings,
    engagementLikes:  safeInt(raw.engagement?.likes ?? raw.totalReactionCount ?? raw.reactionCount ?? 0),
    engagementShares: safeInt(raw.engagement?.shares ?? raw.repostsCount ?? raw.sharesCount ?? 0),
    engagementViews:  safeInt(raw.engagement?.impressions ?? raw.impressionsCount ?? raw.viewCount ?? 0),
    mediaUrlExpiresSoon: media.length > 0,
  });
}

function extractLinkedInMedia(raw: any): ExtractionResult {
  const warnings: string[] = [];
  const media: MediaItem[] = [];

  const images = firstArray(raw.postImages, raw.images, raw.imageUrls);
  const videoNode = raw.postVideo ?? raw.video ?? raw.videos?.[0];

  // LinkedIn video posts sometimes also expose postImages as thumbnails.
  // Prefer the real video asset so thumbnail images are not misclassified as the whole post.
  if (videoNode) {
    const videoUrl = firstString(videoNode.videoUrl, videoNode.video_url, videoNode.url, videoNode.src, videoNode.downloadUrl);
    if (!videoUrl) {
      warnings.push('linkedin.postVideo: video skipped, no video url');
      return { media: [], expectedCount: 1, warnings };
    }
    if (isStreamUrl(videoUrl)) {
      warnings.push('linkedin.postVideo: video skipped, stream manifest url is not Telegram-compatible');
      return { media: [], expectedCount: 1, warnings };
    }
    const fallbackThumb = images.length > 0
      ? (typeof images[0] === 'string' ? images[0] : firstString(images[0].url, images[0].imageUrl, images[0].src))
      : undefined;
    media.push({
      type: 'video',
      url: videoUrl,
      thumbnailUrl: firstString(videoNode.thumbnailUrl, videoNode.thumbnail_url, videoNode.thumbnail, videoNode.previewUrl, fallbackThumb) ?? undefined,
      width: safeOptionalInt(videoNode.width),
      height: safeOptionalInt(videoNode.height),
      durationSec: safeOptionalDuration(videoNode.durationSec ?? videoNode.duration ?? videoNode.durationSeconds),
    });
    return { media, expectedCount: 1, warnings };
  }

  if (images.length > 0) {
    for (const [index, img] of images.entries()) {
      const imgUrl = typeof img === 'string' ? img : firstString(img.url, img.imageUrl, img.src);
      if (!imgUrl || !imgUrl.startsWith('http') || isStreamUrl(imgUrl)) {
        warnings.push(`linkedin.postImages[${index}]: image skipped, invalid image url`);
        continue;
      }
      media.push({
        type: 'image',
        url: imgUrl,
        width: safeOptionalInt(typeof img === 'string' ? undefined : img.width),
        height: safeOptionalInt(typeof img === 'string' ? undefined : img.height),
      });
    }
    return capExtraction(media, images.length, warnings, 'linkedin');
  }

  const coverPages = firstArray(raw.document?.coverPages, raw.document?.pages, raw.documentCoverPages);
  if (coverPages.length > 0) {
    for (const [index, page] of coverPages.entries()) {
      const imgUrl = firstString(page.imageUrls?.[0], page.imageUrl, page.url, page.src);
      if (!imgUrl || isStreamUrl(imgUrl)) {
        warnings.push(`linkedin.document.coverPages[${index}]: page skipped, invalid image url`);
        continue;
      }
      media.push({
        type: 'image',
        url: imgUrl,
        width: safeOptionalInt(page.width),
        height: safeOptionalInt(page.height),
      });
    }
    return capExtraction(media, coverPages.length, warnings, 'linkedin');
  }

  const articleImage = firstString(raw.article?.image?.url, raw.article?.imageUrl, raw.thumbnailUrl);
  if (articleImage && !isStreamUrl(articleImage)) {
    media.push({ type: 'image', url: articleImage });
    return { media, expectedCount: 1, warnings };
  }

  return { media: [], expectedCount: 0, warnings };
}

// ── RSS ───────────────────────────────────────────────────────

function normalizeRssItem(raw: any): NormalizedItem | null {
  const url = firstString(raw.url, raw.link, raw.guid);
  if (!url) return null;

  return compactNormalized({
    platform:       'rss',
    sourceAccount:  firstString(raw.author, raw.creator, raw.feed) ?? '',
    sourceUrl:      url,
    postId:         firstString(raw.guid, url) ?? url,
    publishedAt:    parseTimestamp(raw.pubDate ?? raw.date ?? raw.published),
    text:           cleanText((raw.title ?? '') + (raw.description ? '\n' + raw.description : '')),
    media:          [],
    expectedMediaCount: 0,
    mediaWarnings: [],
    engagementLikes: 0,
    engagementShares: 0,
    engagementViews: 0,
    mediaUrlExpiresSoon: false,
  });
}

// ══════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════

interface ExtractionResult {
  media: MediaItem[];
  expectedCount: number;
  warnings: string[];
}

function capExtraction(media: MediaItem[], expectedCount: number, warnings: string[], platform: string): ExtractionResult {
  const capped = media.slice(0, MAX_MEDIA_ITEMS);
  if (media.length > MAX_MEDIA_ITEMS) {
    warnings.push(`${platform}: extracted ${media.length} media items, capped to Telegram album limit ${MAX_MEDIA_ITEMS}`);
  }
  return { media: capped, expectedCount, warnings };
}

function pushCountWarnings(warnings: string[], platform: string, expected: number, extracted: number): void {
  if (expected > MAX_MEDIA_ITEMS) {
    warnings.push(`${platform}: expected ${expected} media items; only first ${MAX_MEDIA_ITEMS} can be queued for Telegram album`);
  }
  if (expected > 0 && extracted < Math.min(expected, MAX_MEDIA_ITEMS)) {
    warnings.push(`${platform}: extracted ${extracted}/${Math.min(expected, MAX_MEDIA_ITEMS)} expected media items`);
  }
}

function compactNormalized(item: NormalizedItem): NormalizedItem {
  const warnings = (item.mediaWarnings ?? []).filter(Boolean).slice(0, 20);
  return {
    ...item,
    expectedMediaCount: item.expectedMediaCount ?? item.media.length,
    mediaWarnings: warnings,
    isReply: item.isReply === true,
    isRetweet: item.isRetweet === true,
    isQuote: item.isQuote === true,
  };
}

function isStreamUrl(url: string): boolean {
  if (!url) return false;
  const u = url.toLowerCase();
  return (
    u.includes('.m3u8') ||
    u.includes('/dash/') ||
    u.includes('manifest.mpd') ||
    u.includes('/hls/') ||
    u.includes('playlist.m3u') ||
    u.includes('index.m3u') ||
    u.endsWith('.mpd')
  );
}

function firstString(...values: any[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function firstArray(...values: any[]): any[] {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function boolish(...values: any[]): boolean {
  for (const value of values) {
    if (value === true || value === 1 || value === '1') return true;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', 'yes', 'y', 'on'].includes(normalized)) return true;
      if (['false', 'no', 'n', 'off', '0'].includes(normalized)) continue;
    }
  }
  return false;
}

function stripQuery(url: string): string {
  return url.split('?')[0] ?? url;
}

function parseTimestamp(value: any): number {
  if (!value) return Math.floor(Date.now() / 1000);
  if (typeof value === 'number') return value > 1e10 ? Math.floor(value / 1000) : value;
  const d = new Date(value);
  return isNaN(d.getTime()) ? Math.floor(Date.now() / 1000) : Math.floor(d.getTime() / 1000);
}

function safeInt(value: any): number {
  const n = Number(value);
  return isNaN(n) || !isFinite(n) ? 0 : Math.max(0, Math.floor(n));
}

function safeOptionalInt(value: any): number | undefined {
  const n = Number(value);
  return isNaN(n) || !isFinite(n) ? undefined : Math.max(0, Math.floor(n));
}

function safeOptionalDuration(value: any): number | undefined {
  const n = Number(value);
  return isNaN(n) || !isFinite(n) || n <= 0 ? undefined : Math.round(n);
}

function cleanText(text: string): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function extractLastPathSegment(url: string): string | null {
  try {
    const path = new URL(url).pathname;
    const seg = path.replace(/\/$/, '').split('/').pop();
    return seg && seg.length > 2 ? seg : null;
  } catch { return null; }
}
