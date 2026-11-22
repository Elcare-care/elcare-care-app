# Runbook: Ledger Gap Repair

> Issue #1065. **Owner:** `@org/backend-lead-indexer`, with on-call SRE executing.
> **Code:** `indexer/src/gap-repair.ts`, `indexer/src/backfill.ts`, `indexer/src/poller.ts` (`persistLedgerGap`),
> `indexer/src/cli.ts` (`gaps …`).
> **Models:** `LedgerGap`, `BackfillJob` (`indexer/prisma/schema.prisma`).
> **Related:** [BackfillJob status](backfill-job-status.md), [Stalled ingestion](stalled-ingestion.md),
> [Re-organization](reorganization.md).

A **ledger gap** is a range of ledgers the live poller skipped (`rpc_window_skip`), lost to a re-org
(`reorg`), or that an operator queued (`manual`). Repairing a gap runs a `BackfillJob` over that
range against an archival RPC.

Every step below carries a safety label. **Do not run a 🔴 step until every 🟢 step before it in
that section has passed.**

| Label | Meaning |
|---|---|
| 🟢 **READ-ONLY (dry review)** | Reads the API, metrics, logs or a DB replica. Changes nothing. |
| 🔴 **MUTATING (repair execution)** | Writes `MarketplaceEvent` and domain projections, changes `LedgerGap` / `BackfillJob` status, and may advance `SyncState`. Replay side effects: backfilled events are written inside a transaction, so `processEvent` does **not** emit SSE frames for them. Connected clients only see the result after their next REST refresh. |

> There is **no dry-run mode** for gap repair. `npm run gaps:repair` and `npm run cli -- gaps repair`
> start mutating immediately. The dry review in Part A is the only rehearsal.

---

## Gap lifecycle

```
Open ──(worker CAS claim)──► Repairing ──(BackfillJob Completed)──► Repaired
                                 └────────(retries exhausted)─────► Failed
```

| Status | Set by | Picked up automatically? |
|---|---|---|
| `Open` | `persistLedgerGap()` (upsert on `(fromLedger, toLedger, source)`) | Yes, by the worker (`GAP_REPAIR_ENABLED=true`), oldest first |
| `Repairing` | Worker CAS `Open → Repairing` | **No.** If the process dies mid-repair the gap stays `Repairing` permanently (see C3) |
| `Repaired` | `repairGap()` after `runBackfill` resolves | — |
| `Failed` | `repairGap()` after `GAP_REPAIR_MAX_RETRIES` (default 3) | **No.** Needs an operator (C2) |

---

## Part A — Dry review 🟢 READ-ONLY

### A1. Prerequisite checks

| # | Check | Command (🟢 READ-ONLY) | Pass when |
|---|---|---|---|
| 1 | Operator credential available as an env var | — | `OPERATOR_TOKEN` is set in your shell (never typed inline) |
| 2 | Indexer healthy, poller not halted for a deep re-org | `curl -s "$INDEXER_URL/health"` | HTTP 200 and `status` is not `down`. If the poller is halted, follow `reorganization.md` first |
| 3 | Network and contracts are correct | Startup report (`startup-config-report.md`) | `warnings: []`, `network` matches the environment |
| 4 | Archival RPC configured and on the **same network** | Startup report → `archivalRpc` (falls back to `rpc`) | Host belongs to the right network. Repair fails immediately if neither URL is set |
| 5 | No other repair or backfill running | `curl -s -H "X-Operator-Token: $OPERATOR_TOKEN" "$INDEXER_URL/backfill/status"` and `…/sync/jobs?status=Running` | `running: false`, no `Running` jobs (but see the note below) |
| 6 | Embedded worker state known | Deployment env: `GAP_REPAIR_ENABLED` | You know whether a worker will also claim gaps |
| 7 | DB headroom | `database-outage.md` pool checks | No pool exhaustion. Repair holds write transactions per batch |

> `/backfill/status` reports only the **current process**. Other pods or CLI runs are invisible to
> it. Use `/sync/jobs?status=Running` and the advisory-lock query in
> [backfill-job-status.md §5](backfill-job-status.md#5-read-only-diagnostic-queries) to see work running elsewhere.

### A2. Inventory the gaps

```bash
# READ-ONLY
curl -s -H "X-Operator-Token: $OPERATOR_TOKEN" "$INDEXER_URL/sync/gaps?status=Open&limit=50"
curl -s -H "X-Operator-Token: $OPERATOR_TOKEN" "$INDEXER_URL/sync/gaps/<id>"
# READ-ONLY CLI (needs DATABASE_URL)
cd indexer && npm run cli -- gaps list
```

```bash
# READ-ONLY metrics
curl -s "$INDEXER_URL/metrics" | grep -E '^indexer_(open_ledger_gaps|open_ledger_gap_ledgers_total|open_gaps_count|open_gaps_ledgers_total|gap_repair_(started|completed|failed)_total)'
```

For each gap, write down `id`, `fromLedger`, `toLedger`, `source`, `status`, the size
(`toLedger - fromLedger + 1`) and any `repairJob[]`.

### A3. Decide

| Situation | Action |
|---|---|
| `source = reorg` and the poller is halted | Stop. Resolve the re-org first (`reorganization.md`) |
| Gap is older than the archival RPC's history | Stop. Find an RPC with that history, or escalate |
| Several overlapping `Open` gaps | Repair them one at a time (oldest first, as the worker does). Inserts are idempotent, so overlap only wastes RPC calls |
| Gap > ~500 000 ledgers | Schedule off-peak. Expect `gap_repair_duration_seconds` in the hours |

**Gate:** record the gap IDs, the expected ledger totals and the person executing in the change or
incident ticket before moving to Part B.

---

## Part B — Repair execution 🔴 MUTATING

### B1. Choose exactly one execution path

| Path | Command | Claims gap safely? | Notes |
|---|---|---|---|
| Embedded worker | `GAP_REPAIR_ENABLED=true` (restart) | Yes, CAS `Open → Repairing` | Repairs every `Open` gap every `GAP_REPAIR_INTERVAL_MS` (120 s) |
| Full cycle, one-shot | `cd indexer && npm run gaps:repair` (or `npm run cli -- gaps repair`) | Yes, CAS | Repairs **all** `Open` gaps, then exits (`1` if any failed) |
| Single gap | `npm run cli -- gaps repair --gap=<id>` | **No.** `repairGap()` runs whatever the current status is | Use for `Failed` gaps. **Disable the worker first** and confirm A1 #5, or two backfills can cover the same range at once |

```bash
# MUTATING: single gap (preferred for manual work)
cd indexer
npm run cli -- gaps repair --gap=<id>
```

### B2. Expected log lines

| Log message | Level | Meaning |
|---|---|---|
| `gap-repair: cycle starting` `{openGaps, totalLedgers}` | info | Worker or full-cycle start |
| `gap-repair: starting repair` `{gapId, fromLedger, toLedger}` | info | One gap claimed |
| `backfill: created new job` `{jobId, startLedger, endLedger, concurrency}` | info | The `BackfillJob` row now exists (`gapId` is set) |
| `backfill: cursor interaction` `{cursorInteraction, liveCursor}` | info | `below` / `overlapping` leave `SyncState` alone. `ahead` advances it |
| `backfill: batch failed (will retry on resume)` | **error** | ⚠️ See the batch-failure caveat below |
| `backfill: job completed` `{jobId, totalInserted, endLedger}` | info | Job marked `Completed` |
| `gap-repair: gap repaired` `{gapId, jobId, totalInserted, durationSeconds, ledgerCount}` | info | Gap marked `Repaired` |
| `gap-repair: gap repair failed` `{gapId, err}` | error | Gap marked `Failed` with `error` (≤ 4096 characters) |
| `backfill: … advisory lock is held by another worker — aborting` | error | Another worker owns the job (`indexer_backfill_lock_contentions_total` +1) |

Expected metrics: `indexer_gap_repair_started_total` +1 per gap,
`indexer_gap_repair_completed_total` or `indexer_gap_repair_failed_total` +1,
`indexer_gap_repair_duration_seconds`, `indexer_backfill_jobs_total{status}`. The recovery FSM moves
to `gap_repair` and back (`indexer_recovery_mode`).

> ⚠️ **Batch-failure caveat (owner action required).** In `runBackfill`, a failing batch is only
> logged (`backfill: batch failed (will retry on resume)`). The job is still marked `Completed` with
> `checkpointLedger = endLedger`, and the gap is marked `Repaired`. Despite the log text, **nothing
> retries it**. Treat any such line for the job as a failed repair and follow C4. A code fix (fail
> the job, or record failed windows) is tracked for `@org/backend-lead-indexer`.

### B3. Rollback boundaries

| What | Reversible? | How |
|---|---|---|
| `MarketplaceEvent` rows inserted | Not by this tool | They are real on-chain events, deduplicated by `eventHash`. Removing them is a re-org rollback (`reorganization.md`), never a manual `DELETE` |
| Domain projections (listings, auctions, offers, …) | Not by this tool | Same as above. Use reconciler repair for drift |
| `SyncState` (only when `cursorInteraction = ahead`) | Manual, 🔴 | Only advanced to ledgers that were actually processed. Do not roll it back by hand. Let the poller continue |
| `LedgerGap.status` / `BackfillJob.status` | Yes, 🔴 manual SQL with a change ticket | See C2 / C3 |
| **Stop point** | — | Stopping the process (SIGTERM) between batches is safe. Each batch's events and checkpoint commit together in one transaction |

---

## Part C — Post-repair reconciliation

### C1. Verify 🟢 READ-ONLY

```bash
curl -s -H "X-Operator-Token: $OPERATOR_TOKEN" "$INDEXER_URL/sync/gaps/<id>"
# expect status "Repaired"; repairJob[] latest status "Completed", checkpointLedger == toLedger
curl -s "$INDEXER_URL/metrics" | grep -E '^indexer_open_(ledger_gaps|gaps_count) '
# expect the open-gap gauges to have dropped by the repaired count (refreshed each worker cycle)
```

Then:

1. **Batch failures:** search the logs for `backfill: batch failed` with this `jobId`. Any hit → C4.
2. **Event coverage:** run the coverage query in
   [backfill-job-status.md §5](backfill-job-status.md#5-read-only-diagnostic-queries) for
   `[fromLedger, toLedger]` and compare it with `totalInserted` and with an RPC/explorer count for a
   sample of ledgers.
3. **State reconciliation (🟢 dry-run):** `RECONCILER_AUTO_REPAIR` defaults to `false`
   (detect-only). Confirm it is still `false` and check `GET /reconciliation/status` (operator) for
   discrepancies on entities touched in the range. See `docs/financial-reconciliation-runbook.md`
   for financial aggregates.
4. Record the outcome (gap IDs, job IDs, `totalInserted`, discrepancies) in the ticket.

### C2. A `Failed` gap 🔴 MUTATING

Read `LedgerGap.error` (🟢). Fix the cause: RPC history, RPC network, credentials. Then repair the
gap directly with `gaps repair --gap=<id>` (B1). There is no API to reset it to `Open`. Doing that
with SQL is 🔴 and needs a ticket:

```sql
-- MUTATING (change ticket required): re-queue one Failed gap for the worker
UPDATE "LedgerGap" SET status = 'Open', error = NULL WHERE id = <id> AND status = 'Failed';
```

### C3. A gap stuck in `Repairing` 🔴 MUTATING

1. 🟢 Confirm that no process is working on it: no `Running` job for that `gapId`, **and** no
   advisory lock held for its latest job (backfill-job-status §5).
2. 🟢 If the latest job is stuck `Running`, resolve it first (backfill-job-status §4).
3. 🔴 Then either run `gaps repair --gap=<id>`, or reset it with
   `UPDATE "LedgerGap" SET status='Open' WHERE id=<id> AND status='Repairing';` (with a ticket).

### C4. Partial repair (batch failures) 🔴 MUTATING

Create a fresh backfill over the failed window(s) from the log lines, or over the whole gap range.
Inserts are idempotent:

```bash
# MUTATING
cd indexer && npm run backfill -- --start=<fromLedger> --end=<toLedger>
```

Then repeat C1.

---

## Review and revert

**Reviewing.** Check each status, log message and metric name against `gap-repair.ts`,
`backfill.ts` (`runBackfill`, `processBatch`), `metrics.ts` / `recovery-metrics.ts` and `cli.ts`.
The batch-failure and `--gap` CAS caveats come straight from current code. Remove them once the code
is fixed.

**Reverting.** This runbook is documentation only. Revert it with `git revert`. It does not change
behaviour.
