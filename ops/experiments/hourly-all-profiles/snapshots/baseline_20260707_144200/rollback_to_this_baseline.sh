#!/usr/bin/env bash
set -euo pipefail

DB="${DB:-content-curator-db-v2}"
SNAP_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== RESTORE wrangler.toml FROM BASELINE ==="
cp "$SNAP_DIR/wrangler.toml.baseline" wrangler.toml

echo "=== TYPECHECK BEFORE DEPLOY ==="
npm run typecheck

echo "=== DEPLOY BASELINE CONFIG ==="
npm run deploy

echo "=== RESTORE DB CONTROL-PLANE CONFIG ==="
npx wrangler d1 execute "$DB" --remote --env production --config wrangler.toml --file "$SNAP_DIR/rollback_control_plane.sql"

echo "=== VERIFY RESTORED CHANNEL ==="
npx wrangler d1 execute "$DB" --remote --env production --config wrangler.toml --command "
SELECT id, enabled, publish_enabled, timezone, allowed_windows, blocked_windows, max_per_day, max_per_hour, min_gap_minutes
FROM channels
WHERE id='crypto_fa_pilot';
"

echo "=== VERIFY RESTORED APIFY SOURCES ==="
npx wrangler d1 execute "$DB" --remote --env production --config wrangler.toml --command "
SELECT id, category_id, enabled, label, apify_dataset_id
FROM apify_sources
WHERE category_id='crypto'
ORDER BY id;
"

echo "=== ROLLBACK DONE ==="
