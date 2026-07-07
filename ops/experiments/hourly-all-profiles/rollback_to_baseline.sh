#!/usr/bin/env bash
set -euo pipefail

BASELINE="${BASELINE:-ops/experiments/hourly-all-profiles/snapshots/baseline_20260707_144200}"

if [ ! -f "$BASELINE/rollback_to_this_baseline.sh" ]; then
  echo "STOP: baseline rollback missing: $BASELINE/rollback_to_this_baseline.sh"
  exit 1
fi

echo "=== ROLLBACK TO BASELINE ==="
bash "$BASELINE/rollback_to_this_baseline.sh"
