// ══════════════════════════════════════════════════════════════
// types.ts — shared types for the entire Worker
// ══════════════════════════════════════════════════════════════

export interface Env {
  DB: D1Database;

  // ── Secrets ────────────────────────────────────────────────
  APIFY_TOKEN: string;
  ANTHROPIC_API_KEY: string;   // برای Scoring (Claude Haiku)
  GEMINI_API_KEY: string;      // برای Translation (Gemini)
  OPENAI_API_KEY: string;      // برای Translation (OpenAI) — آلترناتیو
  TELEGRAM_BOT_TOKEN: string;
  INTERNAL_API_SECRET: string;

  // ExecutionContext
  ctx?: ExecutionContext;

  // ── AI — Scoring (Claude) ──────────────────────────────────
  AI_SCORING_MODEL: string;            // پیش‌فرض: claude-haiku-4-5-20251001
  AI_SCORE_THRESHOLD_DEFAULT: string;
  AI_MAX_CALLS_PER_DAY: string;
  AI_DAILY_TOKEN_BUDGET: string;
  AI_MAX_CANDIDATES_PER_RUN: string;
  AI_MAX_TEXT_CHARS_PER_ITEM: string;
  AI_MAX_OUTPUT_TOKENS: string;
  AI_MAX_RETRIES: string;

  // ── AI — Translation ───────────────────────────────────────
  TRANSLATION_PROVIDER: string;        // 'gemini' | 'openai' | 'claude'
  TRANSLATION_MODEL: string;           // مثال: gemini-2.5-flash-lite, gpt-4o-mini

  // Apify
  APIFY_CURATION_ENABLED: string;
  APIFY_CURATION_DRY_RUN: string;
  APIFY_MAX_ITEMS_PER_SOURCE: string;

  // Telegram
  TELEGRAM_FINAL_PUBLISH_ENABLED: string;
  TELEGRAM_PUBLISH_SCHEDULER_ENABLED: string;
  TELEGRAM_PUBLISH_DUE_LIMIT: string;

  // Media
  MEDIA_PROCESSING_MODE: string;

  // Runtime
  ENVIRONMENT: string;
  LOG_LEVEL: string;
}

// ── Platform types ────────────────────────────────────────────

export type Platform = 'x' | 'instagram' | 'linkedin' | 'rss';

export type MediaType = 'image' | 'video';

export type TelegramMethod =
  | 'sendMessage'
  | 'sendPhoto'
  | 'sendVideo'
  | 'sendMediaGroup'
  | 'sendMessageWithLink';

export type PublishPriority = 'breaking' | 'high' | 'normal' | 'low';

export type RiskLevel = 'low' | 'medium' | 'high';

export type ItemStatus =
  | 'pending'
  | 'ai_processing'
  | 'ai_selected'
  | 'ai_rejected'
  | 'queued'
  | 'duplicate'
  | 'error';

export type QueueStatus =
  | 'scheduled'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'retry'
  | 'cancelled';

// ── Normalized item (common model across all platforms) ───────

export interface MediaItem {
  type: MediaType;
  url: string;
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
  publishedAt: number; // unix timestamp
  text: string;
  media: MediaItem[];
  engagementLikes: number;
  engagementShares: number;
  engagementViews: number;
  /** true = CDN URLs expire در چند ساعت → باید سریع publish شود */
  mediaUrlExpiresSoon: boolean;
}

// ── AI Gate output ────────────────────────────────────────────

export interface TranslationOutput {
  captionShort: string; // ≤900 chars — برای روی media
  captionFull: string;  // ≤3500 chars — متن کامل
  hashtags: string[];
}

export interface AIGateResult {
  publish: boolean;
  score: number;
  riskLevel: RiskLevel;
  riskFlags: string[];
  topicFingerprint: string;
  publishPriority: PublishPriority;
  translations: Record<string, TranslationOutput>; // key = language code
}

// ── Category config (from D1) ─────────────────────────────────

export interface CategoryRow {
  id: string;
  label: string;
  prompt_profile: string;
  score_threshold: number;
  freshness_hours: number;
  media_mode: 'preferred' | 'optional' | 'disabled';
  language_targets: string; // JSON array string
  enabled: number;
}

export interface ChannelRow {
  id: string;
  category_id: string;
  telegram_chat_id: string;
  language: string;
  timezone: string;
  allowed_windows: string; // JSON
  blocked_windows: string; // JSON
  max_per_day: number;
  max_per_hour: number;
  min_gap_minutes: number;
  publish_enabled: number;
  enabled: number;
}

export interface ApifySourceRow {
  id: string;
  category_id: string;
  platform: string;
  apify_dataset_id: string;
  label: string | null;
  enabled: number;
}

// ── Media resolver output ─────────────────────────────────────

export interface MediaResolution {
  method: TelegramMethod;
  mediaUrls: string[];
  useShortCaption: boolean;
}
