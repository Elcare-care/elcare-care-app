// simulate_payout_tests.rs — read-only payout preview (matches README worked examples)
//
// Tests pin the four canonical cases:
//   1. round-down: tiny price where fees truncate to 0
//   2. exact division: price that divides cleanly across all legs
//   3. no royalty: collection reports 0 bps
//   4. multiple recipients: last one absorbs dust

use crate::test::{mock_nft, valid_recipients, MockNftClient};
use crate::types::{OptionalPayoutLeg, Recipient};
use crate::{MarketplaceContract, MarketplaceContractClient};
use soroban_sdk::{
    symbol_short, testutils::Address as _, testutils::Ledger, token::StellarAssetClient,
    token::TokenClient, vec, Address, Env,
};

// ── Setup helper ──────────────────────────────────────────────────────────────

/// Returns (env, client, admin/artist, buyer, payment_token, treasury, collection).
/// The mock collection has no royalty configured by default (royalty_bps = 0).
fn setup() -> (
    Env,
    MarketplaceContractClient<'static>,
    Address,
    Address,
    Address,
    Address,
    Address,
) {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| li.sequence_number = 1);

    let contract_id = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let treasury = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let payment_token = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let sac = StellarAssetClient::new(&env, &payment_token);
    sac.mint(&admin, &500_000_000_000_i128);
    sac.mint(&buyer, &500_000_000_000_i128);
    sac.mint(&contract_id, &500_000_000_000_i128);

    let collection = env.register(mock_nft::MockNft, ());
    // Token #1 owned by admin (the artist).
    MockNftClient::new(&env, &collection).set_owner(&1u64, &admin);

    client.set_admin(&admin);
    client.migrate_roles(&admin);
    client.add_token_to_whitelist(&admin, &payment_token);
    client.set_treasury(&admin, &treasury);

    (
        env,
        client,
        admin,
        buyer,
        payment_token,
        treasury,
        collection,
    )
}

// ── Test 1: round-down — tiny price where fee truncates to 0 ─────────────────

/// 1 stroop, fee_bps = 1 (0.01%).
/// fee = 1 * 1 / 10_000 = 0 (truncated).
/// No royalty configured. Artist receives the full 1 stroop. Total = 1.
#[test]
fn test_simulate_payout_round_down_fee_truncates_to_zero() {
    let (env, client, artist, _buyer, _token, _treasury, collection) = setup();

    let recipients = valid_recipients(&env, &artist);
    let plan = client.simulate_payout(&1_i128, &collection, &artist, &recipients, &1u32);

    assert_eq!(plan.fee, 0, "fee must truncate to 0 for 1 stroop at 1 bps");
    assert!(
        matches!(plan.royalty, OptionalPayoutLeg::None),
        "no royalty expected"
    );
    assert_eq!(plan.recipients.len(), 1);
    assert_eq!(plan.recipients.get(0).unwrap().amount, 1);
    assert_eq!(plan.total, 1);
}

// ── Test 2: exact division — no dust ─────────────────────────────────────────

/// price = 100_000, fee_bps = 500, single recipient at 10_000 bps, no royalty.
/// fee = 100_000 * 500 / 10_000 = 5_000.
/// remaining = 95_000; recipient = 95_000 (last absorbs remainder = 0 dust).
/// total = 100_000.
#[test]
fn test_simulate_payout_exact_division_no_dust() {
    let (env, client, artist, _buyer, _token, _treasury, collection) = setup();

    let recipients = valid_recipients(&env, &artist); // artist at 10_000 bps
    let plan = client.simulate_payout(&100_000_i128, &collection, &artist, &recipients, &500u32);

    assert_eq!(plan.fee, 5_000, "fee must be 5% of 100_000");
    assert!(
        matches!(plan.royalty, OptionalPayoutLeg::None),
        "no royalty expected"
    );
    assert_eq!(plan.recipients.len(), 1);
    assert_eq!(plan.recipients.get(0).unwrap().amount, 95_000);
    assert_eq!(plan.total, 100_000);
    // Invariant: royalty(0) + fee + recipients == total
    assert_eq!(
        0 + plan.fee + plan.recipients.get(0).unwrap().amount,
        100_000
    );
}

// ── Test 3: no royalty — zero bps ────────────────────────────────────────────

/// Mock collection reports royalty_bps = 0 (the default).
/// price = 10_000_000, fee_bps = 250.
/// royalty = None; fee = 250_000; artist = 9_750_000; total = 10_000_000.
#[test]
fn test_simulate_payout_no_royalty_zero_bps() {
    let (env, client, artist, _buyer, _token, _treasury, collection) = setup();

    // MockNft defaults to royalty_bps = 0 — no explicit set needed.
    let recipients = valid_recipients(&env, &artist);
    let plan = client.simulate_payout(&10_000_000_i128, &collection, &artist, &recipients, &250u32);

    assert!(
        matches!(plan.royalty, OptionalPayoutLeg::None),
        "royalty_bps=0 must yield OptionalPayoutLeg::None"
    );
    assert_eq!(plan.fee, 250_000, "fee = 2.5% of 10_000_000");
    assert_eq!(plan.recipients.len(), 1);
    assert_eq!(plan.recipients.get(0).unwrap().amount, 9_750_000);
    assert_eq!(plan.total, 10_000_000);
}

// ── Test 4: multiple recipients — last absorbs dust ──────────────────────────

/// price = 7, fee_bps = 0, no royalty.
/// 3 recipients: A at 3_300, B at 3_300, C at 3_400.
///   A = 7 * 3_300 / 10_000 = 2 (floor)
///   B = 7 * 3_300 / 10_000 = 2 (floor)
///   C = 7 - 2 - 2 = 3        (last absorbs 1 stroop dust)
/// total = 7.
#[test]
fn test_simulate_payout_multiple_recipients_last_absorbs_dust() {
    let (env, client, artist, _buyer, _token, _treasury, collection) = setup();

    let addr_a = Address::generate(&env);
    let addr_b = Address::generate(&env);
    let addr_c = Address::generate(&env);
    let recipients = vec![
        &env,
        Recipient {
            address: addr_a.clone(),
            percentage: 3_300,
        },
        Recipient {
            address: addr_b.clone(),
            percentage: 3_300,
        },
        Recipient {
            address: addr_c.clone(),
            percentage: 3_400,
        },
    ];

    let plan = client.simulate_payout(&7_i128, &collection, &artist, &recipients, &0u32);

    assert_eq!(plan.fee, 0, "fee_bps=0 must yield zero fee");
    assert!(matches!(plan.royalty, OptionalPayoutLeg::None));
    assert_eq!(plan.recipients.len(), 3);
    assert_eq!(plan.recipients.get(0).unwrap().amount, 2, "A gets 2");
    assert_eq!(plan.recipients.get(1).unwrap().amount, 2, "B gets 2");
    assert_eq!(plan.recipients.get(2).unwrap().amount, 3, "C absorbs dust");
    assert_eq!(plan.total, 7);

    // Invariant
    let payout_sum: i128 = (0..3).map(|i| plan.recipients.get(i).unwrap().amount).sum();
    assert_eq!(plan.fee + payout_sum, 7, "all 7 stroops accounted for");
}

// ── Test 5: simulate_payout matches buy_artwork payout ───────────────────────

/// Create a real listing, record treasury balance before purchase, buy, record
/// after. Also call simulate_payout with the same inputs before the purchase.
/// Assert simulate_payout.fee == treasury balance delta and
/// simulate_payout.total == listing.price.
#[test]
fn test_simulate_payout_matches_buy_artwork_payout() {
    let (env, client, artist, buyer, payment_token, treasury, collection) = setup();
    let price = 10_000_000_i128;
    let fee_bps = 500u32;

    client.set_protocol_fee(&artist, &fee_bps);

    let recipients = valid_recipients(&env, &artist);

    // Predict the payout BEFORE the purchase.
    let plan = client.simulate_payout(&price, &collection, &artist, &recipients, &fee_bps);

    // Create listing and record treasury balance before buy.
    let listing_id = client.create_listing(
        &artist,
        &price,
        &symbol_short!("XLM"),
        &payment_token,
        &collection,
        &1u64,
        &1u64,
        &recipients,
        &None::<u64>,
    );

    let token_client = TokenClient::new(&env, &payment_token);
    let treasury_before = token_client.balance(&treasury);

    client.buy_artwork(&buyer, &listing_id);

    let treasury_after = token_client.balance(&treasury);
    let treasury_delta = treasury_after - treasury_before;

    assert_eq!(
        plan.fee, treasury_delta,
        "simulated fee must match actual treasury inflow"
    );
    assert_eq!(
        plan.total, price,
        "simulated total must equal listing price"
    );
}

// ── Test 6: simulate_payout does not mutate state ────────────────────────────

/// Call simulate_payout twice with the same inputs; both calls must return
/// identical results and the listing count must not change.
#[test]
fn test_simulate_payout_does_not_mutate_state() {
    let (env, client, artist, _buyer, _token, _treasury, collection) = setup();

    let recipients = valid_recipients(&env, &artist);
    let count_before = client.get_total_listings();

    let plan1 =
        client.simulate_payout(&10_000_000_i128, &collection, &artist, &recipients, &300u32);
    let plan2 =
        client.simulate_payout(&10_000_000_i128, &collection, &artist, &recipients, &300u32);

    let count_after = client.get_total_listings();
    assert_eq!(
        count_before, count_after,
        "simulate_payout must not create listings"
    );

    // Both calls produce identical plans.
    assert_eq!(plan1.fee, plan2.fee, "fee must be deterministic");
    assert_eq!(plan1.total, plan2.total, "total must be deterministic");
    assert_eq!(
        plan1.recipients.len(),
        plan2.recipients.len(),
        "recipient count must be deterministic"
    );
    for i in 0..plan1.recipients.len() {
        assert_eq!(
            plan1.recipients.get(i).unwrap().amount,
            plan2.recipients.get(i).unwrap().amount,
            "recipient[{i}] amount must be deterministic"
        );
    }
}
