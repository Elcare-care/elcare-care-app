 go// contract.rs — ELCARE-HUB Marketplace contract implementation
#[allow(unused_imports)]
use soroban_sdk::{
    contract, contractimpl, log, panic_with_error, token::Client as TokenClient,
    Address, Bytes, Env, IntoVal, Symbol, Vec,
};
use crate::events::*;
use crate::{
    escrow,
    storage::{
        acquire_auction_lock, acquire_listing_lock, add_artist_auction_id,
        add_artist_listing_id, add_to_active_listings, append_bid_record,
        clear_pending_admin_storage, get_active_listing_ids, get_artist_auction_ids,
        get_artist_listing_ids, get_auction_count, get_listing_count,
        get_pending_admin_storage, increment_auction_count, increment_listing_count,
        increment_offer_count, is_artist_revoked_storage, load_auction, load_auction_bids,
        load_listing, load_listing_offers, load_offer, load_offerer_offers,
        release_auction_lock, release_listing_lock, remove_artist_revocation_storage,
        remove_from_active_listings, save_auction, save_listing, save_listing_offers,
        save_offer, save_offerer_offers, set_artist_revocation_storage,
        set_pending_admin_storage, get_auction_extension_window_storage,
        get_auction_extension_trigger_storage, set_auction_extension_window_storage,
        set_auction_extension_trigger_storage, get_min_price_storage, get_max_price_storage,
        set_min_price_storage, set_max_price_storage, is_migration_done, set_migration_done,
    },
    types::{
        Auction, AuctionStatus, BidRecord, CancelReason, Listing, ListingStatus,
        MarketplaceError, Offer, OfferStatus, Recipient,
    },
};

/// Semantic version — bump on every breaking storage change.
const CONTRACT_VERSION: &str = "1.1.0";
const DEFAULT_MIN_BID_INCREMENT: i128 = 1;
const DEFAULT_EXTENSION_WINDOW: u64 = 600;
const DEFAULT_EXTENSION_TRIGGER: u64 = 0;
const MIN_AUCTION_DURATION: u64 = 3_600;
const BID_HISTORY_CAP: u32 = 20;
const MAX_OFFERS_PER_LISTING: u32 = 50;

#[contract]
pub struct MarketplaceContract;

#[contractimpl]
impl MarketplaceContract {
    // ── Admin ────────────────────────────────────────────────

    pub fn set_admin(env: Env, admin: Address) {
        let key = crate::storage::DataKey::Admin;
        if env.storage().persistent().get::<_, Address>(&key).is_some() {
            panic_with_error!(&env, MarketplaceError::Unauthorized);
        }
        admin.require_auth();
        env.storage().persistent().set(&key, &admin);
    }

    pub fn get_admin(env: Env) -> Option<Address> {
        env.storage()
            .persistent()
            .get::<_, Address>(&crate::storage::DataKey::Admin)
    }

    pub fn transfer_admin(env: Env, current_admin: Address, new_admin: Address) {
        current_admin.require_auth();
        let stored = Self::get_admin(env.clone())
            .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::Unauthorized));
        if current_admin != stored {
            panic_with_error!(&env, MarketplaceError::Unauthorized);
        }
        set_pending_admin_storage(&env, &new_admin);
        AdminTransferProposedEvent { current_admin, proposed_admin: new_admin }.publish(&env);
    }

    pub fn accept_admin(env: Env, new_admin: Address) {
        new_admin.require_auth();
        let pending = get_pending_admin_storage(&env)
            .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::Unauthorized));
        if new_admin != pending {
            panic_with_error!(&env, MarketplaceError::Unauthorized);
        }
        let old_admin = Self::get_admin(env.clone())
            .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::Unauthorized));
        let key = crate::storage::DataKey::Admin;
        env.storage().persistent().set(&key, &new_admin);
        env.storage().persistent().extend_ttl(
            &key,
            crate::storage::LEDGER_TTL_THRESHOLD,
            crate::storage::LEDGER_TTL_BUMP,
        );
        clear_pending_admin_storage(&env);
        AdminTransferredEvent { old_admin, new_admin }.publish(&env);
    }

    // ── Versioning & Migration ───────────────────────────────

    pub fn version(env: Env) -> soroban_sdk::String {
        soroban_sdk::String::from_str(&env, CONTRACT_VERSION)
    }

    pub fn migrate(env: Env, admin: Address) {
        admin.require_auth();
        let stored = Self::get_admin(env.clone()).expect("admin not set");
        if admin != stored { panic_with_error!(&env, MarketplaceError::Unauthorized); }
        let version = soroban_sdk::String::from_str(&env, CONTRACT_VERSION);
        if is_migration_done(&env, &version) {
            panic_with_error!(&env, MarketplaceError::AlreadyMigrated);
        }
        set_migration_done(&env, &version);
    }

    // ── Price bounds ─────────────────────────────────────────

    pub fn set_price_bounds(env: Env, admin: Address, min: i128, max: i128) {
        admin.require_auth();
        if admin != Self::get_admin(env.clone()).expect("admin not set") {
            panic_with_error!(&env, MarketplaceError::Unauthorized);
        }
        if min < 0 || max < 0 || min > max { panic_with_error!(&env, MarketplaceError::InvalidPrice); }
        set_min_price_storage(&env, min);
        set_max_price_storage(&env, max);
    }

    pub fn get_price_bounds(env: Env) -> (Option<i128>, Option<i128>) {
        (get_min_price_storage(&env), get_max_price_storage(&env))
    }

    // ── Treasury & Fees ──────────────────────────────────────

    pub fn set_treasury(env: Env, admin: Address, treasury: Address) {
        admin.require_auth();
        if admin != Self::get_admin(env.clone()).expect("admin not set") {
            panic_with_error!(&env, MarketplaceError::Unauthorized);
        }
        crate::storage::set_treasury_storage(&env, &treasury);
    }

    pub fn get_treasury(env: Env) -> Option<Address> {
        crate::storage::get_treasury_storage(&env)
    }

    pub fn set_protocol_fee(env: Env, admin: Address, bps: u32) {
        admin.require_auth();
        if admin != Self::get_admin(env.clone()).expect("admin not set") {
            panic_with_error!(&env, MarketplaceError::Unauthorized);
        }
        if bps > 1000 { panic_with_error!(&env, MarketplaceError::InvalidPrice); }
        crate::storage::set_protocol_fee_bps_storage(&env, bps);
    }

    pub fn get_protocol_fee(env: Env) -> u32 {
        crate::storage::get_protocol_fee_bps_storage(&env).unwrap_or(0)
    }

    pub fn set_min_bid_increment(env: Env, admin: Address, increment: i128) {
        admin.require_auth();
        if admin != Self::get_admin(env.clone()).expect("admin not set") {
            panic_with_error!(&env, MarketplaceError::Unauthorized);
        }
        if increment < 0 { panic_with_error!(&env, MarketplaceError::InvalidPrice); }
        crate::storage::set_min_bid_increment_storage(&env, increment);
    }

    pub fn get_min_bid_increment(env: Env) -> i128 {
        crate::storage::get_min_bid_increment_storage(&env).unwrap_or(DEFAULT_MIN_BID_INCREMENT)
    }

    pub fn set_auction_extension_window(env: Env, admin: Address, window: u64) {
        admin.require_auth();
        if admin != Self::get_admin(env.clone()).expect("admin not set") {
            panic_with_error!(&env, MarketplaceError::Unauthorized);
        }
        set_auction_extension_window_storage(&env, window);
    }

    pub fn get_auction_extension_window(env: Env) -> u64 {
        get_auction_extension_window_storage(&env).unwrap_or(DEFAULT_EXTENSION_WINDOW)
    }

    pub fn set_auction_extension_trigger(env: Env, admin: Address, trigger: u64) {
        admin.require_auth();
        if admin != Self::get_admin(env.clone()).expect("admin not set") {
            panic_with_error!(&env, MarketplaceError::Unauthorized);
        }
        set_auction_extension_trigger_storage(&env, trigger);
    }

    pub fn get_auction_extension_trigger(env: Env) -> u64 {
        get_auction_extension_trigger_storage(&env).unwrap_or(DEFAULT_EXTENSION_TRIGGER)
    }

    // ── Pause ────────────────────────────────────────────────

    pub fn admin_pause(env: Env, admin: Address) {
        admin.require_auth();
        if admin != Self::get_admin(env.clone()).expect("admin not set") {
            panic_with_error!(&env, MarketplaceError::Unauthorized);
        }
        crate::storage::set_paused(&env, true);
        #[allow(deprecated)]
        env.events().publish((crate::events::CONTRACT_PAUSED,), ());
    }

    pub fn admin_unpause(env: Env, admin: Address) {
        admin.require_auth();
        if admin != Self::get_admin(env.clone()).expect("admin not set") {
            panic_with_error!(&env, MarketplaceError::Unauthorized);
        }
        crate::storage::set_paused(&env, false);
        #[allow(deprecated)]
        env.events().publish((crate::events::CONTRACT_UNPAUSED,), ());
    }

    pub fn is_paused(env: Env) -> bool {
        crate::storage::is_paused(&env)
    }

    // ── Artist Moderation ────────────────────────────────────

    pub fn revoke_artist(env: Env, artist: Address) {
        Self::require_admin(&env);
        set_artist_revocation_storage(&env, &artist);
        #[allow(deprecated)]
        env.events().publish((crate::events::ARTIST_REVOKED,), artist);
    }

    pub fn reinstate_artist(env: Env, artist: Address) {
        Self::require_admin(&env);
        remove_artist_revocation_storage(&env, &artist);
        #[allow(deprecated)]
        env.events().publish((crate::events::ARTIST_REINSTATED,), artist);
    }

    pub fn is_artist_revoked(env: Env, artist: Address) -> bool {
        is_artist_revoked_storage(&env, &artist)
    }

    /// Cancel all active listings + auctions for a revoked artist.
    /// Releases each escrowed NFT back to the artist, refunds all pending offers.
    pub fn cancel_artist_listings(env: Env, admin: Address, artist: Address) {
        admin.require_auth();
        if admin != Self::get_admin(env.clone()).expect("admin not set") {
            panic_with_error!(&env, MarketplaceError::Unauthorized);
        }
        if !is_artist_revoked_storage(&env, &artist) { return; }

        let listing_ids = get_artist_listing_ids(&env, &artist);
        for listing_id in listing_ids.iter() {
            if let Some(mut listing) = load_listing(&env, listing_id) {
                if listing.status == ListingStatus::Active {
                    // Refund pending payment-token offers (Effects first)
                    let offers = load_listing_offers(&env, listing_id);
                    for offer_id in offers.iter() {
                        if let Some(mut offer) = load_offer(&env, offer_id) {
                            if offer.status == OfferStatus::Pending {
                                offer.status = OfferStatus::Rejected;
                                save_offer(&env, &offer);
                                // Interaction: refund
                                TokenClient::new(&env, &offer.token).transfer(
                                    &env.current_contract_address(),
                                    &offer.offerer,
                                    &offer.amount,
                                );
                            }
                        }
                    }
                    listing.status = ListingStatus::Cancelled;
                    save_listing(&env, &listing);
                    remove_from_active_listings(&env, listing_id);
                    ListingCancelledEvent {
                        listing_id,
                        cancelled_by: admin.clone(),
                        reason: CancelReason::AdminRevoked,
                        ledger_sequence: env.ledger().sequence(),
                    }.publish(&env);
                    // Interaction: return NFT from escrow to artist
                    escrow::release_nft(
                        &env, &listing.collection, listing.token_id,
                        &listing.artist, env.ledger().sequence(), listing_id,
                    );
                }
            }
        }
    }

    // ── Token Whitelist ──────────────────────────────────────

    pub fn add_token_to_whitelist(env: Env, token: Address) {
        Self::require_admin(&env);
        let key = crate::storage::DataKey::TokenWhitelist;
        let mut wl = env.storage().persistent()
            .get::<_, Vec<Address>>(&key).unwrap_or(Vec::new(&env));
        if !wl.contains(&token) { wl.push_back(token); env.storage().persistent().set(&key, &wl); }
    }

    pub fn remove_token_from_whitelist(env: Env, token: Address) {
        Self::require_admin(&env);
        let key = crate::storage::DataKey::TokenWhitelist;
        let wl = env.storage().persistent()
            .get::<_, Vec<Address>>(&key).unwrap_or(Vec::new(&env));
        let mut nw = Vec::new(&env);
        for t in wl.iter() { if t != token { nw.push_back(t.clone()); } }
        env.storage().persistent().set(&key, &nw);
    }

    pub fn get_token_whitelist(env: Env) -> Vec<Address> {
        let key = crate::storage::DataKey::TokenWhitelist;
        env.storage().persistent()
            .get::<_, Vec<Address>>(&key).unwrap_or(Vec::new(&env))
    }

    // ── create_listing ───────────────────────────────────────
    // CEI order:
    //   Checks  — auth, revocation, price, split, whitelist
    //   Effects — save listing, update indices, emit ListingCreated
    //   Interaction — escrow_nft (verify owner, pull NFT into custody)

    #[allow(clippy::too_many_arguments)]
    pub fn create_listing(
        env: Env, artist: Address, price: i128, currency: Symbol,
        token: Address, collection: Address, token_id: u64,
        recipients: Vec<Recipient>, expires_at: Option<u64>,
    ) -> u64 {
        Self::require_not_paused(&env);
        artist.require_auth();
        Self::require_not_revoked(&env, &artist);
        if price <= 0 { panic_with_error!(&env, MarketplaceError::InvalidPrice); }
        Self::require_price_in_bounds(&env, price);
        if let Some(exp) = expires_at {
            if exp <= env.ledger().timestamp() {
                panic_with_error!(&env, MarketplaceError::InvalidPrice);
            }
        }
        let rlen = recipients.len();
        if rlen == 0 { panic_with_error!(&env, MarketplaceError::InvalidSplit); }
        if rlen > 4  { panic_with_error!(&env, MarketplaceError::TooManyRecipients); }
        let protocol_fee_bps = crate::storage::get_protocol_fee_bps_storage(&env).unwrap_or(0);
        Self::validate_recipients(&env, &recipients, protocol_fee_bps);
        if !Self::is_token_whitelisted(&env, &token) {
            panic_with_error!(&env, MarketplaceError::TokenNotWhitelisted);
        }

        // Effects
        let listing_id = increment_listing_count(&env);
        let listing = Listing {
            listing_id, artist: artist.clone(), price, currency,
            token, collection: collection.clone(), token_id,
            recipients, status: ListingStatus::Active, owner: None,
            created_at: env.ledger().sequence(), protocol_fee_bps, expires_at,
        };
        save_listing(&env, &listing);
        add_artist_listing_id(&env, &artist, listing_id);
        add_to_active_listings(&env, listing_id);
        ListingCreatedEvent {
            listing_id, artist: artist.clone(), price,
            currency: listing.currency.clone(), collection: listing.collection.clone(),
            token_id: listing.token_id, ledger_sequence: env.ledger().sequence(),
        }.publish(&env);

        // Interaction — pull NFT into contract custody (verifies ownership, no double-list)
        escrow::escrow_nft(&env, &artist, &listing.collection, listing.token_id, true, listing_id);
        escrow::emit_nft_escrowed(&env, listing_id, &listing.collection,
            listing.token_id, &artist, env.ledger().sequence());
        listing_id
    }

    // update_listing — no NFT movement; NFT stays in escrow unchanged
    pub fn update_listing(
        env: Env, artist: Address, listing_id: u64,
        new_price: i128, new_token: Address, new_recipients: Vec<Recipient>,
    ) -> bool {
        Self::require_not_paused(&env);
        artist.require_auth();
        let mut listing = load_listing(&env, listing_id)
            .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::ListingNotFound));
        if listing.artist != artist { panic_with_error!(&env, MarketplaceError::Unauthorized); }
        if listing.status != ListingStatus::Active {
            panic_with_error!(&env, MarketplaceError::ListingNotActive);
        }
        // Block if any pending offer exists
        let offers = load_listing_offers(&env, listing_id);
        for oid in offers.iter() {
            if let Some(o) = load_offer(&env, oid) {
                if o.status == OfferStatus::Pending {
                    panic_with_error!(&env, MarketplaceError::Unauthorized);
                }
            }
        }
        if new_price <= 0 { panic_with_error!(&env, MarketplaceError::InvalidPrice); }
        if !Self::is_token_whitelisted(&env, &new_token) {
            panic_with_error!(&env, MarketplaceError::Unauthorized);
        }
        let nrlen = new_recipients.len();
        if nrlen == 0 { panic_with_error!(&env, MarketplaceError::InvalidSplit); }
        if nrlen > 4  { panic_with_error!(&env, MarketplaceError::TooManyRecipients); }
        Self::validate_recipients(&env, &new_recipients, listing.protocol_fee_bps);
        listing.price = new_price;
        listing.token = new_token;
        listing.recipients = new_recipients;
        save_listing(&env, &listing);
        ListingUpdatedEvent {
            listing_id, artist: artist.clone(), new_price,
            collection: listing.collection.clone(), token_id: listing.token_id,
            ledger_sequence: env.ledger().sequence(),
        }.publish(&env);
        true
    }

    pub fn update_listing_price(env: Env, seller: Address, listing_id: u64, new_price: i128) -> bool {
        Self::require_not_paused(&env);
        seller.require_auth();
        let mut listing = load_listing(&env, listing_id)
            .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::ListingNotFound));
        if listing.artist != seller { panic_with_error!(&env, MarketplaceError::Unauthorized); }
        if listing.status != ListingStatus::Active {
            panic_with_error!(&env, MarketplaceError::ListingNotActive);
        }
        if new_price <= 0 { panic_with_error!(&env, MarketplaceError::InvalidPrice); }
        let price_upper_bound: i128 = i128::MAX / 10_000;
        if new_price > price_upper_bound { panic_with_error!(&env, MarketplaceError::InvalidPrice); }
        let old_price = listing.price;
        listing.price = new_price;
        save_listing(&env, &listing);
        ListingPriceUpdatedEvent { listing_id, old_price, new_price, updated_by: seller }.publish(&env);
        true
    }

    // ── buy_artwork ──────────────────────────────────────────
    // CEI:
    //   1. lock   2. checks   3. effects (mark Sold, reject offers)
    //   4. emit   5. interactions (payment payout, release_nft, refund offers)
    //   6. unlock
    pub fn buy_artwork(env: Env, buyer: Address, listing_id: u64) -> bool {
        Self::require_not_paused(&env);
        buyer.require_auth();
        if !acquire_listing_lock(&env, listing_id) {
            panic_with_error!(&env, MarketplaceError::ReentrancyGuard);
        }
        let mut listing = match load_listing(&env, listing_id) {
            Some(l) => l,
            None => { release_listing_lock(&env, listing_id);
                      panic_with_error!(&env, MarketplaceError::ListingNotFound); }
        };
        if listing.status == ListingStatus::Sold {
            release_listing_lock(&env, listing_id);
            panic_with_error!(&env, MarketplaceError::ListingSold);
        }
        if listing.status == ListingStatus::Cancelled {
            release_listing_lock(&env, listing_id);
            panic_with_error!(&env, MarketplaceError::ListingCancelled);
        }
        if listing.status != ListingStatus::Active {
            release_listing_lock(&env, listing_id);
            panic_with_error!(&env, MarketplaceError::ListingNotActive);
        }
        if listing.artist == buyer {
            release_listing_lock(&env, listing_id);
            panic_with_error!(&env, MarketplaceError::SelfPurchaseNotAllowed);
        }
        if let Some(ref o) = listing.owner {
            if *o == buyer { release_listing_lock(&env, listing_id);
                             panic_with_error!(&env, MarketplaceError::SelfPurchaseNotAllowed); }
        }
        if let Some(exp) = listing.expires_at {
            if env.ledger().timestamp() >= exp {
                release_listing_lock(&env, listing_id);
                panic_with_error!(&env, MarketplaceError::ListingExpired);
            }
        }
        if !Self::is_token_whitelisted(&env, &listing.token) {
            release_listing_lock(&env, listing_id);
            panic_with_error!(&env, MarketplaceError::TokenNotWhitelisted);
        }
        // Effects
        listing.status = ListingStatus::Sold;
        listing.owner = Some(buyer.clone());
        save_listing(&env, &listing);
        remove_from_active_listings(&env, listing_id);
        let offers = load_listing_offers(&env, listing_id);
        let mut p_offerers: Vec<Address> = Vec::new(&env);
        let mut p_amounts: Vec<i128> = Vec::new(&env);
        let mut p_tokens: Vec<Address> = Vec::new(&env);
        for oid in offers.iter() {
            if let Some(mut offer) = load_offer(&env, oid) {
                if offer.status == OfferStatus::Pending {
                    offer.status = OfferStatus::Rejected;
                    save_offer(&env, &offer);
                    p_offerers.push_back(offer.offerer.clone());
                    p_amounts.push_back(offer.amount);
                    p_tokens.push_back(offer.token.clone());
                }
            }
        }
        ArtworkSoldEvent {
            listing_id, artist: listing.artist.clone(), buyer: buyer.clone(),
            price: listing.price, currency: listing.currency.clone(),
            ledger_sequence: env.ledger().sequence(),
        }.publish(&env);
        // Interactions
        let fee = Self::distribute_payout(
            &env, &listing.token, &listing.collection, listing.price,
            &listing.artist, &listing.recipients, &buyer, true, listing.protocol_fee_bps,
        );
        if fee > 0 {
            if let Some(treasury) = crate::storage::get_treasury_storage(&env) {
                ProtocolFeeCollectedEvent {
                    listing_id, amount: fee, token: listing.token.clone(), treasury,
                }.publish(&env);
            }
        }
        // NFT: from escrow → buyer (CEI: state already Sold)
        escrow::release_nft(&env, &listing.collection, listing.token_id,
            &buyer, env.ledger().sequence(), listing_id);
        for i in 0..p_offerers.len() {
            TokenClient::new(&env, &p_tokens.get(i).unwrap()).transfer(
                &env.current_contract_address(),
                &p_offerers.get(i).unwrap(),
                &p_amounts.get(i).unwrap(),
            );
        }
        release_listing_lock(&env, listing_id);
        true
    }

    // ── cancel_listing ───────────────────────────────────────
    // Effects first, then release_nft (Interaction)
    pub fn cancel_listing(env: Env, artist: Address, listing_id: u64) -> bool {
        Self::require_not_paused(&env);
        artist.require_auth();
        let mut listing = load_listing(&env, listing_id)
            .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::ListingNotFound));
        if listing.artist != artist { panic_with_error!(&env, MarketplaceError::Unauthorized); }
        if listing.status != ListingStatus::Active {
            panic_with_error!(&env, MarketplaceError::ListingNotActive);
        }
        // Refund pending offers
        let offers = load_listing_offers(&env, listing_id);
        for oid in offers.iter() {
            if let Some(mut offer) = load_offer(&env, oid) {
                if offer.status == OfferStatus::Pending {
                    offer.status = OfferStatus::Rejected;
                    save_offer(&env, &offer);
                    TokenClient::new(&env, &offer.token).transfer(
                        &env.current_contract_address(), &offer.offerer, &offer.amount,
                    );
                }
            }
        }
        listing.status = ListingStatus::Cancelled;
        save_listing(&env, &listing);
        remove_from_active_listings(&env, listing_id);
        ListingCancelledEvent {
            listing_id, cancelled_by: artist.clone(),
            reason: CancelReason::Owner, ledger_sequence: env.ledger().sequence(),
        }.publish(&env);
        // Return NFT to seller
        escrow::release_nft(&env, &listing.collection, listing.token_id,
            &artist, env.ledger().sequence(), listing_id);
        true
    }

    // ── expire_listing ───────────────────────────────────────
    // Permissionless — anyone may expire a listing past its expires_at
    pub fn expire_listing(env: Env, listing_id: u64) {
        let mut listing = load_listing(&env, listing_id)
            .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::ListingNotFound));
        if listing.status != ListingStatus::Active {
            panic_with_error!(&env, MarketplaceError::ListingNotActive);
        }
        let exp = match listing.expires_at {
            Some(t) => t,
            None => panic_with_error!(&env, MarketplaceError::ListingNotExpired),
        };
        if env.ledger().timestamp() < exp {
            panic_with_error!(&env, MarketplaceError::ListingNotExpired);
        }
        listing.status = ListingStatus::Cancelled;
        save_listing(&env, &listing);
        remove_from_active_listings(&env, listing_id);
        ListingExpiredEvent {
            listing_id, expired_at: exp, ledger_sequence: env.ledger().sequence(),
        }.publish(&env);
        // Return NFT to seller
        escrow::release_nft(&env, &listing.collection, listing.token_id,
            &listing.artist, env.ledger().sequence(), listing_id);
    }

    // ── create_auction ───────────────────────────────────────
    // CEI: Effects → emit → escrow_nft (Interaction)
    #[allow(clippy::too_many_arguments)]
    pub fn create_auction(
        env: Env, creator: Address, token: Address, collection: Address,
        token_id: u64, reserve_price: i128, duration: u64, recipients: Vec<Recipient>,
    ) -> u64 {
        Self::require_not_paused(&env);
        creator.require_auth();
        Self::require_not_revoked(&env, &creator);
        if reserve_price <= 0 { panic_with_error!(&env, MarketplaceError::InvalidPrice); }
        if duration < MIN_AUCTION_DURATION {
            panic_with_error!(&env, MarketplaceError::InvalidAuctionDuration);
        }
        if !Self::is_token_whitelisted(&env, &token) {
            panic_with_error!(&env, MarketplaceError::TokenNotWhitelisted);
        }
        let auction_id = increment_auction_count(&env);
        let end_time = env.ledger().timestamp() + duration;
        let min_increment = crate::storage::get_min_bid_increment_storage(&env)
            .unwrap_or(DEFAULT_MIN_BID_INCREMENT);
        let extension_window = get_auction_extension_window_storage(&env)
            .unwrap_or(DEFAULT_EXTENSION_WINDOW);
        let extension_trigger = get_auction_extension_trigger_storage(&env)
            .unwrap_or(DEFAULT_EXTENSION_TRIGGER);
        let protocol_fee_bps = crate::storage::get_protocol_fee_bps_storage(&env).unwrap_or(0);
        let auction = Auction {
            auction_id, creator: creator.clone(), token: token.clone(),
            collection: collection.clone(), token_id, reserve_price,
            highest_bid: 0, highest_bidder: None, end_time,
            status: AuctionStatus::Active, recipients,
            min_increment, extension_window, extension_trigger, protocol_fee_bps,
        };
        save_auction(&env, &auction);
        add_artist_auction_id(&env, &creator, auction_id);
        AuctionCreatedEvent {
            auction_id, creator: creator.clone(), reserve_price,
            token, collection: collection.clone(), token_id, end_time,
        }.publish(&env);
        // Interaction — pull NFT into custody
        escrow::escrow_nft(&env, &creator, &collection, token_id, false, auction_id);
        escrow::emit_nft_escrowed(&env, auction_id, &collection, token_id,
            &creator, env.ledger().sequence());
        auction_id
    }

    // ── place_bid ────────────────────────────────────────────
    pub fn place_bid(env: Env, bidder: Address, auction_id: u64, amount: i128) {
        Self::require_not_paused(&env);
        bidder.require_auth();
        let mut auction = load_auction(&env, auction_id)
            .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::AuctionNotFound));
        if auction.status != AuctionStatus::Active {
            panic_with_error!(&env, MarketplaceError::AuctionNotActive);
        }
        if env.ledger().timestamp() >= auction.end_time {
            panic_with_error!(&env, MarketplaceError::AuctionExpired);
        }
        if bidder == auction.creator { panic_with_error!(&env, MarketplaceError::SelfBidNotAllowed); }
        let required_min = if auction.highest_bid == 0 {
            auction.reserve_price
        } else {
            auction.highest_bid.checked_add(auction.min_increment)
                .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::BidTooLow))
        };
        if amount < required_min { panic_with_error!(&env, MarketplaceError::BidTooLow); }
        let previous_bidder = auction.highest_bidder.clone();
        let previous_bid = auction.highest_bid;
        auction.highest_bid = amount;
        auction.highest_bidder = Some(bidder.clone());
        let now = env.ledger().timestamp();
        let time_remaining = auction.end_time.saturating_sub(now);
        let mut extended = false;
        if auction.extension_trigger > 0 && time_remaining < auction.extension_trigger {
            auction.end_time = now.checked_add(auction.extension_window).unwrap_or(auction.end_time);
            extended = true;
        }
        save_auction(&env, &auction);
        append_bid_record(&env, auction_id,
            &BidRecord { bidder: bidder.clone(), amount, ledger: env.ledger().sequence() },
            BID_HISTORY_CAP,
        );
        BidPlacedEvent { auction_id, bidder: bidder.clone(), bid_amount: amount }.publish(&env);
        if extended {
            AuctionExtendedEvent { auction_id, new_end_time: auction.end_time }.publish(&env);
        }
        let tc = TokenClient::new(&env, &auction.token);
        if let Some(prev) = previous_bidder {
            tc.transfer(&env.current_contract_address(), &prev, &previous_bid);
        }
        tc.transfer(&bidder, &env.current_contract_address(), &amount);
    }

    // ── finalize_auction ─────────────────────────────────────
    // CEI: lock → checks → effects → emit → interactions (payout + release_nft) → unlock
    // With escrow: NFT source is always the contract — no seller-side surprise.
    pub fn finalize_auction(env: Env, caller: Address, auction_id: u64) {
        Self::require_not_paused(&env);
        caller.require_auth();
        if !acquire_auction_lock(&env, auction_id) {
            panic_with_error!(&env, MarketplaceError::ReentrancyGuard);
        }
        let mut auction = match load_auction(&env, auction_id) {
            Some(a) => a,
            None => { release_auction_lock(&env, auction_id);
                      panic_with_error!(&env, MarketplaceError::AuctionNotFound); }
        };
        if auction.status != AuctionStatus::Active {
            release_auction_lock(&env, auction_id);
            panic_with_error!(&env, MarketplaceError::AuctionAlreadyFinalized);
        }
        if env.ledger().timestamp() < auction.end_time {
            release_auction_lock(&env, auction_id);
            panic_with_error!(&env, MarketplaceError::AuctionNotEnded);
        }
        let winner = auction.highest_bidder.clone();
        let winning_bid = auction.highest_bid;
        let snapshotted_fee = auction.protocol_fee_bps;
        auction.status = if winner.is_some() { AuctionStatus::Finalized } else { AuctionStatus::Cancelled };
        save_auction(&env, &auction);
        AuctionFinalizedEvent { auction_id, winner: winner.clone(), amount: winning_bid }.publish(&env);
        if let Some(ref w) = winner {
            let fee = Self::distribute_payout(
                &env, &auction.token, &auction.collection, winning_bid,
                &auction.creator, &auction.recipients, w, false, snapshotted_fee,
            );
            if fee > 0 {
                if let Some(treasury) = crate::storage::get_treasury_storage(&env) {
                    ProtocolFeeCollectedEvent {
                        listing_id: auction_id, amount: fee,
                        token: auction.token.clone(), treasury,
                    }.publish(&env);
                }
            }
            // NFT: escrow → winner (CEI: status Finalized already)
            escrow::release_nft(&env, &auction.collection, auction.token_id,
                w, env.ledger().sequence(), auction_id);
        } else {
            // No bids — return NFT to creator
            escrow::release_nft(&env, &auction.collection, auction.token_id,
                &auction.creator, env.ledger().sequence(), auction_id);
        }
        release_auction_lock(&env, auction_id);
    }

    // ── cancel_auction ───────────────────────────────────────
    // Only no-bid auctions can be cancelled; releases NFT back to creator
    pub fn cancel_auction(env: Env, creator: Address, auction_id: u64) {
        Self::require_not_paused(&env);
        creator.require_auth();
        let mut auction = load_auction(&env, auction_id)
            .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::AuctionNotFound));
        if auction.creator != creator { panic_with_error!(&env, MarketplaceError::Unauthorized); }
        if auction.status != AuctionStatus::Active {
            panic_with_error!(&env, MarketplaceError::AuctionAlreadyFinalized);
        }
        if auction.highest_bidder.is_some() {
            panic_with_error!(&env, MarketplaceError::AuctionHasBids);
        }
        auction.status = AuctionStatus::Cancelled;
        save_auction(&env, &auction);
        AuctionCancelledEvent { auction_id, cancelled_by: creator.clone() }.publish(&env);
        // Return NFT to creator
        escrow::release_nft(&env, &auction.collection, auction.token_id,
            &creator, env.ledger().sequence(), auction_id);
    }

    // ── Offers ───────────────────────────────────────────────

    pub fn make_offer(
        env: Env, offerer: Address, listing_id: u64,
        amount: i128, token: Address, expires_at: Option<u64>,
    ) -> u64 {
        Self::require_not_paused(&env);
        offerer.require_auth();
        let listing = load_listing(&env, listing_id)
            .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::ListingNotFound));
        if listing.status != ListingStatus::Active {
            panic_with_error!(&env, MarketplaceError::ListingNotActive);
        }
        if listing.artist == offerer { panic_with_error!(&env, MarketplaceError::CannotOfferOwnListing); }
        if amount <= 0 { panic_with_error!(&env, MarketplaceError::InsufficientOfferAmount); }
        if !Self::is_token_whitelisted(&env, &token) {
            panic_with_error!(&env, MarketplaceError::TokenNotWhitelisted);
        }
        let lo = load_listing_offers(&env, listing_id);
        let mut active: u32 = 0;
        for oid in lo.iter() {
            if let Some(o) = load_offer(&env, oid) {
                if o.status == OfferStatus::Pending { active += 1; }
            }
        }
        if active >= MAX_OFFERS_PER_LISTING {
            panic_with_error!(&env, MarketplaceError::OfferLimitReached);
        }
        TokenClient::new(&env, &token).transfer(&offerer, &env.current_contract_address(), &amount);
        let offer_id = increment_offer_count(&env);
        save_offer(&env, &Offer {
            offer_id, listing_id, offerer: offerer.clone(), amount,
            token: token.clone(), status: OfferStatus::Pending,
            created_at: env.ledger().sequence(), expires_at,
        });
        let mut lo2 = load_listing_offers(&env, listing_id);
        lo2.push_back(offer_id);
        save_listing_offers(&env, listing_id, &lo2);
        let mut oo = load_offerer_offers(&env, &offerer);
        oo.push_back(offer_id);
        save_offerer_offers(&env, &offerer, &oo);
        OfferMadeEvent { offer_id, listing_id, offerer: offerer.clone(), amount, token }.publish(&env);
        offer_id
    }

    pub fn withdraw_offer(env: Env, offerer: Address, offer_id: u64) {
        Self::require_not_paused(&env);
        offerer.require_auth();
        let mut offer = load_offer(&env, offer_id)
            .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::OfferNotFound));
        if offer.offerer != offerer { panic_with_error!(&env, MarketplaceError::Unauthorized); }
        if offer.status != OfferStatus::Pending {
            panic_with_error!(&env, MarketplaceError::InvalidOfferState);
        }
        TokenClient::new(&env, &offer.token).transfer(
            &env.current_contract_address(), &offerer, &offer.amount,
        );
        offer.status = OfferStatus::Withdrawn;
        save_offer(&env, &offer);
        OfferWithdrawnEvent { offer_id, listing_id: offer.listing_id, offerer }.publish(&env);
    }

    pub fn reject_offer(env: Env, artist: Address, offer_id: u64) {
        Self::require_not_paused(&env);
        artist.require_auth();
        let mut offer = load_offer(&env, offer_id)
            .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::OfferNotFound));
        let listing = load_listing(&env, offer.listing_id)
            .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::ListingNotFound));
        if listing.artist != artist { panic_with_error!(&env, MarketplaceError::Unauthorized); }
        if offer.status != OfferStatus::Pending {
            panic_with_error!(&env, MarketplaceError::InvalidOfferState);
        }
        TokenClient::new(&env, &offer.token).transfer(
            &env.current_contract_address(), &offer.offerer, &offer.amount,
        );
        offer.status = OfferStatus::Rejected;
        save_offer(&env, &offer);
        OfferRejectedEvent { offer_id, listing_id: offer.listing_id, offerer: offer.offerer }.publish(&env);
    }

    // ── accept_offer ─────────────────────────────────────────
    // CEI: lock → checks → effects → emit → interactions (payout + release_nft + refunds) → unlock
    pub fn accept_offer(env: Env, artist: Address, offer_id: u64) {
        Self::require_not_paused(&env);
        artist.require_auth();
        let mut offer = load_offer(&env, offer_id)
            .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::OfferNotFound));
        let listing_id = offer.listing_id;
        if !acquire_listing_lock(&env, listing_id) {
            panic_with_error!(&env, MarketplaceError::ReentrancyGuard);
        }
        let mut listing = match load_listing(&env, listing_id) {
            Some(l) => l,
            None => { release_listing_lock(&env, listing_id);
                      panic_with_error!(&env, MarketplaceError::ListingNotFound); }
        };
        if listing.artist != artist {
            release_listing_lock(&env, listing_id);
            panic_with_error!(&env, MarketplaceError::Unauthorized);
        }
        if offer.status != OfferStatus::Pending || listing.status != ListingStatus::Active {
            release_listing_lock(&env, listing_id);
            panic_with_error!(&env, MarketplaceError::InvalidOfferState);
        }
        if let Some(exp) = offer.expires_at {
            if env.ledger().timestamp() >= exp {
                release_listing_lock(&env, listing_id);
                panic_with_error!(&env, MarketplaceError::OfferExpired);
            }
        }
        if let Some(exp) = listing.expires_at {
            if env.ledger().timestamp() >= exp {
                release_listing_lock(&env, listing_id);
                panic_with_error!(&env, MarketplaceError::ListingExpired);
            }
        }
        // Effects
        let accepted_offerer = offer.offerer.clone();
        let accepted_amount = offer.amount;
        offer.status = OfferStatus::Accepted;
        save_offer(&env, &offer);
        listing.status = ListingStatus::Sold;
        listing.owner = Some(accepted_offerer.clone());
        save_listing(&env, &listing);
        remove_from_active_listings(&env, listing_id);
        // Mark competing offers Rejected (collect refund data)
        let siblings = load_listing_offers(&env, listing.listing_id);
        let mut r_offerers: Vec<Address> = Vec::new(&env);
        let mut r_amounts: Vec<i128> = Vec::new(&env);
        let mut r_tokens: Vec<Address> = Vec::new(&env);
        for oid in siblings.iter() {
            if oid != offer_id {
                if let Some(mut other) = load_offer(&env, oid) {
                    if other.status == OfferStatus::Pending {
                        other.status = OfferStatus::Rejected;
                        save_offer(&env, &other);
                        r_offerers.push_back(other.offerer.clone());
                        r_amounts.push_back(other.amount);
                        r_tokens.push_back(other.token.clone());
                        OfferRejectedEvent {
                            offer_id: oid, listing_id, offerer: other.offerer,
                        }.publish(&env);
                    }
                }
            }
        }
        OfferAcceptedEvent {
            offer_id, listing_id, offerer: accepted_offerer.clone(), amount: accepted_amount,
        }.publish(&env);
        // Interactions
        let fee = Self::distribute_payout(
            &env, &offer.token, &listing.collection, offer.amount,
            &artist, &listing.recipients, &offer.offerer, false, listing.protocol_fee_bps,
        );
        if fee > 0 {
            if let Some(treasury) = crate::storage::get_treasury_storage(&env) {
                ProtocolFeeCollectedEvent {
                    listing_id, amount: fee, token: offer.token.clone(), treasury,
                }.publish(&env);
            }
        }
        // NFT: escrow → accepted offerer (CEI: status Sold already)
        escrow::release_nft(&env, &listing.collection, listing.token_id,
            &accepted_offerer, env.ledger().sequence(), listing_id);
        for i in 0..r_offerers.len() {
            TokenClient::new(&env, &r_tokens.get(i).unwrap()).transfer(
                &env.current_contract_address(),
                &r_offerers.get(i).unwrap(),
                &r_amounts.get(i).unwrap(),
            );
        }
        release_listing_lock(&env, listing_id);
    }

    pub fn reclaim_offer(env: Env, offer_id: u64) {
        Self::require_not_paused(&env);
        let mut offer = load_offer(&env, offer_id)
            .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::OfferNotFound));
        if offer.status != OfferStatus::Pending {
            panic_with_error!(&env, MarketplaceError::InvalidOfferState);
        }
        let exp = match offer.expires_at {
            Some(e) => e,
            None => panic_with_error!(&env, MarketplaceError::InvalidOfferState),
        };
        if env.ledger().timestamp() < exp { panic_with_error!(&env, MarketplaceError::OfferExpired); }
        TokenClient::new(&env, &offer.token).transfer(
            &env.current_contract_address(), &offer.offerer, &offer.amount,
        );
        offer.status = OfferStatus::Withdrawn;
        save_offer(&env, &offer);
        crate::events::OfferReclaimedEvent {
            offer_id, listing_id: offer.listing_id,
            offerer: offer.offerer.clone(), amount: offer.amount,
        }.publish(&env);
    }

    // ── Read-only getters ────────────────────────────────────

    pub fn get_listing(env: Env, listing_id: u64) -> Listing {
        load_listing(&env, listing_id)
            .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::ListingNotFound))
    }
    pub fn get_total_listings(env: Env) -> u64 { get_listing_count(&env) }
    pub fn get_artist_listings(env: Env, artist: Address) -> Vec<u64> {
        get_artist_listing_ids(&env, &artist)
    }
    pub fn get_total_auctions(env: Env) -> u64 { get_auction_count(&env) }
    pub fn get_artist_auctions(env: Env, artist: Address) -> Vec<u64> {
        get_artist_auction_ids(&env, &artist)
    }
    pub fn get_active_listings(env: Env, limit: u32, offset: u32) -> Vec<u64> {
        let ids = get_active_listing_ids(&env);
        let start = offset as usize;
        let end = (start + limit as usize).min(ids.len() as usize);
        let mut page = Vec::new(&env);
        for i in start..end { page.push_back(ids.get(i as u32).unwrap()); }
        page
    }
    pub fn get_active_listings_page(env: Env, start: u32, limit: u32) -> Vec<u64> {
        Self::get_active_listings(env, limit, start)
    }
    pub const MAX_PAGE_LIMIT: u32 = 100;
    pub fn get_listings_paginated(env: Env, start: u32, limit: u32) -> (Vec<Listing>, u32) {
        let effective_limit = if limit > Self::MAX_PAGE_LIMIT { Self::MAX_PAGE_LIMIT }
                              else if limit == 0 { return (Vec::new(&env), start); }
                              else { limit };
        let ids = get_active_listing_ids(&env);
        let total = ids.len();
        if start >= total { return (Vec::new(&env), start); }
        let end = (start + effective_limit).min(total);
        let mut listings: Vec<Listing> = Vec::new(&env);
        for i in start..end {
            let lid = ids.get(i).unwrap();
            if let Some(l) = load_listing(&env, lid) { listings.push_back(l); }
        }
        (listings, end)
    }
    pub fn get_offers_by_listing(env: Env, listing_id: u64) -> Vec<crate::types::Offer> {
        let ids = load_listing_offers(&env, listing_id);
        let mut offers = Vec::new(&env);
        for oid in ids.iter() {
            if let Some(o) = load_offer(&env, oid) { offers.push_back(o); }
        }
        offers
    }
    pub fn get_listing_status(env: Env, listing_id: u64) -> ListingStatus {
        let l = load_listing(&env, listing_id)
            .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::ListingNotFound));
        l.status
    }
    pub fn get_auction(env: Env, auction_id: u64) -> Auction {
        load_auction(&env, auction_id)
            .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::AuctionNotFound))
    }
    pub fn get_auction_bids(env: Env, auction_id: u64) -> Vec<BidRecord> {
        load_auction(&env, auction_id)
            .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::AuctionNotFound));
        load_auction_bids(&env, auction_id)
    }
    pub fn get_offer(env: Env, offer_id: u64) -> crate::types::Offer {
        load_offer(&env, offer_id)
            .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::OfferNotFound))
    }
    pub fn get_listing_offers(env: Env, listing_id: u64) -> Vec<u64> {
        load_listing_offers(&env, listing_id)
    }
    pub fn get_offerer_offers(env: Env, offerer: Address) -> Vec<u64> {
        load_offerer_offers(&env, &offerer)
    }
    /// Return the escrow record for a `(collection, token_id)` pair, if any.
    pub fn get_escrow(env: Env, collection: Address, token_id: u64)
        -> Option<crate::storage::EscrowRecord>
    {
        crate::storage::get_escrow_record(&env, &collection, token_id)
    }

    // ── Private helpers ──────────────────────────────────────

    fn require_admin(env: &Env) {
        let key = crate::storage::DataKey::Admin;
        let admin = env.storage().persistent()
            .get::<_, Address>(&key).expect("admin not set");
        admin.require_auth();
    }

    fn require_price_in_bounds(env: &Env, price: i128) {
        if let Some(min) = get_min_price_storage(env) {
            if price < min { panic_with_error!(env, MarketplaceError::PriceOutOfBounds); }
        }
        if let Some(max) = get_max_price_storage(env) {
            if price > max { panic_with_error!(env, MarketplaceError::PriceOutOfBounds); }
        }
    }

    fn require_not_paused(env: &Env) {
        if crate::storage::is_paused(env) {
            panic_with_error!(env, MarketplaceError::ContractPaused);
        }
    }

    fn require_not_revoked(env: &Env, artist: &Address) {
        if is_artist_revoked_storage(env, artist) {
            panic_with_error!(env, MarketplaceError::ArtistRevoked);
        }
    }

    fn is_token_whitelisted(env: &Env, token: &Address) -> bool {
        let key = crate::storage::DataKey::TokenWhitelist;
        let wl = env.storage().persistent()
            .get::<_, Vec<Address>>(&key).unwrap_or(Vec::new(env));
        if wl.is_empty() { true } else { wl.contains(token) }
    }

    fn validate_recipients(env: &Env, recipients: &Vec<Recipient>, protocol_fee_bps: u32) {
        let mut total: u32 = 0;
        for i in 0..recipients.len() {
            let bps = recipients.get(i).unwrap().percentage;
            total = total.checked_add(bps)
                .unwrap_or_else(|| panic_with_error!(env, MarketplaceError::RoyaltyExceedsLimit));
        }
        let combined = total.checked_add(protocol_fee_bps)
            .unwrap_or_else(|| panic_with_error!(env, MarketplaceError::RoyaltyExceedsLimit));
        if combined > 10_000 { panic_with_error!(env, MarketplaceError::RoyaltyExceedsLimit); }
    }

    #[allow(clippy::too_many_arguments)]
    fn distribute_payout(
        env: &Env, token_addr: &Address, collection_addr: &Address,
        amount: i128, seller: &Address, recipients: &Vec<Recipient>,
        buyer: &Address, transfer_from_buyer: bool, fee_bps: u32,
    ) -> i128 {
        let token = TokenClient::new(env, token_addr);
        if transfer_from_buyer {
            token.transfer(buyer, &env.current_contract_address(), &amount);
        }
        let mut payout = amount;
        let royalty_info: (Address, u32) = env.invoke_contract(
            collection_addr,
            &soroban_sdk::Symbol::new(env, "royalty_info"),
            soroban_sdk::vec![env],
        );
        let (royalty_receiver, royalty_bps) = royalty_info;
        if royalty_bps > 0 && royalty_receiver != *seller {
            let royalty = amount
                .checked_mul(royalty_bps as i128)
                .unwrap_or_else(|| panic_with_error!(env, MarketplaceError::ArithmeticOverflow))
                .checked_div(10_000)
                .unwrap_or_else(|| panic_with_error!(env, MarketplaceError::ArithmeticOverflow));
            token.transfer(&env.current_contract_address(), &royalty_receiver, &royalty);
            payout -= royalty;
        }
        let mut fee_collected: i128 = 0;
        if let Some(t) = crate::storage::get_treasury_storage(env) {
            let fee = payout * fee_bps as i128 / 10_000;
            if fee > 0 {
                token.transfer(&env.current_contract_address(), &t, &fee);
                fee_collected = fee;
            }
            payout -= fee;
        }
        let len = recipients.len();
        let mut ds = 0i128;
        for i in 0..len {
            let r = recipients.get(i).unwrap();
            let amt = if i == len - 1 {
                payout - ds
            } else {
                payout.checked_mul(r.percentage as i128)
                    .unwrap_or_else(|| panic_with_error!(env, MarketplaceError::ArithmeticOverflow))
                    .checked_div(10_000)
                    .unwrap_or_else(|| panic_with_error!(env, MarketplaceError::ArithmeticOverflow))
            };
            token.transfer(&env.current_contract_address(), &r.address, &amt);
            ds += amt;
        }
        fee_collected
    }
}
