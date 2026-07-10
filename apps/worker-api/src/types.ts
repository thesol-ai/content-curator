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
  GEMINI_API_KEY_2?: string;
  GEMINI_API_KEY_3?: string;
  GEMINI_API_KEY_4?: string;
  GEMINI_API_KEY_5?: string;
  GEMINI_API_KEY_6?: string;
  GEMINI_API_KEY_POOL?: string;
  OPENAI_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  INTERNAL_API_SECRET: string;
  TELEGRAM_ADMIN_BOT_ENABLED?: string;
  TELEGRAM_ADMIN_BOT_SECRET?: string;
  TELEGRAM_ADMIN_ALLOWED_USER_IDS?: string;
  // برای R2 public access (اگر bucket public نباشد)
  R2_PUBLIC_BASE_URL?: string;

  // ── AI — Scoring (Claude) ──────────────────────────────────
  AI_SCORING_MODEL: string;
  AI_SCORE_THRESHOLD_DEFAULT: string;
  AI_MAX_CALLS_PER_DAY: string;
  AI_DAILY_TOKEN_BUDGET: string;
  AI_SCORING_HOURLY_CALL_BUDGET?: string;
  AI_SCORING_HOURLY_TOKEN_BUDGET?: string;
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
  AI_CANDIDATE_TRANSLATION_MAX_ATTEMPTS?: string; // default: AI_CANDIDATE_MAX_ATTEMPTS; lets translation_missing retry without burying selected items too early
  AI_CANDIDATE_MAX_AGE_HOURS?: string;      // default: "6"
  AI_FAIR_SOURCE_PICKER_ENABLED?: string;   // default: "false"
  AI_FAIR_SOURCE_PICKER_POOL_MULTIPLIER?: string; // default: "6"
  AI_BACKLOG_INLINE_DRAIN_ENABLED?: string; // default: "false" in production

  // ── AI — Translation ───────────────────────────────────────
  TRANSLATION_PROVIDER: string;
  TRANSLATION_MODEL: string;
  TRANSLATION_DEBUG_ENABLED?: string;

  // Apify
  APIFY_CURATION_ENABLED: string;
  APIFY_CURATION_DRY_RUN: string;
  APIFY_SCHEDULED_CURATION_ENABLED?: string;
  APIFY_MAX_ITEMS_PER_SOURCE: string;
  APIFY_RAW_FETCH_LIMIT_PER_SOURCE?: string;
  APIFY_ROTATION_ENABLED?: string;
  APIFY_ROTATION_INTERVAL_HOURS?: string;
  APIFY_ROTATION_WAIT_FOR_FINISH_SECONDS?: string;
  APIFY_ROTATION_MAX_SOURCES_PER_TICK?: string;

  // Telegram
  TELEGRAM_FINAL_PUBLISH_ENABLED: string;
  TELEGRAM_PUBLISH_SCHEDULER_ENABLED: string;
  TELEGRAM_PUBLISH_DUE_LIMIT: string;

  // Market Snapshot — direct Telegram posting, independent from publish_queue
  MARKET_SNAPSHOT_ENABLED?: string;
  MARKET_SNAPSHOT_INTERVAL_HOURS?: string;
  MARKET_SNAPSHOT_SLOTS?: string;
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
  PUBLISH_SOURCE_ACCOUNT_GAP_MINUTES?: string;

  // ── Phase 6E/6F — queue-health controller + adaptive rotation + scheduler ──
  QUEUE_HEALTH_CONTROLLER_ENABLED?: string;        // default: "false"
  QUEUE_HEALTH_MIN_SCHEDULED_NEXT_6H?: string;     // default: "3"
  QUEUE_HEALTH_STARVING_SCHEDULED_NEXT_6H?: string;// default: floor(min/2)
  QUEUE_HEALTH_STARVING_MAX_BATCHES?: string;      // default: "3"
  QUEUE_HEALTH_STARVING_SCORING_CALL_BONUS?: string; // default: "50"
  QUEUE_HEALTH_CHANNEL_ID?: string;                // controller target channel
  QUEUE_POLICY_ENFORCEMENT_ENABLED?: string;        // default false; explicit opt-in only
  WEAK_POST_AI_GATE_OVERRIDE_ENABLED?: string;     // default false; soften only editorial capacity gates while all target queues starve
  WEAK_POST_AI_GATE_OVERRIDE_SCORE_MARGIN?: string;// default 5; required score above category threshold
  APIFY_ROTATION_CONTINUOUS_ENABLED?: string;      // default: "false"
  APIFY_ROTATION_SLOT_MINUTES?: string;            // default: "30"
  // ── Apify cost control (single paid actor event per source/slot) ──
  APIFY_MAX_ATTEMPTS_PER_SLOT?: string;            // default: "1" (one paid event; set >=3 to restore legacy chain)
  APIFY_ADAPTIVE_ATTEMPT_SELECTION_ENABLED?: string; // default: "true" (pick best attempt by historical yield)
  APIFY_SECOND_ATTEMPT_DAILY_BUDGET?: string;      // default: "0" (extra attempts/day, only while starving)
  APIFY_ATTEMPT_YIELD_HISTORY_DAYS?: string;       // default: "7"
  APIFY_ATTEMPT_YIELD_MIN_SAMPLE?: string;         // default: "3"
  PUBLISH_SCHEDULER_GAP_FILL_ENABLED?: string;     // default: "false"
  AI_TRANSLATION_MAX_TEXT_CHARS?: string;          // default: falls back to AI_MAX_TEXT_CHARS_PER_ITEM
  BACKLOG_TRANSLATE_AFTER_GATES_ENABLED?: string;  // default: "false"
  PUBLISH_ENFORCE_SOURCE_DAILY_CAP_ENABLED?: string; // default: "false" — enforce channels.max_posts_per_source_per_day
  AUDIENCE_PROFILE_SCORING_ENABLED?: string;        // default: "false" — locale-aware selection guidance (6J)
  STORY_INTELLIGENCE_ENABLED?: string;              // default: "false" — ask model for structured story fields (6K, observe)
  STORY_INTELLIGENCE_OBSERVE_ONLY?: string;         // default: "true"  — never reject on story_key yet
  STORY_INTELLIGENCE_REJECT_ENABLED?: string;       // default: "false" — actively reject story_key repeats
  STORY_INTELLIGENCE_WINDOW_HOURS?: string;         // default: "48"
  STORY_INTELLIGENCE_FOLLOWUP_ALLOW_ENABLED?: string; // default: "true" — let materially-new follow-ups through
  STORY_INTELLIGENCE_SEMANTIC_REJECT_ENABLED?: string; // default: "false" — allow heuristic semantic story blocking
  STORY_INTELLIGENCE_RETENTION_DAYS?: string;       // default: "30" — retention for story_intelligence_events
  // ── RSS feed ingestion (independent, zero-Apify-cost source) ──
  RSS_FALLBACK_CRON_COORDINATOR_ENABLED?: string;      // default: "false" — fallback-only publish-first cron coordinator
  RSS_INGEST_ENABLED?: string;                      // default: "false" — master switch for RSS polling
  RSS_FEED_PROBE_ONLY?: string;                     // default: "false" — fetch+parse+log only, no enqueue
  RSS_INGEST_INTERVAL_MIN?: string;                 // default: "30" — per-feed poll interval
  RSS_MAX_ITEMS_PER_FEED?: string;                  // default: "4" — new items enqueued per feed per run
  RSS_MAX_NEW_ITEMS_PER_RUN?: string;               // default: "12" — across all feeds per run
  RSS_MAX_NEW_ITEMS_PER_DAY?: string;               // default: "80" — across all feeds per day
  RSS_FEED_TIMEOUT_SEC?: string;                    // default: "10" — per-feed fetch timeout
  JINA_READER_ENABLED?: string;                     // default: "false" — full-text extraction for short-summary feeds
  JINA_MIN_CONTENT_CHARS?: string;                  // default: "500" — below this, try Jina full text
  JINA_MAX_CALLS_PER_DAY?: string;                  // default: "50" — daily Jina attempt budget (all attempts)
  JINA_API_KEY?: string;                            // optional — raises Jina rate limits
  RSS_BRIEF_MODEL?: string;                         // default: DUPLICATE_AI_JUDGE_MODEL or AI_SCORING_MODEL
  RSS_BRIEF_MAX_CALLS_PER_DAY?: string;             // default: "20" — daily RSS brief generation budget
  RSS_BRIEF_TIMEOUT_SEC?: string;                   // default: "25" — per-brief Claude call timeout
  DUPLICATE_AI_JUDGE_ENABLED?: string;             // default: "false" — Claude duplicate judge before translation/queue
  DUPLICATE_AI_JUDGE_MODEL?: string;               // default: AI_SCORING_MODEL
  DUPLICATE_AI_JUDGE_BATCH_SIZE?: string;          // default: "5"
  DUPLICATE_AI_JUDGE_MAX_PRIORS?: string;          // default: "20"
  DUPLICATE_AI_JUDGE_WINDOW_HOURS?: string;        // default: STORY_INTELLIGENCE_WINDOW_HOURS or "72"
  DUPLICATE_AI_JUDGE_MAX_TEXT_CHARS?: string;      // default: "220"
  DUPLICATE_AI_JUDGE_MAX_CALLS_PER_DAY?: string;   // default: "14"
  DUPLICATE_AI_JUDGE_CONFIDENCE_THRESHOLD?: string;// default: "0.78"
  AI_COST_ATTRIBUTION_ENABLED?: string;             // default: "false" — write ai_usage_attribution rows
  AI_USAGE_ATTRIBUTION_RETENTION_DAYS?: string;     // default: "45"
  SOURCE_REPUTATION_WEIGHTING_ENABLED?: string;     // default: "false" — weight rotation by source reputation
  SOURCE_REPUTATION_EXPLORATION_PCT?: string;       // default: "20"
  SOURCE_REPUTATION_MIN_SAMPLE?: string;            // default: "20"
  SOURCE_REPUTATION_MAX_WEIGHT?: string;            // default: "2.0"
  SOURCE_REPUTATION_MIN_WEIGHT?: string;            // default: "0.3"
  SOURCE_REPUTATION_RECENT_RUN_COOLDOWN_SLOTS?: string; // default: "6" — cool down recently-run sources
  QUEUE_QUALITY_CONTROLLER_ENABLED?: string;        // default: "false" — steer rotation toward diversity
  QUEUE_QUALITY_MIN_UNIQUE_SOURCES_NEXT_6H?: string;  // default: "2"
  QUEUE_QUALITY_MAX_SOURCE_SHARE_NEXT_24H?: string;   // default: "0.4"
  QUEUE_QUALITY_MIN_UNIQUE_STORIES_NEXT_6H?: string;  // default: "2"
  CAPTION_QUALITY_REPAIR_ENABLED?: string;          // default: "false" — repair-first caption quality
  CAPTION_QUALITY_REJECT_ENABLED?: string;          // default: "false" — reject if still low after repair
  CAPTION_QUALITY_MIN_SCORE?: string;               // default: "70"

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
  /** Optional full article body (RSS content:encoded / extracted full text).
   *  Scoring uses `text` (title + summary); the RSS brief step uses `fullText`. */
  fullText?: string;
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

export type EditorialClaimType =
  | 'fact'
  | 'opinion'
  | 'forecast'
  | 'allegation'
  | 'estimate'
  | 'unknown';

export interface EditorialFactFrame {
  /** Neutral source-supported statement of the main event; not a ready-made title. */
  headlineFact: string;
  /** Whether the central statement is confirmed fact, opinion, prediction, etc. */
  claimType: EditorialClaimType;
  /** Explicit speaker/source for opinions, forecasts, allegations, and estimates. */
  attribution: string;
  /** Names, figures, dates, or terms that the rewrite should preserve when relevant. */
  mustInclude: string[];
  /** Unsupported conclusions the caption must not introduce. */
  forbiddenInferences: string[];
}

export interface AIGateResult {
  publish: boolean;
  score: number;
  riskLevel: RiskLevel;
  riskFlags: string[];
  topicFingerprint: string;
  publishPriority: PublishPriority;
  translations: Record<string, TranslationOutput>;
  /** Optional Claude-produced factual boundary passed to the caption writer.
   *  It does not affect selection, scoring, or publishing eligibility. */
  editorialFactFrame?: EditorialFactFrame | null;
  /** Phase 6K (observe-only): structured story key derived from the model's
   *  primary_entities/event_type/canonical_date. Logged, never used to reject yet. */
  storyKey?: string | null;
  /** Phase 6K: the parsed structured fields behind storyKey (for queryable storage). */
  storyFields?: { primaryEntities: string[]; eventType: string; canonicalDate: string } | null;
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
 * pending     → waiting_for_ai_score / منتظر scoring
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
  | 'skipped'
  | 'needs_translation'; // PATCH E: all channels lacked a translation; retried by backlog drain

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
