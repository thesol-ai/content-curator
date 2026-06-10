-- ══════════════════════════════════════════════════════════════
-- 0007_apify_extraction_diagnostics.sql
-- Phase 7: Apify normalization diagnostics
-- ══════════════════════════════════════════════════════════════

ALTER TABLE discovery_items ADD COLUMN media_expected_count INTEGER;
ALTER TABLE discovery_items ADD COLUMN media_extracted_count INTEGER;
ALTER TABLE discovery_items ADD COLUMN media_extraction_warnings TEXT DEFAULT '[]';
