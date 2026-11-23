# Stalled Ingestion — Severity Classification

**Issue:** Reliability, Security, and Operations  
**Owner:** `indexer-team` (primary), on-call SRE (escalation)  
**Alert source:** `indexer/prometheus-alerts.yml` (group `elcarehub_indexer`)  
**Related runbook:** [stalled-ingestion.md](./stalled-ingestion.md)

---

## Purpose

This document defines three ingestion severity levels — **Mild**, **Degraded**, and **Down** — using
concrete ledger-lag and duration thresholds derived from the existing Prometheus alert rules. It maps
each level to the alerts that fire, the user impact, and the required operator action.

---

## Severity Levels

### Mild

| Dimension | Value |
|---|---|
| **Prometheus alerts** | `IndexerSyncLagHigh` |
| **Metric condition** | `elcarehub_sync_lag_ledgers > 100` for ≥ 2 minutes |
| **`ingestion_severity` label** | `mild` |
| **User impact** | Listings, bids, and sales from the last few minutes may not appear yet. No data loss. Existing state is correct. |
| **Funds safety** | ✅ Not at risk |
| **On-call page?** | No. Monitor; auto-resolves in most cases. |
| **Verification metric** | `elcarehub_sync_lag_ledgers` trending down |
| **Automatic recovery?** | Yes — the poller catches up once RPC connectivity is restored. |

**What typically causes it:** Transient RPC latency spike, brief network hiccup, or a momentary
rate-limit (HTTP 429) from the Stellar RPC provider. The poller falls behind but resumes.

---

### Degraded

| Dimension | Value |
|---|---|
| **Prometheus alerts** | `IndexerSyncLagCritical`, `IndexerStalled` |
| **Metric conditions** | `elcarehub_sync_lag_ledgers > 1000` for ≥ 1 min  **OR** `indexer_stalled == 1` for ≥ 3 min |
| **`ingestion_severity` label** | `degraded` |
| **User impact** | New transactions (listings, bids, purchases) are not reflected in the UI. Frontend shows stale marketplace state. |
| **Funds safety** | ✅ Not at risk — PostgreSQL and Soroban contracts hold the source of truth. |
| **On-call page?** | Yes — investigate within 15 minutes. |
| **Verification metric** | `indexer_stalled` drops to 0; `elcarehub_sync_lag_ledgers` starts decreasing |
| **Automatic recovery?** | Partial — the stall watchdog will attempt up to 3 automatic poller restarts. If RPC is healthy it usually recovers within 2 poll cycles (~10 s). |

**What typically causes it:** RPC endpoint down or returning sustained errors, DB connection pool
exhaustion, or a chain reorg that the poller cannot auto-resolve.

**First actions:**

```bash
# 1. Check health endpoint (READ-ONLY)
curl http://localhost:4000/health | jq '.checks'

# 2. Check which dependency is unhealthy
# - checks.stellar_rpc.status = "down" → follow stalled-ingestion.md §A
# - checks.database.status = "down"    → follow stalled-ingestion.md §B
# - checks.sync_lag.status = "down"    → check for re-org (stalled-ingestion.md §C)

# 3. Check stall watchdog restart count (READ-ONLY)
curl http://localhost:4000/metrics | grep elcarehub_poller_restart_total
```

---

### Down

| Dimension | Value |
|---|---|
| **Prometheus alerts** | `IndexerSyncLagSustained`, `IndexerPollerRestartHigh` |
| **Metric conditions** | `elcarehub_sync_lag_ledgers > 1000` for ≥ 10 min  **OR** `increase(elcarehub_poller_restart_total[10m]) >= 3` |
| **`ingestion_severity` label** | `down` |
| **User impact** | Effectively no new on-chain activity visible to users. All live marketplace data is stale. The process is about to exit (on the third automatic restart it exits with a non-zero code). |
| **Funds safety** | ✅ Not at risk — funds are in Soroban contracts. Users cannot interact via the UI until recovery. |
| **On-call page?** | Yes — immediate response required. |
| **Verification metric** | `indexer_stalled` = 0; `elcarehub_poller_restart_total` stops increasing; `elcarehub_sync_lag_ledgers` decreasing |
| **Automatic recovery?** | No — requires operator intervention after the process exits. |

**What typically causes it:** Persistent RPC outage lasting > 10 minutes, database outage, deep
chain reorg (> `MAX_ROLLBACK_DEPTH`) halting the poller, or a fatal process crash.

**First actions:**

```bash
# 1. Check whether the process has already exited
docker compose ps indexer     # or: kubectl get pods -l app=indexer

# 2. If exited, check why
docker compose logs --tail=50 indexer | grep -iE 'fatal|exit|stall|restarts'

# 3. Restart (only after identifying root cause)
docker compose restart indexer

# 4. If poller halted due to deep reorg (halted=true in /health/details):
#    Follow stalled-ingestion.md §C (Deep Reorg — Poller Halted)
```

---

## Decision Tree

```
         [ Alert fires ]
                │
                ▼
  Read ingestion_severity label
                │
   ┌────────────┼─────────────┐
   ▼            ▼             ▼
 mild        degraded        down
   │            │             │
   ▼            ▼             ▼
Monitor.     Page within   Immediate page.
Check        15 minutes.   Process may have
lag trend.   Check health  exited. Follow
             endpoint.     stalled-ingestion.md
             Follow A/B/C  §A, §B, or §C.
             in runbook.   
```

---

## Metric Name Validation

All metric names below are confirmed present in `indexer/src/metrics.ts`:

| Metric | Definition location | Used in alert |
|---|---|---|
| `elcarehub_sync_lag_ledgers` | `syncLagLedgersGauge` (metrics.ts line ~170) | `IndexerSyncLagHigh`, `IndexerSyncLagCritical`, `IndexerSyncLagSustained` |
| `indexer_stalled` | `stalledGauge` (metrics.ts line ~110) | `IndexerStalled` |
| `elcarehub_poller_restart_total` | `pollerRestartTotal` (metrics.ts line ~135) | `IndexerPollerRestartHigh` |
| `indexer_latest_ledger_processed` | `latestLedgerProcessedGauge` (metrics.ts line ~20) | Grafana dashboard (not an alert) |

> If `elcarehub_sync_lag_ledgers` returns no data, the metric is likely named
> `indexer_sync_latency_ledgers` on older indexer builds (before the gauge alias
> was added). Both names are registered. The alert rules target the canonical name
> `elcarehub_sync_lag_ledgers`.

---

## Thresholds Summary

| Threshold | Alert | Severity level |
|---|---|---|
| Lag > 100 ledgers for 2 min | `IndexerSyncLagHigh` | mild |
| Lag > 1 000 ledgers for 1 min | `IndexerSyncLagCritical` | degraded |
| `indexer_stalled` == 1 for 3 min | `IndexerStalled` | degraded |
| Lag > 1 000 ledgers for 10 min | `IndexerSyncLagSustained` | down |
| 3+ automatic restarts in 10 min | `IndexerPollerRestartHigh` | down |

These thresholds match the `for:` values in `indexer/prometheus-alerts.yml`. Changing
a threshold requires updating **both** the alert rule and this table.

---

## Owner, Trigger, Expected Output, Rollback

| Field | Value |
|---|---|
| **Owner** | `indexer-team`; escalation → on-call SRE → Backend Lead |
| **Trigger** | Prometheus alert fires → PagerDuty / Slack `#alerts` |
| **Expected output** | Alert resolves automatically (mild); `indexer_stalled` drops to 0 and lag decreases (degraded/down) |
| **Rollback / Escalation** | For degraded/down: restart indexer process; if poller halted by deep reorg, follow stalled-ingestion.md §C; if RPC down, activate fallback via rpc-fallback-activation.md; escalate to Backend Lead after 15 min unresolved |

---

## Related

- [stalled-ingestion.md](./stalled-ingestion.md) — full diagnosis and recovery procedures
- [observability-alerts.md](./observability-alerts.md) — per-alert response procedures
- [rpc-fallback-activation.md](./rpc-fallback-activation.md) — switching to a fallback RPC endpoint
- [reorganization.md](./reorganization.md) — deep reorg recovery
- `indexer/prometheus-alerts.yml` — authoritative alert definitions
