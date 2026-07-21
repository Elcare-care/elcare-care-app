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

// Event data structs
// Event data structs
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
    /// The actor that triggered the cancellation (may be the artist, admin, or contract).
    pub cancelled_by: Address,
    /// Discriminant indicating the reason for cancellation (Owner, Expired, AdminRevoked).
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

// Add more event structs as needed for other actions
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

/// Emitted when a qualifying late bid triggers the anti-sniping extension rule.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuctionExtendedEvent {
    pub auction_id: u64,
    /// The new end time after the extension has been applied.
    pub new_end_time: u64,
}

impl AuctionExtendedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, AUCTION_EXTENDED),), self);
    }
}

/// Emitted when a creator cancels an auction that has received no bids.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuctionCancelledEvent {
    pub auction_id: u64,
    pub cancelled_by: Address,
}

impl AuctionCancelledEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, AUCTION_CANCELLED),), self);
    }
}

impl ListingUpdatedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, LISTING_UPDATED),), self);
    }
}

/// Emitted when a seller updates the price of an active listing in-place via
/// `update_listing_price`.  Both the old and new price are recorded so that
/// indexers can reconstruct the full price history of every listing.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ListingPriceUpdatedEvent {
    pub listing_id: u64,
    pub old_price: i128,
    pub new_price: i128,
    pub updated_by: Address,
}

/// Emitted when anyone calls `expire_listing` on a genuinely expired listing,
/// transitioning it from Active → Expired/Cancelled.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ListingExpiredEvent {
    pub listing_id: u64,
    pub expired_at: u64,
    pub ledger_sequence: u32,
}

impl ListingPriceUpdatedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, LISTING_PRICE_UPDATED),), self);
    }
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
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminTransferredEvent {
    pub old_admin: Address,
    pub new_admin: Address,
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

// ── Protocol Fee Event ────────────────────────────────────────────────────────
//
// Emitted from every settlement path (buy_artwork, finalize_auction,
// accept_offer) so the treasury's revenue is independently observable
// on-chain without requiring indexer inference.

/// Emitted once per settlement with the exact protocol-fee amount transferred
/// to the treasury.  Carries enough context to identify the originating trade
/// and reconcile treasury balances in real time.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtocolFeeCollectedEvent {
    /// ID of the listing (for buy_artwork / accept_offer) or auction
    /// (for finalize_auction) that generated the fee.
    pub listing_id: u64,
    /// Raw token amount transferred to the treasury.  Zero when no treasury is
    /// configured or when the computed fee rounds down to zero.
    pub amount: i128,
    /// The payment token from which the fee was deducted.
    pub token: Address,
    /// The treasury address that received the fee.
    pub treasury: Address,
}

impl ProtocolFeeCollectedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((soroban_sdk::Symbol::new(env, PROTOCOL_FEE_COLLECTED),), self);
    }
}

// End of events

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
