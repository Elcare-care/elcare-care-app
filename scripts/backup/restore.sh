#!/usr/bin/env bash
# ============================================================
# scripts/backup/restore.sh
#
# Decrypts, verifies, and restores a PostgreSQL backup to a
# target database, then runs Prisma migrations and read checks.
# Designed for disaster-recovery drills; does NOT touch production
# unless RESTORE_TARGET_URL explicitly points at it.
#
# Required env vars:
#   BACKUP_FILE              — Path to the .dump.enc file to restore
#   BACKUP_ENCRYPTION_KEY    — Passphrase used when the backup was created
#   RESTORE_TARGET_URL       — Postgres connection string for the restore target
#                              (use an isolated DB, never production directly)
#
# Optional env vars:
#   SKIP_CHECKSUM            — Set to "true" to skip SHA-256 check (not recommended)
#   INDEXER_DIR              — Path to the indexer directory for 'prisma migrate deploy'
#                              (default: ./indexer relative to repo root)
#
# Exit codes:
#   0 — restore and read checks passed
#   1 — checksum mismatch, decryption error, restore failure, or read check failure
# ============================================================
set -euo pipefail

SKIP_CHECKSUM="${SKIP_CHECKSUM:-false}"
INDEXER_DIR="${INDEXER_DIR:-$(cd "$(dirname "$0")/../.." && pwd)/indexer}"

: "${BACKUP_FILE:?BACKUP_FILE must be set}"
: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY must be set}"
: "${RESTORE_TARGET_URL:?RESTORE_TARGET_URL must be set}"

echo "[restore] $(date -u +%FT%TZ) Starting restore from: ${BACKUP_FILE}"

# ── Step 1: Verify checksum ───────────────────────────────────────────────────
CHECKSUM_FILE="${BACKUP_FILE}.sha256"

if [[ "$SKIP_CHECKSUM" != "true" ]]; then
  if [[ ! -f "$CHECKSUM_FILE" ]]; then
    echo "[restore] ERROR: Checksum file not found: ${CHECKSUM_FILE}" >&2
    exit 1
  fi
  echo "[restore] Verifying SHA-256 checksum..."
  if ! sha256sum --check "$CHECKSUM_FILE"; then
    echo "[restore] ERROR: Checksum mismatch — backup file may be corrupted or tampered." >&2
    exit 1
  fi
  echo "[restore] Checksum OK."
else
  echo "[restore] WARNING: Skipping checksum verification (SKIP_CHECKSUM=true)."
fi

# ── Step 2: Decrypt and restore ───────────────────────────────────────────────
echo "[restore] Decrypting and restoring into target database..."

openssl enc \
  -d \
  -aes-256-cbc \
  -pbkdf2 \
  -iter 600000 \
  -pass "env:BACKUP_ENCRYPTION_KEY" \
  -in "$BACKUP_FILE" \
| pg_restore \
    --no-password \
    --clean \
    --if-exists \
    --no-owner \
    --no-privileges \
    --dbname "$RESTORE_TARGET_URL"

echo "[restore] pg_restore complete."

# ── Step 3: Run migrations (apply any schema changes since the backup) ────────
if [[ -d "$INDEXER_DIR" ]] && command -v npx &>/dev/null; then
  echo "[restore] Running Prisma migrations on restore target..."
  DATABASE_URL="$RESTORE_TARGET_URL" npx --prefix "$INDEXER_DIR" prisma migrate deploy
  echo "[restore] Migrations applied."
else
  echo "[restore] WARNING: Skipping migrations (INDEXER_DIR not found or npx unavailable)."
fi

# ── Step 4: Read checks — confirm the restored DB is queryable ────────────────
echo "[restore] Running read checks..."

PSQL_CMD="psql --no-password --tuples-only --quiet $RESTORE_TARGET_URL"

LISTING_COUNT=$($PSQL_CMD -c 'SELECT COUNT(*) FROM "Listing";' 2>/dev/null | tr -d ' ' || echo "ERROR")
SYNC_STATE=$($PSQL_CMD -c 'SELECT "lastLedger" FROM "SyncState" WHERE id = 1;' 2>/dev/null | tr -d ' ' || echo "ERROR")

if [[ "$LISTING_COUNT" == "ERROR" ]] || [[ "$SYNC_STATE" == "ERROR" ]]; then
  echo "[restore] ERROR: Read check failed — could not query restored database." >&2
  exit 1
fi

echo "[restore] Read checks passed:"
echo "          Listing count : ${LISTING_COUNT}"
echo "          Last ledger   : ${SYNC_STATE}"

echo "[restore] $(date -u +%FT%TZ) Restore complete and verified."
echo ""
echo "  IMPORTANT: This restore targeted: ${RESTORE_TARGET_URL}"
echo "  Confirm this is NOT the production database before proceeding."
