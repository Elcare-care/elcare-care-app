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
- [Upgrading & Migrating](#upgrading--migrating)
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

## Collection Kind × Input Validation Matrix

Each `deploy_*` / `preflight_deploy_*` call validates inputs through a shared helper before touching storage. The table below documents accepted ranges and the error codes returned on violation.

### Input Bounds by Kind

| Field | Normal721 | Normal1155 | LazyMint721 | LazyMint1155 | Error on violation |
|---|---|---|---|---|---|
| `name` | 1–64 chars | 1–64 chars | 1–64 chars | 1–64 chars | `EmptyName` (#12) / `NameTooLong` (#18) |
| `symbol` | 1–16 chars | _(none)_ | 1–16 chars | _(none)_ | `EmptySymbol` (#13) / `SymbolTooLong` (#19) |
| `max_supply` | 1–1 000 000 000 | _(none)_ | 1–1 000 000 000 | _(none)_ | `InvalidMaxSupply` (#14) / `MaxSupplyTooLarge` (#20) |
| `royalty_bps` | 0–10 000 | 0–10 000 | 0–10 000 | 0–10 000 | `InvalidRoyaltyBps` (#11) |
| `platform_fee_bps` | 0–2 000 | 0–2 000 | 0–2 000 | 0–2 000 | `InvalidFeeBps` (#5) |
| `salt` | unique per creator | unique per creator | unique per creator | unique per creator | `DuplicateSalt` (#10) |

**Notes:**
- `preflight_deploy_*` runs the same validation as `deploy_*` without requiring auth or touching storage. All errors are returned as `Vec<u32>` in `PreflightResult.errors`; an empty vector means the deployment is expected to succeed.
- `WasmHashNotSet` (#4) is included in `errors` when the WASM for that kind has not yet been registered via `set_wasm_hashes`. This is expected on a fresh factory and does not indicate an input error.
- `ContractPaused` (#6) is included when the factory is in the paused state.
- When multiple validations fail, all error codes are returned simultaneously — not just the first.

### Kind × Shape Mapping

| CollectionKind | Rust variant | deploy function | shape |
|---|---|---|---|
| Normal ERC-721 | `CollectionKind::Normal721` | `deploy_normal_721` | 721-shaped (name, symbol, max_supply) |
| Normal ERC-1155 | `CollectionKind::Normal1155` | `deploy_normal_1155` | 1155-shaped (name only) |
| Lazy ERC-721 | `CollectionKind::LazyMint721` | `deploy_lazy_721` | 721-shaped + creator_pubkey + network_passphrase |
| Lazy ERC-1155 | `CollectionKind::LazyMint1155` | `deploy_lazy_1155` | 1155-shaped + creator_pubkey + network_passphrase |

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

## Emergency Pause Role (Issue #267)

`pause()` / `unpause()` halt all four `deploy_*` functions and were previously gated by the single `Admin` key only. `set_emergency_pauser(pauser)` (admin-only) now lets an operator designate a separate `EmergencyPauser` address — a dedicated incident-response multisig, for example — that can call `pause`/`unpause` independently of the routine admin authority. While no pauser has been configured, `pause`/`unpause` fall back to `Admin` unchanged, so existing deployments need no migration. `emergency_pauser()` returns the current explicit holder, or `None` while on the admin fallback. Every reassignment emits a `("pauser", "set")` event.

This mirrors the marketplace contract's fuller role-separation model (see `contracts/soroban-marketplace/README.md`'s "Role-Based Authorization" section) scoped to launchpad's smaller privileged surface — routine admin config (`set_wasm_hashes`, `set_fee_config`) and irreversible admin-transfer remain on the existing two-step `Admin` flow.

---

## Salt Security & Address Determinism

### How salts work

Every `deploy_*` call requires a `salt: BytesN<32>` chosen by the creator. The factory derives a **secure salt** internally:

```
secure_salt = sha256(creator.to_xdr() ‖ raw_salt)
```

The deployed address is then:
```
address = sha256(factory_address ‖ secure_salt)
```

### Front-running resistance

Because `secure_salt` incorporates the creator's XDR-encoded address, two different creators passing the same `raw_salt` will deploy to two completely different on-chain addresses. A malicious actor who copies Alice's raw salt and submits their own transaction first cannot occupy Alice's target address.

| Scenario | Outcome |
|---|---|
| Alice: `raw_salt = X` | deploys to `sha256(factory ‖ sha256(alice_xdr ‖ X))` |
| Bob: `raw_salt = X` (same) | deploys to `sha256(factory ‖ sha256(bob_xdr ‖ X))` ≠ Alice's |
| Alice: `raw_salt = X` (second call) | returns existing address (`dep_idem` event, no new deployment) |

### Valid / invalid / deployed salt sequences

| Salt state | Preflight result | Deploy result |
|---|---|---|
| **Valid** — new (creator, raw_salt) pair | `errors = []` (or `[4]` if WASM not registered) | Deploys to predicted address |
| **Invalid** — `DuplicateSalt` | `errors` contains `10` | Reverts (after deploy already consumed the salt) |
| **Deployed** — same (creator, raw_salt) already used | `errors` contains `10` | Returns existing address idempotently (`dep_idem` event) |

### Cross-kind collision

The secure salt is derived from `(creator, raw_salt)` only — not from the collection kind. Two calls with the same creator+salt but different kinds (`deploy_normal_721` vs `deploy_normal_1155`) produce the **same** `predicted_address`. After the first deployment, the second returns the existing address idempotently regardless of kind.

### Pre-computing the address

```typescript
import { Address, hash, xdr } from "@stellar/stellar-sdk";

function predictAddress(factory: Address, creator: Address, rawSalt: Buffer): string {
  const creatorXdr = creator.toXDRObject().toXDR();
  const secureSalt = hash(Buffer.concat([creatorXdr, rawSalt]));
  // The Soroban deployer uses SHA256(factory_contract_id XDR || "contract" || secure_salt)
  // Use stellar-sdk's Contract.deploymentAddress helper when available.
  // Alternatively: call preflight_deploy_* on-chain (read-only, no fee).
  return "use preflight_deploy_* for the exact address";
}
```

The most reliable pre-computation is to call `preflight_deploy_*` read-only — it returns `predicted_address` using the same derivation path as the real deploy.

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
