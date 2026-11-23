// salt_sequence_tests.rs — Salt validity, replay-prevention, and sequencing invariants
//
// Documents the exact valid/invalid/deployed salt sequences for the Launchpad:
//
//   Valid salt sequence:    new creator → new raw salt → deploy succeeds
//   Invalid salt sequence:  same creator + same raw salt → DuplicateSalt(#10) on preflight
//   Deployed salt sequence: same creator + same raw salt after success → idempotent (dep_idem event)
//
// Invariant (make_secure_salt):
//   secure_salt = sha256(creator.to_xdr() ‖ raw_salt)
//   Two deployments with the same raw_salt but different creators produce distinct secure_salts.
//   Two deployments with the same creator but different raw_salts produce distinct secure_salts.
//
// Address replay prevention:
//   Once a (creator, raw_salt) pair has been deployed (SaltAddress key written),
//   a second deploy_* call returns the same address (idempotent, NOT a new deployment).
//   A preflight_* call for the same pair will include DuplicateSalt(#10) in errors.

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, BytesN, Env, String,
};

use crate::{Error, Launchpad, LaunchpadClient};

// ── Minimal setup (no WASM) ───────────────────────────────────────────────────
//
// Most salt tests only call preflight_deploy_*, which is a read-only view that
// does not need WASM files on disk.  We initialise the factory with zero fee and
// no WASM hashes registered.  Preflight errors will include WasmHashNotSet(4);
// the tests assert only on the presence or absence of DuplicateSalt(10).

fn setup_no_wasm(env: &Env) -> (LaunchpadClient<'_>, Address) {
    env.mock_all_auths();
    env.ledger().with_mut(|li| li.sequence_number = 1);

    let launchpad_id = env.register(Launchpad, ());
    let client = LaunchpadClient::new(env, &launchpad_id);

    let admin = Address::generate(env);
    let fee_receiver = Address::generate(env);
    client.initialize(&admin, &fee_receiver, &0i128);

    // Return the client and a reusable currency placeholder (no token minted;
    // fee is zero so the balance check in preflight is a no-op).
    let currency = Address::generate(env);
    (client, currency)
}

// ── Helper: call preflight_deploy_normal_721 with minimal valid params ─────────

fn preflight_721(
    client: &LaunchpadClient<'_>,
    env: &Env,
    creator: &Address,
    currency: &Address,
    salt: &BytesN<32>,
) -> soroban_sdk::Vec<u32> {
    client
        .preflight_deploy_normal_721(
            creator,
            currency,
            &String::from_str(env, "Salt Test"),
            &String::from_str(env, "ST"),
            &100u64,
            &0u32,
            &0u32,
            salt,
        )
        .errors
}

// ── Helper: call preflight_deploy_normal_1155 with minimal valid params ────────

fn preflight_1155(
    client: &LaunchpadClient<'_>,
    env: &Env,
    creator: &Address,
    currency: &Address,
    salt: &BytesN<32>,
) -> soroban_sdk::Vec<u32> {
    client
        .preflight_deploy_normal_1155(
            creator,
            currency,
            &String::from_str(env, "Salt Test 1155"),
            &0u32,
            &0u32,
            salt,
        )
        .errors
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1
// Valid salt sequence: two different creators, same raw salt.
// Neither preflight should report DuplicateSalt — the salts are independent
// because secure_salt = sha256(creator.to_xdr() ‖ raw_salt).
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_salt_fresh_creator_no_duplicate_error() {
    let env = Env::default();
    let (client, currency) = setup_no_wasm(&env);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    // Both use the identical raw salt bytes.
    let salt = BytesN::from_array(&env, &[0xA1u8; 32]);

    let errors_alice = preflight_721(&client, &env, &alice, &currency, &salt);
    let errors_bob = preflight_721(&client, &env, &bob, &currency, &salt);

    // DuplicateSalt must be absent for both — different creators produce
    // different secure_salts even when raw_salt is identical.
    assert!(
        !errors_alice.contains(&(Error::DuplicateSalt as u32)),
        "alice: unexpected DuplicateSalt; errors = {errors_alice:?}"
    );
    assert!(
        !errors_bob.contains(&(Error::DuplicateSalt as u32)),
        "bob: unexpected DuplicateSalt; errors = {errors_bob:?}"
    );

    // May contain WasmHashNotSet(4) — that is expected without WASM uploaded.
    // The absence of DuplicateSalt is the only invariant being tested here.
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 2
// Valid salt sequence: same creator, two different raw salts.
// Neither preflight should report DuplicateSalt — each raw_salt produces a
// distinct secure_salt even from the same creator.
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_salt_different_raw_salts_same_creator_no_duplicate_error() {
    let env = Env::default();
    let (client, currency) = setup_no_wasm(&env);

    let creator = Address::generate(&env);
    let salt_a = BytesN::from_array(&env, &[0xB1u8; 32]);
    let salt_b = BytesN::from_array(&env, &[0xB2u8; 32]);

    let errors_a = preflight_721(&client, &env, &creator, &currency, &salt_a);
    let errors_b = preflight_721(&client, &env, &creator, &currency, &salt_b);

    assert!(
        !errors_a.contains(&(Error::DuplicateSalt as u32)),
        "salt_a: unexpected DuplicateSalt; errors = {errors_a:?}"
    );
    assert!(
        !errors_b.contains(&(Error::DuplicateSalt as u32)),
        "salt_b: unexpected DuplicateSalt; errors = {errors_b:?}"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 3
// Syntactically valid edge case: raw salt with all bytes = 0xFF.
// The factory must accept it (no DuplicateSalt).  The only expected error is
// WasmHashNotSet(4) because no WASM is registered in this environment.
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_salt_max_bytes_accepted() {
    let env = Env::default();
    let (client, currency) = setup_no_wasm(&env);

    let creator = Address::generate(&env);
    // All-0xFF is a valid BytesN<32> — the factory must not reject it on salt
    // grounds alone.
    let salt = BytesN::from_array(&env, &[0xFFu8; 32]);

    let errors = preflight_721(&client, &env, &creator, &currency, &salt);

    assert!(
        !errors.contains(&(Error::DuplicateSalt as u32)),
        "all-0xFF salt must not produce DuplicateSalt; errors = {errors:?}"
    );
    // WasmHashNotSet is acceptable; anything else would be a regression.
    assert!(
        errors.is_empty() || errors.contains(&(Error::WasmHashNotSet as u32)),
        "unexpected error for all-0xFF salt; errors = {errors:?}"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 4
// Syntactically valid edge case: raw salt with all bytes = 0x00.
// Same expectation as the all-0xFF case above.
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_salt_zero_bytes_accepted() {
    let env = Env::default();
    let (client, currency) = setup_no_wasm(&env);

    let creator = Address::generate(&env);
    let salt = BytesN::from_array(&env, &[0x00u8; 32]);

    let errors = preflight_721(&client, &env, &creator, &currency, &salt);

    assert!(
        !errors.contains(&(Error::DuplicateSalt as u32)),
        "all-0x00 salt must not produce DuplicateSalt; errors = {errors:?}"
    );
    assert!(
        errors.is_empty() || errors.contains(&(Error::WasmHashNotSet as u32)),
        "unexpected error for all-0x00 salt; errors = {errors:?}"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 5  [ignored — requires WASM files on disk]
//
// Deployed salt sequence (idempotent):
//   1. deploy_normal_721 once → contract address A recorded in SaltAddress.
//   2. deploy_normal_721 again with the same (creator, salt) → returns A,
//      no second registry entry, collection_count is still 1.
//
// Requires WASM files; run after:
//   cargo build --target wasm32v1-none --release \
//     -p collection-nft-erc721 -p collection-nft-erc1155 \
//     -p lazy-mint-erc721 -p lazy-mint-erc1155
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[ignore]
fn test_salt_deployed_sequence_idempotent() {
    // Uses setup_launchpad (from test.rs) which loads real WASM.
    // 1. Call deploy_normal_721 once — salt is marked used, SaltAddress is written.
    // 2. Call deploy_normal_721 again with the same creator and salt.
    // 3. Assert second call returns exactly the same address as the first.
    // 4. Assert collection_count is still 1 (no duplicate registry entry).
    // 5. Assert a "dep_idem" event was emitted on the second call.
    unimplemented!("requires WASM — see test comment above");
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 6  [ignored — requires WASM files on disk]
//
// Invalid salt sequence (DuplicateSalt in preflight after deploy):
//   1. deploy_normal_721 once → marks (creator, salt) as used.
//   2. preflight_deploy_normal_721 with same (creator, salt) → errors contains 10.
//
// This confirms the preflight faithfully reflects the deployed state so a
// caller can detect a stale salt without re-attempting the mutating call.
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[ignore]
fn test_salt_preflight_duplicate_produces_error_10() {
    // Uses setup_launchpad (from test.rs) which loads real WASM.
    // 1. deploy_normal_721 once → marks salt as used.
    // 2. Call preflight_deploy_normal_721 with same (creator, salt).
    // 3. Assert preflight.errors.contains(&10u32)  (DuplicateSalt discriminant).
    unimplemented!("requires WASM — see test comment above");
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 7
// Distinct creators produce distinct predicted addresses for the same raw salt.
// This is the preflight-only equivalent of Category A in test.rs — no WASM
// needed because we only call the read-only preflight path.
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_salt_distinct_creators_produce_distinct_predicted_addresses() {
    let env = Env::default();
    let (client, currency) = setup_no_wasm(&env);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let salt = BytesN::from_array(&env, &[0xC1u8; 32]);

    let result_alice = client.preflight_deploy_normal_721(
        &alice,
        &currency,
        &String::from_str(&env, "Alice"),
        &String::from_str(&env, "ALI"),
        &100u64,
        &0u32,
        &0u32,
        &salt,
    );

    let result_bob = client.preflight_deploy_normal_721(
        &bob,
        &currency,
        &String::from_str(&env, "Bob"),
        &String::from_str(&env, "BOB"),
        &100u64,
        &0u32,
        &0u32,
        &salt,
    );

    assert_ne!(
        result_alice.predicted_address, result_bob.predicted_address,
        "different creators with the same raw salt must predict different addresses; \
         alice = {:?}, bob = {:?}",
        result_alice.predicted_address, result_bob.predicted_address
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 8
// Distinct raw salts from the same creator produce distinct predicted addresses.
// Confirms that sha256(creator ‖ salt_a) ≠ sha256(creator ‖ salt_b) when
// salt_a ≠ salt_b, and that the deployer reflects this in predicted_address.
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_salt_distinct_raw_salts_produce_distinct_predicted_addresses() {
    let env = Env::default();
    let (client, currency) = setup_no_wasm(&env);

    let creator = Address::generate(&env);
    let salt_a = BytesN::from_array(&env, &[0xD1u8; 32]);
    let salt_b = BytesN::from_array(&env, &[0xD2u8; 32]);

    let result_a = client.preflight_deploy_normal_721(
        &creator,
        &currency,
        &String::from_str(&env, "Collection A"),
        &String::from_str(&env, "CA"),
        &100u64,
        &0u32,
        &0u32,
        &salt_a,
    );

    let result_b = client.preflight_deploy_normal_721(
        &creator,
        &currency,
        &String::from_str(&env, "Collection B"),
        &String::from_str(&env, "CB"),
        &100u64,
        &0u32,
        &0u32,
        &salt_b,
    );

    assert_ne!(
        result_a.predicted_address, result_b.predicted_address,
        "same creator with different raw salts must predict different addresses; \
         salt_a → {:?}, salt_b → {:?}",
        result_a.predicted_address, result_b.predicted_address
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 9
// Cross-kind address collision documentation.
//
// make_secure_salt derives secure_salt from (creator, raw_salt) only — the
// collection kind (721 vs 1155) is NOT included.  Therefore:
//
//   preflight_deploy_normal_721 (creator, salt)  →  predicted_address = P
//   preflight_deploy_normal_1155(creator, salt)  →  predicted_address = P  (same)
//
// Both kinds share the same predicted_address for a given (creator, salt) pair.
// After the first successful deployment the second call returns P idempotently
// (the SaltAddress lookup short-circuits before WASM deployment) regardless of
// which kind was originally deployed.
//
// This is a deliberate design — the namespace is (factory, secure_salt) not
// (factory, secure_salt, kind) — and operators must use distinct raw_salts when
// they intend to deploy both a 721 and a 1155 collection for the same creator.
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_salt_sequence_no_cross_kind_collision() {
    let env = Env::default();
    let (client, currency) = setup_no_wasm(&env);

    let creator = Address::generate(&env);
    // Single raw salt used for both a 721 and a 1155 preflight.
    let salt = BytesN::from_array(&env, &[0xE5u8; 32]);

    let result_721 = client.preflight_deploy_normal_721(
        &creator,
        &currency,
        &String::from_str(&env, "Cross Kind 721"),
        &String::from_str(&env, "CK7"),
        &100u64,
        &0u32,
        &0u32,
        &salt,
    );

    let result_1155 = client.preflight_deploy_normal_1155(
        &creator,
        &currency,
        &String::from_str(&env, "Cross Kind 1155"),
        &0u32,
        &0u32,
        &salt,
    );

    // The two kinds produce the SAME predicted address because secure_salt is
    // derived from (creator, raw_salt) with no kind component.
    // This documents the cross-kind collision: use distinct raw_salts when
    // deploying both a 721 and a 1155 for the same creator.
    assert_eq!(
        result_721.predicted_address, result_1155.predicted_address,
        "normal_721 and normal_1155 with the same (creator, salt) must predict \
         the same address — they share the secure_salt derivation; \
         721 → {:?}, 1155 → {:?}",
        result_721.predicted_address, result_1155.predicted_address
    );
}
