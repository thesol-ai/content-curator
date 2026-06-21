-- ══════════════════════════════════════════════════════════════
-- 0021_rss_sources.sql
-- Independent RSS feed sources (zero Apify cost — fetched directly over HTTP).
--
-- Kept separate from apify_sources (whose apify_dataset_id NOT NULL is
-- meaningless for a feed). Schedule state (last_checked_at, poll interval,
-- failure counters) and content watermark (last_seen_item_url / _published_at)
-- are distinct columns so polling cadence and "what's new" are tracked
-- independently. source_account is canonical and mandatory because source caps
-- and fair-source behavior key on NormalizedItem.sourceAccount.
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS rss_sources (
  id                          TEXT PRIMARY KEY,
  category_id                 TEXT NOT NULL,
  feed_url                    TEXT NOT NULL,
  label                       TEXT NOT NULL,
  source_account              TEXT NOT NULL,
  enabled                     INTEGER NOT NULL DEFAULT 1,
  poll_interval_minutes       INTEGER NOT NULL DEFAULT 30,
  last_checked_at             TEXT,
  last_success_at             TEXT,
  last_http_status            INTEGER,
  last_error                  TEXT,
  consecutive_failures        INTEGER NOT NULL DEFAULT 0,
  etag                        TEXT,
  last_modified               TEXT,
  last_seen_item_url          TEXT,
  last_seen_item_published_at INTEGER,
  created_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                  TEXT
);

CREATE INDEX IF NOT EXISTS idx_rss_sources_category
  ON rss_sources(category_id, enabled);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rss_sources_feed_url_unique
  ON rss_sources(feed_url);

-- Seed the initial crypto feeds. DO NOTHING on conflict keeps any operator
-- edits (enabled/interval) authoritative after first apply.
INSERT INTO rss_sources (id, category_id, feed_url, label, source_account, enabled, poll_interval_minutes)
VALUES
  ('rss_crypto_coindesk',     'crypto', 'https://www.coindesk.com/arc/outboundfeeds/rss-full-text?outputType=xml', 'CoinDesk (full text)', 'coindesk',     1, 30),
  ('rss_crypto_cointelegraph','crypto', 'https://cointelegraph.com/rss',                                            'Cointelegraph',        'cointelegraph',1, 30),
  ('rss_crypto_theblock',     'crypto', 'https://www.theblock.co/rss.xml',                                          'The Block',            'theblock',     1, 30),
  ('rss_crypto_cryptoslate',  'crypto', 'https://cryptoslate.com/feed/',                                            'CryptoSlate',          'cryptoslate',  1, 30)
ON CONFLICT(feed_url) DO NOTHING;
