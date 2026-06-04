-- ══════════════════════════════════════════════════════════════
-- 0011_content_filter_controls.sql
-- Reply/quote/retweet and media/text-only controls
-- ══════════════════════════════════════════════════════════════

-- ── Discovery item metadata from source platforms ─────────────
ALTER TABLE discovery_items ADD COLUMN is_reply INTEGER NOT NULL DEFAULT 0;
ALTER TABLE discovery_items ADD COLUMN is_retweet INTEGER NOT NULL DEFAULT 0;
ALTER TABLE discovery_items ADD COLUMN is_quote INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_discovery_items_reply_flags
  ON discovery_items(category_id, is_reply, is_retweet, is_quote, status);

-- ── Category-level content filters ───────────────────────────
ALTER TABLE categories ADD COLUMN allow_replies INTEGER NOT NULL DEFAULT 0;
ALTER TABLE categories ADD COLUMN allow_retweets INTEGER NOT NULL DEFAULT 1;
ALTER TABLE categories ADD COLUMN allow_quotes INTEGER NOT NULL DEFAULT 1;

-- allow | penalize | reject
ALTER TABLE categories ADD COLUMN text_only_policy TEXT NOT NULL DEFAULT 'allow';

-- Optional score floors used after AI scoring. NULL means no extra floor.
ALTER TABLE categories ADD COLUMN min_score_for_text_only REAL;
ALTER TABLE categories ADD COLUMN min_score_for_media REAL;
