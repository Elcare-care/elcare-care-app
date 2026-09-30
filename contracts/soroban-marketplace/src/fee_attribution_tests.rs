/// # Fee attribution for per-collection fee overrides (Issue #846)
///
/// Settlement must record the fee rate it actually applied: the collection's
/// `CollectionFeeBps` override when one is configured, otherwise the rate
/// snapshotted on the listing when it was created. `FeeAttributionEvent` carries
/// both the applied rate and a flag saying which of the two it came from, so the
/// indexer can separate override-driven fee income from snapshot-rate income.
///
/// These tests pin the pair down end-to-end: the treasury balance shows which
/// rate was really charged, and the event topic shows the attribution fired.
use crate::test::{mock_nft, valid_recipients, MockNftClient};
use crate::{MarketplaceContract, MarketplaceContractClient};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, Env,
};

/// (env, client, admin/artist, buyer, payment token, treasury, collection)
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

    let collection = env.register(mock_nft::MockNft, ());
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

/// Creates a listing, sells it, and reports whether the settlement attributed
/// its fee. The event check happens immediately after the settling call: Soroban
/// testutils only keep the most recent invocation's events.
fn sell(
    env: &Env,
    client: &MarketplaceContractClient,
    artist: &Address,
    buyer: &Address,
    token: &Address,
    collection: &Address,
    price: i128,
) -> bool {
    let listing_id = client.create_listing(
        artist,
        &price,
        &symbol_short!("XLM"),
        token,
        collection,
        &1u64,
        &1u64,
        &valid_recipients(env, artist),
        &None::<u64>,
    );
    client.buy_artwork(buyer, &listing_id);
    has_event_with_topic(env, "fee_attribution")
}

#[allow(irrefutable_let_patterns)] // ContractEventBody has a single variant in this SDK version
fn has_event_with_topic(env: &Env, symbol: &str) -> bool {
    use soroban_sdk::xdr::{ContractEventBody, ScVal};
    env.events().all().events().iter().any(|event| {
        if let ContractEventBody::V0(body) = &event.body {
            body.topics.iter().any(|topic| match topic {
                ScVal::Symbol(s) => core::str::from_utf8(s.0.as_slice()).unwrap_or("") == symbol,
                _ => false,
            })
        } else {
            false
        }
    })
}

#[test]
fn test_fee_attribution_uses_snapshot_rate_without_override() {
    let (env, client, artist, buyer, token, treasury, collection) = setup();
    let price = 10_000_000_i128;

    // Global fee 300 bps, no collection override: the listing snapshots 300.
    client.set_protocol_fee(&artist, &300u32);

    assert!(
        sell(&env, &client, &artist, &buyer, &token, &collection, price),
        "settlement must attribute the fee it applied"
    );

    let token_client = TokenClient::new(&env, &token);
    assert_eq!(token_client.balance(&treasury), 300_000_i128); // 300 bps of 10_000_000
}

#[test]
fn test_fee_attribution_applies_collection_override() {
    let (env, client, artist, buyer, token, treasury, collection) = setup();
    let price = 10_000_000_i128;

    // Listing snapshots the global 300 bps, then the collection gets a 700 bps
    // override: the override is what the settlement must apply and attribute.
    client.set_protocol_fee(&artist, &300u32);
    client.set_collection_fee_bps(&artist, &collection, &700u32);
    assert_eq!(client.get_collection_fee_bps(&collection), Some(700u32));

    assert!(
        sell(&env, &client, &artist, &buyer, &token, &collection, price),
        "override-driven settlement must be attributed"
    );

    let token_client = TokenClient::new(&env, &token);
    assert_eq!(token_client.balance(&treasury), 700_000_i128); // 700 bps, not the snapshot
}

#[test]
fn test_fee_attribution_falls_back_when_override_cleared() {
    let (env, client, artist, buyer, token, treasury, collection) = setup();
    let price = 10_000_000_i128;

    client.set_protocol_fee(&artist, &300u32);
    client.set_collection_fee_bps(&artist, &collection, &900u32);
    client.clear_collection_fee_bps(&artist, &collection);
    assert_eq!(client.get_collection_fee_bps(&collection), None);

    assert!(sell(
        &env,
        &client,
        &artist,
        &buyer,
        &token,
        &collection,
        price
    ));

    let token_client = TokenClient::new(&env, &token);
    assert_eq!(token_client.balance(&treasury), 300_000_i128);
}

#[test]
fn test_fee_attribution_with_zero_override_charges_no_fee() {
    let (env, client, artist, buyer, token, treasury, collection) = setup();
    let price = 10_000_000_i128;

    client.set_protocol_fee(&artist, &300u32);
    // An explicit 0 bps override is a deliberate choice, not a missing value —
    // it must win over the snapshot and charge nothing.
    client.set_collection_fee_bps(&artist, &collection, &0u32);

    assert!(sell(
        &env,
        &client,
        &artist,
        &buyer,
        &token,
        &collection,
        price
    ));

    let token_client = TokenClient::new(&env, &token);
    assert_eq!(token_client.balance(&treasury), 0_i128);
}
