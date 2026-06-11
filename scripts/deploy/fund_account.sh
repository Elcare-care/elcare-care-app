#!/usr/bin/env bash
# ============================================================
# fund_account.sh
# Creates a new Stellar keypair and funds it on Testnet via
# Friendbot. Saves the keys to .env.deploy for use by
# deploy_contract.sh
# ============================================================
set -euo pipefail

ENV_FILE="$(dirname "$0")/.env.deploy"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ELCARE-HUB — Fund Testnet Deployer Account"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Check prerequisites ──────────────────────────────────────
for cmd in stellar curl jq; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: '$cmd' is required but not installed."
    echo "  Install the Stellar CLI: https://developers.stellar.org/docs/tools/developer-tools/cli/install-cli"
    exit 1
  fi
done

# ── Generate keypair ──────────────────────────────────────────
echo "Generating new keypair..."
stellar keys generate ELCARE-HUB-deployer --fund --network testnet --overwrite >/dev/null 2>&1 || true

STELLAR_SECRET=$(stellar keys secret ELCARE-HUB-deployer 2>/dev/null || true)
STELLAR_PUBLIC=$(stellar keys public-key ELCARE-HUB-deployer 2>/dev/null || true)

if [[ -z "$STELLAR_SECRET" || -z "$STELLAR_PUBLIC" ]]; then
  echo "ERROR: Failed to generate keypair. Is the Stellar CLI installed and in your PATH?"
  exit 1
fi

echo "Public Key : $STELLAR_PUBLIC"
echo "Secret Key : (written to $ENV_FILE — keep this safe!)"

# ── Fund via Friendbot ────────────────────────────────────────
echo "Funding account via Friendbot..."
RESPONSE=$(curl -s "https://friendbot.stellar.org?addr=${STELLAR_PUBLIC}")
STATUS=$(echo "$RESPONSE" | jq -r '.successful // "false"')

if [[ "$STATUS" != "true" ]]; then
  echo "WARNING: Friendbot may have returned an error (account may already be funded)."
  echo "Response: $RESPONSE"
fi

# ── Save to .env.deploy ───────────────────────────────────────
cat > "$ENV_FILE" <<EOF
# ELCARE-HUB Deploy — Testnet
# Generated $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# WARNING: Never commit this file to version control.
STELLAR_SECRET=$STELLAR_SECRET
STELLAR_PUBLIC=$STELLAR_PUBLIC
NETWORK=testnet
RPC_URL=https://soroban-testnet.stellar.org
HORIZON_URL=https://horizon-testnet.stellar.org
EOF

echo ""
echo "✓ Account funded. Credentials saved to $ENV_FILE"
echo "  Run ./deploy_contract.sh next."
