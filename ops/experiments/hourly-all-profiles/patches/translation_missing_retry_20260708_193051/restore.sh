#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

cp "$DIR/candidate-queue.ts.before" apps/worker-api/src/services/candidate-queue.ts
cp "$DIR/types.ts.before" apps/worker-api/src/types.ts
cp "$DIR/wrangler.toml.before" wrangler.toml

echo "RESTORED_FROM=$DIR"
echo "Run: npm run typecheck && npm run deploy"
