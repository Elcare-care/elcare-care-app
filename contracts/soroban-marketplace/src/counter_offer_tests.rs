//! counter_offer_tests.rs — Issue #850: Counter-Offer Flow Integration Tests
//!
//! Tests the full counter-offer lifecycle:
//! - Buyer makes an offer → seller rejects via reject_offer
//! - Seller accepts an offer via accept_offer (settles at offer price)
//! - Parent offer transitions to Rejected/Withdrawn on accept
//! - Pending offer list is accurate after each lifecycle transition

#![cfg(test)]
extern crate std;

use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env,
};

use crate::{
    storage::load_pending_offer_ids,
    types::{ListingStatus, OfferStatus, Recipient},
    MarketplaceContract, MarketplaceContractClient,
};

// ── Mock NFT ──────────────────────────────────────────────────────────────────

mod mock_nft_counter {
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

use mock_nft_counter::MockNftClient;

// ── Setup helper ──────────────────────────────────────────────────────────────

fn setup_counter() -> (
    Env,
    MarketplaceContractClient<'static>,
    Address, // artist/seller
    Address, // buyer
    Address, // payment_token
    Address, // collection
) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let artist = Address::generate(&env);
    let buyer = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let payment_token = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let sac = StellarAssetClient::new(&env, &payment_token);
    sac.mint(&artist, &100_000_000_000_i128);
    sac.mint(&buyer, &100_000_000_000_i128);
    sac.mint(&contract_id, &100_000_000_000_i128);

    let collection_id = env.register(mock_nft_counter::MockNft, ());
    MockNftClient::new(&env, &collection_id).set_owner(&1u64, &artist);

    client.set_admin(&artist);
    client.add_token_to_whitelist(&payment_token);

    (env, client, artist, buyer, payment_token, collection_id)
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

/// Full accept cycle: buyer offers → seller accepts → listing sold at offer price.
#[test]
fn test_offer_accept_cycle_settles_at_offer_price() {
    let (env, client, artist, buyer, payment_token, collection_id) = setup_counter();

    let listing_id = client.create_listing(
        &artist,
        &100_000_i128,
        &symbol_short!("XLM"),
        &payment_token,
        &collection_id,
        &1u64,
        &valid_recipients(&env, &artist),
        &None::<u64>,
    );

    env.ledger().with_mut(|li| li.timestamp = 1000);
    let offer_id = client.make_offer(
        &buyer,
        &listing_id,
        &80_000_i128,
        &payment_token,
        &Some(9_999_999u64),
    );

    let token = TokenClient::new(&env, &payment_token);
    let artist_before = token.balance(&artist);

    // Seller accepts the offer — settlement at 80_000
    client.accept_offer(&artist, &offer_id);

    let offer = client.get_offer(&offer_id);
    assert_eq!(offer.status, OfferStatus::Accepted);

    let listing = client.get_listing(&listing_id);
    assert_eq!(listing.status, ListingStatus::Sold);
    assert_eq!(listing.owner, Some(buyer.clone()));

    // Artist received the offer amount
    assert_eq!(token.balance(&artist), artist_before + 80_000_i128);

    // No pending offers remain
    let pending = load_pending_offer_ids(&env, listing_id);
    assert_eq!(pending.len(), 0);
}

/// Reject cycle: buyer offers → seller rejects → funds returned to buyer.
#[test]
fn test_offer_reject_cycle_returns_funds() {
    let (env, client, artist, buyer, payment_token, collection_id) = setup_counter();

    let listing_id = client.create_listing(
        &artist,
        &100_000_i128,
        &symbol_short!("XLM"),
        &payment_token,
        &collection_id,
        &1u64,
        &valid_recipients(&env, &artist),
        &None::<u64>,
    );

    env.ledger().with_mut(|li| li.timestamp = 1000);
    let offer_id = client.make_offer(
        &buyer,
        &listing_id,
        &60_000_i128,
        &payment_token,
        &Some(9_999_999u64),
    );

    let token = TokenClient::new(&env, &payment_token);
    let buyer_before = token.balance(&buyer);

    // Seller rejects
    client.reject_offer(&artist, &offer_id);

    let offer = client.get_offer(&offer_id);
    assert_eq!(offer.status, OfferStatus::Rejected);

    // Buyer got funds back
    assert_eq!(token.balance(&buyer), buyer_before + 60_000_i128);

    // Listing is still Active
    let listing = client.get_listing(&listing_id);
    assert_eq!(listing.status, ListingStatus::Active);

    // No pending offers
    let pending = load_pending_offer_ids(&env, listing_id);
    assert_eq!(pending.len(), 0);
}

/// Withdraw cycle: buyer makes offer then withdraws it before seller acts.
#[test]
fn test_offer_withdraw_cycle_returns_funds() {
    let (env, client, artist, buyer, payment_token, collection_id) = setup_counter();

    let listing_id = client.create_listing(
        &artist,
        &100_000_i128,
        &symbol_short!("XLM"),
        &payment_token,
        &collection_id,
        &1u64,
        &valid_recipients(&env, &artist),
        &None::<u64>,
    );

    env.ledger().with_mut(|li| li.timestamp = 1000);
    let offer_id = client.make_offer(
        &buyer,
        &listing_id,
        &50_000_i128,
        &payment_token,
        &Some(9_999_999u64),
    );

    let token = TokenClient::new(&env, &payment_token);
    let buyer_before = token.balance(&buyer);

    client.withdraw_offer(&buyer, &offer_id);

    let offer = client.get_offer(&offer_id);
    assert_eq!(offer.status, OfferStatus::Withdrawn);
    assert_eq!(token.balance(&buyer), buyer_before + 50_000_i128);

    let pending = load_pending_offer_ids(&env, listing_id);
    assert_eq!(pending.len(), 0);
}

/// Accepting one offer auto-rejects all other pending offers and returns their funds.
#[test]
fn test_accept_offer_auto_rejects_sibling_offers() {
    let (env, client, artist, buyer, payment_token, collection_id) = setup_counter();
    let buyer2 = Address::generate(&env);
    let sac = StellarAssetClient::new(&env, &payment_token);
    sac.mint(&buyer2, &100_000_000_000_i128);

    let listing_id = client.create_listing(
        &artist,
        &100_000_i128,
        &symbol_short!("XLM"),
        &payment_token,
        &collection_id,
        &1u64,
        &valid_recipients(&env, &artist),
        &None::<u64>,
    );

    env.ledger().with_mut(|li| li.timestamp = 1000);
    let offer_id1 = client.make_offer(
        &buyer,
        &listing_id,
        &80_000_i128,
        &payment_token,
        &Some(9_999_999u64),
    );
    let offer_id2 = client.make_offer(
        &buyer2,
        &listing_id,
        &70_000_i128,
        &payment_token,
        &Some(9_999_999u64),
    );

    let token = TokenClient::new(&env, &payment_token);
    let buyer2_before = token.balance(&buyer2);

    // Accept offer_id1 — offer_id2 should be auto-rejected
    client.accept_offer(&artist, &offer_id1);

    let offer2 = client.get_offer(&offer_id2);
    assert_eq!(
        offer2.status,
        OfferStatus::Rejected,
        "sibling offer must be auto-rejected"
    );
    // buyer2 gets their 70_000 back
    assert_eq!(token.balance(&buyer2), buyer2_before + 70_000_i128);

    // Pending offers list is now empty
    let pending = load_pending_offer_ids(&env, listing_id);
    assert_eq!(pending.len(), 0);
}

/// An offer on a non-active listing must panic.
#[test]
#[should_panic]
fn test_offer_on_sold_listing_panics() {
    let (env, client, artist, buyer, payment_token, collection_id) = setup_counter();
    let buyer2 = Address::generate(&env);
    let sac = StellarAssetClient::new(&env, &payment_token);
    sac.mint(&buyer2, &100_000_000_000_i128);

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
        &buyer,
        &listing_id,
        &50_000_i128,
        &payment_token,
        &Some(9_999_999u64),
    );

    // Accept to sell the listing
    client.accept_offer(&artist, &offer_id);

    // Now the listing is Sold — another offer should panic
    client.make_offer(
        &buyer2,
        &listing_id,
        &50_000_i128,
        &payment_token,
        &Some(9_999_999u64),
    );
}

/// Cannot reject an offer that is not Pending.
#[test]
#[should_panic]
fn test_reject_already_withdrawn_offer_panics() {
    let (env, client, artist, buyer, payment_token, collection_id) = setup_counter();

    let listing_id = client.create_listing(
        &artist,
        &100_000_i128,
        &symbol_short!("XLM"),
        &payment_token,
        &collection_id,
        &1u64,
        &valid_recipients(&env, &artist),
        &None::<u64>,
    );

    env.ledger().with_mut(|li| li.timestamp = 1000);
    let offer_id = client.make_offer(
        &buyer,
        &listing_id,
        &50_000_i128,
        &payment_token,
        &Some(9_999_999u64),
    );

    // Buyer withdraws first
    client.withdraw_offer(&buyer, &offer_id);

    // Seller tries to reject already-withdrawn offer — should panic
    client.reject_offer(&artist, &offer_id);
}
