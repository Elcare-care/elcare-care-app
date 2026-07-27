#!/usr/bin/env bash
# ============================================================
# scripts/live-e2e/collect-logs.sh
#
# Dumps container logs, contract/seed IDs, and a snapshot of indexer DB
# state to scripts/live-e2e/artifacts/<timestamp>/ for post-mortem
# diagnosis. Safe to run whether or not the stack is currently healthy —
# every step is best-effort so one failing capture never blocks the rest.
#
# Usage: ./scripts/live-e2e/collect-logs.sh
# ============================================================
set -uo pipefail  # deliberately NOT -e: every capture step is best-effort

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.live-e2e.yml"
LIVE_ENV_FILE="$SCRIPT_DIR/.env.live-e2e"

TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
OUT_DIR="$SCRIPT_DIR/artifacts/$TIMESTAMP"
mkdir -p "$OUT_DIR"

echo "Collecting live-e2e diagnostics into $OUT_DIR ..."

COMPOSE_ARGS=(-f "$COMPOSE_FILE")
[[ -f "$LIVE_ENV_FILE" ]] && COMPOSE_ARGS+=(--env-file "$LIVE_ENV_FILE")

# ── Container logs, one file per service ──────────────────────
for service in postgres redis indexer frontend; do
  docker compose "${COMPOSE_ARGS[@]}" logs --no-color "$service" \
    > "$OUT_DIR/${service}.log" 2>&1
done

# ── Container status ────────────────────────────────────────────
docker compose "${COMPOSE_ARGS[@]}" ps > "$OUT_DIR/compose_ps.txt" 2>&1

# ── Indexer health + a sample of tracked resources ────────────
INDEXER_URL="http://localhost:4100"
curl -s "$INDEXER_URL/health?details=1" > "$OUT_DIR/indexer_health.json" 2>&1
curl -s "$INDEXER_URL/listings?limit=20" > "$OUT_DIR/indexer_listings_sample.json" 2>&1

# ── Chain-side state for the seeded resources, if known ────────
if [[ -f "$SCRIPT_DIR/seed_ids.env" ]]; then
  cp "$SCRIPT_DIR/seed_ids.env" "$OUT_DIR/seed_ids.env"
fi
if [[ -f "$REPO_ROOT/scripts/deploy/deployed_ids.env" ]]; then
  cp "$REPO_ROOT/scripts/deploy/deployed_ids.env" "$OUT_DIR/deployed_ids.env"
fi

# ── Postgres row counts for the core indexed tables ────────────
docker compose "${COMPOSE_ARGS[@]}" exec -T postgres \
  psql -U postgres -d marketplace_indexer_live \
  -c "SELECT 'listings' AS table, count(*) FROM \"Listing\" UNION ALL SELECT 'auctions', count(*) FROM \"Auction\" UNION ALL SELECT 'offers', count(*) FROM \"Offer\";" \
  > "$OUT_DIR/db_row_counts.txt" 2>&1

echo "✓ Diagnostics written to $OUT_DIR"
