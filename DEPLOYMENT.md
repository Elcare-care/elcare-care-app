# ELCARE-HUB Rolling Deployment Guide

This guide documents the tested rolling deployment sequence for the indexer service, ensuring:
- Public reads remain available during deployment
- No duplicate polling occurs
- SSE clients reconnect gracefully
- Database and cursor state remain compatible

## Prerequisites

- Kubernetes cluster with Helm 3+ or Docker Compose stack
- PostgreSQL with point-in-time recovery enabled
- Prometheus/Grafana for deployment monitoring
- Access to deployment credentials (not included here)

## Architecture Overview

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Indexer 1  │     │  Indexer 2  │     │  Indexer N  │
│  (Leader)   │────▶│  (Worker)   │────▶│  (Worker)   │
└─────────────┘     └─────────────┘     └─────────────┘
      │                   │                   │
      ▼                   ▼                   ▼
┌──────────────────────────────────────────────────┐
│              PostgreSQL (Shared DB)              │
│  - TrackedContract cursors (leader/worker state) │
│  - Lease table (coordination)                    │
│  - LedgerGap jobs (work distribution)            │
└──────────────────────────────────────────────────┘
```

## Rolling Deployment Sequence

### Phase 1: Pre-Deployment Checks

**Goal**: Verify system health before starting deployment

```bash
# Validate configuration (new - shared config module)
node scripts/validate-config.js

# Check indexer health
curl -s http://indexer:4000/health | jq .

# Verify no active migration is running
kubectl rollout status deployment/indexer -n elcarehub --timeout=10s
```

**Readiness gates**:
- All instances healthy (HTTP 200 on `/health`)
- No pending ledger gaps > 1 hour old
- Database connection pool utilization < 80%
- SSE connections < 80 per instance (for HPA target)

### Phase 2: Drain phase (Old Version)

**Goal**: Stop accepting new work while draining existing work

```bash
# 1. Scale down to 1 instance (min available)
kubectl scale deployment/indexer -n elcarehub --replicas=1

# 2. Wait for instance to become unready (graceful shutdown)
kubectl rollout status deployment/indexer -n elcarehub --timeout=60s

# 3. Verify poller has caught up (no new gaps)
curl -s http://indexer:4000/metrics | grep indexer_open_gaps_count
```

**Termination handling**:
- `SIGTERM` sent to indexer pod
- Graceful shutdown hook (`gracefulShutdown()` in `poller.ts`) executes:
  - Stops poller loop (saves cursor state)
  - Closes SSE clients (send `server-shutdown` event)
  - Disconnects from Redis
  - Disconnects from PostgreSQL
  - Runs registered shutdown hooks
- Process exits with code 0 (not 137/143 OOM/kill signals)

**Metrics to monitor**:
- `indexer_stalled` should be 0 before shutdown
- `indexer_sse_active_connections` should trend toward 0
- `elcarehub_lease_held` should be 1 for leader

### Phase 3: Migration

**Goal**: Apply database migrations with minimal downtime

```bash
# 1. Run migration (pre-deploy job)
kubectl apply -f k8s/migration-job.yaml

# 2. Wait for migration to complete
kubectl wait --for=condition=complete job/migration -n elcarehub --timeout=300s

# 3. Verify migration version
kubectl exec -n elcarehub deploy/indexer -- node -e "console.log(process.env.DB_MIGRATION_VERSION)"
```

**Migration preflight checks**:
- No active indexer instances running
- Database backup exists (within 24 hours)
- Schema compatibility matrix allows upgrade

### Phase 4: Rollout (New Version)

**Goal**: Deploy new version with zero-downtime reads

```bash
# 1. Deploy new version (rolling update)
kubectl rollout update deployment/indexer -n elcarehub \
  --set image=elcarehub/indexer:latest

# 2. Monitor rollout progress
kubectl rollout status deployment/indexer -n elcarehub --timeout=300s

# 3. Verify new instances are healthy
for i in $(seq 0 $((REPLICAS-1))); do
  curl -s http://indexer-${i}.indexer:4000/health | jq .
done
```

**Rollout strategy**:
- `maxUnavailable: 1` — Only one instance unavailable at a time
- `maxSurge: 1` — One extra instance allowed during rollout
- `progressDeadlineSeconds: 600` — 10-minute deadline

### Phase 5: Post-Deployment Verification

**Goal**: Verify new version is functioning correctly

```bash
# 1. Verify no duplicate polling
kubectl logs -n elcarehub deploy/indexer | grep "Duplicate ledger" | wc -l

# 2. Verify sync lag is acceptable
curl -s http://indexer:4000/metrics | grep indexer_ledger_lag

# 3. Verify SSE clients reconnect
curl -s http://indexer:4000/health | jq .status

# 4. Run smoke test
curl -s http://indexer:4000/api/marketplace/listings | jq '.data | length'
```

### Phase 6: Rollout Complete

**Goal**: Confirm deployment success and cleanup

```bash
# 1. Scale to desired replicas
kubectl scale deployment/indexer -n elcarehub --replicas=3

# 2. Verify all instances are healthy
kubectl get pods -n elcarehub -l app=indexer -w

# 3. Check final metrics
curl -s http://indexer:4000/metrics > metrics-deployment-complete.prom
```

## Rollback Criteria

Define rollback trigger conditions before deployment:

| Condition | Action |
|-----------|--------|
| `indexer_stalled == 1` for > 5 min | Immediate rollback |
| `indexer_open_gaps_count > 20` for > 10 min | Immediate rollback |
| `indexer_sse_active_connections == 0` for > 30 min | Alert, monitor |
| API p99 latency > 5s for > 5 min | Alert, monitor |
| Database connection pool > 95% for > 2 min | Alert, monitor |

**Rollback procedure**:
```bash
# 1. Identify current version
kubectl describe deployment indexer -n elcarehub | grep Image:

# 2. Rollback to previous version
kubectl rollout undo deployment/indexer -n elcarehub

# 3. Verify rollback succeeded
kubectl rollout status deployment/indexer -n elcarehub
```

## Configuration Changes

### Version Metadata

Version metadata is embedded at build time and passed as environment variables:

```dockerfile
ARG BUILD_SHA=unknown
ARG BUILD_TIME=unknown
ARG INDEXER_VERSION=1.0.0
ARG API_VERSION=1.0.0
ARG EVENT_SCHEMA_VERSION=1
ARG DB_MIGRATION_VERSION=20260724000000

ENV INDEXER_VERSION="${INDEXER_VERSION}"
ENV API_VERSION="${API_VERSION}"
ENV EVENT_SCHEMA_VERSION="${EVENT_SCHEMA_VERSION}"
ENV DB_MIGRATION_VERSION="${DB_MIGRATION_VERSION}"
ENV BUILD_SHA="${BUILD_SHA}"
ENV BUILD_TIME="${BUILD_TIME}"
```

### Health Endpoint

The `/health/details` endpoint requires operator token:

```bash
# Health check (no auth required)
curl http://indexer:4000/health

# Full diagnostics (operator auth required)
curl -H "X-Admin-Token: ${OPERATOR_TOKEN}" http://indexer:4000/health/details
```

## SSE Client Reconnection

### Behavior During Deployment

1. **Graceful shutdown**: Old instance sends `server-shutdown` SSE event
2. **Client action**: Clients disconnect and attempt reconnection
3. **New instance**: New instance has same Redis stream (same replay window)
4. **Replay**: Clients resume from lastEventId (same id space)

### Client Implementation Pattern

```javascript
const eventSource = new EventSource('/sse');

eventSource.onmessage = (event) => {
  if (event.type === 'server-shutdown') {
    // Graceful shutdown initiated — reconnect with lastEventId
    const lastId = eventSource.lastEventId;
    eventSource.close();
    
    // Reconnect with lastEventId to resume where we left off
    reconnectWithLastId(lastId);
  }
};

function reconnectWithLastId(lastEventId) {
  const url = lastEventId 
    ? `/sse?lastEventId=${lastEventId}` 
    : '/sse';
  
  const reconnected = new EventSource(url);
  reconnected.onmessage = handleEvent;
}
```

### Metrics for Monitoring

| Metric | Target | Description |
|--------|--------|-------------|
| `indexer_sse_active_connections` | Stable | No sudden drops during deployment |
| `indexer_sse_replay_requests_total` | Low rate | Clients resuming from lastEventId |
| `indexer_sse_events_dropped_total` | 0 | No client queue overflow |

## Database Migration Order

### Migration Types

1. **Safe (no downtime)**:
   - New columns with defaults
   - New indexes
   - Non-null constraints (with default)

2. **Unsafe (requires downtime)**:
   - Column type changes
   - Table renames
   - Data transformations

### Migration Sequence

```bash
# 1. Pre-migration check (validate config)
node scripts/validate-config.js

# 2. Run migrations
npx prisma migrate deploy

# 3. Verify migration version
npx prisma migrate status

# 4. Run compatibility check
node scripts/validate-migration.js
```

## Smoke Test Suite

Run after each deployment to verify core functionality:

```bash
#!/bin/bash
# scripts/smoke-test.sh

set -e

BASE_URL="${1:-http://localhost:4000}"

echo "Running smoke tests..."

# Test 1: Health endpoint
echo "✓ Testing /health..."
curl -s "${BASE_URL}/health" | jq -e '.status == "up"'

# Test 2: Read endpoint
echo "✓ Testing /api/marketplace/listings..."
curl -s "${BASE_URL}/api/marketplace/listings" | jq -e '.data | length >= 0'

# Test 3: SSE connectivity
echo "✓ Testing SSE connectivity..."
curl -s "${BASE_URL}/sse?lastEventId=0" -H "Accept: text/event-stream" | head -c 100

# Test 4: Metrics endpoint
echo "✓ Testing /metrics..."
curl -s "${BASE_URL}/metrics" | grep -q "indexer_latest_ledger_processed"

# Test 5: Version info
echo "✓ Testing /version..."
curl -s "${BASE_URL}/version" | jq -e '.app == process.env.INDEXER_VERSION'

echo "All smoke tests passed!"
```

## Deployment Scripts

### Kubernetes

```yaml
# k8s/indexer-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: indexer
  labels:
    app: indexer
spec:
  replicas: 3
  revisionHistoryLimit: 5
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
      maxSurge: 1
  template:
    metadata:
      labels:
        app: indexer
    spec:
      terminationGracePeriodSeconds: 60
      containers:
      - name: indexer
        image: elcarehub/indexer:latest
        ports:
        - containerPort: 4000
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: indexer-secrets
              key: database-url
        # ... other env vars
        readinessProbe:
          httpGet:
            path: /readyz
            port: 4000
          initialDelaySeconds: 30
          periodSeconds: 10
        livenessProbe:
          httpGet:
            path: /health
            port: 4000
          initialDelaySeconds: 60
          periodSeconds: 15
```

### Docker Compose

```yaml
# docker-compose.prod.yml
version: '3.8'

services:
  indexer:
    image: elcarehub/indexer:latest
    scale: 3
    deploy:
      replicas: 3
      update_config:
        parallelism: 1
        delay: 30s
        failure_action: rollback
        monitor: 60s
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:4000/health"]
      interval: 15s
      timeout: 5s
      retries: 3
    volumes:
      - ./scripts:/scripts:ro
    command: ["sh", "-c", "node scripts/validate-config.js && npx prisma migrate deploy && node dist/index.js"]
```

## Monitoring Dashboard

Key metrics to monitor during deployment:

| Panel | Query | Warning | Critical |
|-------|-------|---------|----------|
| Active Instances | `count(up{job="indexer"})` | < replicas - 1 | < replicas - 2 |
| Sync Lag | `indexer_ledger_lag` | > 100 | > 500 |
| Open Gaps | `indexer_open_gaps_count` | > 5 | > 20 |
| SSE Connections | `indexer_sse_active_connections` | < 10 (all down) | < 5 (all down) |
| DB Pool Usage | `indexer_db_pool_connections_used` | > 8 | > 9.5 |
| Rollback Events | `increase(kubernetes_deployment_rollback_total[1h])` | > 0 | > 1 |

## Troubleshooting

### Common Issues

**Issue**: Duplicate polling detected
- **Symptom**: `Duplicate ledger` log entries
- **Cause**: Lease acquisition failed, multiple instances polling same contract
- **Fix**: Check lease table, restart indexer with fresh lease

**Issue**: SSE clients not reconnecting
- **Symptom**: `indexer_sse_active_connections == 0` persistently
- **Cause**: Redis stream window too small, lastEventId expired
- **Fix**: Increase `SSE_STREAM_MAXLEN`, client-side retry with longer window

**Issue**: Database migration conflict
- **Symptom**: `deadlock detected` in migration logs
- **Cause**: Multiple migration jobs running simultaneously
- **Fix**: Ensure only one migration job runs, use advisory locks

### Rollback Checklist

- [ ] Configuration validated with `node scripts/validate-config.js`
- [ ] Database backup exists and is restorable
- [ ] Rollback image version documented and tested
- [ ] Service mesh (if any) routes restored to previous version
- [ ] Prometheus alerts re-enabled for previous version metrics
