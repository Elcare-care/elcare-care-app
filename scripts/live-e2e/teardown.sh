#!/usr/bin/env bash
# ============================================================
# scripts/live-e2e/teardown.sh
#
# Tears down the live integration environment. Collects logs first
# unless --skip-logs is passed, since the whole point of this
# environment is diagnosing failures that mocked tests can't catch —
# losing the logs on teardown would defeat that.
#
# Usage: ./scripts/live-e2e/teardown.sh [--skip-logs] [--keep-contracts]
#
# Flags:
#   --skip-logs       Don't run collect-logs.sh before tearing down.
#   --keep-contracts  Leave scripts/deploy/deployed_ids.env and
#                     scripts/live-e2e/seed_ids.env in place so the
#                     next run can pass --skip-deploy. Contracts are
#                     immutable on testnet regardless — this only
#                     controls whether local state is wiped.
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.live-e2e.yml"
LIVE_ENV_FILE="$SCRIPT_DIR/.env.live-e2e"

SKIP_LOGS=false
KEEP_CONTRACTS=false

for arg in "$@"; do
  case "$arg" in
    --skip-logs) SKIP_LOGS=true ;;
    --keep-contracts) KEEP_CONTRACTS=true ;;
    -h|--help) grep '^#' "$0" | grep -v '^#!/' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ERROR: Unknown flag: $arg"; exit 1 ;;
  esac
done

if ! $SKIP_LOGS; then
  "$SCRIPT_DIR/collect-logs.sh" || echo "  WARNING: log collection failed, continuing with teardown."
fi

echo "Stopping and removing containers + volumes..."
if [[ -f "$LIVE_ENV_FILE" ]]; then
  docker compose -f "$COMPOSE_FILE" --env-file "$LIVE_ENV_FILE" down -v --remove-orphans
else
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans
fi

if ! $KEEP_CONTRACTS; then
  rm -f "$SCRIPT_DIR/seed_ids.env" "$LIVE_ENV_FILE"
  echo "Cleared local seed/env state (deployed contracts on testnet are unaffected)."
fi

echo "✓ Teardown complete."
