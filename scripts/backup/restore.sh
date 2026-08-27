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
#   METRICS_PUSH_URL         — Prometheus Pushgateway URL for aggregate metrics
#                              (no PII or secrets are pushed; only counts and durations)
#
# Output
#   Summary lines prefixed with [restore] or [report].
#   Secrets (DATABASE_URL, BACKUP_ENCRYPTION_KEY, RESTORE_TARGET_URL) are
#   NEVER printed.  Row counts and ledger numbers are safe aggregate metrics.
#
# Exit codes:
#   0 — restore, read checks, and encryption verification passed
#   1 — any step failed (checksum, decryption, restore, read checks)
# ============================================================
set -euo pipefail

SKIP_CHECKSUM="${SKIP_CHECKSUM:-false}"
INDEXER_DIR="${INDEXER_DIR:-$(cd "$(dirname "$0")/../.." && pwd)/indexer}"
METRICS_PUSH_URL="${METRICS_PUSH_URL:-}"

: "${BACKUP_FILE:?BACKUP_FILE must be set}"
: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY must be set}"
: "${RESTORE_TARGET_URL:?RESTORE_TARGET_URL must be set}"

RESTORE_START_EPOCH=$(date +%s)

# ── Artifact identity (safe to log — no secrets) ──────────────────────────────
ARTIFACT_NAME=$(basename "$BACKUP_FILE")
ARTIFACT_SIZE_BYTES=$(stat -c%s "$BACKUP_FILE" 2>/dev/null || stat -f%z "$BACKUP_FILE" 2>/dev/null || echo "unknown")
ARTIFACT_MTIME_EPOCH=$(stat -c%Y "$BACKUP_FILE" 2>/dev/null || stat -f%m "$BACKUP_FILE" 2>/dev/null || echo "0")
BACKUP_AGE_SECONDS=$(( RESTORE_START_EPOCH - ARTIFACT_MTIME_EPOCH ))

echo "[restore] ============================================================"
echo "[restore] $(date -u +%FT%TZ) Starting restore"
echo "[restore]   Artifact : ${ARTIFACT_NAME}"
echo "[restore]   Size     : ${ARTIFACT_SIZE_BYTES} bytes"
echo "[restore]   Age      : ${BACKUP_AGE_SECONDS} seconds (~$(( BACKUP_AGE_SECONDS / 3600 ))h)"
echo "[restore] ============================================================"

# Alert if the backup is older than 25 hours (missed a daily backup cycle).
BACKUP_AGE_WARN_SECONDS=$(( 25 * 3600 ))
if [[ "$ARTIFACT_MTIME_EPOCH" != "0" ]] && [[ "$BACKUP_AGE_SECONDS" -gt "$BACKUP_AGE_WARN_SECONDS" ]]; then
  echo "[restore] WARNING: Backup artifact is ${BACKUP_AGE_SECONDS}s old (>${BACKUP_AGE_WARN_SECONDS}s threshold)." >&2
  echo "[restore] WARNING: The most recent backup may have been missed. Verify the backup schedule." >&2
fi

# ── Step 1: Verify checksum ───────────────────────────────────────────────────
CHECKSUM_FILE="${BACKUP_FILE}.sha256"
CHECKSUM_STATUS="skipped"

if [[ "$SKIP_CHECKSUM" != "true" ]]; then
  if [[ ! -f "$CHECKSUM_FILE" ]]; then
    echo "[restore] ERROR: Checksum file not found: ${ARTIFACT_NAME}.sha256" >&2
    echo "[restore] FAILED artifact=${ARTIFACT_NAME} step=checksum_file_missing" >&2
    exit 1
  fi
  echo "[restore] Verifying SHA-256 checksum..."
  if ! sha256sum --check "$CHECKSUM_FILE" >/dev/null 2>&1; then
    echo "[restore] ERROR: Checksum mismatch — backup may be corrupted or tampered." >&2
    echo "[restore] FAILED artifact=${ARTIFACT_NAME} step=checksum_mismatch" >&2
    exit 1
  fi
  CHECKSUM_STATUS="ok"
  echo "[restore] Checksum OK."
else
  echo "[restore] WARNING: Skipping checksum verification (SKIP_CHECKSUM=true)."
fi

# ── Step 2: Verify encryption (test decrypt header only) ─────────────────────
# We decrypt exactly 1 byte to verify the passphrase is correct before
# committing the full pg_restore.  This catches wrong-key failures early
# without writing any decrypted data to disk.
echo "[restore] Verifying encryption passphrase (header check)..."
ENCRYPT_STATUS="ok"
if ! openssl enc \
    -d \
    -aes-256-cbc \
    -pbkdf2 \
    -iter 600000 \
    -pass "env:BACKUP_ENCRYPTION_KEY" \
    -in "$BACKUP_FILE" \
    2>/dev/null \
  | dd bs=1 count=1 of=/dev/null 2>/dev/null; then
  echo "[restore] ERROR: Encryption key verification failed — wrong passphrase or corrupt file." >&2
  echo "[restore] FAILED artifact=${ARTIFACT_NAME} step=encryption_key_check" >&2
  ENCRYPT_STATUS="failed"
  exit 1
fi
echo "[restore] Encryption passphrase: OK"

# ── Step 3: Decrypt and restore ───────────────────────────────────────────────
echo "[restore] Decrypting and restoring into target database..."
RESTORE_STEP_START=$(date +%s)

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

RESTORE_STEP_END=$(date +%s)
RESTORE_STEP_DURATION=$(( RESTORE_STEP_END - RESTORE_STEP_START ))
echo "[restore] pg_restore complete (${RESTORE_STEP_DURATION}s)."

# ── Step 4: Run migrations (apply schema changes since the backup) ─────────────
MIGRATION_STATUS="skipped"
if [[ -d "$INDEXER_DIR" ]] && command -v npx &>/dev/null; then
  echo "[restore] Running Prisma migrations on restore target..."
  # DATABASE_URL is passed via env; the value is never echoed.
  DATABASE_URL="$RESTORE_TARGET_URL" npx --prefix "$INDEXER_DIR" prisma migrate deploy
  MIGRATION_STATUS="ok"
  echo "[restore] Migrations applied."
else
  echo "[restore] WARNING: Skipping migrations (INDEXER_DIR not found or npx unavailable)."
fi

# ── Step 5: Read checks — representative row counts (no PII) ──────────────────
echo "[restore] Running read checks..."
READ_STATUS="ok"

# Use a temporary pgpass-style connection that never leaks secrets to stdout.
PSQL_CMD="psql --no-password --tuples-only --quiet"

run_query() {
  local label="$1"
  local sql="$2"
  local result
  result=$($PSQL_CMD "$RESTORE_TARGET_URL" -c "$sql" 2>/dev/null | tr -d ' \n' || echo "ERROR")
  if [[ "$result" == "ERROR" ]] || [[ -z "$result" ]]; then
    echo "[restore] ERROR: Read check failed for: ${label}" >&2
    READ_STATUS="failed"
    echo "ERROR"
  else
    echo "$result"
  fi
}

LISTING_COUNT=$(run_query "Listing count"  'SELECT COUNT(*) FROM "Listing";')
AUCTION_COUNT=$(run_query "Auction count"  'SELECT COUNT(*) FROM "Auction";')
OFFER_COUNT=$(run_query   "Offer count"    'SELECT COUNT(*) FROM "Offer";')
SYNC_LEDGER=$(run_query   "SyncState"      'SELECT "lastLedger" FROM "SyncState" WHERE id = 1;')
EVENT_COUNT=$(run_query   "Event count"    'SELECT COUNT(*) FROM "MarketplaceEvent";')

if [[ "$READ_STATUS" == "failed" ]]; then
  echo "[restore] FAILED artifact=${ARTIFACT_NAME} step=read_checks" >&2
  exit 1
fi

echo "[restore] Read checks passed:"
echo "          Listings        : ${LISTING_COUNT}"
echo "          Auctions        : ${AUCTION_COUNT}"
echo "          Offers          : ${OFFER_COUNT}"
echo "          Events          : ${EVENT_COUNT}"
echo "          Last ledger     : ${SYNC_LEDGER}"

# ── Step 6: Compute and report total restore duration ─────────────────────────
RESTORE_END_EPOCH=$(date +%s)
TOTAL_DURATION=$(( RESTORE_END_EPOCH - RESTORE_START_EPOCH ))

echo ""
echo "[report] ============================================================"
echo "[report] Restore verification summary"
echo "[report]   Artifact              : ${ARTIFACT_NAME}"
echo "[report]   Artifact size (bytes) : ${ARTIFACT_SIZE_BYTES}"
echo "[report]   Backup age (seconds)  : ${BACKUP_AGE_SECONDS}"
echo "[report]   Encryption check      : ${ENCRYPT_STATUS}"
echo "[report]   Checksum verification : ${CHECKSUM_STATUS}"
echo "[report]   pg_restore duration   : ${RESTORE_STEP_DURATION}s"
echo "[report]   Migrations            : ${MIGRATION_STATUS}"
echo "[report]   Read checks           : ${READ_STATUS}"
echo "[report]   Total duration        : ${TOTAL_DURATION}s"
echo "[report]   Row counts            : listings=${LISTING_COUNT} auctions=${AUCTION_COUNT} offers=${OFFER_COUNT} events=${EVENT_COUNT}"
echo "[report]   Sync ledger           : ${SYNC_LEDGER}"
echo "[report] RESULT: PASS"
echo "[report] ============================================================"

# ── Step 7: Push aggregate metrics to Pushgateway (if configured) ─────────────
# Only aggregate numeric metrics are pushed — no connection strings, passwords,
# row data, or personally identifying information.
if [[ -n "$METRICS_PUSH_URL" ]]; then
  echo "[restore] Pushing aggregate metrics to Pushgateway..."
  cat <<METRICS | curl --silent --data-binary @- "${METRICS_PUSH_URL}/metrics/job/db_restore_verification" || true
# HELP backup_restore_duration_seconds Total wall-clock duration of the restore verification
# TYPE backup_restore_duration_seconds gauge
backup_restore_duration_seconds ${TOTAL_DURATION}
# HELP backup_pg_restore_duration_seconds Duration of the pg_restore step only
# TYPE backup_pg_restore_duration_seconds gauge
backup_pg_restore_duration_seconds ${RESTORE_STEP_DURATION}
# HELP backup_age_seconds Age of the restored backup artifact in seconds
# TYPE backup_age_seconds gauge
backup_age_seconds ${BACKUP_AGE_SECONDS}
# HELP backup_artifact_size_bytes Size of the encrypted backup artifact in bytes
# TYPE backup_artifact_size_bytes gauge
backup_artifact_size_bytes ${ARTIFACT_SIZE_BYTES}
# HELP backup_restore_listing_count Row count of Listing table after restore
# TYPE backup_restore_listing_count gauge
backup_restore_listing_count ${LISTING_COUNT}
# HELP backup_restore_event_count Row count of MarketplaceEvent table after restore
# TYPE backup_restore_event_count gauge
backup_restore_event_count ${EVENT_COUNT}
# HELP backup_restore_sync_ledger Last synced ledger sequence after restore
# TYPE backup_restore_sync_ledger gauge
backup_restore_sync_ledger ${SYNC_LEDGER}
# HELP backup_restore_success 1 if restore verification passed, 0 otherwise
# TYPE backup_restore_success gauge
backup_restore_success 1
METRICS
  echo "[restore] Metrics pushed."
fi

echo ""
echo "[restore] $(date -u +%FT%TZ) Restore complete and verified."
echo ""
echo "  IMPORTANT: This restore targeted the ISOLATED restore environment."
echo "  Verify RESTORE_TARGET_URL is NOT the production database."
