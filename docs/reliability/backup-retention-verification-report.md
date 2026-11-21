# Backup Retention Verification Report

## Purpose

This document is a read-only template for operators to periodically verify that database backups are present, recent, intact, and restorable. It is based on the `db-backup` workflow (`.github/workflows/db-backup.yml`) and the helper scripts `scripts/backup/backup.sh` and `scripts/backup/restore.sh`.

Complete this report during each scheduled verification. **Do not** record secrets, credentials, tokens, live connection strings, or real production URLs in this file or in any issue that references it. Use placeholders such as `<BACKUP_ARTIFACT_NAME>` and `<RUN_URL>`.

---

## Report Metadata

| Field | Value |
| --- | --- |
| Verification date (UTC) | `<YYYY-MM-DD>` |
| Operator | `<NAME / HANDLE>` |
| Workflow run URL | `<RUN_URL>` |
| Workflow run ID | `<RUN_ID>` |
| Backup artifact name | `<BACKUP_ARTIFACT_NAME>` |
| Artifact retention period | `<RETENTION_DAYS>` |
| Environment verified | `<ENVIRONMENT>` |

---

## Backup Inventory

| Field | Value | Expected / Threshold | Result |
| --- | --- | --- | --- |
| Backup count (artifacts found) | `<COUNT>` | `>= <MIN_EXPECTED_COUNT>` | `<PASS / FAIL>` |
| Most recent backup timestamp (UTC) | `<TIMESTAMP>` | — | — |
| Backup age | `<AGE_HOURS>` hours | `< 25` hours (warning threshold in `restore.sh`) | `<PASS / FAIL>` |
| Checksum verification | `<PASS / FAIL>` | `PASS` | `<PASS / FAIL>` |
| Restore eligibility (`verify-restore` job) | `<PASS / FAIL>` | `PASS` | `<PASS / FAIL>` |

> **Note:** The 25-hour warning threshold is defined in `scripts/backup/restore.sh`. A backup older than 25 hours indicates the scheduled `db-backup` workflow may not have run successfully and should be escalated.

---

## Checksum Verification Detail

| Field | Value |
| --- | --- |
| Checksum file / manifest | `<CHECKSUM_MANIFEST_NAME>` |
| Checksum algorithm | `<ALGORITHM>` |
| Verification command output | `<PASS / FAIL — summary only>` |

Do not paste raw checksum values that could be used to reconstruct or validate live artifacts outside the approved process.

---

## Restore Eligibility Detail

| Field | Value |
| --- | --- |
| `verify-restore` job status | `<SUCCESS / FAILURE / SKIPPED>` |
| Restore target (non-production) | `<RESTORE_TARGET_PLACEHOLDER>` |
| Restore duration | `<DURATION>` |
| Post-restore sanity check | `<PASS / FAIL>` |

---

## Evidence Summary

| Item | Result |
| --- | --- |
| Backup count within expected range | `<PASS / FAIL>` |
| Backup age under 25-hour threshold | `<PASS / FAIL>` |
| Checksum verification passed | `<PASS / FAIL>` |
| Restore eligibility confirmed | `<PASS / FAIL>` |
| **Overall result** | `<PASS / FAIL>` |

---

## Ownership and Escalation

| Field | Value |
| --- | --- |
| Owner | `<OWNER / TEAM>` |
| Verification trigger | `<SCHEDULE / MANUAL>` |
| Expected output | All checks `PASS`; report filed and linked from the tracking issue |
| Escalation path | `<ESCALATION_CONTACT / CHANNEL>` |
| Rollback / remediation step | Re-run `db-backup` workflow; if failure persists, escalate per path above |

---

## Notes

- This report is **read-only**: it records observations and does not trigger deployments, rotations, or destructive operations.
- No secrets, live credentials, tokens, or real connection strings/URLs may be recorded here. Use placeholders only.
- File the completed report as evidence on the tracking issue and retain it according to the artifact retention policy.