#!/usr/bin/env bash
# ============================================================
# scripts/deploy/health-gate.sh
#
# Post-deploy health gate and smoke test.
# Validates that every component is reachable and internally
# consistent before traffic is shifted to a new deployment.
# Exits non-zero if any required gate fails.
#
# Required env vars:
#   INDEXER_URL              — Indexer base URL, e.g. https://indexer.example.com
#
# Optional env vars:
#   FRONTEND_URL             — Frontend base URL (default: derived from INDEXER_URL host)
#   HEALTH_DETAILS_TOKEN     — Bearer token for /health/details (auth-protected)
#   GATE_TIMEOUT_SECONDS     — Max seconds to wait for readiness (default: 120)
#   SMOKE_CONTRACT_ID        — Contract ID to use for read-only smoke query
#
# Exit codes:
#   0 — all required gates passed
#   1 — one or more required gates failed
#
# Rollback procedure on non-zero exit:
#   1. Do NOT shift traffic to the new revision.
#   2. Re-point the load balancer / CDN to the previous known-good revision.
#   3. Page the on-call operator with this script's output (captured as a
#      release artifact — see .github/workflows/post-deploy-smoke.yml).
#   4. Investigate the failed gate before retrying the deployment.
# ============================================================
set -euo pipefail

INDEXER_URL="${INDEXER_URL:?INDEXER_URL must be set}"
FRONTEND_URL="${FRONTEND_URL:-}"
HEALTH_DETAILS_TOKEN="${HEALTH_DETAILS_TOKEN:-}"
GATE_TIMEOUT_SECONDS="${GATE_TIMEOUT_SECONDS:-120}"
SMOKE_CONTRACT_ID="${SMOKE_CONTRACT_ID:-}"

CHECKS_PASSED=0
CHECKS_FAILED=0
REPORT_LINES=()

# Timestamp helper
ts() { date -u +%FT%TZ; }

log() { echo "[gate] $(ts) $*"; }
pass() {
  CHECKS_PASSED=$((CHECKS_PASSED + 1))
  REPORT_LINES+=("  PASS  $*")
  log "PASS  $*"
}
fail() {
  CHECKS_FAILED=$((CHECKS_FAILED + 1))
  REPORT_LINES+=("  FAIL  $*")
  log "FAIL  $*" >&2
}

# ── Helper: HTTP GET with timeout ─────────────────────────────────────────────
http_get() {
  local url="$1"
  local auth_header="${2:-}"
  local args=(-sS --max-time 15 -o /dev/null -w "%{http_code}")
  if [[ -n "$auth_header" ]]; then
    args+=(-H "$auth_header")
  fi
  curl "${args[@]}" "$url"
}

# ── Helper: wait for a URL to return 200 with bounded retries ─────────────────
wait_for_url() {
  local name="$1"
  local url="$2"
  local deadline=$((SECONDS + GATE_TIMEOUT_SECONDS))

  log "Waiting for ${name} at ${url} (timeout ${GATE_TIMEOUT_SECONDS}s)..."
  while [[ $SECONDS -lt $deadline ]]; do
    CODE=$(http_get "$url" 2>/dev/null || echo "000")
    if [[ "$CODE" == "200" ]]; then
      return 0
    fi
    sleep 3
  done
  return 1
}

echo ""
log "========================================================"
log "  ELCARE-HUB Deployment Health Gate"
log "  Indexer : ${INDEXER_URL}"
log "  Frontend: ${FRONTEND_URL:-<not set>}"
log "========================================================"
echo ""

# ── Gate 1: Indexer liveness ──────────────────────────────────────────────────
log "Gate 1/6: Indexer liveness (/health)"
if wait_for_url "indexer" "${INDEXER_URL}/health"; then
  pass "Indexer /health returned 200"
else
  fail "Indexer /health did not return 200 within ${GATE_TIMEOUT_SECONDS}s"
fi

# ── Gate 2: Indexer readiness (database + sync lag) ──────────────────────────
log "Gate 2/6: Indexer readiness (/readyz)"
CODE=$(http_get "${INDEXER_URL}/readyz" 2>/dev/null || echo "000")
if [[ "$CODE" == "200" ]]; then
  pass "Indexer /readyz returned 200 (database and sync lag OK)"
else
  fail "Indexer /readyz returned ${CODE} (database or sync lag not ready)"
fi

# ── Gate 3: Database + Redis health (via /health details) ────────────────────
log "Gate 3/6: Database and Redis health (via /health/details)"
AUTH_HEADER=""
if [[ -n "$HEALTH_DETAILS_TOKEN" ]]; then
  AUTH_HEADER="Authorization: Bearer ${HEALTH_DETAILS_TOKEN}"
fi
HEALTH_BODY=$(curl -sS --max-time 15 \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  "${INDEXER_URL}/health/details" 2>/dev/null || echo "{}")

DB_STATUS=$(echo "$HEALTH_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('checks',{}).get('database',{}).get('status','unknown'))" 2>/dev/null || echo "unknown")
REDIS_STATUS=$(echo "$HEALTH_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('checks',{}).get('redis',{}).get('status','unknown'))" 2>/dev/null || echo "unknown")

if [[ "$DB_STATUS" == "ok" ]]; then
  pass "Database health: ok"
else
  fail "Database health: ${DB_STATUS} (check /health/details)"
fi

if [[ "$REDIS_STATUS" == "ok" ]]; then
  pass "Redis health: ok"
else
  fail "Redis health: ${REDIS_STATUS} (check /health/details)"
fi

# ── Gate 4: Indexer API schema reachable ─────────────────────────────────────
log "Gate 4/6: Indexer OpenAPI schema (/openapi.json)"
CODE=$(http_get "${INDEXER_URL}/openapi.json" 2>/dev/null || echo "000")
if [[ "$CODE" == "200" ]]; then
  pass "Indexer OpenAPI schema reachable"
else
  fail "Indexer OpenAPI schema returned ${CODE}"
fi

# ── Gate 5: Frontend startup ──────────────────────────────────────────────────
log "Gate 5/6: Frontend startup"
if [[ -n "$FRONTEND_URL" ]]; then
  CODE=$(http_get "${FRONTEND_URL}" 2>/dev/null || echo "000")
  if [[ "$CODE" == "200" ]]; then
    pass "Frontend returned 200"
  else
    fail "Frontend returned ${CODE}"
  fi
else
  log "  SKIP  FRONTEND_URL not set — skipping frontend gate"
  REPORT_LINES+=("  SKIP  Frontend (FRONTEND_URL not set)")
fi

# ── Gate 6: Smoke — read listings API ────────────────────────────────────────
log "Gate 6/6: API smoke test (GET /listings)"
LISTINGS_URL="${INDEXER_URL}/listings?limit=1"
if [[ -n "$SMOKE_CONTRACT_ID" ]]; then
  LISTINGS_URL="${LISTINGS_URL}&contractId=${SMOKE_CONTRACT_ID}"
fi
CODE=$(http_get "$LISTINGS_URL" 2>/dev/null || echo "000")
if [[ "$CODE" == "200" ]]; then
  pass "GET /listings returned 200"
else
  fail "GET /listings returned ${CODE}"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
log "========================================================"
log "  Health Gate Report — $(ts)"
log "  Passed: ${CHECKS_PASSED}  Failed: ${CHECKS_FAILED}"
log "========================================================"
for line in "${REPORT_LINES[@]}"; do
  echo "$line"
done
echo ""

if [[ $CHECKS_FAILED -gt 0 ]]; then
  log "DEPLOYMENT BLOCKED — ${CHECKS_FAILED} gate(s) failed. See rollback procedure in this script."
  exit 1
fi

log "All gates passed. Deployment may proceed."
exit 0
