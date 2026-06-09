// ══════════════════════════════════════════════════════════════
// types.ts — shared types for the entire Worker
// ══════════════════════════════════════════════════════════════

export interface Env {
  DB: D1Database;
  // Optional R2 bucket برای ذخیره‌سازی media (mode: r2_storage)
  MEDIA_BUCKET?: R2Bucket;

  // ── Secrets ────────────────────────────────────────────────
  APIFY_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  GEMINI_API_KEY: string;
  OPENAI_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  INTERNAL_API_SECRET: string;
  // برای R2 public access (اگر bucket public نباشد)
  R2_PUBLIC_BASE_URL?: string;

  // ── AI — Scoring (Claude) ──────────────────────────────────
  AI_SCORING_MODEL: string;
  AI_SCORE_THRESHOLD_DEFAULT: string;
  AI_MAX_CALLS_PER_DAY: string;
  AI_DAILY_TOKEN_BUDGET: string;
  AI_MAX_CANDIDATES_PER_RUN: string;
  AI_MAX_TEXT_CHARS_PER_ITEM: string;
  AI_MAX_OUTPUT_TOKENS: string;
  AI_MAX_RETRIES: string;

  // ── AI Candidate Backlog (Phase 1) ─────────────────────────
  // وقتی false باشد، رفتار pipeline کاملاً تغییر نمی‌کند.
  AI_CANDIDATE_BACKLOG_ENABLED?: string;    // default: "false"
  AI_SCORING_BATCH_SIZE?: string;           // default: "10"
  AI_MAX_SCORING_BATCHES_PER_RUN?: string;  // default: "2"
  AI_CANDIDATE_BACKLOG_DRAIN_LIMIT?: string;// default: "20"
  AI_CANDIDATE_MAX_ATTEMPTS?: string;       // default: "2"
  AI_CANDIDATE_MAX_AGE_HOURS?: string;      // default: "6"
  AI_FAIR_SOURCE_PICKER_ENABLED?: string;   // default: "false"

  // ── AI — Translation ───────────────────────────────────────
  TRANSLATION_PROVIDER: string;
  TRANSLATION_MODEL: string;

  // Apify
  APIFY_CURATION_ENABLED: string;
  APIFY_CURATION_DRY_RUN: string;
  APIFY_SCHEDULED_CURATION_ENABLED?: string;
  APIFY_MAX_ITEMS_PER_SOURCE: string;

  // Telegram
  TELEGRAM_FINAL_PUBLISH_ENABLED: string;
  TELEGRAM_PUBLISH_SCHEDULER_ENABLED: string;
  TELEGRAM_PUBLISH_DUE_LIMIT: string;

  // Market Snapshot — direct Telegram posting, independent from publish_queue
  MARKET_SNAPSHOT_ENABLED?: string;
  MARKET_SNAPSHOT_INTERVAL_HOURS?: string;
  MARKET_SNAPSHOT_CHANNEL_ID?: string;
  MARKET_SNAPSHOT_CUSTOM_EMOJIS_ENABLED?: string;
  MARKET_SNAPSHOT_EMOJI_BTC?: string;
  MARKET_SNAPSHOT_EMOJI_ETH?: string;
  MARKET_SNAPSHOT_EMOJI_SOL?: string;
  MARKET_SNAPSHOT_EMOJI_XRP?: string;
  MARKET_SNAPSHOT_EMOJI_BNB?: string;
  MARKET_SNAPSHOT_EMOJI_ADA?: string;
  MARKET_SNAPSHOT_EMOJI_TON?: string;
  MARKET_SNAPSHOT_EMOJI_DOGE?: string;

  // Publish scheduling delays
  PUBLISH_DELAY_BREAKING_MINUTES?: string;
  PUBLISH_DELAY_HIGH_MINUTES?: string;
  PUBLISH_DELAY_NORMAL_MINUTES?: string;
  PUBLISH_DELAY_LOW_MINUTES?: string;
  PUBLISH_DELAY_EXPIRING_MEDIA_HIGH_MINUTES?: string;
  PUBLISH_DELAY_EXPIRING_MEDIA_DEFAULT_MINUTES?: string;

  // Media — سه حالت:
  //   direct_url    → URL مستقیم به Telegram (پیش‌فرض، سریع، بدون ضمانت)
  //   binary_upload → دانلود + آپلود binary به Telegram (توصیه می‌شود)
  //   r2_storage    → دانلود → R2 → URL پایدار (بهترین قابلیت اطمینان)
  MEDIA_PROCESSING_MODE: string;
  // حداکثر حجم فایل برای دانلود (مگابایت) — پیش‌فرض 50
  MEDIA_MAX_DOWNLOAD_MB: string;
  MEDIA_DOWNLOAD_TIMEOUT_SEC: string;
  // If false, any failed item in a binary media group fails the whole post. Default true.
  MEDIA_GROUP_PARTIAL_PUBLISH_ENABLED?: string;

  DEDUPE_WINDOW_HOURS: string; // default 168 (7 days)

  // Cloudflare Stream — اختیاری، برای video transcoding به H.264
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_STREAM_API_TOKEN?: string;
  // Paid/optional. Must be exactly 'true' before Stream can be called.
  STREAM_TRANSCODE_ENABLED?: string; // default false
  STREAM_TRANSCODE_TIMEOUT_SEC?: string; // default 120

  ENVIRONMENT: string;
  LOG_LEVEL: string;
}

// ── Platform types ────────────────────────────────────────────

export type Platform = 'x' | 'instagram' | 'linkedin' | 'rss';
export type MediaType = 'image' | 'video';

export type MediaProcessingStatus =
  | 'pending'
  | 'validating'
  | 'ready'
  | 'failed'
  | 'unsupported'
  | 'too_large'
  | 'expired'
  | 'uploaded'; // Telegram file_id موجود است

export type ThumbnailStatus =
  | 'missing'
  | 'valid'
  | 'download_failed'
  | 'unsupported_format'
  | 'too_large'
  | 'invalid_dimensions'
  | 'invalid_image';

export type TelegramMethod =
  | 'sendMessage'
  | 'sendPhoto'
  | 'sendVideo'
  | 'sendMediaGroup';

export type PublishPriority = 'breaking' | 'high' | 'normal' | 'low';
export type RiskLevel = 'low' | 'medium' | 'high';

export type ItemStatus =
  | 'pending' | 'ai_processing' | 'ai_selected'
  | 'ai_rejected' | 'queued' | 'duplicate' | 'error';

export type QueueStatus =
  | 'scheduled' | 'publishing' | 'published'
  | 'failed' | 'retry' | 'cancelled';

// ── Normalized media item ─────────────────────────────────────

export interface MediaItem {
  type: MediaType;
  url: string;
  /** URL عکس پیش‌نمایش ویدئو — از پلتفرم اصلی */
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  durationSec?: number;
  sizeMb?: number;
}

export interface NormalizedItem {
  platform: Platform;
  sourceAccount: string;
  sourceUrl: string;
  postId: string;
  publishedAt: number;
  text: string;
  media: MediaItem[];
  /** Apify/source media count when the actor exposes it. Used for extraction diagnostics. */
  expectedMediaCount?: number;
  /** Non-fatal extraction warnings from Apify normalization. */
  mediaWarnings?: string[];
  engagementLikes: number;
  engagementShares: number;
  engagementViews: number;
  mediaUrlExpiresSoon: boolean;
  /** X/Twitter or platform reply marker. Used for deterministic category policy. */
  isReply?: boolean;
  /** Retweet/repost marker when exposed by the source platform. */
  isRetweet?: boolean;
  /** Quote-post marker when exposed by the source platform. */
  isQuote?: boolean;
}

// ── AI Gate output ────────────────────────────────────────────

export interface TranslationOutput {
  captionShort: string;
  captionFull: string;
  hashtags: string[];
}

export interface AIGateResult {
  publish: boolean;
  score: number;
  riskLevel: RiskLevel;
  riskFlags: string[];
  topicFingerprint: string;
  publishPriority: PublishPriority;
  translations: Record<string, TranslationOutput>;
}

// ── DB Row types ──────────────────────────────────────────────

export interface CategoryRow {
  id: string;
  label: string;
  prompt_profile: string;
  /** اگر set باشد، به جای prompt_profile از این prompt استفاده می‌شود */
  custom_prompt: string | null;
  score_threshold: number;
  freshness_hours: number;
  media_mode: 'preferred' | 'optional' | 'disabled';
  language_targets: string;
  editorial_guidelines: string | null;
  selection_criteria: string | null;
  rejection_criteria: string | null;
  required_context: string | null;
  avoid_duplicate_people_stories: number;
  allow_replies?: number;
  allow_retweets?: number;
  allow_quotes?: number;
  text_only_policy?: 'allow' | 'penalize' | 'reject';
  min_score_for_text_only?: number | null;
  min_score_for_media?: number | null;
  enabled: number;
}

export interface ChannelRow {
  id: string;
  category_id: string;
  telegram_chat_id: string;
  language: string;
  timezone: string;
  allowed_windows: string;
  blocked_windows: string;
  max_per_day: number;
  max_per_hour: number;
  min_gap_minutes: number;
  publish_enabled: number;
  enabled: number;
  /** دستورالعمل اختصاصی برای AI — مثال: "لحن رسمی" یا "برای مخاطبان مبتدی" */
  custom_instructions: string | null;
  tone_profile: string;
  channel_label: string | null;
  /** اگر 0 باشد، source_url فقط برای audit در DB می‌ماند و در Telegram نمایش داده نمی‌شود. */
  source_enabled: number;
  source_label_override: string | null;
  signature_enabled: number;
  signature_text: string | null;
  channel_id_footer_enabled: number;
  channel_id_footer_text: string | null;
  /** Default 1: Telegram link previews should stay disabled unless explicitly changed later. */
  disable_link_preview: number;
  semantic_dedupe_enabled: number;
  semantic_dedupe_window_hours: number;
  max_posts_per_source_per_day: number | null;
  editorial_mode: string;
  audience_level: string;
  caption_style: string;
  creativity_level: number;
  caption_max_chars: number;
  caption_short_max_chars: number;
  language_prompt: string | null;
  terminology_notes: string | null;
  forbidden_phrases: string | null;
}

export interface ApifySourceRow {
  id: string;
  category_id: string;
  platform: string;
  apify_dataset_id: string;
  label: string | null;
  enabled: number;
  apify_actor_id: string | null;
  apify_task_id: string | null;
  last_dataset_id: string | null;
  source_config: string | null;
}

export interface DiscoveryMediaRow {
  id: string;
  item_id: string;
  media_index: number;
  media_type: string;
  source_url: string;
  thumbnail_url: string | null;
  mime_type: string | null;
  file_size_bytes: number | null;
  width: number | null;
  height: number | null;
  duration_sec: number | null;
  size_mb: number | null;
  processing_status: MediaProcessingStatus;
  processing_error: string | null;
  expires_at: number | null;
  telegram_file_id: string | null;
  telegram_message_id?: string | null;
  thumbnail_status?: ThumbnailStatus | null;
  thumbnail_error?: string | null;
}

// ── Media resolver output ─────────────────────────────────────

export interface MediaResolution {
  method: TelegramMethod;
  mediaUrls: string[];
  thumbnailUrls: string[];
  useShortCaption: boolean;
}

// ── Media processor result ────────────────────────────────────

export interface ProcessedMedia {
  /** blob دانلود شده (اگر mode=binary_upload) */
  blob?: Blob;
  /** URL پایدار (اگر mode=r2_storage یا Telegram file_id) */
  stableUrl?: string;
  /** file_id از Telegram (اگر قبلاً upload شده) */
  telegramFileId?: string;
  thumbnailBlob?: Blob;
  thumbnailStatus?: ThumbnailStatus;
  thumbnailError?: string;
  mimeType: string;
  sizeBytes: number;
  ok: boolean;
  error?: string;
  status: MediaProcessingStatus;
}


// ── Telegram publish observability ────────────────────────────

export interface PublishedMediaResult {
  mediaIndex: number;
  status: MediaProcessingStatus;
  error?: string;
  telegramFileId?: string;
  telegramMessageId?: string;
  thumbnailStatus?: ThumbnailStatus;
  thumbnailError?: string;
}

// ── AI Candidate Backlog (Phase 1) ────────────────────────────

/**
 * وضعیت‌های ممکن یک candidate در صف AI.
 *
 * pending     → منتظر scoring
 * scoring     → claimed برای یک batch scoring
 * ai_selected → Claude تأیید کرد
 * ai_rejected → Claude رد کرد
 * queued      → حداقل یک publish_queue row ایجاد شده
 * failed      → بعد از attempt_count حداکثر، شکست خورده
 * skipped     → به خاطر stale بودن یا policy حذف شده
 */
export type AICandidateStatus =
  | 'pending'
  | 'scoring'
  | 'ai_selected'
  | 'ai_rejected'
  | 'queued'
  | 'failed'
  | 'skipped';

/** Row خوانده‌شده از جدول ai_candidate_queue */
export interface AICandidateRow {
  id: string;
  source_id: string | null;
  run_id: string | null;
  category_id: string;
  platform: string;
  source_account: string | null;
  source_url: string;
  post_id: string | null;
  published_at: number | null;
  normalized_item_json: string;
  dedupe_keys_json: string;
  priority_score: number;
  status: AICandidateStatus;
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  claimed_at: string | null;
  scored_at: string | null;
}

/** ورودی enqueue یک candidate جدید */
export interface AICandidateEnqueueInput {
  sourceId?: string;
  runId: string;
  categoryId: string;
  platform: string;
  sourceAccount: string;
  sourceUrl: string;
  postId: string;
  publishedAt: number;
  normalizedItem: NormalizedItem;
  dedupeKeys: string[];
  priorityScore?: number;
}
