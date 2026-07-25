// events.rs — Defines all contract event schemas for ELCARE-HUB Marketplace

use soroban_sdk::{contracttype, Address, Env, Symbol};

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
}
impl RoyaltySettlementEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, ROYALTY_SETTLEMENT),), self);
    }
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
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OfferAcceptedEvent {
    pub offer_id: u64,
    pub listing_id: u64,
    pub offerer: Address,
    pub amount: i128,
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

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtocolFeeCollectedEvent {
    pub listing_id: u64,
    pub amount: i128,
    pub token: Address,
    pub treasury: Address,
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

/// Emit `role_migrated` when `migrate_roles` assigns an explicit holder to a
/// role that was previously falling back to `Admin`.
pub fn emit_role_migrated(env: &Env, role: crate::types::RoleType, authority: Address) {
    RoleMigratedEvent { role, authority }.publish(env);
}
