-- ══════════════════════════════════════════════════════════════
-- 0010_editorial_controls.sql
-- Phase 9: editorial prompt controls per category and channel
-- ══════════════════════════════════════════════════════════════

-- Category-level editorial/scoring guidance
ALTER TABLE categories ADD COLUMN editorial_guidelines TEXT;
ALTER TABLE categories ADD COLUMN selection_criteria TEXT;
ALTER TABLE categories ADD COLUMN rejection_criteria TEXT;
ALTER TABLE categories ADD COLUMN required_context TEXT;
ALTER TABLE categories ADD COLUMN avoid_duplicate_people_stories INTEGER NOT NULL DEFAULT 1;

-- Channel/language-level rewrite controls
ALTER TABLE channels ADD COLUMN editorial_mode TEXT NOT NULL DEFAULT 'news';
ALTER TABLE channels ADD COLUMN audience_level TEXT NOT NULL DEFAULT 'intermediate';
ALTER TABLE channels ADD COLUMN caption_style TEXT NOT NULL DEFAULT 'contextual';
ALTER TABLE channels ADD COLUMN creativity_level REAL NOT NULL DEFAULT 0.2;
ALTER TABLE channels ADD COLUMN caption_max_chars INTEGER NOT NULL DEFAULT 1200;
ALTER TABLE channels ADD COLUMN caption_short_max_chars INTEGER NOT NULL DEFAULT 280;
ALTER TABLE channels ADD COLUMN language_prompt TEXT;
ALTER TABLE channels ADD COLUMN terminology_notes TEXT;
ALTER TABLE channels ADD COLUMN forbidden_phrases TEXT DEFAULT '[]';
