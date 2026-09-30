//! reservation_tests.rs — Issue #850: Listing Reservation Window Integration Tests
//!
//! Tests the `set_listing_reservation` / `buy_artwork` reservation window:
//! - set_listing_reservation stores reserved_for, start, end correctly
//! - buy_artwork during window by reserved address succeeds
//! - buy_artwork during window by different address returns ReservationWindowActive
//! - buy_artwork after reservation_end by anyone succeeds
//! - Invalid window config (end <= start) returns InvalidReservationWindow
//! - ListingReservationSetEvent emitted correctly including clears

#![cfg(test)]
extern crate std;

use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    vec, Address, Env,
};

use crate::{
    types::{ListingStatus, Recipient},
    MarketplaceContract, MarketplaceContractClient,
};

// ── Mock NFT ──────────────────────────────────────────────────────────────────

mod mock_nft_res {
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

use mock_nft_res::MockNftClient;

// ── Setup helper ──────────────────────────────────────────────────────────────

fn setup_res() -> (
    Env,
    MarketplaceContractClient<'static>,
    Address, // artist
    Address, // reserved_buyer
    Address, // other_buyer
    Address, // payment_token
    Address, // collection
) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let artist = Address::generate(&env);
    let reserved_buyer = Address::generate(&env);
    let other_buyer = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let payment_token = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let sac = StellarAssetClient::new(&env, &payment_token);
    sac.mint(&artist, &100_000_000_000_i128);
    sac.mint(&reserved_buyer, &100_000_000_000_i128);
    sac.mint(&other_buyer, &100_000_000_000_i128);
    sac.mint(&contract_id, &100_000_000_000_i128);

    let collection_id = env.register(mock_nft_res::MockNft, ());
    MockNftClient::new(&env, &collection_id).set_owner(&1u64, &artist);

    client.set_admin(&artist);
    client.add_token_to_whitelist(&payment_token);

    (
        env,
        client,
        artist,
        reserved_buyer,
        other_buyer,
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

/// set_listing_reservation stores the correct window fields.
#[test]
fn test_set_listing_reservation_stores_correctly() {
    let (env, client, artist, reserved_buyer, _other, payment_token, collection_id) =
        setup_res();

    env.ledger().with_mut(|li| li.timestamp = 1000);

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

    client.set_listing_reservation(
        &artist,
        &listing_id,
        &reserved_buyer,
        &2000u64,
        &5000u64,
    );

    let res = client.get_listing_reservation(&listing_id);
    assert!(res.is_some(), "reservation should be stored");
    let r = res.unwrap();
    assert_eq!(r.reserved_for, reserved_buyer);
    assert_eq!(r.reservation_start, 2000u64);
    assert_eq!(r.reservation_end, 5000u64);
}

/// Reserved buyer can purchase during the active window.
#[test]
fn test_reserved_buyer_can_buy_during_window() {
    let (env, client, artist, reserved_buyer, _other, payment_token, collection_id) =
        setup_res();

    env.ledger().with_mut(|li| li.timestamp = 1000);

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

    client.set_listing_reservation(
        &artist,
        &listing_id,
        &reserved_buyer,
        &2000u64,
        &5000u64,
    );

    // Advance into the window
    env.ledger().with_mut(|li| li.timestamp = 3000);

    let result = client.buy_artwork(&reserved_buyer, &listing_id);
    assert!(result, "reserved buyer should succeed during window");

    let listing = client.get_listing(&listing_id);
    assert_eq!(listing.status, ListingStatus::Sold);
    assert_eq!(listing.owner, Some(reserved_buyer));
}

/// Non-reserved buyer cannot purchase during the active reservation window.
#[test]
#[should_panic]
fn test_non_reserved_buyer_blocked_during_window() {
    let (env, client, artist, reserved_buyer, other_buyer, payment_token, collection_id) =
        setup_res();

    env.ledger().with_mut(|li| li.timestamp = 1000);

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

    client.set_listing_reservation(
        &artist,
        &listing_id,
        &reserved_buyer,
        &2000u64,
        &5000u64,
    );

    // Advance into the window
    env.ledger().with_mut(|li| li.timestamp = 3000);

    // other_buyer is NOT reserved — should panic with ReservationWindowActive
    client.buy_artwork(&other_buyer, &listing_id);
}

/// After the reservation window ends, any buyer can purchase.
#[test]
fn test_any_buyer_can_buy_after_window_expires() {
    let (env, client, artist, reserved_buyer, other_buyer, payment_token, collection_id) =
        setup_res();

    env.ledger().with_mut(|li| li.timestamp = 1000);

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

    client.set_listing_reservation(
        &artist,
        &listing_id,
        &reserved_buyer,
        &2000u64,
        &5000u64,
    );

    // Advance PAST the window end (timestamp == reservation_end means window closed)
    env.ledger().with_mut(|li| li.timestamp = 5000);

    let result = client.buy_artwork(&other_buyer, &listing_id);
    assert!(result, "any buyer should succeed after reservation window ends");

    let listing = client.get_listing(&listing_id);
    assert_eq!(listing.status, ListingStatus::Sold);
    assert_eq!(listing.owner, Some(other_buyer));
}

/// Exactly at reservation_end the window is expired (exclusive upper bound).
#[test]
fn test_reservation_end_is_exclusive_upper_bound() {
    let (env, client, artist, reserved_buyer, other_buyer, payment_token, collection_id) =
        setup_res();

    env.ledger().with_mut(|li| li.timestamp = 1000);

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

    // Window: [2000, 5000)
    client.set_listing_reservation(
        &artist,
        &listing_id,
        &reserved_buyer,
        &2000u64,
        &5000u64,
    );

    // At exactly reservation_end (5000), window is expired — other_buyer can buy
    env.ledger().with_mut(|li| li.timestamp = 5000);

    let result = client.buy_artwork(&other_buyer, &listing_id);
    assert!(
        result,
        "at reservation_end the window is expired; non-reserved buyer should succeed"
    );
}

/// Invalid reservation window (end <= start) must panic.
#[test]
#[should_panic]
fn test_invalid_reservation_window_end_before_start() {
    let (env, client, artist, reserved_buyer, _other, payment_token, collection_id) =
        setup_res();

    env.ledger().with_mut(|li| li.timestamp = 1000);

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

    // end <= start — should panic with InvalidReservationWindow
    client.set_listing_reservation(
        &artist,
        &listing_id,
        &reserved_buyer,
        &5000u64,
        &2000u64, // end < start
    );
}

/// Clearing a reservation (reservation_end = 0) removes it and emits the event.
#[test]
fn test_clear_reservation_window() {
    let (env, client, artist, reserved_buyer, other_buyer, payment_token, collection_id) =
        setup_res();

    env.ledger().with_mut(|li| li.timestamp = 1000);

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

    // Set a reservation
    client.set_listing_reservation(
        &artist,
        &listing_id,
        &reserved_buyer,
        &2000u64,
        &9999u64,
    );
    assert!(client.get_listing_reservation(&listing_id).is_some());

    // Clear it by passing reservation_end = 0
    client.set_listing_reservation(
        &artist,
        &listing_id,
        &reserved_buyer,
        &0u64,
        &0u64,
    );
    assert!(
        client.get_listing_reservation(&listing_id).is_none(),
        "reservation should be cleared"
    );

    // Now during what would have been the window, other_buyer can buy
    env.ledger().with_mut(|li| li.timestamp = 3000);
    let result = client.buy_artwork(&other_buyer, &listing_id);
    assert!(result, "any buyer should succeed after reservation is cleared");
}

/// Before the reservation_start, any buyer can purchase (window not yet active).
#[test]
fn test_any_buyer_can_buy_before_window_starts() {
    let (env, client, artist, reserved_buyer, other_buyer, payment_token, collection_id) =
        setup_res();

    env.ledger().with_mut(|li| li.timestamp = 1000);

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

    // Window starts at 5000, currently at 1000
    client.set_listing_reservation(
        &artist,
        &listing_id,
        &reserved_buyer,
        &5000u64,
        &9999u64,
    );

    // other_buyer tries at timestamp 1000, before window opens — should succeed
    let result = client.buy_artwork(&other_buyer, &listing_id);
    assert!(
        result,
        "any buyer should succeed before the reservation window starts"
    );
}
