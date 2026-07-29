// contract.rs — ELCARE-HUB Marketplace contract implementation
#[allow(unused_imports)]
use soroban_sdk::{
    contract, contractimpl, log, panic_with_error, token::Client as TokenClient,
    Address, Bytes, Env, IntoVal, Symbol, Vec,
};
use crate::events::*;
use crate::{
    escrow,
    storage::{
        active_listings_len, add_artist_auction_id,
        add_artist_listing_id, add_listing_offer_id, add_offerer_offer_id, add_pending_offer,
        add_to_active_listings, append_bid_record, bump_instance_ttl, clear_artist_cancel_cursor,
        clear_migration_progress, clear_pending_admin_storage, clear_pending_offers,
        get_active_listing_ids_range, get_artist_auction_ids,
        get_artist_cancel_cursor, get_artist_listing_ids, get_auction_count,
        get_auction_extension_trigger_storage, get_auction_extension_window_storage,
        get_auction_max_extensions_storage,
        get_bid_history_cap_storage, get_listing_count, get_max_price_storage,
        get_migration_progress, get_min_price_storage, get_pending_admin_storage,
        increment_auction_count, increment_listing_count, increment_offer_count,
        index_append, index_len,
        is_artist_revoked_storage, is_migration_done, load_auction, load_auction_bids,
        load_listing, load_listing_offers, load_offer, load_offerer_offers,
        load_pending_offer_ids, pending_offer_count, release_auction_lock,
        release_listing_lock, remove_artist_revocation_storage, remove_from_active_listings,
        remove_pending_offer, save_auction, save_listing, save_offer,
        set_artist_cancel_cursor, set_artist_revocation_storage,
        set_auction_extension_trigger_storage,
        set_auction_extension_window_storage, set_auction_max_extensions_storage,
        set_bid_history_cap_storage, set_max_price_storage, set_migration_done,
        set_migration_progress, set_min_price_storage, set_pending_admin_storage,
        take_legacy_index_vec, DataKey, IndexId, PendingAdminProposal, MAX_BID_HISTORY_CAP,
    },
    types::{
        Auction, AuctionStatus, BatchCreateListingInput, BatchUpdateListingInput, BidRecord,
        CancelReason, Listing, ListingStatus, MarketplaceError, Offer, OfferStatus, Recipient,
    },
};

/// Semantic version — bump on every breaking storage change.
const CONTRACT_VERSION: &str = "1.1.0";
const DEFAULT_MIN_BID_INCREMENT: i128 = 1;
const DEFAULT_EXTENSION_WINDOW: u64 = 600;
const DEFAULT_EXTENSION_TRIGGER: u64 = 0;

// ── Reentrancy RAII scopes (Issue #204) ───────────────────────────────────────
//
// These structs acquire the appropriate temporary-storage lock on construction
// and release it via Drop.  Using RAII ensures the guard is always cleared when
// the enclosing scope exits — whether via a normal return or a panic — providing
// defence-in-depth on top of Soroban's atomic rollback guarantee.
//
// Usage:
//   let _guard = ListingReentrancyScope::new(&env, listing_id)?;
//   // ... function body — guard is released automatically at end of scope ...
//
// Both structs hold the `Env` by value (cloned once) because Soroban `Env` is
// cheaply reference-counted and `Drop` must own everything it needs.

/// RAII guard for per-listing reentrancy protection.
/// Acquired by `buy_artwork` and `accept_offer`.
struct ListingReentrancyScope {
    env: Env,
    listing_id: u64,
}

impl ListingReentrancyScope {
    /// Attempt to acquire the listing lock.
    /// Returns `Ok(scope)` on success, or panics with `ReentrancyGuard` if the
    /// lock is already held.
    fn new(env: &Env, listing_id: u64) -> Self {
        if !crate::storage::acquire_listing_lock(env, listing_id) {
            panic_with_error!(env, MarketplaceError::ReentrancyGuard);
        }
        Self { env: env.clone(), listing_id }
    }
}

impl Drop for ListingReentrancyScope {
    fn drop(&mut self) {
        crate::storage::release_listing_lock(&self.env, self.listing_id);
    }
}

/// RAII guard for per-auction reentrancy protection.
/// Acquired by `finalize_auction`.
struct AuctionReentrancyScope {
    env: Env,
    auction_id: u64,
}

impl AuctionReentrancyScope {
    fn new(env: &Env, auction_id: u64) -> Self {
        if !crate::storage::acquire_auction_lock(env, auction_id) {
            panic_with_error!(env, MarketplaceError::ReentrancyGuard);
        }
        Self { env: env.clone(), auction_id }
    }
}

impl Drop for AuctionReentrancyScope {
    fn drop(&mut self) {
        crate::storage::release_auction_lock(&self.env, self.auction_id);
    }
}

/// Lifetime of a pending admin-rotation proposal, in seconds (7 days).
///
/// `transfer_admin` stamps each proposal with
/// `expires_at = env.ledger().timestamp() + ADMIN_PROPOSAL_TTL`.  Once that
/// deadline passes, `accept_admin` reverts with `AdminProposalExpired`, so a
/// proposal that is never accepted or cancelled cannot leave the contract in a
/// half-transferred governance state indefinitely.
const ADMIN_PROPOSAL_TTL: u64 = 604_800; // 7 days

/// Minimum auction duration in seconds (1 hour).
///
/// An auction whose computed `end_time = now + duration` would be less than
/// `MIN_AUCTION_DURATION` seconds in the future is rejected with
/// `InvalidAuctionDuration`.  This prevents meaningless or front-runnable
/// auctions that expire almost immediately.
const MIN_AUCTION_DURATION: u64 = 3_600; // 1 hour

/// Maximum number of listing ids accepted by one `cancel_listings` batch.
const MAX_BATCH_CANCEL: u32 = 10;

/// Hard ceiling on the number of records/ids any single bounded maintenance
/// call (`extend_active_ttls`, `cleanup_expired_locks`) will touch, applied
/// on top of (never relaxed by) whatever the caller passes as `max_items` /
/// however many ids they supply. Keeps a single maintenance transaction's
/// compute/read footprint bounded no matter what an admin requests.
/// (Issue #280)
const MAX_MAINTENANCE_ITEMS: u32 = 100;

const MAX_OFFERS_PER_LISTING: u32 = 50;

/// Maximum number of addresses one auction's blocked-bidder registry can hold
/// (Issue #199).  Bounds the per-auction `AuctionBlockedBidders` entry so the
/// `place_bid` membership scan and the storage footprint stay small.
const MAX_BLOCKED_BIDDERS: u32 = 50;

#[contract]
pub struct MarketplaceContract;

#[contractimpl]
impl MarketplaceContract {
    // ── Admin ────────────────────────────────────────────────

    pub fn set_admin(env: Env, admin: Address) {
        bump_instance_ttl(&env);
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

    /// Step 1 of the two-step admin rotation: the current admin proposes a
    /// candidate.  The proposal is stamped with an `expires_at` deadline
    /// (`now + ADMIN_PROPOSAL_TTL`); a second call overwrites any still-pending
    /// proposal (and its deadline) with the new candidate.
    pub fn transfer_admin(env: Env, current_admin: Address, new_admin: Address) {
        bump_instance_ttl(&env);
        current_admin.require_auth();
        let stored = Self::get_admin(env.clone())
            .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::Unauthorized));
        if current_admin != stored {
            panic_with_error!(&env, MarketplaceError::Unauthorized);
        }
        let expires_at = env.ledger().timestamp() + ADMIN_PROPOSAL_TTL;
        set_pending_admin_storage(
            &env,
            &PendingAdminProposal {
                candidate: new_admin.clone(),
                expires_at,
            },
        );
        emit_admin_proposed(&env, current_admin, new_admin, expires_at);
    }

    /// Step 2 of the two-step admin rotation: the proposed candidate accepts.
    ///
    /// Reverts with `NoAdminProposalPending` if no proposal is active,
    /// `Unauthorized` if the caller is not the proposed candidate, and
    /// `AdminProposalExpired` if the proposal's `expires_at` deadline has
    /// passed.
    pub fn accept_admin(env: Env, new_admin: Address) {
        bump_instance_ttl(&env);
        new_admin.require_auth();
        let pending = get_pending_admin_storage(&env)
            .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::NoAdminProposalPending));
        if new_admin != pending.candidate {
            panic_with_error!(&env, MarketplaceError::Unauthorized);
        }
        if env.ledger().timestamp() > pending.expires_at {
            panic_with_error!(&env, MarketplaceError::AdminProposalExpired);
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
        emit_admin_accepted(&env, old_admin, new_admin);
    }

    /// Cancel a still-pending admin proposal.  Callable only by the current
    /// admin.  Reverts with `NoAdminProposalPending` when no proposal is
    /// active, so cancelling is idempotent-by-error rather than silent.
    pub fn cancel_admin_proposal(env: Env, current_admin: Address) {
        bump_instance_ttl(&env);
        current_admin.require_auth();
        let stored = Self::get_admin(env.clone())
            .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::Unauthorized));
        if current_admin != stored {
            panic_with_error!(&env, MarketplaceError::Unauthorized);
        }
        let pending = get_pending_admin_storage(&env)
            .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::NoAdminProposalPending));
        clear_pending_admin_storage(&env);
        emit_admin_proposal_cancelled(&env, current_admin, pending.candidate);
    }

    /// View: the currently-pending admin proposal (candidate + `expires_at`),
    /// or `None` when no rotation is in progress.
    pub fn get_pending_admin(env: Env) -> Option<PendingAdminProposal> {
        get_pending_admin_storage(&env)
    }

    // ── Role-based authorization (Issue #267) ─────────────────
    //
    // Every privileged entry point below is owned by exactly one `RoleType`:
    // `ProtocolConfig` (price bounds, treasury, fees, bid/auction params),
    // `EmergencyPause` (global/collection/function circuit breakers),
    // `CollectionAdmin` (artist revocation/reinstatement, listing cleanup)
    // and `Upgrade` (storage/version migration). A role with no explicit
    // holder falls back to whoever holds `Admin`, so existing single-admin
    // deployments keep working unchanged until an operator opts in via
    // `migrate_roles` or a direct `propose_role_transfer` /
    // `accept_role_transfer`. Keeping `EmergencyPause` independently
    // assignable means an incident responder can still halt the marketplace
    // even if the (potentially slower, multisig-gated) `ProtocolConfig`
    // authority is unavailable or compromised.

    /// Resolve the current holder of `role`: its explicit holder if one has
    /// been assigned, otherwise the contract `Admin`.
    pub fn get_role(env: Env, role: RoleType) -> Address {
        get_role_storage(&env, &role)
            .unwrap_or_else(|| Self::get_admin(env.clone()).expect("admin not set"))
    }

    /// View: the currently-pending role-transfer proposal for `role`, or
    /// `None` when no rotation is in progress.
    pub fn get_pending_role(env: Env, role: RoleType) -> Option<PendingRoleProposal> {
        get_pending_role_storage(&env, &role)
    }

    /// Step 1 of the two-step role rotation: the current holder of `role`
    /// proposes a candidate. Mirrors `transfer_admin`'s TTL/overwrite
    /// semantics — a second call overwrites any still-pending proposal.
    pub fn propose_role_transfer(
        env: Env,
        current_authority: Address,
        role: RoleType,
        candidate: Address,
    ) {
        bump_instance_ttl(&env);
        current_authority.require_auth();
        let stored = Self::get_role(env.clone(), role.clone());
        if current_authority != stored {
            panic_with_error!(&env, MarketplaceError::Unauthorized);
        }
        let expires_at = env.ledger().timestamp() + ADMIN_PROPOSAL_TTL;
        set_pending_role_storage(
            &env,
            &role,
            &PendingRoleProposal {
                candidate: candidate.clone(),
                expires_at,
            },
        );
        emit_role_proposed(&env, role, current_authority, candidate, expires_at);
    }

    /// Step 2: the proposed candidate accepts and becomes the explicit
    /// holder of `role`. Reverts with `NoRoleProposalPending` if no proposal
    /// is active, `Unauthorized` if the caller is not the proposed candidate,
    /// and `RoleProposalExpired` if the proposal's deadline has passed —
    /// analogous to `accept_admin`.
    pub fn accept_role_transfer(env: Env, role: RoleType, candidate: Address) {
        bump_instance_ttl(&env);
        candidate.require_auth();
        let pending = get_pending_role_storage(&env, &role)
            .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::NoRoleProposalPending));
        if candidate != pending.candidate {
            panic_with_error!(&env, MarketplaceError::Unauthorized);
        }
        if env.ledger().timestamp() > pending.expires_at {
            panic_with_error!(&env, MarketplaceError::RoleProposalExpired);
        }
        let old_authority = Self::get_role(env.clone(), role.clone());
        set_role_storage(&env, &role, &candidate);
        clear_pending_role_storage(&env, &role);
        emit_role_accepted(&env, role, old_authority, candidate);
    }

    /// Cancel a still-pending role-transfer proposal. Callable only by the
    /// current holder of the role. Reverts with `NoRoleProposalPending` when
    /// no proposal is active.
    pub fn cancel_role_proposal(env: Env, current_authority: Address, role: RoleType) {
        bump_instance_ttl(&env);
        current_authority.require_auth();
        let stored = Self::get_role(env.clone(), role.clone());
        if current_authority != stored {
            panic_with_error!(&env, MarketplaceError::Unauthorized);
        }
        let pending = get_pending_role_storage(&env, &role)
            .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::NoRoleProposalPending));
        clear_pending_role_storage(&env, &role);
        emit_role_proposal_cancelled(&env, role, current_authority, pending.candidate);
    }

    /// Migration path for existing single-admin deployments (Issue #267):
    /// explicitly assigns `admin` as the holder of every role that does not
    /// yet have one, emitting `role_migrated` for each. Callable only by the
    /// current `Admin`.
    ///
    /// Idempotent: a role that already has an explicit holder (including one
    /// assigned by an earlier `migrate_roles` call, or one since transferred
    /// to a distinct authority) is left untouched, so re-running it is always
    /// safe.
    pub fn migrate_roles(env: Env, admin: Address) {
        bump_instance_ttl(&env);
        admin.require_auth();
        if admin != Self::get_admin(env.clone()).expect("admin not set") {
            panic_with_error!(&env, MarketplaceError::Unauthorized);
        }
        for role in [
            RoleType::ProtocolConfig,
            RoleType::EmergencyPause,
            RoleType::CollectionAdmin,
            RoleType::Upgrade,
        ] {
            if get_role_storage(&env, &role).is_none() {
                set_role_storage(&env, &role, &admin);
                emit_role_migrated(&env, role, admin.clone());
            }
        }
    }

    // ── Versioning & Migration ───────────────────────────────

    pub fn version(env: Env) -> soroban_sdk::String {
        soroban_sdk::String::from_str(&env, CONTRACT_VERSION)
    }

    /// Admin-guarded, idempotent storage migration entry point.
    ///
    /// # Idempotency
    /// The function records a per-version marker in persistent storage the
    /// first time it is called.  Subsequent calls for the *same* version
    /// revert with `AlreadyMigrated` so that accidental double-invocations
    /// during upgrade scripts are caught rather than silently re-executed.
    ///
    /// # Usage
    /// Upgrade scripts should:
    /// 1. Deploy the new WASM and invoke `migrate(admin)`.
    /// 2. Verify `version()` returns the expected string.
    /// 3. Any data back-fill should be performed inside this function body
    ///    for the specific version being migrated to.
    /// # 1.1.0 migration
    /// Transforms the legacy monolithic `Vec<u64>` index entries
    /// (ActiveListings, ArtistListings, ArtistAuctions, ListingOffers,
    /// OffererOffers) into fixed-capacity pages, and rebuilds the bounded
    /// per-listing pending-offer sets used for O(1) offer-cap enforcement.
    /// Legacy keys are deleted as they are consumed, so re-running a partial
    /// migration never duplicates entries.
    ///
    /// Run `migrate` immediately after the WASM upgrade (ideally while the
    /// contract is paused): index writes performed between the upgrade and the
    /// migration land in the paged storage first, so migrated legacy entries
    /// would be appended after them, deviating from strict creation order.
    ///
    /// For state too large to migrate in one transaction, use the bounded
    /// [`Self::migrate_step`] variant until it returns 0.
    pub fn migrate(env: Env, admin: Address) {
        bump_instance_ttl(&env);
        let version = Self::require_pending_migration(&env, &admin);
        // Unbounded budget: run every phase to completion in this invocation.
        Self::run_migration(&env, &version, u32::MAX);
    }

    /// Bounded, resumable variant of [`Self::migrate`]: processes at most
    /// `max_items` migration units (one listing, auction or offer each) and
    /// persists a cursor so the next call resumes where this one stopped.
    ///
    /// Returns the number of units still to process — call repeatedly until it
    /// returns `0`, at which point the migration marker is recorded and any
    /// further call (of this or `migrate`) reverts with `AlreadyMigrated`.
    pub fn migrate_step(env: Env, admin: Address, max_items: u32) -> u64 {
        bump_instance_ttl(&env);
        let version = Self::require_pending_migration(&env, &admin);
        Self::run_migration(&env, &version, max_items)
    }

    /// Common guard for `migrate`/`migrate_step`: admin auth + not-yet-migrated.
    fn require_pending_migration(env: &Env, admin: &Address) -> soroban_sdk::String {
        Self::require_role(env, admin, RoleType::Upgrade);
        let version = soroban_sdk::String::from_str(env, CONTRACT_VERSION);
        if is_migration_done(env, &version) {
            panic_with_error!(env, MarketplaceError::AlreadyMigrated);
        }
        version
    }

    /// Migration engine shared by `migrate` and `migrate_step`.
    ///
    /// Phases (each unit is one listing/auction/offer, so per-call work is
    /// strictly bounded by `budget`):
    ///   0. per listing: migrate the artist's legacy listing index and the
    ///      listing's legacy offer index; rebuild its pending-offer set.
    ///   1. per auction: migrate the creator's legacy auction index.
    ///   2. per offer:   migrate the offerer's legacy offer index.
    ///   3. move the legacy ActiveListings vector into pages + position keys.
    ///
    /// Returns the number of units remaining; records the completion marker
    /// (and drops the cursor) when everything has been processed.
    fn run_migration(env: &Env, version: &soroban_sdk::String, mut budget: u32) -> u64 {
        let mut p = get_migration_progress(env, version);
        let listing_count = get_listing_count(env);
        let auction_count = get_auction_count(env);
        let offer_count = crate::storage::get_offer_count(env);

        while budget > 0 {
            match p.phase {
                0 => {
                    if p.cursor >= listing_count {
                        p.phase = 1;
                        p.cursor = 0;
                        continue;
                    }
                    let listing_id = p.cursor + 1; // ids are 1-based
                    Self::migrate_listing_unit(env, listing_id);
                    p.cursor += 1;
                    budget -= 1;
                }
                1 => {
                    if p.cursor >= auction_count {
                        p.phase = 2;
                        p.cursor = 0;
                        continue;
                    }
                    let auction_id = p.cursor + 1;
                    if let Some(auction) = load_auction(env, auction_id) {
                        Self::migrate_legacy_index(
                            env,
                            &DataKey::ArtistAuctions(auction.creator.clone()),
                            &IndexId::ArtistAuctions(auction.creator),
                        );
                    }
                    p.cursor += 1;
                    budget -= 1;
                }
                2 => {
                    if p.cursor >= offer_count {
                        p.phase = 3;
                        p.cursor = 0;
                        continue;
                    }
                    let offer_id = p.cursor + 1;
                    if let Some(offer) = load_offer(env, offer_id) {
                        Self::migrate_legacy_index(
                            env,
                            &DataKey::OffererOffers(offer.offerer.clone()),
                            &IndexId::OffererOffers(offer.offerer),
                        );
                    }
                    p.cursor += 1;
                    budget -= 1;
                }
                3 => {
                    // The legacy active index is a single entry; reading it is
                    // the same cost the old code paid on every removal.
                    if let Some(ids) = take_legacy_index_vec(env, &DataKey::ActiveListings) {
                        for listing_id in ids.iter() {
                            add_to_active_listings(env, listing_id);
                        }
                    }
                    p.phase = 4;
                    budget -= 1;
                }
                _ => break,
            }
        }

        let remaining: u64 = match p.phase {
            0 => (listing_count - p.cursor) + auction_count + offer_count + 1,
            1 => (auction_count - p.cursor) + offer_count + 1,
            2 => (offer_count - p.cursor) + 1,
            3 => 1,
            _ => 0,
        };

        if remaining == 0 {
            clear_migration_progress(env, version);
            set_migration_done(env, version);
        } else {
            set_migration_progress(env, version, &p);
        }
        remaining
    }

    /// Phase-0 unit: migrate everything hanging off one listing.
    fn migrate_listing_unit(env: &Env, listing_id: u64) {
        let listing = match load_listing(env, listing_id) {
            Some(l) => l,
            None => return,
        };
        // The first listing of each artist migrates the artist's whole legacy
        // index; later listings find the legacy key already consumed.
        Self::migrate_legacy_index(
            env,
            &DataKey::ArtistListings(listing.artist.clone()),
            &IndexId::ArtistListings(listing.artist.clone()),
        );
        // Per-listing offer history + pending-offer set rebuild.
        if let Some(offer_ids) = take_legacy_index_vec(env, &DataKey::ListingOffers(listing_id)) {
            for offer_id in offer_ids.iter() {
                index_append(env, &IndexId::ListingOffers(listing_id), offer_id);
                if let Some(offer) = load_offer(env, offer_id) {
                    if offer.status == OfferStatus::Pending {
                        add_pending_offer(env, listing_id, offer_id);
                    }
                }
            }
        }
    }

    /// Move one legacy monolithic `Vec<u64>` entry into the paged index,
    /// deleting the legacy key.  No-op when the legacy key is absent.
    fn migrate_legacy_index(env: &Env, legacy: &DataKey, idx: &IndexId) {
        if let Some(ids) = take_legacy_index_vec(env, legacy) {
            for value in ids.iter() {
                index_append(env, idx, value);
            }
        }
    }

    // ── Price bounds ─────────────────────────────────────────

    pub fn set_price_bounds(env: Env, admin: Address, min: i128, max: i128) {
        bump_instance_ttl(&env);
        Self::require_role(&env, &admin, RoleType::ProtocolConfig);
        if min < 0 || max < 0 || min > max { panic_with_error!(&env, MarketplaceError::InvalidPrice); }
        set_min_price_storage(&env, min);
        set_max_price_storage(&env, max);
    }

    pub fn get_price_bounds(env: Env) -> (Option<i128>, Option<i128>) {
        (get_min_price_storage(&env), get_max_price_storage(&env))
    }

    // ── Treasury & Fees ──────────────────────────────────────

    pub fn set_treasury(env: Env, admin: Address, treasury: Address) {
        bump_instance_ttl(&env);
        Self::require_role(&env, &admin, RoleType::ProtocolConfig);
        crate::storage::set_treasury_storage(&env, &treasury);
    }

    pub fn get_treasury(env: Env) -> Option<Address> {
        crate::storage::get_treasury_storage(&env)
    }

    pub fn set_protocol_fee(env: Env, admin: Address, bps: u32) {
        bump_instance_ttl(&env);
        Self::require_role(&env, &admin, RoleType::ProtocolConfig);
        if bps > 1000 { panic_with_error!(&env, MarketplaceError::InvalidPrice); }
        crate::storage::set_protocol_fee_bps_storage(&env, bps);
    }

    pub fn get_protocol_fee(env: Env) -> u32 {
        crate::storage::get_protocol_fee_bps_storage(&env).unwrap_or(0)
    }

    // ── Per-collection fee overrides (Issue #322) ────────────────────────────

    /// Set a per-collection protocol fee override (admin-only).
    ///
    /// `bps` must be in 0–10 000 (100 %).  All new listings and auctions
    /// created for `collection` after this call will snapshot `bps` instead of
    /// the global protocol fee.  Existing listings/auctions are unaffected —
    /// they already captured their fee at creation time.
    pub fn set_collection_fee_bps(env: Env, admin: Address, collection: Address, bps: u32) {
        bump_instance_ttl(&env);
        admin.require_auth();
        if admin != Self::get_admin(env.clone()).expect("admin not set") {
            panic_with_error!(&env, MarketplaceError::Unauthorized);
        }
        if bps > 10_000 {
            panic_with_error!(&env, MarketplaceError::InvalidPrice);
        }
        set_collection_fee_bps_storage(&env, &collection, bps);
        crate::events::emit_collection_fee_set(&env, collection, bps);
    }

    /// Remove the per-collection fee override (admin-only).
    ///
    /// After this call, new listings and auctions for `collection` will fall
    /// back to the global protocol fee (`get_protocol_fee`).
    pub fn clear_collection_fee_bps(env: Env, admin: Address, collection: Address) {
        bump_instance_ttl(&env);
        admin.require_auth();
        if admin != Self::get_admin(env.clone()).expect("admin not set") {
            panic_with_error!(&env, MarketplaceError::Unauthorized);
        }
        clear_collection_fee_bps_storage(&env, &collection);
        crate::events::emit_collection_fee_cleared(&env, collection);
    }

    /// View: return the per-collection fee override (in bps) for `collection`,
    /// or `None` when no override is set (global fee applies).
    pub fn get_collection_fee_bps(env: Env, collection: Address) -> Option<u32> {
        get_collection_fee_bps_storage(&env, &collection)
    }

    pub fn set_min_bid_increment(env: Env, admin: Address, increment: i128) {
        bump_instance_ttl(&env);
        Self::require_role(&env, &admin, RoleType::ProtocolConfig);
        if increment < 0 { panic_with_error!(&env, MarketplaceError::InvalidPrice); }
        crate::storage::set_min_bid_increment_storage(&env, increment);
    }

    pub fn get_min_bid_increment(env: Env) -> i128 {
        crate::storage::get_min_bid_increment_storage(&env).unwrap_or(DEFAULT_MIN_BID_INCREMENT)
    }

    /// Set the global bid-history ring-buffer capacity.
    ///
    /// `cap` must be in the range 1–200 (enforced by `MAX_BID_HISTORY_CAP`).
    /// The new value is snapshotted into every *future* auction at creation
    /// time via `Auction::bid_history_cap`.  Already-running auctions keep
    /// their original cap for the lifetime of the auction so that no in-flight
    /// bid is silently evicted by a retroactive shrink.
    ///
    /// # Ring-buffer eviction — O(n) shift
    /// `append_bid_record` (storage.rs) uses a plain `Vec<BidRecord>` as the
    /// ring buffer.  When the history is full it removes the front element
    /// with `Vec::remove(0)`, which shifts every remaining element down by one
    /// position — O(n) in the cap.  This is acceptable because:
    ///  • `cap` is bounded to 200 entries.
    ///  • A 200-entry shift operates on stack-local XDR values; no additional
    ///    ledger-entry reads are needed.
    ///  • `place_bid` is called at most once per ledger, so the amortised cost
    ///    per auction is negligible.
    /// If a future version needs O(1) eviction, the ring buffer can be replaced
    /// with an indexed page (write-head pointer in instance storage).
    pub fn set_bid_history_cap(env: Env, admin: Address, cap: u32) {
        bump_instance_ttl(&env);
        Self::require_role(&env, &admin, RoleType::ProtocolConfig);
        if cap == 0 || cap > MAX_BID_HISTORY_CAP {
            panic_with_error!(&env, MarketplaceError::InvalidPrice);
        }
        set_bid_history_cap_storage(&env, cap);
    }

    pub fn get_bid_history_cap(env: Env) -> u32 {
        get_bid_history_cap_storage(&env)
    }

    pub fn set_auction_extension_window(env: Env, admin: Address, window: u64) {
        bump_instance_ttl(&env);
        Self::require_role(&env, &admin, RoleType::ProtocolConfig);
        set_auction_extension_window_storage(&env, window);
    }

    pub fn get_auction_extension_window(env: Env) -> u64 {
        get_auction_extension_window_storage(&env).unwrap_or(DEFAULT_EXTENSION_WINDOW)
    }

    pub fn set_auction_extension_trigger(env: Env, admin: Address, trigger: u64) {
        bump_instance_ttl(&env);
        Self::require_role(&env, &admin, RoleType::ProtocolConfig);
        set_auction_extension_trigger_storage(&env, trigger);
    }

    pub fn get_auction_extension_trigger(env: Env) -> u64 {
        get_auction_extension_trigger_storage(&env).unwrap_or(DEFAULT_EXTENSION_TRIGGER)
    }

    /// Set the global cap on how many times a single auction may be extended by
    /// the anti-sniping logic.  0 = unlimited (default).
    /// Snapshotted into each new auction at creation time.
    pub fn set_auction_max_extensions(env: Env, admin: Address, max: u32) {
        bump_instance_ttl(&env);
        Self::require_role(&env, &admin, RoleType::ProtocolConfig);
        set_auction_max_extensions_storage(&env, max);
    }

    pub fn get_auction_max_extensions(env: Env) -> u32 {
        get_auction_max_extensions_storage(&env)
    }

    // ── Pause ────────────────────────────────────────────────

    pub fn admin_pause(env: Env, admin: Address) {
        Self::require_role(&env, &admin, RoleType::EmergencyPause);
        crate::storage::set_paused(&env, true);
        #[allow(deprecated)]
        env.events().publish((crate::events::CONTRACT_PAUSED,), ());
    }

    pub fn admin_unpause(env: Env, admin: Address) {
        Self::require_role(&env, &admin, RoleType::EmergencyPause);
        crate::storage::set_paused(&env, false);
        #[allow(deprecated)]
        env.events().publish((crate::events::CONTRACT_UNPAUSED,), ());
    }

    pub fn is_paused(env: Env) -> bool {
        crate::storage::is_paused(&env)
    }

    // ── Granular circuit-breakers (Issue #205) ───────────────
    //
    // Three independent axes of pause control:
    //   1. Global (admin_pause / admin_unpause — existing)
    //   2. Per-collection (pause_collection / unpause_collection)
    //   3. Per-function   (pause_function / unpause_function)
    //
    // Any active axis blocks the affected operations.  Global pause
    // still blocks everything; collection and function pauses are
    // additive narrow restrictions layered on top.
    //
    // ── State-transition matrix (narrowly-scoped emergency pause) ──
    //
    // A pause is meant to stop *new* risk exposure, not trap funds or NFTs
    // that are already committed to the contract.  Every public entry point
    // falls into exactly one of the two buckets below.
    //
    // Blocked when paused (subject to global / collection / function axes,
    // via `require_not_paused` or `require_not_paused_ctx`) — these create
    // new exposure (new escrow, new payment flow, new price commitment):
    //   - create_listing        (collection + function axis)
    //   - update_listing        (global axis)
    //   - update_listing_price  (global axis)
    //   - buy_artwork           (collection + function axis)
    //   - create_auction        (collection + function axis)
    //   - place_bid             (collection + function axis)
    //   - make_offer            (collection + function axis)
    //   - accept_offer          (global axis — a purchase-like state
    //                            transition, not fund recovery, so it stays
    //                            gated like buy_artwork)
    //
    // Always available regardless of pause state (fund recovery / cleanup —
    // these return escrowed tokens or NFTs to their rightful owner, or tidy
    // up state that is already terminal/expired, so blocking them would trap
    // user funds during exactly the incident a pause is meant to contain):
    //   - cancel_listing            (artist reclaims NFT from escrow)
    //   - cancel_listings           (batch form of the above)
    //   - cancel_artist_listings    (admin-driven revocation cleanup sweep)
    //   - expire_listing            (permissionless; already unguarded)
    //   - cancel_auction            (creator reclaims NFT, no-bid only)
    //   - finalize_auction          (settles an already-ended auction —
    //                                explicitly called out by the issue)
    //   - admin_cancel_auction      (admin emergency unwind + bidder refund)
    //   - withdraw_offer            (offerer reclaims escrowed funds)
    //   - reject_offer              (artist rejects offer, funds return to
    //                                the offerer)
    //   - reclaim_offer             (offerer reclaims funds from an offer
    //                                that expired without action)
    //
    // These cleanup paths deliberately skip *all three* pause axes (global,
    // collection, function) — they exist precisely so a paused incident
    // doesn't also freeze user funds/state in limbo.

    /// Pause all operations for a specific collection.
    pub fn pause_collection(env: Env, admin: Address, collection: Address) {
        bump_instance_ttl(&env);
        Self::require_role(&env, &admin, RoleType::EmergencyPause);
        crate::storage::set_collection_paused(&env, &collection, true);
        crate::events::emit_collection_paused(&env, collection);
    }

    /// Resume all operations for a previously paused collection.
    pub fn unpause_collection(env: Env, admin: Address, collection: Address) {
        bump_instance_ttl(&env);
        Self::require_role(&env, &admin, RoleType::EmergencyPause);
        crate::storage::set_collection_paused(&env, &collection, false);
        crate::events::emit_collection_unpaused(&env, collection);
    }

    /// Return whether a specific collection is individually paused.
    pub fn is_collection_paused(env: Env, collection: Address) -> bool {
        crate::storage::is_collection_paused(&env, &collection)
    }

    /// Pause a specific entry-point by its function name symbol.
    /// Valid names: "buy_artwork", "create_listing", "place_bid",
    ///              "create_auction", "make_offer", "accept_offer".
    pub fn pause_function(env: Env, admin: Address, function_name: Symbol) {
        bump_instance_ttl(&env);
        Self::require_role(&env, &admin, RoleType::EmergencyPause);
        crate::storage::set_function_paused(&env, &function_name, true);
        crate::events::emit_function_paused(&env, function_name);
    }

    /// Resume a previously paused entry-point.
    pub fn unpause_function(env: Env, admin: Address, function_name: Symbol) {
        bump_instance_ttl(&env);
        Self::require_role(&env, &admin, RoleType::EmergencyPause);
        crate::storage::set_function_paused(&env, &function_name, false);
        crate::events::emit_function_unpaused(&env, function_name);
    }

    /// Return whether a specific function is individually paused.
    pub fn is_function_paused(env: Env, function_name: Symbol) -> bool {
        crate::storage::is_function_paused(&env, &function_name)
    }

    // ── Artist Moderation ────────────────────────────────────

    /// Revoke an artist and immediately begin cascading cleanup.
    ///
    /// On the first call (or after a reinstate → re-revoke cycle) the function:
    ///   1. Marks the artist as revoked in storage.
    ///   2. Iterates up to `REVOCATION_CLEANUP_CAP` active listings owned by
    ///      the artist, cancelling each (offer refunds + escrow return).
    ///   3. Continues iterating into the artist's auctions (within the same
    ///      budget), cancelling each and refunding the current highest bidder.
    ///   4. Emits `ArtistRevokedEvent` and, when items remain, a
    ///      `RevocationIncompleteEvent` so the caller knows to invoke again.
    ///
    /// Subsequent calls advance the cursor until all items are processed.
    /// The function is idempotent: calling it on an already-revoked artist with
    /// no remaining items is a no-op.
    pub fn revoke_artist(env: Env, artist: Address) {
        bump_instance_ttl(&env);
        Self::require_role_auth(&env, RoleType::CollectionAdmin);
        set_artist_revocation_storage(&env, &artist);

        // Emit the revocation event using the typed struct (not the raw address).
        ArtistRevokedEvent { artist: artist.clone() }.publish(&env);

        // ── Cascade: cancel listings ─────────────────────────────────────────
        let admin = {
            let key = crate::storage::DataKey::Admin;
            env.storage().persistent()
                .get::<_, Address>(&key)
                .expect("admin not set")
        };

        let listing_idx = IndexId::ArtistListings(artist.clone());
        let listing_total = index_len(&env, &listing_idx);
        let mut cursor = crate::storage::get_artist_cancel_cursor(&env, &artist);
        let mut budget = REVOCATION_CLEANUP_CAP;

        // Phase 1 — listings
        while cursor < listing_total && budget > 0 {
            let listing_id = crate::storage::index_get(&env, &listing_idx, cursor).unwrap();
            cursor += 1;
            budget -= 1;
            if let Some(mut listing) = load_listing(&env, listing_id) {
                if listing.status == ListingStatus::Active {
                    // Refund all pending offers
                    for offer_id in load_pending_offer_ids(&env, listing_id).iter() {
                        if let Some(mut offer) = load_offer(&env, offer_id) {
                            if offer.status == OfferStatus::Pending {
                                offer.status = OfferStatus::Rejected;
                                save_offer(&env, &offer);
                                TokenClient::new(&env, &offer.token).transfer(
                                    &env.current_contract_address(),
                                    &offer.offerer,
                                    &offer.amount,
                                );
                            }
                        }
                    }
                    clear_pending_offers(&env, listing_id);
                    listing.status = ListingStatus::Cancelled;
                    save_listing(&env, &listing);
                    remove_from_active_listings(&env, listing_id);
                    ListingCancelledEvent {
                        listing_id,
                        cancelled_by: admin.clone(),
                        reason: CancelReason::AdminRevoked,
                        ledger_sequence: env.ledger().sequence(),
                    }.publish(&env);
                    escrow::release_nft(
                        &env, &listing.collection, listing.token_id,
                        &listing.artist, env.ledger().sequence(), listing_id,
                    );
                }
            }
        }
        set_artist_cancel_cursor(&env, &artist, cursor);

        // Phase 2 — auctions (within remaining budget)
        let auction_idx = IndexId::ArtistAuctions(artist.clone());
        let auction_total = index_len(&env, &auction_idx);
        let mut auction_cursor = crate::storage::get_artist_auction_cancel_cursor(&env, &artist);

        while auction_cursor < auction_total && budget > 0 {
            let auction_id = crate::storage::index_get(&env, &auction_idx, auction_cursor).unwrap();
            auction_cursor += 1;
            budget -= 1;
            if let Some(mut auction) = load_auction(&env, auction_id) {
                if auction.status == AuctionStatus::Active {
                    // Refund current highest bidder if any
                    if let Some(ref bidder) = auction.highest_bidder.clone() {
                        let refund = auction.highest_bid;
                        if refund > 0 {
                            TokenClient::new(&env, &auction.token).transfer(
                                &env.current_contract_address(),
                                bidder,
                                &refund,
                            );
                            AuctionBidRefundedEvent {
                                auction_id,
                                bidder: bidder.clone(),
                                amount: refund,
                                token: auction.token.clone(),
                                reason: Symbol::new(&env, "admin_revoke"),
                                ledger_sequence: env.ledger().sequence(),
                            }.publish(&env);
                        }
                    }
                    auction.status = AuctionStatus::Cancelled;
                    save_auction(&env, &auction);
                    AuctionCancelledEvent {
                        auction_id,
                        cancelled_by: admin.clone(),
                        reason: Symbol::new(&env, "admin_revoke"),
                    }.publish(&env);
                    escrow::release_nft(
                        &env, &auction.collection, auction.token_id,
                        &auction.creator, env.ledger().sequence(), auction_id,
                    );
                }
            }
        }
        crate::storage::set_artist_auction_cancel_cursor(&env, &artist, auction_cursor);

        // ── Emit incomplete signal if items remain ───────────────────────────
        let listings_remaining = listing_total.saturating_sub(cursor) as u64;
        let auctions_remaining = auction_total.saturating_sub(auction_cursor) as u64;
        let total_remaining = listings_remaining + auctions_remaining;
        if total_remaining > 0 {
            RevocationIncompleteEvent {
                artist: artist.clone(),
                remaining: total_remaining,
                ledger_sequence: env.ledger().sequence(),
            }.publish(&env);
        }
    }

    pub fn reinstate_artist(env: Env, artist: Address) {
        bump_instance_ttl(&env);
        Self::require_role_auth(&env, RoleType::CollectionAdmin);
        remove_artist_revocation_storage(&env, &artist);
        // Clear any in-progress revocation cursors on reinstatement
        crate::storage::clear_artist_cancel_cursor(&env, &artist);
        crate::storage::clear_artist_auction_cancel_cursor(&env, &artist);
        ArtistReinstatedEvent { artist }.publish(&env);
    }

    pub fn is_artist_revoked(env: Env, artist: Address) -> bool {
        is_artist_revoked_storage(&env, &artist)
    }

    /// Cancel the active listings of a revoked artist — batched and resumable.
    ///
    /// Called by the admin after revoking an artist to clean up their active
    /// listings.  Processes at most `max_items` of the artist's listings per
    /// invocation (bounding the per-transaction read/write footprint for a
    /// prolific artist) and persists a cursor so the next call resumes where
    /// this one stopped.  Per cancelled listing the semantics are unchanged:
    /// every pending offer is refunded and rejected first, then the listing is
    /// cancelled and a ListingCancelledEvent with reason=AdminRevoked is
    /// emitted.
    ///
    /// Returns the number of the artist's listings still to process — call
    /// repeatedly until it returns `0`.  Calling it for a non-revoked artist
    /// does nothing and returns `0`.
    pub fn cancel_artist_listings(env: Env, admin: Address, artist: Address, max_items: u32) -> u64 {
        bump_instance_ttl(&env);
        Self::require_role(&env, &admin, RoleType::CollectionAdmin);

        // Only cancel listings if the artist is actually revoked.  A stale
        // cursor from an interrupted sweep is dropped so a later re-revocation
        // starts from the beginning (new listings may have appeared since).
        if !is_artist_revoked_storage(&env, &artist) {
            clear_artist_cancel_cursor(&env, &artist);
            return 0;
        }

        let idx = IndexId::ArtistListings(artist.clone());
        let total = index_len(&env, &idx);
        let mut cursor = get_artist_cancel_cursor(&env, &artist);
        let end = cursor.saturating_add(max_items).min(total);

        while cursor < end {
            let listing_id = crate::storage::index_get(&env, &idx, cursor).unwrap();
            cursor += 1;
            if let Some(mut listing) = load_listing(&env, listing_id) {
                if listing.status == ListingStatus::Active {
                    // Refund-then-cancel: sweep the bounded pending-offer set.
                    for offer_id in load_pending_offer_ids(&env, listing_id).iter() {
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
                    clear_pending_offers(&env, listing_id);

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

        // The cursor is kept at `total` once the sweep completes: repeat calls
        // are then true no-ops, and listings created after a reinstate/
        // re-revoke cycle append behind the cursor so only they get swept.
        set_artist_cancel_cursor(&env, &artist, cursor);
        (total - cursor) as u64
    }

    /// Batch-cancel up to `MAX_BATCH_CANCEL` of the caller's own listings in a
    /// single invocation.  Strict all-or-nothing semantics: every id must
    /// exist, be owned by `owner` and still be Active, otherwise the whole
    /// call reverts.  Per listing the refund-then-cancel semantics match
    /// `cancel_listing`.  Returns the number of listings cancelled.
    pub fn cancel_listings(env: Env, owner: Address, listing_ids: Vec<u64>) -> u32 {
        bump_instance_ttl(&env);
        // Fund-recovery / cleanup op — always available, ignores all pause axes.
        owner.require_auth();

        if listing_ids.len() > MAX_BATCH_CANCEL {
            panic_with_error!(&env, MarketplaceError::BatchTooLarge);
        }

        for listing_id in listing_ids.iter() {
            Self::cancel_listing_inner(&env, &owner, listing_id);
        }

        listing_ids.len()
    }

    // ── Bounded storage maintenance (Issue #280) ─────────────
    //
    // Two admin-only, bounded-per-call entry points. Neither ever deletes a
    // Listing, Auction or Offer record — see the retention classification
    // at the top of `storage.rs` and `docs/guides/storage-retention.md` for
    // the full policy. Both emit `CleanupSummaryEvent` so an indexer/keeper
    // can observe how much maintenance work actually happened each call.

    /// Bounded, resumable TTL-refresh sweep over the live (non-terminal)
    /// record set: Active listings (+ their Pending offers) and Active
    /// auctions (+ their bid history).
    ///
    /// Every read/write this contract performs already re-extends the TTL
    /// of the record it touches (`storage::bump_entry_ttl` call sites), so a
    /// frequently-used listing or auction never silently expires. This
    /// sweep defends against the opposite case: an Active listing or
    /// auction nobody has read or interacted with recently, whose TTL can
    /// lapse invisibly and make it unexpectedly unavailable to the indexer
    /// or frontend even though it is still logically live.
    ///
    /// Processes at most `max_items` records this call, hard-capped at
    /// `MAX_MAINTENANCE_ITEMS` regardless of the argument, and persists a
    /// `TtlSweepProgress` cursor so repeated calls make forward progress.
    /// The sweep is a perpetual cycle (phase 0 = `ActiveListings` index,
    /// phase 1 = sequential auction ids, then wraps back to phase 0) — as
    /// long as at least one listing or auction is Active, later calls will
    /// always find something to refresh. Unlike `migrate_step` this is not
    /// a one-shot drain; it is meant to be invoked periodically forever by
    /// an operator/keeper process.
    ///
    /// Never touches a terminal (Sold/Cancelled/Finalized) record — those
    /// are deliberately left to fall out of TTL so Soroban's own archival
    /// mechanism takes over, since the contract never deletes historical
    /// listing/auction/offer data. If the sweep finds an id still present
    /// in the `ActiveListings` index or auction id space whose stored
    /// status is no longer Active (or the record is missing), it emits a
    /// `TtlAnomalyEvent` instead of silently doing nothing, surfacing the
    /// index/state drift rather than hiding it.
    ///
    /// Returns the number of records actually refreshed this call.
    pub fn extend_active_ttls(env: Env, admin: Address, max_items: u32) -> u32 {
        bump_instance_ttl(&env);
        admin.require_auth();
        if admin != Self::get_admin(env.clone()).expect("admin not set") {
            panic_with_error!(&env, MarketplaceError::Unauthorized);
        }

        let budget_cap = max_items.min(MAX_MAINTENANCE_ITEMS);
        let total_listings = active_listings_len(&env);
        let total_auctions = get_auction_count(&env);
        if budget_cap == 0 || (total_listings == 0 && total_auctions == 0) {
            return 0;
        }

        let mut progress = get_ttl_sweep_progress(&env);
        let mut processed: u32 = 0;
        // Bounds the number of phase-0/phase-1 toggles when one side of the
        // sweep is empty, so the loop can never spin forever without making
        // progress (each toggle is O(1); two full toggles are always enough
        // to reach whichever side has work).
        let mut toggles: u32 = 0;

        while processed < budget_cap && toggles < 4 {
            if progress.phase == 0 {
                if total_listings == 0 || progress.cursor >= total_listings as u64 {
                    progress.phase = 1;
                    progress.cursor = 0;
                    toggles += 1;
                    continue;
                }
                let pos = progress.cursor as u32;
                if let Some(listing_id) = index_get(&env, &IndexId::ActiveListings, pos) {
                    match load_listing(&env, listing_id) {
                        Some(listing) if listing.status == ListingStatus::Active => {
                            // `load_listing` already bumped the listing's own
                            // TTL; also refresh every Pending offer hanging
                            // off it (bounded, ≤ MAX_OFFERS_PER_LISTING).
                            for offer_id in load_pending_offer_ids(&env, listing_id).iter() {
                                load_offer(&env, offer_id);
                            }
                        }
                        _ => {
                            TtlAnomalyEvent {
                                subject: Symbol::new(&env, "listing"),
                                id: listing_id,
                                ledger_sequence: env.ledger().sequence(),
                            }
                            .publish(&env);
                        }
                    }
                }
                progress.cursor += 1;
                processed += 1;
            } else {
                if total_auctions == 0 || progress.cursor >= total_auctions {
                    progress.phase = 0;
                    progress.cursor = 0;
                    toggles += 1;
                    continue;
                }
                let auction_id = progress.cursor + 1; // ids are 1-based
                match load_auction(&env, auction_id) {
                    Some(auction) if auction.status == AuctionStatus::Active => {
                        // `load_auction` already bumped the auction's own
                        // TTL; also refresh its bid history if any.
                        load_auction_bids(&env, auction_id);
                    }
                    Some(_) => {} // terminal — intentionally left alone
                    None => {
                        TtlAnomalyEvent {
                            subject: Symbol::new(&env, "auction"),
                            id: auction_id,
                            ledger_sequence: env.ledger().sequence(),
                        }
                        .publish(&env);
                    }
                }
                progress.cursor += 1;
                processed += 1;
            }
        }

        set_ttl_sweep_progress(&env, &progress);
        CleanupSummaryEvent {
            kind: Symbol::new(&env, "ttl_extend"),
            items_processed: processed,
            ledger_sequence: env.ledger().sequence(),
        }
        .publish(&env);
        processed
    }

    /// Bounded admin safety-valve that force-clears reentrancy locks for the
    /// given listing/auction ids.
    ///
    /// `ListingLock`/`AuctionLock` live in *temporary* storage with a short
    /// TTL (`REENTRANCY_LOCK_TTL` ledgers) and are already released on every
    /// normal exit path of every function that acquires one; a panic
    /// mid-call rolls back the whole transaction (including the lock
    /// write), so it can never leak a lock either. Under normal operation
    /// Soroban's own temporary-storage expiry reclaims any lock this
    /// contract somehow failed to release. This entry point exists purely
    /// as an operator-triggered safety valve for a stuck lock spotted
    /// off-chain — it is a no-op (and safe to retry) for any id whose lock
    /// is already absent, so calling it again with nothing left to clear
    /// just returns 0.
    ///
    /// `listing_ids` and `auction_ids` are processed in that order up to a
    /// combined `MAX_MAINTENANCE_ITEMS`; ids past the cap are silently
    /// ignored rather than causing the whole call to revert. Returns the
    /// number of locks actually found and cleared.
    pub fn cleanup_expired_locks(
        env: Env,
        admin: Address,
        listing_ids: Vec<u64>,
        auction_ids: Vec<u64>,
    ) -> u32 {
        bump_instance_ttl(&env);
        admin.require_auth();
        if admin != Self::get_admin(env.clone()).expect("admin not set") {
            panic_with_error!(&env, MarketplaceError::Unauthorized);
        }

        let mut cleared: u32 = 0;
        let mut budget = MAX_MAINTENANCE_ITEMS;

        for listing_id in listing_ids.iter() {
            if budget == 0 {
                break;
            }
            budget -= 1;
            let key = DataKey::ListingLock(listing_id);
            if env.storage().temporary().has(&key) {
                release_listing_lock(&env, listing_id);
                cleared += 1;
            }
        }
        for auction_id in auction_ids.iter() {
            if budget == 0 {
                break;
            }
            budget -= 1;
            let key = DataKey::AuctionLock(auction_id);
            if env.storage().temporary().has(&key) {
                release_auction_lock(&env, auction_id);
                cleared += 1;
            }
        }

        CleanupSummaryEvent {
            kind: Symbol::new(&env, "lock_cleanup"),
            items_processed: cleared,
            ledger_sequence: env.ledger().sequence(),
        }
        .publish(&env);
        cleared
    }

    /// Permissionless TTL renewal entry-point (Issue #280).
    ///
    /// Anyone may call this to bump the TTLs of the specified listings, auctions,
    /// and offers. This enables external keeper processes to maintain critical
    /// storage entries before they expire. The function is bounded by
    /// `MAX_MAINTENANCE_ITEMS` to prevent abuse, and only renews entries that
    /// actually exist (missing ids are silently skipped).
    ///
    /// Returns the number of entries actually renewed.
    pub fn renew_storage(
        env: Env,
        listing_ids: Vec<u64>,
        auction_ids: Vec<u64>,
        offer_ids: Vec<u64>,
    ) -> u32 {
        bump_instance_ttl(&env);
        let mut renewed: u32 = 0;
        let budget = MAX_MAINTENANCE_ITEMS;

        // Renew listings
        for listing_id in listing_ids.iter().take(budget as usize) {
            if load_listing(&env, listing_id).is_some() {
                crate::storage::bump_listing_ttl(&env, listing_id);
                renewed += 1;
            }
        }

        // Renew auctions (remaining budget)
        let remaining = budget - renewed;
        for auction_id in auction_ids.iter().take(remaining as usize) {
            if load_auction(&env, auction_id).is_some() {
                crate::storage::bump_auction_ttl(&env, auction_id);
                renewed += 1;
            }
        }

        // Renew offers (remaining budget)
        let remaining = budget - renewed;
        for offer_id in offer_ids.iter().take(remaining as usize) {
            if load_offer(&env, offer_id).is_some() {
                crate::storage::bump_offer_ttl(&env, offer_id);
                renewed += 1;
            }
        }

        CleanupSummaryEvent {
            kind: Symbol::new(&env, "storage_renewal"),
            items_processed: renewed,
            ledger_sequence: env.ledger().sequence(),
        }
        .publish(&env);
        renewed
    }

    // ── Token Whitelist ──────────────────────────────────────

    pub fn add_token_to_whitelist(env: Env, token: Address) {
        bump_instance_ttl(&env);
        Self::require_admin(&env);
        // Boundary validation (Issue #282): reject the marketplace's own
        // address before it can ever land in the whitelist. Decimals/asset
        // identity for the token are the off-chain registry's job (see
        // `validate_token_asset` doc comment); this is deliberately a cheap,
        // on-chain-only sanity check.
        Self::validate_token_asset(&env, &token, None);
        let key = crate::storage::DataKey::TokenWhitelist;
        let mut wl = env.storage().persistent()
            .get::<_, Vec<Address>>(&key).unwrap_or(Vec::new(&env));
        // Idempotent by design: re-whitelisting an already-present token is a
        // no-op rather than an error, so an admin re-running a setup script
        // can never accidentally create duplicate entries.
        if !wl.contains(&token) { wl.push_back(token); env.storage().persistent().set(&key, &wl); }
    }

    pub fn remove_token_from_whitelist(env: Env, token: Address) {
        bump_instance_ttl(&env);
        Self::require_role_auth(&env, RoleType::ProtocolConfig);
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
        bump_instance_ttl(&env);
        Self::require_not_paused_ctx(
            &env,
            Some(&collection),
            Some(&Symbol::new(&env, "create_listing")),
        );
        artist.require_auth();
        Self::require_not_revoked(&env, &artist);
        Self::create_listing_inner(
            &env,
            &artist,
            price,
            currency,
            token,
            collection,
            token_id,
            recipients,
            expires_at,
        )
    }

    pub fn create_listings(
        env: Env, artist: Address, requests: Vec<BatchCreateListingInput>,
    ) -> Vec<u64> {
        bump_instance_ttl(&env);
        artist.require_auth();
        Self::require_not_revoked(&env, &artist);

        let mut listing_ids = Vec::new(&env);
        for request in requests.iter() {
            Self::require_not_paused_ctx(
                &env,
                Some(&request.collection),
                Some(&Symbol::new(&env, "create_listing")),
            );
            let listing_id = Self::create_listing_inner(
                &env,
                &artist,
                request.price,
                request.currency.clone(),
                request.token.clone(),
                request.collection.clone(),
                request.token_id,
                request.recipients.clone(),
                request.expires_at,
            );
            listing_ids.push_back(listing_id);
        }
        listing_ids
    }

    // update_listing — no NFT movement; NFT stays in escrow unchanged
    pub fn update_listing(
        env: Env, artist: Address, listing_id: u64,
        new_price: i128, new_token: Address, new_recipients: Vec<Recipient>,
    ) -> bool {
        bump_instance_ttl(&env);
        Self::require_not_paused(&env);
        artist.require_auth();
        Self::update_listing_inner(&env, &artist, listing_id, new_price, new_token, new_recipients)
    }

    pub fn update_listings(
        env: Env, artist: Address, requests: Vec<BatchUpdateListingInput>,
    ) -> Vec<bool> {
        bump_instance_ttl(&env);
        Self::require_not_paused(&env);
        artist.require_auth();

        let mut results = Vec::new(&env);
        for request in requests.iter() {
            let ok = Self::update_listing_inner(
                &env,
                &artist,
                request.listing_id,
                request.new_price,
                request.new_token.clone(),
                request.new_recipients.clone(),
            );
            results.push_back(ok);
        }
        results
    }

    pub fn update_listing_price(env: Env, seller: Address, listing_id: u64, new_price: i128) -> bool {
        bump_instance_ttl(&env);
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
    //   6. unlock (automatic via ListingReentrancyScope::drop)
    pub fn buy_artwork(env: Env, buyer: Address, listing_id: u64) -> bool {
        bump_instance_ttl(&env);
        // Function-level circuit-breaker (cheap, before any storage reads).
        Self::require_not_paused_ctx(&env, None, Some(&Symbol::new(&env, "buy_artwork")));
        buyer.require_auth();
        if !acquire_listing_lock(&env, listing_id) {
            panic_with_error!(&env, MarketplaceError::ReentrancyGuard);
        }
        let mut listing = match load_listing(&env, listing_id) {
            Some(l) => l,
            None => { release_listing_lock(&env, listing_id);
                      panic_with_error!(&env, MarketplaceError::ListingNotFound); }
        };
        // Collection-level circuit-breaker (after loading listing).
        if crate::storage::is_collection_paused(&env, &listing.collection) {
            release_listing_lock(&env, listing_id);
            panic_with_error!(&env, MarketplaceError::ContractPaused);
        }
        if listing.status == ListingStatus::Sold {
            panic_with_error!(&env, MarketplaceError::ListingSold);
        }
        if listing.status == ListingStatus::Cancelled {
            panic_with_error!(&env, MarketplaceError::ListingCancelled);
        }
        if listing.status != ListingStatus::Active {
            panic_with_error!(&env, MarketplaceError::ListingNotActive);
        }
        if listing.artist == buyer {
            panic_with_error!(&env, MarketplaceError::SelfPurchaseNotAllowed);
        }
        if let Some(ref o) = listing.owner {
            if *o == buyer {
                panic_with_error!(&env, MarketplaceError::SelfPurchaseNotAllowed);
            }
        }
        if let Some(exp) = listing.expires_at {
            if env.ledger().timestamp() >= exp {
                listing.status = ListingStatus::Cancelled;
                save_listing(&env, &listing);
                remove_from_active_listings(&env, listing_id);
                for offer_id in load_pending_offer_ids(&env, listing_id).iter() {
                    if let Some(mut offer) = load_offer(&env, offer_id) {
                        if offer.status == OfferStatus::Pending {
                            offer.status = OfferStatus::Rejected;
                            save_offer(&env, &offer);
                            TokenClient::new(&env, &offer.token).transfer(
                                &env.current_contract_address(),
                                &offer.offerer,
                                &offer.amount,
                            );
                        }
                    }
                }
                clear_pending_offers(&env, listing_id);
                ListingCancelledEvent {
                    listing_id,
                    cancelled_by: listing.artist.clone(),
                    reason: CancelReason::Expired,
                    ledger_sequence: env.ledger().sequence(),
                }.publish(&env);
                ListingExpiredEvent {
                    listing_id, expired_at: exp, ledger_sequence: env.ledger().sequence(),
                }.publish(&env);
                escrow::release_nft(&env, &listing.collection, listing.token_id,
                    &listing.artist, env.ledger().sequence(), listing_id);
                return false;
            }
        }
        if !Self::is_token_whitelisted(&env, &listing.token) {
            panic_with_error!(&env, MarketplaceError::TokenNotWhitelisted);
        }
        // Effects
        listing.status = ListingStatus::Sold;
        listing.owner = Some(buyer.clone());
        save_listing(&env, &listing);
        remove_from_active_listings(&env, listing_id);

        // Reject all pending offers (state mutation only — token refunds happen
        // in the interactions phase below).  The sweep iterates the bounded
        // pending-offer set (≤ MAX_OFFERS_PER_LISTING), not the full history.
        let offers = load_pending_offer_ids(&env, listing_id);
        let mut p_offerers: Vec<Address> = Vec::new(&env);
        let mut p_amounts: Vec<i128> = Vec::new(&env);
        let mut p_tokens: Vec<Address> = Vec::new(&env);
        for offer_id in offers.iter() {
            if let Some(mut offer) = load_offer(&env, offer_id) {
                if offer.status == OfferStatus::Pending {
                    offer.status = OfferStatus::Rejected;
                    save_offer(&env, &offer);
                    p_offerers.push_back(offer.offerer.clone());
                    p_amounts.push_back(offer.amount);
                    p_tokens.push_back(offer.token.clone());
                }
            }
        }
        clear_pending_offers(&env, listing_id);

        ArtworkSoldEvent {
            listing_id, artist: listing.artist.clone(), buyer: buyer.clone(),
            price: listing.price, currency: listing.currency.clone(),
            ledger_sequence: env.ledger().sequence(),
            schema_version: EVENT_SCHEMA_VERSION,
        }.publish(&env);
        // Interactions
        let (fee, payouts) = Self::distribute_payout(
            &env, &listing.token, &listing.collection, listing.price,
            &listing.artist, &listing.recipients, &buyer, true, listing.protocol_fee_bps,
        );
        if fee > 0 {
            if let Some(treasury) = crate::storage::get_treasury_storage(&env) {
                crate::storage::add_protocol_fee_total(&env, &listing.token, fee);
                ProtocolFeeCollectedEvent {
                    listing_id, amount: fee, token: listing.token.clone(), treasury,
                    schema_version: EVENT_SCHEMA_VERSION,
                }.publish(&env);
            }
        }
        // On-chain accounting counters (Issue #279) — bumped only after the
        // transfer plan above has fully succeeded, alongside the royalty
        // settlement snapshot so they always agree with the emitted event.
        crate::storage::add_royalty_total(&env, &listing.token, listing.price);
        crate::storage::increment_settlement_count(&env, &listing.token);
        // Emit royalty settlement snapshot for auditability (Issue #270)
        RoyaltySettlementEvent {
            id: listing_id,
            recipients: listing.recipients.clone(),
            total_amount: listing.price,
            token: listing.token.clone(),
            ledger_sequence: env.ledger().sequence(),
            schema_version: EVENT_SCHEMA_VERSION,
        }.publish(&env);
        // Per-recipient payout breakdown for the royalty audit trail (Issue #201)
        emit_royalty_paid(
            &env, Some(listing_id), None, listing.price, fee,
            listing.token.clone(), payouts,
        );
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
        // _guard dropped here — releases listing lock automatically.
        true
    }

    // ── cancel_listing ───────────────────────────────────────
    // Effects first, then release_nft (Interaction)
    pub fn cancel_listing(env: Env, artist: Address, listing_id: u64) -> bool {
        bump_instance_ttl(&env);
        // Fund-recovery / cleanup op — always available, ignores all pause axes.
        artist.require_auth();
        Self::cancel_listing_inner(&env, &artist, listing_id)
    }

    // ── expire_listing ───────────────────────────────────────
    // Permissionless — anyone may expire a listing past its expires_at
    pub fn expire_listing(env: Env, listing_id: u64) {
        bump_instance_ttl(&env);
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
        ListingCancelledEvent {
            listing_id,
            cancelled_by: listing.artist.clone(),
            reason: CancelReason::Expired,
            ledger_sequence: env.ledger().sequence(),
        }.publish(&env);
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
        Self::require_not_paused_ctx(
            &env,
            Some(&collection),
            Some(&Symbol::new(&env, "create_auction")),
        );
        creator.require_auth();
        Self::require_not_revoked(&env, &creator);
        if reserve_price <= 0 { panic_with_error!(&env, MarketplaceError::InvalidPrice); }
        if duration < MIN_AUCTION_DURATION {
            panic_with_error!(&env, MarketplaceError::InvalidAuctionDuration);
        }
        Self::validate_token_asset(&env, &token, Some(&collection));
        if !Self::is_token_whitelisted(&env, &token) {
            panic_with_error!(&env, MarketplaceError::TokenNotWhitelisted);
        }
        // Snapshot protocol fee early so it can be used in recipient validation.
        let protocol_fee_bps = crate::storage::get_protocol_fee_bps_storage(&env).unwrap_or(0);
        // Validate recipients using the same rules as create_listing (#270).
        let recipients_len = recipients.len();
        if recipients_len == 0 {
            panic_with_error!(&env, MarketplaceError::InvalidSplit);
        }
        if recipients_len > 4 {
            panic_with_error!(&env, MarketplaceError::TooManyRecipients);
        }
        Self::validate_recipients(&env, &recipients, protocol_fee_bps);
        let auction_id = increment_auction_count(&env);
        let end_time = env.ledger().timestamp() + duration;
        let min_increment = crate::storage::get_min_bid_increment_storage(&env)
            .unwrap_or(DEFAULT_MIN_BID_INCREMENT);
        // Snapshot the anti-sniping parameters so the auction's extension
        // behaviour is determined at creation, not by future admin changes.
        let extension_window =
            get_auction_extension_window_storage(&env).unwrap_or(DEFAULT_EXTENSION_WINDOW);
        let extension_trigger =
            get_auction_extension_trigger_storage(&env).unwrap_or(DEFAULT_EXTENSION_TRIGGER);
        // protocol_fee_bps already computed above.
        // Snapshot the global bid-history cap so changing it later never
        // retroactively affects this auction's ring-buffer.
        let bid_history_cap = get_bid_history_cap_storage(&env);
        // Snapshot the global anti-sniping max-extensions cap.  0 = unlimited.
        let max_extensions = get_auction_max_extensions_storage(&env);
        // Validate extension_window when trigger is enabled: must be > 0 to
        // prevent an auction from being stuck in a non-extending state.
        if extension_trigger > 0 && extension_window == 0 {
            panic_with_error!(&env, MarketplaceError::InvalidExtensionWindow);
        }
        let auction = Auction {
            auction_id, creator: creator.clone(), token: token.clone(),
            collection: collection.clone(), token_id, reserve_price,
            highest_bid: 0, highest_bidder: None, end_time,
            status: AuctionStatus::Active, recipients,
            min_increment, extension_window, extension_trigger, protocol_fee_bps,
            bid_history_cap, max_extensions, extension_count: 0,
        };
        save_auction(&env, &auction);
        add_artist_auction_id(&env, &creator, auction_id);
        AuctionCreatedEvent {
            auction_id, creator: creator.clone(), reserve_price,
            token, collection: collection.clone(), token_id, end_time,
            schema_version: EVENT_SCHEMA_VERSION,
        }.publish(&env);
        // Interaction — pull NFT into custody
        escrow::escrow_nft(&env, &creator, &collection, token_id, false, auction_id);
        escrow::emit_nft_escrowed(&env, auction_id, &collection, token_id,
            &creator, env.ledger().sequence());
        auction_id
    }

    // ── place_bid ────────────────────────────────────────────
    pub fn place_bid(env: Env, bidder: Address, auction_id: u64, amount: i128) {
        bump_instance_ttl(&env);
        Self::require_not_paused_ctx(&env, None, Some(&Symbol::new(&env, "place_bid")));
        bidder.require_auth();
        let mut auction = load_auction(&env, auction_id)
            .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::AuctionNotFound));
        // Collection-level check after loading auction.
        Self::require_not_paused_ctx(&env, Some(&auction.collection), None);
        if auction.status != AuctionStatus::Active {
            panic_with_error!(&env, MarketplaceError::AuctionNotActive);
        }
        if env.ledger().timestamp() >= auction.end_time {
            panic_with_error!(&env, MarketplaceError::AuctionExpired);
        }
        if bidder == auction.creator { panic_with_error!(&env, MarketplaceError::SelfBidNotAllowed); }
        // Anti-shill-bidding registry (Issue #199): addresses the creator or
        // admin has blocked for this auction may not bid.
        if is_bidder_blocked(&env, auction_id, &bidder) {
            panic_with_error!(&env, MarketplaceError::Unauthorized);
        }
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
            // Enforce max-extensions cap (0 = unlimited).
            if auction.max_extensions > 0 && auction.extension_count >= auction.max_extensions {
                panic_with_error!(&env, MarketplaceError::MaxExtensionsReached);
            }
            // Validate extension_window is non-zero (guard against mis-configuration).
            if auction.extension_window == 0 {
                panic_with_error!(&env, MarketplaceError::InvalidExtensionWindow);
            }
            let prev_end_time = auction.end_time;
            auction.end_time = now.checked_add(auction.extension_window).unwrap_or(auction.end_time);
            auction.extension_count = auction.extension_count.saturating_add(1);
            extended = true;
            save_auction(&env, &auction);
            append_bid_record(&env, auction_id,
                &BidRecord { bidder: bidder.clone(), amount, ledger: env.ledger().sequence() },
                auction.bid_history_cap,
            );
            BidPlacedEvent { auction_id, bidder: bidder.clone(), bid_amount: amount }.publish(&env);
            AuctionExtendedEvent {
                auction_id,
                prev_end_time,
                new_end_time: auction.end_time,
                extension_count: auction.extension_count,
            }.publish(&env);
        } else {
            save_auction(&env, &auction);
            append_bid_record(&env, auction_id,
                &BidRecord { bidder: bidder.clone(), amount, ledger: env.ledger().sequence() },
                auction.bid_history_cap,
            );
            BidPlacedEvent { auction_id, bidder: bidder.clone(), bid_amount: amount }.publish(&env);
        }
        let _ = extended;
        let tc = TokenClient::new(&env, &auction.token);
        if let Some(prev) = previous_bidder {
            tc.transfer(&env.current_contract_address(), &prev, &previous_bid);
            // Emit refund event so the indexer can reconcile escrow (Issue #271)
            AuctionBidRefundedEvent {
                auction_id,
                bidder: prev,
                amount: previous_bid,
                token: auction.token.clone(),
                reason: Symbol::new(&env, "outbid"),
                ledger_sequence: env.ledger().sequence(),
                schema_version: EVENT_SCHEMA_VERSION,
            }.publish(&env);
        }
        tc.transfer(&bidder, &env.current_contract_address(), &amount);
    }

    // ── finalize_auction ─────────────────────────────────────
    // CEI: lock → checks → effects → emit → interactions (payout + release_nft) → unlock
    // With escrow: NFT source is always the contract — no seller-side surprise.
    pub fn finalize_auction(env: Env, caller: Address, auction_id: u64) {
        bump_instance_ttl(&env);
        // Fund-recovery / cleanup op — always available, ignores all pause axes.
        caller.require_auth();
        // RAII guard — cleared by Drop whether the function returns normally or panics.
        let _guard = AuctionReentrancyScope::new(&env, auction_id);
        let mut auction = load_auction(&env, auction_id)
            .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::AuctionNotFound));
        if auction.status != AuctionStatus::Active {
            panic_with_error!(&env, MarketplaceError::AuctionAlreadyFinalized);
        }
        if env.ledger().timestamp() < auction.end_time {
            panic_with_error!(&env, MarketplaceError::AuctionNotEnded);
        }
        let winner = auction.highest_bidder.clone();
        let winning_bid = auction.highest_bid;
        let snapshotted_fee = auction.protocol_fee_bps;
        auction.status = if winner.is_some() { AuctionStatus::Finalized } else { AuctionStatus::Cancelled };
        save_auction(&env, &auction);
        AuctionFinalizedEvent {
            auction_id, winner: winner.clone(), amount: winning_bid,
            schema_version: EVENT_SCHEMA_VERSION,
        }.publish(&env);
        if let Some(ref w) = winner {
            let (fee, payouts) = Self::distribute_payout(
                &env, &auction.token, &auction.collection, winning_bid,
                &auction.creator, &auction.recipients, w, false, snapshotted_fee,
            );
            if fee > 0 {
                if let Some(treasury) = crate::storage::get_treasury_storage(&env) {
                    crate::storage::add_protocol_fee_total(&env, &auction.token, fee);
                    ProtocolFeeCollectedEvent {
                        listing_id: auction_id, amount: fee,
                        token: auction.token.clone(), treasury,
                        schema_version: EVENT_SCHEMA_VERSION,
                    }.publish(&env);
                }
            }
            // On-chain accounting counters (Issue #279) — see buy_artwork.
            crate::storage::add_royalty_total(&env, &auction.token, winning_bid);
            crate::storage::increment_settlement_count(&env, &auction.token);
            // Emit royalty settlement snapshot for auditability (Issue #270)
            RoyaltySettlementEvent {
                id: auction_id,
                recipients: auction.recipients.clone(),
                total_amount: winning_bid,
                token: auction.token.clone(),
                ledger_sequence: env.ledger().sequence(),
                schema_version: EVENT_SCHEMA_VERSION,
            }.publish(&env);
            // Per-recipient payout breakdown for the royalty audit trail (Issue #201)
            emit_royalty_paid(
                &env, None, Some(auction_id), winning_bid, fee,
                auction.token.clone(), payouts,
            );
            // NFT: escrow → winner (CEI: status Finalized already)
            escrow::release_nft(&env, &auction.collection, auction.token_id,
                w, env.ledger().sequence(), auction_id);
        } else {
            // No bids — emit cancelled with reason, then return NFT to creator
            AuctionCancelledEvent {
                auction_id,
                cancelled_by: auction.creator.clone(),
                reason: Symbol::new(&env, "no_bids"),
            }.publish(&env);
            escrow::release_nft(&env, &auction.collection, auction.token_id,
                &auction.creator, env.ledger().sequence(), auction_id);
        }
        // _guard dropped here — releases auction lock automatically.
    }

    // ── cancel_auction ───────────────────────────────────────
    // Only no-bid auctions can be cancelled; releases NFT back to creator
    pub fn cancel_auction(env: Env, creator: Address, auction_id: u64) {
        bump_instance_ttl(&env);
        // Fund-recovery / cleanup op — always available, ignores all pause axes.
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
        AuctionCancelledEvent {
            auction_id,
            cancelled_by: creator.clone(),
            reason: Symbol::new(&env, "owner"),
        }.publish(&env);
        // Return NFT to creator
        escrow::release_nft(&env, &auction.collection, auction.token_id,
            &creator, env.ledger().sequence(), auction_id);
    }

    // ── admin_cancel_auction ─────────────────────────────────
    // Admin emergency cancellation — works even if bids exist.
    // Refunds the highest bidder before cancelling. (Issue #271)
    pub fn admin_cancel_auction(env: Env, admin: Address, auction_id: u64) {
        Self::require_role(&env, &admin, RoleType::EmergencyPause);
        if !acquire_auction_lock(&env, auction_id) {
            panic_with_error!(&env, MarketplaceError::ReentrancyGuard);
        }
        let mut auction = match load_auction(&env, auction_id) {
            Some(a) => a,
            None => {
                release_auction_lock(&env, auction_id);
                panic_with_error!(&env, MarketplaceError::AuctionNotFound);
            }
        };
        if auction.status != AuctionStatus::Active {
            release_auction_lock(&env, auction_id);
            panic_with_error!(&env, MarketplaceError::InvalidAuctionState);
        }
        // Refund the highest bidder (if any) before marking cancelled.
        let refunded_amount = auction.highest_bid;
        if let Some(ref bidder) = auction.highest_bidder.clone() {
            let tc = TokenClient::new(&env, &auction.token);
            tc.transfer(&env.current_contract_address(), bidder, &refunded_amount);
            AuctionBidRefundedEvent {
                auction_id,
                bidder: bidder.clone(),
                amount: refunded_amount,
                token: auction.token.clone(),
                reason: Symbol::new(&env, "admin_cancel"),
                ledger_sequence: env.ledger().sequence(),
                schema_version: EVENT_SCHEMA_VERSION,
            }.publish(&env);
        }
        auction.status = AuctionStatus::Cancelled;
        save_auction(&env, &auction);
        AuctionCancelledEvent {
            auction_id,
            cancelled_by: admin.clone(),
            reason: Symbol::new(&env, "admin"),
        }.publish(&env);
        AuctionAdminCancelledEvent {
            auction_id,
            cancelled_by: admin,
            refunded_amount,
            token: auction.token.clone(),
            ledger_sequence: env.ledger().sequence(),
            schema_version: EVENT_SCHEMA_VERSION,
        }.publish(&env);
        // Return NFT to creator
        escrow::release_nft(&env, &auction.collection, auction.token_id,
            &auction.creator, env.ledger().sequence(), auction_id);
        release_auction_lock(&env, auction_id);
    }

    // ── Offers ───────────────────────────────────────────────

    pub fn make_offer(
        env: Env, offerer: Address, listing_id: u64,
        amount: i128, token: Address, expires_at: Option<u64>,
    ) -> u64 {
        bump_instance_ttl(&env);
        Self::require_not_paused_ctx(&env, None, Some(&Symbol::new(&env, "make_offer")));
        offerer.require_auth();
        let listing = load_listing(&env, listing_id)
            .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::ListingNotFound));
        // Collection-level check after loading listing.
        Self::require_not_paused_ctx(&env, Some(&listing.collection), None);
        if listing.status != ListingStatus::Active {
            panic_with_error!(&env, MarketplaceError::ListingNotActive);
        }
        if listing.artist == offerer { panic_with_error!(&env, MarketplaceError::CannotOfferOwnListing); }
        if amount <= 0 { panic_with_error!(&env, MarketplaceError::InsufficientOfferAmount); }
        Self::validate_token_asset(&env, &token, Some(&listing.collection));
        if !Self::is_token_whitelisted(&env, &token) {
            panic_with_error!(&env, MarketplaceError::TokenNotWhitelisted);
        }
        // Enforce the active-offer cap so per-listing storage is bounded.
        // Only Pending offers count; terminal offers have freed their slot.
        // O(1): one read of the bounded pending-offer set — no scan over the
        // listing's full offer history.
        if pending_offer_count(&env, listing_id) >= MAX_OFFERS_PER_LISTING {
            panic_with_error!(&env, MarketplaceError::OfferLimitReached);
        }
        TokenClient::new(&env, &token).transfer(&offerer, &env.current_contract_address(), &amount);
        let offer_id = increment_offer_count(&env);
        save_offer(
            &env,
            &Offer {
                offer_id,
                listing_id,
                offerer: offerer.clone(),
                amount,
                token: token.clone(),
                status: OfferStatus::Pending,
                created_at: env.ledger().sequence(),
                expires_at, // #32: optional expiry stored with offer
            },
        );
        // O(1) appends: each index touches only its last page.
        add_listing_offer_id(&env, listing_id, offer_id);
        add_offerer_offer_id(&env, &offerer, offer_id);
        add_pending_offer(&env, listing_id, offer_id);

        OfferMadeEvent {
            offer_id,
            listing_id,
            offerer: offerer.clone(),
            amount,
            token,
            expires_at,
            schema_version: EVENT_SCHEMA_VERSION,
        }
        .publish(&env);

        offer_id
    }

    pub fn withdraw_offer(env: Env, offerer: Address, offer_id: u64) {
        bump_instance_ttl(&env);
        // Fund-recovery / cleanup op — always available, ignores all pause axes.
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
        remove_pending_offer(&env, offer.listing_id, offer_id);

        OfferWithdrawnEvent {
            offer_id,
            listing_id: offer.listing_id,
            offerer: offerer.clone(),
        }
        .publish(&env);
    }

    pub fn reject_offer(env: Env, artist: Address, offer_id: u64) {
        bump_instance_ttl(&env);
        // Fund-recovery / cleanup op (returns escrowed funds to the offerer) —
        // always available, ignores all pause axes.
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
        remove_pending_offer(&env, offer.listing_id, offer_id);

        OfferRejectedEvent {
            offer_id,
            listing_id: offer.listing_id,
            offerer: offer.offerer.clone(),
        }
        .publish(&env);
    }

    // ── accept_offer ─────────────────────────────────────────
    // CEI: lock → checks → effects → emit → interactions (payout + release_nft + refunds) → unlock
    pub fn accept_offer(env: Env, artist: Address, offer_id: u64) {
        bump_instance_ttl(&env);
        Self::require_not_paused(&env);
        artist.require_auth();
        let mut offer = load_offer(&env, offer_id)
            .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::OfferNotFound));
        let listing_id = offer.listing_id;
        // RAII guard — cleared by Drop whether the function returns normally or panics.
        let _guard = ListingReentrancyScope::new(&env, listing_id);
        let mut listing = load_listing(&env, listing_id)
            .unwrap_or_else(|| panic_with_error!(&env, MarketplaceError::ListingNotFound));
        if listing.artist != artist {
            panic_with_error!(&env, MarketplaceError::Unauthorized);
        }
        if offer.status != OfferStatus::Pending || listing.status != ListingStatus::Active {
            panic_with_error!(&env, MarketplaceError::InvalidOfferState);
        }
        if let Some(exp) = offer.expires_at {
            if env.ledger().timestamp() >= exp {
                panic_with_error!(&env, MarketplaceError::OfferExpired);
            }
        }
        if let Some(exp) = listing.expires_at {
            if env.ledger().timestamp() >= exp {
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

        // #31: Mark all other pending offers Rejected; collect refund data and
        // emit OfferRejectedEvent for each.  Sweeps the bounded pending-offer
        // set (≤ MAX_OFFERS_PER_LISTING), then drops it — the accepted offer
        // and every sibling have reached a terminal state.
        let sibling_offers = load_pending_offer_ids(&env, listing.listing_id);
        let mut r_offerers: Vec<Address> = Vec::new(&env);
        let mut r_amounts: Vec<i128> = Vec::new(&env);
        let mut r_tokens: Vec<Address> = Vec::new(&env);
        for oid in sibling_offers.iter() {
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
        clear_pending_offers(&env, listing.listing_id);

        OfferAcceptedEvent {
            offer_id, listing_id, offerer: accepted_offerer.clone(), amount: accepted_amount,
            schema_version: EVENT_SCHEMA_VERSION,
        }.publish(&env);
        // Interactions
        let (fee, payouts) = Self::distribute_payout(
            &env, &offer.token, &listing.collection, offer.amount,
            &artist, &listing.recipients, &offer.offerer, false, listing.protocol_fee_bps,
        );
        if fee > 0 {
            if let Some(treasury) = crate::storage::get_treasury_storage(&env) {
                crate::storage::add_protocol_fee_total(&env, &offer.token, fee);
                ProtocolFeeCollectedEvent {
                    listing_id, amount: fee, token: offer.token.clone(), treasury,
                    schema_version: EVENT_SCHEMA_VERSION,
                }.publish(&env);
            }
        }
        // On-chain accounting counters (Issue #279) — see buy_artwork.
        crate::storage::add_royalty_total(&env, &offer.token, offer.amount);
        crate::storage::increment_settlement_count(&env, &offer.token);
        // Emit royalty settlement snapshot for auditability (Issue #270)
        RoyaltySettlementEvent {
            id: listing_id,
            recipients: listing.recipients.clone(),
            total_amount: offer.amount,
            token: offer.token.clone(),
            ledger_sequence: env.ledger().sequence(),
            schema_version: EVENT_SCHEMA_VERSION,
        }.publish(&env);
        // Per-recipient payout breakdown for the royalty audit trail (Issue #201)
        emit_royalty_paid(
            &env, Some(listing_id), None, offer.amount, fee,
            offer.token.clone(), payouts,
        );
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
        // _guard dropped here — releases listing lock automatically.
    }

    pub fn reclaim_offer(env: Env, offer_id: u64) {
        bump_instance_ttl(&env);
        // Fund-recovery / cleanup op — always available, ignores all pause axes.
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
        remove_pending_offer(&env, offer.listing_id, offer_id);

        OfferReclaimedEvent {
            offer_id,
            listing_id: offer.listing_id,
            offerer: offer.offerer.clone(),
            amount: offer.amount,
        }
        .publish(&env);
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

    /// Paginated ids of currently-active listings.
    ///
    /// Ordering note (deliberate change with the 1.1.0 paged storage): the
    /// active index uses swap-removal, so after any listing leaves the set the
    /// order is no longer strict creation order.  It is stable between
    /// removals; clients needing chronological order should sort by id.
    pub fn get_active_listings(env: Env, limit: u32, offset: u32) -> Vec<u64> {
        get_active_listing_ids_range(&env, offset, limit)
    }
    pub fn get_active_listings_page(env: Env, start: u32, limit: u32) -> Vec<u64> {
        Self::get_active_listings(env, limit, start)
    }

    /// Total number of currently-active listings (O(1)).
    pub fn get_active_listings_count(env: Env) -> u32 {
        active_listings_len(&env)
    }

    /// Number of Pending offers on `listing_id` — the counter enforcing
    /// MAX_OFFERS_PER_LISTING in `make_offer` (O(1)).
    pub fn get_pending_offer_count(env: Env, listing_id: u64) -> u32 {
        pending_offer_count(&env, listing_id)
    }

    /// Maximum `limit` accepted by `get_listings_paginated`.
    pub const MAX_PAGE_LIMIT: u32 = 100;
    pub fn get_listings_paginated(env: Env, start: u32, limit: u32) -> (Vec<Listing>, u32) {
        // Clamp limit to the hard maximum.
        let effective_limit = if limit > Self::MAX_PAGE_LIMIT {
            Self::MAX_PAGE_LIMIT
        } else if limit == 0 {
            // A zero limit is valid; return an empty page immediately.
            return (Vec::new(&env), start);
        } else {
            limit
        };

        let total = active_listings_len(&env);

        // Out-of-range start: return empty page + same cursor (no panic).
        if start >= total {
            return (Vec::new(&env), start);
        }

        let end = (start + effective_limit).min(total);
        // Read only the pages covering [start, end) — never the whole index.
        let ids = get_active_listing_ids_range(&env, start, end - start);
        let mut listings: Vec<Listing> = Vec::new(&env);
        for listing_id in ids.iter() {
            if let Some(listing) = load_listing(&env, listing_id) {
                listings.push_back(listing);
            }
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

    fn create_listing_inner(
        env: &Env, artist: &Address, price: i128, currency: Symbol,
        token: Address, collection: Address, token_id: u64,
        recipients: Vec<Recipient>, expires_at: Option<u64>,
    ) -> u64 {
        if price <= 0 { panic_with_error!(env, MarketplaceError::InvalidPrice); }
        Self::require_price_in_bounds(env, price);
        if let Some(exp) = expires_at {
            if exp <= env.ledger().timestamp() {
                panic_with_error!(env, MarketplaceError::InvalidPrice);
            }
        }

        let recipients_len = recipients.len();
        if recipients_len == 0 {
            panic_with_error!(env, MarketplaceError::InvalidSplit);
        }
        if recipients_len > 4 {
            panic_with_error!(env, MarketplaceError::TooManyRecipients);
        }

        let protocol_fee_bps = crate::storage::get_protocol_fee_bps_storage(env).unwrap_or(0);
        Self::validate_recipients(env, &recipients, protocol_fee_bps);
        if !Self::is_token_whitelisted(env, &token) {
            panic_with_error!(env, MarketplaceError::TokenNotWhitelisted);
        }

        let listing_id = increment_listing_count(env);
        let listing = Listing {
            listing_id,
            artist: artist.clone(),
            price,
            currency,
            token,
            collection: collection.clone(),
            token_id,
            recipients,
            status: ListingStatus::Active,
            owner: None,
            created_at: env.ledger().sequence(),
            protocol_fee_bps,
            expires_at,
        };
        save_listing(env, &listing);
        add_artist_listing_id(env, artist, listing_id);
        add_to_active_listings(env, listing_id);
        ListingCreatedEvent {
            listing_id,
            artist: artist.clone(),
            price,
            currency: listing.currency.clone(),
            collection: listing.collection.clone(),
            token_id: listing.token_id,
            ledger_sequence: env.ledger().sequence(),
        }.publish(env);

        escrow::escrow_nft(env, artist, &listing.collection, listing.token_id, true, listing_id);
        escrow::emit_nft_escrowed(env, listing_id, &listing.collection,
            listing.token_id, artist, env.ledger().sequence());
        listing_id
    }

    fn update_listing_inner(
        env: &Env, artist: &Address, listing_id: u64,
        new_price: i128, new_token: Address, new_recipients: Vec<Recipient>,
    ) -> bool {
        let mut listing = load_listing(env, listing_id)
            .unwrap_or_else(|| panic_with_error!(env, MarketplaceError::ListingNotFound));
        if listing.artist != *artist { panic_with_error!(env, MarketplaceError::Unauthorized); }
        if listing.status != ListingStatus::Active {
            panic_with_error!(env, MarketplaceError::ListingNotActive);
        }

        if pending_offer_count(env, listing_id) > 0 {
            panic_with_error!(env, MarketplaceError::Unauthorized);
        }
        if new_price <= 0 { panic_with_error!(env, MarketplaceError::InvalidPrice); }
        if !Self::is_token_whitelisted(env, &new_token) {
            panic_with_error!(env, MarketplaceError::Unauthorized);
        }
        let nrlen = new_recipients.len();
        if nrlen == 0 { panic_with_error!(env, MarketplaceError::InvalidSplit); }
        if nrlen > 4  { panic_with_error!(env, MarketplaceError::TooManyRecipients); }
        Self::validate_recipients(env, &new_recipients, listing.protocol_fee_bps);
        let old_price = listing.price;
        listing.price = new_price;
        listing.token = new_token;
        listing.recipients = new_recipients;
        save_listing(env, &listing);
        ListingUpdatedEvent {
            listing_id,
            artist: artist.clone(),
            new_price,
            collection: listing.collection.clone(),
            token_id: listing.token_id,
            ledger_sequence: env.ledger().sequence(),
        }.publish(env);
        // Emit price-change event whenever the price actually changes so
        // the indexer can maintain a full PriceHistory table (Issue #213).
        if old_price != new_price {
            ListingPriceUpdatedEvent {
                listing_id,
                old_price,
                new_price,
                updated_by: artist.clone(),
            }.publish(env);
        }
        true
    }

    fn cancel_listing_inner(env: &Env, artist: &Address, listing_id: u64) -> bool {
        let mut listing = load_listing(env, listing_id)
            .unwrap_or_else(|| panic_with_error!(env, MarketplaceError::ListingNotFound));
        if listing.artist != *artist { panic_with_error!(env, MarketplaceError::Unauthorized); }
        if listing.status != ListingStatus::Active {
            panic_with_error!(env, MarketplaceError::ListingNotActive);
        }

        for offer_id in load_pending_offer_ids(env, listing_id).iter() {
            if let Some(mut offer) = load_offer(env, offer_id) {
                if offer.status == OfferStatus::Pending {
                    offer.status = OfferStatus::Rejected;
                    save_offer(env, &offer);
                    TokenClient::new(env, &offer.token).transfer(
                        &env.current_contract_address(), &offer.offerer, &offer.amount,
                    );
                }
            }
        }
        clear_pending_offers(env, listing_id);

        listing.status = ListingStatus::Cancelled;
        save_listing(env, &listing);
        remove_from_active_listings(env, listing_id);
        ListingCancelledEvent {
            listing_id,
            cancelled_by: artist.clone(),
            reason: CancelReason::Owner,
            ledger_sequence: env.ledger().sequence(),
        }.publish(env);
        escrow::release_nft(env, &listing.collection, listing.token_id,
            artist, env.ledger().sequence(), listing_id);
        true
    }

    fn require_admin(env: &Env) {
        let key = crate::storage::DataKey::Admin;
        let admin = env.storage().persistent()
            .get::<_, Address>(&key).expect("admin not set");
        admin.require_auth();
    }

    /// Authorize `caller` (already `require_auth`ed) as either the auction's
    /// creator or the contract admin — the two roles allowed to manage a
    /// blocked-bidder registry (Issue #199).
    fn require_creator_or_admin(env: &Env, caller: &Address, creator: &Address) {
        if caller == creator {
            return;
        }
        if let Some(admin) = env
            .storage()
            .persistent()
            .get::<_, Address>(&DataKey::Admin)
        {
            if *caller == admin {
                return;
            }
        }
        panic_with_error!(env, MarketplaceError::Unauthorized);
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

    /// Granular pause check with optional collection and function context.
    /// Panics with ContractPaused if ANY active circuit-breaker fires.
    fn require_not_paused_ctx(
        env: &Env,
        collection: Option<&Address>,
        function_name: Option<&Symbol>,
    ) {
        if crate::storage::is_paused_for(env, collection, function_name) {
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
        let whitelist = env
            .storage()
            .persistent()
            .get::<_, Vec<Address>>(&key)
            .unwrap_or(Vec::new(env));
        if whitelist.is_empty() {
            true
        } else {
            whitelist.contains(token)
        }
    }

    // ── IPFS CID validation (Issue #206) ─────────────────────────────────────
    //
    // Accepts two canonical CID formats:
    //
    //   CIDv1 base32:  starts with 'b' (multibase prefix), followed by
    //                  lowercase a-z and digits 2-7, total length 46–100 chars.
    //
    //   CIDv0 base58:  starts with "Qm", exactly 46 characters, using the
    //                  base58 alphabet (1-9, A-H, J-N, P-Z, a-k, m-z).
    //
    // Implemented with soroban_sdk::Bytes character iteration — no std, no
    // external dependencies, fully no_std compatible with the Soroban runtime.
    fn validate_cid(cid: &soroban_sdk::String) -> bool {
        let len = cid.len();
        // Minimum 46 chars covers both CIDv0 (exactly 46) and CIDv1 (≥ 46).
        // Maximum 100 chars provides headroom for variant CIDv1 encodings.
        if len < 46 || len > 100 {
            return false;
        }

        // Collect bytes for indexed access (soroban String = UTF-8; CIDs are ASCII).
        let mut bytes = soroban_sdk::Bytes::new(cid.env());
        cid.iter().for_each(|b| bytes.push_back(b));

        let first  = bytes.get(0).unwrap_or(0) as char;
        let second = bytes.get(1).unwrap_or(0) as char;

        // ── CIDv1 base32 lowercase (multibase prefix 'b') ────────────────────
        if first == 'b' {
            for i in 1..len {
                let c = bytes.get(i).unwrap_or(0) as char;
                if !matches!(c, 'a'..='z' | '2'..='7') {
                    return false;
                }
            }
            return true;
        }

        // ── CIDv0 base58 (prefix "Qm", exactly 46 chars) ─────────────────────
        if first == 'Q' && second == 'm' {
            if len != 46 {
                return false;
            }
            // base58 alphabet excludes: '0', 'I', 'O', 'l'
            for i in 0..len {
                let c = bytes.get(i).unwrap_or(0) as char;
                if !matches!(c,
                    '1'..='9'
                    | 'A'..='H' | 'J'..='N' | 'P'..='Z'
                    | 'a'..='k' | 'm'..='z'
                ) {
                    return false;
                }
            }
            return true;
        }

        false
    }

    /// View: return `true` for a well-formed IPFS CID (CIDv0 or CIDv1),
    /// `false` for any malformed input.
    ///
    /// Accepted formats:
    /// - CIDv1 base32: starts with `b`, 46–100 lowercase base32 chars (`a-z`, `2-7`).
    /// - CIDv0 base58: starts with `Qm`, exactly 46 base58 chars.
    ///
    /// Callers can pre-validate CIDs returned by IPFS pinning services before
    /// including them in `create_listing` or `create_auction` invocations.
    pub fn check_cid_valid(env: Env, cid: soroban_sdk::String) -> bool {
        Self::validate_cid(&cid)
    }

    /// Validate that the sum of all `Recipient.percentage` values (each expressed
    /// in basis points, 0–10 000) plus the current protocol fee does not exceed
    /// 10 000 bps (100 %).
    ///
    /// Uses `checked_add` throughout to prevent integer overflow on malformed
    /// input.  Panics with `RoyaltyExceedsLimit` when the invariant is violated.
    ///
    /// # Invariants checked
    /// * `recipients` must be non-empty (caller responsibility to guard with `InvalidSplit`).
    /// * Each recipient's `percentage` must be > 0 (ZeroRecipientBps).
    /// * No duplicate addresses in the recipient list (DuplicateRecipient).
    /// * `sum(r.percentage) + protocol_fee_bps <= 10_000`
    fn validate_recipients(env: &Env, recipients: &Vec<Recipient>, protocol_fee_bps: u32) {
        let len = recipients.len();
        let mut total_bps: u32 = 0;
        for i in 0..len {
            let r = recipients.get(i).unwrap();
            // Each recipient must contribute a non-zero share.
            if r.percentage == 0 {
                panic_with_error!(env, MarketplaceError::ZeroRecipientBps);
            }
            // Duplicate address check: compare against every prior entry.
            for j in 0..i {
                if recipients.get(j).unwrap().address == r.address {
                    panic_with_error!(env, MarketplaceError::DuplicateRecipient);
                }
            }
            total_bps = total_bps.checked_add(r.percentage)
                .unwrap_or_else(|| panic_with_error!(env, MarketplaceError::RoyaltyExceedsLimit));
        }
        let combined = total_bps.checked_add(protocol_fee_bps)
            .unwrap_or_else(|| panic_with_error!(env, MarketplaceError::RoyaltyExceedsLimit));
        if combined > 10_000 { panic_with_error!(env, MarketplaceError::RoyaltyExceedsLimit); }
    }

    /// Returns `(protocol_fee_collected, per-recipient payouts)`. The payout
    /// vector records every transfer made out of the sale price except the
    /// protocol fee — i.e. the collection-level `royalty_info` receiver (when
    /// paid) followed by each configured recipient — so entries always sum to
    /// `amount - protocol_fee_collected`. (Issue #201)
    #[allow(clippy::too_many_arguments)]
    fn distribute_payout(
        env: &Env, token_addr: &Address, collection_addr: &Address,
        amount: i128, seller: &Address, recipients: &Vec<Recipient>,
        buyer: &Address, transfer_from_buyer: bool, fee_bps: u32,
    ) -> (i128, Vec<RecipientPayout>) {
        let token = TokenClient::new(env, token_addr);
        if transfer_from_buyer {
            token.transfer(buyer, &env.current_contract_address(), &amount);
        }
        let mut payouts: Vec<RecipientPayout> = Vec::new(env);
        let mut payout = amount;
        let royalty_info: (Address, u32) = env.invoke_contract(
            collection_addr,
            &soroban_sdk::Symbol::new(env, "royalty_info"),
            soroban_sdk::vec![env],
        );
        let (royalty_receiver, royalty_bps) = royalty_info;
        let mut payout = amount;
        if royalty_bps > 0 && royalty_receiver != *seller {
            let royalty = amount
                .checked_mul(royalty_bps as i128)
                .unwrap_or_else(|| panic_with_error!(env, MarketplaceError::ArithmeticOverflow))
                .checked_div(10_000)
                .unwrap_or_else(|| panic_with_error!(env, MarketplaceError::ArithmeticOverflow));
            token.transfer(&env.current_contract_address(), &royalty_receiver, &royalty);
            payouts.push_back(RecipientPayout { address: royalty_receiver, amount: royalty });
            payout -= royalty;
        }

        // ── Fee + recipient split via math::distribute ────────────────────────
        // `distribute` uses checked arithmetic throughout and guarantees
        // fee + sum(payouts) == payout (no stroop lost).
        //
        // Only collect the fee when a treasury address is configured.
        // When no treasury is set the fee_bps is ignored and the full `payout`
        // is distributed to recipients — this preserves the original semantics.
        let effective_fee_bps = if crate::storage::get_treasury_storage(env).is_some() {
            fee_bps
        } else {
            0
        };
        let dist = crate::math::distribute(env, payout, effective_fee_bps, recipients);

        // Transfer protocol fee to treasury (only when treasury is configured
        // and fee > 0).
        let mut fee_collected: i128 = 0;
        if dist.fee > 0 {
            if let Some(t) = crate::storage::get_treasury_storage(env) {
                token.transfer(&env.current_contract_address(), &t, &dist.fee);
                fee_collected = dist.fee;
            }
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
            payouts.push_back(RecipientPayout { address: r.address, amount: amt });
            ds += amt;
        }
        (fee_collected, payouts)
    }
}
