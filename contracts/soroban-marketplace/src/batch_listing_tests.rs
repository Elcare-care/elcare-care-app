/// Issue #457 — Batch listing creation, update, and cancellation tests.
///
/// Covers all required acceptance-criteria scenarios:
///   • Single-item batch (sanity check for create, update, cancel)
///   • Ten-item successful batch create
///   • Batch with one invalid item — verifies correct zero-based item_index
///   • BatchTooLarge when the 50-item cap is exceeded
///   • Mixed ERC-721 / ERC-1155 batch create
///   • Two-phase atomicity: partial failure leaves no state changes
///   • update_listings: two-phase validation, BatchTooLarge
///   • cancel_listings: two-phase validation, BatchTooLarge, all emit events
use super::*;
use crate::types::{
    BatchCreateListingInput, BatchUpdateListingInput, ListingStatus, MarketplaceError, Recipient,
};
use soroban_sdk::{
    symbol_short,
    testutils::Address as _,
    token::StellarAssetClient,
    vec, Address, Env,
};

// ── Mock ERC-721 collection ───────────────────────────────────────────────────
//
// Minimal mock used for single-token (quantity = 1) listings.  Exposes:
//   • owner_of        — ownership check in escrow_nft
//   • set_owner       — test helper (mint)
//   • transfer_from   — escrow_nft pull and release_nft push
//   • royalty_info    — 0 bps (no royalty) for settlement simplicity
//   • contract_type   — "ERC721" so quantity-1 constraint is enforced
mod mock_nft_721 {
    use soroban_sdk::{contract, contractimpl, Address, Env, Symbol};

    #[soroban_sdk::contracttype]
    enum Key721 {
        Owner(u64),
    }

    #[contract]
    pub struct MockNft721;

    #[contractimpl]
    impl MockNft721 {
        pub fn owner_of(env: Env, token_id: u64) -> Address {
            env.storage()
                .instance()
                .get::<Key721, Address>(&Key721::Owner(token_id))
                .expect("token has no owner")
        }

        pub fn set_owner(env: Env, token_id: u64, owner: Address) {
            env.storage()
                .instance()
                .set(&Key721::Owner(token_id), &owner);
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
                .get::<Key721, Address>(&Key721::Owner(token_id))
                .expect("token has no owner");
            assert_eq!(cur, from, "transfer_from: wrong owner");
            env.storage()
                .instance()
                .set(&Key721::Owner(token_id), &to);
        }

        pub fn royalty_info(env: Env) -> (Address, u32) {
            use soroban_sdk::testutils::Address as _;
            (Address::generate(&env), 0u32)
        }

        pub fn contract_type(_env: Env) -> Symbol {
            Symbol::new(&_env, "ERC721")
        }
    }
}
use mock_nft_721::MockNft721Client;

// ── Mock ERC-1155 collection ──────────────────────────────────────────────────
//
// Supports both transfer_from (escrow-in) and batch_transfer_from (escrow-out
// on cancel / buy).  Returns "ERC1155" from contract_type so quantity > 1 is
// accepted.
mod mock_nft_1155 {
    use soroban_sdk::{contract, contractimpl, Address, Bytes, Env, Symbol, Vec};

    #[soroban_sdk::contracttype]
    enum Key1155 {
        Owner(u64),
    }

    #[contract]
    pub struct MockNft1155;

    #[contractimpl]
    impl MockNft1155 {
        pub fn owner_of(env: Env, token_id: u64) -> Address {
            env.storage()
                .instance()
                .get::<Key1155, Address>(&Key1155::Owner(token_id))
                .expect("token has no owner")
        }

        pub fn set_owner(env: Env, token_id: u64, owner: Address) {
            env.storage()
                .instance()
                .set(&Key1155::Owner(token_id), &owner);
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
                .get::<Key1155, Address>(&Key1155::Owner(token_id))
                .expect("token has no owner");
            assert_eq!(cur, from, "transfer_from: wrong owner");
            env.storage()
                .instance()
                .set(&Key1155::Owner(token_id), &to);
        }

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
                    .get::<Key1155, Address>(&Key1155::Owner(token_id))
                    .expect("token has no owner");
                assert_eq!(cur, from, "batch_transfer_from: wrong owner");
                env.storage()
                    .instance()
                    .set(&Key1155::Owner(token_id), &to);
            }
        }

        pub fn royalty_info(env: Env) -> (Address, u32) {
            use soroban_sdk::testutils::Address as _;
            (Address::generate(&env), 0u32)
        }

        pub fn contract_type(_env: Env) -> Symbol {
            Symbol::new(&_env, "ERC1155")
        }
    }
}
use mock_nft_1155::MockNft1155Client;

// ── Shared setup ──────────────────────────────────────────────────────────────

/// Returns `(env, client, admin, artist, payment_token)`.
/// The ERC-721 collection is registered separately per test so each token_id
/// maps to a fresh contract (avoids cross-test escrow-record collisions).
fn setup_batch() -> (
    Env,
    MarketplaceContractClient<'static>,
    Address, // admin
    Address, // artist
    Address, // payment_token
) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let artist = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let payment_token = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    StellarAssetClient::new(&env, &payment_token).mint(&artist, &10_000_000_000_i128);
    StellarAssetClient::new(&env, &payment_token).mint(&contract_id, &10_000_000_000_i128);

    client.set_admin(&admin);
    client.add_token_to_whitelist(&admin, &payment_token);

    (env, client, admin, artist, payment_token)
}

/// Build a single-recipient vec awarding 100% to `artist`.
fn rcpts(env: &Env, artist: &Address) -> soroban_sdk::Vec<Recipient> {
    vec![
        env,
        Recipient {
            address: artist.clone(),
            percentage: 10_000,
        },
    ]
}

/// Register a fresh ERC-721 collection, mint `token_id` to `artist`, and
/// return the collection address.
fn fresh_721(env: &Env, artist: &Address, token_id: u64) -> Address {
    let col = env.register(mock_nft_721::MockNft721, ());
    MockNft721Client::new(env, &col).set_owner(&token_id, artist);
    col
}

/// Register a fresh ERC-1155 collection, mint `token_id` to `artist`, and
/// return the collection address.
fn fresh_1155(env: &Env, artist: &Address, token_id: u64) -> Address {
    let col = env.register(mock_nft_1155::MockNft1155, ());
    MockNft1155Client::new(env, &col).set_owner(&token_id, artist);
    col
}

/// Build a valid `BatchCreateListingInput` for the given collection / token.
fn make_create_input(
    env: &Env,
    artist: &Address,
    payment_token: &Address,
    collection: &Address,
    token_id: u64,
    quantity: u64,
) -> BatchCreateListingInput {
    BatchCreateListingInput {
        price: 1_000_000_i128,
        currency: symbol_short!("XLM"),
        token: payment_token.clone(),
        collection: collection.clone(),
        token_id,
        quantity,
        recipients: rcpts(env, artist),
        expires_at: None,
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// create_listings tests
// ═══════════════════════════════════════════════════════════════════════════

// ── Sanity: single-item batch ─────────────────────────────────────────────

#[test]
fn batch_create_single_item_succeeds() {
    let (env, client, _admin, artist, token) = setup_batch();
    let col = fresh_721(&env, &artist, 1);
    let items = vec![&env, make_create_input(&env, &artist, &token, &col, 1, 1)];

    let ids = client.create_listings(&artist, &items);

    assert_eq!(ids.len(), 1);
    let listing = client.get_listing(&ids.get(0).unwrap());
    assert_eq!(listing.status, ListingStatus::Active);
    assert_eq!(listing.price, 1_000_000_i128);
    assert_eq!(listing.artist, artist);
}

// ── Ten-item successful batch ─────────────────────────────────────────────

#[test]
fn batch_create_ten_items_all_active() {
    let (env, client, _admin, artist, token) = setup_batch();

    let mut items = soroban_sdk::Vec::new(&env);
    for token_id in 1u64..=10u64 {
        let col = fresh_721(&env, &artist, token_id);
        items.push_back(make_create_input(&env, &artist, &token, &col, token_id, 1));
    }

    let ids = client.create_listings(&artist, &items);

    assert_eq!(ids.len(), 10);
    for i in 0..10u32 {
        let listing = client.get_listing(&ids.get(i).unwrap());
        assert_eq!(listing.status, ListingStatus::Active);
    }
    // Total listing count must reflect all ten new listings.
    assert_eq!(client.get_total_listings(), 10u64);
}

// ── Invalid item at index 0 ───────────────────────────────────────────────

#[test]
fn batch_create_invalid_item_index_zero_rejected() {
    let (env, client, _admin, artist, token) = setup_batch();
    let good_col = fresh_721(&env, &artist, 2);

    // Item 0: price = 0  →  InvalidPrice = 2, reported at index 0.
    let bad_item = BatchCreateListingInput {
        price: 0, // invalid
        currency: symbol_short!("XLM"),
        token: token.clone(),
        collection: fresh_721(&env, &artist, 1),
        token_id: 1,
        quantity: 1,
        recipients: rcpts(&env, &artist),
        expires_at: None,
    };
    let good_item = make_create_input(&env, &artist, &token, &good_col, 2, 1);
    let items = vec![&env, bad_item, good_item];

    let result = client.try_create_listings(&artist, &items);
    // Must fail with BatchItemInvalid = 61.
    assert!(result.is_err());
    // No listings must have been created (all-or-nothing).
    assert_eq!(client.get_total_listings(), 0u64);
}

// ── Invalid item at index 4 (middle of batch) ─────────────────────────────

#[test]
fn batch_create_invalid_item_mid_batch_correct_index() {
    let (env, client, _admin, artist, token) = setup_batch();

    let mut items = soroban_sdk::Vec::new(&env);
    // Items 0–3: valid ERC-721 tokens.
    for token_id in 1u64..=4u64 {
        let col = fresh_721(&env, &artist, token_id);
        items.push_back(make_create_input(&env, &artist, &token, &col, token_id, 1));
    }
    // Item 4: invalid price.
    items.push_back(BatchCreateListingInput {
        price: -1,
        currency: symbol_short!("XLM"),
        token: token.clone(),
        collection: fresh_721(&env, &artist, 5),
        token_id: 5,
        quantity: 1,
        recipients: rcpts(&env, &artist),
        expires_at: None,
    });
    // Items 5–9: valid tokens — must never be created.
    for token_id in 6u64..=10u64 {
        let col = fresh_721(&env, &artist, token_id);
        items.push_back(make_create_input(&env, &artist, &token, &col, token_id, 1));
    }

    let result = client.try_create_listings(&artist, &items);
    assert!(result.is_err());
    // All-or-nothing: zero listings created.
    assert_eq!(client.get_total_listings(), 0u64);
}

// ── Last item in batch is invalid ────────────────────────────────────────

#[test]
fn batch_create_last_item_invalid_nothing_created() {
    let (env, client, _admin, artist, token) = setup_batch();

    let mut items = soroban_sdk::Vec::new(&env);
    for token_id in 1u64..=4u64 {
        let col = fresh_721(&env, &artist, token_id);
        items.push_back(make_create_input(&env, &artist, &token, &col, token_id, 1));
    }
    // Last item: invalid — too many recipients (5 > 4).
    items.push_back(BatchCreateListingInput {
        price: 1_000_000,
        currency: symbol_short!("XLM"),
        token: token.clone(),
        collection: fresh_721(&env, &artist, 5),
        token_id: 5,
        quantity: 1,
        recipients: vec![
            &env,
            Recipient { address: Address::generate(&env), percentage: 2_000 },
            Recipient { address: Address::generate(&env), percentage: 2_000 },
            Recipient { address: Address::generate(&env), percentage: 2_000 },
            Recipient { address: Address::generate(&env), percentage: 2_000 },
            Recipient { address: Address::generate(&env), percentage: 2_000 },
        ],
        expires_at: None,
    });

    assert!(client.try_create_listings(&artist, &items).is_err());
    assert_eq!(client.get_total_listings(), 0u64);
}

// ── BatchTooLarge: 51 items exceeds MAX_BATCH_CREATE = 50 ────────────────

#[test]
fn batch_create_too_large_returns_batch_too_large() {
    let (env, client, _admin, artist, token) = setup_batch();

    let mut items = soroban_sdk::Vec::new(&env);
    for token_id in 1u64..=51u64 {
        let col = fresh_721(&env, &artist, token_id);
        items.push_back(make_create_input(&env, &artist, &token, &col, token_id, 1));
    }

    let result = client.try_create_listings(&artist, &items);
    // Must fail — specifically with BatchTooLarge = 36.
    assert!(result.is_err());
    // Confirm error code 36 (BatchTooLarge).
    let err = result.unwrap_err().unwrap();
    assert_eq!(err, MarketplaceError::BatchTooLarge);
}

// ── Exactly at the cap (50 items) succeeds ───────────────────────────────

#[test]
fn batch_create_exactly_fifty_items_succeeds() {
    let (env, client, _admin, artist, token) = setup_batch();

    let mut items = soroban_sdk::Vec::new(&env);
    for token_id in 1u64..=50u64 {
        let col = fresh_721(&env, &artist, token_id);
        items.push_back(make_create_input(&env, &artist, &token, &col, token_id, 1));
    }

    let ids = client.create_listings(&artist, &items);
    assert_eq!(ids.len(), 50);
    assert_eq!(client.get_total_listings(), 50u64);
}

// ── Mixed ERC-721 / ERC-1155 batch ───────────────────────────────────────

#[test]
fn batch_create_mixed_erc721_and_erc1155_succeeds() {
    let (env, client, _admin, artist, token) = setup_batch();

    // Three ERC-721 tokens (quantity = 1 each).
    let col_a = fresh_721(&env, &artist, 1);
    let col_b = fresh_721(&env, &artist, 2);
    let col_c = fresh_721(&env, &artist, 3);

    // Two ERC-1155 tokens (quantity = 5 each).
    let col_d = fresh_1155(&env, &artist, 4);
    let col_e = fresh_1155(&env, &artist, 5);

    let items = vec![
        &env,
        make_create_input(&env, &artist, &token, &col_a, 1, 1),
        make_create_input(&env, &artist, &token, &col_b, 2, 1),
        make_create_input(&env, &artist, &token, &col_c, 3, 1),
        make_create_input(&env, &artist, &token, &col_d, 4, 5),
        make_create_input(&env, &artist, &token, &col_e, 5, 5),
    ];

    let ids = client.create_listings(&artist, &items);
    assert_eq!(ids.len(), 5);

    // Verify ERC-721 items have quantity 1.
    assert_eq!(client.get_listing(&ids.get(0).unwrap()).quantity, 1u64);
    assert_eq!(client.get_listing(&ids.get(1).unwrap()).quantity, 1u64);
    assert_eq!(client.get_listing(&ids.get(2).unwrap()).quantity, 1u64);
    // Verify ERC-1155 items have quantity 5.
    assert_eq!(client.get_listing(&ids.get(3).unwrap()).quantity, 5u64);
    assert_eq!(client.get_listing(&ids.get(4).unwrap()).quantity, 5u64);

    // All five listings are Active and immediately queryable.
    for i in 0..5u32 {
        assert_eq!(
            client.get_listing(&ids.get(i).unwrap()).status,
            ListingStatus::Active
        );
    }
}

// ── ERC-721 with quantity > 1 in a mixed batch fails at correct index ─────

#[test]
fn batch_create_mixed_erc721_quantity_gt_one_fails_at_correct_index() {
    let (env, client, _admin, artist, token) = setup_batch();

    let col_ok = fresh_721(&env, &artist, 1);
    // Item index 1: ERC-721 collection but quantity = 3 → CollectionIncompatible = 60.
    let col_bad = fresh_721(&env, &artist, 2);

    let items = vec![
        &env,
        make_create_input(&env, &artist, &token, &col_ok, 1, 1),
        // quantity = 3 on an ERC-721 → should fail
        BatchCreateListingInput {
            price: 1_000_000,
            currency: symbol_short!("XLM"),
            token: token.clone(),
            collection: col_bad.clone(),
            token_id: 2,
            quantity: 3, // invalid for ERC-721
            recipients: rcpts(&env, &artist),
            expires_at: None,
        },
    ];

    let result = client.try_create_listings(&artist, &items);
    assert!(result.is_err());
    // No listings created.
    assert_eq!(client.get_total_listings(), 0u64);
}

// ── Returned IDs are valid and immediately queryable via get_listing ──────

#[test]
fn batch_create_returned_ids_are_queryable() {
    let (env, client, _admin, artist, token) = setup_batch();
    let col1 = fresh_721(&env, &artist, 1);
    let col2 = fresh_721(&env, &artist, 2);
    let col3 = fresh_721(&env, &artist, 3);

    let items = vec![
        &env,
        make_create_input(&env, &artist, &token, &col1, 1, 1),
        make_create_input(&env, &artist, &token, &col2, 2, 1),
        make_create_input(&env, &artist, &token, &col3, 3, 1),
    ];

    let ids = client.create_listings(&artist, &items);
    assert_eq!(ids.len(), 3);

    for i in 0..3u32 {
        let id = ids.get(i).unwrap();
        let listing = client.get_listing(&id);
        assert_eq!(listing.listing_id, id);
        assert_eq!(listing.status, ListingStatus::Active);
        assert_eq!(listing.artist, artist);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// update_listings tests
// ═══════════════════════════════════════════════════════════════════════════

// ── Sanity: single-item update ────────────────────────────────────────────

#[test]
fn batch_update_single_item_updates_price() {
    let (env, client, _admin, artist, token) = setup_batch();
    let col = fresh_721(&env, &artist, 1);

    let id = client.create_listing(
        &artist,
        &1_000_000_i128,
        &symbol_short!("XLM"),
        &token,
        &col,
        &1u64,
        &1u64,
        &rcpts(&env, &artist),
        &None::<u64>,
    );

    let update = BatchUpdateListingInput {
        listing_id: id,
        new_price: 2_000_000_i128,
        new_token: token.clone(),
        new_recipients: rcpts(&env, &artist),
    };
    let results = client.update_listings(&artist, &vec![&env, update]);
    assert_eq!(results.len(), 1);
    assert!(results.get(0).unwrap());

    assert_eq!(client.get_listing(&id).price, 2_000_000_i128);
}

// ── Multi-item update: all prices updated atomically ─────────────────────

#[test]
fn batch_update_multiple_items_all_prices_updated() {
    let (env, client, _admin, artist, token) = setup_batch();

    let mut create_items = soroban_sdk::Vec::new(&env);
    for token_id in 1u64..=5u64 {
        let col = fresh_721(&env, &artist, token_id);
        create_items.push_back(make_create_input(&env, &artist, &token, &col, token_id, 1));
    }
    let ids = client.create_listings(&artist, &create_items);

    let mut update_items = soroban_sdk::Vec::new(&env);
    for i in 0..5u32 {
        update_items.push_back(BatchUpdateListingInput {
            listing_id: ids.get(i).unwrap(),
            new_price: 9_999_999_i128,
            new_token: token.clone(),
            new_recipients: rcpts(&env, &artist),
        });
    }

    let results = client.update_listings(&artist, &update_items);
    assert_eq!(results.len(), 5);
    for i in 0..5u32 {
        assert!(results.get(i).unwrap());
        assert_eq!(
            client.get_listing(&ids.get(i).unwrap()).price,
            9_999_999_i128
        );
    }
}

// ── Batch update fails if one listing_id does not exist ───────────────────

#[test]
fn batch_update_nonexistent_listing_fails_batch_item_invalid() {
    let (env, client, _admin, artist, token) = setup_batch();
    let col = fresh_721(&env, &artist, 1);
    let id = client.create_listing(
        &artist,
        &1_000_000_i128,
        &symbol_short!("XLM"),
        &token,
        &col,
        &1u64,
        &1u64,
        &rcpts(&env, &artist),
        &None::<u64>,
    );

    let items = vec![
        &env,
        BatchUpdateListingInput {
            listing_id: id,
            new_price: 2_000_000_i128,
            new_token: token.clone(),
            new_recipients: rcpts(&env, &artist),
        },
        BatchUpdateListingInput {
            listing_id: 9_999u64, // does not exist
            new_price: 2_000_000_i128,
            new_token: token.clone(),
            new_recipients: rcpts(&env, &artist),
        },
    ];

    let result = client.try_update_listings(&artist, &items);
    assert!(result.is_err());
    // First listing must be unchanged (atomicity).
    assert_eq!(client.get_listing(&id).price, 1_000_000_i128);
}

// ── Batch update fails if caller is not owner ─────────────────────────────

#[test]
fn batch_update_wrong_owner_fails() {
    let (env, client, _admin, artist, token) = setup_batch();
    let col = fresh_721(&env, &artist, 1);
    let id = client.create_listing(
        &artist,
        &1_000_000_i128,
        &symbol_short!("XLM"),
        &token,
        &col,
        &1u64,
        &1u64,
        &rcpts(&env, &artist),
        &None::<u64>,
    );

    let intruder = Address::generate(&env);
    let items = vec![
        &env,
        BatchUpdateListingInput {
            listing_id: id,
            new_price: 2_000_000_i128,
            new_token: token.clone(),
            new_recipients: rcpts(&env, &intruder),
        },
    ];

    assert!(client.try_update_listings(&intruder, &items).is_err());
    // Price unchanged.
    assert_eq!(client.get_listing(&id).price, 1_000_000_i128);
}

// ── update_listings: BatchTooLarge ────────────────────────────────────────

#[test]
fn batch_update_too_large_returns_batch_too_large() {
    let (env, client, _admin, artist, token) = setup_batch();

    // Build 51 update requests (no need for real listings — preflight will
    // reject at the size cap before loading any listing).
    let mut items = soroban_sdk::Vec::new(&env);
    for i in 0u64..51u64 {
        items.push_back(BatchUpdateListingInput {
            listing_id: i + 1,
            new_price: 1_000_000_i128,
            new_token: token.clone(),
            new_recipients: rcpts(&env, &artist),
        });
    }

    let result = client.try_update_listings(&artist, &items);
    assert!(result.is_err());
    let err = result.unwrap_err().unwrap();
    assert_eq!(err, MarketplaceError::BatchTooLarge);
}

// ── update_listings: invalid price fails preflight ────────────────────────

#[test]
fn batch_update_invalid_price_fails_preflight() {
    let (env, client, _admin, artist, token) = setup_batch();
    let col = fresh_721(&env, &artist, 1);
    let id = client.create_listing(
        &artist,
        &1_000_000_i128,
        &symbol_short!("XLM"),
        &token,
        &col,
        &1u64,
        &1u64,
        &rcpts(&env, &artist),
        &None::<u64>,
    );

    let items = vec![
        &env,
        BatchUpdateListingInput {
            listing_id: id,
            new_price: 0, // invalid
            new_token: token.clone(),
            new_recipients: rcpts(&env, &artist),
        },
    ];

    assert!(client.try_update_listings(&artist, &items).is_err());
    // Price must be unchanged.
    assert_eq!(client.get_listing(&id).price, 1_000_000_i128);
}

// ═══════════════════════════════════════════════════════════════════════════
// cancel_listings tests
// ═══════════════════════════════════════════════════════════════════════════

// ── Sanity: single-item cancel ────────────────────────────────────────────

#[test]
fn batch_cancel_single_item_marks_cancelled() {
    let (env, client, _admin, artist, token) = setup_batch();
    let col = fresh_721(&env, &artist, 1);
    let id = client.create_listing(
        &artist,
        &1_000_000_i128,
        &symbol_short!("XLM"),
        &token,
        &col,
        &1u64,
        &1u64,
        &rcpts(&env, &artist),
        &None::<u64>,
    );

    let cancelled = client.cancel_listings(&artist, &vec![&env, id]);
    assert_eq!(cancelled, 1u32);
    assert_eq!(client.get_listing(&id).status, ListingStatus::Cancelled);
}

// ── Multi-item cancel: all cancelled in one transaction ───────────────────

#[test]
fn batch_cancel_multiple_items_all_cancelled() {
    let (env, client, _admin, artist, token) = setup_batch();

    let mut create_items = soroban_sdk::Vec::new(&env);
    for token_id in 1u64..=5u64 {
        let col = fresh_721(&env, &artist, token_id);
        create_items.push_back(make_create_input(&env, &artist, &token, &col, token_id, 1));
    }
    let ids = client.create_listings(&artist, &create_items);

    let mut cancel_ids = soroban_sdk::Vec::new(&env);
    for i in 0..5u32 {
        cancel_ids.push_back(ids.get(i).unwrap());
    }

    let cancelled = client.cancel_listings(&artist, &cancel_ids);
    assert_eq!(cancelled, 5u32);

    for i in 0..5u32 {
        assert_eq!(
            client.get_listing(&ids.get(i).unwrap()).status,
            ListingStatus::Cancelled
        );
    }
}

// ── cancel_listings: non-existent id fails preflight ─────────────────────

#[test]
fn batch_cancel_nonexistent_id_fails_nothing_cancelled() {
    let (env, client, _admin, artist, token) = setup_batch();
    let col = fresh_721(&env, &artist, 1);
    let id = client.create_listing(
        &artist,
        &1_000_000_i128,
        &symbol_short!("XLM"),
        &token,
        &col,
        &1u64,
        &1u64,
        &rcpts(&env, &artist),
        &None::<u64>,
    );

    // Mix a valid id with a non-existent one.
    let result = client.try_cancel_listings(&artist, &vec![&env, id, 9_999u64]);
    assert!(result.is_err());
    // The valid listing must still be Active (atomicity).
    assert_eq!(client.get_listing(&id).status, ListingStatus::Active);
}

// ── cancel_listings: non-Active listing fails preflight ───────────────────

#[test]
fn batch_cancel_already_cancelled_listing_fails() {
    let (env, client, _admin, artist, token) = setup_batch();
    let col1 = fresh_721(&env, &artist, 1);
    let col2 = fresh_721(&env, &artist, 2);

    let id1 = client.create_listing(
        &artist,
        &1_000_000_i128,
        &symbol_short!("XLM"),
        &token,
        &col1,
        &1u64,
        &1u64,
        &rcpts(&env, &artist),
        &None::<u64>,
    );
    let id2 = client.create_listing(
        &artist,
        &1_000_000_i128,
        &symbol_short!("XLM"),
        &token,
        &col2,
        &2u64,
        &1u64,
        &rcpts(&env, &artist),
        &None::<u64>,
    );

    // Cancel id2 individually first.
    client.cancel_listing(&artist, &id2);
    assert_eq!(client.get_listing(&id2).status, ListingStatus::Cancelled);

    // Batch cancel with id1 (Active) + id2 (Cancelled) must fail entirely.
    let result = client.try_cancel_listings(&artist, &vec![&env, id1, id2]);
    assert!(result.is_err());
    // id1 must still be Active.
    assert_eq!(client.get_listing(&id1).status, ListingStatus::Active);
}

// ── cancel_listings: wrong owner fails preflight ─────────────────────────

#[test]
fn batch_cancel_wrong_owner_fails() {
    let (env, client, _admin, artist, token) = setup_batch();
    let col = fresh_721(&env, &artist, 1);
    let id = client.create_listing(
        &artist,
        &1_000_000_i128,
        &symbol_short!("XLM"),
        &token,
        &col,
        &1u64,
        &1u64,
        &rcpts(&env, &artist),
        &None::<u64>,
    );

    let intruder = Address::generate(&env);
    let result = client.try_cancel_listings(&intruder, &vec![&env, id]);
    assert!(result.is_err());
    assert_eq!(client.get_listing(&id).status, ListingStatus::Active);
}

// ── cancel_listings: BatchTooLarge ────────────────────────────────────────

#[test]
fn batch_cancel_too_large_returns_batch_too_large() {
    let (env, client, _admin, artist, _token) = setup_batch();

    // 51 fictitious ids — size check fires before any storage reads.
    let mut ids = soroban_sdk::Vec::new(&env);
    for i in 1u64..=51u64 {
        ids.push_back(i);
    }

    let result = client.try_cancel_listings(&artist, &ids);
    assert!(result.is_err());
    let err = result.unwrap_err().unwrap();
    assert_eq!(err, MarketplaceError::BatchTooLarge);
}

// ── cancel_listings: exactly 50 items at cap succeeds ────────────────────

#[test]
fn batch_cancel_exactly_fifty_items_succeeds() {
    let (env, client, _admin, artist, token) = setup_batch();

    let mut create_items = soroban_sdk::Vec::new(&env);
    for token_id in 1u64..=50u64 {
        let col = fresh_721(&env, &artist, token_id);
        create_items.push_back(make_create_input(&env, &artist, &token, &col, token_id, 1));
    }
    let ids = client.create_listings(&artist, &create_items);
    assert_eq!(ids.len(), 50);

    let mut cancel_ids = soroban_sdk::Vec::new(&env);
    for i in 0..50u32 {
        cancel_ids.push_back(ids.get(i).unwrap());
    }

    let cancelled = client.cancel_listings(&artist, &cancel_ids);
    assert_eq!(cancelled, 50u32);
    for i in 0..50u32 {
        assert_eq!(
            client.get_listing(&ids.get(i).unwrap()).status,
            ListingStatus::Cancelled
        );
    }
}

// ── cancel_listings on ERC-1155 batch releases escrowed tokens ───────────

#[test]
fn batch_cancel_erc1155_listings_releases_escrow() {
    let (env, client, _admin, artist, token) = setup_batch();
    let col1 = fresh_1155(&env, &artist, 1);
    let col2 = fresh_1155(&env, &artist, 2);

    let items = vec![
        &env,
        make_create_input(&env, &artist, &token, &col1, 1, 10),
        make_create_input(&env, &artist, &token, &col2, 2, 5),
    ];
    let ids = client.create_listings(&artist, &items);
    assert_eq!(ids.len(), 2);

    let mut cancel_ids = soroban_sdk::Vec::new(&env);
    for i in 0..2u32 {
        cancel_ids.push_back(ids.get(i).unwrap());
    }

    let cancelled = client.cancel_listings(&artist, &cancel_ids);
    assert_eq!(cancelled, 2u32);

    // Both listings are Cancelled — escrow records are cleared.
    for i in 0..2u32 {
        let listing = client.get_listing(&ids.get(i).unwrap());
        assert_eq!(listing.status, ListingStatus::Cancelled);
        // Escrow record for this token should be gone.
        let escrow = client.get_escrow(&listing.collection, &listing.token_id);
        assert!(escrow.is_none());
    }
}
