-- ══════════════════════════════════════════════════════════════
-- 0017_market_trending_text_media_sources.sql
-- Split Market Trending experiment into explicit Text and Media Apify sources.
--
-- Safety:
--   - Both new sources are disabled by default.
--   - Dataset IDs are placeholders and must be replaced before enabling.
--   - Each Apify task must use its own explicit source_id webhook.
-- ══════════════════════════════════════════════════════════════

-- Keep the original Phase 6 seed disabled as a legacy placeholder.
UPDATE apify_sources
SET
  label = 'Crypto X Market Trending Legacy Placeholder',
  enabled = 0,
  source_config = json_set(
    COALESCE(source_config, '{}'),
    '$.rollout_phase', 'split_into_text_and_media',
    '$.deprecated_placeholder', true,
    '$.note', 'Use src_market_trending_x_text and src_market_trending_x_media instead.'
  )
WHERE id = 'src_market_trending_x';

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
  'src_market_trending_x_text',
  'crypto',
  'x',
  'PLACEHOLDER_REPLACE_BEFORE_ENABLE',
  'Crypto X Market Trending Text',
  0,
  NULL,
  NULL,
  NULL,
  '{"rollout_phase":"prepared","variant":"text","requires_monitoring":true,"recommended_query":"(bitcoin OR ethereum OR crypto OR stablecoin OR liquidation OR ETF OR DeFi OR onchain OR market OR Fed OR inflation OR rate_cut OR spot_ETF OR altseason) min_faves:100 -filter:media -filter:replies lang:en","webhook_source_id":"src_market_trending_x_text"}'
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
) VALUES (
  'src_market_trending_x_media',
  'crypto',
  'x',
  'PLACEHOLDER_REPLACE_BEFORE_ENABLE',
  'Crypto X Market Trending Media',
  0,
  NULL,
  NULL,
  NULL,
  '{"rollout_phase":"prepared","variant":"media","requires_monitoring":true,"recommended_query":"(bitcoin OR ethereum OR crypto OR stablecoin OR liquidation OR ETF OR DeFi OR onchain OR market OR Fed OR inflation OR rate_cut OR spot_ETF OR altseason) min_faves:100 filter:media -filter:replies lang:en","webhook_source_id":"src_market_trending_x_media"}'
);
