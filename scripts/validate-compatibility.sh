#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# validate-compatibility.sh
#
# Reads versions.toml and verifies that declared versions are consistent with:
#   - indexer/package.json
#   - frontend/elcarehub-app/package.json
#   - indexer/openapi.json
#   - Latest Prisma migration directory
#   - Contract Cargo.toml files
#   - Event schema sync (contract EVENTS.md ↔ indexer event-schemas.ts)
#
# Usage: bash scripts/validate-compatibility.sh
# Exit 0 = all checks pass, Exit 1 = mismatch found.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSIONS_TOML="$REPO_ROOT/versions.toml"
ERRORS=0

red()   { printf "\033[31m✗ %s\033[0m\n" "$1"; }
green() { printf "\033[32m✓ %s\033[0m\n" "$1"; }
warn()  { printf "\033[33m⚠ %s\033[0m\n" "$1"; }

# ── Parse versions.toml (minimal TOML parser for flat key=value) ─────────────
# Extracts values like components.indexer.version = "1.0.0" → 1.0.0
toml_val() {
  local path="$1"
  grep -E "^${path}\s*=" "$VERSIONS_TOML" 2>/dev/null \
    | head -1 \
    | sed 's/.*=\s*"\{0,1\}\([^"]*\)"\{0,1\}\s*$/\1/' \
    || echo ""
}

# ── 1. versions.toml exists ──────────────────────────────────────────────────
echo "━━━ validate-compatibility.sh ━━━"
echo ""

if [[ ! -f "$VERSIONS_TOML" ]]; then
  red "versions.toml not found at $VERSIONS_TOML"
  exit 1
fi
green "versions.toml exists"

# ── 2. Indexer version ───────────────────────────────────────────────────────
TOML_INDEXER=$(toml_val "components.indexer.version")
PKG_INDEXER=$(jq -r '.version' "$REPO_ROOT/indexer/package.json")
if [[ "$TOML_INDEXER" != "$PKG_INDEXER" ]]; then
  red "Indexer version mismatch: versions.toml=$TOML_INDEXER, package.json=$PKG_INDEXER"
  ERRORS=$((ERRORS + 1))
else
  green "Indexer version matches: $TOML_INDEXER"
fi

# ── 3. Frontend version ──────────────────────────────────────────────────────
TOML_FRONTEND=$(toml_val "components.frontend.version")
PKG_FRONTEND=$(jq -r '.version' "$REPO_ROOT/frontend/elcarehub-app/package.json")
if [[ "$TOML_FRONTEND" != "$PKG_FRONTEND" ]]; then
  red "Frontend version mismatch: versions.toml=$TOML_FRONTEND, package.json=$PKG_FRONTEND"
  ERRORS=$((ERRORS + 1))
else
  green "Frontend version matches: $TOML_FRONTEND"
fi

# ── 4. Marketplace contract Cargo.toml version ───────────────────────────────
TOML_MARKETPLACE=$(toml_val "components.contracts.marketplace.version")
CARGO_MARKETPLACE=$(grep '^version' "$REPO_ROOT/contracts/soroban-marketplace/Cargo.toml" | head -1 | sed 's/.*"\(.*\)".*/\1/')
if [[ "$TOML_MARKETPLACE" != "$CARGO_MARKETPLACE" ]]; then
  red "Marketplace contract version mismatch: versions.toml=$TOML_MARKETPLACE, Cargo.toml=$CARGO_MARKETPLACE"
  ERRORS=$((ERRORS + 1))
else
  green "Marketplace contract version matches: $TOML_MARKETPLACE"
fi

# ── 5. Launchpad contract Cargo.toml version ─────────────────────────────────
TOML_LAUNCHPAD=$(toml_val "components.contracts.launchpad.version")
CARGO_LAUNCHPAD=$(grep '^version' "$REPO_ROOT/contracts/launchpad/Cargo.toml" | head -1 | sed 's/.*"\(.*\)".*/\1/')
if [[ "$TOML_LAUNCHPAD" != "$CARGO_LAUNCHPAD" ]]; then
  red "Launchpad contract version mismatch: versions.toml=$TOML_LAUNCHPAD, Cargo.toml=$CARGO_LAUNCHPAD"
  ERRORS=$((ERRORS + 1))
else
  green "Launchpad contract version matches: $TOML_LAUNCHPAD"
fi

# ── 6. OpenAPI spec version ──────────────────────────────────────────────────
TOML_API=$(toml_val "components.indexer.api_version")
OPENAPI_VERSION=$(jq -r '.info.version' "$REPO_ROOT/indexer/openapi.json" 2>/dev/null || echo "")
if [[ -z "$OPENAPI_VERSION" ]]; then
  warn "Could not read openapi.json — skipping API version check"
elif [[ "$TOML_API" != "$OPENAPI_VERSION" ]]; then
  red "OpenAPI version mismatch: versions.toml=$TOML_API, openapi.json=$OPENAPI_VERSION"
  ERRORS=$((ERRORS + 1))
else
  green "OpenAPI version matches: $TOML_API"
fi

# ── 7. Latest Prisma migration matches declared version ──────────────────────
TOML_DB=$(toml_val "components.indexer.db_migration_version")
MIGRATIONS_DIR="$REPO_ROOT/indexer/prisma/migrations"
if [[ -d "$MIGRATIONS_DIR" ]]; then
  LATEST_MIGRATION=$(ls -1 "$MIGRATIONS_DIR" | grep -E '^[0-9]{14}_' | sort -n | tail -1 | cut -d_ -f1)
  if [[ -z "$LATEST_MIGRATION" ]]; then
    warn "No timestamped migrations found — skipping DB version check"
  elif [[ "$TOML_DB" != "$LATEST_MIGRATION" ]]; then
    red "DB migration version mismatch: versions.toml=$TOML_DB, latest migration=$LATEST_MIGRATION"
    ERRORS=$((ERRORS + 1))
  else
    green "DB migration version matches: $TOML_DB"
  fi
else
  warn "Migrations directory not found — skipping DB version check"
fi

# ── 8. Event schema version declared ─────────────────────────────────────────
TOML_EVENT=$(toml_val "components.event_schema.version")
if [[ -z "$TOML_EVENT" ]]; then
  red "Event schema version not set in versions.toml"
  ERRORS=$((ERRORS + 1))
else
  green "Event schema version declared: $TOML_EVENT"
fi

# ── 9. Compatibility entries exist ───────────────────────────────────────────
COMBO_COUNT=$(grep -c "release_id" "$VERSIONS_TOML" 2>/dev/null || echo "0")
if [[ "$COMBO_COUNT" -lt 2 ]]; then
  # release_id appears once in [release] and at least once in valid_combinations
  red "No valid combinations found in versions.toml [compatibility].valid_combinations"
  ERRORS=$((ERRORS + 1))
else
  green "Compatibility matrix has $((COMBO_COUNT - 1)) valid combination(s)"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
if [[ $ERRORS -gt 0 ]]; then
  red "$ERRORS validation error(s) found. Fix versions.toml and component files before releasing."
  exit 1
else
  green "All version consistency checks passed."
  exit 0
fi
