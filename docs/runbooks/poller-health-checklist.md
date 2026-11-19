# Poller Health Checklist

**Issue:** #1063 · **Audience:** on-call operators · **Mutates data:** No (all checks are read-only)

This checklist classifies the poller as **Healthy**, **Degraded**,
**Stalled**, or **Re-org** using existing endpoints, metrics, and the
`SyncState` row, so nobody has to guess from raw logs. When the state is
Stalled, continue with [stalled-ingestion.md](./stalled-ingestion.md). When it
is Re-org, continue with [reorganization.md](./reorganization.md).

Every threshold below is taken from source:
`indexer/src/health.ts` (`SYNC_LAG_DEGRADED = 100`, `SYNC_LAG_DOWN = 1000`),
`indexer/src/stall.ts` and `indexer/src/config.ts` (`STALL_WARNING_MS` 30 s,
`STALL_CRITICAL_MS` 120 s, `STALL_FATAL_MS` 300 s, 5 consecutive RPC failures,
`MAX_ROLLBACK_DEPTH` 100, `POLL_INTERVAL_MS` 5 s).

---

## 1. Collect signals (READ-ONLY)

```bash
# READ-ONLY — dependency + lag summary (no auth, no writes)
curl -s "$INDEXER_URL/health" | jq '{status, sync_lag: .checks.sync_lag, rpc: .checks.stellar_rpc}'

# READ-ONLY — readiness (503 when stalled or lag > 1000)
curl -s -w '\nHTTP %{http_code}\n' "$INDEXER_URL/readyz"

# READ-ONLY — poller metrics. Sample twice, ~10 s apart, to see movement.
curl -s "$INDEXER_URL/metrics" | grep -E \
  '^(indexer_latest_ledger_processed|indexer_network_latest_ledger|indexer_sync_latency_ledgers|indexer_stalled|elcarehub_poller_stall_total|elcarehub_poller_restart_total|indexer_open_ledger_gaps|indexer_ledger_gaps_created_total)'

# READ-ONLY — persisted cursor (read-only session)
PGOPTIONS='-c default_transaction_read_only=on' psql "$DATABASE_URL" -X -At -c \
  'SELECT "lastLedger", "updatedAt" FROM "SyncState" WHERE id = 1;'

# READ-ONLY — recent re-org / stall log lines
docker compose -f indexer/docker-compose.yml logs --since 15m indexer \
  | grep -E 'Chain re-org detected|Reorg: rolling back|halting poller|stall'
```

---

## 2. Classify

Work from the top. The first row that matches is the state.

| State | Signals (all from step 1) | Expected ledger lag | `/health` · `/readyz` | Required next command |
|---|---|---|---|---|
| **Re-org (deep, halted)** | Log `CRITICAL: Re-org depth exceeds MAX_ROLLBACK_DEPTH — halting poller`; SSE `CRITICAL_REORG`; `indexer_latest_ledger_processed` frozen | Grows by about 1 ledger every 5 s | `degraded`/`down` · 503 once stall thresholds pass | Stop. Follow [reorganization.md](./reorganization.md) § deep re-org. Do **not** edit `SyncState`. |
| **Re-org (shallow, auto-recovered)** | Log `Chain re-org detected` then `Reorg: rolling back`; SSE `REORG`; `indexer_ledger_gaps_created_total{source="reorg"}` may also increase (cursor ahead of network tip); ledger advancing again | Brief spike ≤ `MAX_ROLLBACK_DEPTH` (100), then falling | usually `ok` · 200 | Read-only: confirm `SyncState.lastLedger` advances on two samples. Record the event in the incident log. |
| **Stalled** | `indexer_stalled == 1` (no ledger progress, or no DB write, for > 30 s, or ≥ 5 consecutive RPC failures); `elcarehub_poller_stall_total{level=…}` increasing | Rising and not recovering | `/readyz` → 503 `{"status":"stalled"}`; `/health` `down` once lag > 1000 | Follow [stalled-ingestion.md](./stalled-ingestion.md). Escalation is automatic: 120 s → SSE `indexer-stalled`; 300 s → poller restart (up to 3 attempts, then process exit; see `elcarehub_poller_restart_total`). |
| **Degraded (catching up)** | `indexer_stalled == 0`; `indexer_latest_ledger_processed` increasing between samples | 101 – 1000 | `degraded` (HTTP 200) · 200 `ready` | Read-only: re-sample in 1 minute; lag should fall. Check `checks.stellar_rpc.latencyMs`. If lag rises for 3 samples, treat as Stalled. |
| **Healthy** | `indexer_stalled == 0`; ledger processed increases about every 5 s | 0 – 100 | `ok` · 200 `ready` | None. |

Notes:

- `/health` reports overall `down` (HTTP 503) when lag > 1000 even if the
  poller is still moving. That is the **Stalled / down** boundary for
  readiness (`runReadinessChecks()` fails on `sync_lag.status == "down"`).
- `checks.sync_lag.lagLedgers == -1` with message `Could not determine sync
  lag` means RPC or `SyncState` could not be read. Treat as Degraded and
  check `checks.stellar_rpc` and `checks.database`.
- The halt flag set by a deep re-org is held in process memory and is not
  shown in `/health` or `/readyz`. The log line and the `CRITICAL_REORG` SSE
  event are the authoritative signals. The poller code refers to
  `POST /admin/reorg-recovery`, but no such route is registered in
  `indexer/src/api/routes.ts` in this version. Follow
  [reorganization.md](./reorganization.md) and escalate. Do not improvise a
  resume.

---

## 3. Report template

```text
State: <Healthy|Degraded|Stalled|Re-org>
SyncState.lastLedger: <n> (updatedAt <ts>)   network tip: <n>   lag: <n>
indexer_stalled: <0|1>   stall_total{warning,critical,fatal}: <a,b,c>   restarts: <n>
/health: <ok|degraded|down>   /readyz: <HTTP code>
Re-org log lines in last 15m: <yes/no>
```

Include no secrets, tokens or connection strings in the report.

---

## 4. Review and revert

- **Review:** compare each threshold in the table with the constants named at
  the top of this page. Run `cd indexer && npx vitest run
  src/__tests__/redis-ops-docs.test.ts`, which asserts those constants still
  match this page.
- **Revert:** `git revert <commit>`. This is documentation and a static test
  only. No runtime, data, or config change.
