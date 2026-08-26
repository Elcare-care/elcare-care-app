#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# contract-upgrade-rehearsal.sh
#
# End-to-end upgrade rehearsal on a disposable network (testnet/futurenet).
# No production secrets required — uses env vars or Stellar CLI identities.
#
# Usage:
#   bash scripts/rehearse/contract-upgrade-rehearsal.sh \
#     --network testnet \
#     --marketplace C... \
#     --admin admin-key-name
#
# Records expected ledger/event evidence for operator sign-off.
# See docs/guides/contract-upgrade-runbook.md § "Rehearsal procedure"
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EVIDENCE_DIR="${EVIDENCE_DIR:-$REPO_ROOT/tmp/upgrade-rehearsal-$(date +%Y%m%d-%H%M%S)}"

NETWORK=""
MARKETPLACE=""
ADMIN_SOURCE=""
CONTRACT_PKG="soroban-marketplace"

red()   { printf "\033[31m✗ %s\033[0m\n" "$1"; }
green() { printf "\033[32m✓ %s\033[0m\n" "$1"; }
info()  { printf "→ %s\n" "$1"; }

usage() {
  grep '^#' "$0" | head -15 | sed 's/^# \?//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --network)     NETWORK="$2"; shift 2 ;;
    --marketplace) MARKETPLACE="$2"; shift 2 ;;
    --admin)       ADMIN_SOURCE="$2"; shift 2 ;;
    --contract)    CONTRACT_PKG="$2"; shift 2 ;;
    -h|--help)     usage 0 ;;
    *) red "Unknown: $1"; usage 1 ;;
  esac
done

[[ -n "$NETWORK" && -n "$MARKETPLACE" && -n "$ADMIN_SOURCE" ]] || {
  red "Required: --network --marketplace --admin"
  usage 1
}

mkdir -p "$EVIDENCE_DIR"
info "Evidence directory: $EVIDENCE_DIR"

log() { echo "$1" | tee -a "$EVIDENCE_DIR/rehearsal.log"; }

# ── 1. Artifact verification ─────────────────────────────────────────────────
log "=== Step 1: Artifact verification ==="
bash "$REPO_ROOT/scripts/validate-compatibility.sh" 2>&1 | tee "$EVIDENCE_DIR/validate-compatibility.log"
bash "$REPO_ROOT/scripts/validate:abi" 2>/dev/null || npm run validate:abi --prefix "$REPO_ROOT" 2>&1 | tee "$EVIDENCE_DIR/validate-abi.log"
green "Compatibility + ABI checks logged"

# ── 2. Unit tests ─────────────────────────────────────────────────────────────
log "=== Step 2: Contract unit tests ==="
(cd "$REPO_ROOT/contracts/soroban-marketplace" && cargo test -p "$CONTRACT_PKG" 2>&1) | tee "$EVIDENCE_DIR/cargo-test.log"
green "Unit tests complete"

# ── 3. Pre-upgrade state snapshot ────────────────────────────────────────────
log "=== Step 3: Pre-upgrade state snapshot ==="
if command -v stellar >/dev/null 2>&1; then
  stellar contract invoke --id "$MARKETPLACE" --network "$NETWORK" -- version \
    2>&1 | tee "$EVIDENCE_DIR/pre-version.txt"
  stellar contract invoke --id "$MARKETPLACE" --network "$NETWORK" -- contract_version \
    2>&1 | tee "$EVIDENCE_DIR/pre-contract-version.txt"
  stellar contract invoke --id "$MARKETPLACE" --network "$NETWORK" -- get_active_listings_count \
    2>&1 | tee "$EVIDENCE_DIR/pre-active-listings.txt" || true
  stellar contract invoke --id "$MARKETPLACE" --network "$NETWORK" -- get_token_whitelist \
    2>&1 | tee "$EVIDENCE_DIR/pre-token-whitelist.txt" || true
else
  red "stellar CLI not found — snapshot skipped"
fi

# ── 4. Build WASM ─────────────────────────────────────────────────────────────
log "=== Step 4: Build release WASM ==="
(cd "$REPO_ROOT" && cargo build --target wasm32v1-none --release -p "$CONTRACT_PKG" 2>&1) \
  | tee "$EVIDENCE_DIR/cargo-build.log"
WASM="$REPO_ROOT/target/wasm32v1-none/release/${CONTRACT_PKG//-/_}.wasm"
ls -lh "$WASM" 2>&1 | tee "$EVIDENCE_DIR/wasm-size.txt"

# ── 5. Pause strategy check (read-only) ──────────────────────────────────────
log "=== Step 5: Pause state ==="
if command -v stellar >/dev/null 2>&1; then
  stellar contract invoke --id "$MARKETPLACE" --network "$NETWORK" -- is_paused \
    2>&1 | tee "$EVIDENCE_DIR/pause-state.txt" || warn "is_paused not available"
fi
info "If paused=true, run admin_unpause after successful migration or keep paused for diagnosis"

# ── 6. Manual upgrade steps (operator) ───────────────────────────────────────
log "=== Step 6: Manual upgrade (operator executes) ==="
cat >> "$EVIDENCE_DIR/operator-commands.sh" <<EOF
#!/usr/bin/env bash
# Generated rehearsal commands — review before running on mainnet
set -euo pipefail
WASM_HASH=\$(stellar contract upload \\
  --wasm "$WASM" \\
  --network $NETWORK \\
  --source $ADMIN_SOURCE | tail -1)

stellar contract install \\
  --wasm-hash "\$WASM_HASH" \\
  --contract-id $MARKETPLACE \\
  --network $NETWORK \\
  --source $ADMIN_SOURCE

stellar contract invoke \\
  --id $MARKETPLACE \\
  --network $NETWORK \\
  --source $ADMIN_SOURCE \\
  -- migrate --admin \$(stellar keys address $ADMIN_SOURCE)
EOF
chmod +x "$EVIDENCE_DIR/operator-commands.sh"
green "Operator command script: $EVIDENCE_DIR/operator-commands.sh"

# ── 7. Post-upgrade verification template ────────────────────────────────────
log "=== Step 7: Post-upgrade verification (run after step 6) ==="
cat > "$EVIDENCE_DIR/post-verify.sh" <<'POSTEOF'
#!/usr/bin/env bash
set -euo pipefail
# Fill MARKETPLACE, NETWORK from rehearsal env
stellar contract invoke --id "$MARKETPLACE" --network "$NETWORK" -- version
stellar contract invoke --id "$MARKETPLACE" --network "$NETWORK" -- contract_version
stellar events --contract-id "$MARKETPLACE" --network "$NETWORK" --topic1 migrated
stellar contract invoke --id "$MARKETPLACE" --network "$NETWORK" -- get_listing --listing_id 1 || true
POSTEOF
chmod +x "$EVIDENCE_DIR/post-verify.sh"

# ── 8. Indexer smoke (optional) ──────────────────────────────────────────────
log "=== Step 8: Indexer smoke template ==="
cat > "$EVIDENCE_DIR/indexer-smoke.sh" <<'IDXEOF'
#!/usr/bin/env bash
# After indexer catches up post-upgrade
curl -sf "${INDEXER_URL:-http://localhost:4000}/health" | jq .
curl -sf "${INDEXER_URL:-http://localhost:4000}/listings?limit=3" | jq 'length'
IDXEOF
chmod +x "$EVIDENCE_DIR/indexer-smoke.sh"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
green "Rehearsal prep complete."
info "Next: seed testnet with listings/auctions/offers/vouchers (scripts/live-e2e/seed.sh)"
info "Then run: $EVIDENCE_DIR/operator-commands.sh"
info "Then run: MARKETPLACE=$MARKETPLACE NETWORK=$NETWORK $EVIDENCE_DIR/post-verify.sh"
info "Attach $EVIDENCE_DIR to change ticket for production upgrade approval"
