// events.rs — Defines all contract event schemas for ELCARE-HUB Marketplace

use soroban_sdk::{contracttype, symbol_short, Address, Env, Symbol};

pub const LISTING_CREATED: Symbol = symbol_short!("lst_crtd");
pub const ARTWORK_SOLD: Symbol = symbol_short!("art_sold");
pub const LISTING_CANCELLED: Symbol = symbol_short!("lst_cncl");
pub const LISTING_UPDATED: Symbol = symbol_short!("lst_updt");
pub const BID_PLACED: Symbol = symbol_short!("bid_plcd");
pub const AUCTION_RESOLVED: Symbol = symbol_short!("auc_rslv");
pub const AUCTION_CREATED: Symbol = symbol_short!("auc_crtd");
pub const OFFER_MADE: Symbol = symbol_short!("ofr_made");
pub const OFFER_ACCEPTED: Symbol = symbol_short!("ofr_accp");
pub const OFFER_REJECTED: Symbol = symbol_short!("ofr_rjct");
pub const OFFER_WITHDRAWN: Symbol = symbol_short!("ofr_wdrn");
pub const ROYALTY_PAID: Symbol = symbol_short!("roy_paid");
pub const ADMIN_TRANSFER_PROPOSED: Symbol = symbol_short!("adm_prop");
pub const ADMIN_TRANSFERRED: Symbol = symbol_short!("adm_xfrd");
pub const ARTIST_REVOKED: Symbol = symbol_short!("art_rvkd");
pub const ARTIST_REINSTATED: Symbol = symbol_short!("art_rnst");
pub const CONTRACT_PAUSED: Symbol = symbol_short!("ctr_psd");
pub const CONTRACT_UNPAUSED: Symbol = symbol_short!("ctr_unpsd");
pub const LISTING_PRICE_UPDATED: Symbol = symbol_short!("lst_pru");
pub const LISTING_EXPIRED: Symbol = symbol_short!("lst_expd");
pub const AUCTION_EXTENDED: Symbol = symbol_short!("auc_ext");
pub const AUCTION_CANCELLED: Symbol = symbol_short!("auc_cncl");
pub const PROTOCOL_FEE_COLLECTED: Symbol = symbol_short!("fee_cltd");
pub const OFFER_RECLAIMED: Symbol = symbol_short!("ofr_rclm");
pub const NFT_ESCROWED: Symbol = symbol_short!("nft_escw");
pub const NFT_RELEASED: Symbol = symbol_short!("nft_rels");

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
        env.events().publish((LISTING_CREATED,), self);
    }
}
impl ArtworkSoldEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((ARTWORK_SOLD,), self);
    }
}
impl ListingCancelledEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((LISTING_CANCELLED,), self);
    }
}
impl AuctionCreatedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((AUCTION_CREATED,), self);
    }
}
impl BidPlacedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((BID_PLACED,), self);
    }
}
impl AuctionFinalizedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((AUCTION_RESOLVED,), self);
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
        env.events().publish((AUCTION_EXTENDED,), self);
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
        env.events().publish((AUCTION_CANCELLED,), self);
    }
}

impl ListingUpdatedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((LISTING_UPDATED,), self);
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
        env.events().publish((LISTING_EXPIRED,), self);
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
        env.events().publish((OFFER_MADE,), self);
    }
}
impl OfferAcceptedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((OFFER_ACCEPTED,), self);
    }
}
impl OfferRejectedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((OFFER_REJECTED,), self);
    }
}
impl OfferWithdrawnEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((OFFER_WITHDRAWN,), self);
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
        env.events().publish((ARTIST_REVOKED,), self);
    }
}
impl ArtistReinstatedEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((ARTIST_REINSTATED,), self);
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
        env.events().publish((ADMIN_TRANSFER_PROPOSED,), self);
    }
}
impl AdminTransferredEvent {
    #[allow(deprecated)]
    pub fn publish(self, env: &Env) {
        env.events().publish((ADMIN_TRANSFERRED,), self);
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
        env.events().publish((PROTOCOL_FEE_COLLECTED,), self);
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
        env.events().publish((OFFER_RECLAIMED,), self);
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
