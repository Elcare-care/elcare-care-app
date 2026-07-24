# Contract Testing & Debugging Guide

This guide covers building, testing, and debugging Soroban smart contracts in the ElcareHub workspace.

---

## 1. Owning Files & Workspace Structure

All smart contracts are written in Rust and managed via a single Cargo workspace defined in the root [`Cargo.toml`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/Cargo.toml).

```
contracts/
├── soroban-marketplace/       # Core marketplace: listings, auctions, offers, royalties
│   ├── Cargo.toml
│   ├── Makefile
│   └── src/
│       ├── lib.rs
│       ├── contract.rs        # Main entry points
│       ├── types.rs           # MarketplaceError enum, data structs
│       ├── storage.rs         # Storage keys and TTL management
│       ├── events.rs          # On-chain event definitions
│       └── test.rs            # Unit test suite
├── launchpad/                 # Collection deployment factory
├── collection_nft_erc721/     # Standard 721 collection
├── collection_nft_erc1155/    # Standard 1155 collection
├── lazy_mint_erc721/          # Lazy-mint 721 variant
└── lazy_mint_erc721/          # Lazy-mint 1155 variant
```

---

## 2. Command Reference

### Prerequisites
* **Rust**: stable toolchain with target `wasm32v1-none` (or `wasm32-unknown-unknown`)
* **Stellar CLI**: `stellar` CLI tool installed (`cargo install --locked stellar-cli`)

### Run All Unit Tests
```bash
cargo test
```
*Expected output:*
```text
running 42 tests
test test::test_create_listing_success ... ok
test test::test_buy_listing_transfers_funds_and_royalties ... ok
...
test result: ok. 42 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

### Run Tests for Specific Contract
```bash
cargo test -p soroban_marketplace
```

### Run Tests with Console Print Output (`std::println!`)
```bash
cargo test -- --nocapture
```

### Build Contract WASM Artifact
```bash
cargo build --target wasm32v1-none --release
```
*Artifact output location:* `target/wasm32v1-none/release/soroban_marketplace.wasm`

### Optimize WASM Artifact Size
```bash
stellar contract optimize \
  --wasm target/wasm32v1-none/release/soroban_marketplace.wasm \
  --wasm-out target/wasm32v1-none/release/soroban_marketplace.optimized.wasm
```

---

## 3. Key Error Codes & Types

Soroban contracts return custom error codes defined in [`contracts/soroban-marketplace/src/types.rs`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/contracts/soroban-marketplace/src/types.rs).

| Error Code | Variant Name | Common Trigger Cause |
|---|---|---|
| `#1` | `InvalidCid` | Empty or malformed IPFS CID string |
| `#2` | `InvalidPrice` | Listing/auction price <= 0 |
| `#3` | `ListingNotFound` | Querying non-existent listing ID |
| `#4` | `ListingNotActive` | Attempting action on sold or cancelled listing |
| `#5` | `Unauthorized` | Non-owner attempting seller action |
| `#6` | `CannotBuyOwnListing` | Seller attempting to buy their own listing |
| `#11` | `BidTooLow` | Bid amount below current highest bid or reserve |
| `#15` | `ArtistRevoked` | Revoked artist attempting to list artwork |
| `#22` | `ReentrancyGuard` | Re-entrant call detected |
| `#23` | `ContractPaused` | Operations attempted while circuit breaker active |
| `#25` | `TokenNotWhitelisted` | Payment attempted with non-whitelisted token |

---

## 4. Decision Tree & Diagnostics for Contract Failures

```
                    [ Contract Build or Test Failure ]
                                    │
                                    ▼
                          Inspect Failure Output
                                    │
       ┌────────────────────────────┼────────────────────────────┐
       ▼                            ▼                            ▼
[ Compilation Error ]       [ Test Failure / Assert ]   [ Host / Dependency Error ]
       │                            │                            │
       ▼                            ▼                            ▼
 Check Target & Syntax:       Run with `--nocapture`:      Check `Cargo.toml`:
 1. `rustup target add        `cargo test --               `ed25519-dalek` MUST be
    wasm32v1-none`             --nocapture`                pinned to `=2.2.0` in
 2. Check for missing derive   Inspect exact panic trace   workspace dependencies
    or type mismatch           and contract error code
```

### First Diagnostic Steps for Common Failures

#### Failure 1: Dependency Conflict with `ed25519-dalek`
* **Symptom:** Compilation error mentioning `CryptoRng` or `ed25519-dalek` v3 ABI breaking `soroban-env-host`.
* **Diagnostic Step:** Verify root `Cargo.toml` contains:
  ```toml
  [workspace.dependencies]
  ed25519-dalek = "=2.2.0"
  ```

#### Failure 2: Storage Key Expiration (`HostError`)
* **Symptom:** `HostError: Error(Storage, ExceededRent)` during testing.
* **Diagnostic Step:** Check that tests call `env.storage().persistent().extend_ttl(...)` or `bump_instance_ttl(...)` in [`storage.rs`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/contracts/soroban-marketplace/src/storage.rs).

#### Failure 3: Missing WASM Compilation Target
* **Symptom:** `error[E0463]: can't find crate for std` when targeting WASM.
* **Diagnostic Step:** Run `rustup target add wasm32v1-none` (or `wasm32-unknown-unknown`).

---

## 5. Safe Redaction Guidance

> [!WARNING]
> When testing or deploying contracts locally or to testnet:

- **Do NOT commit private keys** used for signing contract deployment transactions (`STELLAR_SECRET_KEY="S..."`).
- Use test keys generated via `stellar keys generate` for local testing.
- Redact all private keys from log output when posting issues or PRs.
