#!/usr/bin/env bash
# ============================================================
# scripts/migrations/check-rollback-annotation.sh
#
# Validates that newly added migration SQL files include a non-empty
# `-- rollback:` annotation as required by docs/MIGRATION_GUIDE.md.
#
# This check is scoped to files passed as arguments — callers (CI) should
# supply only newly added migration files from the PR diff so that
# historical migrations without rollback notes are not affected.
#
# USAGE
#   # Check specific files (typical CI usage):
#   bash scripts/migrations/check-rollback-annotation.sh \
#     indexer/prisma/migrations/20261101000000_add_column/migration.sql
#
#   # No arguments — exits 0 (nothing to check):
#   bash scripts/migrations/check-rollback-annotation.sh
#
# EXIT CODES
#   0  — all checked files have a valid rollback annotation
#   1  — at least one file is missing a rollback annotation
#
# ROLLBACK ANNOTATION FORMAT
#   The annotation must be a SQL line comment starting with `-- rollback:`
#   followed by non-empty descriptive content.  The token "rollback"
#   appearing in an unrelated comment does NOT satisfy this requirement.
#
#   Valid example:
#     -- rollback: ALTER TABLE "Listing" DROP COLUMN IF EXISTS "newColumn";
#
#   Invalid (token only, no content):
#     -- rollback:
#
#   Invalid (unrelated comment containing "rollback"):
#     -- note: we may need to rollback later
# ============================================================
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "[check-rollback] No migration files to check."
  exit 0
fi

ERRORS=0

for file in "$@"; do
  if [[ ! -f "$file" ]]; then
    echo "[check-rollback] WARNING: file not found, skipping: $file" >&2
    continue
  fi

  # Search for a line that starts with `-- rollback:` followed by at least
  # one non-whitespace character of content.  The regex is anchored to the
  # comment prefix so that "rollback" in an unrelated comment position does
  # not match.
  if grep -qE '^[[:space:]]*--[[:space:]]*rollback:[[:space:]]*\S' "$file"; then
    echo "  ✓ $file"
  else
    echo ""
    echo "  ✗ [ERROR] $file"
    echo "    Missing '-- rollback: <steps>' annotation."
    echo "    Every new migration must include a rollback comment describing"
    echo "    how to undo the change. See docs/MIGRATION_GUIDE.md §Rollback notes."
    ERRORS=$((ERRORS + 1))
  fi
done

echo ""
if [[ $ERRORS -gt 0 ]]; then
  echo "[check-rollback] FAILED — $ERRORS migration(s) missing rollback annotation."
  exit 1
fi

echo "[check-rollback] OK — all checked migrations have rollback annotations."
exit 0
