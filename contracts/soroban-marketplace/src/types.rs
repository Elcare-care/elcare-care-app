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
    /// `cancel_listings` was called with more ids than MAX_BATCH_CANCEL in a
    /// single batch — split the request into smaller batches.
    BatchTooLarge = 36,
    /// `migrate` was called again for a version whose migration marker is
    /// already recorded in persistent storage.
    AlreadyMigrated = 37,
    /// `purchase` was attempted by the listing's own artist (or a recipient of
    /// the listing) — self-purchase is not allowed.
    SelfPurchaseNotAllowed = 38,
    /// A listing price violates the configured `[min, max]` price bounds.
    PriceOutOfBounds = 39,
    /// A checked arithmetic operation overflowed while computing fee splits.
    ArithmeticOverflow = 40,
    /// `accept_admin` was called after the pending admin proposal's `expires_at`
    /// ledger timestamp has passed.  The proposal must be re-issued.
    ///
    /// NOTE: Issue #202 suggested discriminant 35, but 35/36 are already taken
    /// (`OfferLimitReached`/`BatchTooLarge`); the next free codes 41/42 are used
    /// instead so existing on-chain error codes are not renumbered.
    AdminProposalExpired = 41,
    /// `accept_admin` or `cancel_admin_proposal` was called when no admin
    /// proposal is currently pending.
    NoAdminProposalPending = 42,
    /// A royalty `Recipient` has a `percentage` of zero basis points.
    /// Every recipient in the list must contribute a non-zero share so that
    /// the list cannot contain dead-weight entries that waste gas on every
    /// settlement.
    ZeroRecipientBps = 43,
    /// The recipient list contains a duplicate address.  Each address may
    /// appear at most once so payouts are unambiguous and the total bps
    /// calculation cannot be confused by double-counting.
    DuplicateRecipient = 44,
    /// `admin_cancel_auction` was called on an auction that is not Active, or
    /// `refund_losing_bid` was called on an auction that is not in a state
    /// that permits refunds.
    InvalidAuctionState = 45,
    /// A bidder attempted to call `refund_losing_bid` for an auction where
    /// they are the current highest bidder (their funds are still locked as
    /// the winning escrow) or they have no bid to refund.
    NoBidToRefund = 46,
    /// The anti-sniping extension window is zero or would overflow the auction
    /// end time.
    InvalidExtensionWindow = 47,
    /// The auction has reached its `max_extensions` cap and can no longer be
    /// extended by the anti-sniping logic.
    MaxExtensionsReached = 48,
    /// `escrow_nft` was called by an account that does not own the token.
    NotTokenOwner = 49,
    /// The token is already held in marketplace escrow for another listing
    /// or auction (double-listing guard).
    TokenAlreadyEscrowed = 50,
    /// An anti-sniping extension would push the auction's end_time beyond
    /// original_end_time + MAX_TOTAL_AUCTION_DURATION. The bid is still
    /// accepted, but the extension is not applied.
    AuctionDurationLimitReached = 51,
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
pub struct BatchCreateListingInput {
    pub price: i128,
    pub currency: Symbol,
    pub token: Address,
    pub collection: Address,
    pub token_id: u64,
    pub recipients: soroban_sdk::Vec<Recipient>,
    pub expires_at: Option<u64>,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct BatchUpdateListingInput {
    pub listing_id: u64,
    pub new_price: i128,
    pub new_token: Address,
    pub new_recipients: soroban_sdk::Vec<Recipient>,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Listing {
    pub listing_id: u64,
    pub artist: Address,
    /// Opaque base-unit amount denominated in `token` (e.g. stroops for
    /// native XLM, or the equivalent smallest unit for a whitelisted SAC).
    /// The contract performs no decimal scaling — see the `token` field doc
    /// below and `Contract::validate_token_asset`. Decimal/precision policy
    /// for display purposes lives in the off-chain token registry
    /// (frontend `config/tokens.ts`, indexer token metadata), not on-chain.
    pub price: i128,
    pub currency: Symbol,
    /// Address of the payment asset contract accepted for this listing —
    /// either the native XLM Stellar Asset Contract or another SAC present
    /// in the admin-managed whitelist (`get_token_whitelist`). All amounts
    /// (`price`, bids, offer amounts) are base units of this token's own
    /// `decimals()` (7, for both native XLM and any classic-asset SAC on
    /// Stellar); the contract treats them as opaque i128 values and never
    /// rescales them. Validated at write time by `is_token_whitelisted` and
    /// `validate_token_asset` — an unsupported or obviously-wrong asset
    /// address (e.g. equal to the collection or to this contract) is
    /// rejected before the listing/auction/offer can ever be created, so it
    /// can never reach settlement.
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
    /// Bid-history ring-buffer capacity snapshotted at auction creation time.
    ///
    /// Snapshotting here means a later admin change to the global
    /// `BidHistoryCap` never retroactively shrinks or grows the history of
    /// an already-running auction — each auction's ring-buffer behaviour is
    /// fixed when it is created.
    ///
    /// Valid range: 1 – 200 (enforced by `set_bid_history_cap`).
    pub bid_history_cap: u32,
    /// Maximum number of times this auction's end time may be extended by
    /// the anti-sniping logic.  0 = unlimited (legacy behaviour).
    /// Snapshotted from the global `max_extensions` setting at creation time.
    pub max_extensions: u32,
    /// Running count of extensions applied so far.
    pub extension_count: u32,
    /// Original end time set at auction creation, used to enforce the
    /// maximum total auction duration cap. Extensions cannot push end_time
    /// beyond original_end_time + MAX_TOTAL_AUCTION_DURATION.
    pub original_end_time: u64,
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
