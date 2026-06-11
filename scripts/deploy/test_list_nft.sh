#!/bin/bash
set -euo pipefail

MARKETPLACE_ID="CB74XQOHEVOL2NQ376JLVW5IGVM6I5VFDSHG66YKSHDQKRNTYGGXW25E"
N721_ADDR="CCRKGAMRTCCIA3GJ33VWXAQOZPCUJ6J5ZE5NC66F4TIDSSYQODDYB7AZ"
TOKEN_ID="0"
PRICE="150000000"
CURRENCY="CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"

source ./scripts/deploy/.env.deploy
RPC_URL="${RPC_URL:-https://soroban-testnet.stellar.org}"
PUBKEY=$STELLAR_PUBLIC

echo "========================================="
echo "Approving Marketplace to transfer N721 token $TOKEN_ID..."
stellar contract invoke \
  --id "$N721_ADDR" \
  --source "$STELLAR_SECRET" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "Test SDF Network ; September 2015" \
  -- approve \
  --spender "$PUBKEY" \
  --approved "$MARKETPLACE_ID" \
  --token_id "$TOKEN_ID" \
  --expiration_ledger 1000000000 || echo "Approval might have failed or already approved."

echo "========================================="
echo "Listing Token $TOKEN_ID on Marketplace for 15 XLM..."

stellar contract invoke \
  --id "$MARKETPLACE_ID" \
  --source "$STELLAR_SECRET" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "Test SDF Network ; September 2015" \
  -- create_listing \
  --artist "$PUBKEY" \
  --price "$PRICE" \
  --currency XLM \
  --token "$CURRENCY" \
  --collection "$N721_ADDR" \
  --token_id "$TOKEN_ID" \
  --recipients "[{\"address\":\"$PUBKEY\",\"percentage\":100}]"
