#!/usr/bin/env bash
# ============================================================
# scripts/migrations/check-zero-downtime.sh
#
# Reports whether a migration SQL file is safe for a zero-downtime
# (expand-contract) deployment while the indexer keeps ingesting.
#
# Prints a structured report to stdout and exits with:
#   0 — migration is safe to deploy without downtime
#   1 — migration requires a maintenance window or phased rollout
#
# USAGE
#   bash scripts/migrations/check-zero-downtime.sh <migration.sql>
#
# The report format is designed to be embedded in a PR description or
# linked from the CI run summary.
# ============================================================
set -euo pipefail

SQL_FILE="${1:-}"

if [[ -z "$SQL_FILE" ]]; then
  echo "Usage: $0 <path/to/migration.sql>" >&2
  exit 2
fi

if [[ ! -f "$SQL_FILE" ]]; then
  echo "File not found: $SQL_FILE" >&2
  exit 2
fi

echo "============================================================"
echo " Zero-Downtime Migration Assessment"
echo " File: $SQL_FILE"
echo " Date: $(date -u +%FT%TZ)"
echo "============================================================"
echo ""

SAFE=true

# Helper: check for pattern and print a verdict line
check() {
  local label="$1"
  local regex="$2"
  local verdict_ok="$3"
  local verdict_fail="$4"
  local remediation="$5"

  if grep -qiE "$regex" "$SQL_FILE" 2>/dev/null; then
    echo "  ✗ $label"
    echo "    → $verdict_fail"
    echo "    → Remediation: $remediation"
    echo ""
    SAFE=false
  else
    echo "  ✓ $label: $verdict_ok"
  fi
}

echo "── Additive changes (expand phase) ─────────────────────────"
# ADD COLUMN with a DEFAULT is always safe in PG 11+
if grep -qiE "ADD[[:space:]]+COLUMN" "$SQL_FILE"; then
  if grep -qiE "ADD[[:space:]]+COLUMN[^;]+DEFAULT" "$SQL_FILE"; then
    echo "  ✓ ADD COLUMN: uses DEFAULT — safe, no table rewrite"
  elif grep -qiE "ADD[[:space:]]+COLUMN[^;]+NOT[[:space:]]+NULL" "$SQL_FILE"; then
    echo "  ✗ ADD COLUMN NOT NULL without DEFAULT"
    echo "    → Requires full table rewrite or deferred constraint."
    echo "    → Remediation: add a DEFAULT value, or use: ADD COLUMN nullable, backfill, then ALTER COLUMN SET NOT NULL."
    echo ""
    SAFE=false
  else
    echo "  ✓ ADD COLUMN: nullable, no DEFAULT required — safe"
  fi
fi

echo ""
echo "── Destructive changes (contract phase — requires dual-write complete) ──"
check "DROP TABLE"   "DROP[[:space:]]+TABLE"   \
  "not present"  \
  "Destructive: destroys all rows. Only safe after all application code has stopped reading/writing this table." \
  "Complete expand → dual-write → backfill → contract cycle first."

check "DROP COLUMN"  "DROP[[:space:]]+COLUMN"  \
  "not present"  \
  "Destructive: loses column data. Safe only after application no longer reads or writes this column." \
  "Remove column from all application code and deploy, then drop in the next release."

check "RENAME TABLE / RENAME COLUMN" \
  "(RENAME[[:space:]]+TABLE|RENAME[[:space:]]+COLUMN)" \
  "not present" \
  "Breaks in-flight queries using the old name." \
  "Add new name (expand), dual-write both names, backfill, cut reads, drop old name (contract)."

check "ALTER COLUMN TYPE" \
  "ALTER[[:space:]]+TABLE[^;]+ALTER[[:space:]]+COLUMN[^;]+TYPE" \
  "not present" \
  "Changes wire format; concurrent reads fail if the new type is incompatible." \
  "Add new typed column → dual-write → backfill → switch reads → drop old column."

check "TRUNCATE" \
  "TRUNCATE[[:space:]]+" \
  "not present" \
  "Irreversible data loss inside the migration." \
  "Use a batched background-job DELETE outside the migration."

echo ""
echo "── Index creation ─────────────────────────────────────────────"
if grep -qiE "CREATE[[:space:]]+INDEX" "$SQL_FILE"; then
  if grep -qiE "CREATE[[:space:]]+INDEX[[:space:]]+CONCURRENTLY" "$SQL_FILE"; then
    echo "  ✓ CREATE INDEX CONCURRENTLY — does not lock writes"
  else
    echo "  ⚠ CREATE INDEX without CONCURRENTLY — locks writes during build"
    echo "    → Advisory: on large tables (> 1M rows) this will block ingestion."
    echo "    → Use CONCURRENTLY and run outside a transaction block."
    echo ""
    # Not a hard failure — just advisory
  fi
fi

echo ""
echo "── Constraint additions ───────────────────────────────────────"
if grep -qiE "ADD[[:space:]]+CONSTRAINT" "$SQL_FILE"; then
  if grep -qiE "ADD[[:space:]]+CONSTRAINT[^;]+NOT[[:space:]]+VALID" "$SQL_FILE"; then
    echo "  ✓ ADD CONSTRAINT NOT VALID — deferred validation, safe"
    echo "    → Remember to run: ALTER TABLE ... VALIDATE CONSTRAINT ... in a follow-up."
  else
    echo "  ⚠ ADD CONSTRAINT (validated immediately) — scans whole table"
    echo "    → On large tables this holds a ShareUpdateExclusiveLock."
    echo "    → Consider: ADD CONSTRAINT ... NOT VALID, then VALIDATE CONSTRAINT separately."
  fi
fi

echo ""
echo "── Backfill checkpoints ───────────────────────────────────────"
if grep -qiE "-- backfill" "$SQL_FILE"; then
  CHKPTS=$(grep -ciE "-- backfill" "$SQL_FILE" || true)
  echo "  ✓ $CHKPTS backfill checkpoint comment(s) found"
else
  echo "  ℹ No backfill checkpoint comments found."
  echo "    → If this migration adds columns that need data backfilled,"
  echo "      document the backfill strategy in a -- backfill: ... comment."
fi

echo ""
echo "── Rollback notes ─────────────────────────────────────────────"
if grep -qiE "-- rollback" "$SQL_FILE"; then
  echo "  ✓ Rollback note found"
else
  echo "  ℹ No rollback note found."
  echo "    → Add a -- rollback: ... comment describing how to undo this migration"
  echo "      if a hot rollback is needed before the contract phase completes."
fi

echo ""
echo "============================================================"
if [[ "$SAFE" == "true" ]]; then
  echo " VERDICT: ✓ SAFE FOR ZERO-DOWNTIME DEPLOYMENT"
  echo "  This migration uses only additive / backward-compatible changes."
else
  echo " VERDICT: ✗ REQUIRES PHASED ROLLOUT OR MAINTENANCE WINDOW"
  echo "  Review the items above. Follow docs/MIGRATION_GUIDE.md."
fi
echo "============================================================"

[[ "$SAFE" == "true" ]] && exit 0 || exit 1
