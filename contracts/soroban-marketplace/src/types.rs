// types.rs
use soroban_sdk::{contracterror, contracttype, Address, Symbol};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum MarketplaceError {
    InvalidCid = 1,
    InvalidPrice = 2,
    ListingNotFound = 3,
    ListingNotActive = 4,
    Unauthorized = 5,
    CannotBuyOwnListing = 6,
    InvalidSplit = 7,
    TooManyRecipients = 8,
    AuctionNotFound = 9,
    AuctionNotActive = 10,
    BidTooLow = 11,
    AuctionExpired = 12,
    AuctionNotExpired = 13,
    AuctionAlreadyFinalized = 14,
    ArtistRevoked = 15,
    OfferNotFound = 16,
    CannotOfferOwnListing = 17,
    OfferNotPending = 18,
    InsufficientOfferAmount = 19,
    ListingSold = 20,
    ListingCancelled = 21,
    ReentrancyGuard = 22,
    ContractPaused = 23,
    /// Royalty bps greater than 10000 (100%) — rejects create_listing/create_auction
    InvalidRoyalty = 24,
    /// Token attempted at purchase time but is no longer whitelisted
    TokenNotWhitelisted = 25,
    /// The sum of all Recipient basis-point values plus the protocol fee exceeds
    /// 10 000 bps (100%).  Rejected at listing creation and on any update that
    /// would mutate recipients, so an invalid split can never be persisted.
    RoyaltyExceedsLimit = 26,
    /// The listing has passed its `expires_at` ledger timestamp and can no
    /// longer be purchased or updated.
    ListingExpired = 27,
    /// `expire_listing` was called on a listing whose `expires_at` is still in
    /// the future (or the listing has no expiry).
    ListingNotExpired = 28,
    /// `finalize_auction` was called before `end_time` has passed.
    AuctionNotEnded = 29,
    /// `cancel_auction` was called on an auction that already has at least one
    /// bid — cancelling would strand the bidder's escrowed funds.
    AuctionHasBids = 30,
    /// `create_auction` was called with an `end_time` (or `duration`) that is in
    /// the past or shorter than `MIN_AUCTION_DURATION`.
    InvalidAuctionDuration = 31,
    /// `place_bid` was called by the auction creator — self-bidding (shill
    /// bidding) is not allowed.  The bidder address must differ from the
    /// auction's `creator` field.
    SelfBidNotAllowed = 32,
    /// An offer state transition was attempted from a terminal state (Accepted,
    /// Rejected, or Withdrawn), or from Pending with the wrong authorizer.
    InvalidOfferState = 33,
    /// `accept_offer` called after the offer's `expires_at` has passed; or
    /// `reclaim_offer` called before expiry / on a non-expiring offer.
    OfferExpired = 34,
    /// A new offer would exceed MAX_OFFERS_PER_LISTING active (Pending) offers
    /// for this listing.  A cap bounds per-listing storage growth and keeps the
    /// auto-reject sweep economically viable.
    OfferLimitReached = 35,
    /// `create_listing` or `create_auction` was called but the marketplace could
    /// not verify that the caller owns `token_id` on the given collection contract.
    /// The call is rejected before any escrow is attempted.
    NotTokenOwner = 36,
    /// A token is already held in escrow for an active listing or auction on this
    /// marketplace.  The same `(collection, token_id)` pair cannot be listed or
    /// auctioned simultaneously — it must be released first via cancel/expire.
    TokenAlreadyEscrowed = 37,
    /// The buyer must not be the listing artist (original creator) or the current
    /// NFT owner.
    SelfPurchaseNotAllowed = 38,
    /// Arithmetic overflow detected during price or fee computation.
    ArithmeticOverflow = 39,
    /// The price falls outside the admin-configured `[min_price, max_price]` bounds.
    PriceOutOfBounds = 40,
    /// `migrate` was called for a version that has already been applied.
    AlreadyMigrated = 41,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ListingStatus {
    Active,
    Sold,
    Cancelled,
}

/// Discriminant carried in the ListingCancelledEvent to indicate why a listing
/// was cancelled.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum CancelReason {
    Owner = 1,
    Expired = 2,
    AdminRevoked = 3,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Recipient {
    pub address: Address,
    /// Share expressed in basis points (0 – 10 000).
    pub percentage: u32,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Listing {
    pub listing_id: u64,
    pub artist: Address,
    pub price: i128,
    pub currency: Symbol,
    pub token: Address,
    pub collection: Address,
    pub token_id: u64,
    pub recipients: soroban_sdk::Vec<Recipient>,
    pub status: ListingStatus,
    pub owner: Option<Address>,
    pub created_at: u32,
    pub protocol_fee_bps: u32,
    pub expires_at: Option<u64>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AuctionStatus {
    Active,
    Finalized,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Auction {
    pub auction_id: u64,
    pub creator: Address,
    pub token: Address,
    pub collection: Address,
    pub token_id: u64,
    pub reserve_price: i128,
    pub highest_bid: i128,
    pub highest_bidder: Option<Address>,
    pub end_time: u64,
    pub status: AuctionStatus,
    pub recipients: soroban_sdk::Vec<Recipient>,
    pub min_increment: i128,
    pub extension_window: u64,
    pub extension_trigger: u64,
    pub protocol_fee_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BidRecord {
    pub bidder: Address,
    pub amount: i128,
    pub ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OfferStatus {
    Pending,
    Accepted,
    Rejected,
    Withdrawn,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Offer {
    pub offer_id: u64,
    pub listing_id: u64,
    pub offerer: Address,
    pub amount: i128,
    pub token: Address,
    pub status: OfferStatus,
    pub created_at: u32,
    pub expires_at: Option<u64>,
}
