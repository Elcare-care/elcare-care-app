// storage.rs
use crate::types::{Auction, BidRecord, Listing, Offer};
use soroban_sdk::{contracttype, Address, Env, Vec};

/// Identifies which listing or auction currently holds a token in escrow.
/// Stored under `DataKey::EscrowedToken(collection, token_id)`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowRecord {
    /// `true` = token is held for a listing; `false` = held for an auction.
    pub is_listing: bool,
    /// The listing_id or auction_id that holds this token.
    pub id: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    ListingCount,
    Listing(u64),
    ArtistListings(Address),
    Admin,
    TokenWhitelist,
    Treasury,
    ProtocolFeeBps,
    AuctionCount,
    Auction(u64),
    ArtistAuctions(Address),
    RevokedArtist(Address),
    OfferCount,
    Offer(u64),
    ListingOffers(u64),
    OffererOffers(Address),
    ListingLock(u64),
    AuctionLock(u64),
    IsPaused,
    PendingAdmin,
    ActiveListings,
    MinBidIncrement,
    AuctionExtensionWindow,
    AuctionExtensionTrigger,
    AuctionBids(u64),
    MinPrice,
    MaxPrice,
    MigrationDone(soroban_sdk::String),
    /// Records that a specific `(collection, token_id)` pair is currently held
    /// in escrow.  Value is an `EscrowRecord` mapping to listing/auction id.
    EscrowedToken(Address, u64),
}

pub const LEDGER_TTL_BUMP: u32 = 432_000;
pub const LEDGER_TTL_THRESHOLD: u32 = 144_000;
pub const REENTRANCY_LOCK_TTL: u32 = 100;

pub fn bump_entry_ttl(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, LEDGER_TTL_THRESHOLD, LEDGER_TTL_BUMP);
}

pub fn bump_active_listings_ttl(env: &Env) {
    bump_entry_ttl(env, &DataKey::ActiveListings);
}

// ── Counters ─────────────────────────────────────────────────

pub fn get_listing_count(env: &Env) -> u64 {
    env.storage()
        .persistent()
        .get::<DataKey, u64>(&DataKey::ListingCount)
        .unwrap_or(0)
}

pub fn increment_listing_count(env: &Env) -> u64 {
    let count = get_listing_count(env) + 1;
    env.storage()
        .persistent()
        .set(&DataKey::ListingCount, &count);
    bump_entry_ttl(env, &DataKey::ListingCount);
    count
}

pub fn get_auction_count(env: &Env) -> u64 {
    env.storage()
        .persistent()
        .get::<DataKey, u64>(&DataKey::AuctionCount)
        .unwrap_or(0)
}

pub fn increment_auction_count(env: &Env) -> u64 {
    let count = get_auction_count(env) + 1;
    env.storage()
        .persistent()
        .set(&DataKey::AuctionCount, &count);
    bump_entry_ttl(env, &DataKey::AuctionCount);
    count
}

pub fn get_offer_count(env: &Env) -> u64 {
    env.storage()
        .persistent()
        .get::<DataKey, u64>(&DataKey::OfferCount)
        .unwrap_or(0)
}

pub fn increment_offer_count(env: &Env) -> u64 {
    let count = get_offer_count(env) + 1;
    env.storage().persistent().set(&DataKey::OfferCount, &count);
    bump_entry_ttl(env, &DataKey::OfferCount);
    count
}

// ── CRUD ─────────────────────────────────────────────────────

pub fn save_listing(env: &Env, listing: &Listing) {
    let key = DataKey::Listing(listing.listing_id);
    env.storage().persistent().set(&key, listing);
    bump_entry_ttl(env, &key);
}

pub fn load_listing(env: &Env, listing_id: u64) -> Option<Listing> {
    let key = DataKey::Listing(listing_id);
    let res = env.storage().persistent().get::<DataKey, Listing>(&key);
    if res.is_some() {
        bump_entry_ttl(env, &key);
    }
    res
}

pub fn save_auction(env: &Env, auction: &Auction) {
    let key = DataKey::Auction(auction.auction_id);
    env.storage().persistent().set(&key, auction);
    bump_entry_ttl(env, &key);
}

pub fn load_auction(env: &Env, auction_id: u64) -> Option<Auction> {
    let key = DataKey::Auction(auction_id);
    let res = env.storage().persistent().get::<DataKey, Auction>(&key);
    if res.is_some() {
        bump_entry_ttl(env, &key);
    }
    res
}

pub fn save_offer(env: &Env, offer: &Offer) {
    let key = DataKey::Offer(offer.offer_id);
    env.storage().persistent().set(&key, offer);
    bump_entry_ttl(env, &key);
}

pub fn load_offer(env: &Env, offer_id: u64) -> Option<Offer> {
    let key = DataKey::Offer(offer_id);
    let res = env.storage().persistent().get::<DataKey, Offer>(&key);
    if res.is_some() {
        bump_entry_ttl(env, &key);
    }
    res
}

// ── Indices ──────────────────────────────────────────────────

pub fn add_artist_listing_id(env: &Env, artist: &Address, listing_id: u64) {
    let key = DataKey::ArtistListings(artist.clone());
    let mut ids = env
        .storage()
        .persistent()
        .get::<_, Vec<u64>>(&key)
        .unwrap_or_else(|| Vec::new(env));
    ids.push_back(listing_id);
    env.storage().persistent().set(&key, &ids);
    bump_entry_ttl(env, &key);
}

pub fn get_artist_listing_ids(env: &Env, artist: &Address) -> Vec<u64> {
    let key = DataKey::ArtistListings(artist.clone());
    let value = env
        .storage()
        .persistent()
        .get::<_, Vec<u64>>(&key)
        .unwrap_or_else(|| Vec::new(env));
    if !value.is_empty() {
        bump_entry_ttl(env, &key);
    }
    value
}

pub fn add_to_active_listings(env: &Env, listing_id: u64) {
    let key = DataKey::ActiveListings;
    let mut ids = env
        .storage()
        .persistent()
        .get::<_, Vec<u64>>(&key)
        .unwrap_or_else(|| Vec::new(env));
    ids.push_back(listing_id);
    env.storage().persistent().set(&key, &ids);
    bump_entry_ttl(env, &key);
}

pub fn remove_from_active_listings(env: &Env, listing_id: u64) {
    let key = DataKey::ActiveListings;
    let ids = env
        .storage()
        .persistent()
        .get::<_, Vec<u64>>(&key)
        .unwrap_or_else(|| Vec::new(env));
    let mut updated = Vec::new(env);
    for id in ids.iter() {
        if id != listing_id {
            updated.push_back(id);
        }
    }
    env.storage().persistent().set(&key, &updated);
    bump_entry_ttl(env, &key);
}

pub fn get_active_listing_ids(env: &Env) -> Vec<u64> {
    let key = DataKey::ActiveListings;
    let value = env
        .storage()
        .persistent()
        .get::<_, Vec<u64>>(&key)
        .unwrap_or_else(|| Vec::new(env));
    bump_entry_ttl(env, &key);
    value
}

pub fn add_artist_auction_id(env: &Env, artist: &Address, auction_id: u64) {
    let key = DataKey::ArtistAuctions(artist.clone());
    let mut ids = env
        .storage()
        .persistent()
        .get::<_, Vec<u64>>(&key)
        .unwrap_or_else(|| Vec::new(env));
    ids.push_back(auction_id);
    env.storage().persistent().set(&key, &ids);
    bump_entry_ttl(env, &key);
}

pub fn get_artist_auction_ids(env: &Env, artist: &Address) -> Vec<u64> {
    let key = DataKey::ArtistAuctions(artist.clone());
    let value = env
        .storage()
        .persistent()
        .get::<_, Vec<u64>>(&key)
        .unwrap_or_else(|| Vec::new(env));
    if !value.is_empty() {
        bump_entry_ttl(env, &key);
    }
    value
}

pub fn save_listing_offers(env: &Env, listing_id: u64, ids: &Vec<u64>) {
    let key = DataKey::ListingOffers(listing_id);
    env.storage().persistent().set(&key, ids);
    bump_entry_ttl(env, &key);
}

pub fn load_listing_offers(env: &Env, listing_id: u64) -> Vec<u64> {
    let key = DataKey::ListingOffers(listing_id);
    let value = env
        .storage()
        .persistent()
        .get::<_, Vec<u64>>(&key)
        .unwrap_or_else(|| Vec::new(env));
    if !value.is_empty() {
        bump_entry_ttl(env, &key);
    }
    value
}

pub fn save_offerer_offers(env: &Env, offerer: &Address, ids: &Vec<u64>) {
    let key = DataKey::OffererOffers(offerer.clone());
    env.storage().persistent().set(&key, ids);
    bump_entry_ttl(env, &key);
}

pub fn load_offerer_offers(env: &Env, offerer: &Address) -> Vec<u64> {
    let key = DataKey::OffererOffers(offerer.clone());
    let value = env
        .storage()
        .persistent()
        .get::<_, Vec<u64>>(&key)
        .unwrap_or_else(|| Vec::new(env));
    if !value.is_empty() {
        bump_entry_ttl(env, &key);
    }
    value
}

// ── Moderation & Config ────────────────────────────────────

pub fn set_artist_revocation_storage(env: &Env, artist: &Address) {
    let key = DataKey::RevokedArtist(artist.clone());
    env.storage().persistent().set(&key, &true);
    bump_entry_ttl(env, &key);
}

pub fn remove_artist_revocation_storage(env: &Env, artist: &Address) {
    env.storage()
        .persistent()
        .remove(&DataKey::RevokedArtist(artist.clone()));
}

pub fn is_artist_revoked_storage(env: &Env, artist: &Address) -> bool {
    let key = DataKey::RevokedArtist(artist.clone());
    let revoked = env
        .storage()
        .persistent()
        .get::<_, bool>(&key)
        .unwrap_or(false);
    if revoked {
        bump_entry_ttl(env, &key);
    }
    revoked
}

pub fn set_treasury_storage(env: &Env, addr: &Address) {
    env.storage().persistent().set(&DataKey::Treasury, addr);
    bump_entry_ttl(env, &DataKey::Treasury);
}

pub fn get_treasury_storage(env: &Env) -> Option<Address> {
    let value = env.storage().persistent().get(&DataKey::Treasury);
    if value.is_some() {
        bump_entry_ttl(env, &DataKey::Treasury);
    }
    value
}

pub fn set_protocol_fee_bps_storage(env: &Env, bps: u32) {
    env.storage()
        .persistent()
        .set(&DataKey::ProtocolFeeBps, &bps);
    bump_entry_ttl(env, &DataKey::ProtocolFeeBps);
}

pub fn get_protocol_fee_bps_storage(env: &Env) -> Option<u32> {
    let value = env.storage().persistent().get(&DataKey::ProtocolFeeBps);
    if value.is_some() {
        bump_entry_ttl(env, &DataKey::ProtocolFeeBps);
    }
    value
}

pub fn set_min_bid_increment_storage(env: &Env, increment: i128) {
    env.storage()
        .persistent()
        .set(&DataKey::MinBidIncrement, &increment);
    bump_entry_ttl(env, &DataKey::MinBidIncrement);
}

pub fn get_min_bid_increment_storage(env: &Env) -> Option<i128> {
    let value = env.storage().persistent().get(&DataKey::MinBidIncrement);
    if value.is_some() {
        bump_entry_ttl(env, &DataKey::MinBidIncrement);
    }
    value
}

pub fn set_auction_extension_window_storage(env: &Env, window: u64) {
    env.storage()
        .persistent()
        .set(&DataKey::AuctionExtensionWindow, &window);
    bump_entry_ttl(env, &DataKey::AuctionExtensionWindow);
}

pub fn get_auction_extension_window_storage(env: &Env) -> Option<u64> {
    let value = env
        .storage()
        .persistent()
        .get(&DataKey::AuctionExtensionWindow);
    if value.is_some() {
        bump_entry_ttl(env, &DataKey::AuctionExtensionWindow);
    }
    value
}

pub fn set_auction_extension_trigger_storage(env: &Env, trigger: u64) {
    env.storage()
        .persistent()
        .set(&DataKey::AuctionExtensionTrigger, &trigger);
    bump_entry_ttl(env, &DataKey::AuctionExtensionTrigger);
}

pub fn get_auction_extension_trigger_storage(env: &Env) -> Option<u64> {
    let value = env
        .storage()
        .persistent()
        .get(&DataKey::AuctionExtensionTrigger);
    if value.is_some() {
        bump_entry_ttl(env, &DataKey::AuctionExtensionTrigger);
    }
    value
}

// ── Reentrancy Guards ────────────────────────────────────────

pub fn acquire_listing_lock(env: &Env, listing_id: u64) -> bool {
    let key = DataKey::ListingLock(listing_id);
    if env.storage().temporary().has(&key) {
        return false;
    }
    env.storage().temporary().set(&key, &true);
    env.storage()
        .temporary()
        .extend_ttl(&key, REENTRANCY_LOCK_TTL, REENTRANCY_LOCK_TTL);
    true
}

pub fn release_listing_lock(env: &Env, listing_id: u64) {
    let key = DataKey::ListingLock(listing_id);
    env.storage().temporary().remove(&key);
}

pub fn acquire_auction_lock(env: &Env, auction_id: u64) -> bool {
    let key = DataKey::AuctionLock(auction_id);
    if env.storage().temporary().has(&key) {
        return false;
    }
    env.storage().temporary().set(&key, &true);
    env.storage()
        .temporary()
        .extend_ttl(&key, REENTRANCY_LOCK_TTL, REENTRANCY_LOCK_TTL);
    true
}

pub fn release_auction_lock(env: &Env, auction_id: u64) {
    let key = DataKey::AuctionLock(auction_id);
    env.storage().temporary().remove(&key);
}

// ── Admin transfer ───────────────────────────────────────────

pub fn set_pending_admin_storage(env: &Env, pending: &Address) {
    env.storage()
        .persistent()
        .set(&DataKey::PendingAdmin, pending);
    bump_entry_ttl(env, &DataKey::PendingAdmin);
}

pub fn get_pending_admin_storage(env: &Env) -> Option<Address> {
    let value = env.storage().persistent().get(&DataKey::PendingAdmin);
    if value.is_some() {
        bump_entry_ttl(env, &DataKey::PendingAdmin);
    }
    value
}

pub fn clear_pending_admin_storage(env: &Env) {
    env.storage().persistent().remove(&DataKey::PendingAdmin);
}

// ── Bid history ──────────────────────────────────────────────

pub fn append_bid_record(env: &Env, auction_id: u64, record: &BidRecord, cap: u32) {
    let key = DataKey::AuctionBids(auction_id);
    let mut history = env
        .storage()
        .persistent()
        .get::<DataKey, soroban_sdk::Vec<BidRecord>>(&key)
        .unwrap_or_else(|| soroban_sdk::Vec::new(env));
    if history.len() >= cap {
        let mut trimmed = soroban_sdk::Vec::new(env);
        for i in 1..history.len() {
            trimmed.push_back(history.get(i).unwrap());
        }
        history = trimmed;
    }
    history.push_back(record.clone());
    env.storage().persistent().set(&key, &history);
    bump_entry_ttl(env, &key);
}

pub fn load_auction_bids(env: &Env, auction_id: u64) -> soroban_sdk::Vec<BidRecord> {
    let key = DataKey::AuctionBids(auction_id);
    let value = env
        .storage()
        .persistent()
        .get::<DataKey, soroban_sdk::Vec<BidRecord>>(&key)
        .unwrap_or_else(|| soroban_sdk::Vec::new(env));
    if !value.is_empty() {
        bump_entry_ttl(env, &key);
    }
    value
}

pub fn set_paused(env: &Env, paused: bool) {
    env.storage().persistent().set(&DataKey::IsPaused, &paused);
    bump_entry_ttl(env, &DataKey::IsPaused);
}

pub fn is_paused(env: &Env) -> bool {
    env.storage()
        .persistent()
        .get::<DataKey, bool>(&DataKey::IsPaused)
        .unwrap_or(false)
}

// ── Price bounds ─────────────────────────────────────────────

pub fn set_min_price_storage(env: &Env, min: i128) {
    env.storage().persistent().set(&DataKey::MinPrice, &min);
    bump_entry_ttl(env, &DataKey::MinPrice);
}

pub fn get_min_price_storage(env: &Env) -> Option<i128> {
    let value = env.storage().persistent().get(&DataKey::MinPrice);
    if value.is_some() {
        bump_entry_ttl(env, &DataKey::MinPrice);
    }
    value
}

pub fn set_max_price_storage(env: &Env, max: i128) {
    env.storage().persistent().set(&DataKey::MaxPrice, &max);
    bump_entry_ttl(env, &DataKey::MaxPrice);
}

pub fn get_max_price_storage(env: &Env) -> Option<i128> {
    let value = env.storage().persistent().get(&DataKey::MaxPrice);
    if value.is_some() {
        bump_entry_ttl(env, &DataKey::MaxPrice);
    }
    value
}

// ── Migration marker ─────────────────────────────────────────

pub fn set_migration_done(env: &Env, version: &soroban_sdk::String) {
    let key = DataKey::MigrationDone(version.clone());
    env.storage().persistent().set(&key, &true);
    bump_entry_ttl(env, &key);
}

pub fn is_migration_done(env: &Env, version: &soroban_sdk::String) -> bool {
    let key = DataKey::MigrationDone(version.clone());
    let done = env
        .storage()
        .persistent()
        .get::<_, bool>(&key)
        .unwrap_or(false);
    if done {
        bump_entry_ttl(env, &key);
    }
    done
}

// ── NFT Escrow index ──────────────────────────────────────────

/// Record that `(collection, token_id)` is now in marketplace custody.
pub fn set_escrow_record(env: &Env, collection: &Address, token_id: u64, record: &EscrowRecord) {
    let key = DataKey::EscrowedToken(collection.clone(), token_id);
    env.storage().persistent().set(&key, record);
    bump_entry_ttl(env, &key);
}

/// Return the escrow record for `(collection, token_id)`, if any.
pub fn get_escrow_record(env: &Env, collection: &Address, token_id: u64) -> Option<EscrowRecord> {
    let key = DataKey::EscrowedToken(collection.clone(), token_id);
    let value = env
        .storage()
        .persistent()
        .get::<DataKey, EscrowRecord>(&key);
    if value.is_some() {
        bump_entry_ttl(env, &key);
    }
    value
}

/// Remove the escrow record, releasing the slot for future listings.
pub fn clear_escrow_record(env: &Env, collection: &Address, token_id: u64) {
    env.storage()
        .persistent()
        .remove(&DataKey::EscrowedToken(collection.clone(), token_id));
}
