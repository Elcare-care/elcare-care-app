#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env.deploy"
source "$ENV_FILE"

LAUNCHPAD_ID="CA4RKSR4ORRIFBBW64MXCWS7GGJ4GY6AIXRGU5EGS43XBDDB7OYV3TRG"
XLM_SAC="CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
PUBKEY_HEX="4b469c90755bbeaca453ff2cdcb84bd89dd9775df8f864c157f7f6cd713b9552"

TIMESTAMP=$(date +%s)
SALT_N721=$(printf "%064x" "${TIMESTAMP}1")
SALT_N1155=$(printf "%064x" "${TIMESTAMP}2")
SALT_L721=$(printf "%064x" "${TIMESTAMP}3")
SALT_L1155=$(printf "%064x" "${TIMESTAMP}4")

echo "Deploying Normal 721..."
N721_ADDR=$(stellar contract invoke \
  --id "$LAUNCHPAD_ID" \
  --source "$STELLAR_SECRET" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "Test SDF Network ; September 2015" \
  -- deploy_normal_721 \
  --creator "$STELLAR_PUBLIC" \
  --currency "$XLM_SAC" \
  --name "ELCARE-HUB N721 Test" \
  --symbol "AFN7" \
  --max_supply 100 \
  --royalty_bps 500 \
  --royalty_receiver "$STELLAR_PUBLIC" \
  --salt "$SALT_N721" \
  | tr -d '"')
echo "Normal 721 Address: $N721_ADDR"

echo "Deploying Normal 1155..."
N1155_ADDR=$(stellar contract invoke \
  --id "$LAUNCHPAD_ID" \
  --source "$STELLAR_SECRET" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "Test SDF Network ; September 2015" \
  -- deploy_normal_1155 \
  --creator "$STELLAR_PUBLIC" \
  --currency "$XLM_SAC" \
  --name "ELCARE-HUB N1155 Test" \
  --royalty_bps 500 \
  --royalty_receiver "$STELLAR_PUBLIC" \
  --salt "$SALT_N1155" \
  | tr -d '"')
echo "Normal 1155 Address: $N1155_ADDR"

echo "Deploying Lazy 721..."
L721_ADDR=$(stellar contract invoke \
  --id "$LAUNCHPAD_ID" \
  --source "$STELLAR_SECRET" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "Test SDF Network ; September 2015" \
  -- deploy_lazy_721 \
  --creator "$STELLAR_PUBLIC" \
  --currency "$XLM_SAC" \
  --creator_pubkey "$PUBKEY_HEX" \
  --name "ELCARE-HUB L721 Test" \
  --symbol "AFL7" \
  --max_supply 100 \
  --royalty_bps 500 \
  --royalty_receiver "$STELLAR_PUBLIC" \
  --salt "$SALT_L721" \
  | tr -d '"')
echo "Lazy 721 Address: $L721_ADDR"

echo "Deploying Lazy 1155..."
L1155_ADDR=$(stellar contract invoke \
  --id "$LAUNCHPAD_ID" \
  --source "$STELLAR_SECRET" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "Test SDF Network ; September 2015" \
  -- deploy_lazy_1155 \
  --creator "$STELLAR_PUBLIC" \
  --currency "$XLM_SAC" \
  --creator_pubkey "$PUBKEY_HEX" \
  --name "ELCARE-HUB L1155 Test" \
  --royalty_bps 500 \
  --royalty_receiver "$STELLAR_PUBLIC" \
  --salt "$SALT_L1155" \
  | tr -d '"')
echo "Lazy 1155 Address: $L1155_ADDR"

echo "========================================="
echo "Minting tokens into Normal 721..."
for i in {0..3}; do
  URI="ipfs://bafybeielb3xq2x275bmzty7dy4vfnvc7t432u3ki3phdiyiqoedbagr32q/${i}.json"
  echo "Minting N721 token ${i}..."
  stellar contract invoke \
    --id "$N721_ADDR" \
    --source "$STELLAR_SECRET" \
    --rpc-url "$RPC_URL" \
    --network-passphrase "Test SDF Network ; September 2015" \
    -- mint \
    --to "$STELLAR_PUBLIC" \
    --uri "$URI"
done

echo "========================================="
echo "Minting tokens into Normal 1155..."
for i in {0..3}; do
  URI="ipfs://bafybeielb3xq2x275bmzty7dy4vfnvc7t432u3ki3phdiyiqoedbagr32q/${i}.json"
  echo "Minting N1155 token ${i} with amount 10..."
  stellar contract invoke \
    --id "$N1155_ADDR" \
    --source "$STELLAR_SECRET" \
    --rpc-url "$RPC_URL" \
    --network-passphrase "Test SDF Network ; September 2015" \
    -- mint_new \
    --to "$STELLAR_PUBLIC" \
    --amount 10 \
    --uri "$URI"
done

echo "========================================="
echo "Done!"
echo "N721: $N721_ADDR"
echo "N1155: $N1155_ADDR"
echo "L721: $L721_ADDR"
echo "L1155: $L1155_ADDR"
