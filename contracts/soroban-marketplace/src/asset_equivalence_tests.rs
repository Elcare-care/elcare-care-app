// asset_equivalence_tests.rs — Issue #463
//
// Verifies that native XLM (wrapped as a Stellar Asset Contract) and any other
// SAC-issued asset behave identically across every marketplace settlement path:
//
//   • listing buy (buy_artwork)
//   • auction settlement (place_bid + finalize_auction)
//   • offer acceptance (make_offer + accept_offer)
//   • protocol fee collection
//   • royalty payout
//
// No decimal rescaling must occur: 1 stroop in = 1 stroop credited.

use crate::test::{mock_nft, valid_recipients, MockNftClient};
use crate::types::Recipient;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env,
};
use crate::contract::{MarketplaceContract, MarketplaceContractClient};

// ── Shared setup helpers ──────────────────────────────────────────────────────

struct TestEnv {
    env: Env,
    client: MarketplaceContractClient<'static>,
    admin: Address,
    buyer: Address,
    contract_id: Address,
    collection_id: Address,
}

fn make_sac(env: &Env) -> (Address, StellarAssetClient) {
    let admin = Address::generate(env);
    let addr = env.register_stellar_asset_contract_v2(admin).address();
    let sac = StellarAssetClient::new(env, &addr);
    (addr, sac)
}

fn base_setup() -> (TestEnv, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);

    let (token, sac) = make_sac(&env);
    sac.mint(&admin, &100_000_000_000_i128);
    sac.mint(&buyer, &100_000_000_000_i128);
    sac.mint(&contract_id, &100_000_000_000_i128);

    let collection_id = env.register(mock_nft::MockNft, ());
    MockNftClient::new(&env, &collection_id).set_owner(&1u64, &admin);

    client.set_admin(&admin);
    client.add_token_to_whitelist(&admin, &token);

    let te = TestEnv { env, client, admin, buyer, contract_id, collection_id };
    (te, token)
}

// Add a second SAC token and whitelist it (used in multi-token equivalence tests).
fn add_second_token(te: &TestEnv) -> Address {
    let (token2, sac2) = make_sac(&te.env);
    sac2.mint(&te.admin, &100_000_000_000_i128);
    sac2.mint(&te.buyer, &100_000_000_000_i128);
    sac2.mint(&te.contract_id, &100_000_000_000_i128);
    te.client.add_token_to_whitelist(&te.admin, &token2);
    token2
}

// ── Listing / buy_artwork ─────────────────────────────────────────────────────

// Both SAC tokens can be used as payment for a listing.
#[test]
fn test_listing_buy_with_first_sac_token() {
    let (te, token) = base_setup();
    let price: i128 = 10_000_000;

    let listing_id = te.client.create_listing(
        &te.admin, &price, &symbol_short!("XLM"),
        &token, &te.collection_id, &1u64, &1u64,
        &valid_recipients(&te.env, &te.admin), &None::<u64>,
    );

    let seller_before = TokenClient::new(&te.env, &token).balance(&te.admin);
    assert!(te.client.buy_artwork(&te.buyer, &listing_id));
    let seller_after = TokenClient::new(&te.env, &token).balance(&te.admin);

    // Seller received exactly `price` (no fee set, no treasury).
    assert_eq!(seller_after - seller_before, price);
}

#[test]
fn test_listing_buy_with_second_sac_token() {
    let (te, _) = base_setup();
    let token2 = add_second_token(&te);
    let price: i128 = 7_777_777;

    MockNftClient::new(&te.env, &te.collection_id).set_owner(&1u64, &te.admin);

    let listing_id = te.client.create_listing(
        &te.admin, &price, &symbol_short!("XLM"),
        &token2, &te.collection_id, &1u64, &1u64,
        &valid_recipients(&te.env, &te.admin), &None::<u64>,
    );

    let seller_before = TokenClient::new(&te.env, &token2).balance(&te.admin);
    assert!(te.client.buy_artwork(&te.buyer, &listing_id));
    let seller_after = TokenClient::new(&te.env, &token2).balance(&te.admin);

    assert_eq!(seller_after - seller_before, price);
}

// No decimal rescaling: amount in equals amount credited.
#[test]
fn test_buy_artwork_no_decimal_rescaling() {
    let (te, token) = base_setup();
    // Use an odd stroop-level amount to detect any scaling.
    let price: i128 = 1_000_001;

    let listing_id = te.client.create_listing(
        &te.admin, &price, &symbol_short!("XLM"),
        &token, &te.collection_id, &1u64, &1u64,
        &valid_recipients(&te.env, &te.admin), &None::<u64>,
    );

    let buyer_before = TokenClient::new(&te.env, &token).balance(&te.buyer);
    let seller_before = TokenClient::new(&te.env, &token).balance(&te.admin);

    assert!(te.client.buy_artwork(&te.buyer, &listing_id));

    let buyer_after = TokenClient::new(&te.env, &token).balance(&te.buyer);
    let seller_after = TokenClient::new(&te.env, &token).balance(&te.admin);

    assert_eq!(buyer_before - buyer_after, price, "buyer debited exactly price");
    assert_eq!(seller_after - seller_before, price, "seller credited exactly price");
}

// ── Auction settlement ────────────────────────────────────────────────────────

fn run_auction(te: &TestEnv, token: &Address, reserve: i128, bid: i128) -> Address {
    let duration: u64 = 3_600;
    let recipients = vec![&te.env, Recipient { address: te.admin.clone(), percentage: 10_000 }];

    let auction_id = te.client.create_auction(
        &te.admin, token, &te.collection_id,
        &1u64, &reserve, &duration, &recipients,
    );

    te.env.ledger().set_timestamp(1);
    te.client.place_bid(&te.buyer, &auction_id, &bid);

    // Advance past auction end.
    te.env.ledger().with_mut(|l| l.timestamp = duration + 2);
    te.client.finalize_auction(&te.admin, &auction_id);

    te.admin.clone()
}

#[test]
fn test_auction_settlement_with_first_sac_token() {
    let (te, token) = base_setup();
    let reserve: i128 = 5_000_000;
    let bid: i128 = 6_000_000;

    let seller_before = TokenClient::new(&te.env, &token).balance(&te.admin);
    run_auction(&te, &token, reserve, bid);
    let seller_after = TokenClient::new(&te.env, &token).balance(&te.admin);

    // Seller receives winning bid amount.
    assert_eq!(seller_after - seller_before, bid);
}

#[test]
fn test_auction_settlement_with_second_sac_token() {
    let (te, _) = base_setup();
    let token2 = add_second_token(&te);

    MockNftClient::new(&te.env, &te.collection_id).set_owner(&1u64, &te.admin);

    let reserve: i128 = 3_000_000;
    let bid: i128 = 4_000_000;

    let seller_before = TokenClient::new(&te.env, &token2).balance(&te.admin);
    run_auction(&te, &token2, reserve, bid);
    let seller_after = TokenClient::new(&te.env, &token2).balance(&te.admin);

    assert_eq!(seller_after - seller_before, bid);
}

#[test]
fn test_auction_bid_no_decimal_rescaling() {
    let (te, token) = base_setup();
    let reserve: i128 = 1_000_001;
    let bid: i128 = 1_500_003;

    let buyer_before = TokenClient::new(&te.env, &token).balance(&te.buyer);
    run_auction(&te, &token, reserve, bid);
    let buyer_after = TokenClient::new(&te.env, &token).balance(&te.buyer);

    assert_eq!(buyer_before - buyer_after, bid, "buyer debited exactly bid amount");
}

// ── Offer acceptance ──────────────────────────────────────────────────────────

fn run_offer_accept(te: &TestEnv, token: &Address, listing_price: i128, offer_amount: i128) {
    let listing_id = te.client.create_listing(
        &te.admin, &listing_price, &symbol_short!("XLM"),
        token, &te.collection_id, &1u64, &1u64,
        &valid_recipients(&te.env, &te.admin), &None::<u64>,
    );

    let offer_id = te.client.make_offer(&te.buyer, &listing_id, &offer_amount, token, &None::<u64>);
    te.client.accept_offer(&te.admin, &offer_id);
}

#[test]
fn test_offer_accept_with_first_sac_token() {
    let (te, token) = base_setup();
    let offer_amount: i128 = 8_000_000;

    let seller_before = TokenClient::new(&te.env, &token).balance(&te.admin);
    run_offer_accept(&te, &token, 10_000_000, offer_amount);
    let seller_after = TokenClient::new(&te.env, &token).balance(&te.admin);

    assert_eq!(seller_after - seller_before, offer_amount);
}

#[test]
fn test_offer_accept_with_second_sac_token() {
    let (te, _) = base_setup();
    let token2 = add_second_token(&te);
    MockNftClient::new(&te.env, &te.collection_id).set_owner(&1u64, &te.admin);

    let offer_amount: i128 = 5_500_000;

    let seller_before = TokenClient::new(&te.env, &token2).balance(&te.admin);
    run_offer_accept(&te, &token2, 10_000_000, offer_amount);
    let seller_after = TokenClient::new(&te.env, &token2).balance(&te.admin);

    assert_eq!(seller_after - seller_before, offer_amount);
}

#[test]
fn test_offer_no_decimal_rescaling() {
    let (te, token) = base_setup();
    let offer_amount: i128 = 9_999_999;

    let buyer_before = TokenClient::new(&te.env, &token).balance(&te.buyer);
    run_offer_accept(&te, &token, 10_000_000, offer_amount);
    let buyer_after = TokenClient::new(&te.env, &token).balance(&te.buyer);

    assert_eq!(buyer_before - buyer_after, offer_amount, "buyer debited exact offer amount");
}

// ── Protocol fee equivalence ──────────────────────────────────────────────────

fn setup_with_fee(fee_bps: u32) -> (TestEnv, Address, Address) {
    let (te, token) = base_setup();
    let treasury = Address::generate(&te.env);
    te.client.set_treasury(&te.admin, &treasury);
    te.client.set_protocol_fee(&te.admin, &fee_bps);
    (te, token, treasury)
}

#[test]
fn test_protocol_fee_collected_with_first_sac_token() {
    let fee_bps = 250u32; // 2.5%
    let price: i128 = 10_000_000;
    let (te, token, treasury) = setup_with_fee(fee_bps);
    let expected_fee = price * fee_bps as i128 / 10_000;

    let recipients = vec![&te.env, Recipient {
        address: te.admin.clone(),
        percentage: 10_000 - fee_bps,
    }];
    let listing_id = te.client.create_listing(
        &te.admin, &price, &symbol_short!("XLM"),
        &token, &te.collection_id, &1u64, &1u64,
        &recipients, &None::<u64>,
    );

    let treasury_before = TokenClient::new(&te.env, &token).balance(&treasury);
    te.client.buy_artwork(&te.buyer, &listing_id);
    let treasury_after = TokenClient::new(&te.env, &token).balance(&treasury);

    assert_eq!(treasury_after - treasury_before, expected_fee,
        "treasury receives exact fee regardless of SAC type");
}

#[test]
fn test_protocol_fee_collected_with_second_sac_token() {
    let fee_bps = 500u32; // 5%
    let price: i128 = 20_000_000;
    let (te, _, treasury) = setup_with_fee(fee_bps);
    let token2 = add_second_token(&te);
    let expected_fee = price * fee_bps as i128 / 10_000;

    MockNftClient::new(&te.env, &te.collection_id).set_owner(&1u64, &te.admin);

    let recipients = vec![&te.env, Recipient {
        address: te.admin.clone(),
        percentage: 10_000 - fee_bps,
    }];
    let listing_id = te.client.create_listing(
        &te.admin, &price, &symbol_short!("XLM"),
        &token2, &te.collection_id, &1u64, &1u64,
        &recipients, &None::<u64>,
    );

    let treasury_before = TokenClient::new(&te.env, &token2).balance(&treasury);
    te.client.buy_artwork(&te.buyer, &listing_id);
    let treasury_after = TokenClient::new(&te.env, &token2).balance(&treasury);

    assert_eq!(treasury_after - treasury_before, expected_fee,
        "fee on second SAC also matches bps calculation");
}

// ── Royalty split equivalence ─────────────────────────────────────────────────

#[test]
fn test_royalty_split_with_first_sac_token() {
    let (te, token) = base_setup();
    let price: i128 = 10_000_000;
    let royalty_recipient = Address::generate(&te.env);
    StellarAssetClient::new(&te.env, &token).mint(&royalty_recipient, &0);

    // 70% to artist, 30% to royalty_recipient.
    let recipients = vec![
        &te.env,
        Recipient { address: te.admin.clone(), percentage: 7_000 },
        Recipient { address: royalty_recipient.clone(), percentage: 3_000 },
    ];
    let listing_id = te.client.create_listing(
        &te.admin, &price, &symbol_short!("XLM"),
        &token, &te.collection_id, &1u64, &1u64,
        &recipients, &None::<u64>,
    );

    let royalty_before = TokenClient::new(&te.env, &token).balance(&royalty_recipient);
    te.client.buy_artwork(&te.buyer, &listing_id);
    let royalty_after = TokenClient::new(&te.env, &token).balance(&royalty_recipient);

    let expected_royalty = price * 3_000 / 10_000;
    assert_eq!(royalty_after - royalty_before, expected_royalty,
        "royalty split is exact for first SAC token");
}

#[test]
fn test_royalty_split_with_second_sac_token() {
    let (te, _) = base_setup();
    let token2 = add_second_token(&te);
    MockNftClient::new(&te.env, &te.collection_id).set_owner(&1u64, &te.admin);

    let price: i128 = 15_000_000;
    let royalty_recipient = Address::generate(&te.env);
    StellarAssetClient::new(&te.env, &token2).mint(&royalty_recipient, &0);

    let recipients = vec![
        &te.env,
        Recipient { address: te.admin.clone(), percentage: 6_000 },
        Recipient { address: royalty_recipient.clone(), percentage: 4_000 },
    ];
    let listing_id = te.client.create_listing(
        &te.admin, &price, &symbol_short!("XLM"),
        &token2, &te.collection_id, &1u64, &1u64,
        &recipients, &None::<u64>,
    );

    let royalty_before = TokenClient::new(&te.env, &token2).balance(&royalty_recipient);
    te.client.buy_artwork(&te.buyer, &listing_id);
    let royalty_after = TokenClient::new(&te.env, &token2).balance(&royalty_recipient);

    let expected_royalty = price * 4_000 / 10_000;
    assert_eq!(royalty_after - royalty_before, expected_royalty,
        "royalty split is exact for second SAC token");
}

// ── Two-token simultaneous activity ──────────────────────────────────────────
// Listings with different tokens can coexist without cross-contamination.

#[test]
fn test_two_sac_listings_settle_independently() {
    let (te, token1) = base_setup();
    let token2 = add_second_token(&te);

    let col2 = te.env.register(mock_nft::MockNft, ());
    MockNftClient::new(&te.env, &col2).set_owner(&1u64, &te.admin);

    let price1: i128 = 3_000_000;
    let price2: i128 = 7_000_000;

    // Listing 1 uses token1, listing 2 uses token2.
    let lid1 = te.client.create_listing(
        &te.admin, &price1, &symbol_short!("XLM"),
        &token1, &te.collection_id, &1u64, &1u64,
        &valid_recipients(&te.env, &te.admin), &None::<u64>,
    );
    let lid2 = te.client.create_listing(
        &te.admin, &price2, &symbol_short!("XLM"),
        &token2, &col2, &1u64, &1u64,
        &valid_recipients(&te.env, &te.admin), &None::<u64>,
    );

    let t1_before = TokenClient::new(&te.env, &token1).balance(&te.admin);
    let t2_before = TokenClient::new(&te.env, &token2).balance(&te.admin);

    te.client.buy_artwork(&te.buyer, &lid1);
    te.client.buy_artwork(&te.buyer, &lid2);

    let t1_after = TokenClient::new(&te.env, &token1).balance(&te.admin);
    let t2_after = TokenClient::new(&te.env, &token2).balance(&te.admin);

    assert_eq!(t1_after - t1_before, price1, "token1 balance unaffected by token2 listing");
    assert_eq!(t2_after - t2_before, price2, "token2 balance unaffected by token1 listing");
}
