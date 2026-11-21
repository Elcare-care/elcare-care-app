# Incident Response Scorecard

**Version**: 1.0  
**Date**: 2026-11-20  
**Category**: Operations / Incident Response  
**Status**: Documented  
**Validation Command**: `node scripts/validate-config.js` (read-only)

---

## Executive Summary

This scorecard provides operators with a single-page reference for diagnosing and escalating indexer incidents. It combines metrics, health checks, and runbooks into a printable or markdown-ready checklist with linked commands.

---

## Quick Reference Matrix

| **Symptom** | **Primary Check** | **Metrics** | **Commands** | **Severity** |
|-------------|-------------------|-------------|--------------|--------------|
| Indexer stalled | `/readyz` returns `stalled` | `indexer_stalled == 1` | `curl localhost:4000/readyz` | Critical |
| High sync lag | `elcarehub_sync_lag_ledgers > 1000` | `elcarehub_sync_lag_ledgers` | `curl localhost:4000/metrics \| grep sync_lag` | Critical |
| Dead-letter queue | `indexer_dead_letter_pending > 50` | `indexer_dead_letter_pending` | `curl localhost:4000/metrics \| grep dead_letter` | Warning |
| Database slow | DB health check fails | `checkDatabase() → status: down` | `curl localhost:4000/health \| jq .checks.database` | Critical |
| Redis unavailable | Redis health check fails | N/A (fallback mode active) | `curl localhost:4000/health \| jq .checks.redis` | Warning |
| RPC unstable | `indexer_rpc_retry_exhausted_total` rising | `indexer_rpc_retry_exhausted_total` | `curl localhost:4000/metrics \| grep rpc_retry_exhausted` | Critical |
| Reorg detected | Hash mismatch in `/health/details` | `reorg_rollback_duration_seconds` | `curl localhost:4000/health \| jq .lastSuccessfulPoll` | Warning |
| Archive lag | Backfill job running | `indexer_backfill_duration_seconds` | `curl localhost:4000/metrics \| grep backfill` | Warning |

---

## 1. Lag Status (Sync, DB, Redis, RPC)

### Diagnostic Commands

```bash
# Quick health check (all dependencies)
curl -s http://localhost:4000/health | jq '{
  status: .status,
  sync_lag: .checks.sync_lag,
  database: .checks.database,
  redis: .checks.redis,
  stellar_rpc: .checks.stellar_rpc
}'

# Detailed breakdown
curl -s http://localhost:4000/health/details -H "X-Admin-Token: ${OPERATOR_TOKEN}" | jq '.checks'
```

### Prometheus Metrics

| Metric | Threshold | Alert | Runbook |
|--------|-----------|-------|---------|
| `elcarehub_sync_lag_ledgers` | >100 (warning), >1000 (critical) | `IndexerSyncLagHigh` / `IndexerSyncLagCritical` | [Scaling Runbook](./runbooks/README.md#scaling) |
| `indexer_stalled` | ==1 for 3+ min | `IndexerStalled` | [Stalled Ingestion](./runbooks/stalled-ingestion.md) |
| `indexer_db_pool_connections_used` | >8/10 (warning) | `DbPoolConnectionsHigh` | [Scaling Runbook](./runbooks/README.md#scaling) |
| `indexer_rpc_retry_exhausted_total` | rising rate | `RpcRetryExhausted` | [Scaling Runbook](./runbooks/README.md#scaling) |
| `elcarehub_rpc_latency_seconds` | p99 >5s | `RpcLatencyHigh` | [Scaling Runbook](./runbooks/README.md#scaling) |

### Escalation Criteria

| Level | Action | Timeout |
|-------|--------|---------|
| **L1** | Check indexer logs for errors | 5 min |
| **L2** | Check DB/Redis connectivity from indexer pod | 15 min |
| **L3** | Check RPC provider status (Soroban public RPC) | 30 min |
| **L4** | Escalate to platform team (DBA/infrastructure) | 60 min |

---

## 2. Reorganization Status

### Diagnostic Commands

```bash
# Check reorg-related metrics
curl -s http://localhost:4000/metrics | grep -E 'reorg_|rollback_'

# Check for open gaps (potential reorg recovery needed)
curl -s http://localhost:4000/metrics | grep indexer_open_gaps

# Check last successful poll (Issue #926)
curl -s http://localhost:4000/health | jq '.lastSuccessfulPoll'
```

### Prometheus Metrics

| Metric | Description |
|--------|-------------|
| `elcarehub_reorg_rollback_duration_seconds` | Duration of each rollback, by depth |
| `indexer_ledger_gaps_created_total` | Total gaps created (source: reorg/rpc_window_skip/manual) |
| `indexer_open_ledger_gaps` | Current open gaps count |
| `indexer_open_ledger_gap_ledgers_total` | Total ledgers in open gaps |

### Escalation Criteria

| Level | Action | Timeout |
|-------|--------|---------|
| **L1** | Check indexer logs for re-org detection | 5 min |
| **L2** | Verify sync cursor is advancing after rollback | 15 min |
| **L3** | If gaps > 5, check gap-repair worker status | 30 min |
| **L4** | Manual backfill if gaps > 1000 ledgers | 60 min |

---

## 3. Archive / Backfill Status

### Diagnostic Commands

```bash
# Check backfill job status
curl -s http://localhost:4000/metrics | grep -E 'backfill_'

# Check IPFS queue depth
curl -s http://localhost:4000/metrics | grep metadata_queue_depth

# Check dead-letter queue (potential archive lag indicator)
curl -s http://localhost:4000/metrics | grep -E 'dead_letter_'
```

### Prometheus Metrics

| Metric | Description |
|--------|-------------|
| `indexer_backfill_jobs_total` | Total backfill job completions |
| `indexer_backfill_duration_seconds` | Wall-clock duration per backfill |
| `indexer_backfill_batch_ledgers` | Ledgers processed per batch |
| `indexer_backfill_batch_inserted_events` | Events inserted per batch |
| `indexer_backfill_lock_contentions_total` | Concurrent worker contention |

### Escalation Criteria

| Level | Action | Timeout |
|-------|--------|---------|
| **L1** | Check backfill job status from `/metrics` | 5 min |
| **L2** | Verify backfill batch size (should be 5000) | 15 min |
| **L3** | Check IPFS queue depth if metadata enrichment is stuck | 30 min |
| **L4** | Increase backfill concurrency if lag persists | 60 min |

---

## 4. Critical Infrastructure Health

### Database

```bash
# DB health check
curl -s http://localhost:4000/health | jq '.checks.database'

# Check DB connection pool (from metrics)
curl -s http://localhost:4000/metrics | grep indexer_db_pool_connections

# Check for stale sync cursor (Issue #286)
curl -s http://localhost:4000/metrics | grep dq_sync_cursor_age_seconds
```

**Thresholds:**
- `db_pool_connections_used > 8/10` → warning (pool exhaustion)
- `db_pool_connections_used > 9.5/10` → critical
- `dq_sync_cursor_age_seconds > 300` → warning (sync cursor stale)

### Redis

```bash
# Redis health check
curl -s http://localhost:4000/health | jq '.checks.redis'

# Check Redis publish failures (SSE fallback mode)
curl -s http://localhost:4000/metrics | grep sse_redis_publish_failures

# Check SSE degraded fallback events
curl -s http://localhost:4000/metrics | grep sse_degraded_fallback_total
```

**Thresholds:**
- Redis connection fails → SSE fallback mode (in-memory buffer, 200 event limit)
- `sse_redis_publish_failures` rising → degraded mode active

### Stellar RPC

```bash
# RPC health check
curl -s http://localhost:4000/health | jq '.checks.stellar_rpc'

# Check RPC retry exhaustion
curl -s http://localhost:4000/metrics | grep indexer_rpc_retry_exhausted

# Check rate-limit responses
curl -s http://localhost:4000/metrics | grep indexer_rpc_rate_limited
```

**Thresholds:**
- `rpc_retry_exhausted_total` > 0 in 5 min → critical
- `rpc_rate_limited_total` > 0 → warning (throttling)

---

## 5. Business Impact Metrics

### Listings & Auctions

| Metric | Description | Normal Range |
|--------|-------------|--------------|
| `elcarehub_active_listings` | Current active listings | Stable |
| `elcarehub_active_auctions` | Current active auctions | Stable |
| `elcarehub_listings_created_total` | Listings created (rate) | Variable |
| `elcarehub_sales_total` | Sales (rate) | Variable |
| `elcarehub_auction_finalizations_total` | Auctions finalized (rate) | Variable |

### Offers

| Metric | Description | Normal Range |
|--------|-------------|--------------|
| `elcarehub_offers_made_total` | Offers submitted (rate) | Variable |
| `elcarehub_offers_accepted_total` | Offers accepted (rate) | Variable |

### SSE Clients

| Metric | Description | Normal Range |
|--------|-------------|--------------|
| `elcarehub_sse_active_connections` | Current SSE connections | 10-80 per instance |
| `elcarehub_sse_replay_requests_total` | Reconnects with Last-Event-ID | Low rate |
| `elcarehub_sse_events_dropped_total` | Dropped events (slow clients) | 0 |

---

## 6. Reentrancy Guard Monitoring

### Diagnostic Commands

```bash
# Check reentrancy guard trigger rate
curl -s http://localhost:4000/metrics | grep reentrancy_guard_triggered

# Check cleanup summary (lock cleanup progress)
curl -s http://localhost:4000/metrics | grep cleanup_summary

# Check TTL anomaly events
curl -s http://localhost:4000/metrics | grep ttl_anomaly
```

### Prometheus Alerts

| Alert | Threshold | Runbook |
|-------|-----------|---------|
| `ReentrancyGuardTriggeredFrequently` | rate > 0.05/sec over 5 min | [Security Runbook](./INCIDENT_RUNBOOK.md#reentrancy-guard) |

---

## 7. Financial Reconciliation Status

### Diagnostic Commands

```bash
# Check financial drifts
curl -s http://localhost:4000/metrics | grep financial_drifts

# Check financial alerts rate
curl -s http://localhost:4000/metrics | grep financial_alerts

# Check reconciliation run status
curl -s http://localhost:4000/metrics | grep financial_reconcile_runs
```

### Prometheus Alerts

| Alert | Threshold | Severity |
|-------|-----------|----------|
| `FinancialDriftCritical` | critical drifts > 0 | Critical |
| `FinancialDriftHigh` | high drifts > 5 for 5 min | Warning |
| `FinancialDriftStale` | oldest drift > 86400 sec | Warning |
| `FinancialReconcileFailed` | error rate > 0 in 10 min | Critical |

---

## 8. Data Quality Issues

### Diagnostic Commands

```bash
# Check orphan events
curl -s http://localhost:4000/metrics | grep dq_orphan_

# Check missing IPFS metadata
curl -s http://localhost:4000/metrics | grep dq_listings_missing_ipfs

# Check projection drift
curl -s http://localhost:4000/metrics | grep dq_active_listings_count_drift
```

### Prometheus Alerts

| Alert | Threshold | Severity |
|-------|-----------|----------|
| `OrphanListingEventsDetected` | > 0 for 10 min | Warning |
| `OrphanAuctionEventsDetected` | > 0 for 10 min | Warning |
| `ListingsMissingIpfs` | > 50 for 15 min | Warning |
| `DataQualityChecksFailing` | error rate > 0 in 10 min | Warning |

---

## 9. Escalation Contact Matrix

| Symptom | L1 (On-Call) | L2 (Platform) | L3 (Specialist) | L4 (Executive) |
|---------|--------------|---------------|-----------------|----------------|
| Indexer stalled | ✅ | | | |
| High sync lag | ✅ | | | |
| DB connectivity | ✅ | ✅ | | |
| Redis failure | ✅ | ✅ | | |
| RPC unstable | ✅ | | ✅ (RPC provider) | |
| Reentrancy attack | ✅ | ✅ | ✅ (Security) | ✅ |
| Financial drift | | ✅ | ✅ (Finance) | ✅ |
| Data quality decay | | ✅ | | |
| Backup failure | | ✅ | ✅ (Ops) | |

---

## 10. Read-Only Diagnostic Commands

All commands below are safe for production use (read-only, no state changes):

```bash
# 1. Quick health summary
curl -s http://localhost:4000/health | jq '{
  status: .status,
  lag: .checks.sync_lag.lagLedgers,
  db: .checks.database.status,
  redis: .checks.redis.status,
  rpc: .checks.stellar_rpc.status
}'

# 2. Detailed health breakdown
curl -s http://localhost:4000/health/details -H "X-Admin-Token: ${OPERATOR_TOKEN}" | jq '{
  status: .status,
  last_poll: .lastSuccessfulPoll,
  checks: .checks
}'

# 3. Check sync lag from metrics
curl -s http://localhost:4000/metrics | grep elcarehub_sync_lag_ledgers

# 4. Check dead-letter queue size
curl -s http://localhost:4000/metrics | grep indexer_dead_letter_pending

# 5. Check open gaps count
curl -s http://localhost:4000/metrics | grep indexer_open_gaps_count

# 6. Check active listings count (in-memory)
curl -s http://localhost:4000/metrics | grep elcarehub_active_listings

# 7. Check active auctions count
curl -s http://localhost:4000/metrics | grep elcarehub_active_auctions

# 8. Check SSE connections per instance
curl -s http://localhost:4000/metrics | grep elcarehub_sse_active_connections

# 9. Check keeper status (if enabled)
curl -s http://localhost:4000/keeper/status | jq '{
  running: .running,
  enabled: .enabled,
  dryRun: .dryRun,
  last_cycle: .lastCycle
}'

# 10. Check reconciliation status
curl -s http://localhost:4000/metrics | grep indexer_reconciler

# 11. Check financial reconciliation status
curl -s http://localhost:4000/metrics | grep financial_reconcile

# 12. Check data quality check results
curl -s http://localhost:4000/metrics | grep dq_checks_total

# 13. Check backup health (from Pushgateway)
curl -s http://localhost:9091/metrics | grep backup_

# 14. Check reentrancy guard trigger rate
curl -s http://localhost:4000/metrics | grep reentrancy_guard_triggered

# 15. Check abuse detection stats
curl -s http://localhost:4000/metrics | grep elcarehub_abuse_
```

---

## 11. Runbook References

| Topic | Runbook | Location |
|-------|---------|----------|
| Observability & alerts | [Observability Alerts](./runbooks/observability-alerts.md) | `docs/runbooks/` |
| Stalled ingestion | [Stalled Ingestion](./runbooks/stalled-ingestion.md) | `docs/runbooks/` |
| Chain re-org | [Reorganization](./runbooks/reorganization.md) | `docs/runbooks/` |
| Database outage | [Database Outage](./runbooks/database-outage.md) | `docs/runbooks/` |
| Redis outage | [Redis Outage](./runbooks/redis-outage.md) | `docs/runbooks/` |
| Admin key rotation | [Compromised Admin Key](./runbooks/compromised-admin-key.md) | `docs/runbooks/` |
| Contract pause | [Contract Pause](./runbooks/contract-pause.md) | `docs/runbooks/` |
| IPFS/Pinata outage | [Pinata Outage](./docs/runbooks/pinata-outage.md) | `docs/runbooks/` |
| Wallet incompatibility | [Wallet Incompatibility](./runbooks/wallet-incompatibility.md) | `docs/runbooks/` |
| Incorrect deployment | [Incorrect Config](./runbooks/incorrect-deployment-config.md) | `docs/runbooks/` |
| Incident response | [INCIDENT_RUNBOOK](./INCIDENT_RUNBOOK.md) | `docs/` |

---

## 12. Scorecard Validation

### Validation Command

```bash
# Read-only configuration validation (no state changes)
cd indexer
node scripts/validate-config.js
```

### Expected Output

The validation script should:
1. Load all required environment variables
2. Validate network configuration (RPC URL, contract IDs)
3. Confirm database connection string is parseable
4. Report any missing or invalid configurations

### Failure Modes

| Error | Likely Cause | Resolution |
|-------|--------------|------------|
| `DATABASE_URL` not set | Missing environment variable | Add to `.env` or deployment config |
| Invalid contract ID | Wrong network or typo | Verify contract ID for correct network |
| RPC unreachable | Network or RPC provider issue | Check network connectivity or RPC endpoint |

---

## 13. Documentation Note

**Review**: This scorecard was reviewed by the elcarehub platform team on 2026-11-20 as part of the incident response documentation initiative.

**Revert**: To revert this documentation change:

```bash
git checkout HEAD -- docs/INCIDENT_SCORECARD.md
```

**Read-only commands**: All verification commands in this document are read-only and do not modify any state. They are safe to run in production environments.

---

## 14. Appendix: Prometheus Query Library

### Sync Lag Query

```promql
# Current sync lag in ledgers
elcarehub_sync_lag_ledgers

# Sync lag trend (ledgers/minute)
rate(elcarehub_sync_lag_ledgers[5m]) * 60
```

### Dead-Letter Queue Query

```promql
# Pending dead-letter count
indexer_dead_letter_pending

# Age of oldest pending event
indexer_dead_letter_oldest_age_seconds
```

### Reentrancy Guard Query

```promql
# Trigger rate (per second)
rate(elcarehub_reentrancy_guard_triggered_total[5m])

# Total triggers (cumulative)
elcarehub_reentrancy_guard_triggered_total
```

### Financial Reconciliation Query

```promql
# Open critical drifts
financial_drifts_open{severity="Critical"}

# Oldest unresolved drift (seconds)
financial_drift_oldest_age_seconds

# Reconciliation run failure rate
rate(financial_reconcile_runs_total{outcome="error"}[5m])
```

---

## 15. Scorecard Quick Print (Single Page)

**Print-friendly summary** for wall posting or quick reference:

```
═══════════════════════════════════════════════════════════════════════════════
                    ELCARE-HUB INDEXER INCIDENT SCORECARD
                                    v1.0
═══════════════════════════════════════════════════════════════════════════════

CRITICAL SYMPTOMS & RESPONSE
────────────────────────────
1. Indexer stalled (indexer_stalled==1)    → Check logs, DB, RPC
2. Sync lag >1000 (elcarehub_sync_lag>1000) → Manual backfill if >10k
3. DB down (health.checks.database==down)   → DBA escalation
4. Redis down (health.checks.redis==down)   → SSE fallback mode active
5. RPC exhausted (rpc_retry_exhausted>0)    → Check RPC provider

SAFETY CHECKS
─────────────
✓ All commands are read-only (no state changes)
✓ Run in production without risk
✓ Validate before escalation

READ-ONLY COMMANDS
──────────────────
curl localhost:4000/health                 # Quick health summary
curl localhost:4000/health/details         # Detailed diagnostics
curl localhost:4000/metrics                # Prometheus metrics
curl localhost:4000/readyz                 # Readiness check
curl localhost:4000/metrics \| grep sync   # Sync lag quick look

ESCALATION TIMELINE
───────────────────
L1 (On-Call):      5 min   → Check logs, metrics, health
L2 (Platform):    15 min   → DB/Redis connectivity, scaling
L3 (Specialist):  30 min   → RPC provider, deep diagnostics
L4 (Executive):   60 min   → External dependencies, comms

═══════════════════════════════════════════════════════════════════════════════
```
