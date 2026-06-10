-- ══════════════════════════════════════════════════════════════
-- 0016_market_trending_source_seed.sql — Phase 6
-- Seed disabled market-trending Apify source for controlled experiment
--
-- Safety rules:
--   - enabled=0: this source cannot affect production until explicitly enabled.
--   - apify_dataset_id is a placeholder and must be replaced before enabling.
--   - webhook rollout must use source_id=src_market_trending_x to avoid dataset ambiguity.
--   - this migration does not change runtime config, Apify schedules, Telegram publishing,
--     or AI candidate backlog flags.
-- ══════════════════════════════════════════════════════════════

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
) VALUES (
  'src_market_trending_x',
  'crypto',
  'x',
  'PLACEHOLDER_REPLACE_BEFORE_ENABLE',
  'Crypto X Market Trending',
  0,
  NULL,
  NULL,
  NULL,
  '{"rollout_phase":"experiment","requires_monitoring":true,"recommended_query":"(bitcoin OR ethereum OR crypto OR stablecoin OR liquidation OR ETF OR DeFi OR onchain OR market OR Fed) min_faves:100 -filter:replies lang:en","webhook_source_id":"src_market_trending_x"}'
);
