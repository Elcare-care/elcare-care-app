// events.rs — Defines all contract event schemas for ELCARE-HUB Marketplace
//
// ── Event Schema Versioning Policy (Issue #278) ─────────────────────────────
//
// The indexer (`indexer/src/event-schemas.ts`) decodes these events from raw
// Soroban XDR using a per-event-type schema registry. The indexer is deployed
// and upgraded independently from these contracts, and must remain able to
// decode historical ledger events forever (raw XDR is replayable via
// `indexer/src/backfill.ts`). That cross-component dependency is why event
// shape changes follow explicit rules rather than being made ad hoc:
//
// 1. Numbering: `EVENT_SCHEMA_VERSION` below applies to the settlement- and
//    audit-critical event structs that carry an explicit `schema_version:
//    u32` field (see the list in `docs/guides/event-parsing.md`). Bump it
//    whenever any of those structs gains a new field. Historical events
//    emitted before the field existed have no `schema_version` in their XDR
//    at all — the indexer treats that absence as implicit version 0.
// 2. Additive-only: existing fields are never renamed, retyped, removed, or
//    given a different meaning. A shape change is always a NEW field
//    appended to the struct. Soroban encodes `#[contracttype]` structs as an
//    ordered map keyed by field name, so appending a field never changes how
//    existing fields decode.
// 3. Numeric encoding is fixed per field once chosen: prices/amounts are
//    `i128`, ledger sequences are `u32`, ids/timestamps are `u64`. Never
//    narrow or widen an existing field's numeric type — add a new field
//    instead of changing one in place.
// 4. Topic naming: topic constants (e.g. `ARTWORK_SOLD`) are permanent once
//    shipped. A new event kind gets a new topic constant; an existing topic
//    is never reused for a differently-shaped payload.
// 5. Deprecation: old struct fields are never mutated or deleted while any
//    historical ledger data referencing them may still need to be replayed.
//    Mark superseded fields as deprecated in a doc comment only.
// 6. Migration for historical records: because the indexer persists decoded
//    JSON and can always fall back to raw XDR, a shape change never requires
//    rewriting historical rows. Instead, the indexer's schema field for the
//    new struct field MUST be marked `optional: true` in `SCHEMA_REGISTRY`
//    (see `indexer/src/event-schemas.ts`) so both pre- and post-bump events
//    decode through the same code path. Full migration guidance and the
//    per-event version catalog live in `docs/guides/event-parsing.md`.

use soroban_sdk::{contracttype, Address, Env, Symbol};

/// Schema version for the explicitly-versioned event structs in this module
/// (those with a `schema_version: u32` field). See the versioning policy
/// above. Bump this — and only this — when one of those structs gains a new
/// field; unversioned event structs are covered by their topic name alone
/// because they have never required a shape change.
pub const EVENT_SCHEMA_VERSION: u32 = 1;

// Versioned event topics as string constants
pub const LISTING_CREATED: &str = "listing_created";
pub const ARTWORK_SOLD: &str = "artwork_sold";
pub const LISTING_CANCELLED: &str = "listing_cancelled";
pub const LISTING_UPDATED: &str = "listing_updated";
pub const BID_PLACED: &str = "bid_placed";
pub const AUCTION_RESOLVED: &str = "auction_resolved";
pub const AUCTION_CREATED: &str = "auction_created";
pub const OFFER_MADE: &str = "offer_made";
pub const OFFER_ACCEPTED: &str = "offer_accepted";
pub const OFFER_REJECTED: &str = "offer_rejected";
pub const OFFER_WITHDRAWN: &str = "offer_withdrawn";
pub const ROYALTY_PAID: &str = "royalty_paid";
pub const ADMIN_TRANSFER_PROPOSED: &str = "admin_transfer_proposed";
pub const ADMIN_TRANSFERRED: &str = "admin_transferred";
pub const ADMIN_PROPOSAL_CANCELLED: &str = "admin_proposal_cancelled";
pub const ARTIST_REVOKED: &str = "artist_revoked";
pub const ARTIST_REINSTATED: &str = "artist_reinstated";
pub const CONTRACT_PAUSED: &str = "contract_paused";
pub const CONTRACT_UNPAUSED: &str = "contract_unpaused";
pub const LISTING_PRICE_UPDATED: &str = "listing_price_updated";
pub const LISTING_EXPIRED: &str = "listing_expired";
pub const AUCTION_EXTENDED: &str = "auction_extended";
pub const AUCTION_CANCELLED: &str = "auction_cancelled";
pub const PROTOCOL_FEE_COLLECTED: &str = "protocol_fee_collected";
pub const OFFER_RECLAIMED: &str = "offer_reclaimed";
pub const NFT_ESCROWED: &str = "nft_escrowed";
pub const NFT_RELEASED: &str = "nft_released";
// Granular pause events (Issue #205)
pub const COLLECTION_PAUSED: &str = "collection_paused";
pub const COLLECTION_UNPAUSED: &str = "collection_unpaused";
pub const FUNCTION_PAUSED: &str = "function_paused";
pub const FUNCTION_UNPAUSED: &str = "function_unpaused";
// Role-based authorization events (Issue #267)
pub const ROLE_TRANSFER_PROPOSED: &str = "role_transfer_proposed";
pub const ROLE_TRANSFERRED: &str = "role_transferred";
pub const ROLE_PROPOSAL_CANCELLED: &str = "role_proposal_cancelled";
pub const ROLE_MIGRATED: &str = "role_migrated";
// Royalty settlement snapshot event (Issue #270)
pub const ROYALTY_SETTLEMENT: &str = "royalty_settlement";
// Auction escrow recovery events (Issue #271)
pub const AUCTION_BID_REFUNDED: &str = "auction_bid_refunded";
pub const AUCTION_ADMIN_CANCELLED: &str = "auction_admin_cancelled";
// Revocation cascade incomplete signal (Issue #214)
pub const REVOCATION_INCOMPLETE: &str = "revocation_incomplete";
// Token whitelist events (Issue #208)
pub const TOKEN_WHITELISTED: &str = "token_whitelisted";
pub const TOKEN_REMOVED: &str = "token_removed";

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ListingCreatedEvent {
    pub listing_id: u64,
    pub artist: Address,
    pub price: i128,
    pub currency: Symbol,
    pub collection: Address,
    pub token_id: u64,
    pub ledger_sequence: u32,
    /// Event schema version (Issue #278). Added additively; absent on
    /// historical pre-upgrade events, which the indexer treats as version 0.
    pub schema_version: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtworkSoldEvent {
    pub listing_id: u64,
    pub artist: Address,
    pub buyer: Address,
    pub price: i128,
    pub currency: Symbol,
    pub ledger_sequence: u32,
    /// Event schema version (Issue #278). Added additively; absent on
    /// historical pre-upgrade events, which the indexer treats as version 0.
    pub schema_version: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ListingCancelledEvent {
    pub listing_id: u64,
    pub cancelled_by: Address,
    pub reason: crate::types::CancelReason,
    pub ledger_sequence: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ListingUpdatedEvent {
    pub listing_id: u64,
    pub artist: Address,
    pub new_price: i128,
    pub collection: Address,
    pub token_id: u64,
    pub ledger_sequence: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuctionCreatedEvent {
    pub auction_id: u64,
    pub creator: Address,
    pub reserve_price: i128,
    pub token: Address,
    pub collection: Address,
    pub token_id: u64,
    pub end_time: u64,
    /// Event schema version (Issue #278). Added additively; absent on
    /// historical pre-upgrade events, which the indexer treats as version 0.
    pub schema_version: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BidPlacedEvent {
    pub auction_id: u64,
    pub bidder: Address,
    pub bid_amount: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuctionFinalizedEvent {
    pub auction_id: u64,
    pub winner: Option<Address>,
    pub amount: i128,
    /// Event schema version (Issue #278). Added additively; absent on
    /// historical pre-upgrade events, which the indexer treats as version 0.
    pub schema_version: u32,
}

impl ListingCreatedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, LISTING_CREATED),), self);
    }
}
impl ArtworkSoldEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, ARTWORK_SOLD),), self);
    }
}
impl ListingCancelledEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, LISTING_CANCELLED),), self);
    }
}
impl AuctionCreatedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, AUCTION_CREATED),), self);
    }
}
impl BidPlacedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, BID_PLACED),), self);
    }
}
impl AuctionFinalizedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, AUCTION_RESOLVED),), self);
    }
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuctionExtendedEvent {
    pub auction_id: u64,
    /// End time before the extension was applied.
    pub prev_end_time: u64,
    pub new_end_time: u64,
    /// Which extension this is (1-based); allows consumers to detect cap proximity.
    pub extension_count: u32,
}
impl AuctionExtendedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, AUCTION_EXTENDED),), self);
    }
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuctionCancelledEvent {
    pub auction_id: u64,
    pub cancelled_by: Address,
    /// Reason code: "owner" | "admin" | "no_bids"
    pub reason: soroban_sdk::Symbol,
}
impl AuctionCancelledEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, AUCTION_CANCELLED),), self);
    }
}

/// Emitted when a losing bidder's escrowed funds are returned.
/// Provides full audit trail for escrow reconciliation. (Issue #271)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuctionBidRefundedEvent {
    pub auction_id: u64,
    pub bidder: Address,
    pub amount: i128,
    pub token: Address,
    /// Reason code: "outbid" | "cancelled" | "admin_cancel"
    pub reason: soroban_sdk::Symbol,
    pub ledger_sequence: u32,
    /// Event schema version (Issue #278). Added additively; absent on
    /// historical pre-upgrade events, which the indexer treats as version 0.
    pub schema_version: u32,
}
impl AuctionBidRefundedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, AUCTION_BID_REFUNDED),), self);
    }
}

/// Emitted when admin force-cancels an active auction, including bids. (Issue #271)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuctionAdminCancelledEvent {
    pub auction_id: u64,
    pub cancelled_by: Address,
    pub refunded_amount: i128,
    pub token: Address,
    pub ledger_sequence: u32,
    /// Event schema version (Issue #278). Added additively; absent on
    /// historical pre-upgrade events, which the indexer treats as version 0.
    pub schema_version: u32,
}
impl AuctionAdminCancelledEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, AUCTION_ADMIN_CANCELLED),), self);
    }
}

/// Emitted at settlement with a snapshot of the normalized recipient list. (Issue #270)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoyaltySettlementEvent {
    /// Listing or auction id.
    pub id: u64,
    /// Normalized recipients at the moment of settlement (read-only snapshot).
    pub recipients: soroban_sdk::Vec<crate::types::Recipient>,
    pub total_amount: i128,
    pub token: Address,
    pub ledger_sequence: u32,
    /// Event schema version (Issue #278). Added additively; absent on
    /// historical pre-upgrade events, which the indexer treats as version 0.
    pub schema_version: u32,
}
impl RoyaltySettlementEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, ROYALTY_SETTLEMENT),), self);
    }
}

/// One `{address, amount}` entry of a settlement breakdown: the exact token
/// amount transferred to `address` during payout distribution. (Issue #201)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecipientPayout {
    pub address: Address,
    pub amount: i128,
}

/// Emitted after all sale transfers complete, carrying the actual amount each
/// recipient received — unlike [`RoyaltySettlementEvent`], which only snapshots
/// the configured bps splits. Recipient payouts (including any collection-level
/// `royalty_info` receiver) sum to `sale_price - protocol_fee_amount`, so the
/// distribution can be audited without replaying the transaction. (Issue #201)
///
/// The whole struct is published as the single event data `Val` under one
/// `royalty_paid` topic; the recipients vector lives in the data field, so the
/// event never exceeds Soroban's topic limits regardless of recipient count.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoyaltyPaidEvent {
    /// Set for `buy_listing` / `accept_offer` settlements.
    pub listing_id: Option<u64>,
    /// Set for `finalize_auction` settlements.
    pub auction_id: Option<u64>,
    pub sale_price: i128,
    pub protocol_fee_amount: i128,
    pub token: Address,
    pub recipients: soroban_sdk::Vec<RecipientPayout>,
    pub ledger_sequence: u32,
}
impl RoyaltyPaidEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, ROYALTY_PAID),), self);
    }
}

/// Emit `royalty_paid` for a completed settlement. Exactly one of `listing_id`
/// / `auction_id` should be `Some`.
#[allow(clippy::too_many_arguments)]
pub fn emit_royalty_paid(
    env: &Env,
    listing_id: Option<u64>,
    auction_id: Option<u64>,
    sale_price: i128,
    protocol_fee_amount: i128,
    token: Address,
    recipients: soroban_sdk::Vec<RecipientPayout>,
) {
    RoyaltyPaidEvent {
        listing_id,
        auction_id,
        sale_price,
        protocol_fee_amount,
        token,
        recipients,
        ledger_sequence: env.ledger().sequence(),
    }
    .publish(env);
}

impl ListingUpdatedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, LISTING_UPDATED),), self);
    }
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ListingPriceUpdatedEvent {
    pub listing_id: u64,
    pub old_price: i128,
    pub new_price: i128,
    pub updated_by: Address,
}
impl ListingPriceUpdatedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((LISTING_PRICE_UPDATED,), self);
    }
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ListingExpiredEvent {
    pub listing_id: u64,
    pub expired_at: u64,
    pub ledger_sequence: u32,
}

impl ListingExpiredEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, LISTING_EXPIRED),), self);
    }
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OfferMadeEvent {
    pub offer_id: u64,
    pub listing_id: u64,
    pub offerer: Address,
    pub amount: i128,
    pub token: Address,
    /// Optional expiry (ledger timestamp) after which the offer can be
    /// reclaimed; `None` when the offer never expires.  Emitted so the indexer
    /// can surface countdown timers without a separate contract read.
    pub expires_at: Option<u64>,
    /// Event schema version (Issue #278). Added additively; absent on
    /// historical pre-upgrade events, which the indexer treats as version 0.
    pub schema_version: u32,
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OfferAcceptedEvent {
    pub offer_id: u64,
    pub listing_id: u64,
    pub offerer: Address,
    pub amount: i128,
    /// Event schema version (Issue #278). Added additively; absent on
    /// historical pre-upgrade events, which the indexer treats as version 0.
    pub schema_version: u32,
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OfferRejectedEvent {
    pub offer_id: u64,
    pub listing_id: u64,
    pub offerer: Address,
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OfferWithdrawnEvent {
    pub offer_id: u64,
    pub listing_id: u64,
    pub offerer: Address,
}

impl OfferMadeEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, OFFER_MADE),), self);
    }
}
impl OfferAcceptedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, OFFER_ACCEPTED),), self);
    }
}
impl OfferRejectedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, OFFER_REJECTED),), self);
    }
}
impl OfferWithdrawnEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, OFFER_WITHDRAWN),), self);
    }
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtistRevokedEvent {
    pub artist: Address,
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtistReinstatedEvent {
    pub artist: Address,
}
impl ArtistRevokedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, ARTIST_REVOKED),), self);
    }
}
impl ArtistReinstatedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, ARTIST_REINSTATED),), self);
    }
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminTransferProposedEvent {
    pub current_admin: Address,
    pub proposed_admin: Address,
    /// Absolute ledger timestamp after which the proposal can no longer be
    /// accepted.  Lets indexers/frontends render a countdown without a
    /// separate view call.
    pub expires_at: u64,
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminTransferredEvent {
    pub old_admin: Address,
    pub new_admin: Address,
}
/// Emitted when the current admin cancels a still-pending admin proposal via
/// `cancel_admin_proposal` before it was accepted or expired.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminProposalCancelledEvent {
    pub current_admin: Address,
    pub cancelled_candidate: Address,
}
impl AdminTransferProposedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, ADMIN_TRANSFER_PROPOSED),), self);
    }
}
impl AdminTransferredEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, ADMIN_TRANSFERRED),), self);
    }
}
impl AdminProposalCancelledEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, ADMIN_PROPOSAL_CANCELLED),), self);
    }
}

// ── Admin-transfer event emitters ─────────────────────────────────────────────
//
// Thin constructors so the contract layer emits admin-rotation events through a
// single, named entry point (Issue #202) instead of building event structs
// inline at each call site.

/// Emit `admin_transfer_proposed` for a newly-created rotation proposal.
pub fn emit_admin_proposed(
    env: &Env,
    current_admin: Address,
    proposed_admin: Address,
    expires_at: u64,
) {
    AdminTransferProposedEvent {
        current_admin,
        proposed_admin,
        expires_at,
    }
    .publish(env);
}

/// Emit `admin_transferred` once a proposal is accepted and authority moves.
pub fn emit_admin_accepted(env: &Env, old_admin: Address, new_admin: Address) {
    AdminTransferredEvent {
        old_admin,
        new_admin,
    }
    .publish(env);
}

/// Emit `admin_proposal_cancelled` when the current admin clears a pending
/// proposal before acceptance/expiry.
pub fn emit_admin_proposal_cancelled(
    env: &Env,
    current_admin: Address,
    cancelled_candidate: Address,
) {
    AdminProposalCancelledEvent {
        current_admin,
        cancelled_candidate,
    }
    .publish(env);
}

// ── Per-collection fee events (Issue #322) ────────────────────────────────────

pub const COLLECTION_FEE_SET: &str = "collection_fee_set";
pub const COLLECTION_FEE_CLEARED: &str = "collection_fee_cleared";

/// Emitted when an admin sets a per-collection protocol fee override.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollectionFeeSetEvent {
    pub collection: Address,
    /// New override value in basis points (0–10 000).
    pub bps: u32,
}

impl CollectionFeeSetEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events()
            .publish((soroban_sdk::Symbol::new(env, COLLECTION_FEE_SET),), self);
    }
}

/// Emitted when an admin clears a per-collection protocol fee override,
/// restoring global-fee fallback behaviour for that collection.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollectionFeeClearedEvent {
    pub collection: Address,
}

impl CollectionFeeClearedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events()
            .publish((soroban_sdk::Symbol::new(env, COLLECTION_FEE_CLEARED),), self);
    }
}

/// Emit `collection_fee_set` for a newly-configured collection-level override.
pub fn emit_collection_fee_set(env: &Env, collection: Address, bps: u32) {
    CollectionFeeSetEvent { collection, bps }.publish(env);
}

/// Emit `collection_fee_cleared` when the admin removes a collection-level
/// override so the collection falls back to the global protocol fee.
pub fn emit_collection_fee_cleared(env: &Env, collection: Address) {
    CollectionFeeClearedEvent { collection }.publish(env);
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtocolFeeCollectedEvent {
    pub listing_id: u64,
    pub amount: i128,
    pub token: Address,
    pub treasury: Address,
    /// Event schema version (Issue #278). Added additively; absent on
    /// historical pre-upgrade events, which the indexer treats as version 0.
    pub schema_version: u32,
}
impl ProtocolFeeCollectedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, PROTOCOL_FEE_COLLECTED),), self);
    }
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OfferReclaimedEvent {
    pub offer_id: u64,
    pub listing_id: u64,
    pub offerer: Address,
    pub amount: i128,
}
impl OfferReclaimedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, OFFER_RECLAIMED),), self);
    }
}

// ── Blocked-bidder Events (Issue #199) ────────────────────────────────────────

/// Emitted when the auction creator or admin adds an address to the auction's
/// blocked-bidder registry.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuctionBidderBlockedEvent {
    pub auction_id: u64,
    pub bidder: Address,
}
impl AuctionBidderBlockedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, AUCTION_BIDDER_BLOCKED),), self);
    }
}

/// Emitted when a previously-blocked address is removed from the auction's
/// blocked-bidder registry.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuctionBidderUnblockedEvent {
    pub auction_id: u64,
    pub bidder: Address,
}
impl AuctionBidderUnblockedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, AUCTION_BIDDER_UNBLOCKED),), self);
    }
}

/// Emit `auction_bidder_blocked` for a newly-registered blocked address.
pub fn emit_bidder_blocked(env: &Env, auction_id: u64, bidder: Address) {
    AuctionBidderBlockedEvent { auction_id, bidder }.publish(env);
}

/// Emit `auction_bidder_unblocked` once an address is removed from the registry.
pub fn emit_bidder_unblocked(env: &Env, auction_id: u64, bidder: Address) {
    AuctionBidderUnblockedEvent { auction_id, bidder }.publish(env);
}

// ── NFT Escrow Events ─────────────────────────────────────────────────────────

/// Emitted when an NFT is pulled into marketplace custody on create_listing /
/// create_auction.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NftEscrowedEvent {
    /// The listing_id or auction_id for which the token is held.
    pub id: u64,
    pub collection: Address,
    pub token_id: u64,
    pub seller: Address,
    pub ledger_sequence: u32,
}
impl NftEscrowedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((NFT_ESCROWED,), self);
    }
}

/// Emitted when an escrowed NFT is released — to a buyer/winner on settlement,
/// or back to the seller/creator on cancellation / expiry / no-bid finalize.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NftReleasedEvent {
    /// The listing_id or auction_id that was holding the token.
    pub id: u64,
    pub collection: Address,
    pub token_id: u64,
    pub recipient: Address,
    pub ledger_sequence: u32,
}
impl NftReleasedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((NFT_RELEASED,), self);
    }
}

// ── Granular pause events (Issue #205) ───────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollectionPausedEvent {
    pub collection: Address,
}
impl CollectionPausedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events()
            .publish((soroban_sdk::Symbol::new(env, COLLECTION_PAUSED),), self);
    }
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollectionUnpausedEvent {
    pub collection: Address,
}
impl CollectionUnpausedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events()
            .publish((soroban_sdk::Symbol::new(env, COLLECTION_UNPAUSED),), self);
    }
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FunctionPausedEvent {
    pub function_name: soroban_sdk::Symbol,
}
impl FunctionPausedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events()
            .publish((soroban_sdk::Symbol::new(env, FUNCTION_PAUSED),), self);
    }
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FunctionUnpausedEvent {
    pub function_name: soroban_sdk::Symbol,
}
impl FunctionUnpausedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events()
            .publish((soroban_sdk::Symbol::new(env, FUNCTION_UNPAUSED),), self);
    }
}

/// Emitted when `revoke_artist` reaches the 100-item cap before finishing the
/// cascade cleanup.  The caller should invoke `revoke_artist` again to continue
/// processing the remaining listings / auctions. (Issue #214)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RevocationIncompleteEvent {
    pub artist: Address,
    /// Number of listings / auctions that still need to be cancelled.
    pub remaining: u64,
    pub ledger_sequence: u32,
}
impl RevocationIncompleteEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events()
            .publish((soroban_sdk::Symbol::new(env, REVOCATION_INCOMPLETE),), self);
    }
}

/// Emit collection_paused event.
pub fn emit_collection_paused(env: &Env, collection: Address) {
    CollectionPausedEvent { collection }.publish(env);
}

/// Emit collection_unpaused event.
pub fn emit_collection_unpaused(env: &Env, collection: Address) {
    CollectionUnpausedEvent { collection }.publish(env);
}

/// Emit function_paused event.
pub fn emit_function_paused(env: &Env, function_name: soroban_sdk::Symbol) {
    FunctionPausedEvent { function_name }.publish(env);
}

/// Emit function_unpaused event.
pub fn emit_function_unpaused(env: &Env, function_name: soroban_sdk::Symbol) {
    FunctionUnpausedEvent { function_name }.publish(env);
}

// ── Role-based authorization events (Issue #267) ─────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoleTransferProposedEvent {
    pub role: crate::types::RoleType,
    pub current_authority: Address,
    pub proposed_authority: Address,
    pub expires_at: u64,
}
impl RoleTransferProposedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events()
            .publish((soroban_sdk::Symbol::new(env, ROLE_TRANSFER_PROPOSED),), self);
    }
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoleTransferredEvent {
    pub role: crate::types::RoleType,
    pub old_authority: Address,
    pub new_authority: Address,
}
impl RoleTransferredEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events()
            .publish((soroban_sdk::Symbol::new(env, ROLE_TRANSFERRED),), self);
    }
}

/// Emitted when the current holder of a role cancels a still-pending
/// transfer proposal before it was accepted or expired.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoleProposalCancelledEvent {
    pub role: crate::types::RoleType,
    pub current_authority: Address,
    pub cancelled_candidate: Address,
}
impl RoleProposalCancelledEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events()
            .publish((soroban_sdk::Symbol::new(env, ROLE_PROPOSAL_CANCELLED),), self);
    }
}

/// Emitted by `migrate_roles` when a previously-unassigned role is given an
/// explicit holder for the first time (single-admin → role-separated
/// migration path, Issue #267).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoleMigratedEvent {
    pub role: crate::types::RoleType,
    pub authority: Address,
}
impl RoleMigratedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events()
            .publish((soroban_sdk::Symbol::new(env, ROLE_MIGRATED),), self);
    }
}

/// Emitted when a token is added to the whitelist (Issue #208).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenWhitelistedEvent {
    pub token: Address,
    pub added_by: Address,
}
impl TokenWhitelistedEvent {
    pub fn publish(self, env: &Env) {
        env.events()
            .publish((soroban_sdk::Symbol::new(env, TOKEN_WHITELISTED),), self);
    }
}

/// Emitted when a token is removed from the whitelist (Issue #208).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenRemovedEvent {
    pub token: Address,
    pub removed_by: Address,
}
impl TokenRemovedEvent {
    pub fn publish(self, env: &Env) {
        env.events()
            .publish((soroban_sdk::Symbol::new(env, TOKEN_REMOVED),), self);
    }
}

/// Emit `role_transfer_proposed` for a newly-created role rotation proposal.
pub fn emit_role_proposed(
    env: &Env,
    role: crate::types::RoleType,
    current_authority: Address,
    proposed_authority: Address,
    expires_at: u64,
) {
    RoleTransferProposedEvent {
        role,
        current_authority,
        proposed_authority,
        expires_at,
    }
    .publish(env);
}

/// Emit `role_transferred` once a role proposal is accepted and authority moves.
pub fn emit_role_accepted(
    env: &Env,
    role: crate::types::RoleType,
    old_authority: Address,
    new_authority: Address,
) {
    RoleTransferredEvent {
        role,
        old_authority,
        new_authority,
    }
    .publish(env);
}

/// Emit `role_proposal_cancelled` when the current holder clears a pending
/// role proposal before acceptance/expiry.
pub fn emit_role_proposal_cancelled(
    env: &Env,
    role: crate::types::RoleType,
    current_authority: Address,
    cancelled_candidate: Address,
) {
    RoleProposalCancelledEvent {
        role,
        current_authority,
        cancelled_candidate,
    }
    .publish(env);
}

/// Emit `token_whitelisted` when a token is added to the whitelist (Issue #208).
pub fn emit_token_whitelisted(env: &Env, token: &Address, added_by: &Address) {
    TokenWhitelistedEvent {
        token: token.clone(),
        added_by: added_by.clone(),
    }
    .publish(env);
}

/// Emit `token_removed` when a token is removed from the whitelist (Issue #208).
pub fn emit_token_removed(env: &Env, token: &Address, removed_by: &Address) {
    TokenRemovedEvent {
        token: token.clone(),
        removed_by: removed_by.clone(),
    }
    .publish(env);
}

/// Emit `role_migrated` when `migrate_roles` assigns an explicit holder to a
/// role that was previously falling back to `Admin`.
pub fn emit_role_migrated(env: &Env, role: crate::types::RoleType, authority: Address) {
    RoleMigratedEvent { role, authority }.publish(env);
}
