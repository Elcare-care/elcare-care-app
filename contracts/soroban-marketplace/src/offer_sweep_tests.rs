// offer_sweep_tests.rs — Offer auto-expiry sweep (Issue #470)
//
// Coverage:
//   - Expired pending offer is swept to Expired status and escrow returned
//   - Non-expired offer is silently skipped
//   - Non-pending offer (accepted, withdrawn, expired) is silently skipped
//   - Non-expiring offer (expires_at = None) is silently skipped
//   - Batch limit (> 20) panics with BatchTooLarge
//   - Partial batch: only expired offers in the batch are swept
//   - Repeated sweep on the same offer is a no-op (idempotent retry)
//   - Mixed active/expired batch: only expired are swept; return count is accurate
//   - Expired offer cannot be accepted after sweep

use super::*;
use crate::types::OfferStatus;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Ledger},
    vec, Address, Env,
};

use crate::test::{mock_nft, MockNftClient, valid_recipients};
use soroban_sdk::token::StellarAssetClient;

// ── Shared setup ─────────────────────────────────────────────────────────────

fn sweep_setup() -> (
    Env,
    MarketplaceContractClient<'static>,
    Address, // admin
    Address, // artist
    Address, // buyer
    Address, // payment_token
    Address, // collection
) {
    let env = Env::default();
    env.mock_all_auths();
    let cid = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &cid);
    let admin = Address::generate(&env);
    let artist = Address::generate(&env);
    let buyer = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let payment_token = env.register_stellar_asset_contract_v2(token_admin.clone()).address();
    let sac = StellarAssetClient::new(&env, &payment_token);
    sac.mint(&artist, &100_000_000_000_i128);
    sac.mint(&buyer, &100_000_000_000_i128);
    sac.mint(&cid, &100_000_000_000_i128);
    let collection = env.register(mock_nft::MockNft, ());
    MockNftClient::new(&env, &collection).set_owner(&1u64, &artist);
    client.set_admin(&admin);
    (env, client, admin, artist, buyer, payment_token, collection)
}

fn make_listing_and_offer(
    env: &Env,
    client: &MarketplaceContractClient,
    artist: &Address,
    buyer: &Address,
    payment_token: &Address,
    collection: &Address,
    offer_expires_at: Option<u64>,
) -> (u64, u64) {
    let listing_id = client.create_listing(
        artist, &10_000_000_i128, &symbol_short!("XLM"),
        payment_token, collection, &1u64, &1u64,
        &valid_recipients(env, artist), &None::<u64>,
    );
    let offer_id = client.make_offer(
        buyer, &listing_id, &5_000_000_i128, payment_token, &offer_expires_at,
    );
    (listing_id, offer_id)
}

// ── §1  Basic sweep ───────────────────────────────────────────────────────────

#[test]
fn test_sweep_transitions_expired_offer_to_expired_status() {
    let (env, client, _, artist, buyer, token, collection) = sweep_setup();
    let now = env.ledger().timestamp();
    let expires_at = now + 1_000;
    let (_, offer_id) = make_listing_and_offer(&env, &client, &artist, &buyer, &token, &collection, Some(expires_at));

    // Advance past expiry.
    env.ledger().with_mut(|l| l.timestamp = now + 1_001);
    let swept = client.sweep_expired_offers(&vec![&env, offer_id]);
    assert_eq!(swept, 1);

    let offer = client.get_offer(&offer_id);
    assert_eq!(offer.status, OfferStatus::Expired);
}

#[test]
fn test_sweep_returns_escrow_to_offerer() {
    let (env, client, _, artist, buyer, token, collection) = sweep_setup();
    let sac = soroban_sdk::token::TokenClient::new(&env, &token);
    let buyer_balance_before = sac.balance(&buyer);

    let now = env.ledger().timestamp();
    let (_, offer_id) = make_listing_and_offer(
        &env, &client, &artist, &buyer, &token, &collection, Some(now + 500),
    );
    env.ledger().with_mut(|l| l.timestamp = now + 501);
    client.sweep_expired_offers(&vec![&env, offer_id]);

    let buyer_balance_after = sac.balance(&buyer);
    assert_eq!(buyer_balance_after, buyer_balance_before,
        "buyer balance must be restored after sweep");
}

#[test]
fn test_sweep_does_not_affect_non_expired_offer() {
    let (env, client, _, artist, buyer, token, collection) = sweep_setup();
    let now = env.ledger().timestamp();
    let (_, offer_id) = make_listing_and_offer(
        &env, &client, &artist, &buyer, &token, &collection, Some(now + 10_000),
    );
    let swept = client.sweep_expired_offers(&vec![&env, offer_id]);
    assert_eq!(swept, 0);

    let offer = client.get_offer(&offer_id);
    assert_eq!(offer.status, OfferStatus::Pending, "non-expired offer must remain Pending");
}

#[test]
fn test_sweep_skips_non_expiring_offer() {
    let (env, client, _, artist, buyer, token, collection) = sweep_setup();
    let (_, offer_id) = make_listing_and_offer(
        &env, &client, &artist, &buyer, &token, &collection, None,
    );
    env.ledger().with_mut(|l| l.timestamp += 999_999);
    let swept = client.sweep_expired_offers(&vec![&env, offer_id]);
    assert_eq!(swept, 0, "non-expiring offer must never be swept");
}

// ── §2  Idempotency and retry-safety ─────────────────────────────────────────

#[test]
fn test_sweep_repeated_on_same_offer_is_noop() {
    let (env, client, _, artist, buyer, token, collection) = sweep_setup();
    let now = env.ledger().timestamp();
    let (_, offer_id) = make_listing_and_offer(
        &env, &client, &artist, &buyer, &token, &collection, Some(now + 100),
    );
    env.ledger().with_mut(|l| l.timestamp = now + 200);
    let first = client.sweep_expired_offers(&vec![&env, offer_id]);
    let second = client.sweep_expired_offers(&vec![&env, offer_id]);
    assert_eq!(first, 1);
    assert_eq!(second, 0, "second sweep must be a no-op");
}

// ── §3  Mixed active/expired batch ────────────────────────────────────────────

#[test]
fn test_sweep_mixed_batch_only_sweeps_expired() {
    let (env, client, _, artist, buyer, token, collection) = sweep_setup();
    // Create a second collection and offer so we can have two distinct listings.
    let collection2 = env.register(mock_nft::MockNft, ());
    MockNftClient::new(&env, &collection2).set_owner(&2u64, &artist);
    let now = env.ledger().timestamp();

    let (_, offer_expired) = make_listing_and_offer(
        &env, &client, &artist, &buyer, &token, &collection, Some(now + 100),
    );
    // Second offer on a fresh listing with token 2.
    let listing2 = client.create_listing(
        &artist, &10_000_000_i128, &symbol_short!("XLM"),
        &token, &collection2, &2u64, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
    let offer_active = client.make_offer(
        &buyer, &listing2, &5_000_000_i128, &token, &Some(now + 99_999),
    );

    env.ledger().with_mut(|l| l.timestamp = now + 200);
    let swept = client.sweep_expired_offers(&vec![&env, offer_expired, offer_active]);
    assert_eq!(swept, 1, "only the expired offer must be swept");

    assert_eq!(client.get_offer(&offer_expired).status, OfferStatus::Expired);
    assert_eq!(client.get_offer(&offer_active).status, OfferStatus::Pending);
}

// ── §4  Batch limit ───────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #36)")]
fn test_sweep_batch_too_large_panics() {
    let (env, client, _, _, _, _, _) = sweep_setup();
    // Build a vec of 21 ids (ids are arbitrary — limit check runs first).
    let mut ids = soroban_sdk::Vec::new(&env);
    for i in 0u64..21 {
        ids.push_back(i + 1);
    }
    // BatchTooLarge = 36
    client.sweep_expired_offers(&ids);
}

// ── §5  Expired offer cannot be accepted ─────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #33)")]
fn test_accept_swept_offer_panics() {
    let (env, client, _, artist, buyer, token, collection) = sweep_setup();
    let now = env.ledger().timestamp();
    let (_, offer_id) = make_listing_and_offer(
        &env, &client, &artist, &buyer, &token, &collection, Some(now + 100),
    );
    env.ledger().with_mut(|l| l.timestamp = now + 200);
    client.sweep_expired_offers(&vec![&env, offer_id]);
    // InvalidOfferState = 33 (offer.status is Expired, not Pending)
    client.accept_offer(&artist, &offer_id);
}

// ── §6  Missing offer id is silently skipped ─────────────────────────────────

#[test]
fn test_sweep_unknown_offer_id_silently_skipped() {
    let (env, client, _, _, _, _, _) = sweep_setup();
    // Offer ID 9999 does not exist.
    let swept = client.sweep_expired_offers(&vec![&env, 9999u64]);
    assert_eq!(swept, 0);
}
