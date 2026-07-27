#!/usr/bin/env bash
# load-tests/harness/run-load-test.sh
#
# Combined load-test harness.
#
# Orchestrates the full test sequence:
#   1. Spin up isolated Docker Compose stack
#   2. Run Prisma migrations on the load-test DB
#   3. Seed fixtures
#   4. Run ingestion simulator (measures write throughput + lag)
#   5. Run k6 API load test (measures HTTP latency, cache hit ratio)
#   6. Run k6 SSE load test (measures TTFE, event delivery)
#   7. Run combined (API + ingestion concurrently) — simulates real prod traffic
#   8. Collect resource usage snapshots (DB connections, Redis memory)
#   9. Generate report and compare against baseline
#  10. Tear down stack
#
# Resource budgets enforced by this script (fail with exit 1 on violation):
#   DB connection count  ≤  DB_CONN_BUDGET        (default: 25)
#   Redis memory usage   ≤  REDIS_MEM_BUDGET_MB    (default: 100)
#   API p95 latency      ≤  API_P95_BUDGET_MS      (default: 200)
#   Ingestion lag p95    ≤  INGEST_P95_BUDGET_MS   (default: 500)
#   SSE TTFE p95         ≤  SSE_TTFE_BUDGET_MS     (default: 500)
#   Error rate           ≤  ERROR_RATE_BUDGET_PCT  (default: 1)
#
# Usage:
#   bash load-tests/harness/run-load-test.sh              # short load (~10 min)
#   SOAK=1 bash load-tests/harness/run-load-test.sh       # soak run (~35 min)
#   SKIP_SEED=1 bash load-tests/harness/run-load-test.sh  # reuse existing data
#
# Prerequisites:
#   docker, docker compose, k6, node ≥20, npx, tsx

set -euo pipefail

# ── Paths ─────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
LT_DIR="${REPO_ROOT}/load-tests"
RESULTS_DIR="${LT_DIR}/results"
COMPOSE_FILE="${LT_DIR}/docker-compose.load-test.yml"
INDEXER_DIR="${REPO_ROOT}/indexer"

mkdir -p "${RESULTS_DIR}"

# ── Config ────────────────────────────────────────────────────────────────────

SOAK="${SOAK:-0}"
SKIP_SEED="${SKIP_SEED:-0}"
SKIP_TEARDOWN="${SKIP_TEARDOWN:-0}"

LT_DATABASE_URL="${LT_DATABASE_URL:-postgresql://ltuser:ltpass@localhost:5433/marketplace_lt}"
LT_REDIS_URL="${LT_REDIS_URL:-redis://localhost:6380}"
INDEXER_URL="${INDEXER_URL:-http://localhost:4001}"

# Resource budgets
DB_CONN_BUDGET="${DB_CONN_BUDGET:-25}"
REDIS_MEM_BUDGET_MB="${REDIS_MEM_BUDGET_MB:-100}"
API_P95_BUDGET_MS="${API_P95_BUDGET_MS:-200}"
INGEST_P95_BUDGET_MS="${INGEST_P95_BUDGET_MS:-500}"
SSE_TTFE_BUDGET_MS="${SSE_TTFE_BUDGET_MS:-500}"
ERROR_RATE_BUDGET_PCT="${ERROR_RATE_BUDGET_PCT:-1}"

START_TS="$(date +%Y%m%d_%H%M%S)"
VIOLATIONS=()

# ── Logging helpers ───────────────────────────────────────────────────────────

info()  { echo "[$(date +%H:%M:%S)] INFO  $*"; }
warn()  { echo "[$(date +%H:%M:%S)] WARN  $*" >&2; }
error() { echo "[$(date +%H:%M:%S)] ERROR $*" >&2; }
step()  { echo; echo "═══ $* ═══"; echo; }

# ── Cleanup handler ───────────────────────────────────────────────────────────

cleanup() {
  if [[ "${SKIP_TEARDOWN}" == "1" ]]; then
    info "SKIP_TEARDOWN=1 — leaving stack running"
    return
  fi
  info "Tearing down load-test stack…"
  docker compose -f "${COMPOSE_FILE}" down -v --remove-orphans 2>/dev/null || true
}
trap cleanup EXIT

# ── Step 1: Start stack ───────────────────────────────────────────────────────

step "Starting isolated load-test stack"
docker compose -f "${COMPOSE_FILE}" up -d --build --wait
info "Stack healthy"

# ── Step 2: Migrate ───────────────────────────────────────────────────────────

step "Running Prisma migrations on load-test DB"
DATABASE_URL="${LT_DATABASE_URL}" \
  npx prisma migrate deploy \
  --schema "${INDEXER_DIR}/prisma/schema.prisma"
info "Migrations applied"

# ── Step 3: Seed ──────────────────────────────────────────────────────────────

if [[ "${SKIP_SEED}" == "0" ]]; then
  step "Seeding fixtures"
  DATABASE_URL="${LT_DATABASE_URL}" \
  REDIS_URL="${LT_REDIS_URL}" \
    npx tsx "${LT_DIR}/fixtures/seed.ts"
  info "Seed complete"
else
  info "SKIP_SEED=1 — skipping fixture generation"
fi

# ── Step 4: Ingestion simulator ───────────────────────────────────────────────

step "Running ingestion / poller simulator"
DATABASE_URL="${LT_DATABASE_URL}" \
REDIS_URL="${LT_REDIS_URL}" \
  npx tsx "${LT_DIR}/ingestion/poller-sim.ts"
info "Ingestion simulator done → ${RESULTS_DIR}/ingestion-latest.json"

# ── Step 5: API load test ─────────────────────────────────────────────────────

step "Running k6 API load test"
K6_SOAK_ARG=""
[[ "${SOAK}" == "1" ]] && K6_SOAK_ARG="--env K6_SOAK=1"

k6 run \
  --env BASE_URL="${INDEXER_URL}" \
  --summary-export="${RESULTS_DIR}/api-load-latest-summary.json" \
  ${K6_SOAK_ARG} \
  "${LT_DIR}/k6/api-load.js" \
  2>&1 | tee "${RESULTS_DIR}/api-load-latest.log"
info "API load test done"

# ── Step 6: SSE load test ─────────────────────────────────────────────────────

step "Running k6 SSE load test"
k6 run \
  --env BASE_URL="${INDEXER_URL}" \
  --summary-export="${RESULTS_DIR}/sse-load-latest-summary.json" \
  ${K6_SOAK_ARG} \
  "${LT_DIR}/k6/sse-load.js" \
  2>&1 | tee "${RESULTS_DIR}/sse-load-latest.log"
info "SSE load test done"

# ── Step 7: Combined (API + ingestion concurrently) ───────────────────────────

step "Running combined load (API + ingestion concurrently)"
DATABASE_URL="${LT_DATABASE_URL}" \
REDIS_URL="${LT_REDIS_URL}" \
SIM_LEDGERS="200" \
SIM_EVENTS_PER_LEDGER="30" \
SIM_CONCURRENCY="2" \
  npx tsx "${LT_DIR}/ingestion/poller-sim.ts" &
INGEST_PID=$!

k6 run \
  --env BASE_URL="${INDEXER_URL}" \
  --summary-export="${RESULTS_DIR}/combined-load-latest-summary.json" \
  "${LT_DIR}/k6/api-load.js" \
  2>&1 | tee "${RESULTS_DIR}/combined-load-latest.log"

wait ${INGEST_PID} || warn "Ingestion subprocess exited non-zero during combined test"
info "Combined load test done"

# ── Step 8: Resource snapshots ────────────────────────────────────────────────

step "Capturing resource usage snapshots"

# DB connection count (pg_stat_activity)
DB_CONNS=$(PGPASSWORD=ltpass psql \
  -h localhost -p 5433 -U ltuser -d marketplace_lt \
  -t -c "SELECT count(*) FROM pg_stat_activity WHERE state != 'idle';" \
  2>/dev/null | tr -d ' ' || echo "0")

# Redis memory
REDIS_MEM_BYTES=$(redis-cli -p 6380 info memory 2>/dev/null \
  | grep 'used_memory:' | cut -d: -f2 | tr -d $'\r' || echo "0")
REDIS_MEM_MB=$(echo "scale=1; ${REDIS_MEM_BYTES:-0} / 1048576" | bc 2>/dev/null || echo "0")

# Redis hit/miss ratio
REDIS_HITS=$(redis-cli -p 6380 info stats 2>/dev/null \
  | grep 'keyspace_hits:' | cut -d: -f2 | tr -d $'\r' || echo "0")
REDIS_MISSES=$(redis-cli -p 6380 info stats 2>/dev/null \
  | grep 'keyspace_misses:' | cut -d: -f2 | tr -d $'\r' || echo "0")

info "DB active connections: ${DB_CONNS}"
info "Redis memory:          ${REDIS_MEM_MB} MB"
info "Redis hits/misses:     ${REDIS_HITS:-0}/${REDIS_MISSES:-0}"

cat > "${RESULTS_DIR}/resources-latest.json" <<EOF
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "db_active_connections": ${DB_CONNS:-0},
  "redis_memory_mb": ${REDIS_MEM_MB:-0},
  "redis_hits": ${REDIS_HITS:-0},
  "redis_misses": ${REDIS_MISSES:-0}
}
EOF

# ── Step 9: Budget checks ─────────────────────────────────────────────────────

step "Checking resource budgets"

check_budget() {
  local name="$1" actual="$2" budget="$3" op="$4"
  if [[ "${op}" == "gt" && "$(echo "${actual} > ${budget}" | bc -l)" == "1" ]]; then
    error "BUDGET VIOLATION: ${name} = ${actual} > ${budget}"
    VIOLATIONS+=("${name}=${actual} (budget ${budget})")
  elif [[ "${op}" == "lt" && "$(echo "${actual} < ${budget}" | bc -l)" == "1" ]]; then
    error "BUDGET VIOLATION: ${name} = ${actual} < ${budget}"
    VIOLATIONS+=("${name}=${actual} (budget ${budget})")
  else
    info "OK  ${name} = ${actual} (budget ${budget})"
  fi
}

check_budget "db_active_connections" "${DB_CONNS:-0}" "${DB_CONN_BUDGET}"  "gt"
check_budget "redis_memory_mb"       "${REDIS_MEM_MB:-0}" "${REDIS_MEM_BUDGET_MB}" "gt"

# Parse p95 from k6 summary JSONs
parse_p95() {
  local file="$1" metric="$2"
  node -e "
    const d = require('${file}');
    const m = d.metrics?.['${metric}'];
    if (m) console.log(m.values?.['p(95)'] ?? m.values?.p95 ?? 0);
    else console.log(0);
  " 2>/dev/null || echo "0"
}

API_P95=$(parse_p95 "${RESULTS_DIR}/api-load-latest-summary.json" "http_req_duration")
SSE_TTFE=$(parse_p95 "${RESULTS_DIR}/sse-load-latest-summary.json" "sse_ttfe_ms")
INGEST_P95=$(node -e \
  "const d=require('${RESULTS_DIR}/ingestion-latest.json'); console.log(d.ingestionLagP95Ms ?? 0)" \
  2>/dev/null || echo "0")

check_budget "api_p95_latency_ms"   "${API_P95}"    "${API_P95_BUDGET_MS}"   "gt"
check_budget "sse_ttfe_p95_ms"      "${SSE_TTFE}"   "${SSE_TTFE_BUDGET_MS}"  "gt"
check_budget "ingest_lag_p95_ms"    "${INGEST_P95}" "${INGEST_P95_BUDGET_MS}" "gt"

# ── Step 10: Generate report ──────────────────────────────────────────────────

step "Generating combined report"
node "${LT_DIR}/harness/reporter.mjs" \
  --timestamp "${START_TS}" \
  --results-dir "${RESULTS_DIR}" \
  --violations "$(printf '%s;' "${VIOLATIONS[@]}" 2>/dev/null || true)" \
  2>&1 | tee "${RESULTS_DIR}/report-${START_TS}.log"

# ── Final outcome ─────────────────────────────────────────────────────────────

echo
if [[ ${#VIOLATIONS[@]} -gt 0 ]]; then
  error "Load test FAILED — ${#VIOLATIONS[@]} budget violation(s):"
  for v in "${VIOLATIONS[@]}"; do error "  • ${v}"; done
  exit 1
else
  info "Load test PASSED — all budgets within limits"
  exit 0
fi
