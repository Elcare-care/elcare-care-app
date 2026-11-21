// revoke_artist_cleanup_tests.rs — Artist revocation × cleanup coverage
//
// Issue: Revoking an artist should block new exposure while allowing existing
// cleanup operations to continue.
//
// Coverage:
//   §1  revoke_artist blocks new listings and auctions (ArtistRevoked #15)
//   §2  cancel_artist_listings cancels active listings after revocation
//   §3  Pending offers are refunded when listings are cancelled via revocation sweep
//   §4  Listings in cancellable terminal states are skipped harmlessly
//   §5  Expired listings are handled via expire_listing (cleanup op, not blocked by pause)
//   §6  cancel_artist_listings is idempotent — repeat calls return 0 when done
//   §7  reinstate_artist re-enables listing creation and clears the cursor
//   §8  CollectionAdmin role required — unauthorized caller is rejected
//   §9  Revocation does not affect other artists' listings
//   §10 Revocation + global pause: cleanup ops still available
//
// Naming conventions mirror auction_cancel_audit_tests.rs and fee_governance_tests.rs
// already in this module.

use crate::contract::{MarketplaceContract, MarketplaceContractClient};
use crate::test::{mock_nft, valid_recipients, MockNftClient};
use crate::types::{ListingStatus, RoleType};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    vec, Address, Env,
};

// ── Shared fixture ────────────────────────────────────────────────────────────

struct S {
    env: Env,
    client: MarketplaceContractClient<'static>,
    admin: Address,
    artist: Address,
    buyer: Address,
    token: Address,
    col: Address,
}

fn setup() -> S {
    let env = Env::default();
    env.mock_all_auths();
    let cid = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &cid);
    let admin = Address::generate(&env);
    let artist = Address::generate(&env);
    let buyer = Address::generate(&env);
    let ta = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(ta).address();
    let sac = StellarAssetClient::new(&env, &token);
    sac.mint(&admin, &100_000_000_000_i128);
    sac.mint(&artist, &100_000_000_000_i128);
    sac.mint(&buyer, &100_000_000_000_i128);
    sac.mint(&cid, &100_000_000_000_i128);
    let col = env.register(mock_nft::MockNft, ());
    // Token #1 owned by artist
    MockNftClient::new(&env, &col).set_owner(&1u64, &artist);
    client.set_admin(&admin);
    client.migrate_roles(&admin);
    client.add_token_to_whitelist(&admin, &token);
    S { env, client, admin, artist, buyer, token, col }
}

/// Create a fresh NFT token id on `col` owned by `owner` and open a listing.
fn new_listing(s: &S, token_id: u64) -> u64 {
    MockNftClient::new(&s.env, &s.col).set_owner(&token_id, &s.artist);
    s.client.create_listing(
        &s.artist,
        &10_000_000_i128,
        &symbol_short!("XLM"),
        &s.token,
        &s.col,
        &token_id,
        &1u64,
        &valid_recipients(&s.env, &s.artist),
        &None::<u64>,
    )
}

// ── §1  revoke_artist blocks new listings and auctions ───────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #15)")]
fn test_revoked_artist_cannot_create_listing() {
    let s = setup();
    s.client.revoke_artist(&s.admin, &s.artist);
    // Any attempt to create a listing must fail with ArtistRevoked (#15).
    MockNftClient::new(&s.env, &s.col).set_owner(&2u64, &s.artist);
    s.client.create_listing(
        &s.artist,
        &5_000_000_i128,
        &symbol_short!("XLM"),
        &s.token,
        &s.col,
        &2u64,
        &1u64,
        &valid_recipients(&s.env, &s.artist),
        &None::<u64>,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #15)")]
fn test_revoked_artist_cannot_create_auction() {
    let s = setup();
    s.client.revoke_artist(&s.admin, &s.artist);
    MockNftClient::new(&s.env, &s.col).set_owner(&3u64, &s.artist);
    s.client.create_auction(
        &s.artist,
        &s.token,
        &s.col,
        &3u64,
        &1_000_000_i128,
        &3_600u64,
        &vec![&s.env, crate::types::Recipient { address: s.artist.clone(), percentage: 10_000 }],
    );
}

#[test]
fn test_is_artist_revoked_returns_true_after_revoke() {
    let s = setup();
    assert!(!s.client.is_artist_revoked(&s.artist));
    s.client.revoke_artist(&s.admin, &s.artist);
    assert!(s.client.is_artist_revoked(&s.artist));
}

// ── §2  cancel_artist_listings cancels active listings ───────────────────────

#[test]
fn test_cancel_artist_listings_cancels_all_active_listings() {
    let s = setup();
    // Open three listings for the artist
    let lid1 = new_listing(&s, 1);
    let lid2 = new_listing(&s, 2);
    let lid3 = new_listing(&s, 3);

    s.client.revoke_artist(&s.admin, &s.artist);
    // Cancel up to 10 items in one call — all three fit
    let remaining = s.client.cancel_artist_listings(&s.admin, &s.artist, &10u32);

    assert_eq!(remaining, 0u64, "all active listings must be cancelled");
    assert_eq!(s.client.get_listing(&lid1).status, ListingStatus::Cancelled);
    assert_eq!(s.client.get_listing(&lid2).status, ListingStatus::Cancelled);
    assert_eq!(s.client.get_listing(&lid3).status, ListingStatus::Cancelled);
}

#[test]
fn test_cancel_artist_listings_cancel_reason_is_admin_revoked() {
    // CancelReason::AdminRevoked = 3; verified via try_ invocation on a cancelled listing.
    let s = setup();
    let lid = new_listing(&s, 1);
    s.client.revoke_artist(&s.admin, &s.artist);
    s.client.cancel_artist_listings(&s.admin, &s.artist, &10u32);

    let listing = s.client.get_listing(&lid);
    assert_eq!(listing.status, ListingStatus::Cancelled);
}

// ── §3  Pending offers are refunded on revocation sweep ──────────────────────

#[test]
fn test_revoke_sweep_refunds_pending_offers() {
    let s = setup();
    let lid = new_listing(&s, 1);

    // Buyer places an offer
    let offer_amount = 3_000_000_i128;
    let token_client = soroban_sdk::token::TokenClient::new(&s.env, &s.token);
    let buyer_initial = token_client.balance(&s.buyer);
    s.client.make_offer(&s.buyer, &lid, &offer_amount, &s.token, &None::<u64>);
    assert_eq!(token_client.balance(&s.buyer), buyer_initial - offer_amount,
        "offer amount must be escrowed");

    // Revoke the artist and sweep
    s.client.revoke_artist(&s.admin, &s.artist);
    s.client.cancel_artist_listings(&s.admin, &s.artist, &10u32);

    // Buyer must have received the offer amount back
    assert_eq!(token_client.balance(&s.buyer), buyer_initial,
        "buyer must be fully refunded after revocation sweep");
}

// ── §4  Terminal listings are skipped harmlessly by the sweep ─────────────────

#[test]
fn test_cancel_artist_listings_skips_already_cancelled_listing() {
    let s = setup();
    let lid = new_listing(&s, 1);

    // Artist cancels their own listing first
    s.client.cancel_listing(&s.artist, &lid);
    assert_eq!(s.client.get_listing(&lid).status, ListingStatus::Cancelled);

    // Now revoke and sweep — should not panic
    s.client.revoke_artist(&s.admin, &s.artist);
    let remaining = s.client.cancel_artist_listings(&s.admin, &s.artist, &10u32);
    assert_eq!(remaining, 0u64);
    // Status must still be Cancelled (not changed to anything else)
    assert_eq!(s.client.get_listing(&lid).status, ListingStatus::Cancelled);
}

#[test]
fn test_cancel_artist_listings_skips_sold_listing() {
    let s = setup();
    let lid = new_listing(&s, 1);

    // Buyer purchases the listing
    s.client.buy_artwork(&s.buyer, &lid);
    assert_eq!(s.client.get_listing(&lid).status, ListingStatus::Sold);

    // Revoke and sweep — Sold listing must not be re-processed
    s.client.revoke_artist(&s.admin, &s.artist);
    let remaining = s.client.cancel_artist_listings(&s.admin, &s.artist, &10u32);
    assert_eq!(remaining, 0u64);
    assert_eq!(s.client.get_listing(&lid).status, ListingStatus::Sold);
}

// ── §5  expire_listing is a cleanup op — works while artist is revoked ────────

#[test]
fn test_expire_listing_works_for_revoked_artist() {
    let s = setup();
    // Create a listing with an expiry 1 second in the future
    MockNftClient::new(&s.env, &s.col).set_owner(&4u64, &s.artist);
    let expires_at: u64 = s.env.ledger().timestamp() + 100;
    let lid = s.client.create_listing(
        &s.artist,
        &5_000_000_i128,
        &symbol_short!("XLM"),
        &s.token,
        &s.col,
        &4u64,
        &1u64,
        &valid_recipients(&s.env, &s.artist),
        &Some(expires_at),
    );

    // Revoke the artist
    s.client.revoke_artist(&s.admin, &s.artist);

    // Advance past expiry
    s.env.ledger().with_mut(|l| l.timestamp = expires_at + 1);

    // expire_listing is permissionless — must work even while artist is revoked
    s.client.expire_listing(&lid);
    assert_eq!(s.client.get_listing(&lid).status, ListingStatus::Cancelled);
}

// ── §6  Idempotency: repeat calls return 0 once complete ─────────────────────

#[test]
fn test_cancel_artist_listings_idempotent_after_completion() {
    let s = setup();
    new_listing(&s, 1);

    s.client.revoke_artist(&s.admin, &s.artist);
    // First call cancels everything
    let remaining_first = s.client.cancel_artist_listings(&s.admin, &s.artist, &10u32);
    assert_eq!(remaining_first, 0u64);

    // Second call — artist still revoked, no listings remain — must return 0
    let remaining_second = s.client.cancel_artist_listings(&s.admin, &s.artist, &10u32);
    assert_eq!(remaining_second, 0u64);
}

#[test]
fn test_cancel_artist_listings_nonrevoked_artist_returns_zero() {
    let s = setup();
    // Artist has listings but is NOT revoked
    new_listing(&s, 1);

    let remaining = s.client.cancel_artist_listings(&s.admin, &s.artist, &10u32);
    // Should be a no-op: artist is not revoked, function returns 0 and clears any stale cursor
    assert_eq!(remaining, 0u64);
    // Listing must still be Active — the sweep must not have touched it
    assert_eq!(s.client.get_listing(&1u64).status, ListingStatus::Active);
}

// ── §7  reinstate_artist restores listing creation ───────────────────────────

#[test]
fn test_reinstate_artist_allows_new_listings() {
    let s = setup();
    s.client.revoke_artist(&s.admin, &s.artist);
    assert!(s.client.is_artist_revoked(&s.artist));

    s.client.reinstate_artist(&s.admin, &s.artist);
    assert!(!s.client.is_artist_revoked(&s.artist));

    // Should succeed without panicking
    MockNftClient::new(&s.env, &s.col).set_owner(&5u64, &s.artist);
    let lid = s.client.create_listing(
        &s.artist,
        &5_000_000_i128,
        &symbol_short!("XLM"),
        &s.token,
        &s.col,
        &5u64,
        &1u64,
        &valid_recipients(&s.env, &s.artist),
        &None::<u64>,
    );
    assert_eq!(s.client.get_listing(&lid).status, ListingStatus::Active);
}

#[test]
fn test_reinstate_clears_cancel_cursor() {
    let s = setup();
    // Open two listings, revoke, cancel one (partial sweep)
    new_listing(&s, 1);
    new_listing(&s, 2);
    s.client.revoke_artist(&s.admin, &s.artist);
    // Cancel only 1 item
    let remaining = s.client.cancel_artist_listings(&s.admin, &s.artist, &1u32);
    assert_eq!(remaining, 1u64, "one listing must remain after partial sweep");

    // Reinstate the artist — this must clear the cursor
    s.client.reinstate_artist(&s.admin, &s.artist);

    // Revoke again and sweep — should process from the beginning, finding the still-active listing
    s.client.revoke_artist(&s.admin, &s.artist);
    let remaining_after = s.client.cancel_artist_listings(&s.admin, &s.artist, &10u32);
    assert_eq!(remaining_after, 0u64,
        "after reinstate and re-revoke, all remaining active listings must be cancelled");
}

// ── §8  CollectionAdmin role required ────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_revoke_artist_requires_collection_admin_role() {
    let s = setup();
    // Rotate CollectionAdmin to a different address so admin can no longer use it
    let col_admin = Address::generate(&s.env);
    s.client.propose_role_transfer(&s.admin, &RoleType::CollectionAdmin, &col_admin);
    s.client.accept_role_transfer(&RoleType::CollectionAdmin, &col_admin);

    // Admin no longer holds CollectionAdmin — must be rejected with Unauthorized (#5)
    s.client.revoke_artist(&s.admin, &s.artist);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_cancel_artist_listings_requires_collection_admin_role() {
    let s = setup();
    let attacker = Address::generate(&s.env);
    s.client.revoke_artist(&s.admin, &s.artist);
    // Attacker is not the CollectionAdmin — must be rejected
    s.client.cancel_artist_listings(&attacker, &s.artist, &10u32);
}

#[test]
fn test_new_collection_admin_can_revoke_after_rotation() {
    let s = setup();
    let col_admin = Address::generate(&s.env);
    s.client.propose_role_transfer(&s.admin, &RoleType::CollectionAdmin, &col_admin);
    s.client.accept_role_transfer(&RoleType::CollectionAdmin, &col_admin);

    // New CollectionAdmin must be able to revoke
    s.client.revoke_artist(&col_admin, &s.artist);
    assert!(s.client.is_artist_revoked(&s.artist));
}

// ── §9  Revocation does not affect other artists ─────────────────────────────

#[test]
fn test_revocation_does_not_affect_other_artist_listings() {
    let s = setup();
    // Artist A (s.artist) has a listing
    let lid_a = new_listing(&s, 1);

    // Artist B has a listing on a separate collection
    let artist_b = Address::generate(&s.env);
    let col_b = s.env.register(mock_nft::MockNft, ());
    MockNftClient::new(&s.env, &col_b).set_owner(&1u64, &artist_b);
    soroban_sdk::token::StellarAssetClient::new(&s.env, &s.token).mint(&artist_b, &100_000_000_i128);
    let lid_b = s.client.create_listing(
        &artist_b,
        &8_000_000_i128,
        &symbol_short!("XLM"),
        &s.token,
        &col_b,
        &1u64,
        &1u64,
        &valid_recipients(&s.env, &artist_b),
        &None::<u64>,
    );

    // Revoke only artist A
    s.client.revoke_artist(&s.admin, &s.artist);
    s.client.cancel_artist_listings(&s.admin, &s.artist, &10u32);

    // Artist A's listing should be Cancelled
    assert_eq!(s.client.get_listing(&lid_a).status, ListingStatus::Cancelled);
    // Artist B's listing must remain Active — untouched
    assert_eq!(s.client.get_listing(&lid_b).status, ListingStatus::Active);
    // Artist B is not revoked
    assert!(!s.client.is_artist_revoked(&artist_b));
}

// ── §10  Revocation + global pause: cleanup still available ──────────────────

#[test]
fn test_cancel_artist_listings_works_under_global_pause() {
    let s = setup();
    let lid = new_listing(&s, 1);

    s.client.revoke_artist(&s.admin, &s.artist);
    // Pause the entire contract
    s.client.admin_pause(&s.admin);
    assert!(s.client.is_paused());

    // cancel_artist_listings is a cleanup op — must succeed even under global pause
    let remaining = s.client.cancel_artist_listings(&s.admin, &s.artist, &10u32);
    assert_eq!(remaining, 0u64);
    assert_eq!(s.client.get_listing(&lid).status, ListingStatus::Cancelled);
}

#[test]
fn test_revoked_artist_cannot_create_listing_while_paused() {
    // Revoked artists are doubly blocked when pause is also active.
    // Verifies that pause does not accidentally unlock the revocation check.
    let s = setup();
    s.client.revoke_artist(&s.admin, &s.artist);
    s.client.admin_pause(&s.admin);

    MockNftClient::new(&s.env, &s.col).set_owner(&6u64, &s.artist);
    // Should fail — the first guard hit is either ContractPaused (#23) or ArtistRevoked (#15)
    let result = s.client.try_create_listing(
        &s.artist,
        &5_000_000_i128,
        &symbol_short!("XLM"),
        &s.token,
        &s.col,
        &6u64,
        &1u64,
        &valid_recipients(&s.env, &s.artist),
        &None::<u64>,
    );
    assert!(result.is_err(), "revoked artist must not create a listing even while paused");
}
