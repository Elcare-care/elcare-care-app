<div align="center">

# soroban-launchpad

**NFT collection factory contract for ElcareHub — deploys four collection types on demand using the Stellar Soroban WASM-sharing pattern.**

</div>

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Collection Types](#collection-types)
- [Contract Functions](#contract-functions)
- [Prerequisites](#prerequisites)
- [Build](#build)
- [Deploy](#deploy)
- [Creating a Collection](#creating-a-collection)
- [Lazy Mint — Voucher Signing](#lazy-mint--voucher-signing)
- [Royalty Interface](#royalty-interface)
- [Storage Layout](#storage-layout)

---

## Overview

The Launchpad is a **factory contract** that deploys NFT collection contracts on demand. Artists call one function — `deploy_normal_721`, `deploy_lazy_721`, etc. — and the factory instantiates a new collection contract with isolated persistent storage. The underlying WASM bytecode is stored once on-chain and shared across all collections of that type (equivalent to Ethereum's EIP-1167 clone pattern, but cleaner).

---

## Architecture

```
Launchpad (factory — deployed once)
├── deploy_normal_721()    ──►  NormalNFT721  instance  (own contract address)
├── deploy_normal_1155()   ──►  NormalNFT1155 instance
├── deploy_lazy_721()      ──►  LazyMint721   instance
└── deploy_lazy_1155()     ──►  LazyMint1155  instance
         │
         └──  All instances share the same WASM hash (zero bytecode duplication)
              Each instance has completely isolated persistent storage
```

---

## Collection Types

| Type | Contract | Ethereum Equivalent | Who Mints |
|------|----------|---------------------|-----------|
| `Normal721` | `collection_nft_erc721` | ERC-721 | Creator pre-mints via `mint()` |
| `Normal1155` | `collection_nft_erc1155` | ERC-1155 | Creator calls `mint_new()` / `mint_batch()` |
| `LazyMint721` | `lazy_mint_erc721` | ERC-721 + lazy | Buyer redeems a signed off-chain voucher |
| `LazyMint1155` | `lazy_mint_erc1155` | ERC-1155 + lazy | Buyer redeems signed voucher (edition) |

**When to use lazy mint:** The creator signs a voucher off-chain for each token. No gas is paid until a buyer redeems it. Ideal for large collections where most tokens may never be purchased.

---

## Contract Functions

| Function | Auth | Description |
|----------|------|-------------|
| `initialize(admin, platform_fee_receiver, platform_fee_bps)` | — | One-time setup |
| `set_wasm_hashes(wasm_normal_721, wasm_normal_1155, wasm_lazy_721, wasm_lazy_1155)` | admin | Register the four WASM content hashes |
| `deploy_normal_721(creator, name, symbol, max_supply, royalty_bps, royalty_receiver, salt)` | creator | Deploy a standard ERC-721 collection |
| `deploy_normal_1155(creator, name, symbol, royalty_bps, royalty_receiver, salt)` | creator | Deploy a standard ERC-1155 collection |
| `deploy_lazy_721(creator, creator_pubkey, name, symbol, max_supply, royalty_bps, royalty_receiver, salt)` | creator | Deploy a lazy-mint ERC-721 collection |
| `deploy_lazy_1155(creator, creator_pubkey, name, symbol, royalty_bps, royalty_receiver, salt)` | creator | Deploy a lazy-mint ERC-1155 collection |
| `get_collections(creator)` | — | Returns all collection addresses for a creator |

The `salt` parameter prevents front-running — two `deploy` calls with the same salt from the same creator will produce the same deterministic address.

---

## Prerequisites

```bash
# Rust toolchain with WASM target
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32v1-none

# Stellar CLI
cargo install --locked stellar-cli --features opt
```

---

## Build

```bash
# From the monorepo root — builds all contracts
stellar contract build

# Outputs to:
# target/wasm32v1-none/release/launchpad.wasm
# target/wasm32v1-none/release/collection_nft_erc721.wasm
# target/wasm32v1-none/release/collection_nft_erc1155.wasm
# target/wasm32v1-none/release/lazy_mint_erc721.wasm
# target/wasm32v1-none/release/lazy_mint_erc1155.wasm
```

---

## Deploy

### Step 1 — Upload the four collection WASMs (done once)

```bash
NETWORK="--network testnet --source my-account"

HASH_N721=$(stellar contract upload \
  --wasm target/wasm32v1-none/release/collection_nft_erc721.wasm $NETWORK)

HASH_N1155=$(stellar contract upload \
  --wasm target/wasm32v1-none/release/collection_nft_erc1155.wasm $NETWORK)

HASH_L721=$(stellar contract upload \
  --wasm target/wasm32v1-none/release/lazy_mint_erc721.wasm $NETWORK)

HASH_L1155=$(stellar contract upload \
  --wasm target/wasm32v1-none/release/lazy_mint_erc1155.wasm $NETWORK)

echo "Normal721  hash: $HASH_N721"
echo "Normal1155 hash: $HASH_N1155"
echo "Lazy721    hash: $HASH_L721"
echo "Lazy1155   hash: $HASH_L1155"
```

### Step 2 — Deploy and initialize the Launchpad factory

```bash
LAUNCHPAD=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/launchpad.wasm $NETWORK)

stellar contract invoke --id $LAUNCHPAD $NETWORK \
  --fn initialize -- \
  --admin $ADMIN_ADDRESS \
  --platform_fee_receiver $ADMIN_ADDRESS \
  --platform_fee_bps 250
```

### Step 3 — Register the WASM hashes

```bash
stellar contract invoke --id $LAUNCHPAD $NETWORK \
  --fn set_wasm_hashes -- \
  --wasm_normal_721  $HASH_N721  \
  --wasm_normal_1155 $HASH_N1155 \
  --wasm_lazy_721    $HASH_L721  \
  --wasm_lazy_1155   $HASH_L1155
```

---

## Creating a Collection

### Standard ERC-721 (pre-mint)

```bash
stellar contract invoke --id $LAUNCHPAD $NETWORK \
  --fn deploy_normal_721 -- \
  --creator $CREATOR_ADDRESS \
  --name "Sahara Sunset Series" \
  --symbol "SSS" \
  --max_supply 500 \
  --royalty_bps 750 \
  --royalty_receiver $CREATOR_ADDRESS \
  --salt $(openssl rand -hex 32)
# Returns: new collection contract address
```

### Lazy-Mint ERC-721 (mint-on-demand)

```bash
# creator_pubkey = raw 32-byte ed25519 public key as hex
stellar contract invoke --id $LAUNCHPAD $NETWORK \
  --fn deploy_lazy_721 -- \
  --creator $CREATOR_ADDRESS \
  --creator_pubkey $CREATOR_PUBKEY_HEX \
  --name "Kente Dreams" \
  --symbol "KDR" \
  --max_supply 1000 \
  --royalty_bps 500 \
  --royalty_receiver $CREATOR_ADDRESS \
  --salt $(openssl rand -hex 32)
```

---

## Lazy Mint — Voucher Signing

For lazy-mint collections, the creator signs a voucher off-chain for each token. The buyer submits the voucher to the contract to mint and receive the token.

```typescript
import { Keypair } from "@stellar/stellar-sdk";
import * as crypto from "crypto";

function buildVoucherDigest721(
  tokenId: bigint,
  price: bigint,       // in stroops
  validUntil: bigint,  // ledger sequence
  uri: string,         // IPFS URI
  currencyXdr: Buffer  // XDR-encoded SAC address
): Buffer {
  const uriHash = crypto.createHash("sha256").update(uri).digest();
  const buf = Buffer.alloc(8 + 16 + 8 + 32 + currencyXdr.length);
  let offset = 0;

  buf.writeBigUInt64BE(tokenId, offset);    offset += 8;

  // i128 big-endian (16 bytes)
  const lo = price & 0xffff_ffff_ffff_ffffn;
  const hi = price >> 64n;
  buf.writeBigUInt64BE(hi, offset);         offset += 8;
  buf.writeBigUInt64BE(lo, offset);         offset += 8;

  buf.writeBigUInt64BE(validUntil, offset); offset += 8;
  uriHash.copy(buf, offset);                offset += 32;
  currencyXdr.copy(buf, offset);

  return crypto.createHash("sha256").update(buf).digest();
}

// Sign and return a BytesN<64> signature
const keypair = Keypair.fromSecret("S...");
const digest = buildVoucherDigest721(1n, 10_000_000n, 99_999_999n, "ipfs://...", currencyXdr);
const signature = Buffer.from(keypair.sign(digest));

console.log("signature hex:", signature.toString("hex"));
// Pass signature to contract's redeem() function
```

> For `LazyMint1155`, add `max_amount` and `price_per_unit` to the digest — see `lazy_1155/src/contract.rs`.

---

## Royalty Interface

Every collection deployed by the Launchpad exposes a `royalty_info` function that the marketplace reads before processing a sale:

```bash
stellar contract invoke --id $COLLECTION_ADDRESS $NETWORK \
  --fn royalty_info
# Returns: { receiver: "GCREATOR...", bps: 500 }
# 500 bps = 5% royalty on every resale
```

---

## Storage Layout

| Storage Type | TTL Strategy | Used For |
|-------------|-------------|----------|
| `instance` | Extended on every call | Factory config: admin, fee config, WASM hashes |
| `persistent` | Extended on access | Per-token URIs, balances, approvals, collection metadata |
| `temporary` | Not used | — |

---

## Supported SDK Version

```toml
soroban-sdk = "21.7.6"
```
