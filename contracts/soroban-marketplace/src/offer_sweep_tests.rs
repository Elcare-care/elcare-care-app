//! offer_sweep_tests.rs — Issue #850: Offer Expiry Sweep Integration Tests
//!
//! Tests the `sweep_expired_offers` (reclaim_offer) mechanism:
//! - Expired offers transition to Withdrawn and funds are returned
//! - Non-expired (still Pending) offers survive the sweep unchanged
//! - ListingPendingOffers count decreases correctly after sweeps
//! - The global OfferCount counter is append-only and never decremented

#![cfg(test)]
extern crate std;

use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env,
};

use crate::{
    storage::{load_offer, load_pending_offer_ids},
    types::{Listing, ListingStatus, Offer, OfferStatus, Recipient},
    MarketplaceContract, MarketplaceContractClient,
};

// ── Mock NFT (re-declared locally so this module is self-contained) ───────────

mod mock_nft_sweep {
    use soroban_sdk::{contract, contractimpl, Address, Env};

    #[soroban_sdk::contracttype]
    enum NftKey {
        Owner(u64),
    }

    #[contract]
    pub struct MockNft;

    #[contractimpl]
    impl MockNft {
        pub fn owner_of(env: Env, token_id: u64) -> Address {
            env.storage()
                .instance()
                .get::<NftKey, Address>(&NftKey::Owner(token_id))
                .expect("token has no owner")
        }
        pub fn set_owner(env: Env, token_id: u64, owner: Address) {
            env.storage()
                .instance()
                .set(&NftKey::Owner(token_id), &owner);
        }
        pub fn transfer_from(
            env: Env,
            _spender: Address,
            from: Address,
            to: Address,
            token_id: u64,
        ) {
            let cur: Address = env
                .storage()
                .instance()
                .get::<NftKey, Address>(&NftKey::Owner(token_id))
                .expect("token has no owner");
            assert_eq!(cur, from, "transfer_from: wrong owner");
            env.storage()
                .instance()
                .set(&NftKey::Owner(token_id), &to);
        }
        pub fn royalty_info(env: Env) -> (Address, u32) {
            use soroban_sdk::testutils::Address as _;
            (Address::generate(&env), 0u32)
        }
    }
}

use mock_nft_sweep::MockNftClient;

// ── Setup helper ──────────────────────────────────────────────────────────────

fn setup_sweep() -> (
    Env,
    MarketplaceContractClient<'static>,
    Address, // admin/artist
    Address, // buyer1
    Address, // buyer2
    Address, // buyer3
    Address, // payment_token
    Address, // collection_id
) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let artist = Address::generate(&env);
    let buyer1 = Address::generate(&env);
    let buyer2 = Address::generate(&env);
    let buyer3 = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let payment_token = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let sac = StellarAssetClient::new(&env, &payment_token);
    sac.mint(&artist, &100_000_000_000_i128);
    sac.mint(&buyer1, &100_000_000_000_i128);
    sac.mint(&buyer2, &100_000_000_000_i128);
    sac.mint(&buyer3, &100_000_000_000_i128);
    sac.mint(&contract_id, &100_000_000_000_i128);

    let collection_id = env.register(mock_nft_sweep::MockNft, ());
    MockNftClient::new(&env, &collection_id).set_owner(&1u64, &artist);

    client.set_admin(&artist);
    client.add_token_to_whitelist(&payment_token);

    (
        env,
        client,
        artist,
        buyer1,
        buyer2,
        buyer3,
        payment_token,
        collection_id,
    )
}

fn valid_recipients(env: &Env, artist: &Address) -> soroban_sdk::Vec<Recipient> {
    vec![
        env,
        Recipient {
            address: artist.clone(),
            percentage: 10_000,
        },
    ]
}

// ── Tests ─────────────────────────────────────────────────────────────────────

/// Setup scenario: one listing, three offers (two expired, one still pending).
/// Returns (listing_id, expired_offer1_id, expired_offer2_id, active_offer_id).
fn setup_expired_offer_scenario(
    env: &Env,
    client: &MarketplaceContractClient,
    artist: &Address,
    buyer1: &Address,
    buyer2: &Address,
    buyer3: &Address,
    payment_token: &Address,
    collection_id: &Address,
) -> (u64, u64, u64, u64) {
    let listing_id = client.create_listing(
        artist,
        &50_000_i128,
        &symbol_short!("XLM"),
        payment_token,
        collection_id,
        &1u64,
        &valid_recipients(env, artist),
        &None::<u64>,
    );

    // Set ledger timestamp to 1000 so we can place offers
    env.ledger().with_mut(|li| li.timestamp = 1000);

    // Two offers that expire at timestamp 2000 (will be expired when we advance to 3000)
    let exp_id1 = client.make_offer(
        buyer1,
        &listing_id,
        &1_000_i128,
        payment_token,
        &Some(2000u64),
    );
    let exp_id2 = client.make_offer(
        buyer2,
        &listing_id,
        &2_000_i128,
        payment_token,
        &Some(2000u64),
    );

    // One offer that expires far in the future — should survive
    let active_id = client.make_offer(
        buyer3,
        &listing_id,
        &3_000_i128,
        payment_token,
        &Some(9_999_999u64),
    );

    (listing_id, exp_id1, exp_id2, active_id)
}

/// Reclaiming an expired offer returns the escrowed funds to the offerer
/// and transitions the offer to Withdrawn.
#[test]
fn test_expired_offer_reclaim_returns_funds() {
    let (env, client, artist, buyer1, buyer2, buyer3, payment_token, collection_id) =
        setup_sweep();

    let (listing_id, exp_id1, exp_id2, active_id) = setup_expired_offer_scenario(
        &env,
        &client,
        &artist,
        &buyer1,
        &buyer2,
        &buyer3,
        &payment_token,
        &collection_id,
    );

    let token = TokenClient::new(&env, &payment_token);
    let buyer1_before = token.balance(&buyer1);
    let buyer2_before = token.balance(&buyer2);

    // Advance past expiry
    env.ledger().with_mut(|li| li.timestamp = 3000);

    // buyer1 reclaims their expired offer
    client.reclaim_offer(&exp_id1);
    let offer1 = client.get_offer(&exp_id1);
    assert_eq!(
        offer1.status,
        OfferStatus::Withdrawn,
        "expired offer should be Withdrawn after reclaim"
    );
    assert_eq!(
        token.balance(&buyer1),
        buyer1_before + 1_000_i128,
        "buyer1 should get their escrow back"
    );

    // buyer2 reclaims their expired offer
    client.reclaim_offer(&exp_id2);
    let offer2 = client.get_offer(&exp_id2);
    assert_eq!(offer2.status, OfferStatus::Withdrawn);
    assert_eq!(token.balance(&buyer2), buyer2_before + 2_000_i128);

    // Active offer should still be Pending
    let active = client.get_offer(&active_id);
    assert_eq!(
        active.status,
        OfferStatus::Pending,
        "non-expired offer must remain Pending"
    );

    // Pending offers count for the listing should now be 1 (only active_id remains)
    let pending = load_pending_offer_ids(&env, listing_id);
    assert_eq!(
        pending.len(),
        1,
        "ListingPendingOffers should have exactly 1 entry remaining"
    );
    assert_eq!(pending.get(0).unwrap(), active_id);
}

/// Attempting to reclaim an offer that has NOT expired must panic.
#[test]
#[should_panic]
fn test_reclaim_non_expired_offer_panics() {
    let (env, client, artist, buyer1, _b2, _b3, payment_token, collection_id) = setup_sweep();

    let listing_id = client.create_listing(
        &artist,
        &50_000_i128,
        &symbol_short!("XLM"),
        &payment_token,
        &collection_id,
        &1u64,
        &valid_recipients(&env, &artist),
        &None::<u64>,
    );

    env.ledger().with_mut(|li| li.timestamp = 1000);
    let offer_id = client.make_offer(
        &buyer1,
        &listing_id,
        &1_000_i128,
        &payment_token,
        &Some(9_999_999u64),
    );

    // Still before expiry — should panic
    client.reclaim_offer(&offer_id);
}

/// An offer with no expiry cannot be reclaimed (only withdrawn by the offerer).
#[test]
#[should_panic]
fn test_reclaim_offer_without_expiry_panics() {
    let (env, client, artist, buyer1, _b2, _b3, payment_token, collection_id) = setup_sweep();

    let listing_id = client.create_listing(
        &artist,
        &50_000_i128,
        &symbol_short!("XLM"),
        &payment_token,
        &collection_id,
        &1u64,
        &valid_recipients(&env, &artist),
        &None::<u64>,
    );

    env.ledger().with_mut(|li| li.timestamp = 1000);
    let offer_id = client.make_offer(
        &buyer1,
        &listing_id,
        &1_000_i128,
        &payment_token,
        &None::<u64>, // no expiry
    );

    // Advance time — but offer has no expiry, so reclaim should still panic
    env.ledger().with_mut(|li| li.timestamp = 99_999_999);
    client.reclaim_offer(&offer_id);
}

/// The global OfferCount is append-only: reclaiming expired offers does not
/// decrement it.
#[test]
fn test_offer_count_is_append_only() {
    let (env, client, artist, buyer1, buyer2, _b3, payment_token, collection_id) = setup_sweep();

    let listing_id = client.create_listing(
        &artist,
        &50_000_i128,
        &symbol_short!("XLM"),
        &payment_token,
        &collection_id,
        &1u64,
        &valid_recipients(&env, &artist),
        &None::<u64>,
    );

    env.ledger().with_mut(|li| li.timestamp = 1000);
    let _oid1 = client.make_offer(
        &buyer1,
        &listing_id,
        &1_000_i128,
        &payment_token,
        &Some(2000u64),
    );
    let _oid2 = client.make_offer(
        &buyer2,
        &listing_id,
        &1_500_i128,
        &payment_token,
        &Some(2000u64),
    );

    // Count should be 2 before any expiry
    assert_eq!(client.get_total_offers(), 2u64);

    // Advance past expiry and reclaim both
    env.ledger().with_mut(|li| li.timestamp = 3000);
    client.reclaim_offer(&_oid1);
    client.reclaim_offer(&_oid2);

    // Count must still be 2 — it is append-only
    assert_eq!(
        client.get_total_offers(),
        2u64,
        "OfferCount is append-only and must not decrease after reclaims"
    );
}

/// After reclaiming expired offers, load_pending_offer_ids reflects only the
/// remaining pending offers.
#[test]
fn test_pending_offer_list_accuracy_after_reclaims() {
    let (env, client, artist, buyer1, buyer2, buyer3, payment_token, collection_id) =
        setup_sweep();

    let (listing_id, exp_id1, exp_id2, active_id) = setup_expired_offer_scenario(
        &env,
        &client,
        &artist,
        &buyer1,
        &buyer2,
        &buyer3,
        &payment_token,
        &collection_id,
    );

    // Before any reclaims: 3 pending
    let before = load_pending_offer_ids(&env, listing_id);
    assert_eq!(before.len(), 3);

    env.ledger().with_mut(|li| li.timestamp = 3000);
    client.reclaim_offer(&exp_id1);
    client.reclaim_offer(&exp_id2);

    // After reclaims: only active_id remains
    let after = load_pending_offer_ids(&env, listing_id);
    assert_eq!(after.len(), 1);
    assert_eq!(after.get(0).unwrap(), active_id);
}
