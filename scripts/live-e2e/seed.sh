#!/usr/bin/env bash
# ============================================================
# scripts/live-e2e/seed.sh
#
# Seeds deterministic on-chain state for the live E2E suite against
# whatever contracts are recorded in scripts/deploy/deployed_ids.env:
#   - A second funded testnet keypair (the "buyer") independent of the
#     deployer/seller account.
#   - A fresh Normal-721 collection.
#   - Token #0, minted and listed on the marketplace  → purchase flow.
#   - Token #1, minted and put up for auction          → auction flow.
#   - Token #2, minted and listed on the marketplace   → offer flow
#     (kept separate from #0 so the purchase test can't consume the
#     listing the offer test depends on).
#
# Writes scripts/live-e2e/seed_ids.env with everything the Playwright
# live suite needs to act on this state directly (no UI-driven setup,
# so test run time and flakiness stay independent of seeding).
#
# Usage: ./scripts/live-e2e/seed.sh [--help]
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/../deploy" && pwd)"
SEED_IDS_FILE="$SCRIPT_DIR/seed_ids.env"

NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
XLM_SAC="CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
AUCTION_DURATION_SECONDS=3600

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  grep '^#' "$0" | grep -v '^#!/' | sed 's/^# \{0,1\}//'
  exit 0
fi

for cmd in stellar curl jq; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: '$cmd' is required but not installed."
    exit 1
  fi
done

if [[ ! -f "$DEPLOY_DIR/deployed_ids.env" || ! -f "$DEPLOY_DIR/.env.deploy" ]]; then
  echo "ERROR: Contracts haven't been deployed yet. Run scripts/deploy/*.sh (or setup.sh without --skip-deploy) first."
  exit 1
fi

# shellcheck disable=SC1091
source "$DEPLOY_DIR/deployed_ids.env"
# shellcheck disable=SC1091
source "$DEPLOY_DIR/.env.deploy"

if [[ -z "${LAUNCHPAD_CONTRACT_ID:-}" ]]; then
  echo "ERROR: LAUNCHPAD_CONTRACT_ID not found. Run scripts/deploy/deploy_launchpad.sh first."
  exit 1
fi

invoke() {
  # $1 = contract id, remaining args = function + args, passed through to `stellar contract invoke`.
  local contract_id="$1"
  shift
  stellar contract invoke \
    --id "$contract_id" \
    --source "$STELLAR_SECRET" \
    --rpc-url "$RPC_URL" \
    --network-passphrase "$NETWORK_PASSPHRASE" \
    -- "$@"
}

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Seeding live E2E state"
echo "  Marketplace : $MARKETPLACE_CONTRACT_ID"
echo "  Launchpad   : $LAUNCHPAD_CONTRACT_ID"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Fund an independent buyer account ────────────────────────
echo ""
echo "[1/6] Funding buyer account..."
stellar keys generate elcarehub-live-e2e-buyer --fund --network testnet --overwrite >/dev/null 2>&1 || true
LIVE_E2E_BUYER_SECRET=$(stellar keys secret elcarehub-live-e2e-buyer)
LIVE_E2E_BUYER_PUBLIC=$(stellar keys public-key elcarehub-live-e2e-buyer)
curl -s "https://friendbot.stellar.org?addr=${LIVE_E2E_BUYER_PUBLIC}" >/dev/null || true
echo "  Buyer: $LIVE_E2E_BUYER_PUBLIC"

# ── Deploy a fresh collection ─────────────────────────────────
echo ""
echo "[2/6] Deploying test collection (Normal 721)..."
SALT=$(printf "%064x" "$(date +%s)1")
COLLECTION_ADDR=$(invoke "$LAUNCHPAD_CONTRACT_ID" deploy_normal_721 \
  --creator "$STELLAR_PUBLIC" \
  --currency "$XLM_SAC" \
  --name "ELCARE-HUB Live E2E Collection" \
  --symbol "AFLE" \
  --max_supply 100 \
  --royalty_bps 500 \
  --royalty_receiver "$STELLAR_PUBLIC" \
  --salt "$SALT" | tr -d '"')
echo "  Collection: $COLLECTION_ADDR"

# ── Mint three tokens ─────────────────────────────────────────
echo ""
echo "[3/6] Minting tokens #0, #1, #2..."
TOKEN_0=$(invoke "$COLLECTION_ADDR" mint --to "$STELLAR_PUBLIC" --uri "ipfs://live-e2e-token-0" | tr -d '"')
TOKEN_1=$(invoke "$COLLECTION_ADDR" mint --to "$STELLAR_PUBLIC" --uri "ipfs://live-e2e-token-1" | tr -d '"')
TOKEN_2=$(invoke "$COLLECTION_ADDR" mint --to "$STELLAR_PUBLIC" --uri "ipfs://live-e2e-token-2" | tr -d '"')
echo "  Token IDs: $TOKEN_0, $TOKEN_1, $TOKEN_2"

RECIPIENTS="[{\"address\":\"$STELLAR_PUBLIC\",\"percentage\":100}]"

# ── Approve + list token #0 (purchase flow) ───────────────────
echo ""
echo "[4/6] Listing token #0 for direct purchase..."
invoke "$COLLECTION_ADDR" approve \
  --spender "$STELLAR_PUBLIC" --approved "$MARKETPLACE_CONTRACT_ID" \
  --token_id "$TOKEN_0" --expiration_ledger 4000000000 >/dev/null
LISTING_ID=$(invoke "$MARKETPLACE_CONTRACT_ID" create_listing \
  --artist "$STELLAR_PUBLIC" --price 150000000 --currency XLM \
  --token "$XLM_SAC" --collection "$COLLECTION_ADDR" --token_id "$TOKEN_0" \
  --recipients "$RECIPIENTS" | tr -d '"')
echo "  Listing ID: $LISTING_ID (15 XLM)"

# ── Approve + auction token #1 ─────────────────────────────────
echo ""
echo "[5/6] Putting token #1 up for auction..."
invoke "$COLLECTION_ADDR" approve \
  --spender "$STELLAR_PUBLIC" --approved "$MARKETPLACE_CONTRACT_ID" \
  --token_id "$TOKEN_1" --expiration_ledger 4000000000 >/dev/null
AUCTION_ID=$(invoke "$MARKETPLACE_CONTRACT_ID" create_auction \
  --creator "$STELLAR_PUBLIC" --token "$XLM_SAC" --collection "$COLLECTION_ADDR" \
  --token_id "$TOKEN_1" --reserve_price 50000000 --duration "$AUCTION_DURATION_SECONDS" \
  --recipients "$RECIPIENTS" | tr -d '"')
echo "  Auction ID: $AUCTION_ID (reserve 5 XLM, ${AUCTION_DURATION_SECONDS}s)"

# ── Approve + list token #2 (offer flow) ──────────────────────
echo ""
echo "[6/6] Listing token #2 for the offer flow..."
invoke "$COLLECTION_ADDR" approve \
  --spender "$STELLAR_PUBLIC" --approved "$MARKETPLACE_CONTRACT_ID" \
  --token_id "$TOKEN_2" --expiration_ledger 4000000000 >/dev/null
OFFER_LISTING_ID=$(invoke "$MARKETPLACE_CONTRACT_ID" create_listing \
  --artist "$STELLAR_PUBLIC" --price 300000000 --currency XLM \
  --token "$XLM_SAC" --collection "$COLLECTION_ADDR" --token_id "$TOKEN_2" \
  --recipients "$RECIPIENTS" | tr -d '"')
echo "  Offer-flow listing ID: $OFFER_LISTING_ID (30 XLM asking price)"

# ── Persist resolved IDs ───────────────────────────────────────
cat > "$SEED_IDS_FILE" <<EOF
# ELCARE-HUB Live E2E Seed — generated $(date -u +"%Y-%m-%dT%H:%M:%SZ")
SEED_COLLECTION_ADDRESS=$COLLECTION_ADDR
SEED_TOKEN_ID=$TOKEN_0
SEED_LISTING_ID=$LISTING_ID
SEED_AUCTION_TOKEN_ID=$TOKEN_1
SEED_AUCTION_ID=$AUCTION_ID
SEED_OFFER_TOKEN_ID=$TOKEN_2
SEED_OFFER_LISTING_ID=$OFFER_LISTING_ID
LIVE_E2E_BUYER_SECRET=$LIVE_E2E_BUYER_SECRET
LIVE_E2E_BUYER_PUBLIC=$LIVE_E2E_BUYER_PUBLIC
EOF

echo ""
echo "✓ Seed complete. Written to $SEED_IDS_FILE"
