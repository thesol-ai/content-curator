# Baseline snapshot

Created at: 20260707_144200

Purpose:
Restore the current stable production control-plane setup before the hourly-all-profiles experiment.

This snapshot restores:
- wrangler.toml
- crypto_fa_pilot channel config
- crypto category config
- crypto apify_sources
- crypto source_accounts
- settings

This snapshot does NOT restore runtime event data:
- publish_queue
- discovery_items
- discovery_runs
- run_events
- ai_usage
- ai_candidate_queue

Reason:
Runtime data may include real posts/events created during the 48h test. Restoring it blindly can resurrect published posts or cause duplicate publishing.
