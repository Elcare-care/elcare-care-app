#!/usr/bin/env bash
# ============================================================
# scripts/backup/backup.sh
#
# Creates an encrypted, checksummed PostgreSQL backup.
#
# Required env vars:
#   DATABASE_URL             — Postgres connection string
#   BACKUP_ENCRYPTION_KEY    — Passphrase for AES-256-CBC encryption
#
# Optional env vars:
#   BACKUP_DIR               — Output directory (default: /var/backups/elcarehub)
#   RETENTION_DAYS           — Days to keep old backups (default: 30)
#
# Output files (in BACKUP_DIR):
#   pg_backup_<timestamp>.dump.enc       — Encrypted custom-format pg_dump
#   pg_backup_<timestamp>.dump.enc.sha256 — SHA-256 checksum for integrity
#
# Restore: see scripts/backup/restore.sh
# ============================================================
set -euo pipefail

TIMESTAMP=$(date -u +%Y%m%d_%H%M%S)
BACKUP_DIR="${BACKUP_DIR:-/var/backups/elcarehub}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
BACKUP_FILE="${BACKUP_DIR}/pg_backup_${TIMESTAMP}.dump.enc"
CHECKSUM_FILE="${BACKUP_FILE}.sha256"

: "${DATABASE_URL:?DATABASE_URL must be set}"
: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY must be set}"

echo "[backup] $(date -u +%FT%TZ) Starting backup → ${BACKUP_FILE}"

mkdir -p "$BACKUP_DIR"

# pg_dump --format=custom produces a binary file that supports parallel restore
# and selective table restoration. Pipe directly into openssl to avoid writing
# unencrypted data to disk at any point.
pg_dump \
  --format=custom \
  --no-password \
  "$DATABASE_URL" \
| openssl enc \
    -aes-256-cbc \
    -pbkdf2 \
    -iter 600000 \
    -salt \
    -pass "env:BACKUP_ENCRYPTION_KEY" \
    -out "$BACKUP_FILE"

# SHA-256 integrity check — verify before restore, not after
sha256sum "$BACKUP_FILE" > "$CHECKSUM_FILE"

BACKUP_BYTES=$(stat -c%s "$BACKUP_FILE" 2>/dev/null || stat -f%z "$BACKUP_FILE")
echo "[backup] $(date -u +%FT%TZ) Backup complete. Size: ${BACKUP_BYTES} bytes"
echo "[backup] Checksum: $(cat "$CHECKSUM_FILE")"

# Remove backups older than RETENTION_DAYS
DELETED=$(find "$BACKUP_DIR" -name "pg_backup_*.dump.enc" -mtime "+${RETENTION_DAYS}" -print -delete | wc -l)
find "$BACKUP_DIR" -name "pg_backup_*.dump.enc.sha256" -mtime "+${RETENTION_DAYS}" -delete
echo "[backup] Retention cleanup: removed ${DELETED} backup(s) older than ${RETENTION_DAYS} days."

echo "[backup] Done."
