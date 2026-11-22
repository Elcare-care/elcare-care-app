# Runbook: Database Backup Restore Drill (DR Verification)

**Owner:** DevOps Engineer  
**Trigger:** Automatically after every daily `db-backup` CI run (the `verify-restore` job in
`.github/workflows/db-backup.yml`). Also run manually before any planned disaster-recovery
exercise or when the backup schedule may have been missed.  
**Expected output:** `verify-restore` job completes with status `success`; the job summary table
shows all five read checks passing and restore duration under 20 minutes.  
**Rollback / escalation:** If the restore job fails, do **not** delete the failed artifact. File
an incident, escalate to DevOps Engineer + Backend Lead, and follow the
[Database Outage runbook](./database-outage.md). Do not use the failed backup for a real
recovery until the root cause is identified.

> **Security note:** No production credentials, connection strings, tokens, or encryption keys
> may appear in this document, in any issue that references it, or in any CI log. Use
> placeholders (`<BACKUP_ENCRYPTION_KEY>`, `<BACKUP_DATABASE_URL>`) everywhere. Secrets live
> only in GitHub repository secrets (Settings → Secrets → Actions).

---

## Prerequisites

Before starting a manual drill, confirm all of the following are true.

| # | Prerequisite | How to verify |
|---|---|---|
| 1 | Repository secrets configured | In GitHub → Settings → Secrets → Actions, confirm `BACKUP_DATABASE_URL`, `BACKUP_ENCRYPTION_KEY`, and `BACKUP_STORAGE_PATH` are present. Do not view or copy their values. |
| 2 | `postgresql-client` available on the runner | The `ubuntu-latest` runner installs it via `apt-get` in the workflow. For a local drill, run `psql --version`. |
| 3 | Isolated restore target reachable | The restore target must **not** be the production database. The `verify-restore` job uses a temporary `postgres:15-alpine` service container. For a local drill, start a local Postgres container: `docker run --rm -p 5432:5432 -e POSTGRES_USER=restore_test -e POSTGRES_PASSWORD=restore_test -e POSTGRES_DB=restore_test postgres:15-alpine` |
| 4 | Backup artifact available | A recent `.dump.enc` file and its `.sha256` checksum exist in the CI artifact store or in `BACKUP_STORAGE_PATH`. |
| 5 | `openssl` available | `openssl version` |
| 6 | `pg_restore` available | `pg_restore --version` |
| 7 | `npx` / Node available (optional) | Required only if Prisma migrations are to be applied. `npx --version` |

---

## Procedure

### A. Automated path (CI — normal operation)

The `verify-restore` job in `.github/workflows/db-backup.yml` runs automatically after every
successful `backup` job. No manual steps are required unless the job fails.

1. Navigate to **Actions → Database Backup** in GitHub.
2. Open the latest run and confirm both `PostgreSQL Backup` and `Restore Verification (DR Drill)` jobs show green.
3. Open the `Restore Verification` job summary. The table must show:
   - `Restore outcome: success`
   - Artifact name and backup age populated
4. File the evidence in [`docs/reliability/ISSUE-BACKUP-RESTORE.md`](../reliability/ISSUE-BACKUP-RESTORE.md) using the placeholders in that template.

### B. Manual drill (local or on-demand)

Use this path for a scheduled DR exercise, to verify a specific artifact, or when the CI
restore job has failed and you need to diagnose the problem.

**Step 1 — Obtain the backup artifact**

Download from the CI artifact store (replace `<RUN_ID>`):

```bash
gh run download <RUN_ID> \
  --name db-backup-<RUN_ID> \
  --dir /tmp/elcarehub-backups
```

Identify the file (never print the full path in a shared log):

```bash
ls /tmp/elcarehub-backups/pg_backup_*.dump.enc | sort | tail -1
```

**Step 2 — Verify the checksum**

```bash
sha256sum --check /tmp/elcarehub-backups/pg_backup_<TIMESTAMP>.dump.enc.sha256
# Expected: pg_backup_<TIMESTAMP>.dump.enc: OK
```

A mismatch means the artifact is corrupt or tampered. Stop here and escalate.

**Step 3 — Verify the encryption key (header check)**

This confirms the passphrase is correct before committing to a full restore. It decrypts
only the first byte and discards it — no unencrypted data touches disk.

```bash
# BACKUP_ENCRYPTION_KEY must be set in the shell environment from a secret manager,
# never typed as a literal value.
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
  -pass "env:BACKUP_ENCRYPTION_KEY" \
  -in /tmp/elcarehub-backups/pg_backup_<TIMESTAMP>.dump.enc \
  2>/dev/null \
| dd bs=1 count=1 of=/dev/null 2>/dev/null
# Expected: 1+0 records in / 1+0 records out
```

**Step 4 — Start the isolated restore target**

```bash
docker run --rm -d \
  --name restore_drill \
  -p 5432:5432 \
  -e POSTGRES_USER=restore_test \
  -e POSTGRES_PASSWORD=restore_test \
  -e POSTGRES_DB=restore_test \
  postgres:15-alpine

# Wait for readiness
until docker exec restore_drill pg_isready -U restore_test; do sleep 2; done
```

**Step 5 — Run the restore script**

```bash
# Set required env vars from your secret manager — never hardcode values.
export BACKUP_FILE=/tmp/elcarehub-backups/pg_backup_<TIMESTAMP>.dump.enc
export RESTORE_TARGET_URL=postgresql://restore_test:restore_test@localhost:5432/restore_test
# BACKUP_ENCRYPTION_KEY already set in environment

bash scripts/backup/restore.sh
```

The script will print a `[report]` summary block. The final line must be:

```
[report] RESULT: PASS
```

**Step 6 — Confirm read checks**

The restore script runs five read checks automatically. After the script exits, you can
re-run them manually to confirm the numbers are plausible:

```bash
PGPASSWORD=restore_test psql \
  -h localhost -U restore_test -d restore_test \
  --tuples-only --quiet \
  -c 'SELECT COUNT(*) FROM "Listing";'

PGPASSWORD=restore_test psql \
  -h localhost -U restore_test -d restore_test \
  --tuples-only --quiet \
  -c 'SELECT "lastLedger" FROM "SyncState" WHERE id = 1;'
```

Expected: row counts are non-negative integers; `lastLedger` is a positive integer consistent
with recent on-chain activity.

**Step 7 — Tear down the restore target**

```bash
docker stop restore_drill
# The --rm flag deletes the container automatically on stop.
```

---

## Success Criteria

A drill is **passing** when all of the following are true:

| Criterion | Required value |
|---|---|
| Checksum verification | `OK` |
| Encryption key check | 1 byte read without error |
| `pg_restore` exit code | `0` |
| Read check — `Listing` count | Integer ≥ 0, no `ERROR` output |
| Read check — `Auction` count | Integer ≥ 0, no `ERROR` output |
| Read check — `Offer` count | Integer ≥ 0, no `ERROR` output |
| Read check — `MarketplaceEvent` count | Integer ≥ 0, no `ERROR` output |
| Read check — `SyncState.lastLedger` | Positive integer |
| Restore script final line | `[report] RESULT: PASS` |
| Backup age | < 25 hours (warning emitted if exceeded; investigate missed backup schedule) |
| Restore target | Confirmed **not** the production database |

---

## Failure Diagnosis

| Symptom | Likely cause | Action |
|---|---|---|
| `sha256sum` mismatch | Corrupt artifact or storage failure | Do not proceed; re-run the backup job and obtain a fresh artifact |
| Encryption key error | Wrong `BACKUP_ENCRYPTION_KEY` secret value | Verify the secret was rotated; never print the key — compare by running a test encrypt/decrypt |
| `pg_restore` exits non-zero | Schema mismatch or corrupt dump | Check `[restore]` log lines for `pg_restore: error`; run migrations manually if schema is ahead of backup |
| Read check returns `ERROR` | Table does not exist post-restore | Prisma migrations may not have run; set `INDEXER_DIR` and re-run, or run `npx prisma migrate deploy` manually |
| Backup age > 25 hours warning | Missed daily backup schedule | Check the `db-backup` workflow run history; investigate why the schedule trigger did not fire |
| Docker container unhealthy | Port conflict or resource exhaustion | Use a different host port or stop other Postgres instances |

---

## Keeping Production Credentials Out of the Repository

| What | Where it lives | Where it must NOT appear |
|---|---|---|
| `BACKUP_DATABASE_URL` | GitHub repository secret | Code, issues, logs, Slack messages, this file |
| `BACKUP_ENCRYPTION_KEY` | GitHub repository secret | Same as above |
| `RESTORE_TARGET_URL` (non-prod) | Shell environment during drill only | CI logs (the restore script deliberately omits it from output) |
| `ALERT_WEBHOOK_URL` | GitHub repository secret | Same as above |

The restore script (`scripts/backup/restore.sh`) is designed to never print any secret value.
The CI workflow excludes `RESTORE_TARGET_URL` from the alert payload by design.

---

## Rollback and Escalation

| Situation | Action |
|---|---|
| Automated restore job fails in CI | Do not re-run immediately. Inspect the job log. Escalate to DevOps Engineer within 1 hour. Record the failed run URL in the issue file. |
| Manual drill confirms backup is unrestorable | Trigger a new backup immediately via `workflow_dispatch`. Notify Backend Lead. Assess data loss window using the last known-good restore date in the issue file. |
| `BACKUP_ENCRYPTION_KEY` is suspected compromised | Follow the [Compromised Admin Key runbook](./compromised-admin-key.md) for secret rotation. After rotation, run a new backup cycle to produce a fresh artifact encrypted with the new key. |
| Backup schedule missed for > 48 hours | Escalate to DevOps Engineer + Backend Lead. File an incident. Assess RPO impact. |

---

## Related Documents

- [`scripts/backup/backup.sh`](../../scripts/backup/backup.sh) — backup creation script
- [`scripts/backup/restore.sh`](../../scripts/backup/restore.sh) — restore and verification script
- [`.github/workflows/db-backup.yml`](../../.github/workflows/db-backup.yml) — CI workflow
- [`docs/runbooks/database-outage.md`](./database-outage.md) — full database outage response
- [`docs/reliability/backup-retention-verification-report.md`](../reliability/backup-retention-verification-report.md) — periodic verification report template
- [`docs/reliability/ISSUE-BACKUP-RESTORE.md`](../reliability/ISSUE-BACKUP-RESTORE.md) — tracking issue with evidence record
