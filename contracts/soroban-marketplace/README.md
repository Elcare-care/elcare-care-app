<div align="center">

# soroban-marketplace

**Core marketplace smart contract for ElcareHub — built with Rust and the Soroban SDK on Stellar.**

</div>

---

## Table of Contents

- [Overview](#overview)
- [Contract Functions](#contract-functions)
- [Contract Versioning & Migration](#contract-versioning--migration)
- [Price Bounds](#price-bounds)
- [Settlement & Payout Rounding Policy](#settlement--payout-rounding-policy)
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
- Upgradable-contract version discovery via `version()`
- Admin-guarded, idempotent storage migration via `migrate()`
- Global price bounds to prevent dust listings and overflow-risk prices

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
| `simulate_payout(amount, collection, seller, recipients, fee_bps)` | — | Read-only: returns the exact `PayoutPlan` a real settlement for `amount` would produce, using the same rounding policy as `buy_artwork` / `finalize_auction` / `accept_offer`. See [Settlement & Payout Rounding Policy](#settlement--payout-rounding-policy). |

### Auctions

| Function | Auth | Description |
|----------|------|-------------|
| `create_auction(creator, token, collection, token_id, reserve_price, duration, recipients)` | creator | Creates an auction. `duration` must be ≥ `MIN_AUCTION_DURATION` (3 600 s / 1 hour); rejects with `InvalidAuctionDuration` otherwise. |
| `place_bid(bidder, auction_id, bid_amount)` | bidder | Places a bid above the current highest. Appends a `BidRecord` to the bounded on-chain history (capped to `BID_HISTORY_CAP = 20`). |
| `finalize_auction(caller, auction_id)` | anyone | Finalizes after `end_time` — transfers NFT to winner and distributes funds. |
| `cancel_auction(creator, auction_id)` | creator | Cancels a no-bid auction before it ends. |
| `get_auction(auction_id)` | — | Returns full `Auction` struct. |
| `get_auction_bids(auction_id)` | — | Returns the bounded bid history (`Vec<BidRecord>`) in chronological order (oldest → newest). At most `BID_HISTORY_CAP` (20) entries are retained; older bids are evicted. Returns an empty vec when no bids have been placed. |

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
| `pause()` / `unpause()` | admin | Global circuit breaker — see [Pause & Circuit Breakers](#pause--circuit-breakers) for exactly which operations it blocks (fund-recovery/cleanup ops always remain available) |
| `pause_collection(collection)` / `unpause_collection(collection)` | admin | Per-collection circuit breaker — additive restriction layered on top of the global pause |
| `pause_function(function_name)` / `unpause_function(function_name)` | admin | Per-function circuit breaker (`create_listing`, `buy_artwork`, `create_auction`, `place_bid`, `make_offer`) — additive restriction layered on top of the global pause |
| `add_token(token)` / `remove_token(token)` | admin | Manage payment token whitelist |
| `revoke_artist(artist)` / `reinstate_artist(artist)` | admin | Artist access control |
| `set_treasury(address)` / `set_fee_bps(bps)` | admin | Update protocol fee config |
| `version()` | — | Returns the current contract semantic version |
| `migrate(admin)` | admin | Idempotent storage migration for upgrades |
| `set_price_bounds(admin, min, max)` | admin | Set global min/max listing price |
| `get_price_bounds()` | — | Returns `(Option<i128>, Option<i128>)` |

### Pause & Circuit Breakers

Pausing exists to stop *new* risk exposure during an incident — it must not trap
funds or NFTs that are already committed to the contract. There are three
independent, additive pause axes (global, per-collection, per-function); any
active axis blocks the operations it covers. Fund-recovery / cleanup
operations ignore **all three** axes entirely, so users can always get their
funds and NFTs back even while the marketplace is paused.

| Blocked while paused (new exposure) | Always available (fund recovery / cleanup) |
|---|---|
| `create_listing` | `cancel_listing` |
| `update_listing` | `cancel_listings` (batch) |
| `update_listing_price` | `cancel_artist_listings` (admin revocation cleanup) |
| `buy_artwork` | `expire_listing` |
| `create_auction` | `cancel_auction` |
| `place_bid` | `finalize_auction` |
| `make_offer` | `admin_cancel_auction` |
| `accept_offer` | `withdraw_offer` |
| | `reject_offer` |
| | `reclaim_offer` |

All pause checks fail with the single stable `ContractPaused` (23) error
code, so the frontend can map any pause-related rejection to one actionable
message regardless of which axis fired.

---

## Role-Based Authorization (Issue #267)

### Overview

Privileged marketplace control was originally a single `Admin` address with unlimited authority — routine configuration, emergency pause, artist moderation, and irreversible migration all shared one key. That means a compromised or unavailable admin key blocks *every* privileged action, including the emergency pause that would otherwise contain the incident.

The contract now assigns every privileged entry point to exactly one of four **roles**. A role with no explicit holder transparently falls back to whoever holds `Admin`, so **no migration is required** for existing deployments to keep working — role separation is opt-in.

| Role | Scope | Entry points |
|------|-------|--------------|
| `ProtocolConfig` | Routine configuration | `set_price_bounds`, `set_treasury`, `set_protocol_fee`, `set_min_bid_increment`, `set_bid_history_cap`, `set_auction_extension_window`, `set_auction_extension_trigger`, `set_auction_max_extensions`, `add_token_to_whitelist`, `remove_token_from_whitelist` |
| `EmergencyPause` | Incident response | `admin_pause`, `admin_unpause`, `pause_collection`, `unpause_collection`, `pause_function`, `unpause_function`, `admin_cancel_auction` |
| `CollectionAdmin` | Artist/collection moderation | `revoke_artist`, `reinstate_artist`, `cancel_artist_listings` |
| `Upgrade` | Irreversible storage/version migration | `migrate`, `migrate_step` |

`Admin` itself is unchanged: it retains the pre-existing two-step `transfer_admin` / `accept_admin` / `cancel_admin_proposal` flow, and is the implicit holder of any role that hasn't been explicitly assigned.

**Why `EmergencyPause` matters most:** it is deliberately kept independent so an incident responder — e.g. a fast 2-of-3 ops multisig — can still halt the marketplace even if the (potentially slower, more heavily-gated) `ProtocolConfig` authority is unavailable, under dispute, or itself the thing being investigated.

**User fund recovery under pause:** cancelling a listing/auction/offer you own, reclaiming an expired offer, and withdrawing from a resolved auction all check `require_not_paused`/`require_not_paused_ctx` on the *creation* side only — they remain callable while any pause axis (global, per-collection, per-function) is active, so a pause can never trap user funds. See `EVENTS.md` and the granular-pause section above for the full per-operation matrix.

### Role management API

| Function | Auth | Description |
|----------|------|-------------|
| `get_role(role) → Address` | — | Resolves the current holder of `role` (explicit holder, or `Admin` fallback) |
| `propose_role_transfer(current_authority, role, candidate)` | current holder of `role` | Step 1 of 2: propose a new holder (7-day expiry, mirrors `transfer_admin`) |
| `accept_role_transfer(role, candidate)` | proposed candidate | Step 2 of 2: candidate accepts and becomes the explicit holder |
| `cancel_role_proposal(current_authority, role)` | current holder of `role` | Cancel a still-pending proposal before acceptance/expiry |
| `get_pending_role(role) → Option<PendingRoleProposal>` | — | View the pending proposal (candidate + `expires_at`), if any |
| `migrate_roles(admin)` | current `Admin` | One-shot, idempotent: assigns `admin` as the explicit holder of every *unassigned* role — a documented on-ramp for deployments that want distinct role addresses recorded on-chain rather than relying on the implicit fallback |

Every transition emits an event so indexers/frontends never have to poll: `role_transfer_proposed`, `role_transferred`, `role_proposal_cancelled`, `role_migrated` (see `events.rs`).

### Using a multisig or managed account as a role authority

Because every role authority is just a Soroban `Address`, it can be:
- A regular Stellar account key (simplest; equivalent to today's single-admin model).
- A **multisig account** — a Stellar account with multiple signers and a signing threshold, so `require_auth()` for that role succeeds only once enough signers co-sign the invocation.
- A **managed authority contract** — a separate Soroban contract address that implements its own `__check_auth` policy (e.g. an on-chain timelock, an M-of-N contract-signer scheme, or a governance module), so `require_auth()` defers to that contract's custom authorization logic.

**Recommended rollout for an existing single-admin deployment:**
1. Deploy or designate the multisig/managed-account address(es) you want to hold each role (a single shared multisig for all four roles is a reasonable starting point; splitting `EmergencyPause` out to its own faster-signing multisig is recommended once you have one).
2. `propose_role_transfer(current_admin, RoleType::EmergencyPause, emergency_multisig)`, then have the multisig call `accept_role_transfer(RoleType::EmergencyPause, emergency_multisig)`.
3. Repeat per role, or call `migrate_roles(admin)` first to record explicit (admin-held) rows for every role, then transfer each one out individually at your own pace — both paths are safe to interleave since `migrate_roles` never touches a role that already has an explicit holder.
4. Confirm with `get_role(role)` after each step before revoking or rotating the original admin key.

---

## Contract Versioning & Migration

### Overview

The contract implements a discoverable version and a guarded migration path to support forward-compatible upgrades when storage shape changes are introduced.

### `version() → String`

Returns the current **semantic version** of the deployed contract binary (e.g. `"1.0.0"`). This is a constant baked into the WASM — it never changes after deployment. Use it in upgrade scripts to verify you are interacting with the expected binary version before calling `migrate`.

```bash
stellar contract invoke \
  --id $CONTRACT_ID \
  --source $STELLAR_SECRET \
  --network testnet \
  -- version
# → "1.0.0"
```

### `migrate(admin) → ()`

An **admin-guarded, idempotent** entry point reserved for storage migrations.

**How it works:**
1. Requires `admin` authorization and verifies the caller is the stored admin.
2. Looks up a per-version migration marker in persistent storage (`DataKey::MigrationDone("1.0.0")`).
3. If the marker already exists, **reverts with `AlreadyMigrated` (#29)** — this prevents double-application of the same migration.
4. Executes any version-specific storage back-fill logic (see the `contract.rs` source for per-version blocks).
5. Writes the marker to make the migration permanent.

**Idempotency guarantee:** Calling `migrate` twice for the same version always reverts on the second call, regardless of admin changes between calls. The marker is keyed by the version string, not by the admin address.

### Migration policy

| Contract version | Storage changes | Migration notes |
|-----------------|-----------------|-----------------|
| `1.0.0` | None (baseline) | Marker written; future versions back-fill from here |

**Adding a migration for a future version:**
1. Bump `CONTRACT_VERSION` in `contract.rs` to the new semver string.
2. Add a per-version block inside `migrate()`:
   ```rust
   // Inside migrate():
   // if CONTRACT_VERSION == "1.1.0" {
   //     // e.g. back-fill new `min_price` field on existing listings
   // }
   ```
3. Deploy the new WASM and invoke `migrate(admin)` once.

**Upgrade script example:**
```bash
# 1. Deploy new WASM
stellar contract install --wasm target/wasm32v1-none/release/soroban_marketplace.wasm
stellar contract upgrade --id $CONTRACT_ID --wasm-hash $WASM_HASH

# 2. Confirm version
stellar contract invoke --id $CONTRACT_ID -- version
# → "1.1.0"

# 3. Run migration (admin-only, idempotent)
stellar contract invoke --id $CONTRACT_ID --source $ADMIN_SECRET -- migrate --admin $ADMIN_PUBLIC

# 4. Verify migration is marked (second call should fail with AlreadyMigrated)
stellar contract invoke --id $CONTRACT_ID --source $ADMIN_SECRET -- migrate --admin $ADMIN_PUBLIC
# → Error(Contract, #29) AlreadyMigrated — expected
```

---

## Price Bounds

### Overview

Admins can set a global `[min_price, max_price]` range that all new listings and auction reserve prices must fall within. This prevents:
- **Dust listings** — spam listings at price `1` that clog the active index.
- **Overflow-risk prices** — absurdly large prices that could cause integer overflow in payout math.

**Backward compatibility:** Price bounds are enforced only on *new* items created after the bounds are set. Existing listings and auctions are not retroactively affected.

**Permissive defaults:** When no bounds are set (fresh deploy or bounds never configured), all positive prices are accepted — identical to the pre-bounds behavior.

### `set_price_bounds(admin, min, max)`

Sets both the global minimum and maximum price in a single atomic call.

**Validation:**
- `min` and `max` must both be ≥ 0.
- `min` must be ≤ `max`. Violating this reverts with `InvalidPrice` (#2).
- Only the stored admin may call this. Non-admin callers revert with `Unauthorized` (#5).

```bash
# Set min = 10_000 stroops, max = 1_000_000_000_000 stroops
stellar contract invoke \
  --id $CONTRACT_ID \
  --source $ADMIN_SECRET \
  --network testnet \
  -- set_price_bounds \
  --admin $ADMIN_PUBLIC \
  --min 10000 \
  --max 1000000000000
```

### `get_price_bounds() → (Option<i128>, Option<i128>)`

Returns the current `(min_price, max_price)` tuple. `None` means that bound is not configured (no limit in that direction).

```bash
stellar contract invoke \
  --id $CONTRACT_ID \
  --source $STELLAR_SECRET \
  --network testnet \
  -- get_price_bounds
# → (Some(10000), Some(1000000000000))
```

### Enforcement

| Entry point | Check |
|-------------|-------|
| `create_listing` | `price` must be within `[min_price, max_price]` |
| `create_auction` | `reserve_price` must be within `[min_price, max_price]` |

Violations revert with `PriceOutOfBounds` (#30).

---

## Settlement & Payout Rounding Policy

_Issue #269 — hardens settlement arithmetic against rounding and overflow edge cases._

All settlement (`buy_artwork`, `accept_offer`, `finalize_auction`) routes through a single, centralized helper — `calculate_payout_plan` in `contract.rs` — that returns a complete, validated `PayoutPlan` **before any token transfer starts**. `distribute_payout` (the real transfer path) and `simulate_payout` (the read-only preview below) both call this same helper, so the frontend fee display can reproduce the exact on-chain split.

**There is exactly one deterministic rounding policy**, applied in this fixed order:

1. **Royalty** — `royalty_amt = floor(amount * royalty_bps / 10_000)`, computed via checked multiply-then-divide. Skipped when `royalty_bps == 0` or the royalty receiver is the seller. `royalty_bps` is read from the collection contract's `royalty_info()` and is bounds-checked (`<= 10_000`); a misbehaving/malicious collection reporting a higher value reverts with `InvalidRoyalty` (#24) instead of being allowed to compute `royalty_amt > amount`.
2. **Protocol fee** — `fee_amt = floor(remaining * fee_bps / 10_000)`, where `remaining = amount - royalty_amt`, computed independently via checked multiply-then-divide. If no treasury is configured, `fee_amt` is `0` regardless of `fee_bps` (there is nowhere to send it, so none is deducted).
3. **Recipients** — every recipient except the **last** gets `floor(remaining * percentage / 10_000)` (`remaining` after subtracting the fee). **The last recipient in the input list receives whatever is left**: `remaining - sum(previous recipients)`.

**Truncation from basis-point division is deterministically absorbed by the last recipient in insertion order.** Royalty and protocol-fee amounts are computed independently via checked division and are never adjusted for remainder — only the final recipient split absorbs sub-unit truncation. This guarantees `royalty + fee + sum(recipient amounts) == amount` exactly for every input. The last recipient (rather than the seller, creator, or treasury) absorbs the remainder because `recipients: Vec<Recipient>` preserves insertion order from listing/auction creation, so "last recipient" is a stable, deterministic choice requiring no extra state — the same recipient absorbs the remainder every time a given listing/auction settles.

### Worked examples

| Scenario | Inputs | Result |
|----------|--------|--------|
| Small price | `amount=3`, `fee_bps=250` (2.5%), 1 recipient at 10 000 bps, no royalty | `fee = floor(3*250/10000) = 0`; recipient (last) gets `3 - 0 = 3`. Total = `3`. |
| High basis points | `amount=1_000_000`, `royalty_bps=1_000` (10%), `fee_bps=500` (5%), 1 recipient at 9 500 bps | `royalty = 100_000`; `remaining = 900_000`; `fee = 45_000`; `remaining = 855_000`; recipient (last) gets `855_000`. Total = `100_000+45_000+855_000 = 1_000_000`. |
| Multiple recipients | `amount=100`, `fee_bps=0`, no royalty, 3 recipients at 3 334 / 3 333 / 3 333 bps | Recipient 0 = `33`, recipient 1 = `33`, recipient 2 (last) = `100-33-33 = 34` (absorbs remainder). Total = `100`. |

### Overflow and validity guarantees

- Every multiplication/division/addition/subtraction in the payout path uses `checked_*` arithmetic and reverts with `ArithmeticOverflow` (#40) instead of silently wrapping — this includes the protocol-fee computation, which previously used unchecked `*`/`/` and has been hardened to match the royalty/recipient paths.
- `recipients` and `fee_bps` are validated (`validate_recipients`: no zero-bps recipients, no duplicate addresses, `sum(recipient bps) + fee_bps <= 10_000`) both at listing/auction creation time **and again** inside `calculate_payout_plan`, so an invalid combination can never reach the transfer phase regardless of call path.
- Before returning, `calculate_payout_plan` asserts `royalty_amt + fee_amt + sum(recipient amounts) == amount` exactly and reverts with `ArithmeticOverflow` if that ever fails — unreachable given the checked math above, but it is the enforced last line of defense: **no transfer starts from a plan that does not conserve the input amount.**

### `simulate_payout(amount, collection, seller, recipients, fee_bps) → PayoutPlan`

Read-only entry point. Fetches `royalty_info()` from `collection` exactly as the real settlement path does, then runs the same `calculate_payout_plan` helper and returns the resulting plan — no storage mutation, no token transfers. Use this from the frontend to render fee breakdowns that are guaranteed to match what a real purchase would produce.

```rust
pub struct PayoutLeg {
    pub address: Address,
    pub amount:  i128,
}

pub struct PayoutPlan {
    pub royalty:    Option<PayoutLeg>, // None when no royalty applies
    pub fee:        i128,
    pub recipients: Vec<PayoutLeg>,    // last entry absorbs the truncation remainder
    pub total:      i128,              // always == amount
}
```

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

/// A single entry in the per-auction bounded bid history.
pub struct BidRecord {
    pub bidder: Address,   // Account that placed this bid
    pub amount: i128,      // Bid amount in payment-token stroops
    pub ledger: u32,       // Ledger sequence number when the bid was recorded
}

/// See "Settlement & Payout Rounding Policy" above.
pub struct PayoutLeg {
    pub address: Address,
    pub amount:  i128,
}

pub struct PayoutPlan {
    pub royalty:    Option<PayoutLeg>,
    pub fee:        i128,
    pub recipients: Vec<PayoutLeg>,
    pub total:      i128,
}
```

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `MIN_AUCTION_DURATION` | `3_600` seconds (1 hour) | Minimum `duration` accepted by `create_auction`. Auctions shorter than this are rejected with `InvalidAuctionDuration (#31)` to prevent meaningless or front-runnable auctions. |
| `BID_HISTORY_CAP` | `20` entries | Maximum number of `BidRecord` entries retained per auction on-chain. When a new bid is placed and the history is already full, the oldest entry is evicted. Use the off-chain indexer for full bid history beyond this cap. |

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
DataKey::AuctionBids(auction_id: u64)    Vec<BidRecord>  (capped to BID_HISTORY_CAP=20)
DataKey::OfferCount                      u64
DataKey::Offer(offer_id: u64)            Offer
DataKey::Admin                           Address
DataKey::PendingAdmin                    Address
DataKey::Treasury                        Address
DataKey::ProtocolFeeBps                  u32
DataKey::MinBidIncrement                 i128
DataKey::AuctionExtensionWindow          u64
DataKey::AuctionExtensionTrigger         u64
DataKey::IsPaused                        bool
DataKey::TokenWhitelist                  Vec<Address>
DataKey::RevokedArtist(Address)          bool
DataKey::ActiveListings                  Vec<u64>
```

All persistent entries use `extend_ttl` on every read/write (~30-day TTL via `LEDGER_TTL_THRESHOLD = 144_000`, `LEDGER_TTL_BUMP = 432_000`).

---

## Error Codes

| Code | Value | Meaning |
|------|-------|---------|
| `InvalidCid` | 1 | Listing CID validation failure (legacy) |
| `InvalidPrice` | 2 | Price / fee amount is invalid (≤ 0 or > limit) |
| `ListingNotFound` | 3 | Listing ID does not exist |
| `ListingNotActive` | 4 | Listing is Sold or Cancelled |
| `Unauthorized` | 5 | Caller does not have required auth |
| `CannotBuyOwnListing` | 6 | Artist cannot purchase their own listing |
| `InvalidSplit` | 7 | Recipient array is empty |
| `TooManyRecipients` | 8 | More than 4 recipients provided |
| `AuctionNotFound` | 9 | Auction ID does not exist |
| `AuctionNotActive` | 10 | Auction is already finalized or cancelled |
| `BidTooLow` | 11 | Bid below reserve price or min-increment threshold |
| `AuctionExpired` | 12 | Bid placed after `end_time` |
| `AuctionNotExpired` | 13 | (reserved) |
| `AuctionAlreadyFinalized` | 14 | Auction already settled; cannot finalize or cancel again |
| `ArtistRevoked` | 15 | Revoked artist attempted a creation action |
| `OfferNotFound` | 16 | Offer ID does not exist |
| `CannotOfferOwnListing` | 17 | Artist cannot make an offer on their own listing |
| `OfferNotPending` | 18 | Offer is not in Pending state |
| `InsufficientOfferAmount` | 19 | Offer amount ≤ 0 |
| `ListingSold` | 20 | Listing is already sold |
| `ListingCancelled` | 21 | Listing is already cancelled |
| `ReentrancyGuard` | 22 | Re-entrant call detected on the same listing/auction |
| `ContractPaused` | 23 | Contract is paused by admin |
| `InvalidRoyalty` | 24 | Royalty bps > 10 000 |
| `TokenNotWhitelisted` | 25 | Payment token removed from whitelist since listing creation |
| `RoyaltyExceedsLimit` | 26 | Sum of recipient bps + protocol fee > 10 000 |
| `ListingExpired` | 27 | Listing `expires_at` has passed |
| `ListingNotExpired` | 28 | `expire_listing` called before the expiry timestamp |
| `AuctionNotEnded` | 28 | `finalize_auction` called before `end_time` |
| `AuctionHasBids` | 30 | `cancel_auction` called on an auction with an active highest bidder |
| `InvalidAuctionDuration` | 31 | `create_auction` `duration` < `MIN_AUCTION_DURATION` (3 600 s) |
| `SelfBidNotAllowed` | 32 | `place_bid` called by the auction creator (shill-bid prevention) |
| `RoleProposalExpired` | 49 | `accept_role_transfer` called after the role proposal's `expires_at` passed |
| `NoRoleProposalPending` | 50 | `accept_role_transfer` / `cancel_role_proposal` called with no pending proposal for that role |

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

# Query contract version
stellar contract invoke \
  --id $CONTRACT_ID \
  --source $STELLAR_SECRET \
  --network testnet \
  -- version

# Run storage migration (admin only, idempotent)
stellar contract invoke \
  --id $CONTRACT_ID \
  --source $ADMIN_SECRET \
  --network testnet \
  -- migrate \
  --admin $ADMIN_PUBLIC

# Set global price bounds
stellar contract invoke \
  --id $CONTRACT_ID \
  --source $ADMIN_SECRET \
  --network testnet \
  -- set_price_bounds \
  --admin $ADMIN_PUBLIC \
  --min 10000 \
  --max 1000000000000

# Pause the contract (admin only)
stellar contract invoke \
  --id $CONTRACT_ID \
  --source $ADMIN_SECRET \
  --network testnet \
  -- pause
```

---

## Architecture & Debugging Guides

For building WASM, running unit tests, and debugging contract errors, refer to:
- 🏗️ **[Local Architecture](../../docs/guides/local-architecture.md)**
- 🦀 **[Contract Testing Guide](../../docs/guides/contract-testing.md)**
- 🚀 **[Deployment Guide](../../docs/guides/deployment.md)**
- 🛡️ **[Security Triage Guide](../../docs/guides/security-triage.md)**

---

## Security & Authorization (Issue #9)

This section documents every privileged function, the role that governs it, and the intended governance model. Refer to this section when reviewing contract changes, planning upgrades, or responding to incidents.

### Role model

The contract supports four independently-assignable roles in addition to the root `Admin` key. Every role falls back to the `Admin` address when no explicit holder has been assigned, so a freshly-deployed contract works exactly as before. Operators should call `migrate_roles` (or `propose_role_transfer` / `accept_role_transfer`) to separate roles once the deployment is stable.

| Role | `RoleType` variant | Purpose |
|---|---|---|
| **ProtocolConfig** | `RoleType::ProtocolConfig` | Protocol parameters: fees, price bounds, bid increments, auction config, token whitelist, TTL maintenance |
| **EmergencyPause** | `RoleType::EmergencyPause` | Circuit-breakers: global pause, per-collection pause, per-function pause, admin auction cancellation |
| **CollectionAdmin** | `RoleType::CollectionAdmin` | Artist moderation: revoke/reinstate artists, cancel artist listings in bulk |
| **Upgrade** | `RoleType::Upgrade` | Storage migration: `migrate` / `migrate_step` entry points |

All role changes follow a **two-step propose/accept** flow with a **7-day TTL** (same as the admin rotation). A proposal that is not accepted within 7 days can no longer be accepted and must be reissued.

### Authorized callers by function

#### ProtocolConfig role

| Function | Notes |
|---|---|
| `set_protocol_fee(bps)` | Global fee in basis points, max 1 000 (10 %) |
| `set_price_bounds(min, max)` | Global listing price floor and ceiling |
| `set_treasury(address)` | Destination for collected protocol fees |
| `set_min_bid_increment(increment)` | Minimum outbid increment in stroops |
| `set_bid_history_cap(cap)` | Ring-buffer size per auction, 1–200 |
| `set_auction_extension_window(secs)` | Anti-sniping extension duration |
| `set_auction_extension_trigger(secs)` | Window before end-time that triggers extension |
| `set_auction_max_extensions(max)` | Cap on total extensions per auction |
| `set_collection_fee_bps(collection, bps)` | Per-collection fee override, 0–10 000 |
| `clear_collection_fee_bps(collection)` | Remove a per-collection override |
| `add_token_to_whitelist(admin, token)` | Approve a payment token for listings/auctions |
| `remove_token_from_whitelist(token)` | Soft-delete a token from the whitelist |
| `extend_active_ttls(max_items)` | Refresh TTLs for active listings/auctions |
| `cleanup_expired_locks(listing_ids, auction_ids)` | Force-clear stuck reentrancy locks |

#### EmergencyPause role

| Function | Notes |
|---|---|
| `admin_pause()` | Global circuit-breaker — blocks all new-exposure paths |
| `admin_unpause()` | Lifts global pause |
| `pause_collection(collection)` | Blocks new activity for one collection |
| `unpause_collection(collection)` | Lifts per-collection pause |
| `pause_function(name)` | Blocks a single entry-point by name |
| `unpause_function(name)` | Lifts per-function pause |
| `admin_cancel_auction(auction_id)` | Emergency cancellation with bidder refund |

#### CollectionAdmin role

| Function | Notes |
|---|---|
| `revoke_artist(artist)` | Marks artist as revoked; begins cascade cancellation |
| `reinstate_artist(artist)` | Removes revocation; clears cursors |
| `cancel_artist_listings(artist, max_items)` | Resumable sweep to cancel a revoked artist's listings |

#### Upgrade role

| Function | Notes |
|---|---|
| `migrate(admin)` | One-shot unbounded migration to current contract version |
| `migrate_step(admin, max_items)` | Bounded, resumable migration step |

#### Admin only (root key)

These functions require the `Admin` address directly and cannot be delegated to a role:

| Function | Notes |
|---|---|
| `set_admin(admin)` | One-time initialisation; reverts if already set |
| `transfer_admin(current, new)` | Step 1 of admin rotation |
| `accept_admin(new)` | Step 2 of admin rotation |
| `cancel_admin_proposal(current)` | Cancels a pending rotation |
| `migrate_roles(admin)` | Assigns `Admin` as explicit holder of any unset roles |

### Pause state matrix

A pause is designed to stop **new exposure** (new escrow, new payments, new price commitments) while leaving **fund-recovery paths always open** so a paused incident never traps user funds.

| Entry point | Global pause | Collection pause | Function pause |
|---|---|---|---|
| `create_listing` | Blocked | Blocked | Blocked (`"create_listing"`) |
| `buy_artwork` | — | Blocked | Blocked (`"buy_artwork"`) |
| `create_auction` | — | Blocked | Blocked (`"create_auction"`) |
| `place_bid` | — | Blocked | Blocked (`"place_bid"`) |
| `make_offer` | — | Blocked | Blocked (`"make_offer"`) |
| `accept_offer` | Blocked | — | — |
| `update_listing` | Blocked | — | — |
| `update_listing_price` | Blocked | — | — |
| **`cancel_listing`** | Always open | Always open | Always open |
| **`cancel_listings`** | Always open | Always open | Always open |
| **`finalize_auction`** | Always open | Always open | Always open |
| **`cancel_auction`** | Always open | Always open | Always open |
| **`admin_cancel_auction`** | Always open | Always open | Always open |
| **`withdraw_offer`** | Always open | Always open | Always open |
| **`reject_offer`** | Always open | Always open | Always open |
| **`reclaim_offer`** | Always open | Always open | Always open |

### Reentrancy protection

Three entry-points acquire a per-resource RAII lock in Soroban **temporary storage** (`REENTRANCY_LOCK_TTL` ledgers):

- `buy_artwork` — `ListingLock(listing_id)`
- `accept_offer` — `ListingLock(listing_id)` (acquired before any state change)
- `finalize_auction` — `AuctionLock(auction_id)`

Locks are released automatically by `Drop`. A Soroban panic rolls back all writes (including the lock write), so a stuck lock is only possible in the rare case of a node crash mid-transaction. Use `cleanup_expired_locks` (ProtocolConfig role) to manually clear any that are spotted off-chain.

### Emergency procedures

#### Halt all new activity immediately

```bash
soroban contract invoke --id <CONTRACT> --fn admin_pause -- --admin <EMERGENCY_PAUSE_KEY>
```

#### Halt activity for one compromised collection

```bash
soroban contract invoke --id <CONTRACT> --fn pause_collection \
  -- --admin <EMERGENCY_PAUSE_KEY> --collection <COLLECTION_ADDRESS>
```

#### Cancel an auction with a live bid

```bash
soroban contract invoke --id <CONTRACT> --fn admin_cancel_auction \
  -- --admin <EMERGENCY_PAUSE_KEY> --auction_id <ID>
```

This refunds the current highest bidder before marking the auction cancelled.

#### Revoke a bad actor artist

```bash
# Step 1: revoke (cascades up to 100 listings/auctions per call)
soroban contract invoke --id <CONTRACT> --fn revoke_artist \
  -- --artist <ARTIST_ADDRESS>

# Step 2: continue cascade if RevocationIncompleteEvent was emitted
soroban contract invoke --id <CONTRACT> --fn cancel_artist_listings \
  -- --admin <COLLECTION_ADMIN_KEY> --artist <ARTIST_ADDRESS> --max_items 50
```

#### Transfer the ProtocolConfig role to a multisig

```bash
# Propose (current holder)
soroban contract invoke --id <CONTRACT> --fn propose_role_transfer \
  -- --current_authority <CURRENT_KEY> --role ProtocolConfig --candidate <MULTISIG_ADDRESS>

# Accept (new holder, within 7 days)
soroban contract invoke --id <CONTRACT> --fn accept_role_transfer \
  -- --role ProtocolConfig --candidate <MULTISIG_ADDRESS>
```

### Security properties guaranteed by design

1. **No single point of failure post-migration**: After `migrate_roles`, each role can be on a separate key or multisig. The `EmergencyPause` role can pause the marketplace even if `ProtocolConfig` or `Admin` keys are unavailable.
2. **All admin/role changes are on-chain and auditable**: Every rotation emits a typed event (`RoleTransferProposedEvent`, `RoleTransferredEvent`, `AdminTransferredEvent`, etc.) that the indexer records.
3. **Fee configuration is non-custodial**: `set_protocol_fee` only affects _future_ listings and auctions. Already-running listings snapshot the fee at creation time (`protocol_fee_bps` field on `Listing`/`Auction`), so a fee change never retroactively alters live deals.
4. **Per-collection fee overrides require ProtocolConfig, not raw admin**: As of the Issue #9 fix, `set_collection_fee_bps` and `clear_collection_fee_bps` use `require_role(ProtocolConfig)` — the ProtocolConfig role holder can manage fees independently of the Admin key.
5. **Token whitelist changes require ProtocolConfig**: `add_token_to_whitelist` now takes an explicit `admin: Address` parameter and calls `require_role(ProtocolConfig)`, consistent with `remove_token_from_whitelist`.
