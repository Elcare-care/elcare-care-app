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
    pub new_end_time: u64,
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
