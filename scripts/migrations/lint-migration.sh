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
#
# NOTES
# ─────
#   * Comment stripping: `--` line comments and `/* */` block comments (including
#     rollback examples embedded in the migration) are removed before matching so
#     documentation cannot trigger false positives.
#   * Statement scoping: `ADD COLUMN … NOT NULL` and `CREATE INDEX` checks run per
#     SQL statement, so `ADD COLUMN … NOT NULL DEFAULT 0` is accepted and only
#     non-CONCURRENTLY index builds are flagged as advisory.
#   * Exemptions: EXEMPTIONS below lists *already-applied historical* migrations
#     whose flagged statement was reviewed and is safe in context. Exempted
#     violations are reported as advisories, never as blocking errors. New
#     migrations must never be added to the exemption list.
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

# ── Exemptions registry ───────────────────────────────────────────────────────
# Format: "migration_dir_name|justification"
# Policy: ONLY migrations that have already been applied to production may be
# listed here, and only when the flagged statement was reviewed and shown to be
# safe in that specific context. New migrations are never exempted by default.
declare -a EXEMPTIONS=(
  "20260628000000_add_status_enums_timestamps_and_bid_table|Already-applied historical migration; the legacy string status columns were converted to the enum with USING in a reviewed one-off backfill."
  "20260827000004_offer_orphan_staging|Already-applied historical migration; the DELETE FROM statements are scoped cleanups of orphaned rows inside a PL/pgSQL DO block for idempotent backfill, not bulk deletes."
)

file_is_exempt() {
  local dir_name="$1"
  for e in "${EXEMPTIONS[@]}"; do
    if [[ "$e" == "${dir_name}|"* ]]; then
      printf '%s' "${e#*|}"
      return 0
    fi
  done
  return 1
}

# ── Pattern definitions ───────────────────────────────────────────────────────
# Each entry: "REGEX|SEVERITY|DESCRIPTION"
# SEVERITY: ERROR (blocks merge) | WARN (advisory only)
# These run against the comment-stripped content. `ADD COLUMN NOT NULL` and
# `CREATE INDEX` are handled separately per statement (see scan_statements).
declare -a PATTERNS=(
  # ── Destructive — ERROR ───────────────────────────────────────────────────
  "DROP[[:space:]]+TABLE|ERROR|DROP TABLE destroys data. Archive rows first, then drop in a separate release (contract phase)."
  "DROP[[:space:]]+COLUMN|ERROR|DROP COLUMN loses data. Remove application reads/writes (contract phase) before dropping the column."
  "ALTER[[:space:]]+TABLE[^;]+RENAME[[:space:]]+COLUMN|ERROR|RENAME COLUMN breaks in-flight queries on the old name. Add a new column (expand), dual-write, backfill, then drop the old one (contract)."
  "RENAME[[:space:]]+TABLE|ERROR|RENAME TABLE breaks in-flight queries. Use CREATE + dual-write + backfill + DROP pattern instead."
  "TRUNCATE[[:space:]]+|ERROR|TRUNCATE is irreversible data loss. Use batched DELETE with a job instead."
  "DELETE[[:space:]]+FROM|ERROR|Bulk DELETE in a migration can time out and locks the table. Use a background batched-delete job instead."
  "ALTER[[:space:]]+TABLE[^;]+ALTER[[:space:]]+COLUMN[^;]+TYPE|ERROR|Changing a column type alters the wire format. Split into: add new column (expand) → dual-write → backfill → switch reads → drop old column (contract)."
)

# ── Comment stripping + per-statement scans ──────────────────────────────────
# Returns the comment-stripped SQL on stdout. Uses perl when available; falls
# back to dropping full-line comment prefixes otherwise.
strip_comments() {
  local file="$1"
  if perl -e 1 2>/dev/null; then
    perl -0777 -pe 's{/\*.*?\*/}{}gs; s{--[^\n]*}{}g;' "$file"
  else
    grep -vE '^[[:space:]]*--' "$file" || true
  fi
}

# Scans per-statement ADD COLUMN ... NOT NULL (ERROR 1) and CREATE INDEX (WARN 2).
# Echoes the outer-script result lines and returns 0/1/2 for add-column violations.
scan_add_column_not_null() {
  strip_comments "$1" | perl -0777 -ne '
    @stmts = split(/;\s*/);
    for $s (@stmts) {
      next if $s =~ /^\s*$/;
      if ($s =~ /\bADD\s+COLUMN\b/i && $s =~ /\bNOT\s+NULL\b/i && $s !~ /\bDEFAULT\b/i) {
        $s =~ s/^\s+|\s+$//g;
        print "$s\n";
      }
    }
  '
}

# Scans for CREATE INDEX statements that do NOT use CONCURRENTLY.
scan_create_index() {
  strip_comments "$1" | perl -0777 -ne '
    @stmts = split(/;\s*/);
    for $s (@stmts) {
      next if $s =~ /^\s*$/;
      if ($s =~ /\bCREATE\s+INDEX\b/i && $s !~ /\bCONCURRENTLY\b/i) {
        $s =~ s/^\s+|\s+$//g;
        print "$s\n";
      }
    }
  '
}

ERRORS=0
WARNINGS=0
EXEMPTIONS_USED=0

# ── Per-file linting ──────────────────────────────────────────────────────────
for file in "${SQL_FILES[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "[lint-migration] WARNING: file not found, skipping: $file" >&2
    continue
  fi

  dir_name="$(basename "$(dirname "$file")")"
  exempt_reason="$(file_is_exempt "$dir_name" || true)"
  is_exempt=false
  if [[ -n "$exempt_reason" ]]; then
    is_exempt=true
  fi

  file_had_issue=false
  match_count=0

  # 1) Generic destructive patterns over comment-stripped content.
  while IFS='|' read -r regex severity description; do
    cleaned="$(strip_comments "$file")"
    if grep -qiP "$regex" <<<"$cleaned" 2>/dev/null || grep -qiE "$regex" <<<"$cleaned" 2>/dev/null; then
      match_count=$((match_count + 1))
      if [[ "$is_exempt" == "true" ]]; then
        echo ""
        echo "  ℹ [EXEMPT] $file"
        echo "    Pattern : $regex"
        echo "    Reason  : $description"
        echo "    Exempted: $exempt_reason"
        EXEMPTIONS_USED=$((EXEMPTIONS_USED + 1))
      elif [[ "$severity" == "ERROR" ]]; then
        echo ""
        echo "  ✗ [ERROR] $file"
        echo "    Pattern : $regex"
        echo "    Reason  : $description"
        ERRORS=$((ERRORS + 1))
      else
        echo ""
        echo "  ⚠ [WARN]  $file"
        echo "    Pattern : $regex"
        echo "    Reason  : $description"
        WARNINGS=$((WARNINGS + 1))
      fi
      file_had_issue=true
    fi
  done <<< "$(printf '%s\n' "${PATTERNS[@]}")"

  # 2) Per-statement ADD COLUMN … NOT NULL without DEFAULT.
  while IFS= read -r stmt; do
    match_count=$((match_count + 1))
    if [[ "$is_exempt" == "true" ]]; then
      echo ""
      echo "  ℹ [EXEMPT] $file"
      echo "    Pattern : ADD COLUMN … NOT NULL without DEFAULT"
      echo "    Reason  : $stmt"
      echo "    Exempted: $exempt_reason"
      EXEMPTIONS_USED=$((EXEMPTIONS_USED + 1))
    else
      echo ""
      echo "  ✗ [ERROR] $file"
      echo "    Pattern : ADD COLUMN … NOT NULL without DEFAULT"
      echo "    Reason  : ADD COLUMN NOT NULL without a DEFAULT requires a full table rewrite in older Postgres versions (pre-11) and a long lock even in Postgres 11+ if the table is large. Add a DEFAULT or use a two-step expand-then-constrain pattern. Statement: $stmt"
      ERRORS=$((ERRORS + 1))
    fi
    file_had_issue=true
  done < <(scan_add_column_not_null "$file")

  # 3) Per-statement CREATE INDEX without CONCURRENTLY (advisory, one report
  #    per file to keep the noise proportional to signal).
  index_stmts=()
  while IFS= read -r stmt; do
    index_stmts+=("$stmt")
  done < <(scan_create_index "$file")
  if [[ ${#index_stmts[@]} -gt 0 ]]; then
    echo ""
    echo "  ⚠ [WARN]  $file"
    echo "    Pattern : CREATE INDEX without CONCURRENTLY (${#index_stmts[@]} statement(s))"
    echo "    Reason  : CREATE INDEX without CONCURRENTLY locks writes for the duration of the build. Use CREATE INDEX CONCURRENTLY (and wrap it outside a transaction block: -- migrate:disable_ddl_transaction)."
    WARNINGS=$((WARNINGS + 1))
    file_had_issue=true
  fi

  if [[ "$file_had_issue" == "false" ]]; then
    echo "  ✓ $file"
  fi
done

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
if [[ $EXEMPTIONS_USED -gt 0 ]]; then
  echo "[lint-migration] ${EXEMPTIONS_USED} violation(s) covered by the historical-exemption registry (see EXEMPTIONS)."
fi
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