// counter_offer_tests.rs — Counter-offer support (Issue #471)
//
// Coverage:
//   - Artist creates counter-offer: parent offer atomically rejected, buyer escrow returned
//   - Counter-offer ID linked to parent via get_counter_offer_parent
//   - Non-artist cannot create a counter-offer (Unauthorized)
//   - Counter on non-pending offer panics (OfferNotPending)
//   - Buyer accepts counter-offer: listing sold, NFT transferred, artist paid
//   - accept_counter_offer on regular offer panics (NotCounterOffer)
//   - Accepting a counter-offer twice panics (InvalidOfferState)
//   - Counter with zero amount panics (InsufficientOfferAmount)

use super::*;
use soroban_sdk::{
    symbol_short,
    testutils::Address as _,
    Address, Env,
};
use crate::test::{mock_nft, MockNftClient, valid_recipients};
use soroban_sdk::token::StellarAssetClient;

// ── Shared setup ─────────────────────────────────────────────────────────────

fn counter_setup() -> (
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
    token: &Address,
    collection: &Address,
) -> (u64, u64) {
    let listing_id = client.create_listing(
        artist, &10_000_000_i128, &symbol_short!("XLM"),
        token, collection, &1u64, &1u64,
        &valid_recipients(env, artist), &None::<u64>,
    );
    let offer_id = client.make_offer(
        buyer, &listing_id, &5_000_000_i128, token, &None::<u64>,
    );
    (listing_id, offer_id)
}

// ── §1  Counter-offer creation ────────────────────────────────────────────────

#[test]
fn test_counter_offer_rejects_parent_and_returns_escrow() {
    let (env, client, _, artist, buyer, token, collection) = counter_setup();
    let sac = soroban_sdk::token::TokenClient::new(&env, &token);
    let buyer_before = sac.balance(&buyer);

    let (_, parent_id) = make_listing_and_offer(&env, &client, &artist, &buyer, &token, &collection);
    assert!(sac.balance(&buyer) < buyer_before, "buyer escrow must be locked after make_offer");

    client.counter_offer(&artist, &parent_id, &8_000_000_i128, &token, &None::<u64>);

    let parent = client.get_offer(&parent_id);
    assert_eq!(parent.status, OfferStatus::Rejected);
    assert_eq!(sac.balance(&buyer), buyer_before, "buyer escrow must be refunded after counter");
}

#[test]
fn test_counter_offer_creates_pending_offer_with_artist_as_offerer() {
    let (env, client, _, artist, buyer, token, collection) = counter_setup();
    let (_, parent_id) = make_listing_and_offer(&env, &client, &artist, &buyer, &token, &collection);

    let counter_id = client.counter_offer(&artist, &parent_id, &8_000_000_i128, &token, &None::<u64>);
    let counter = client.get_offer(&counter_id);
    assert_eq!(counter.status, OfferStatus::Pending);
    assert_eq!(counter.amount, 8_000_000_i128);
    assert_eq!(counter.offerer, artist);
}

#[test]
fn test_counter_offer_parent_link_is_stored() {
    let (env, client, _, artist, buyer, token, collection) = counter_setup();
    let (_, parent_id) = make_listing_and_offer(&env, &client, &artist, &buyer, &token, &collection);

    let counter_id = client.counter_offer(&artist, &parent_id, &8_000_000_i128, &token, &None::<u64>);
    assert_eq!(
        client.get_counter_offer_parent(&counter_id),
        Some(parent_id),
        "counter-offer must link back to the original offer ID"
    );
}

#[test]
fn test_regular_offer_has_no_counter_offer_parent() {
    let (env, client, _, artist, buyer, token, collection) = counter_setup();
    let (_, offer_id) = make_listing_and_offer(&env, &client, &artist, &buyer, &token, &collection);
    assert_eq!(
        client.get_counter_offer_parent(&offer_id),
        None,
        "regular offers must have no counter-offer parent link"
    );
}

// ── §2  Settlement via accept_counter_offer ───────────────────────────────────

#[test]
fn test_accept_counter_offer_marks_listing_sold() {
    let (env, client, _, artist, buyer, token, collection) = counter_setup();
    let (listing_id, parent_id) = make_listing_and_offer(&env, &client, &artist, &buyer, &token, &collection);

    let counter_id = client.counter_offer(&artist, &parent_id, &8_000_000_i128, &token, &None::<u64>);
    client.accept_counter_offer(&buyer, &counter_id);

    let listing = client.get_listing(&listing_id);
    assert_eq!(listing.status, ListingStatus::Sold);
    assert_eq!(listing.owner, Some(buyer.clone()));
}

#[test]
fn test_accept_counter_offer_pays_artist() {
    let (env, client, _, artist, buyer, token, collection) = counter_setup();
    let sac = soroban_sdk::token::TokenClient::new(&env, &token);

    let (_, parent_id) = make_listing_and_offer(&env, &client, &artist, &buyer, &token, &collection);
    let artist_before = sac.balance(&artist);

    let counter_id = client.counter_offer(&artist, &parent_id, &8_000_000_i128, &token, &None::<u64>);
    client.accept_counter_offer(&buyer, &counter_id);

    assert!(
        sac.balance(&artist) > artist_before,
        "artist balance must increase after counter-offer settlement"
    );
}

#[test]
fn test_accept_counter_offer_marks_counter_accepted() {
    let (env, client, _, artist, buyer, token, collection) = counter_setup();
    let (_, parent_id) = make_listing_and_offer(&env, &client, &artist, &buyer, &token, &collection);

    let counter_id = client.counter_offer(&artist, &parent_id, &8_000_000_i128, &token, &None::<u64>);
    client.accept_counter_offer(&buyer, &counter_id);

    assert_eq!(client.get_offer(&counter_id).status, OfferStatus::Accepted);
}

// ── §3  Error cases ───────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_non_artist_cannot_create_counter_offer() {
    let (env, client, _, artist, buyer, token, collection) = counter_setup();
    let attacker = Address::generate(&env);
    let (_, parent_id) = make_listing_and_offer(&env, &client, &artist, &buyer, &token, &collection);
    // Unauthorized = 5
    client.counter_offer(&attacker, &parent_id, &8_000_000_i128, &token, &None::<u64>);
}

#[test]
#[should_panic(expected = "Error(Contract, #18)")]
fn test_counter_on_already_rejected_offer_panics() {
    let (env, client, _, artist, buyer, token, collection) = counter_setup();
    let (_, parent_id) = make_listing_and_offer(&env, &client, &artist, &buyer, &token, &collection);
    // First counter atomically rejects the parent.
    client.counter_offer(&artist, &parent_id, &8_000_000_i128, &token, &None::<u64>);
    // Second counter on the same (now Rejected) parent: OfferNotPending = 18
    client.counter_offer(&artist, &parent_id, &9_000_000_i128, &token, &None::<u64>);
}

#[test]
#[should_panic(expected = "Error(Contract, #74)")]
fn test_accept_regular_offer_via_accept_counter_offer_panics() {
    let (env, client, _, artist, buyer, token, collection) = counter_setup();
    let (_, offer_id) = make_listing_and_offer(&env, &client, &artist, &buyer, &token, &collection);
    // NotCounterOffer = 74
    client.accept_counter_offer(&buyer, &offer_id);
}

#[test]
#[should_panic(expected = "Error(Contract, #33)")]
fn test_accept_counter_offer_twice_panics() {
    let (env, client, _, artist, buyer, token, collection) = counter_setup();
    let (_, parent_id) = make_listing_and_offer(&env, &client, &artist, &buyer, &token, &collection);
    let counter_id = client.counter_offer(&artist, &parent_id, &8_000_000_i128, &token, &None::<u64>);
    client.accept_counter_offer(&buyer, &counter_id);
    // InvalidOfferState = 33 (counter is now Accepted)
    client.accept_counter_offer(&buyer, &counter_id);
}

#[test]
#[should_panic(expected = "Error(Contract, #19)")]
fn test_counter_offer_zero_amount_panics() {
    let (env, client, _, artist, buyer, token, collection) = counter_setup();
    let (_, parent_id) = make_listing_and_offer(&env, &client, &artist, &buyer, &token, &collection);
    // InsufficientOfferAmount = 19
    client.counter_offer(&artist, &parent_id, &0_i128, &token, &None::<u64>);
}
