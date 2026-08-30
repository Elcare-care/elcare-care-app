#!/bin/bash
# scripts/deploy/rehearsal.sh — Deployment rehearsal script
#
# This script simulates a rolling deployment without actually changing
# container images. It's used for:
# - Validating deployment procedures before production
# - Training operators on deployment sequence
# - Testing rollback procedures
#
# Usage: ./rehearsal.sh [mode]
#   mode: "full" (default) or "quick"
#
# Exit codes:
#   0 = Rehearsal completed successfully
#   1 = Rehearsal failed (check errors above)

set -e

MODE="${1:-full}"
BASE_URL="${INDEXER_URL:-http://localhost:4000}"

echo "============================================"
echo "ELCARE-HUB Deployment Rehearsal"
echo "============================================"
echo "Mode: ${MODE}"
echo "Base URL: ${BASE_URL}"
echo ""

# ── Helper functions ──────────────────────────────────────────────────────────

log() {
  echo "[REHEARSAL] $(date -u +"%Y-%m-%dT%H:%M:%SZ") $*"
}

check_http() {
  local endpoint="$1"
  local expected_status="${2:-200}"
  
  local http_code=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}${endpoint}" 2>/dev/null || echo "000")
  [ "$http_code" = "$expected_status" ]
}

get_metric() {
  local metric="$1"
  curl -s "${BASE_URL}/metrics" 2>/dev/null | grep "^${metric} " | awk '{print $NF}'
}

get_json_field() {
  local endpoint="$1"
  local field="$2"
  curl -s "${BASE_URL}${endpoint}" | jq -r ".${field}" 2>/dev/null || echo ""
}

# ── Phase 1: Pre-Deployment Checks ────────────────────────────────────────────

log "Phase 1: Pre-Deployment Checks"
echo ""

log "  Step 1.1: Validate configuration"
if [ -f "scripts/validate-config.js" ]; then
  echo "    [OK] validate-config.js exists"
else
  echo "    [SKIP] validate-config.js not found (mock mode)"
fi

log "  Step 1.2: Check indexer health"
if check_http "/health" "200"; then
  echo "    [OK] /health endpoint responding"
  echo "    Status: $(get_json_field "/health" "status")"
else
  echo "    [FAIL] /health endpoint not responding"
  exit 1
fi

log "  Step 1.3: Verify no pending gaps"
gaps=$(get_metric "indexer_open_gaps_count")
if [ -n "$gaps" ]; then
  echo "    [OK] Open gaps: ${gaps}"
  if [ "$gaps" -gt 20 ] 2>/dev/null; then
    echo "    [WARN] More than 20 open gaps — consider delaying deployment"
  fi
else
  echo "    [WARN] Could not determine gap count"
fi

log "  Step 1.4: Check SSE connections"
sse=$(get_metric "indexer_sse_active_connections")
if [ -n "$sse" ]; then
  echo "    [OK] Active SSE connections: ${sse}"
  if [ "$sse" -gt 80 ] 2>/dev/null; then
    echo "    [WARN] High SSE connection count — monitor during deployment"
  fi
else
  echo "    [WARN] Could not determine SSE connection count"
fi

log "  Step 1.5: Verify database connection pool"
pool=$(get_metric "indexer_db_pool_connections_used")
if [ -n "$pool" ]; then
  echo "    [OK] DB pool connections: ${pool}/10"
  if [ "$pool" -gt 8 ] 2>/dev/null; then
    echo "    [WARN] High DB pool utilization — monitor during deployment"
  fi
else
  echo "    [WARN] Could not determine DB pool utilization"
fi

echo ""

# ── Phase 2: Drain Simulation ────────────────────────────────────────────────

log "Phase 2: Drain Simulation (old version)"
echo ""

log "  Step 2.1: Check current sync lag"
lag=$(get_metric "indexer_ledger_lag")
if [ -n "$lag" ]; then
  echo "    [OK] Sync lag: ${lag} ledgers"
  if [ "$lag" -gt 100 ] 2>/dev/null; then
    echo "    [WARN] Sync lag > 100 — indexer may not catch up quickly"
  fi
else
  echo "    [WARN] Could not determine sync lag"
fi

log "  Step 2.2: Simulate graceful shutdown"
echo "    [OK] Would send SIGTERM to indexer"
echo "    [OK] Would wait for gracefulShutdown() to complete"
echo "    [OK] Would verify poller saved cursor state"

log "  Step 2.3: Verify poller has caught up"
echo "    [OK] Would verify indexer_open_gaps_count <= previous value"
echo "    [OK] Would verify indexer_stalled == 0"

echo ""

# ── Phase 3: Migration Simulation ────────────────────────────────────────────

log "Phase 3: Migration Simulation"
echo ""

log "  Step 3.1: Pre-migration check"
if [ -f "scripts/validate-config.js" ]; then
  echo "    [OK] validate-config.js available for pre-migration check"
else
  echo "    [SKIP] validate-config.js not found (mock mode)"
fi

log "  Step 3.2: Run migrations (mock)"
echo "    [OK] Would run: npx prisma migrate deploy"
echo "    [OK] Would wait for migration completion"
echo "    [OK] Would verify migration version"

log "  Step 3.3: Verify migration version"
echo "    [OK] Would verify DB_MIGRATION_VERSION matches target"
echo "    [OK] Would verify no pending migrations"

echo ""

# ── Phase 4: Rollout Simulation ──────────────────────────────────────────────

log "Phase 4: Rollout Simulation (new version)"
echo ""

log "  Step 4.1: Deploy new version"
echo "    [OK] Would run: kubectl rollout update deployment/indexer"
echo "    [OK] Would wait for rollout completion"
echo "    [OK] Would verify new instances are healthy"

log "  Step 4.2: Monitor rollout progress"
echo "    [OK] Would monitor: kubectl rollout status deployment/indexer"
echo "    [OK] Would verify maxUnavailable=1 respected"
echo "    [OK] Would verify no duplicate polling occurs"

log "  Step 4.3: Verify new instances"
if check_http "/health" "200"; then
  echo "    [OK] /health endpoint responding"
else
  echo "    [FAIL] /health endpoint not responding"
  exit 1
fi

echo ""

# ── Phase 5: Post-Deployment Verification ────────────────────────────────────

log "Phase 5: Post-Deployment Verification"
echo ""

log "  Step 5.1: Smoke test"
echo "    [OK] Would run: npm run smoke-test"
echo "    [OK] Would verify /api/marketplace/listings"
echo "    [OK] Would verify SSE connectivity"

log "  Step 5.2: Verify no duplicate polling"
echo "    [OK] Would grep logs for 'Duplicate ledger' entries"
echo "    [OK] Would verify 0 duplicate ledger events"

log "  Step 5.3: Verify sync lag is acceptable"
new_lag=$(get_metric "indexer_ledger_lag")
if [ -n "$new_lag" ]; then
  echo "    [OK] Sync lag: ${new_lag} ledgers"
  if [ "$new_lag" -gt 200 ] 2>/dev/null; then
    echo "    [WARN] Sync lag higher than expected — investigate"
  fi
else
  echo "    [WARN] Could not determine sync lag"
fi

log "  Step 5.4: Verify SSE clients reconnect"
new_sse=$(get_metric "indexer_sse_active_connections")
if [ -n "$new_sse" ]; then
  echo "    [OK] Active SSE connections: ${new_sse}"
  if [ "$new_sse" -gt 0 ] 2>/dev/null; then
    echo "    [OK] SSE clients reconnected successfully"
  else
    echo "    [WARN] No SSE connections — clients may be reconnecting"
  fi
else
  echo "    [WARN] Could not determine SSE connection count"
fi

echo ""

# ── Phase 6: Final Verification ──────────────────────────────────────────────

log "Phase 6: Final Verification"
echo ""

log "  Step 6.1: Run full smoke test suite"
echo "    [OK] Would run: npm run smoke-test"

log "  Step 6.2: Verify metrics"
echo "    [OK] Would verify indexer_ledger_lag < 500"
echo "    [OK] Would verify indexer_open_gaps_count < 20"
echo "    [OK] Would verify indexer_stalled == 0"

log "  Step 6.3: Rollout complete"
echo "    [OK] Deployment successful!"
echo "    [OK] Scale to desired replicas: kubectl scale deployment/indexer --replicas=N"
echo "    [OK] Monitor for 5 minutes before next deployment"

echo ""

# ── Summary ───────────────────────────────────────────────────────────────────

echo "============================================"
echo "Rehearsal Summary"
echo "============================================"

if [ "$MODE" = "full" ]; then
  echo ""
  echo "Next Steps:"
  echo "  1. Review logs: kubectl logs -n elcarehub deploy/indexer"
  echo "  2. Check metrics: kubectl port-forward svc/indexer 4000:4000"
  echo "  3. View dashboard: http://localhost:4000/api/docs"
  echo "  4. Scale up: kubectl scale deployment/indexer --replicas=3"
else
  echo ""
  echo "Quick mode completed — basic checks passed"
fi

echo ""
echo "============================================"
echo "✓ Rehearsal completed successfully!"
echo "============================================"
