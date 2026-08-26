#!/usr/bin/env bash
# ============================================================
# deploy_contract.sh
# Builds, optimises, and deploys the Soroban marketplace
# contract to Stellar Testnet.
# Requires: fund_account.sh to have been run first.
#
# Usage: ./deploy_contract.sh [--dry-run] [--skip-verification] [--help]
#
# Flags:
#   --dry-run            Validate prerequisites and print what would
#                         happen, but make no on-chain changes.
#   --skip-verification  Skip the release artifact verification gate
#                         (see below). UNSAFE — local/dev use only.
#                         Refused when DEPLOY_ENV=production.
#   --help                Show this message and exit.
#
# Release artifact verification (issue #540):
#   If RELEASE_ARTIFACTS_DIR is set, this script treats it as a
#   downloaded, signed GitHub Release (see
#   .github/workflows/release.yml and docs/RELEASE_VERIFICATION.md)
#   and runs scripts/release/verify-artifact.sh against it before
#   building or deploying anything. Deployment aborts if verification
#   fails. This does NOT change what gets deployed (the contract is
#   still built fresh from source in this script) — it is a
#   provenance gate so an operator promoting a specific tagged
#   release cannot proceed on tampered or unverifiable artifacts.
#
#   RELEASE_ARTIFACTS_DIR unset -> verification is skipped (the
#   common case: building straight from a working tree for testnet
#   iteration, not promoting a signed release).
#
#   DEPLOY_ENV=production (or PRODUCTION=true) -> --skip-verification
#   is rejected outright, and RELEASE_ARTIFACTS_DIR + a clean
#   verification pass become mandatory.
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$SCRIPT_DIR/.env.deploy"
DEPLOYED_IDS="$SCRIPT_DIR/deployed_ids.env"
DEPLOYED_VERSIONS="$SCRIPT_DIR/deployed_versions.json"
CONTRACT_DIR="$REPO_ROOT/contracts/soroban-marketplace"
WASM_LOCAL="$CONTRACT_DIR/target/wasm32v1-none/release/soroban_marketplace.wasm"
WASM_WORKSPACE="$REPO_ROOT/target/wasm32v1-none/release/soroban_marketplace.wasm"
WASM="$WASM_WORKSPACE"
FRONTEND_ENV="$REPO_ROOT/frontend/elcarehub-app/.env.local"
DRY_RUN=false
SKIP_VERIFICATION=false
RELEASE_ARTIFACTS_DIR="${RELEASE_ARTIFACTS_DIR:-}"
RELEASE_REPO="${RELEASE_REPO:-your-org/elcarehub}"
DEPLOY_ENV="${DEPLOY_ENV:-}"
PRODUCTION="${PRODUCTION:-false}"

usage() {
  grep '^#' "$0" | grep -v '^#!/' | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --skip-verification) SKIP_VERIFICATION=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: Unknown flag: $arg"; usage; exit 1 ;;
  esac
done

IS_PRODUCTION=false
if [[ "$DEPLOY_ENV" == "production" || "$PRODUCTION" == "true" ]]; then
  IS_PRODUCTION=true
fi

if $SKIP_VERIFICATION && $IS_PRODUCTION; then
  echo "ERROR: --skip-verification is not allowed when DEPLOY_ENV=production (or PRODUCTION=true)."
  echo "       Production deployments must verify release artifacts. See docs/RELEASE_VERIFICATION.md."
  exit 1
fi

if $IS_PRODUCTION && [[ -z "$RELEASE_ARTIFACTS_DIR" ]]; then
  echo "ERROR: DEPLOY_ENV=production requires RELEASE_ARTIFACTS_DIR to point at a"
  echo "       downloaded, signed release (see docs/RELEASE_VERIFICATION.md)."
  exit 1
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ELCARE-HUB — Deploy Soroban Contract to Testnet"
if $DRY_RUN; then echo "  (DRY RUN — no on-chain changes will be made)"; fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Release artifact verification gate ───────────────────────
if [[ -n "$RELEASE_ARTIFACTS_DIR" ]]; then
  if $SKIP_VERIFICATION; then
    echo "WARNING: --skip-verification passed — SKIPPING release artifact verification."
    echo "         This is UNSAFE and must never be used for a production deployment."
  else
    echo ""
    echo "Verifying release artifacts in $RELEASE_ARTIFACTS_DIR ..."
    if $DRY_RUN; then
      echo "DRY RUN: Would run: $SCRIPT_DIR/../release/verify-artifact.sh --dir $RELEASE_ARTIFACTS_DIR --repo $RELEASE_REPO"
    elif ! "$SCRIPT_DIR/../release/verify-artifact.sh" --dir "$RELEASE_ARTIFACTS_DIR" --repo "$RELEASE_REPO"; then
      echo "ERROR: Release artifact verification FAILED. Refusing to deploy unverified artifacts."
      echo "       Use --skip-verification only for local/dev debugging (never in production)."
      exit 1
    fi
    echo "Release artifact verification passed."
  fi
elif $IS_PRODUCTION; then
  # Unreachable given the guard above, but kept as defense-in-depth.
  echo "ERROR: Production deployment with no RELEASE_ARTIFACTS_DIR set."
  exit 1
else
  echo "NOTE: RELEASE_ARTIFACTS_DIR not set — building from source, skipping release"
  echo "      artifact verification (only applies when deploying a downloaded,"
  echo "      signed release; see docs/RELEASE_VERIFICATION.md)."
fi

# ── Check prerequisites ─────────────────────────────────────
for cmd in stellar cargo jq; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: '$cmd' is not installed."
    exit 1
  fi
done

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found. Run ./fund_account.sh first."
  exit 1
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

for var in STELLAR_SECRET STELLAR_PUBLIC RPC_URL NETWORK; do
  if [[ -z "${!var:-}" ]]; then
    echo "ERROR: $var is not set in $ENV_FILE. Run ./fund_account.sh to regenerate."
    exit 1
  fi
done

if $DRY_RUN; then
  echo "DRY RUN: Prerequisites OK."
  echo "DRY RUN: Would build $CONTRACT_DIR"
  echo "DRY RUN: Would install WASM to $NETWORK via $RPC_URL"
  echo "DRY RUN: Would deploy contract and write IDs to:"
  echo "         $DEPLOYED_IDS"
  echo "         $FRONTEND_ENV"
  exit 0
fi

# ── Build WASM ────────────────────────────────────────────────
echo ""
echo "Step 1/4  Building contract WASM..."
cd "$CONTRACT_DIR"
cargo build --target wasm32v1-none --release 2>&1

if [[ -f "$WASM_WORKSPACE" ]]; then
  WASM="$WASM_WORKSPACE"
elif [[ -f "$WASM_LOCAL" ]]; then
  WASM="$WASM_LOCAL"
else
  echo "ERROR: Built WASM not found in expected locations:"
  echo "  - $WASM_WORKSPACE"
  echo "  - $WASM_LOCAL"
  exit 1
fi

# ── Optimise WASM ─────────────────────────────────────────────
echo ""
echo "Step 2/4  Optimising WASM..."
if stellar contract optimize \
  --wasm "$WASM" \
  --wasm-out "$WASM"; then
  WASM_SIZE=$(wc -c <"$WASM")
  echo "  WASM size: ${WASM_SIZE} bytes"
else
  echo "  WARNING: WASM optimization failed. Continuing with unoptimized WASM."
fi

# ── Upload WASM to network ────────────────────────────────────
echo ""
echo "Step 3/4  Uploading WASM to ${NETWORK}..."
WASM_HASH=$(stellar contract install \
  --wasm "$WASM" \
  --source "$STELLAR_SECRET" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "Test SDF Network ; September 2015" \
  --ignore-checks 2>&1 | tail -1)
echo "  WASM hash: $WASM_HASH"

# ── Deploy contract instance ──────────────────────────────────
echo ""
echo "Step 4/4  Deploying contract instance..."
CONTRACT_ID=$(stellar contract deploy \
  --wasm-hash "$WASM_HASH" \
  --source "$STELLAR_SECRET" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "Test SDF Network ; September 2015" \
  --ignore-checks 2>&1 | tail -1)
echo "  Contract ID: $CONTRACT_ID"

# ── Write machine-readable deployed IDs ──────────────────────
cat > "$DEPLOYED_IDS" <<EOF
# ELCARE-HUB Deployed Contract IDs
# Generated $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# Source this file or read it downstream to wire up services.
MARKETPLACE_CONTRACT_ID=$CONTRACT_ID
MARKETPLACE_WASM_HASH=$WASM_HASH
NETWORK=$NETWORK
RPC_URL=$RPC_URL
EOF
echo "  Deployed IDs written to $DEPLOYED_IDS"

# ── Write version mapping (WASM hash → source version) ───────
CONTRACT_VERSION=$(grep '^version' "$CONTRACT_DIR/Cargo.toml" | head -1 | sed 's/.*"\(.*\)".*/\1/')
CONTRACT_SEMVER=$(grep 'CONTRACT_VERSION' "$CONTRACT_DIR/src/contract.rs" | head -1 | sed 's/.*"\(.*\)".*/\1/')
GIT_SHA=$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo "unknown")

# Merge into deployed_versions.json (append or create)
if [[ -f "$DEPLOYED_VERSIONS" ]]; then
  EXISTING=$(cat "$DEPLOYED_VERSIONS")
else
  EXISTING='{"deployments":[]}'
fi

echo "$EXISTING" | jq \
  --arg contract_id "$CONTRACT_ID" \
  --arg wasm_hash "$WASM_HASH" \
  --arg cargo_version "$CONTRACT_VERSION" \
  --arg contract_version "$CONTRACT_SEMVER" \
  --arg git_sha "$GIT_SHA" \
  --arg network "$NETWORK" \
  --arg deployed_at "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
  '.deployments += [{
    "contract": "soroban-marketplace",
    "contract_id": $contract_id,
    "wasm_hash": $wasm_hash,
    "cargo_version": $cargo_version,
    "contract_version": $contract_version,
    "git_sha": $git_sha,
    "network": $network,
    "deployed_at": $deployed_at
  }]' > "$DEPLOYED_VERSIONS"
echo "  Version mapping written to $DEPLOYED_VERSIONS"

# ── Write frontend .env.local ────────────────────────────────
mkdir -p "$(dirname "$FRONTEND_ENV")"

update_env() {
  local key=$1
  local val=$2
  if grep -q "^${key}=" "$FRONTEND_ENV"; then
    sed "s|^${key}=.*|${key}=${val}|" "$FRONTEND_ENV" > "$FRONTEND_ENV.tmp"
    mv "$FRONTEND_ENV.tmp" "$FRONTEND_ENV"
  else
    echo "${key}=${val}" >> "$FRONTEND_ENV"
  fi
}

if [ ! -f "$FRONTEND_ENV" ]; then
  cat > "$FRONTEND_ENV" <<EOF
# ELCARE-HUB Frontend — generated by deploy_contract.sh
NEXT_PUBLIC_CONTRACT_ID=$CONTRACT_ID
NEXT_PUBLIC_STELLAR_NETWORK=testnet
NEXT_PUBLIC_STELLAR_RPC_URL=$RPC_URL
NEXT_PUBLIC_STELLAR_HORIZON_URL=$HORIZON_URL
NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015

# Pinata IPFS — fill these in manually
PINATA_JWT=
NEXT_PUBLIC_PINATA_GATEWAY=https://gateway.pinata.cloud
EOF
else
  update_env "NEXT_PUBLIC_CONTRACT_ID" "$CONTRACT_ID"
  update_env "NEXT_PUBLIC_STELLAR_NETWORK" "testnet"
  update_env "NEXT_PUBLIC_STELLAR_RPC_URL" "$RPC_URL"
  update_env "NEXT_PUBLIC_STELLAR_HORIZON_URL" "$HORIZON_URL"
  update_env "NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE" "Test SDF Network ; September 2015"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✓ Deployment complete!"
echo ""
echo "  Contract ID : $CONTRACT_ID"
echo "  Network     : $NETWORK"
echo ""
echo "  Machine-readable IDs : $DEPLOYED_IDS"
echo "  Frontend env written  : $FRONTEND_ENV"
echo "  Add your PINATA_JWT to that file, then:"
echo "    cd frontend/elcarehub-app && npm install && npm run dev"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
