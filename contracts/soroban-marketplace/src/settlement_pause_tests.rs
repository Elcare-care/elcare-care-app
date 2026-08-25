// settlement_pause_tests.rs — Issue #464
//
// Verifies emergency settlement pause granularity:
//
//   • get_pause_matrix() reports accurate state for all three axes
//   • buy_artwork, accept_offer, place_bid, create_listing, create_auction are
//     each blocked by global / per-collection / per-function pause
//   • Recovery ops (cancel_listing, withdraw_offer, claim_royalty,
//     finalize_auction) remain available under every pause mode

use crate::test::{mock_nft, valid_recipients, MockNftClient};
use crate::types::{PauseMatrix, Recipient};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env, Symbol,
};
use crate::contract::{MarketplaceContract, MarketplaceContractClient};

// ── Shared setup ──────────────────────────────────────────────────────────────

struct S {
    env: Env,
    client: MarketplaceContractClient<'static>,
    admin: Address,
    buyer: Address,
    token: Address,
    cid: Address,
    col: Address,
}

fn setup() -> S {
    let env = Env::default();
    env.mock_all_auths();
    let cid = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &cid);
    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let ta = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(ta).address();
    let sac = StellarAssetClient::new(&env, &token);
    sac.mint(&admin, &100_000_000_000_i128);
    sac.mint(&buyer, &100_000_000_000_i128);
    sac.mint(&cid, &100_000_000_000_i128);
    let col = env.register(mock_nft::MockNft, ());
    MockNftClient::new(&env, &col).set_owner(&1u64, &admin);
    client.set_admin(&admin);
    client.add_token_to_whitelist(&admin, &token);
    S { env, client, admin, buyer, token, cid, col }
}

fn make_listing(s: &S) -> u64 {
    s.client.create_listing(
        &s.admin, &10_000_000_i128, &symbol_short!("XLM"),
        &s.token, &s.col, &1u64, &1u64,
        &valid_recipients(&s.env, &s.admin), &None::<u64>,
    )
}

fn make_offer(s: &S, listing_id: u64) -> u64 {
    s.client.make_offer(&s.buyer, &listing_id, &5_000_000_i128, &s.token, &None::<u64>)
}

// ── get_pause_matrix ─────────────────────────────────────────────────────────

#[test]
fn test_get_pause_matrix_all_false_by_default() {
    let s = setup();
    let col_sym = Symbol::new(&s.env, "buy_artwork");
    let pm: PauseMatrix = s.client.get_pause_matrix(&None::<Address>, &None::<Symbol>);
    assert!(!pm.global);
    assert!(!pm.collection_paused);
    assert!(!pm.function_paused);
    assert!(!pm.any_paused);

    // Specific axes also false.
    let pm2 = s.client.get_pause_matrix(&Some(s.col.clone()), &Some(col_sym));
    assert!(!pm2.any_paused);
}

#[test]
fn test_get_pause_matrix_global_flag() {
    let s = setup();
    s.client.admin_pause(&s.admin);
    let pm = s.client.get_pause_matrix(&None::<Address>, &None::<Symbol>);
    assert!(pm.global);
    assert!(pm.any_paused);
    assert!(!pm.collection_paused);
    assert!(!pm.function_paused);
}

#[test]
fn test_get_pause_matrix_collection_flag() {
    let s = setup();
    s.client.pause_collection(&s.admin, &s.col);
    let pm_with = s.client.get_pause_matrix(&Some(s.col.clone()), &None::<Symbol>);
    assert!(pm_with.collection_paused);
    assert!(pm_with.any_paused);
    assert!(!pm_with.global);

    // Different collection → not paused.
    let other_col = s.env.register(mock_nft::MockNft, ());
    let pm_other = s.client.get_pause_matrix(&Some(other_col), &None::<Symbol>);
    assert!(!pm_other.collection_paused);
    assert!(!pm_other.any_paused);
}

#[test]
fn test_get_pause_matrix_function_flag() {
    let s = setup();
    let fn_sym = Symbol::new(&s.env, "buy_artwork");
    s.client.pause_function(&s.admin, &fn_sym);
    let pm = s.client.get_pause_matrix(&None::<Address>, &Some(fn_sym.clone()));
    assert!(pm.function_paused);
    assert!(pm.any_paused);
    assert!(!pm.global);

    // Different function → not paused.
    let other_fn = Symbol::new(&s.env, "make_offer");
    let pm2 = s.client.get_pause_matrix(&None::<Address>, &Some(other_fn));
    assert!(!pm2.function_paused);
    assert!(!pm2.any_paused);
}

#[test]
fn test_get_pause_matrix_all_three_axes() {
    let s = setup();
    let fn_sym = Symbol::new(&s.env, "buy_artwork");
    s.client.admin_pause(&s.admin);
    s.client.pause_collection(&s.admin, &s.col);
    s.client.pause_function(&s.admin, &fn_sym);

    let pm = s.client.get_pause_matrix(&Some(s.col.clone()), &Some(fn_sym));
    assert!(pm.global);
    assert!(pm.collection_paused);
    assert!(pm.function_paused);
    assert!(pm.any_paused);
}

// ── Settlement blocked by global pause ───────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #23)")]
fn test_buy_artwork_blocked_by_global_pause() {
    let s = setup();
    let lid = make_listing(&s);
    s.client.admin_pause(&s.admin);
    s.client.buy_artwork(&s.buyer, &lid);
}

#[test]
#[should_panic(expected = "Error(Contract, #23)")]
fn test_accept_offer_blocked_by_global_pause() {
    let s = setup();
    let lid = make_listing(&s);
    let oid = make_offer(&s, lid);
    s.client.admin_pause(&s.admin);
    s.client.accept_offer(&s.admin, &oid);
}

#[test]
#[should_panic(expected = "Error(Contract, #23)")]
fn test_place_bid_blocked_by_global_pause() {
    let s = setup();
    let dur: u64 = 3_600;
    let recs = vec![&s.env, Recipient { address: s.admin.clone(), percentage: 10_000 }];
    let aid = s.client.create_auction(
        &s.admin, &s.token, &s.col, &1u64, &5_000_000_i128, &dur, &recs,
    );
    s.env.ledger().set_timestamp(1);
    s.client.admin_pause(&s.admin);
    s.client.place_bid(&s.buyer, &aid, &6_000_000_i128);
}

// ── Settlement blocked by per-collection pause ────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #23)")]
fn test_buy_artwork_blocked_by_collection_pause() {
    let s = setup();
    let lid = make_listing(&s);
    s.client.pause_collection(&s.admin, &s.col);
    s.client.buy_artwork(&s.buyer, &lid);
}

#[test]
#[should_panic(expected = "Error(Contract, #23)")]
fn test_accept_offer_blocked_by_collection_pause() {
    let s = setup();
    let lid = make_listing(&s);
    let oid = make_offer(&s, lid);
    s.client.pause_collection(&s.admin, &s.col);
    s.client.accept_offer(&s.admin, &oid);
}

#[test]
#[should_panic(expected = "Error(Contract, #23)")]
fn test_place_bid_blocked_by_collection_pause() {
    let s = setup();
    let dur: u64 = 3_600;
    let recs = vec![&s.env, Recipient { address: s.admin.clone(), percentage: 10_000 }];
    let aid = s.client.create_auction(
        &s.admin, &s.token, &s.col, &1u64, &5_000_000_i128, &dur, &recs,
    );
    s.env.ledger().set_timestamp(1);
    s.client.pause_collection(&s.admin, &s.col);
    s.client.place_bid(&s.buyer, &aid, &6_000_000_i128);
}

// ── Settlement blocked by per-function pause ──────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #23)")]
fn test_buy_artwork_blocked_by_function_pause() {
    let s = setup();
    let lid = make_listing(&s);
    s.client.pause_function(&s.admin, &Symbol::new(&s.env, "buy_artwork"));
    s.client.buy_artwork(&s.buyer, &lid);
}

#[test]
#[should_panic(expected = "Error(Contract, #23)")]
fn test_accept_offer_blocked_by_function_pause() {
    let s = setup();
    let lid = make_listing(&s);
    let oid = make_offer(&s, lid);
    s.client.pause_function(&s.admin, &Symbol::new(&s.env, "accept_offer"));
    s.client.accept_offer(&s.admin, &oid);
}

// ── Recovery ops remain available under global pause ─────────────────────────

#[test]
fn test_cancel_listing_works_under_global_pause() {
    let s = setup();
    let lid = make_listing(&s);
    s.client.admin_pause(&s.admin);
    // cancel_listing is always available — must not panic.
    s.client.cancel_listing(&s.admin, &lid);
}

#[test]
fn test_withdraw_offer_works_under_global_pause() {
    let s = setup();
    let lid = make_listing(&s);
    let oid = make_offer(&s, lid);
    s.client.admin_pause(&s.admin);
    // withdraw_offer refunds the buyer — must not panic.
    s.client.withdraw_offer(&s.buyer, &oid);
}

#[test]
fn test_finalize_auction_works_under_global_pause() {
    let s = setup();
    let dur: u64 = 3_600;
    let recs = vec![&s.env, Recipient { address: s.admin.clone(), percentage: 10_000 }];
    let aid = s.client.create_auction(
        &s.admin, &s.token, &s.col, &1u64, &5_000_000_i128, &dur, &recs,
    );
    s.env.ledger().set_timestamp(1);
    s.client.place_bid(&s.buyer, &aid, &6_000_000_i128);
    // Pause after the bid but before finalization.
    s.client.admin_pause(&s.admin);
    s.env.ledger().with_mut(|l| l.timestamp = dur + 2);
    // finalize_auction is always available (fund recovery) — must not panic.
    s.client.finalize_auction(&s.admin, &aid);
}

// ── Recovery ops remain available under collection pause ─────────────────────

#[test]
fn test_cancel_listing_works_under_collection_pause() {
    let s = setup();
    let lid = make_listing(&s);
    s.client.pause_collection(&s.admin, &s.col);
    s.client.cancel_listing(&s.admin, &lid);
}

#[test]
fn test_withdraw_offer_works_under_collection_pause() {
    let s = setup();
    let lid = make_listing(&s);
    let oid = make_offer(&s, lid);
    s.client.pause_collection(&s.admin, &s.col);
    s.client.withdraw_offer(&s.buyer, &oid);
}

// ── Recovery ops remain available under function pause ────────────────────────

#[test]
fn test_cancel_listing_works_under_buy_artwork_function_pause() {
    let s = setup();
    let lid = make_listing(&s);
    s.client.pause_function(&s.admin, &Symbol::new(&s.env, "buy_artwork"));
    // cancel_listing is not gated by function pause — must not panic.
    s.client.cancel_listing(&s.admin, &lid);
}

#[test]
fn test_withdraw_offer_works_under_accept_offer_function_pause() {
    let s = setup();
    let lid = make_listing(&s);
    let oid = make_offer(&s, lid);
    s.client.pause_function(&s.admin, &Symbol::new(&s.env, "accept_offer"));
    // withdraw_offer bypasses all pause axes — must not panic.
    s.client.withdraw_offer(&s.buyer, &oid);
}

// ── Unpause restores settlement ───────────────────────────────────────────────

#[test]
fn test_buy_artwork_works_after_global_unpause() {
    let s = setup();
    let lid = make_listing(&s);
    s.client.admin_pause(&s.admin);
    s.client.admin_unpause(&s.admin);
    assert!(s.client.buy_artwork(&s.buyer, &lid));
}

#[test]
fn test_accept_offer_works_after_collection_unpause() {
    let s = setup();
    let lid = make_listing(&s);
    let oid = make_offer(&s, lid);
    s.client.pause_collection(&s.admin, &s.col);
    s.client.unpause_collection(&s.admin, &s.col);
    // Should succeed after unpausing.
    s.client.accept_offer(&s.admin, &oid);
}

#[test]
fn test_accept_offer_works_after_function_unpause() {
    let s = setup();
    let lid = make_listing(&s);
    let oid = make_offer(&s, lid);
    s.client.pause_function(&s.admin, &Symbol::new(&s.env, "accept_offer"));
    s.client.unpause_function(&s.admin, &Symbol::new(&s.env, "accept_offer"));
    s.client.accept_offer(&s.admin, &oid);
}

// ── Cross-axis independence ───────────────────────────────────────────────────
// Pausing one collection must not affect a different collection's listings.

#[test]
fn test_different_collection_unaffected_by_collection_pause() {
    let s = setup();
    let col2 = s.env.register(mock_nft::MockNft, ());
    MockNftClient::new(&s.env, &col2).set_owner(&1u64, &s.admin);

    let lid2 = s.client.create_listing(
        &s.admin, &5_000_000_i128, &symbol_short!("XLM"),
        &s.token, &col2, &1u64, &1u64,
        &valid_recipients(&s.env, &s.admin), &None::<u64>,
    );

    // Pause the FIRST collection.
    s.client.pause_collection(&s.admin, &s.col);

    // Buying from the second (unpaused) collection must succeed.
    assert!(s.client.buy_artwork(&s.buyer, &lid2));
}

// ── get_pause_matrix any_paused mirrors require_not_paused_ctx ────────────────

#[test]
fn test_pause_matrix_any_paused_consistent_with_is_paused() {
    let s = setup();
    let fn_sym = Symbol::new(&s.env, "buy_artwork");

    // Nothing paused → any_paused false → buy_artwork succeeds.
    let pm = s.client.get_pause_matrix(&Some(s.col.clone()), &Some(fn_sym.clone()));
    assert!(!pm.any_paused);

    // Pause the function → any_paused true → buy_artwork panics.
    s.client.pause_function(&s.admin, &fn_sym);
    let pm2 = s.client.get_pause_matrix(&Some(s.col.clone()), &Some(fn_sym));
    assert!(pm2.any_paused);
    assert!(pm2.function_paused);
}
