export const twitterVideoPost = {
  url: 'https://x.com/example/status/1001',
  id_str: '1001',
  full_text: 'A short product video update',
  author: { userName: 'example' },
  created_at: '2026-06-01T10:00:00Z',
  favorite_count: 42,
  retweet_count: 7,
  extended_entities: {
    media: [
      {
        type: 'video',
        media_url_https: 'https://pbs.twimg.com/media/thumb.jpg',
        video_info: {
          duration_millis: 12000,
          variants: [
            { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/ext_tw_video/playlist.m3u8' },
            { content_type: 'video/mp4', bitrate: 256000, url: 'https://video.twimg.com/ext_tw_video/low.mp4' },
            { content_type: 'video/mp4', bitrate: 2176000, url: 'https://video.twimg.com/ext_tw_video/high.mp4' },
          ],
        },
      },
    ],
  },
};

export const instagramCarouselPost = {
  url: 'https://www.instagram.com/p/abc123/',
  shortCode: 'abc123',
  caption: 'Carousel post with one image and one reel',
  ownerUsername: 'design_team',
  timestamp: '2026-06-01T09:00:00Z',
  likesCount: 120,
  childPosts: [
    {
      type: 'GraphImage',
      displayUrl: 'https://scontent.cdninstagram.com/image-1.jpg',
      dimensions: { width: 1080, height: 1080 },
    },
    {
      type: 'GraphVideo',
      videoUrl: 'https://scontent.cdninstagram.com/video-1.mp4',
      displayUrl: 'https://scontent.cdninstagram.com/video-1-thumb.jpg',
      videoDuration: 18.4,
      dimensions: { width: 1080, height: 1920 },
    },
  ],
};

export const instagramReelPost = {
  url: 'https://www.instagram.com/reel/reel123/',
  id: 'reel123',
  type: 'GraphVideo',
  caption: 'A reel with a thumbnail',
  ownerUsername: 'growth_lab',
  timestamp: '2026-06-01T11:00:00Z',
  videoUrl: 'https://scontent.cdninstagram.com/reel.mp4',
  displayUrl: 'https://scontent.cdninstagram.com/reel-thumb.jpg',
  videoDuration: 31,
};

export const linkedinVideoPost = {
  linkedinUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:123456',
  id: 'urn:li:activity:123456',
  content: 'A LinkedIn video post',
  author: { publicIdentifier: 'founder-example' },
  postedAt: { timestamp: 1780308000000 },
  postVideo: {
    videoUrl: 'https://media.licdn.com/video.mp4',
    thumbnailUrl: 'https://media.licdn.com/video-thumb.jpg',
  },
  engagement: { likes: 10, shares: 2, impressions: 1000 },
};

export const linkedinDocumentPost = {
  linkedinUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:777',
  id: 'urn:li:activity:777',
  content: 'A LinkedIn document carousel post',
  author: { publicIdentifier: 'product-lead' },
  postedAt: { timestamp: 1780308000000 },
  document: {
    coverPages: [
      { imageUrls: ['https://media.licdn.com/page-1.jpg'], width: 1200, height: 1600 },
      { imageUrls: ['https://media.licdn.com/page-2.jpg'], width: 1200, height: 1600 },
    ],
  },
};

export const twitterVideoOnlyHlsPost = {
  url: 'https://x.com/example/status/2002',
  id_str: '2002',
  full_text: 'A video with only HLS variants',
  author: { userName: 'example' },
  created_at: '2026-06-01T10:00:00Z',
  extended_entities: {
    media: [
      {
        type: 'video',
        media_url_https: 'https://pbs.twimg.com/media/hls-thumb.jpg',
        video_info: {
          variants: [
            { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/ext_tw_video/playlist.m3u8' },
          ],
        },
      },
    ],
  },
};

export const instagramSidecarChildrenPost = {
  url: 'https://www.instagram.com/p/sidecar123/',
  shortCode: 'sidecar123',
  caption: 'Sidecar children format',
  ownerUsername: 'design_team',
  timestamp: '2026-06-01T09:00:00Z',
  sidecarChildren: [
    { __typename: 'GraphImage', display_url: 'https://scontent.cdninstagram.com/sidecar-1.jpg' },
    { __typename: 'GraphVideo', video_url: 'https://scontent.cdninstagram.com/sidecar-video.mp4', display_url: 'https://scontent.cdninstagram.com/sidecar-video-thumb.jpg' },
  ],
};

export const instagramCarouselWithManifestVideoPost = {
  url: 'https://www.instagram.com/p/manifest123/',
  shortCode: 'manifest123',
  caption: 'Carousel with unsupported stream video',
  ownerUsername: 'video_team',
  timestamp: '2026-06-01T09:00:00Z',
  carousel_media: [
    { media_type: 1, image_versions2: { candidates: [{ url: 'https://scontent.cdninstagram.com/ok.jpg' }] } },
    { media_type: 2, video_versions: [{ url: 'https://scontent.cdninstagram.com/manifest.mpd' }], image_versions2: { candidates: [{ url: 'https://scontent.cdninstagram.com/thumb.jpg' }] } },
  ],
};

export const linkedinAlternateVideoPost = {
  url: 'https://www.linkedin.com/feed/update/urn:li:activity:888',
  activityUrn: 'urn:li:activity:888',
  text: 'Alternate LinkedIn video schema',
  author: { username: 'alt-founder' },
  createdAt: '2026-06-01T09:00:00Z',
  video: {
    url: 'https://media.licdn.com/alt-video.mp4',
    previewUrl: 'https://media.licdn.com/alt-video-thumb.jpg',
    durationSeconds: 42,
  },
};

export const linkedinDocumentWithTooManyPagesPost = {
  linkedinUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:999',
  id: 'urn:li:activity:999',
  content: 'Large LinkedIn document carousel',
  author: { publicIdentifier: 'deck-builder' },
  postedAt: { timestamp: 1780308000000 },
  document: {
    coverPages: Array.from({ length: 12 }, (_, i) => ({
      imageUrls: [`https://media.licdn.com/deck-page-${i + 1}.jpg`],
      width: 1200,
      height: 1600,
    })),
  },
};

export const linkedinVideoWithPostImageThumbnailPost = {
  linkedinUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:555',
  id: 'urn:li:activity:555',
  content: 'LinkedIn video that also exposes postImages as preview frames',
  author: { publicIdentifier: 'video-author' },
  postedAt: { timestamp: 1780308000000 },
  postImages: [
    { url: 'https://media.licdn.com/video-preview-from-postImages.jpg', width: 1280, height: 720 },
  ],
  postVideo: {
    videoUrl: 'https://media.licdn.com/video-with-preview.mp4',
  },
};
