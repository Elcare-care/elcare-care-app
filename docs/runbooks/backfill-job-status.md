# Runbook: BackfillJob Status, Safe Restart, and Stuck-Job Ownership

> Issue #1064. **Owner:** `@org/backend-lead-indexer` (code). Stuck/failed jobs: on-call SRE (first
> response), escalating to `@org/backend-lead-indexer`.
> **Code:** `indexer/src/backfill.ts`, `indexer/src/cli.ts` (`backfill …`), `indexer/src/gap-repair.ts`.
> **Model:** `BackfillJob` + enum `BackfillJobStatus` (`indexer/prisma/schema.prisma`).
> **Routes:** `GET /backfill/status`, `GET /sync/jobs[?status=]`, `GET /sync/jobs/{id}`, `GET /sync/gaps/{id}`
> (all `operator`, header `X-Operator-Token`).
> **Related:** [`indexer/docs/backfill-checkpoint-semantics.md`](../../indexer/docs/backfill-checkpoint-semantics.md),
> [Gap repair](gap-repair.md).

---

## 1. `BackfillJob` fields

| Column | Meaning | Safe to share? |
|---|---|---|
| `id` | Job ID. Also the low 32 bits of the advisory-lock key | yes |
| `startLedger` / `endLedger` | Inclusive range | yes |
| `checkpointLedger` | Highest ledger written by the last committed batch. `0` = nothing written yet | yes |
| `status` | See §2 | yes |
| `totalInserted` | New `MarketplaceEvent` rows (duplicates are not counted) | yes |
| `gapId` | The `LedgerGap` this job repairs, or `null` for a manual backfill | yes |
| `error` | Last fatal error (≤ 4096 characters) | **with care**: RPC errors can echo URLs |
| `rpcUrl` | The RPC endpoint used | **no**: provider URLs can embed API keys in the path or query |
| `createdAt` / `updatedAt` | Timestamps. `updatedAt` changes on every checkpoint | yes |

> `GET /sync/jobs` and `GET /sync/jobs/{id}` return the **whole row, including `rpcUrl` and
> `error`**. Don't paste their raw output into tickets. Use the safe query in §5 or strip those
> fields first.

---

## 2. Status table

| Status | Entered when | Process holds the advisory lock? | `--resume` allowed? | Picked up automatically? | Normal duration | Looks stuck when |
|---|---|---|---|---|---|---|
| **Pending** | `createBackfillJob()` inserts the row, just before the lock is taken | No | **Yes** | No | Milliseconds | Still `Pending` after a minute. The creator died, or lost the lock race, before `Running` |
| **Running** | After `pg_try_advisory_lock` succeeds | **Yes**, for the lifetime of that DB session | **No** (refused: "already Running — may be held by another worker") | No | Minutes to hours | `updatedAt` hasn't moved for > 10 × the normal batch time **and** no advisory lock is held (§5). The worker crashed without updating the status |
| **Completed** | Every batch window processed | Released | No ("nothing to resume") | — | Terminal | Never. But see the ⚠️ below |
| **Failed** | An exception outside per-batch processing after the job is `Running` (for example a DB error during the `SyncState` read or a status update). Errors before the row exists (bad range, `getLatestLedger` failure) create no job | Released (`finally`) | **Yes**, from `checkpointLedger + 1` | No. A *gap* job is retried inside `withRetry` up to `GAP_REPAIR_MAX_RETRIES`, each attempt creating a **new** job | Terminal until resumed | — |
| **Cancelled** | `npm run cli -- backfill cancel <id>` (refused for Completed/Cancelled) | — | No | — | Terminal | — |

> ⚠️ **"Completed" does not guarantee full coverage.** A batch that throws (for example an RPC
> timeout) is only logged as `backfill: batch failed (will retry on resume)`. The job still finishes
> as `Completed` with `checkpointLedger = endLedger`, so a resume can never retry that batch.
> Always check the logs for that line for the job ID (see `gap-repair.md` B2/C4). Owner:
> `@org/backend-lead-indexer`.
>
> ⚠️ **Cancelling a Running job does not stop it.** `cancel` only writes `status = 'Cancelled'`. The
> running loop never re-reads the status, so it carries on and overwrites the status with
> `Completed` or `Failed`. Stop the process to stop the job.

The in-process view comes from `GET /backfill/status`: `running`, `jobId`, `fromLedger`, `toLedger`,
`checkpointLedger`, `percentage`, `throughputEventsPerSec`, `estimatedRemainingMs`. It describes
**only the job running in the API process that answers**. CLI runs and other pods do not appear.

---

## 3. Safe restart semantics

| Question | Answer (from `backfill.ts`) |
|---|---|
| Where does a resume start? | `checkpointLedger + 1` (or `startLedger` when the checkpoint is `0`). `--start` / `--end` are ignored |
| Can replaying a range create duplicates? | No. Events dedupe on `eventHash`, and projections only run for newly inserted events |
| Is a batch atomic? | Yes. Events and `checkpointLedger` / `totalInserted` commit in **one transaction** per batch |
| Does the same `--start`/`--end` resume an old job? | **No.** Without `--resume=<id>` a **new** job is created over the full range. That is safe (idempotent), just slower. `backfill-checkpoint-semantics.md` says otherwise. Prefer `--resume` |
| Can two workers run one job? | No. `pg_try_advisory_lock((0xBACF << 32) \| id)` lets only one session hold the job |
| Does a backfill move the live cursor? | Only when the whole range is **ahead** of `SyncState.lastLedger`. `below` / `overlapping` leave it untouched |
| Is the checkpoint exact with concurrency > 1? | ⚠️ Not strictly. Up to `BACKFILL_CONCURRENCY` (default 5, max 20) batches commit in parallel, and each writes its own max ledger, so `checkpointLedger` reflects whichever batch committed **last**. After a crash, resume with `--concurrency=1` when exact coverage matters, or re-run the full range |

Restart procedure:

1. 🟢 Find the job: `npm run cli -- backfill list`, or the §5 query.
2. 🟢 If it is `Running`, prove that nothing holds its lock (§5 lock query). If a lock is held, **stop**:
   the job is live. Find the owner by the `pid` / `application_name` and wait or escalate.
3. 🔴 `Failed` / `Pending`: `npm run cli -- backfill resume <id>` (or `npm run backfill -- --resume=<id>`).
4. 🔴 `Running` with no lock (a crashed worker): mark it `Failed`, then resume it. With a change ticket:
   ```sql
   -- MUTATING: only after the §5 lock query returns zero rows for this job
   UPDATE "BackfillJob" SET status = 'Failed', error = 'operator: worker crashed, lock not held (INC-…)'
   WHERE id = <id> AND status = 'Running';
   ```
5. 🟢 Watch the logs: `backfill: resuming existing job {jobId, checkpoint}` → `backfill: starting run {resumeFrom}`
   → `backfill: job completed`. Check `indexer_backfill_jobs_total{status}`.

---

## 4. Ownership of stuck or failed jobs

| Situation | First responder | Escalate to | Within |
|---|---|---|---|
| Gap-repair job `Failed` / gap `Failed` | On-call SRE: `gap-repair.md` C2 | `@org/backend-lead-indexer` if it fails again after a fix | Same business day; before the RPC history window expires |
| Job `Running` with no lock (crashed) | On-call SRE: §3 step 4 | `@org/backend-lead-indexer` | 1 business day |
| Job `Running` **with** a lock but no progress | On-call SRE: check RPC/DB health, then stop the owning process | `@org/backend-lead-indexer` + `@org/devops` (infra) | 4 h |
| Orphan `Pending` (> 1 h) | On-call SRE: resume it, or cancel it if it was created by mistake | — | Next business day |
| `Completed` with `batch failed` log lines | On-call SRE: re-run the range (`gap-repair.md` C4) | `@org/backend-lead-indexer` (code fix) | Same business day |
| `indexer_backfill_lock_contentions_total` rising | On-call SRE: look for duplicate workers or CLI runs | `@org/devops` | 4 h |

Record each intervention (job ID, action, ticket) in the incident ticket. CLI resumes are not
written to `OperationalAudit`.

---

## 5. Read-only diagnostic queries

Run these 🟢 **READ-ONLY** queries on a replica or with a read-only role. They return **safe fields
only**: no `rpcUrl` value (host only), and URLs are masked in `error`.

```sql
-- READ-ONLY: BackfillJob diagnostics (safe fields only)
SELECT
  j.id,
  j.status,
  j."startLedger",
  j."endLedger",
  j."checkpointLedger",
  CASE WHEN j."checkpointLedger" = 0 THEN 0
       ELSE round(100.0 * (j."checkpointLedger" - j."startLedger" + 1)
                  / NULLIF(j."endLedger" - j."startLedger" + 1, 0), 1)
  END                                                         AS pct_checkpointed,
  j."totalInserted",
  j."gapId",
  g.status                                                    AS gap_status,
  substring(j."rpcUrl" from '^[a-z+]+://(?:[^@/]*@)?([^/:?#]+)') AS rpc_host,   -- host only
  (j.error IS NOT NULL)                                       AS has_error,
  left(regexp_replace(j.error, '[a-z+]+://[^\s"'']+', '<url>', 'gi'), 200) AS error_excerpt,
  j."createdAt",
  j."updatedAt",
  now() - j."updatedAt"                                       AS since_last_checkpoint
FROM "BackfillJob" j
LEFT JOIN "LedgerGap" g ON g.id = j."gapId"
WHERE j.status IN ('Pending', 'Running', 'Failed')
   OR j."updatedAt" > now() - interval '24 hours'
ORDER BY j."updatedAt" DESC
LIMIT 50;
```

```sql
-- READ-ONLY: is anyone holding the advisory lock for job <id>?
-- Key = (0xBACF << 32) | id  →  classid = 47823, objid = <id>, objsubid = 1
SELECT l.pid, l.granted, a.application_name, a.state, a.backend_start
FROM pg_locks l
JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.locktype = 'advisory' AND l.classid = 47823 AND l.objid = <id> AND l.objsubid = 1;
-- zero rows → no live worker owns the job
```

```sql
-- READ-ONLY: event coverage for a job's range (compare with totalInserted / an RPC sample)
SELECT COUNT(*) AS events, MIN("ledgerSequence") AS first_ledger, MAX("ledgerSequence") AS last_ledger
FROM "MarketplaceEvent"
WHERE "ledgerSequence" BETWEEN <startLedger> AND <endLedger>;
```

The same safe view over the API (🟢 READ-ONLY) drops the sensitive fields locally:

```bash
curl -s -H "X-Operator-Token: $OPERATOR_TOKEN" "$INDEXER_URL/sync/jobs?status=Running" \
  | jq 'map(del(.rpcUrl, .error) + {hasError: (.error != null)})'
```

---

## 6. Review and revert

**Reviewing.** Check §2 against `runBackfill()` (resume guards, the lock, the `Running` / `Completed` /
`Failed` updates), `createBackfillJob()`, `cancelBackfillJob()` and `cli.ts` `handleBackfill`. Check
the lock constants against `advisoryLockKey()` (`0xbacf` = 47823). The two ⚠️ notes and the
concurrency caveat in §3 describe current code. Remove them when the code changes.

**Reverting.** This runbook is documentation only. Revert it with `git revert`. The SQL in §3 step 4
is the only mutating statement, and it is gated behind a lock check and a change ticket.
