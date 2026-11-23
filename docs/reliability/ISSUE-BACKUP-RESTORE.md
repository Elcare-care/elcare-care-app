# Issue: Backup Restore Verification — Unexercised Recovery Path

**Status:** Closed — procedure implemented  
**Opened:** 2026-11-22  
**Closed:** 2026-11-22  
**Owner:** DevOps Engineer

---

## Problem Statement

A backup is not verified until a restore has been exercised in a disposable environment.
The `db-backup` CI workflow and `backup.sh` / `restore.sh` scripts existed, and the
`database-outage.md` runbook referenced backups — but no documented procedure existed that
specified: prerequisites before running a drill, success criteria to declare a restore passing,
or a step-by-step manual path an operator could follow independently of CI.

---

## Work Done

### Evidence inspected

| Artifact | Finding |
|---|---|
| `.github/workflows/db-backup.yml` | Two jobs: `backup` (pg_dump → openssl encrypt → upload artifact) and `verify-restore` (download artifact → `restore.sh` → job summary). `verify-restore` runs after every `backup` job. Secrets `BACKUP_DATABASE_URL`, `BACKUP_ENCRYPTION_KEY`, `BACKUP_STORAGE_PATH` required; `METRICS_PUSH_URL` and `ALERT_WEBHOOK_URL` optional. Restore target is an isolated `postgres:15-alpine` service container — not production. |
| `scripts/backup/backup.sh` | Writes `pg_backup_<timestamp>.dump.enc` + `.sha256` checksum. Encrypts with AES-256-CBC / PBKDF2 / 600 000 iterations. Never writes unencrypted data to disk. |
| `scripts/backup/restore.sh` | 7-step pipeline: (1) checksum verify, (2) encryption header check, (3) decrypt + pg_restore, (4) Prisma migrations, (5) read checks (Listing, Auction, Offer, MarketplaceEvent, SyncState.lastLedger), (6) duration report, (7) Pushgateway metrics. Prints `[report] RESULT: PASS` on full success. Explicitly warns if backup age > 25 hours. Never prints secrets. |
| `docs/runbooks/database-outage.md` | Full outage runbook present. `§Related Runbooks` did not reference a restore drill procedure. `§Post-Incident Review Template` contained an action item: "Set up database backup/restore runbook." |
| `docs/reliability/backup-retention-verification-report.md` | Periodic verification report template present, but no corresponding runbook to explain how to execute a drill and populate it. |

### Gaps identified

1. No document specified the prerequisites an operator must confirm before starting a manual drill (isolated target, secrets configured, tools installed).
2. No explicit success criteria table existed — the `restore.sh` script defines them implicitly but an operator reading the runbook had no checklist.
3. `database-outage.md §Related Runbooks` did not point to a drill procedure, so an operator responding to an outage had no immediate link to restoration guidance.
4. The post-incident review template's action item "Set up database backup/restore runbook" was unfulfilled.

### Changes made

| File | Change |
|---|---|
| `docs/runbooks/backup-restore-drill-runbook.md` | **Created.** Automated path (CI), manual drill path (7 steps), prerequisites table, success criteria table, failure diagnosis table, credential security rules, rollback/escalation paths, related documents. |
| `docs/runbooks/database-outage.md` | **Updated.** Added `backup-restore-drill-runbook.md` to `§Related Runbooks`. |
| `docs/reliability/ISSUE-BACKUP-RESTORE.md` | **Created** (this file). Evidence record. |

---

## Validation

The following commands from the new runbook were verified syntactically against the existing
scripts. No dependencies were installed. No production system was contacted. No secrets were
introduced or recorded.

```bash
# Confirm checksum file format matches what backup.sh produces
# backup.sh writes: sha256sum "$BACKUP_FILE" > "$CHECKSUM_FILE"
# restore.sh reads: sha256sum --check "$CHECKSUM_FILE"
# These are compatible sha256sum invocations. ✓

# Confirm encryption parameters match between backup.sh and restore.sh
# backup.sh:  openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass env:...
# restore.sh: openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:...
# Parameters are symmetric. ✓

# Confirm restore.sh read checks target the correct table names
# Tables: "Listing", "Auction", "Offer", "MarketplaceEvent", "SyncState"
# These match the Prisma schema referenced in database-outage.md. ✓
```

No deployment was triggered. No rotation was performed. No live credentials appear in this
file or in the runbook.

---

## Implementation Procedure (repeatable)

1. **Automated (normal):** After each daily `db-backup` CI run, open GitHub Actions →
   Database Backup → latest run. Confirm `Restore Verification (DR Drill)` is green and the
   job summary shows `Restore outcome: success`.
2. **Manual drill:** Follow `docs/runbooks/backup-restore-drill-runbook.md §Procedure B`
   step by step. Confirm all success criteria in the table at `§Success Criteria`.
3. Record the result in `docs/reliability/backup-retention-verification-report.md` using
   the placeholders in that template (never record real credentials or connection strings).

**Measurable result:** `verify-restore` job status is `success`; the `[report] RESULT: PASS`
line appears in restore script output; all five read checks return non-negative integers
without `ERROR`.

---

## Owner, Trigger, Expected Output, Rollback

| Field | Value |
|---|---|
| **Owner** | DevOps Engineer |
| **Trigger** | Daily `db-backup` CI schedule (02:00 UTC) or manual `workflow_dispatch` |
| **Expected output** | `verify-restore` job: `success`; restore script: `[report] RESULT: PASS`; backup age < 25 hours; all read checks pass |
| **Rollback** | If restore fails: do not delete the artifact. File an incident. Escalate to DevOps Engineer + Backend Lead. Follow `docs/runbooks/database-outage.md` for recovery guidance. |
| **Escalation** | DevOps Engineer (primary); Backend Lead (data integrity); Slack #alerts → PagerDuty for P1 |

---

## Related Documents

- [`docs/runbooks/backup-restore-drill-runbook.md`](../runbooks/backup-restore-drill-runbook.md)
- [`docs/runbooks/database-outage.md`](../runbooks/database-outage.md)
- [`docs/reliability/backup-retention-verification-report.md`](./backup-retention-verification-report.md)
- [`scripts/backup/backup.sh`](../../scripts/backup/backup.sh)
- [`scripts/backup/restore.sh`](../../scripts/backup/restore.sh)
- [`.github/workflows/db-backup.yml`](../../.github/workflows/db-backup.yml)
