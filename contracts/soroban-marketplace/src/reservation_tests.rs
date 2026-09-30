// reservation_tests.rs — Issue #462
//
// Verifies seller-controlled listing reservation windows:
//   - Reservation blocks non-reserved buyers during the active window
//   - Reserved buyer can purchase during the window
//   - Any buyer can purchase after the window expires
//   - set_listing_reservation with None clears the reservation and emits event
//   - get_listing_reservation returns current values
//   - Invalid window configurations are rejected

use crate::test::{mock_nft, valid_recipients, MockNftClient};
use crate::types::MarketplaceError;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _, Ledger},
    vec, Address, Env,
};
use crate::contract::{MarketplaceContract, MarketplaceContractClient};
use soroban_sdk::token::StellarAssetClient;

fn setup() -> (
    Env,
    MarketplaceContractClient<'static>,
    Address, // admin/seller
    Address, // buyer
    Address, // reserved_buyer
    Address, // payment_token
    Address, // collection_id
) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &contract_id);
    let seller = Address::generate(&env);
    let buyer = Address::generate(&env);
    let reserved_buyer = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let payment_token = env.register_stellar_asset_contract_v2(token_admin.clone()).address();
    let sac = StellarAssetClient::new(&env, &payment_token);
    sac.mint(&seller, &100_000_000_000_i128);
    sac.mint(&buyer, &100_000_000_000_i128);
    sac.mint(&reserved_buyer, &100_000_000_000_i128);
    sac.mint(&contract_id, &100_000_000_000_i128);
    let collection_id = env.register(mock_nft::MockNft, ());
    MockNftClient::new(&env, &collection_id).set_owner(&1u64, &seller);
    client.set_admin(&seller);
    client.add_token_to_whitelist(&seller, &payment_token);
    (env, client, seller, buyer, reserved_buyer, payment_token, collection_id)
}

fn create_listing(
    env: &Env,
    client: &MarketplaceContractClient,
    seller: &Address,
    token: &Address,
    collection: &Address,
) -> u64 {
    client.create_listing(
        seller, &10_000_000_i128, &symbol_short!("XLM"),
        token, collection, &1u64, &1u64,
        &valid_recipients(env, seller), &None::<u64>,
    )
}

// ── Test: reservation blocks non-reserved buyer during active window ──────────

#[test]
#[should_panic(expected = "Error(Contract, #65)")]
fn test_reservation_blocks_non_reserved_buyer() {
    let (env, client, seller, buyer, _reserved, token, col) = setup();
    let listing_id = create_listing(&env, &client, &seller, &token, &col);

    // Set timestamp so the reservation window is active
    env.ledger().set_timestamp(1_000);
    client.set_listing_reservation(
        &seller, &listing_id,
        &Some(Address::generate(&env)), // reserved for someone else
        &None::<u64>,
        &Some(5_000_u64), // window ends at timestamp 5000
    );

    // buyer (not the reserved address) tries to buy — must fail
    client.buy_artwork(&buyer, &listing_id);
}

// ── Test: reserved buyer can purchase during the window ───────────────────────

#[test]
fn test_reserved_buyer_can_purchase_during_window() {
    let (env, client, seller, _buyer, reserved_buyer, token, col) = setup();
    let listing_id = create_listing(&env, &client, &seller, &token, &col);

    env.ledger().set_timestamp(1_000);
    client.set_listing_reservation(
        &seller, &listing_id,
        &Some(reserved_buyer.clone()),
        &None::<u64>,
        &Some(5_000_u64),
    );

    // reserved_buyer buys — must succeed
    assert!(client.buy_artwork(&reserved_buyer, &listing_id));
}

// ── Test: any buyer can purchase after the reservation window expires ─────────

#[test]
fn test_any_buyer_can_purchase_after_window_expires() {
    let (env, client, seller, buyer, reserved_buyer, token, col) = setup();
    let listing_id = create_listing(&env, &client, &seller, &token, &col);

    env.ledger().set_timestamp(1_000);
    client.set_listing_reservation(
        &seller, &listing_id,
        &Some(reserved_buyer.clone()),
        &None::<u64>,
        &Some(3_000_u64),
    );

    // Advance past the window end
    env.ledger().set_timestamp(3_001);
    // Non-reserved buyer can now purchase
    assert!(client.buy_artwork(&buyer, &listing_id));
}

// ── Test: reservation with start time — before start window is open to all ───

#[test]
fn test_before_reservation_start_any_buyer_can_purchase() {
    let (env, client, seller, buyer, reserved_buyer, token, col) = setup();
    let listing_id = create_listing(&env, &client, &seller, &token, &col);

    env.ledger().set_timestamp(500);
    client.set_listing_reservation(
        &seller, &listing_id,
        &Some(reserved_buyer.clone()),
        &Some(2_000_u64), // window starts at 2000
        &Some(5_000_u64), // window ends at 5000
    );

    // timestamp 500 < 2000 (start) — any buyer can purchase
    assert!(client.buy_artwork(&buyer, &listing_id));
}

// ── Test: clear reservation emits event and allows any buyer ─────────────────

#[test]
fn test_clear_reservation_allows_any_buyer() {
    let (env, client, seller, buyer, reserved_buyer, token, col) = setup();
    let listing_id = create_listing(&env, &client, &seller, &token, &col);

    env.ledger().set_timestamp(1_000);
    client.set_listing_reservation(
        &seller, &listing_id,
        &Some(reserved_buyer.clone()),
        &None::<u64>,
        &Some(9_999_u64),
    );

    // Clear the reservation
    client.set_listing_reservation(
        &seller, &listing_id,
        &None::<Address>,
        &None::<u64>,
        &None::<u64>,
    );

    // Now any buyer can purchase even during the old window
    assert!(client.buy_artwork(&buyer, &listing_id));
}

// ── Test: clear reservation emits listing_reservation_set event ───────────────
// NOTE: env.events().all() in SDK 25.3.0 returns only the last invocation's
// events, so we assert once per call rather than accumulating across two calls.

fn count_reservation_set_events(env: &Env) -> usize {
    env.events().all().events().iter().filter(|e| {
        use soroban_sdk::xdr::{ContractEventBody, ScVal};
        if let ContractEventBody::V0(v0) = &e.body {
            if let Some(ScVal::Symbol(s)) = v0.topics.first() {
                return core::str::from_utf8(s.0.as_slice()).unwrap_or("")
                    == "listing_reservation_set";
            }
        }
        false
    }).count()
}

#[test]
fn test_clear_reservation_emits_event() {
    let (env, client, seller, _buyer, reserved_buyer, token, col) = setup();
    let listing_id = create_listing(&env, &client, &seller, &token, &col);

    env.ledger().set_timestamp(1_000);
    client.set_listing_reservation(
        &seller, &listing_id,
        &Some(reserved_buyer.clone()),
        &None::<u64>,
        &Some(9_999_u64),
    );
    // Verify the set call emitted one event.
    assert_eq!(count_reservation_set_events(&env), 1, "setting reservation must emit event");

    client.set_listing_reservation(
        &seller, &listing_id,
        &None::<Address>,
        &None::<u64>,
        &None::<u64>,
    );
    // Verify the clear call also emits one event.
    assert_eq!(count_reservation_set_events(&env), 1, "clearing reservation must emit event");
}

// ── Test: get_listing_reservation returns current values ─────────────────────

#[test]
fn test_get_listing_reservation() {
    let (env, client, seller, _buyer, reserved_buyer, token, col) = setup();
    let listing_id = create_listing(&env, &client, &seller, &token, &col);

    // Initially no reservation
    let (rf, rs, re) = client.get_listing_reservation(&listing_id);
    assert!(rf.is_none());
    assert!(rs.is_none());
    assert!(re.is_none());

    env.ledger().set_timestamp(1_000);
    client.set_listing_reservation(
        &seller, &listing_id,
        &Some(reserved_buyer.clone()),
        &Some(2_000_u64),
        &Some(8_000_u64),
    );

    let (rf, rs, re) = client.get_listing_reservation(&listing_id);
    assert_eq!(rf, Some(reserved_buyer));
    assert_eq!(rs, Some(2_000_u64));
    assert_eq!(re, Some(8_000_u64));
}

// ── Test: invalid window — end in the past — rejected ────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #66)")]
fn test_invalid_reservation_window_end_in_past() {
    let (env, client, seller, _buyer, reserved_buyer, token, col) = setup();
    let listing_id = create_listing(&env, &client, &seller, &token, &col);

    env.ledger().set_timestamp(5_000); // now is 5000
    client.set_listing_reservation(
        &seller, &listing_id,
        &Some(reserved_buyer.clone()),
        &None::<u64>,
        &Some(3_000_u64), // end (3000) <= now (5000) → invalid
    );
}

// ── Test: invalid window — start >= end — rejected ────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #66)")]
fn test_invalid_reservation_window_start_ge_end() {
    let (env, client, seller, _buyer, reserved_buyer, token, col) = setup();
    let listing_id = create_listing(&env, &client, &seller, &token, &col);

    env.ledger().set_timestamp(1_000);
    client.set_listing_reservation(
        &seller, &listing_id,
        &Some(reserved_buyer.clone()),
        &Some(6_000_u64), // start >= end → invalid
        &Some(5_000_u64),
    );
}

// ── Test: non-seller cannot set reservation ───────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_non_seller_cannot_set_reservation() {
    let (env, client, seller, buyer, reserved_buyer, token, col) = setup();
    let listing_id = create_listing(&env, &client, &seller, &token, &col);

    env.ledger().set_timestamp(1_000);
    // buyer (not the seller) tries to set reservation — must fail with Unauthorized
    client.set_listing_reservation(
        &buyer, &listing_id,
        &Some(reserved_buyer.clone()),
        &None::<u64>,
        &Some(9_999_u64),
    );
}

// ── Test: no reservation window — any buyer can purchase ─────────────────────

#[test]
fn test_no_reservation_any_buyer_can_purchase() {
    let (env, client, seller, buyer, _reserved, token, col) = setup();
    let listing_id = create_listing(&env, &client, &seller, &token, &col);

    // No reservation set — any buyer can purchase
    assert!(client.buy_artwork(&buyer, &listing_id));
}
