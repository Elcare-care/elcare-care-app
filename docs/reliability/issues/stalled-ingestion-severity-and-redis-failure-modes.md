# Issue: Stalled Ingestion Severity Classification + Redis Failure-Mode Matrix

**Category:** Reliability, Security, and Operations  
**Status:** Implemented  
**Implemented:** 2026-11-22  
**Owner:** `indexer-team`  
**Reviewable by:** on-call SRE, Backend Lead

---

## Task A — Stalled Ingestion Severity Classification

### Description

Stalled ingestion may be mild, degraded, or down based on ledger lag and duration. Operators had
no documented mapping from alert name to severity level, and the alert rules carried no machine-
readable label indicating which tier was active.

### Work done

| Step | Evidence |
|---|---|
| Inspected `indexer/prometheus-alerts.yml` for existing thresholds and metric names | `IndexerSyncLagHigh` (100 ledgers, 2 m), `IndexerSyncLagCritical` (1 000 ledgers, 1 m), `IndexerStalled` (3 m), `IndexerPollerRestartHigh` (3 restarts/10 m) confirmed |
| Validated metric names against `indexer/src/metrics.ts` | `elcarehub_sync_lag_ledgers` → `syncLagLedgersGauge`; `indexer_stalled` → `stalledGauge`; `elcarehub_poller_restart_total` → `pollerRestartTotal` — all present |
| Added `ingestion_severity: mild/degraded/down` label to all four sync-health alert rules | `indexer/prometheus-alerts.yml` — sync health section updated |
| Added new `IndexerSyncLagSustained` alert (lag > 1 000 ledgers for 10 min, `ingestion_severity: down`) | Covers the gap between 1-minute degraded fire and a truly sustained outage |
| Added `owner: indexer-team` and `runbook:` annotation to all updated alerts | Consistent with the existing data-quality and autoscaling alerts in the same file |
| Created `docs/runbooks/stalled-ingestion-severity.md` | Defines all three severity levels with thresholds, metrics, user impact, actions, and a threshold-summary table |
| Updated `docs/runbooks/observability-alerts.md` alert index | Added `IndexerSyncLagSustained`; added `ingestion_severity` column; added cross-reference to new severity doc |
| Updated `docs/runbooks/README.md` | Indexed `stalled-ingestion-severity.md` |

### Validation

```bash
# Confirm all four sync-health alert rules are present and carry ingestion_severity label
grep -n "ingestion_severity" elcare-care-app/indexer/prometheus-alerts.yml
# Expected: four lines — mild, degraded, degraded, down (IndexerSyncLagHigh, IndexerSyncLagCritical,
#           IndexerStalled, IndexerPollerRestartHigh) plus a fifth for IndexerSyncLagSustained

# Confirm new alert present
grep -n "IndexerSyncLagSustained" elcare-care-app/indexer/prometheus-alerts.yml
# Expected: one rule definition

# Confirm metric names exist in source
grep -n "syncLagLedgersGauge\|stalledGauge\|pollerRestartTotal" \
  elcare-care-app/indexer/src/metrics.ts
# Expected: three definition lines

# Confirm severity doc exists and is linked
grep -n "stalled-ingestion-severity" \
  elcare-care-app/docs/runbooks/README.md \
  elcare-care-app/docs/runbooks/observability-alerts.md
# Expected: one line in each file
```

### Measurable result

Before: sync-health alerts had no `ingestion_severity` label; `IndexerSyncLagSustained` did not
exist; no document mapped alert names to mild/degraded/down.

After: every sync-health alert carries a machine-readable `ingestion_severity` label; a new
`IndexerSyncLagSustained` (down) alert fires after 10 minutes of sustained critical lag; and
`docs/runbooks/stalled-ingestion-severity.md` provides a repeatable, threshold-sourced reference
that operators can follow without reading source code.

### Rollback

```bash
# Revert the prometheus-alerts.yml sync-health section to remove the new labels/alert:
git revert <commit-hash>

# Or manually: remove ingestion_severity labels and IndexerSyncLagSustained from
# indexer/prometheus-alerts.yml, and delete:
#   docs/runbooks/stalled-ingestion-severity.md
# No runtime state is changed; no deployments are triggered.
```

---

## Task B — Redis Failure-Mode Matrix

### Description

Operators needed to know whether rate limiting, caching, SSE, and abuse detection fail open or
degrade when Redis is unavailable. The existing `redis-outage.md` described restart procedures
but did not document per-surface behavior or which metrics signal each degradation mode.

### Work done

| Step | Evidence |
|---|---|
| Inspected `indexer/src/redis.ts` | `disableOfflineQueue: true`; exponential backoff reconnect (50 ms base, 3 000 ms cap, ±100 ms jitter) confirmed |
| Inspected `indexer/src/api/cache-middleware.ts` | `isRedisReady()` guard → `next()` on miss or error; cache write failure non-fatal; fail-open confirmed |
| Inspected `indexer/src/api/cache-service.ts` | Distributed thundering-herd lock falls back to in-process `inflight` Map when Redis unavailable; fail-open confirmed |
| Inspected `indexer/src/api/rate-limit-middleware.ts` | `express-rate-limit` default in-memory store — **not Redis-dependent**; no fail behavior |
| Inspected `indexer/src/realtime/hub.ts` | `redisUsable()` guard; on failure: `sseRedisPublishFailuresTotal.inc()` → `sseDegradedFallbackTotal.inc()` → in-memory ring (200 events), local-pod delivery only; subscriber uses `scheduleResubscribe()` loop; fail-open confirmed |
| Inspected `indexer/src/api/abuse-detection.ts` | `isRedisReady()` → `failOpen()` → `abuseDetectionRedisFailureTotal.inc()` → `next()` for quota checks and passive blocklist checks; write operations (`blockKey`/`unblockKey`) throw when Redis unavailable (fail-closed, by design) |
| Confirmed all observation metrics exist in `indexer/src/metrics.ts` | `elcarehub_sse_redis_publish_failures_total`, `elcarehub_sse_degraded_fallback_total`, `elcarehub_sse_subscriber_reconnects_total`, `elcarehub_abuse_detection_redis_failures_total`, `elcarehub_cache_bypass_total` — all defined |
| Created `docs/runbooks/redis-failure-modes.md` | Six-surface matrix with fail-open/fail-closed, observation metrics, recovery checklist, and configuration reference |
| Updated `docs/runbooks/redis-outage.md` Detection section | Added `elcarehub_sse_degraded_fallback_total` and `elcarehub_abuse_detection_redis_failures_total` as automatic signals; added SSE and abuse-detection manual checks |
| Updated `docs/runbooks/redis-outage.md` Impact Assessment section | Replaced single-column table with six-surface fail-open matrix; added reference to `redis-failure-modes.md` |
| Updated `docs/runbooks/redis-outage.md` Related Runbooks section | Added link to `redis-failure-modes.md` |
| Updated `docs/runbooks/README.md` | Indexed `redis-failure-modes.md` |

### Validation

```bash
# Confirm failure-modes doc exists
ls elcare-care-app/docs/runbooks/redis-failure-modes.md

# Confirm all six surfaces are documented
grep -c "^### [0-9]\." elcare-care-app/docs/runbooks/redis-failure-modes.md
# Expected: 6

# Confirm observation metrics are defined in source
grep -n "sseRedisPublishFailuresTotal\|sseDegradedFallbackTotal\|sseSubscriberReconnectsTotal\|abuseDetectionRedisFailure" \
  elcare-care-app/indexer/src/metrics.ts
# Expected: four definition lines

# Confirm redis-failure-modes.md is linked from redis-outage.md
grep -n "redis-failure-modes" elcare-care-app/docs/runbooks/redis-outage.md
# Expected: two lines (Detection section + Related Runbooks)

# Confirm README indexes the new file
grep -n "redis-failure-modes" elcare-care-app/docs/runbooks/README.md
# Expected: one line
```

### Measurable result

Before: `redis-outage.md` described only restart/OOM/connection-limit procedures; no document
listed per-surface fail-open behavior or which metrics signal each degradation mode; two
Prometheus metrics (`elcarehub_sse_degraded_fallback_total`,
`elcarehub_abuse_detection_redis_failures_total`) were defined but never referenced in any
runbook.

After: `docs/runbooks/redis-failure-modes.md` provides a repeatable, source-verified six-surface
matrix; `redis-outage.md` Detection and Impact sections now reference both new metrics and the
matrix; every surface's fail-open behavior, security implication, and recovery observation is
documented in one place.

### Rollback

```bash
# Delete the new file:
#   docs/runbooks/redis-failure-modes.md
# Revert redis-outage.md to its previous Detection / Impact Assessment / Related Runbooks
# sections (or: git revert <commit-hash>).
# No runtime state, secrets, or deployments are affected.
```

---

## Shared Owner / Escalation / Rollback Summary

| Field | Value |
|---|---|
| **Owner** | `indexer-team` (primary); on-call SRE (escalation); Backend Lead (after 15 min unresolved) |
| **Trigger** | Alert fires with `ingestion_severity` label (Task A); `/health → checks.redis.status = "down"` or `elcarehub_sse_degraded_fallback_total` / `elcarehub_abuse_detection_redis_failures_total` increasing (Task B) |
| **Expected output** | Alert resolves, metrics return to baseline, lag decreases — all without process restart in mild/degraded cases |
| **Rollback** | `git revert <commit>` on the relevant commit(s); no secrets, no production deployment, no data mutation involved in either task |
| **No secrets introduced** | ✅ Confirmed — no credentials, tokens, or environment variables added |
| **No destructive operations** | ✅ Confirmed — documentation and alert-label changes only |
