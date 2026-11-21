# Soroban Marketplace Event Catalog

This document serves as the definitive catalog of all events emitted by the `soroban-marketplace` smart contract.

## Event Definitions

The JSON block below defines the exact topics and data schemas for all events. It is automatically parsed by the indexer's CI tests to ensure parser completeness.

```json
{
  "LISTING_CREATED": {
    "topic": "listing_created",
    "data_schema": {
      "listing_id": "u64",
      "artist": "Address",
      "price": "i128",
      "currency": "Symbol",
      "collection": "Address",
      "token_id": "u64",
      "ledger_sequence": "u32"
    }
  },
  "ARTWORK_SOLD": {
    "topic": "artwork_sold",
    "data_schema": {
      "listing_id": "u64",
      "artist": "Address",
      "buyer": "Address",
      "price": "i128",
      "currency": "Symbol",
      "ledger_sequence": "u32"
    }
  },
  "LISTING_CANCELLED": {
    "topic": "listing_cancelled",
    "data_schema": {
      "listing_id": "u64",
      "cancelled_by": "Address",
      "reason": "CancelReason",
      "ledger_sequence": "u32"
    }
  },
  "LISTING_UPDATED": {
    "topic": "listing_updated",
    "data_schema": {
      "listing_id": "u64",
      "artist": "Address",
      "new_price": "i128",
      "collection": "Address",
      "token_id": "u64",
      "ledger_sequence": "u32"
    }
  },
  "BID_PLACED": {
    "topic": "bid_placed",
    "data_schema": {
      "auction_id": "u64",
      "bidder": "Address",
      "bid_amount": "i128",
      "effective_end_time": "u64"
    }
  },
  "AUCTION_RESOLVED": {
    "topic": "auction_resolved",
    "data_schema": {
      "auction_id": "u64",
      "winner": "Option<Address>",
      "amount": "i128"
    }
  },
  "AUCTION_CREATED": {
    "topic": "auction_created",
    "data_schema": {
      "auction_id": "u64",
      "creator": "Address",
      "reserve_price": "i128",
      "token": "Address",
      "collection": "Address",
      "token_id": "u64",
      "end_time": "u64"
    }
  },
  "OFFER_MADE": {
    "topic": "offer_made",
    "data_schema": {
      "offer_id": "u64",
      "listing_id": "u64",
      "offerer": "Address",
      "amount": "i128",
      "token": "Address"
    }
  },
  "OFFER_ACCEPTED": {
    "topic": "offer_accepted",
    "data_schema": {
      "offer_id": "u64",
      "listing_id": "u64",
      "offerer": "Address",
      "amount": "i128"
    }
  },
  "OFFER_REJECTED": {
    "topic": "offer_rejected",
    "data_schema": {
      "offer_id": "u64",
      "listing_id": "u64",
      "offerer": "Address"
    }
  },
  "OFFER_WITHDRAWN": {
    "topic": "offer_withdrawn",
    "data_schema": {
      "offer_id": "u64",
      "listing_id": "u64",
      "offerer": "Address"
    }
  },
  "ROYALTY_PAID": {
    "topic": "royalty_paid",
    "data_schema": {
      "listing_id": "Option<u64>",
      "auction_id": "Option<u64>",
      "sale_price": "i128",
      "protocol_fee_amount": "i128",
      "token": "Address",
      "recipients": "Vec<RecipientPayout>",
      "ledger_sequence": "u32"
    }
  },
  "ADMIN_TRANSFER_PROPOSED": {
    "topic": "admin_transfer_proposed",
    "data_schema": {
      "current_admin": "Address",
      "proposed_admin": "Address",
      "expires_at": "u64"
    }
  },
  "ADMIN_TRANSFERRED": {
    "topic": "admin_transferred",
    "data_schema": {
      "old_admin": "Address",
      "new_admin": "Address"
    }
  },
  "ARTIST_REVOKED": {
    "topic": "artist_revoked",
    "data_schema": {
      "artist": "Address"
    }
  },
  "ARTIST_REINSTATED": {
    "topic": "artist_reinstated",
    "data_schema": {
      "artist": "Address"
    }
  },
  "CONTRACT_PAUSED": {
    "topic": "contract_paused",
    "data_schema": {
      "paused_by": "Option<Address>"
    }
  },
  "CONTRACT_UNPAUSED": {
    "topic": "contract_unpaused",
    "data_schema": {
      "unpaused_by": "Option<Address>"
    }
  },
  "COLLECTION_PAUSED": {
    "topic": "collection_paused",
    "data_schema": {
      "collection": "Address"
    }
  },
  "COLLECTION_UNPAUSED": {
    "topic": "collection_unpaused",
    "data_schema": {
      "collection": "Address"
    }
  },
  "FUNCTION_PAUSED": {
    "topic": "function_paused",
    "data_schema": {
      "function_name": "Symbol"
    }
  },
  "FUNCTION_UNPAUSED": {
    "topic": "function_unpaused",
    "data_schema": {
      "function_name": "Symbol"
    }
  },
  "LISTING_PRICE_UPDATED": {
    "topic": "listing_price_updated",
    "data_schema": {
      "listing_id": "u64",
      "old_price": "i128",
      "new_price": "i128",
      "updated_by": "Address"
    }
  },
  "LISTING_EXPIRED": {
    "topic": "listing_expired",
    "data_schema": {
      "listing_id": "u64",
      "expired_at": "u64",
      "ledger_sequence": "u32"
    }
  },
  "AUCTION_EXTENDED": {
    "topic": "auction_extended",
    "data_schema": {
      "auction_id": "u64",
      "prev_end_time": "u64",
      "new_end_time": "u64",
      "extension_count": "u32"
    }
  },
  "AUCTION_CANCELLED": {
    "topic": "auction_cancelled",
    "data_schema": {
      "auction_id": "u64",
      "cancelled_by": "Address",
      "reason": "AuctionCancelReason",
      "escrow_amount": "i128",
      "token": "Address",
      "ledger_sequence": "u32",
      "schema_version": "u32"
    }
  },
  "PROTOCOL_FEE_COLLECTED": {
    "topic": "protocol_fee_collected",
    "data_schema": {
      "listing_id": "u64",
      "amount": "i128",
      "token": "Address",
      "treasury": "Address"
    }
  },
  "OFFER_RECLAIMED": {
    "topic": "offer_reclaimed",
    "data_schema": {
      "offer_id": "u64",
      "listing_id": "u64",
      "offerer": "Address",
      "amount": "i128"
    }
  },
  "ROLE_TRANSFER_PROPOSED": {
    "topic": "role_transfer_proposed",
    "data_schema": {
      "role": "RoleType",
      "current_authority": "Address",
      "proposed_authority": "Address",
      "expires_at": "u64"
    }
  },
  "ROLE_TRANSFERRED": {
    "topic": "role_transferred",
    "data_schema": {
      "role": "RoleType",
      "old_authority": "Address",
      "new_authority": "Address"
    }
  },
  "ROLE_PROPOSAL_CANCELLED": {
    "topic": "role_proposal_cancelled",
    "data_schema": {
      "role": "RoleType",
      "current_authority": "Address",
      "cancelled_candidate": "Address"
    }
  },
  "ROLE_MIGRATED": {
    "topic": "role_migrated",
    "data_schema": {
      "role": "RoleType",
      "authority": "Address"
    }
  }
}
```

---

## Detailed Event Semantics & Edge Cases

### 1. Auction Extension (`AUCTION_EXTENDED`) — Issue #1085
Emitted when a qualifying bid is accepted within the active `extension_trigger` window and neither `max_extensions` nor `MAX_TOTAL_AUCTION_DURATION` (30 days) is exceeded.
* **Topic**: `auction_extended`
* **Payload Fields**:
  * `auction_id`: Target auction identifier (`u64`).
  * `prev_end_time`: Expiration timestamp prior to this extension (`u64`).
  * `new_end_time`: New extended timestamp (`now + extension_window`) (`u64`).
  * `extension_count`: Monotonically increasing counter (1-based) indicating total extensions applied (`u32`).
* **Suppression Semantics**:
  * If a bid arrives inside the trigger window but `extension_count >= max_extensions` (when `max_extensions > 0`), the bid is accepted, but no `auction_extended` event is emitted.
  * If the proposed end time exceeds `original_end_time + 2_592_000`, the bid is accepted, but extension is suppressed and no `auction_extended` event is emitted.
  * If `now >= end_time`, the transaction reverts with `AuctionExpired` (#9) before reaching event emission.

### 2. Bid History Retention & Event Stream (`BID_PLACED`) — Issue #1084
* **Topic**: `bid_placed`
* **Payload Fields**:
  * `auction_id`: Target auction identifier (`u64`).
  * `bidder`: Address of the successful bidder (`Address`).
  * `bid_amount`: Amount placed in the payment token (`i128`).
  * `effective_end_time`: The active end time of the auction after this bid (`u64`).
* **On-Chain Storage vs. Event Stream**:
  * Every valid bid emits a `bid_placed` event to the ledger stream.
  * On-chain state retains at most `bid_history_cap` records (default 50, range 1–200, commonly configured to 20 in UI fixtures) in a FIFO ring buffer.
  * When capacity is reached, the oldest record at index 0 is evicted. The on-chain list queryable via `get_auction_bids(auction_id)` maintains strict chronological monotonicity (oldest retained to newest).

### 3. Reserve Price & Finalization Distinction — Issue #1086
* **Outcome A: Reserve Met / Winning Settlement**:
  * Emits `AUCTION_RESOLVED` (`auction_resolved`): carries `winner: Some(winner_address)` and `amount: winning_bid`.
  * Emits `PROTOCOL_FEE_COLLECTED`, `ROYALTY_SETTLEMENT`, and royalty breakdown.
  * NFT custody transferred to winner.
* **Outcome B: Reserve Not Met / Zero Bids**:
  * When an auction expires without receiving any bids meeting `reserve_price`:
  * Emits `AUCTION_RESOLVED` (`auction_resolved`) with `winner: None` and `amount: 0`.
  * Emits `AUCTION_CANCELLED` (`auction_cancelled`) with `reason: AuctionCancelReason::Owner` and `escrow_amount: 0`.
  * No fee or payout events are emitted.
  * NFT custody safely returned to creator.

### 4. Auction Cancellation & Custody Cleanup — Issue #1087
* **Creator Cancel (`cancel_auction`)**:
  * Callable only on Active auctions with zero bids.
  * Emits `AUCTION_CANCELLED` with `reason: AuctionCancelReason::Owner`, `escrow_amount: 0`.
* **Admin / Emergency Cancel (`admin_cancel_auction`)**:
  * Callable with or without active bids.
  * When bids exist: refunds 100% of the leading bid to `highest_bidder`, marks `mark_bid_refunded` (blocking double refund), emits `AUCTION_BID_REFUNDED`, emits `AUCTION_CANCELLED` with `reason: Admin` or `Emergency` and `escrow_amount = refunded_amount`, and emits `AUCTION_ADMIN_CANCELLED`.
  * In both paths, NFT custody is returned to creator, leaving zero residual escrow in the contract.

### 5. Offer Lifecycle State Matrix & Event Flow — Issue #1088

The contract implements a formal state machine for offers via `OfferStatus` (`types.rs`) and entry points in `contract.rs`. Escrowed payment tokens are held by the marketplace contract until terminal resolution.

#### Offer State Fields
* `offer_id`: Unique monotonic identifier (`u64`).
* `listing_id`: Target marketplace listing (`u64`).
* `offerer`: Address of the prospective buyer (`Address`).
* `amount`: Escrowed payment token amount in base units (`i128`).
* `token`: Whitelisted SAC payment token address (`Address`).
* `status`: Current state (`OfferStatus`: `Pending`, `Accepted`, `Rejected`, `Withdrawn`, `Expired`).
* `created_at`: Ledger sequence number when created (`u32`).
* `expires_at`: Optional expiration timestamp in seconds (`Option<u64>`).

#### State Transition Matrix

| Initial State | Transition Action | Entry Point | Required Auth | Preconditions & Guard Checks | Target State | Escrow & Custody Action | Emitted Event(s) |
|:---|:---|:---|:---|:---|:---|:---|:---|
| *(None)* | **Create** | `make_offer` | `offerer` | Listing Active, `offerer != artist`, `amount > 0`, token whitelisted, pending count $< 30$ | `Pending` | Transfers `amount` from `offerer` to contract escrow | `OFFER_MADE` (`offer_made`) |
| `Pending` | **Accept** | `accept_offer` | `artist` | Listing Active, `now < expires_at`, `now < listing.expires_at`, token active in policy engine | `Accepted` | 1. Payout split to royalty, treasury, seller<br>2. NFT transferred to `offerer`<br>3. Siblings refunded | `OFFER_ACCEPTED` (`offer_accepted`), `OFFER_REJECTED` (`offer_rejected`) for siblings, `PROTOCOL_FEE_COLLECTED`, `ROYALTY_SETTLEMENT` |
| `Pending` | **Reject** | `reject_offer` | `artist` | Listing exists, `artist == caller`, offer is `Pending` | `Rejected` | Full `amount` refunded from contract to `offerer` | `OFFER_REJECTED` (`offer_rejected`) |
| `Pending` | **Withdraw** | `withdraw_offer` | `offerer` | `offerer == caller`, offer is `Pending` | `Withdrawn` | Full `amount` refunded from contract to `offerer` | `OFFER_WITHDRAWN` (`offer_withdrawn`) |
| `Pending` | **Reclaim** | `reclaim_offer` | None (Public) | Offer is `Pending`, `expires_at.is_some()`, `now >= expires_at` | `Withdrawn` | Full `amount` refunded from contract to `offerer` | `OFFER_RECLAIMED` (`offer_reclaimed`) |
| `Pending` | **Sweep** | `sweep_expired_offers` | None (Batch) | Batch size $\le 20$, offer is `Pending`, `now >= expires_at` | `Expired` | Full `amount` refunded from contract to `offerer` | `OFFER_EXPIRED_SWEEP` (`offer_expired_sweep`) |
| `Pending` | **Counter** | `counter_offer` | `artist` | `artist == caller`, offer is `Pending`, `amount > 0` | `Rejected` (parent) | Parent escrow refunded to `offerer`; new counter-offer created | `OFFER_COUNTERED` (`offer_countered`), `OFFER_MADE` (`offer_made`) |
| `Accepted` | *(Any)* | `*` | Any | None | *(Terminal)* | None | Reverts with `InvalidOfferState` (`#33`) |
| `Rejected` | *(Any)* | `*` | Any | None | *(Terminal)* | None | Reverts with `InvalidOfferState` (`#33`) |
| `Withdrawn` | *(Any)* | `*` | Any | None | *(Terminal)* | None | Reverts with `InvalidOfferState` (`#33`) |
| `Expired` | *(Any)* | `*` | Any | None | *(Terminal)* | None | Reverts with `InvalidOfferState` (`#33`) |

#### Reentrancy & Pause Safety
* **Reentrancy**: `accept_offer` acquires `ListingLock(listing_id)` via RAII guard `ListingReentrancyScope` before modifying state or performing token/NFT transfers. Reentrant callbacks revert with `ReentrancyGuard` (`#22`).
* **Emergency Pause Bypass**: User fund recovery entry points (`withdraw_offer`, `reject_offer`, `reclaim_offer`) bypass all pause controls (global, per-collection, per-function), guaranteeing buyers and artists can always retrieve escrowed funds during an incident.
* **Checks-Effects-Interactions (CEI)**: Every transition updates and commits `offer.status` in persistent storage before invoking `TokenClient::transfer`.

---

## Event Schema Discrepancy Audit (Issue — Event Naming Drift)

This section records every drift found between `events.rs`, this document, and
the indexer's `event-schemas.ts` / `parser.ts`, and documents the resolution.

### Changes made in this audit

| Event | Location | Drift found | Resolution |
|---|---|---|---|
| `ROYALTY_PAID` | `EVENTS.md` JSON block | Schema showed `{listing_id, artist, amount, token}`. Rust struct is `RoyaltyPaidEvent {listing_id?, auction_id?, sale_price, protocol_fee_amount, token, recipients, ledger_sequence}`. | EVENTS.md updated to match Rust struct. |
| `BID_PLACED` | `EVENTS.md` JSON block | Missing `effective_end_time: u64` field (added in Issue #468, present in Rust struct and indexer schema). | Field added to EVENTS.md schema. |
| `AUCTION_EXTENDED` | `EVENTS.md` JSON block | Only listed `auction_id` and `new_end_time`. Rust struct also carries `prev_end_time: u64` and `extension_count: u32`. | Both fields added to EVENTS.md schema. |
| `AUCTION_CANCELLED` | `EVENTS.md` JSON block | Only listed `auction_id` and `cancelled_by`. Rust struct `AuctionCancelledEvent` also carries `reason`, `escrow_amount`, `token`, `ledger_sequence`, `schema_version`. | Full schema added to EVENTS.md. |
| `ADMIN_TRANSFER_PROPOSED` | `EVENTS.md` JSON block | Missing `expires_at: u64` field (added in Issue #202, present in Rust struct and indexer schema). | Field added to EVENTS.md schema. |
| `CONTRACT_PAUSED` / `CONTRACT_UNPAUSED` | `EVENTS.md` JSON block | Showed empty `data_schema: {}`. Rust emits `paused_by: Option<Address>` and `unpaused_by: Option<Address>`. | Corrected to `Option<Address>` fields. |
| Long-form topic strings | `parser.ts` TOPIC_MAP | 30+ topics emitted by the current contract build (listing_updated, listing_cancelled, bid_placed, offer_rejected, offer_withdrawn, royalty_paid, role_*, function_pause, admin events, etc.) had no TOPIC_MAP entry and were silently dropped by the indexer parser. | All missing long-form topic strings added to TOPIC_MAP in `parser.ts`. |
| Role events | `event-schemas.ts` SCHEMA_REGISTRY | `ROLE_TRANSFER_PROPOSED`, `ROLE_TRANSFERRED`, `ROLE_PROPOSAL_CANCELLED`, `ROLE_MIGRATED`, `ROLE_PROPOSAL_OVERWRITTEN` had no schema and were not registered. | Schemas defined and registered in `event-schemas.ts`. |
| `FUNCTION_PAUSED` / `FUNCTION_UNPAUSED` | `event-schemas.ts` SCHEMA_REGISTRY | Schemas were defined in `event-schemas.ts` but were not registered in `SCHEMA_REGISTRY`. | Added to registry. |
| `LISTING_PRICE_UPDATED` | `event-schemas.ts` SCHEMA_REGISTRY | Schema was defined but not registered in `SCHEMA_REGISTRY`. | Added to registry. |

### Field-name cross-reference (events.rs ↔ EVENTS.md ↔ indexer)

The table below records the canonical field names from `events.rs` for the
role events, which must be used consistently in `EVENTS.md`, `event-schemas.ts`,
and any consumer of raw XDR.

| Event struct (events.rs) | Field | Type |
|---|---|---|
| `RoleTransferProposedEvent` | `role` | `RoleType` (enum → string tag) |
| | `current_authority` | `Address` |
| | `proposed_authority` | `Address` |
| | `expires_at` | `u64` |
| `RoleTransferredEvent` | `role` | `RoleType` |
| | `old_authority` | `Address` |
| | `new_authority` | `Address` |
| | `ledger_sequence` | `u32` |
| `RoleProposalCancelledEvent` | `role` | `RoleType` |
| | `current_authority` | `Address` |
| | `cancelled_candidate` | `Address` |
| | `ledger_sequence` | `u32` |
| `RoleMigratedEvent` | `role` | `RoleType` |
| | `authority` | `Address` |
| `RoleProposalOverwrittenEvent` | `role` | `RoleType` |
| | `current_authority` | `Address` |
| | `old_candidate` | `Address` |
| | `old_expires_at` | `u64` |
| | `new_candidate` | `Address` |
| | `new_expires_at` | `u64` |
| | `ledger_sequence` | `u32` |
