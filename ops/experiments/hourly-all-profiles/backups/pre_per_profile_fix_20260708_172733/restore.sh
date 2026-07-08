#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

cp "$DIR/curation-orchestrator.ts" apps/worker-api/src/services/curation-orchestrator.ts
cp "$DIR/crypto-sources.ts" apps/worker-api/src/categories/crypto/sources.ts
cp "$DIR/apify-rotation-runner.ts" apps/worker-api/src/services/apify-rotation-runner.ts
cp "$DIR/fair-source-picker.ts" apps/worker-api/src/services/fair-source-picker.ts
cp "$DIR/wrangler.toml" wrangler.toml

echo "RESTORED_FROM_BACKUP=$DIR"
echo "Now run: npm run typecheck && npm run deploy"
