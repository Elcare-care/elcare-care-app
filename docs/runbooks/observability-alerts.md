# Observability & Alert Response Runbook

This runbook explains how to interpret and respond to each Prometheus alert defined
in `indexer/prometheus-alerts.yml`. For infrastructure outage runbooks (database,
Redis, RPC), see the companion files in this directory.

---

## Alert Index

| Alert | Severity | What it means |
|---|---|---|
| IndexerSyncLagHigh | warning | >100 ledgers behind network tip |
| IndexerSyncLagCritical | critical | >1,000 ledgers behind — likely stalled |
| IndexerStalled | critical | Poller completely stopped for 3+ minutes |
| IndexerPollerRestartHigh | critical | 3+ automatic restarts in 10 min (process exit imminent) |
| HighDecodeErrorRate | warning | XDR parse failures spike — possible contract schema drift |
| UnsupportedSchemaVersionSeen | warning | Contract upgrade shipped without indexer update |
| DeadLetterQueueGrowing | warning | >50 events stuck in dead-letter storage |
| DeadLetterOldestEventStale | warning | Oldest dead-letter event >1 hour old |
| ApiHighP99Latency | warning | API P99 >2 s |
| ApiHighErrorRate | warning | >0.5 user tx errors/sec |
| ReentrancyGuardTriggeredFrequently | warning | Possible exploit probe — contract reentrancy guard firing |
| RpcRetryExhausted | critical | Stellar RPC unreachable after all retries |
| ReconcilerDriftHigh | warning | >100 records with on-chain drift in one reconciliation run |

---

## Dashboard Quick-Access

Open the Grafana dashboard **ElcareHub Indexer** (import `grafana/elcarehub-dashboard.json`).

Key panels to check first during an incident:

- **Sync Lag (ledgers)** — should be < 100 at all times
- **Indexer Stalled** — should be 0
- **Sync Lag Over Time** — shows trend; a flat line means the poller is stuck
- **API P99 Latency** — should stay below 500 ms under normal load
- **Transaction Error Rate** — sourced from `elcarehub_tx_submission_errors_total`

---

## Response Procedures

### IndexerSyncLagHigh / IndexerSyncLagCritical

1. Open the Grafana **Sync Lag Over Time** panel and check whether lag is growing or stable.
2. Check Stellar RPC health:
   ```
   GET /health  →  checks.stellar_rpc.status
   ```
3. Check the poller logs for connection errors or repeated timeouts:
   ```bash
   docker logs elcarehub-indexer --tail 200 | grep -i "rpc\|timeout\|error"
   ```
4. If the RPC endpoint is healthy but lag is growing, check whether a ledger gap
   has formed — see [stalled-ingestion.md](./stalled-ingestion.md).
5. If lag exceeds 10,000 ledgers, consider triggering a targeted backfill.

---

### IndexerStalled

The poller has stopped advancing entirely.

1. Check `/health` — if `sync_lag.status` is `down`, the gap is already confirmed.
2. Look for a `[stall]` log entry with severity `fatal` — this triggers a process restart.
3. If the process has not restarted, trigger one manually:
   ```bash
   docker restart elcarehub-indexer
   ```
4. If the poller restart count hits 3, the process exits with a non-zero code.
   Ensure your container orchestrator (Docker Compose / Kubernetes) is configured
   with `restart: always` so it recovers automatically.
5. Post-recovery: verify lag decreases in the Grafana panel within 2 minutes.

---

### IndexerPollerRestartHigh

Three or more automatic restarts in 10 minutes means the process is about to exit.

1. Treat as **IndexerStalled** — follow that procedure first.
2. If restarts continue after the process exits and relaunches, the root cause is
   persistent (bad RPC endpoint, DB down, config error). Fix the underlying issue
   before the auto-restart loop runs again.

---

### HighDecodeErrorRate / UnsupportedSchemaVersionSeen

These indicate that on-chain events cannot be parsed by the current indexer build.

1. Check `indexer_decode_errors_by_type_total` (labeled by `event_type`) to identify
   which event type is failing.
2. Check `indexer_unsupported_schema_version_total` to see whether a schema_version
   bump is responsible.
3. Compare the contract source (`contracts/`) against the event schemas in
   `indexer/src/event-schemas.ts`. If the contract was updated, the indexer needs
   a matching schema update.
4. Deploy the updated indexer build. Events that failed during the gap are stored in
   the dead-letter queue — see **DeadLetterQueueGrowing** below.

---

### DeadLetterQueueGrowing / DeadLetterOldestEventStale

Events that could not be parsed or written are stored in dead-letter storage for
later replay.

1. Query the dead-letter table to understand error distribution:
   ```sql
   SELECT error_code, COUNT(*) FROM dead_letter GROUP BY error_code ORDER BY 2 DESC;
   ```
2. Once the root cause is fixed (schema update deployed, decode bug patched), trigger
   a replay for the affected events via the `/admin/dead-letter/replay` endpoint or
   the CLI:
   ```bash
   pnpm indexer dead-letter:replay --error-code <code>
   ```
3. Monitor `indexer_dead_letter_pending` in Grafana — it should trend to zero.

---

### ApiHighP99Latency

1. Check Grafana **API Latency by Route** to identify the slow endpoint.
2. Run `EXPLAIN ANALYZE` on the underlying query if it is database-backed.
3. Check Redis cache hit rate — a cold cache after a restart causes a latency spike
   that resolves within a few minutes.
4. If a single route is consistently slow, check for a missing index or N+1 query.

---

### ApiHighErrorRate

Sourced from `elcarehub_tx_submission_errors_total{category=...}`.

1. Break down by `category` label to distinguish:
   - `wallet_rejection` — user-side; not a platform problem unless the rate is abnormal
   - `simulation_failure` — likely a contract state change or insufficient balance
   - `rpc_failure` — Stellar RPC degraded; correlate with IndexerSyncLagHigh
   - `unknown` — needs investigation; check the indexer error logs
2. If `rpc_failure` dominates, follow the **RpcRetryExhausted** procedure.
3. If `simulation_failure` dominates during a new deployment, verify the contract
   ABI matches the frontend client library.

---

### ReentrancyGuardTriggeredFrequently

Error code 22 (`ReentrancyGuard`) firing repeatedly is a security signal.

1. Identify the source: check which wallet addresses are triggering the error via
   the indexer event log or Stellar Explorer.
2. If the pattern looks automated (regular intervals, single address), consider
   temporarily revoking that artist address from the admin dashboard.
3. Escalate to the security contact if the pattern appears to be an exploit attempt.
   See [SECURITY.md](../../SECURITY.md).

---

### RpcRetryExhausted

The indexer has exhausted all retries against the Stellar RPC.

1. Check the configured `STELLAR_RPC_URL` in the environment — verify it resolves.
2. Check the Stellar Network status page for outages.
3. If the primary RPC is down, update `STELLAR_RPC_URL` to a fallback endpoint and
   restart the indexer.
4. After recovery, verify sync lag begins decreasing within 2 minutes.

---

### ReconcilerDriftHigh

More than 100 records show on-chain drift in a single reconciliation run.

1. Check `indexer_reconciler_discrepancies_total{model="..."}` to see which model
   (listing, auction, offer, collection) has the most drift.
2. If the drift is systematic (same field across many records), suspect a bug in the
   indexer parser for that event type.
3. Run the reconciler in repair mode (not dry-run) after the root cause is fixed:
   ```bash
   RECONCILER_DRY_RUN=false pnpm indexer reconcile
   ```
4. Monitor `indexer_reconciler_drift_records` — it should drop to near zero after
   a successful repair pass.

---

## Health Endpoint Reference

| Endpoint | Purpose |
|---|---|
| `GET /health` | Full dependency status (DB, Redis, RPC, sync lag, confirmation depth) |
| `GET /readyz` | Readiness: DB + sync lag only — used by load-balancer health checks |
| `GET /health/details` | Same as `/health` with version metadata |
| `GET /metrics` | Prometheus scrape endpoint |

A healthy response from `/health` looks like:
```json
{
  "status": "ok",
  "checks": {
    "database":           { "status": "ok", "latencyMs": 4 },
    "redis":              { "status": "ok", "latencyMs": 1 },
    "stellar_rpc":        { "status": "ok", "latencyMs": 120 },
    "sync_lag":           { "status": "ok", "latencyMs": 80, "lagLedgers": 2 },
    "confirmation_depth": { "status": "ok", "latencyMs": 6, "pendingConfirmationCount": 0 }
  },
  "status": "ok"
}
```

Any `"status": "down"` on `database` or `sync_lag` will make `/readyz` return HTTP 503,
removing the indexer from the load-balancer rotation.
