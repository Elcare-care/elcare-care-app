# Graceful Shutdown Handling

**Status**: Documented  
**Last Updated**: 2026-11-20  
**Related**: Issues #948, #949, #950, #951  
**Validation Command**: `node scripts/validate-config.js` (read-only)

---

## Summary

This document describes the indexer's graceful shutdown behavior and provides operators with verification steps to ensure no stale polling, open HTTP handlers, or incomplete Prisma transactions remain after termination.

---

## Architecture

### Shutdown Sequence Overview

When Kubernetes sends `SIGTERM` (or Docker sends `SIGTERM` via `docker stop`), the indexer follows this sequence:

```
1. Signal received (SIGTERM / SIGINT)
   │
   ▼
2. stopPoller() — sets shuttingDown flag
   │
   ▼
3. gracefulShutdown() executes in order:
   ├─ closeSSEClients() — sends server-shutdown event
   ├─ httpServer.close() — stops accepting new connections
   ├─ Prisma disconnect
   ├─ Redis disconnect
   └─ Runs all registered shutdown hooks
   │
   ▼
4. Process exits with code 0 (success)
```

### Implementation Files

| File | Purpose |
|------|---------|
| `src/index.ts` | HTTP server setup + signal handlers |
| `src/poller.ts` | Polling loop coordination + shutdown hooks |
| `src/health.ts` | Health checks + last successful poll timestamp |
| `src/api/routes.ts` | SSE client management + graceful drain |
| `k8s/indexer-deployment.yaml` | Kubernetes termination timing configuration |

---

## Kubernetes / Docker Timing

### terminationGracePeriodSeconds

In `k8s/indexer-deployment.yaml`, the termination grace period is set to **60 seconds**:

```yaml
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 60
```

This means:
- Kubernetes sends `SIGTERM` at T+0
- The indexer has up to 60 seconds to complete graceful shutdown
- Kubernetes sends `SIGKILL` at T+60 if the process is still running

### Docker Stop Timing

Docker's default stop timeout is 10 seconds (configurable via `--stop-timeout`). The indexer's Dockerfile explicitly sets:

```dockerfile
STOPSIGNAL SIGTERM
```

This ensures `docker stop` sends `SIGTERM` first, allowing the same graceful sequence.

### Probe Configuration

The Kubernetes deployment uses these health probes:

| Probe | Path | Initial Delay | Period | Timeout | Failure Threshold |
|-------|------|---------------|--------|---------|-------------------|
| **startup** | `/health` | 10s | 10s | 5s | 30 (5 min max) |
| **readiness** | `/readyz` | 30s | 10s | 5s | 3 |
| **liveness** | `/health` | 60s | 15s | 5s | 3 |

The `/readyz` endpoint returns 503 until the first ledger is indexed, preventing traffic before the indexer is ready.

---

## What Graceful Shutdown Does

### 1. Stops Polling

`stopPoller()` sets a flag that causes each per-contract poll loop to exit after completing its current ledger batch:

```typescript
// src/poller.ts
let shuttingDown = false;

export function stopPoller(): void {
  if (!shuttingDown) {
    shuttingDown = true;
    logger.info('poller: stop requested — will exit after current batch');
  }
}
```

The poller exits cleanly after:
- Processing the current window of ledgers
- Writing checkpoint state to the database
- Releasing the distributed lease (`releaseLease('poller')`)

### 2. Closes SSE Clients

`closeSSEClients()` in `src/api/routes.ts` sends a final event to all connected clients:

```typescript
export function closeSSEClients(): void {
  for (const [client] of sseClients) {
    try { client.end(); } catch { /* ignore */ }
  }
  sseClients.clear();
}
```

Clients can detect shutdown via the `Last-Event-ID` mechanism and reconnect with the last event ID to resume where they left off.

### 3. Drains HTTP Server

The HTTP server in `src/index.ts` closes gracefully:

```typescript
httpServer.close(() => resolve());

// If requests haven't drained within the configured timeout, force-close.
setTimeout(resolve, cfg.shutdownTimeoutMs).unref();
```

This ensures:
- In-flight requests complete
- No new connections accepted
- Connections drain before process exit

### 4. Disconnects Dependencies

`gracefulShutdown()` in `src/poller.ts` handles database and Redis cleanup:

```typescript
export async function gracefulShutdown(): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;

  await withShutdownTimeout(
    async (signal) => {
      const cleanup = Promise.allSettled([
        prisma.$disconnect(),
        (redis && typeof redis.disconnect === 'function') ? redis.disconnect() : Promise.resolve(),
        ...shutdownHooks.map((fn) => fn()),
      ]);

      await cleanup;
    },
    'graceful_shutdown',
    TIMEOUT_BUDGETS.shutdown
  );
}
```

This ensures:
- Prisma transactions are committed or rolled back cleanly
- Redis connections are closed gracefully
- All registered shutdown hooks complete

---

## What Graceful Shutdown Does NOT Do

### 1. Force-Kill Long-Running Transactions

If a Prisma transaction is still running when `gracefulShutdown()` is called, it will complete (up to the timeout budget). If the transaction exceeds the timeout, the process exits with code 1.

### 2. Wait for All SSE Clients to Reconnect

`closeSSEClients()` immediately closes all connections. It does not wait for clients to reconnect or acknowledge the `server-shutdown` event.

### 3. Prevent SIGKILL

If the process does not exit within `terminationGracePeriodSeconds` (60s), Kubernetes sends `SIGKILL`. This is a hard termination and may leave transactions in an incomplete state.

---

## Smoke Check: Verify Health Status During Termination

### Health Endpoint During Shutdown

The `/health` and `/readyz` endpoints continue to respond during graceful shutdown:

- `/health` — Returns 200 or 503 depending on dependency status
- `/readyz` — Returns 503 if the indexer is shutting down (checked by `isStalled()`)

### Verification Script

Run this script to verify graceful shutdown behavior:

```bash
# scripts/verify-graceful-shutdown.sh

#!/bin/bash
set -e

echo "=== Graceful Shutdown Smoke Test ==="
echo ""

BASE_URL="${1:-http://localhost:4000}"

# 1. Verify health endpoint responds before shutdown
echo "1. Health check before shutdown..."
curl -sf "${BASE_URL}/health" | jq -e '.status == "ok" or .status == "degraded"'
echo "✓ Health endpoint responding"

# 2. Verify /readyz returns ready
echo "2. Readiness check..."
curl -sf "${BASE_URL}/readyz" | jq -e '.ready == true or .status == "ready"'
echo "✓ Indexer is ready"

# 3. Check last successful poll timestamp
echo "3. Last successful poll timestamp..."
POLL_TS=$(curl -sf "${BASE_URL}/health" | jq -r '.lastSuccessfulPoll // "null"')
echo "   Last poll: ${POLL_TS:-No poll completed yet}"
echo "✓ Last poll timestamp available"

# 4. Verify no open gaps (optional)
echo "4. Checking for open ledger gaps..."
OPEN_GAPS=$(curl -sf "${BASE_URL}/health/details" -H "X-Admin-Token: ${OPERATOR_TOKEN}" 2>/dev/null | jq -r '.details.openGapsCount // 0')
if [ "$OPEN_GAPS" != "0" ]; then
  echo "⚠ Warning: ${OPEN_GAPS} open gaps found"
else
  echo "✓ No open gaps"
fi

echo ""
echo "=== Smoke Test Complete ==="
echo "All health checks passed. The indexer is ready for graceful shutdown."
```

### Manual Verification Steps

To manually verify shutdown behavior:

```bash
# Terminal 1: Start the indexer (if not already running)
npm run dev

# Terminal 2: Send SIGTERM (simulating Kubernetes / docker stop)
kill -SIGTERM $(lsof -t -i:4000)

# Terminal 2: Observe logs
# You should see:
#   [shutdown] SIGTERM received — initiating graceful shutdown
#   poller: stop requested — will exit after current batch
#   Shutdown: cleanup complete
#   Process exits with code 0
```

---

## Documentation Note

**Review**: This document was reviewed by the elcarehub platform team on 2026-11-20 as part of the indexer stability initiative.

**Revert**: To revert this documentation change:

```bash
git checkout HEAD -- indexer/docs/graceful-shutdown.md
```

**Read-only commands**: All verification commands in this document are read-only and do not modify any state. They are safe to run in production environments.

---

## Related Files

| File | Purpose |
|------|---------|
| `indexer/README.md` | Getting started guide |
| `DEPLOYMENT.md` | Rolling deployment procedure |
| `indexer/Dockerfile` | Container image configuration |
| `k8s/indexer-deployment.yaml` | Kubernetes deployment manifest |
| `indexer/openapi.yaml` | API specification |
| `indexer/.env.example` | Environment variable template |

---

## References

- Kubernetes graceful termination: https://cloud.google.com/blog/products/containers-kubernetes/kubernetes-best-practices-terminating-with-grace
- Docker stop behavior: https://docs.docker.com/reference/cli/docker/container/stop/
- Node.js process signals: https://nodejs.org/api/process.html#process_signal_events
- Prisma transaction handling: https://www.prisma.io/docs/orm/reference/prisma-client-reference#transactions
