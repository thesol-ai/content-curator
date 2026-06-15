-- ══════════════════════════════════════════════════════════════
-- 0020_seed_crypto_discovery_sources.sql
-- Discovery lane (no `from:` cohort) — the only source that returned real
-- data in production testing (20 real / 0 mock). Account-based `from:` sources
-- returned 90–100% actor mock placeholders.
--
-- Why ON CONFLICT DO UPDATE (not INSERT OR IGNORE):
--   These two source ids were already created MANUALLY in production during
--   live testing. A plain INSERT OR IGNORE would no-op and silently fail to
--   set enabled / apify_task_id / source_config. DO UPDATE makes the migration
--   authoritative and idempotent.
--
-- Safety:
--   - discovery_top: enabled=1 (the proven healthy lane).
--   - discovery_latest: enabled=0 (turn on only after 24h of low mock_pct).
--   - last_dataset_id is intentionally NOT overwritten, to preserve run history.
--   - Real task id below is the one used in production testing.
-- ══════════════════════════════════════════════════════════════

INSERT INTO apify_sources (
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
  'src_crypto_x_discovery_top',
  'crypto',
  'x',
  'placeholder_discovery_top',
  'Crypto X Discovery Top',
  1,
  NULL,
  'o5POUfmo9AJ9BUzIT',
  NULL,
  '{"mode":"discovery","queryType":"Top","requires_monitoring":true,"webhook_source_id":"src_crypto_x_discovery_top"}'
),
(
  'src_crypto_x_discovery_latest',
  'crypto',
  'x',
  'placeholder_discovery_latest',
  'Crypto X Discovery Latest',
  0,
  NULL,
  'o5POUfmo9AJ9BUzIT',
  NULL,
  '{"mode":"discovery","queryType":"Latest","requires_monitoring":true,"webhook_source_id":"src_crypto_x_discovery_latest"}'
)
ON CONFLICT(id) DO UPDATE SET
  category_id   = excluded.category_id,
  platform      = excluded.platform,
  label         = excluded.label,
  enabled       = excluded.enabled,
  apify_task_id = excluded.apify_task_id,
  source_config = excluded.source_config;
  -- NOTE: last_dataset_id and apify_dataset_id deliberately left untouched
  -- on conflict so existing rotation history is preserved.

-- ── Optional, run SEPARATELY after you confirm discovery is healthy ──
-- Disable the mock-heavy account-based sources to stop burning Apify cost.
-- Do NOT run blindly: confirm with source-health-check.sql first (see its
-- threshold: mock_pct >= 90 AND raw_count >= 50 across >= 3 fetch events).
--
-- UPDATE apify_sources SET enabled = 0
--   WHERE id IN ('src_market_trending_x_media', 'src_crypto_x_news_text');
