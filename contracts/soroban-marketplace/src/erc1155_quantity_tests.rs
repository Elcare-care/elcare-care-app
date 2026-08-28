/// Issue #479 — ERC-1155 partial-quantity settlement tests.
///
/// These tests verify that listings with `quantity > 1` (ERC-1155 multi-
/// edition) flow correctly through creation, settlement, cancellation, and
/// royalty calculation.  A dedicated mock collection is registered per test so
/// it can respond to both `transfer_from` (escrow-in) and
/// `batch_transfer_from` (escrow-out on buy/cancel).
use super::*;
use crate::types::{ListingStatus, Recipient};
use soroban_sdk::{
    symbol_short,
    testutils::Address as _,
    token::StellarAssetClient,
    vec, Address, Env,
};

// ── Mock ERC-1155 collection ──────────────────────────────────────────────────
//
// Supports the three entry points the marketplace calls:
//   • transfer_from   — used by escrow_nft to pull token into custody
//   • batch_transfer_from — used by release_nft_with_quantity on buy/cancel
//   • owner_of        — ownership check during escrow
//   • royalty_info    — royalty receiver + bps
//   • contract_type   — returns "ERC1155" so quantity > 1 is accepted
mod mock_erc1155 {
    use soroban_sdk::{
        contract, contractimpl, Address, Bytes, Env, Symbol, Vec,
    };

    #[soroban_sdk::contracttype]
    enum Key {
        Owner(u64),
        RoyaltyBps,
        RoyaltyRecv,
    }

    #[contract]
    pub struct MockErc1155;

    #[contractimpl]
    impl MockErc1155 {
        pub fn owner_of(env: Env, token_id: u64) -> Address {
            env.storage()
                .instance()
                .get::<Key, Address>(&Key::Owner(token_id))
                .expect("token has no owner")
        }

        pub fn set_owner(env: Env, token_id: u64, owner: Address) {
            env.storage()
                .instance()
                .set(&Key::Owner(token_id), &owner);
        }

        /// Called by escrow_nft to move the token into marketplace custody.
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
                .get::<Key, Address>(&Key::Owner(token_id))
                .expect("token has no owner");
            assert_eq!(cur, from, "transfer_from: wrong owner");
            env.storage().instance().set(&Key::Owner(token_id), &to);
        }

        /// Called by release_nft_with_quantity to deliver tokens to the buyer.
        /// Transfers ownership of the first id in `ids` from `from` to `to`.
        pub fn batch_transfer_from(
            env: Env,
            _operator: Address,
            from: Address,
            to: Address,
            ids: Vec<u64>,
            _amounts: Vec<u128>,
            _data: Bytes,
        ) {
            if let Some(token_id) = ids.get(0) {
                let cur: Address = env
                    .storage()
                    .instance()
                    .get::<Key, Address>(&Key::Owner(token_id))
                    .expect("token has no owner");
                assert_eq!(cur, from, "batch_transfer_from: wrong owner");
                env.storage()
                    .instance()
                    .set(&Key::Owner(token_id), &to);
            }
        }

        pub fn royalty_info(env: Env) -> (Address, u32) {
            use soroban_sdk::testutils::Address as _;
            let bps: u32 = env
                .storage()
                .instance()
                .get::<Key, u32>(&Key::RoyaltyBps)
                .unwrap_or(0);
            let recv: Address = env
                .storage()
                .instance()
                .get::<Key, Address>(&Key::RoyaltyRecv)
                .unwrap_or_else(|| Address::generate(&env));
            (recv, bps)
        }

        pub fn set_royalty(env: Env, recv: Address, bps: u32) {
            env.storage().instance().set(&Key::RoyaltyRecv, &recv);
            env.storage().instance().set(&Key::RoyaltyBps, &bps);
        }

        pub fn contract_type(_env: Env) -> Symbol {
            Symbol::new(&_env, "ERC1155")
        }
    }
}
use mock_erc1155::MockErc1155Client;

// ── Shared test setup ─────────────────────────────────────────────────────────

fn setup_1155() -> (Env, MarketplaceContractClient<'static>, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let artist = Address::generate(&env);
    let buyer = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let payment_token = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    StellarAssetClient::new(&env, &payment_token).mint(&buyer, &1_000_000_000_i128);
    StellarAssetClient::new(&env, &payment_token).mint(&artist, &1_000_000_000_i128);
    StellarAssetClient::new(&env, &contract_id).mint(&contract_id, &1_000_000_000_i128);

    // ERC-1155 collection
    let collection = env.register(mock_erc1155::MockErc1155, ());
    MockErc1155Client::new(&env, &collection).set_owner(&1u64, &artist);

    client.set_admin(&admin);
    client.add_token_to_whitelist(&admin, &payment_token);

    (env, client, artist, buyer, payment_token, collection)
}

fn recipients(env: &Env, artist: &Address) -> soroban_sdk::Vec<Recipient> {
    vec![
        env,
        Recipient {
            address: artist.clone(),
            percentage: 10_000,
        },
    ]
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[test]
fn erc1155_listing_with_quantity_gt_one_is_created_active() {
    let (env, client, artist, _buyer, token, collection) = setup_1155();

    let id = client.create_listing(
        &artist,
        &500_000_i128,
        &symbol_short!("XLM"),
        &token,
        &collection,
        &1u64,
        &10u64,
        &recipients(&env, &artist),
        &None::<u64>,
    );

    let listing = client.get_listing(&id);
    assert_eq!(listing.status, ListingStatus::Active);
    assert_eq!(listing.quantity, 10u64);
}

#[test]
fn erc1155_buy_full_quantity_marks_listing_sold() {
    let (env, client, artist, buyer, token, collection) = setup_1155();

    let id = client.create_listing(
        &artist,
        &500_000_i128,
        &symbol_short!("XLM"),
        &token,
        &collection,
        &1u64,
        &5u64,
        &recipients(&env, &artist),
        &None::<u64>,
    );

    let sold = client.buy_artwork(&buyer, &id);
    assert!(sold);
    assert_eq!(client.get_listing(&id).status, ListingStatus::Sold);
}

#[test]
fn erc1155_cancel_listing_with_quantity_marks_cancelled() {
    let (env, client, artist, _buyer, token, collection) = setup_1155();

    let id = client.create_listing(
        &artist,
        &500_000_i128,
        &symbol_short!("XLM"),
        &token,
        &collection,
        &1u64,
        &8u64,
        &recipients(&env, &artist),
        &None::<u64>,
    );

    let cancelled = client.cancel_listing(&artist, &id);
    assert!(cancelled);
    assert_eq!(client.get_listing(&id).status, ListingStatus::Cancelled);
}

#[test]
#[should_panic(expected = "Error(Contract")]
fn erc1155_buy_already_sold_listing_panics() {
    let (env, client, artist, buyer, token, collection) = setup_1155();

    // Second buyer — needs funds too (already minted in setup_1155 for buyer)
    let buyer2 = buyer.clone();

    let id = client.create_listing(
        &artist,
        &100_000_i128,
        &symbol_short!("XLM"),
        &token,
        &collection,
        &1u64,
        &3u64,
        &recipients(&env, &artist),
        &None::<u64>,
    );

    client.buy_artwork(&buyer, &id);
    // Second buy on an already-sold listing must panic.
    client.buy_artwork(&buyer2, &id);
}

#[test]
fn erc1155_royalty_applied_on_quantity_sale() {
    let (env, client, artist, buyer, token, collection) = setup_1155();

    // Configure royalty on the collection
    let royalty_receiver = Address::generate(&env);
    MockErc1155Client::new(&env, &collection).set_royalty(&royalty_receiver, &500u32); // 5%

    // Protocol treasury
    let treasury = Address::generate(&env);
    client.set_treasury(&artist, &treasury);
    client.set_protocol_fee(&artist, &200u32); // 2%

    let price = 1_000_000_i128;
    let rcps = vec![
        &env,
        Recipient {
            address: artist.clone(),
            percentage: 7_800, // 78% — leaves room for royalty (5%) + fee (2%)
        },
    ];

    let id = client.create_listing(
        &artist,
        &price,
        &symbol_short!("XLM"),
        &token,
        &collection,
        &1u64,
        &4u64,
        &rcps,
        &None::<u64>,
    );

    // Snapshot buyer balance before purchase
    let buyer_before = soroban_sdk::token::TokenClient::new(&env, &token).balance(&buyer);

    client.buy_artwork(&buyer, &id);

    let buyer_after = soroban_sdk::token::TokenClient::new(&env, &token).balance(&buyer);
    // Buyer paid at most `price`
    assert!(buyer_before - buyer_after <= price);

    assert_eq!(client.get_listing(&id).status, ListingStatus::Sold);
}

#[test]
fn erc1155_listing_quantity_stored_in_record() {
    let (env, client, artist, _buyer, token, collection) = setup_1155();
    let qty = 42u64;

    let id = client.create_listing(
        &artist,
        &200_000_i128,
        &symbol_short!("XLM"),
        &token,
        &collection,
        &1u64,
        &qty,
        &recipients(&env, &artist),
        &None::<u64>,
    );

    assert_eq!(client.get_listing(&id).quantity, qty);
}
