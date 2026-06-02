-- ══════════════════════════════════════════════════════════════
-- 0008_ai_usage.sql — AI usage/cost observability + budget guardrails
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ai_usage (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL, -- anthropic | gemini | openai | claude
  purpose       TEXT NOT NULL, -- scoring | translation
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'success', -- success | failed | skipped
  error_message TEXT,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_provider_purpose ON ai_usage(provider, purpose, status, created_at DESC);
