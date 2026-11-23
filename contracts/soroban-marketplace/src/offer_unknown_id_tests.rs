// offer_unknown_id_tests.rs — Issue 078 (offer withdrawal for unknown identifier)
//
// Offer withdrawal for an unknown identifier should have defined, deterministic
// behavior. These tests pin the current policy so any regression is immediately
// visible.
//
// Acceptance criteria:
//   • Withdrawing with an unused offer_id returns `OfferNotFound` (#16).
//   • No offer or balance state changes after the failed withdrawal.
//   • The test follows existing error-code conventions (Error(Contract, #N)).

use crate::test::{mock_nft, valid_recipients, MockNftClient};
use crate::types::OfferStatus;
use crate::contract::{MarketplaceContract, MarketplaceContractClient};
use soroban_sdk::{
    symbol_short,
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env,
};

// ── Setup ─────────────────────────────────────────────────────────────────────

fn setup() -> (
    Env,
    MarketplaceContractClient<'static>,
    Address, // artist / admin
    Address, // buyer / offerer
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
    StellarAssetClient::new(&env, &payment_token).mint(&buyer, &100_000_000_000_i128);
    let collection = env.register(mock_nft::MockNft, ());
    MockNftClient::new(&env, &collection).set_owner(&1u64, &artist);
    client.set_admin(&artist);
    client.add_token_to_whitelist(&artist, &payment_token);
    (env, client, artist, buyer, payment_token, collection)
}

// ── Unknown offer withdrawal — deterministic OfferNotFound response ────────────

/// Withdrawing offer_id = 0 (never issued) must panic with `OfferNotFound` (#16).
///
/// offer_id 0 is not a sentinel — the counter starts at 1 — but it is a
/// well-defined "never issued" value in a freshly-initialised contract.
#[test]
#[should_panic(expected = "Error(Contract, #16)")]
fn test_withdraw_offer_id_zero_panics_with_offer_not_found() {
    let (env, client, _artist, buyer, _token, _col) = setup();
    client.withdraw_offer(&buyer, &0u64);
}

/// Withdrawing a large arbitrary offer_id that was never created must also
/// fail with `OfferNotFound` (#16).
#[test]
#[should_panic(expected = "Error(Contract, #16)")]
fn test_withdraw_offer_large_unused_id_panics_with_offer_not_found() {
    let (env, client, _artist, buyer, _token, _col) = setup();
    client.withdraw_offer(&buyer, &999_999u64);
}

/// `try_withdraw_offer` on an unknown id returns the typed `OfferNotFound`
/// error — confirms the error code matches the documented policy (#16).
#[test]
fn test_withdraw_offer_unknown_id_returns_offer_not_found_error() {
    let (env, client, _artist, buyer, _token, _col) = setup();
    let result = client.try_withdraw_offer(&buyer, &42u64);
    assert_eq!(
        result,
        Err(Ok(crate::types::MarketplaceError::OfferNotFound.into())),
        "unknown offer_id must return OfferNotFound"
    );
}

// ── No side-effects on adjacent offer state ────────────────────────────────────

/// After a failed withdrawal of an unknown id, any existing real pending offer
/// must remain Pending and the offerer's escrowed balance must be unchanged.
///
/// This verifies that the not-found path performs no state mutations that could
/// affect unrelated offer records.
#[test]
fn test_withdraw_unknown_id_does_not_affect_existing_pending_offer() {
    let (env, client, artist, buyer, payment_token, collection) = setup();

    // Create a real listing.
    let listing_id = client.create_listing(
        &artist,
        &10_000_000_i128,
        &symbol_short!("XLM"),
        &payment_token,
        &collection,
        &1u64,
        &1u64,
        &valid_recipients(&env, &artist),
        &None::<u64>,
    );

    // Buyer makes a real offer, locking 1_000_000 tokens into escrow.
    let real_offer_id = client.make_offer(
        &buyer,
        &listing_id,
        &1_000_000_i128,
        &payment_token,
        &None::<u64>,
    );

    // Record the buyer's token balance after escrow.
    let balance_after_escrow = TokenClient::new(&env, &payment_token).balance(&buyer);

    // Attempt withdrawal of a non-existent offer — must fail.
    let unused_id = real_offer_id + 1_000;
    let result = client.try_withdraw_offer(&buyer, &unused_id);
    assert!(
        result.is_err(),
        "unknown offer_id must be rejected"
    );

    // The real offer must still be Pending — its state is untouched.
    let real_offer = client.get_offer(&real_offer_id);
    assert_eq!(
        real_offer.status,
        OfferStatus::Pending,
        "real offer must remain Pending after failed withdrawal of unrelated id"
    );

    // The buyer's balance must not have changed — no refund was issued.
    let balance_after_failed_withdraw = TokenClient::new(&env, &payment_token).balance(&buyer);
    assert_eq!(
        balance_after_escrow, balance_after_failed_withdraw,
        "buyer balance must not change after a failed withdrawal of an unknown offer"
    );
}

/// A failed withdrawal of an unknown offer_id does not add any entry to the
/// offerer's offer list — `get_offerer_offers` returns the same slice before
/// and after the failed call.
#[test]
fn test_withdraw_unknown_id_does_not_create_offerer_entry() {
    let (env, client, _artist, buyer, _token, _col) = setup();

    // No offers have been made yet; list must be empty.
    let offers_before = client.get_offerer_offers(&buyer);
    assert_eq!(offers_before.len(), 0);

    let _ = client.try_withdraw_offer(&buyer, &77u64);

    let offers_after = client.get_offerer_offers(&buyer);
    assert_eq!(
        offers_before.len(),
        offers_after.len(),
        "offerer offer list must not grow after a failed withdrawal of unknown id"
    );
}
