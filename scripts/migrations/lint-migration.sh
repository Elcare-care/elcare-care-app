#!/usr/bin/env bash
# ============================================================
# scripts/migrations/lint-migration.sh
#
# Lints every new Prisma migration SQL file for patterns that are
# unsafe in a zero-downtime expand-contract deployment.
#
# USAGE
#   # Lint all migrations (CI default):
#   bash scripts/migrations/lint-migration.sh
#
#   # Lint only files changed vs main (fast in PRs):
#   bash scripts/migrations/lint-migration.sh --changed-only
#
#   # Lint a single file:
#   bash scripts/migrations/lint-migration.sh indexer/prisma/migrations/.../migration.sql
#
# EXIT CODES
#   0  — all checked files are safe
#   1  — at least one unsafe pattern detected
#   2  — invocation error (bad args / no migration files found)
#
# UNSAFE PATTERNS (block merge)
# ─────────────────────────────
#   DROP TABLE             — destroys data; must use archive + rename first
#   DROP COLUMN            — data loss; use contract phase only after backfill
#   ALTER COLUMN … TYPE    — changes wire format; split into expand + backfill + contract
#   ALTER COLUMN … NOT NULL without DEFAULT — locks table during backfill on large sets
#   RENAME TABLE           — breaks any in-flight query using the old name
#   RENAME COLUMN          — same; prefer adding a new column in expand phase
#   TRUNCATE               — irreversible data loss
#   DELETE FROM            — bulk deletes should be batched outside a migration
#
# SAFE PATTERNS (explicitly allowed)
# ────────────────────────────────────
#   ADD COLUMN … DEFAULT … (NOT NULL optional with a DEFAULT)
#   CREATE INDEX CONCURRENTLY
#   CREATE TABLE
#   CREATE TYPE / CREATE INDEX (non-concurrent are flagged as advisory)
# ============================================================
set -euo pipefail

MIGRATIONS_DIR="${MIGRATIONS_DIR:-indexer/prisma/migrations}"
CHANGED_ONLY=false
EXPLICIT_FILE=""

# ── Argument parsing ──────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --changed-only) CHANGED_ONLY=true ;;
    --*)
      echo "[lint-migration] Unknown option: $arg" >&2
      exit 2
      ;;
    *.sql) EXPLICIT_FILE="$arg" ;;
    *)
      echo "[lint-migration] Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

# ── Collect files to lint ─────────────────────────────────────────────────────
declare -a SQL_FILES=()

if [[ -n "$EXPLICIT_FILE" ]]; then
  SQL_FILES=("$EXPLICIT_FILE")
elif [[ "$CHANGED_ONLY" == "true" ]]; then
  # Compare against the merge-base so new migration files added in the PR are caught.
  BASE="${BASE_BRANCH:-origin/main}"
  mapfile -t SQL_FILES < <(
    git diff --name-only "${BASE}...HEAD" -- '*.sql' 2>/dev/null \
    | grep "^${MIGRATIONS_DIR}/" \
    || true
  )
else
  mapfile -t SQL_FILES < <(find "$MIGRATIONS_DIR" -name "migration.sql" | sort)
fi

if [[ ${#SQL_FILES[@]} -eq 0 ]]; then
  echo "[lint-migration] No migration SQL files to lint."
  exit 0
fi

echo "[lint-migration] Linting ${#SQL_FILES[@]} file(s)..."

# ── Pattern definitions ───────────────────────────────────────────────────────
# Each entry: "REGEX|SEVERITY|DESCRIPTION"
# SEVERITY: ERROR (blocks merge) | WARN (advisory only)

declare -a PATTERNS=(
  # ── Destructive — ERROR ───────────────────────────────────────────────────
  "DROP[[:space:]]+TABLE|ERROR|DROP TABLE destroys data. Archive rows first, then drop in a separate release (contract phase)."
  "DROP[[:space:]]+COLUMN|ERROR|DROP COLUMN loses data. Remove application reads/writes (contract phase) before dropping the column."
  "ALTER[[:space:]]+TABLE[^;]+RENAME[[:space:]]+COLUMN|ERROR|RENAME COLUMN breaks in-flight queries on the old name. Add a new column (expand), dual-write, backfill, then drop the old one (contract)."
  "RENAME[[:space:]]+TABLE|ERROR|RENAME TABLE breaks in-flight queries. Use CREATE + dual-write + backfill + DROP pattern instead."
  "TRUNCATE[[:space:]]+|ERROR|TRUNCATE is irreversible data loss. Use batched DELETE with a job instead."
  "^[[:space:]]*DELETE[[:space:]]+FROM|ERROR|Bulk DELETE in a migration can time out and locks the table. Use a background batched-delete job instead."
  "ALTER[[:space:]]+TABLE[^;]+ALTER[[:space:]]+COLUMN[^;]+TYPE|ERROR|Changing a column type alters the wire format. Split into: add new column (expand) → dual-write → backfill → switch reads → drop old column (contract)."
  # ── Risky NOT NULL without DEFAULT — ERROR ────────────────────────────────
  "ADD[[:space:]]+COLUMN[^;]+NOT[[:space:]]+NULL[^;]*$|ERROR|ADD COLUMN NOT NULL without a DEFAULT requires a full table rewrite in older Postgres versions (pre-11) and a long lock even in Postgres 11+ if the table is large. Add a DEFAULT or use a two-step expand-then-constrain pattern."
  # ── Advisory — WARN ───────────────────────────────────────────────────────
  "CREATE[[:space:]]+INDEX[^;]+(?!CONCURRENTLY)|WARN|CREATE INDEX without CONCURRENTLY locks writes for the duration of the build. Use CREATE INDEX CONCURRENTLY (and wrap it outside a transaction block: -- migrate:disable_ddl_transaction)."
)

ERRORS=0
WARNINGS=0

# ── Per-file linting ──────────────────────────────────────────────────────────
for file in "${SQL_FILES[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "[lint-migration] WARNING: file not found, skipping: $file" >&2
    continue
  fi

  file_had_issue=false

  while IFS='|' read -r regex severity description; do
    # grep -i for case-insensitive; -P for PCRE (available on ubuntu-latest)
    if grep -qiP "$regex" "$file" 2>/dev/null || grep -qiE "$regex" "$file" 2>/dev/null; then
      if [[ "$severity" == "ERROR" ]]; then
        echo ""
        echo "  ✗ [ERROR] $file"
        echo "    Pattern : $regex"
        echo "    Reason  : $description"
        ERRORS=$((ERRORS + 1))
        file_had_issue=true
      else
        echo ""
        echo "  ⚠ [WARN]  $file"
        echo "    Pattern : $regex"
        echo "    Reason  : $description"
        WARNINGS=$((WARNINGS + 1))
        file_had_issue=true
      fi
    fi
  done <<< "$(printf '%s\n' "${PATTERNS[@]}")"

  if [[ "$file_had_issue" == "false" ]]; then
    echo "  ✓ $file"
  fi
done

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "[lint-migration] Results: ${ERRORS} error(s), ${WARNINGS} advisory warning(s)"

if [[ $ERRORS -gt 0 ]]; then
  echo ""
  echo "[lint-migration] FAILED — destructive migration pattern(s) detected."
  echo "  See docs/MIGRATION_GUIDE.md for the expand-contract procedure."
  exit 1
fi

if [[ $WARNINGS -gt 0 ]]; then
  echo "[lint-migration] Passed with advisory warnings. Review before merging."
fi

echo "[lint-migration] OK"
exit 0
