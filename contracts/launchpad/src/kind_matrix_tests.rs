// kind_matrix_tests.rs — Supported kind values and invalid input coverage
//
// Documents and tests the exact boundary of valid/invalid inputs for all four
// CollectionKind variants. Each test uses preflight_deploy_* (read-only) so
// no WASM files are needed; preflight runs the same validate_* helpers as the
// real deploy.
//
// Kind × input validation matrix:
//
// | Kind        | Shape   | name | symbol | max_supply | royalty_bps | platform_fee_bps |
// |-------------|---------|------|--------|------------|-------------|-----------------|
// | Normal721   | 721     | ≤64  | ≤16    | 1–1e9      | 0–10_000    | 0–2_000         |
// | Normal1155  | 1155    | ≤64  | (none) | (none)     | 0–10_000    | 0–2_000         |
// | LazyMint721 | 721     | ≤64  | ≤16    | 1–1e9      | 0–10_000    | 0–2_000         |
// | LazyMint1155| 1155    | ≤64  | (none) | (none)     | 0–10_000    | 0–2_000         |
//
// Error codes map (launchpad Error enum):
//   EmptyName=12, NameTooLong=18, EmptySymbol=13, SymbolTooLong=19,
//   InvalidMaxSupply=14, MaxSupplyTooLarge=20, InvalidRoyaltyBps=11,
//   InvalidFeeBps=5, DuplicateSalt=10, ContractPaused=6

extern crate std;

use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, String};

use crate::{Launchpad, LaunchpadClient};

// ─── Error code constants ────────────────────────────────────────────────────

const ERR_INVALID_FEE_BPS: u32 = 5;
const ERR_WASM_HASH_NOT_SET: u32 = 4;
const ERR_DUPLICATE_SALT: u32 = 10;
const ERR_INVALID_ROYALTY_BPS: u32 = 11;
const ERR_EMPTY_NAME: u32 = 12;
const ERR_EMPTY_SYMBOL: u32 = 13;
const ERR_INVALID_MAX_SUPPLY: u32 = 14;
const ERR_NAME_TOO_LONG: u32 = 18;
const ERR_SYMBOL_TOO_LONG: u32 = 19;
const ERR_MAX_SUPPLY_TOO_LARGE: u32 = 20;

/// Input-validation error codes — the codes we care about for boundary tests.
/// WasmHashNotSet (#4) is not in this list; it is expected on a fresh factory
/// and does not indicate an invalid input.
const INPUT_VALIDATION_ERRORS: &[u32] = &[
    ERR_EMPTY_NAME,
    ERR_NAME_TOO_LONG,
    ERR_EMPTY_SYMBOL,
    ERR_SYMBOL_TOO_LONG,
    ERR_INVALID_MAX_SUPPLY,
    ERR_MAX_SUPPLY_TOO_LARGE,
    ERR_INVALID_ROYALTY_BPS,
    ERR_INVALID_FEE_BPS,
];

// ─── Setup helper ────────────────────────────────────────────────────────────

/// Registers a Launchpad and calls `initialize`. Does NOT upload any WASMs.
/// preflight_deploy_* works without them: validation runs first, then
/// WasmHashNotSet (#4) is appended when the hash is absent.
fn setup_preflight(env: &Env) -> (LaunchpadClient<'_>, Address) {
    env.mock_all_auths();

    let launchpad_id = env.register(Launchpad, ());
    let client = LaunchpadClient::new(env, &launchpad_id);

    let admin = Address::generate(env);
    let fee_receiver = Address::generate(env);

    client.initialize(&admin, &fee_receiver, &0i128);

    let creator = Address::generate(env);
    (client, creator)
}

/// Returns `true` if `errors` contains `code`.
fn has_error(errors: &soroban_sdk::Vec<u32>, code: u32) -> bool {
    errors.iter().any(|e| e == code)
}

/// Asserts that none of the input-validation error codes are present in `errors`.
/// WasmHashNotSet (#4) may be present and is ignored by this check.
fn assert_no_input_errors(errors: &soroban_sdk::Vec<u32>) {
    for &code in INPUT_VALIDATION_ERRORS {
        assert!(
            !has_error(errors, code),
            "unexpected input-validation error {} in errors: {:?}",
            code,
            errors
        );
    }
}

// ─── Happy-path tests (valid inputs → no input-validation errors) ─────────────
//
// All four of these tests will get WasmHashNotSet (#4) in `errors` because no
// WASM has been registered. That is expected. The assertion is only that none
// of the input-validation codes (12, 13, 14, 18, 19, 20, 11, 5) appear.

#[test]
fn test_kind_normal721_valid_inputs_no_input_errors() {
    let env = Env::default();
    let (client, creator) = setup_preflight(&env);

    let currency = Address::generate(&env);
    let salt = BytesN::from_array(&env, &[1u8; 32]);

    let result = client.preflight_deploy_normal_721(
        &creator,
        &currency,
        &String::from_str(&env, "My Collection"),
        &String::from_str(&env, "MYC"),
        &1_000u64,
        &500u32,
        &0u32,
        &salt,
    );

    assert_no_input_errors(&result.errors);
    // WasmHashNotSet is expected because no WASM was uploaded
    assert!(
        has_error(&result.errors, ERR_WASM_HASH_NOT_SET),
        "expected WasmHashNotSet (#4) on a fresh factory without WASM"
    );
}

#[test]
fn test_kind_normal1155_valid_inputs_no_input_errors() {
    let env = Env::default();
    let (client, creator) = setup_preflight(&env);

    let currency = Address::generate(&env);
    let salt = BytesN::from_array(&env, &[2u8; 32]);

    let result = client.preflight_deploy_normal_1155(
        &creator,
        &currency,
        &String::from_str(&env, "My 1155 Collection"),
        &300u32,
        &0u32,
        &salt,
    );

    assert_no_input_errors(&result.errors);
    assert!(
        has_error(&result.errors, ERR_WASM_HASH_NOT_SET),
        "expected WasmHashNotSet (#4) on a fresh factory without WASM"
    );
}

#[test]
fn test_kind_lazy721_valid_inputs_no_input_errors() {
    let env = Env::default();
    let (client, creator) = setup_preflight(&env);

    let currency = Address::generate(&env);
    let salt = BytesN::from_array(&env, &[3u8; 32]);

    let result = client.preflight_deploy_lazy_721(
        &creator,
        &currency,
        &String::from_str(&env, "Lazy 721 Collection"),
        &String::from_str(&env, "LZ7"),
        &500u64,
        &750u32,
        &0u32,
        &salt,
    );

    assert_no_input_errors(&result.errors);
    assert!(
        has_error(&result.errors, ERR_WASM_HASH_NOT_SET),
        "expected WasmHashNotSet (#4) on a fresh factory without WASM"
    );
}

#[test]
fn test_kind_lazy1155_valid_inputs_no_input_errors() {
    let env = Env::default();
    let (client, creator) = setup_preflight(&env);

    let currency = Address::generate(&env);
    let salt = BytesN::from_array(&env, &[4u8; 32]);

    let result = client.preflight_deploy_lazy_1155(
        &creator,
        &currency,
        &String::from_str(&env, "Lazy 1155 Collection"),
        &200u32,
        &0u32,
        &salt,
    );

    assert_no_input_errors(&result.errors);
    assert!(
        has_error(&result.errors, ERR_WASM_HASH_NOT_SET),
        "expected WasmHashNotSet (#4) on a fresh factory without WASM"
    );
}

// ─── Normal721 invalid-input tests ──────────────────────────────────────────

#[test]
fn test_kind_normal721_empty_name_produces_error_12() {
    let env = Env::default();
    let (client, creator) = setup_preflight(&env);

    let currency = Address::generate(&env);
    let salt = BytesN::from_array(&env, &[10u8; 32]);

    let result = client.preflight_deploy_normal_721(
        &creator,
        &currency,
        &String::from_str(&env, ""), // empty name
        &String::from_str(&env, "SYM"),
        &1_000u64,
        &0u32,
        &0u32,
        &salt,
    );

    assert!(
        has_error(&result.errors, ERR_EMPTY_NAME),
        "expected EmptyName (#12) in errors: {:?}",
        result.errors
    );
}

#[test]
fn test_kind_normal721_name_too_long_produces_error_18() {
    let env = Env::default();
    let (client, creator) = setup_preflight(&env);

    let currency = Address::generate(&env);
    let salt = BytesN::from_array(&env, &[11u8; 32]);

    // 65-character name (one beyond the 64-char limit)
    let long_name = String::from_str(
        &env,
        "AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDDEEEEEEEEEEFFFFF_OVERFLOW!",
    );

    let result = client.preflight_deploy_normal_721(
        &creator,
        &currency,
        &long_name,
        &String::from_str(&env, "SYM"),
        &1_000u64,
        &0u32,
        &0u32,
        &salt,
    );

    assert!(
        has_error(&result.errors, ERR_NAME_TOO_LONG),
        "expected NameTooLong (#18) in errors: {:?}",
        result.errors
    );
}

#[test]
fn test_kind_normal721_empty_symbol_produces_error_13() {
    let env = Env::default();
    let (client, creator) = setup_preflight(&env);

    let currency = Address::generate(&env);
    let salt = BytesN::from_array(&env, &[12u8; 32]);

    let result = client.preflight_deploy_normal_721(
        &creator,
        &currency,
        &String::from_str(&env, "My Collection"),
        &String::from_str(&env, ""), // empty symbol
        &1_000u64,
        &0u32,
        &0u32,
        &salt,
    );

    assert!(
        has_error(&result.errors, ERR_EMPTY_SYMBOL),
        "expected EmptySymbol (#13) in errors: {:?}",
        result.errors
    );
}

#[test]
fn test_kind_normal721_symbol_too_long_produces_error_19() {
    let env = Env::default();
    let (client, creator) = setup_preflight(&env);

    let currency = Address::generate(&env);
    let salt = BytesN::from_array(&env, &[13u8; 32]);

    // 17-character symbol (one beyond the 16-char limit)
    let long_symbol = String::from_str(&env, "TOOLONGSYMBOLXYZ1");

    let result = client.preflight_deploy_normal_721(
        &creator,
        &currency,
        &String::from_str(&env, "My Collection"),
        &long_symbol,
        &1_000u64,
        &0u32,
        &0u32,
        &salt,
    );

    assert!(
        has_error(&result.errors, ERR_SYMBOL_TOO_LONG),
        "expected SymbolTooLong (#19) in errors: {:?}",
        result.errors
    );
}

#[test]
fn test_kind_normal721_zero_max_supply_produces_error_14() {
    let env = Env::default();
    let (client, creator) = setup_preflight(&env);

    let currency = Address::generate(&env);
    let salt = BytesN::from_array(&env, &[14u8; 32]);

    let result = client.preflight_deploy_normal_721(
        &creator,
        &currency,
        &String::from_str(&env, "My Collection"),
        &String::from_str(&env, "MYC"),
        &0u64, // zero max_supply
        &0u32,
        &0u32,
        &salt,
    );

    assert!(
        has_error(&result.errors, ERR_INVALID_MAX_SUPPLY),
        "expected InvalidMaxSupply (#14) in errors: {:?}",
        result.errors
    );
}

#[test]
fn test_kind_normal721_max_supply_too_large_produces_error_20() {
    let env = Env::default();
    let (client, creator) = setup_preflight(&env);

    let currency = Address::generate(&env);
    let salt = BytesN::from_array(&env, &[15u8; 32]);

    let result = client.preflight_deploy_normal_721(
        &creator,
        &currency,
        &String::from_str(&env, "My Collection"),
        &String::from_str(&env, "MYC"),
        &1_000_000_001u64, // one above the 1,000,000,000 cap
        &0u32,
        &0u32,
        &salt,
    );

    assert!(
        has_error(&result.errors, ERR_MAX_SUPPLY_TOO_LARGE),
        "expected MaxSupplyTooLarge (#20) in errors: {:?}",
        result.errors
    );
}

#[test]
fn test_kind_normal721_royalty_too_high_produces_error_11() {
    let env = Env::default();
    let (client, creator) = setup_preflight(&env);

    let currency = Address::generate(&env);
    let salt = BytesN::from_array(&env, &[16u8; 32]);

    let result = client.preflight_deploy_normal_721(
        &creator,
        &currency,
        &String::from_str(&env, "My Collection"),
        &String::from_str(&env, "MYC"),
        &1_000u64,
        &10_001u32, // one above MAX_ROYALTY_BPS (10_000)
        &0u32,
        &salt,
    );

    assert!(
        has_error(&result.errors, ERR_INVALID_ROYALTY_BPS),
        "expected InvalidRoyaltyBps (#11) in errors: {:?}",
        result.errors
    );
}

#[test]
fn test_kind_normal721_fee_too_high_produces_error_5() {
    let env = Env::default();
    let (client, creator) = setup_preflight(&env);

    let currency = Address::generate(&env);
    let salt = BytesN::from_array(&env, &[17u8; 32]);

    let result = client.preflight_deploy_normal_721(
        &creator,
        &currency,
        &String::from_str(&env, "My Collection"),
        &String::from_str(&env, "MYC"),
        &1_000u64,
        &0u32,
        &2_001u32, // one above MAX_FEE_BPS (2_000)
        &salt,
    );

    assert!(
        has_error(&result.errors, ERR_INVALID_FEE_BPS),
        "expected InvalidFeeBps (#5) in errors: {:?}",
        result.errors
    );
}

// ─── Normal1155 invalid-input tests ─────────────────────────────────────────

#[test]
fn test_kind_normal1155_empty_name_produces_error_12() {
    let env = Env::default();
    let (client, creator) = setup_preflight(&env);

    let currency = Address::generate(&env);
    let salt = BytesN::from_array(&env, &[20u8; 32]);

    let result = client.preflight_deploy_normal_1155(
        &creator,
        &currency,
        &String::from_str(&env, ""), // empty name
        &0u32,
        &0u32,
        &salt,
    );

    assert!(
        has_error(&result.errors, ERR_EMPTY_NAME),
        "expected EmptyName (#12) in errors: {:?}",
        result.errors
    );
}

#[test]
fn test_kind_normal1155_royalty_too_high_produces_error_11() {
    let env = Env::default();
    let (client, creator) = setup_preflight(&env);

    let currency = Address::generate(&env);
    let salt = BytesN::from_array(&env, &[21u8; 32]);

    let result = client.preflight_deploy_normal_1155(
        &creator,
        &currency,
        &String::from_str(&env, "My 1155"),
        &10_001u32, // one above MAX_ROYALTY_BPS (10_000)
        &0u32,
        &salt,
    );

    assert!(
        has_error(&result.errors, ERR_INVALID_ROYALTY_BPS),
        "expected InvalidRoyaltyBps (#11) in errors: {:?}",
        result.errors
    );
}

// ─── LazyMint721 invalid-input tests ────────────────────────────────────────

#[test]
fn test_kind_lazy721_empty_name_produces_error_12() {
    let env = Env::default();
    let (client, creator) = setup_preflight(&env);

    let currency = Address::generate(&env);
    let salt = BytesN::from_array(&env, &[30u8; 32]);

    let result = client.preflight_deploy_lazy_721(
        &creator,
        &currency,
        &String::from_str(&env, ""), // empty name
        &String::from_str(&env, "LZ7"),
        &1_000u64,
        &0u32,
        &0u32,
        &salt,
    );

    assert!(
        has_error(&result.errors, ERR_EMPTY_NAME),
        "expected EmptyName (#12) in errors: {:?}",
        result.errors
    );
}

// ─── LazyMint1155 invalid-input tests ───────────────────────────────────────

#[test]
fn test_kind_lazy1155_empty_name_produces_error_12() {
    let env = Env::default();
    let (client, creator) = setup_preflight(&env);

    let currency = Address::generate(&env);
    let salt = BytesN::from_array(&env, &[40u8; 32]);

    let result = client.preflight_deploy_lazy_1155(
        &creator,
        &currency,
        &String::from_str(&env, ""), // empty name
        &0u32,
        &0u32,
        &salt,
    );

    assert!(
        has_error(&result.errors, ERR_EMPTY_NAME),
        "expected EmptyName (#12) in errors: {:?}",
        result.errors
    );
}

// ─── DuplicateSalt test (requires compiled WASMs) ───────────────────────────

#[test]
#[ignore = "requires compiled WASMs; run with cargo test -- --ignored"]
fn test_kind_duplicate_salt_produces_error_10() {
    // This test must call deploy_normal_721 with a real WASM to record the salt,
    // then call preflight_deploy_normal_721 with the same (creator, salt) to
    // confirm DuplicateSalt (#10) is returned.
    //
    // Without WASM files the first deploy panics before the salt can be stored,
    // so there is nothing to collide against. Build all four collection WASMs
    // first:
    //   cargo build --target wasm32v1-none --release \
    //     -p collection-nft-erc721 -p collection-nft-erc1155 \
    //     -p lazy-mint-erc721 -p lazy-mint-erc1155
    // Then run:
    //   cargo test -p launchpad test_kind_duplicate_salt -- --ignored
    //
    // The body below is intentionally left unimplemented so that running with
    // --ignored will report "test ignored" rather than silently passing.
    unimplemented!("see test comment: build WASMs first, then run with cargo test -- --ignored");
    // Expected assertion once WASM is available:
    //   let result = client.preflight_deploy_normal_721(&creator, &currency,
    //       &name, &symbol, &max_supply, &royalty_bps, &platform_fee_bps, &salt);
    //   assert!(has_error(&result.errors, ERR_DUPLICATE_SALT));
    #[allow(unreachable_code)]
    let _ = ERR_DUPLICATE_SALT; // keep the constant reachable for the linter
}
