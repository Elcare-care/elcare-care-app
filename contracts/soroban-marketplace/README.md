<div align="center">

# soroban-marketplace

**Core marketplace smart contract for ElcareHub — built with Rust and the Soroban SDK on Stellar.**

</div>

---

## Table of Contents

- [Overview](#overview)
- [Contract Functions](#contract-functions)
- [Data Types](#data-types)
- [Storage Layout](#storage-layout)
- [Error Codes](#error-codes)
- [Prerequisites](#prerequisites)
- [Build](#build)
- [Test](#test)
- [Deploy](#deploy)
- [Manual Invocation](#manual-invocation)

---

## Overview

This contract manages the complete lifecycle of on-chain marketplace listings, auctions, and offers. All state lives in **Soroban persistent storage** — no database is needed for the contract itself. The off-chain indexer reads emitted events to reconstruct a queryable view.

**What the contract handles:**
- NFT listings with multi-recipient royalty splits
- Fixed-price sales with whitelisted token support
- Auctions with reserve prices, bidding, and finalization
- Offer system — make, accept, reject, withdraw
- Protocol fee collection to a configurable treasury
- Admin controls — pause/unpause, token whitelist, artist revocation

---

## Contract Functions

### Listings

| Function | Auth | Description |
|----------|------|-------------|
| `create_listing(artist, metadata_cid, collection, token_id, price, currency, token, recipients)` | artist | Creates a listing, returns `listing_id` |
| `update_listing(artist, listing_id, new_price)` | artist | Updates price of an active listing |
| `cancel_listing(artist, listing_id)` | artist | Cancels an active listing |
| `buy_artwork(buyer, listing_id)` | buyer | Purchases listing, distributes payment + royalties |
| `get_listing(listing_id)` | — | Returns full `Listing` struct |
| `get_total_listings()` | — | Total listing count |
| `get_artist_listings(artist)` | — | `Vec<u64>` of artist's listing IDs |

### Auctions

| Function | Auth | Description |
|----------|------|-------------|
| `create_auction(creator, collection, token_id, reserve_price, token, end_time, recipients)` | creator | Creates an auction |
| `place_bid(bidder, auction_id, bid_amount)` | bidder | Places a bid above the current highest |
| `finalize_auction(auction_id)` | anyone | Finalizes after `end_time` — transfers NFT to winner |
| `cancel_auction(creator, auction_id)` | creator | Cancels with no bids |
| `get_auction(auction_id)` | — | Returns full `Auction` struct |

### Offers

| Function | Auth | Description |
|----------|------|-------------|
| `make_offer(offerer, listing_id, amount, token)` | offerer | Makes an offer on a listing |
| `accept_offer(artist, listing_id, offer_id)` | artist | Accepts an offer, marks listing Sold |
| `reject_offer(artist, listing_id, offer_id)` | artist | Rejects an offer |
| `withdraw_offer(offerer, offer_id)` | offerer | Withdraws a pending offer |

### Admin

| Function | Auth | Description |
|----------|------|-------------|
| `initialize(admin, treasury, fee_bps)` | — | One-time setup |
| `set_admin(new_admin)` | admin | Immediate admin transfer |
| `propose_admin(proposed)` | admin | Step 1 of 2-step transfer |
| `accept_admin()` | proposed | Step 2 of 2-step transfer |
| `pause()` / `unpause()` | admin | Circuit breaker — blocks all state changes |
| `add_token(token)` / `remove_token(token)` | admin | Manage payment token whitelist |
| `revoke_artist(artist)` / `reinstate_artist(artist)` | admin | Artist access control |
| `set_treasury(address)` / `set_fee_bps(bps)` | admin | Update protocol fee config |

---

## Data Types

```rust
pub struct Listing {
    pub listing_id:   u64,
    pub artist:       Address,
    pub metadata_cid: String,        // IPFS CID of artwork metadata JSON
    pub collection:   Address,       // NFT collection contract
    pub token_id:     u64,           // Token ID within the collection
    pub price:        i128,          // in stroops (1 XLM = 10_000_000)
    pub currency:     String,        // "XLM" or token symbol
    pub token:        Address,       // Payment token contract address
    pub recipients:   Vec<Recipient>, // Royalty split
    pub status:       ListingStatus, // Active | Sold | Cancelled
    pub owner:        Option<Address>,
    pub created_at:   u32,           // Ledger sequence number
}

pub struct Recipient {
    pub address:    Address,
    pub percentage: u32,             // Basis points (10000 = 100%)
}

pub enum ListingStatus { Active, Sold, Cancelled }

pub struct Auction {
    pub auction_id:     u64,
    pub creator:        Address,
    pub collection:     Address,
    pub token_id:       u64,
    pub token:          Address,
    pub reserve_price:  i128,
    pub highest_bid:    i128,
    pub highest_bidder: Option<Address>,
    pub end_time:       u64,         // Ledger sequence
    pub status:         AuctionStatus,
    pub recipients:     Vec<Recipient>,
    pub created_at:     u32,
}

pub enum AuctionStatus { Active, Finalized, Cancelled }
```

---

## Storage Layout

```
Persistent key                           Value
──────────────────────────────────────────────────────────────
DataKey::ListingCount                    u64
DataKey::Listing(listing_id: u64)        Listing
DataKey::ArtistListings(Address)         Vec<u64>
DataKey::AuctionCount                    u64
DataKey::Auction(auction_id: u64)        Auction
DataKey::OfferCount                      u64
DataKey::Offer(offer_id: u64)            Offer
DataKey::Admin                           Address
DataKey::ProposedAdmin                   Address
DataKey::Treasury                        Address
DataKey::FeeBps                          u32
DataKey::Paused                          bool
DataKey::TokenWhitelist                  Vec<Address>
DataKey::RevokedArtists                  Vec<Address>
```

All entries use `extend_ttl` on every read/write to maintain a ~30-day TTL.

---

## Error Codes

| Code | Value | Meaning |
|------|-------|---------|
| `ListingNotFound` | 1 | Listing ID does not exist |
| `Unauthorized` | 2 | Caller does not have required auth |
| `ListingNotActive` | 3 | Listing is Sold or Cancelled |
| `CannotBuyOwnListing` | 4 | Artist cannot buy their own listing |
| `InvalidAmount` | 5 | Payment amount mismatch |
| `InvalidCid` | 6 | Empty metadata CID |
| `InvalidPrice` | 7 | Price must be greater than zero |
| `ContractPaused` | 8 | Contract is paused by admin |
| `TokenNotWhitelisted` | 9 | Payment token not on whitelist |
| `ArtistRevoked` | 10 | Artist is not permitted to list |
| `AuctionNotActive` | 11 | Auction is finalized or cancelled |
| `BidTooLow` | 12 | Bid below reserve or current highest |
| `AuctionNotEnded` | 13 | Finalize called before end time |
| `OfferNotFound` | 14 | Offer ID does not exist |

---

## Prerequisites

```bash
# 1. Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32v1-none

# 2. Stellar CLI
cargo install --locked stellar-cli --features opt
```

---

## Build

```bash
make build
# or directly:
cargo build --target wasm32v1-none --release
```

Output: `target/wasm32v1-none/release/soroban_marketplace.wasm`

Optimise WASM size (strips dead code):

```bash
make optimize
# or:
stellar contract optimize --wasm target/wasm32v1-none/release/soroban_marketplace.wasm
```

---

## Test

```bash
make test
# with output:
make test-verbose
# or directly:
cargo test
```

All tests use `Env::default()` with `mock_all_auths()` — no live network or wallet needed.

---

## Deploy

```bash
cd ../../scripts/deploy
./fund_account.sh        # fund test keypair
./deploy_contract.sh     # build + deploy + print CONTRACT_ID
```

---

## Manual Invocation

```bash
# Source deployment env vars
source ../../scripts/deploy/.env.deploy

# Create a listing
stellar contract invoke \
  --id $CONTRACT_ID \
  --source $STELLAR_SECRET \
  --network testnet \
  -- create_listing \
  --artist $STELLAR_PUBLIC \
  --metadata_cid "QmYourIPFSCIDHere" \
  --price 10000000 \
  --currency XLM

# Query total listings
stellar contract invoke \
  --id $CONTRACT_ID \
  --source $STELLAR_SECRET \
  --network testnet \
  -- get_total_listings

# Pause the contract (admin only)
stellar contract invoke \
  --id $CONTRACT_ID \
  --source $ADMIN_SECRET \
  --network testnet \
  -- pause
```
