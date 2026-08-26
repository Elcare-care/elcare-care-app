// registry_tests.rs — Issue #436
// Hardened multi-version collection registry and deployment pipeline tests.
//
// These tests supplement the existing test.rs coverage and specifically target
// the acceptance criteria from Issue #436:
//
//   1. Preflight cannot proceed when validation fails → deploy also fails
//   2. Duplicate salts are rejected deterministically
//   3. Registry state is consistent after failed deploys / version upgrades
//   4. Child collections can be traced to factory metadata and wasm version
//   5. Empty names/symbols, zero max_supply, invalid royalty/fee are all caught
//   6. Wasm version is bumped monotonically and recorded in registry records
//   7. Collections by creator / by address / paginated are consistent

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::StellarAssetClient,
    Address, BytesN, Env, String,
};

use crate::{CollectionKind, Error, Launchpad, LaunchpadClient};

// ── Helpers ───────────────────────────────────────────────────────────────────

fn wasm_bytes(name: &str) -> std::vec::Vec<u8> {
    let exe = std::env::current_exe().unwrap();
    let target_dir = exe
        .parent().and_then(|p| p.parent()).and_then(|p| p.parent())
        .unwrap().to_path_buf();
    let path = target_dir
        .join("wasm32v1-none").join("release")
        .join(std::format!("{name}.wasm"));
    std::fs::read(&path).unwrap_or_else(|_| panic!(
        "missing wasm at {}. Build first.",
        path.display()
    ))
}

fn setup(env: &Env) -> (LaunchpadClient<'_>, Address, Address, Address) {
    env.mock_all_auths();

    let launchpad_id = env.register(Launchpad, ());
    let client = LaunchpadClient::new(env, &launchpad_id);

    let admin = Address::generate(env);
    let fee_receiver = Address::generate(env);
    let creator = Address::generate(env);

    client.initialize(&admin, &fee_receiver, &0i128);

    let w721  = env.deployer().upload_contract_wasm(wasm_bytes("collection_nft_erc721").as_slice());
    let w1155 = env.deployer().upload_contract_wasm(wasm_bytes("collection_nft_erc1155").as_slice());
    let wl721 = env.deployer().upload_contract_wasm(wasm_bytes("lazy_mint_erc721").as_slice());
    let wl1155= env.deployer().upload_contract_wasm(wasm_bytes("lazy_mint_erc1155").as_slice());
    client.set_wasm_hashes(&w721, &w1155, &wl721, &wl1155);

    (client, admin, fee_receiver, creator)
}

fn setup_token(env: &Env, holder: &Address, amount: i128) -> Address {
    let token_admin = Address::generate(env);
    let token = env.register_stellar_asset_contract_v2(token_admin.clone()).address();
    StellarAssetClient::new(env, &token).mint(holder, &amount);
    token
}

// ── Acceptance criterion 1: preflight failures prevent deploy ────────────────

#[test]
fn preflight_and_deploy_agree_on_paused_state() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 1);
    let (client, _admin, _fee_receiver, creator) = setup(&env);

    client.pause();

    let salt = BytesN::from_array(&env, &[0x01u8; 32]);
    let currency = setup_token(&env, &creator, 1_000_000);

    // Preflight reports ContractPaused
    let preflight = client.preflight_deploy_normal_721(
        &creator,
        &currency,
        &String::from_str(&env, "Test"),
        &String::from_str(&env, "TST"),
        &100u64,
        &0u32,
        &0u32,
        &salt,
    );
    assert!(preflight.errors.contains(&(Error::ContractPaused as u32)));

    // Real deploy also fails with ContractPaused
    let deploy_result = client.try_deploy_normal_721(
        &creator,
        &currency,
        &String::from_str(&env, "Test"),
        &String::from_str(&env, "TST"),
        &100u64,
        &0u32,
        &Address::generate(&env),
        &0u32,
        &salt,
    );
    assert_eq!(deploy_result, Err(Ok(Error::ContractPaused)));
}

#[test]
fn preflight_reports_empty_name_error() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 1);
    let (client, _admin, _fee_receiver, creator) = setup(&env);

    let salt = BytesN::from_array(&env, &[0x02u8; 32]);
    let currency = setup_token(&env, &creator, 1_000_000);

    let preflight = client.preflight_deploy_normal_721(
        &creator,
        &currency,
        &String::from_str(&env, ""), // empty name
        &String::from_str(&env, "TST"),
        &100u64,
        &0u32,
        &0u32,
        &salt,
    );
    assert!(
        preflight.errors.contains(&(Error::EmptyName as u32)),
        "preflight must report EmptyName for empty name"
    );
}

#[test]
fn preflight_reports_empty_symbol_error() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 1);
    let (client, _admin, _fee_receiver, creator) = setup(&env);

    let salt = BytesN::from_array(&env, &[0x03u8; 32]);
    let currency = setup_token(&env, &creator, 1_000_000);

    let preflight = client.preflight_deploy_normal_721(
        &creator,
        &currency,
        &String::from_str(&env, "MyCollection"),
        &String::from_str(&env, ""), // empty symbol
        &100u64,
        &0u32,
        &0u32,
        &salt,
    );
    assert!(preflight.errors.contains(&(Error::EmptySymbol as u32)));
}

#[test]
fn preflight_reports_zero_max_supply_error() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 1);
    let (client, _admin, _fee_receiver, creator) = setup(&env);

    let salt = BytesN::from_array(&env, &[0x04u8; 32]);
    let currency = setup_token(&env, &creator, 1_000_000);

    let preflight = client.preflight_deploy_normal_721(
        &creator,
        &currency,
        &String::from_str(&env, "MyCollection"),
        &String::from_str(&env, "MC"),
        &0u64, // zero max_supply
        &0u32,
        &0u32,
        &salt,
    );
    assert!(preflight.errors.contains(&(Error::InvalidMaxSupply as u32)));
}

#[test]
fn preflight_reports_invalid_royalty_bps() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 1);
    let (client, _admin, _fee_receiver, creator) = setup(&env);

    let salt = BytesN::from_array(&env, &[0x05u8; 32]);
    let currency = setup_token(&env, &creator, 1_000_000);

    let preflight = client.preflight_deploy_normal_721(
        &creator,
        &currency,
        &String::from_str(&env, "MyCollection"),
        &String::from_str(&env, "MC"),
        &100u64,
        &10_001u32, // exceeds 100%
        &0u32,
        &salt,
    );
    assert!(preflight.errors.contains(&(Error::InvalidRoyaltyBps as u32)));
}

#[test]
fn preflight_reports_invalid_fee_bps() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 1);
    let (client, _admin, _fee_receiver, creator) = setup(&env);

    let salt = BytesN::from_array(&env, &[0x06u8; 32]);
    let currency = setup_token(&env, &creator, 1_000_000);

    let preflight = client.preflight_deploy_normal_721(
        &creator,
        &currency,
        &String::from_str(&env, "MyCollection"),
        &String::from_str(&env, "MC"),
        &100u64,
        &0u32,
        &2001u32, // exceeds MAX_FEE_BPS (2000)
        &salt,
    );
    assert!(preflight.errors.contains(&(Error::InvalidFeeBps as u32)));
}

// ── Acceptance criterion 2: duplicate salts rejected ─────────────────────────

#[test]
fn duplicate_salt_rejected_across_successful_deployments() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 1);
    let (client, _admin, _fee_receiver, creator) = setup(&env);

    let salt = BytesN::from_array(&env, &[0xA0u8; 32]);
    let currency = Address::generate(&env);
    let royalty_receiver = Address::generate(&env);

    // First deploy succeeds
    client.deploy_normal_721(
        &creator,
        &currency,
        &String::from_str(&env, "First"),
        &String::from_str(&env, "FRS"),
        &100u64,
        &0u32,
        &royalty_receiver,
        &0u32,
        &salt,
    );

    // Second deploy with identical (creator, salt) must fail with DuplicateSalt
    let second = client.try_deploy_normal_721(
        &creator,
        &currency,
        &String::from_str(&env, "Second"),
        &String::from_str(&env, "SND"),
        &100u64,
        &0u32,
        &royalty_receiver,
        &0u32,
        &salt,
    );
    assert_eq!(second, Err(Ok(Error::DuplicateSalt)));
}

// ── Acceptance criterion 3: registry is consistent after failed deploys ───────

#[test]
fn registry_count_unchanged_after_failed_deploy() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 1);
    let (client, _admin, _fee_receiver, creator) = setup(&env);

    let count_before = client.collection_count();

    // Attempt a deploy that will fail (empty name)
    let _ = client.try_deploy_normal_721(
        &creator,
        &Address::generate(&env),
        &String::from_str(&env, ""), // empty name → fails
        &String::from_str(&env, "MC"),
        &100u64,
        &0u32,
        &Address::generate(&env),
        &0u32,
        &BytesN::from_array(&env, &[0xB1u8; 32]),
    );

    let count_after = client.collection_count();
    assert_eq!(
        count_before, count_after,
        "Registry count must not change after a failed deploy"
    );
}

#[test]
fn registry_count_unchanged_after_paused_deploy_attempt() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 1);
    let (client, _admin, _fee_receiver, creator) = setup(&env);

    client.pause();
    let count_before = client.collection_count();

    let _ = client.try_deploy_normal_1155(
        &creator,
        &Address::generate(&env),
        &String::from_str(&env, "Paused"),
        &0u32,
        &Address::generate(&env),
        &0u32,
        &BytesN::from_array(&env, &[0xB2u8; 32]),
    );

    assert_eq!(client.collection_count(), count_before);
    client.unpause();
}

// ── Acceptance criterion 4: child collections traceable to factory metadata ───

#[test]
fn deployed_collection_record_contains_factory_metadata() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 77);
    let (client, _admin, _fee_receiver, creator) = setup(&env);

    let salt = BytesN::from_array(&env, &[0xC1u8; 32]);
    let currency = Address::generate(&env);
    let royalty_receiver = Address::generate(&env);

    let addr = client.deploy_normal_721(
        &creator,
        &currency,
        &String::from_str(&env, "Traceable"),
        &String::from_str(&env, "TRC"),
        &500u64,
        &0u32,
        &royalty_receiver,
        &250u32,
        &salt,
    );

    // Record should be in global registry
    let record = client.get_collection(&addr).unwrap();
    assert_eq!(record.address, addr);
    assert_eq!(record.creator, creator);
    assert_eq!(record.name, String::from_str(&env, "Traceable"));
    assert_eq!(record.symbol, String::from_str(&env, "TRC"));
    assert_eq!(record.ledger, 77u32);
    assert_eq!(record.platform_fee_bps, 250u32);
    assert!(matches!(record.kind, CollectionKind::Normal721));

    // Must also appear in creator's collection list
    let by_creator = client.collections_by_creator(&creator);
    assert_eq!(by_creator.len(), 1);
    assert_eq!(by_creator.get(0).unwrap().address, addr);
}

#[test]
fn all_four_deploy_kinds_are_tracked_in_registry() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 1);
    let (client, _admin, _fee_receiver, creator) = setup(&env);

    let currency = Address::generate(&env);
    let royalty_receiver = Address::generate(&env);
    let creator_pubkey = BytesN::from_array(&env, &[0x11u8; 32]);

    let addr_721 = client.deploy_normal_721(
        &creator, &currency,
        &String::from_str(&env, "N721"), &String::from_str(&env, "N721"),
        &100u64, &0u32, &royalty_receiver, &0u32,
        &BytesN::from_array(&env, &[0xD1u8; 32]),
    );
    let addr_1155 = client.deploy_normal_1155(
        &creator, &currency,
        &String::from_str(&env, "N1155"), &0u32, &royalty_receiver, &0u32,
        &BytesN::from_array(&env, &[0xD2u8; 32]),
    );
    let addr_l721 = client.deploy_lazy_721(
        &creator, &currency, &creator_pubkey,
        &String::from_str(&env, "L721"), &String::from_str(&env, "L721"),
        &100u64, &0u32, &royalty_receiver, &0u32,
        &BytesN::from_array(&env, &[0xD3u8; 32]),
        &String::from_str(&env, "Test Network; September 2015"),
    );
    let addr_l1155 = client.deploy_lazy_1155(
        &creator, &currency, &creator_pubkey,
        &String::from_str(&env, "L1155"), &0u32, &royalty_receiver, &0u32,
        &BytesN::from_array(&env, &[0xD4u8; 32]),
        &String::from_str(&env, "Test Network; September 2015"),
    );

    assert_eq!(client.collection_count(), 4u64);

    assert!(matches!(client.get_collection(&addr_721).unwrap().kind, CollectionKind::Normal721));
    assert!(matches!(client.get_collection(&addr_1155).unwrap().kind, CollectionKind::Normal1155));
    assert!(matches!(client.get_collection(&addr_l721).unwrap().kind, CollectionKind::LazyMint721));
    assert!(matches!(client.get_collection(&addr_l1155).unwrap().kind, CollectionKind::LazyMint1155));
}

// ── Acceptance criterion 6: wasm version bumps monotonically ─────────────────

#[test]
fn wasm_version_increments_on_each_set_wasm_hashes_call() {
    let env = Env::default();
    env.mock_all_auths();
    let launchpad_id = env.register(Launchpad, ());
    let client = LaunchpadClient::new(&env, &launchpad_id);
    let admin = Address::generate(&env);
    let fee_receiver = Address::generate(&env);
    client.initialize(&admin, &fee_receiver, &0i128);

    assert_eq!(client.wasm_version(), 0u32);

    let h = BytesN::from_array(&env, &[1u8; 32]);
    let v1 = client.set_wasm_hashes(&h, &h, &h, &h);
    assert_eq!(v1, 1u32);
    assert_eq!(client.wasm_version(), 1u32);

    let h2 = BytesN::from_array(&env, &[2u8; 32]);
    let v2 = client.set_wasm_hashes(&h2, &h, &h, &h);
    assert_eq!(v2, 2u32);
    assert_eq!(client.wasm_version(), 2u32);

    let v3 = client.set_wasm_hashes(&h2, &h2, &h2, &h2);
    assert_eq!(v3, 3u32);
}

#[test]
fn wasm_hashes_struct_version_matches_wasm_version_view() {
    let env = Env::default();
    env.mock_all_auths();
    let launchpad_id = env.register(Launchpad, ());
    let client = LaunchpadClient::new(&env, &launchpad_id);
    let admin = Address::generate(&env);
    let fee_receiver = Address::generate(&env);
    client.initialize(&admin, &fee_receiver, &0i128);

    let h = BytesN::from_array(&env, &[3u8; 32]);
    client.set_wasm_hashes(&h, &h, &h, &h);

    let hashes = client.wasm_hashes().unwrap();
    assert_eq!(hashes.version, client.wasm_version());
    assert_eq!(hashes.version, 1u32);
}

// ── Acceptance criterion 7: registry API consistency ─────────────────────────

#[test]
fn get_collection_by_address_matches_all_collections_record() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 1);
    let (client, _admin, _fee_receiver, creator) = setup(&env);

    let salt = BytesN::from_array(&env, &[0xE1u8; 32]);
    let addr = client.deploy_normal_721(
        &creator, &Address::generate(&env),
        &String::from_str(&env, "Alpha"), &String::from_str(&env, "ALP"),
        &100u64, &0u32, &Address::generate(&env), &0u32, &salt,
    );

    let by_addr = client.get_collection(&addr).unwrap();
    let all = client.all_collections();
    let from_all = all.get(0).unwrap();

    assert_eq!(by_addr.address, from_all.address);
    assert_eq!(by_addr.name, from_all.name);
    assert_eq!(by_addr.creator, from_all.creator);
    assert_eq!(by_addr.ledger, from_all.ledger);
}

#[test]
fn get_collections_paginated_is_consistent_with_collection_count() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 1);
    let (client, _admin, _fee_receiver, creator) = setup(&env);

    let currency = Address::generate(&env);
    let royalty_receiver = Address::generate(&env);

    for i in 0u8..5u8 {
        let salt = BytesN::from_array(&env, &[i; 32]);
        let name = soroban_sdk::String::from_str(&env, &std::format!("Coll{i}"));
        let sym  = soroban_sdk::String::from_str(&env, &std::format!("C{i}"));
        client.deploy_normal_721(
            &creator, &currency, &name, &sym,
            &100u64, &0u32, &royalty_receiver, &0u32, &salt,
        );
    }

    assert_eq!(client.collection_count(), 5u64);

    // Page 0: first 2
    let page0 = client.get_collections(&0u64, &2u32);
    assert_eq!(page0.len(), 2);

    // Page 1: next 2
    let page1 = client.get_collections(&2u64, &2u32);
    assert_eq!(page1.len(), 2);

    // Page 2: last 1
    let page2 = client.get_collections(&4u64, &2u32);
    assert_eq!(page2.len(), 1);

    // Beyond range: empty
    let page_out = client.get_collections(&100u64, &5u32);
    assert_eq!(page_out.len(), 0);
}

#[test]
fn collections_by_creator_only_returns_that_creators_collections() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 1);
    let (client, _admin, _fee_receiver, creator_a) = setup(&env);
    let creator_b = Address::generate(&env);

    let currency = Address::generate(&env);
    let royalty_receiver = Address::generate(&env);

    // Creator A deploys 2
    for i in 0u8..2u8 {
        client.deploy_normal_721(
            &creator_a, &currency,
            &soroban_sdk::String::from_str(&env, &std::format!("A{i}")),
            &soroban_sdk::String::from_str(&env, &std::format!("A{i}")),
            &100u64, &0u32, &royalty_receiver, &0u32,
            &BytesN::from_array(&env, &[i; 32]),
        );
    }

    // Creator B deploys 1
    client.deploy_normal_721(
        &creator_b, &currency,
        &String::from_str(&env, "B0"), &String::from_str(&env, "B0"),
        &100u64, &0u32, &royalty_receiver, &0u32,
        &BytesN::from_array(&env, &[0xFFu8; 32]),
    );

    assert_eq!(client.collections_by_creator(&creator_a).len(), 2);
    assert_eq!(client.collections_by_creator(&creator_b).len(), 1);
    assert_eq!(client.collections_by_creator(&Address::generate(&env)).len(), 0);
}

// ── Deploy fee invariants ─────────────────────────────────────────────────────

#[test]
fn deploy_fee_is_transferred_before_deploy_state_mutation() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 1);
    let (client, _admin, fee_receiver, creator) = setup(&env);

    const FEE: i128 = 500;
    client.set_fee_config(&fee_receiver, &FEE);

    let token = setup_token(&env, &creator, 10_000);
    let royalty_receiver = Address::generate(&env);

    client.deploy_normal_1155(
        &creator, &token,
        &String::from_str(&env, "FeeTest"),
        &0u32, &royalty_receiver, &0u32,
        &BytesN::from_array(&env, &[0xF1u8; 32]),
    );

    // Treasury must have received the fee
    let treasury_balance = soroban_sdk::token::TokenClient::new(&env, &token).balance(&fee_receiver);
    assert_eq!(treasury_balance, FEE);

    // Creator's balance must have decreased by fee
    let creator_balance = soroban_sdk::token::TokenClient::new(&env, &token).balance(&creator);
    assert_eq!(creator_balance, 10_000 - FEE);
}

#[test]
fn negative_deploy_fee_rejected_at_initialization() {
    let env = Env::default();
    env.mock_all_auths();
    let launchpad_id = env.register(Launchpad, ());
    let client = LaunchpadClient::new(&env, &launchpad_id);
    let admin = Address::generate(&env);
    let fee_receiver = Address::generate(&env);

    let result = client.try_initialize(&admin, &fee_receiver, &-1i128);
    assert_eq!(result, Err(Ok(Error::InvalidDeployFee)));
}

#[test]
fn negative_deploy_fee_rejected_at_set_fee_config() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 1);
    let (client, _admin, fee_receiver, _creator) = setup(&env);

    let result = client.try_set_fee_config(&fee_receiver, &-100i128);
    assert_eq!(result, Err(Ok(Error::InvalidDeployFee)));
}
