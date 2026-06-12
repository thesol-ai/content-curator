-- ══════════════════════════════════════════════════════════════
-- 0018_future_disabled_categories_seed.sql
-- First future non-crypto categories, intentionally disabled.
--
-- Categories:
--   - film
--   - gaming
--   - ai
--
-- Safety:
--   - category.enabled=0 for every category.
--   - channel.publish_enabled=0 and channel.enabled=0 for every channel.
--   - apify_sources.enabled=0 for every source.
--   - Apify dataset/task values are placeholders/null and must be replaced before any dry-run rollout.
--   - Source strategies are no-op in code, so even accidental source enablement cannot create rotation plans in this phase.
--   - This migration does not change runtime config, Telegram publishing, scheduler flags, market snapshot, or crypto behavior.
-- ══════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO categories (
  id,
  label,
  prompt_profile,
  score_threshold,
  freshness_hours,
  media_mode,
  language_targets,
  enabled,
  allow_replies,
  allow_retweets,
  allow_quotes,
  text_only_policy,
  min_score_for_text_only,
  min_score_for_media
) VALUES
(
  'movie',
  'Movies & Cinema',
  'default_editorial',
  76,
  72,
  'optional',
  '["fa"]',
  0,
  0,
  1,
  1,
  'allow',
  NULL,
  NULL
),
(
  'gaming',
  'Gaming',
  'default_editorial',
  76,
  72,
  'optional',
  '["fa"]',
  0,
  0,
  1,
  1,
  'allow',
  NULL,
  NULL
),
(
  'ai',
  'Artificial Intelligence',
  'default_editorial',
  78,
  48,
  'optional',
  '["fa"]',
  0,
  0,
  1,
  1,
  'allow',
  NULL,
  NULL
);

INSERT OR IGNORE INTO channels (
  id,
  category_id,
  telegram_chat_id,
  language,
  timezone,
  allowed_windows,
  blocked_windows,
  max_per_day,
  max_per_hour,
  min_gap_minutes,
  publish_enabled,
  enabled
) VALUES
(
  'movie_fa_dry_run',
  'movie',
  'DISABLED_REPLACE_BEFORE_ENABLE',
  'fa',
  'Asia/Tehran',
  '["10:00-13:00","17:00-21:00"]',
  '["00:00-08:00"]',
  3,
  1,
  90,
  0,
  0
),
(
  'gaming_fa_dry_run',
  'gaming',
  'DISABLED_REPLACE_BEFORE_ENABLE',
  'fa',
  'Asia/Tehran',
  '["10:00-13:00","17:00-21:00"]',
  '["00:00-08:00"]',
  3,
  1,
  90,
  0,
  0
),
(
  'ai_fa_dry_run',
  'ai',
  'DISABLED_REPLACE_BEFORE_ENABLE',
  'fa',
  'Asia/Tehran',
  '["10:00-13:00","17:00-21:00"]',
  '["00:00-08:00"]',
  4,
  1,
  90,
  0,
  0
);

INSERT OR IGNORE INTO apify_sources (
  id,
  category_id,
  platform,
  apify_dataset_id,
  label,
  enabled,
  apify_actor_id,
  apify_task_id,
  last_dataset_id,
  source_config
) VALUES
(
  'src_movie_x_news_text',
  'movie',
  'x',
  'PLACEHOLDER_REPLACE_BEFORE_ENABLE',
  'Movie X News Text Disabled Placeholder',
  0,
  NULL,
  NULL,
  NULL,
  '{"rollout_phase":"phase_05_disabled_seed","category":"movie","variant":"text","requires_monitoring":true,"dry_run_only":true,"recommended_query":"(film OR cinema OR movie OR trailer OR director OR casting OR box_office OR festival OR streaming OR studio) -filter:media -filter:replies lang:en","webhook_source_id":"src_movie_x_news_text","note":"Do not enable in Phase 05."}'
),
(
  'src_gaming_x_news_text',
  'gaming',
  'x',
  'PLACEHOLDER_REPLACE_BEFORE_ENABLE',
  'Gaming X News Text Disabled Placeholder',
  0,
  NULL,
  NULL,
  NULL,
  '{"rollout_phase":"phase_05_disabled_seed","category":"gaming","variant":"text","requires_monitoring":true,"dry_run_only":true,"recommended_query":"(gaming OR game OR videogame OR console OR PlayStation OR Xbox OR Nintendo OR Steam OR esports OR studio OR patch OR release) -filter:media -filter:replies lang:en","webhook_source_id":"src_gaming_x_news_text","note":"Do not enable in Phase 05."}'
),
(
  'src_ai_x_news_text',
  'ai',
  'x',
  'PLACEHOLDER_REPLACE_BEFORE_ENABLE',
  'AI X News Text Disabled Placeholder',
  0,
  NULL,
  NULL,
  NULL,
  '{"rollout_phase":"phase_05_disabled_seed","category":"ai","variant":"text","requires_monitoring":true,"dry_run_only":true,"recommended_query":"(AI OR artificial_intelligence OR LLM OR model OR benchmark OR research OR OpenAI OR Anthropic OR GoogleDeepMind OR inference OR agent OR safety) -filter:media -filter:replies lang:en","webhook_source_id":"src_ai_x_news_text","note":"Do not enable in Phase 05."}'
);
