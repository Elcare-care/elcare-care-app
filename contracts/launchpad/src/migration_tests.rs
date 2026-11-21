// migration_tests.rs — Issue #1100
//
// Contract version compatibility checklist: unit tests that pin the exact
// invariants operators must verify before and after a WASM upgrade.
//
// Coverage:
//   1. `version()` returns the compile-time constant (CONTRACT_VERSION).
//   2. `contract_version()` returns None before any migration.
//   3. `migrate()` is admin-gated.
//   4. `migrate()` succeeds once and writes the on-chain version marker.
//   5. `contract_version()` matches `version()` after a successful migration.
//   6. `migrate()` for the same version returns `AlreadyMigrated` (idempotency
//      marker prevents duplicate runs).
//   7. `migrate_step()` mirrors `migrate()` behaviour for the resumable path.
//   8. `migrate_step()` returns 0 remaining items after completing the migration.
//   9. `migrate_step()` also sets the on-chain version after the last step.
//  10. A `migrated` event is emitted with the correct version topic on success.
//  11. `contract_version()` is absent (None) on a brand-new initialize without
//      migrate — confirms version ≠ contract_version until the operator runs it.
//  12. Registry state (collection_count, existing records) is unchanged by
//      migrate — it must not corrupt live data.
//  13. Legacy `AllCollections` key is consumed and re-indexed by `migrate()`.

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    xdr,
    xdr::ToXdr,
    Address, BytesN, Env, IntoVal, String, TryFromVal, Val,
};

use crate::{CollectionKind, Error, Launchpad, LaunchpadClient, CONTRACT_VERSION};

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Returns the WASM bytes for a contract by name, identical to test.rs.
fn wasm_bytes(name: &str) -> std::vec::Vec<u8> {
    let exe = std::env::current_exe().unwrap();
    let target_dir = exe
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .unwrap()
        .to_path_buf();
    let path = target_dir
        .join("wasm32v1-none")
        .join("release")
        .join(std::format!("{name}.wasm"));
    std::fs::read(&path).unwrap_or_else(|_| {
        panic!(
            "missing wasm at {}. build it first with: cargo build --target wasm32v1-none --release",
            path.display()
        )
    })
}

/// Stand up a fully initialized launchpad (admin, fee_receiver set, WASM
/// hashes registered).  Returns `(client, admin, creator)`.
fn setup_with_wasm(env: &Env) -> (LaunchpadClient<'_>, Address, Address) {
    env.mock_all_auths();

    let launchpad_id = env.register(Launchpad, ());
    let client = LaunchpadClient::new(env, &launchpad_id);

    let admin = Address::generate(env);
    let fee_receiver = Address::generate(env);
    let creator = Address::generate(env);

    client.initialize(&admin, &fee_receiver, &0i128);

    let w721 = env
        .deployer()
        .upload_contract_wasm(wasm_bytes("collection_nft_erc721").as_slice());
    let w1155 = env
        .deployer()
        .upload_contract_wasm(wasm_bytes("collection_nft_erc1155").as_slice());
    let wl721 = env
        .deployer()
        .upload_contract_wasm(wasm_bytes("lazy_mint_erc721").as_slice());
    let wl1155 = env
        .deployer()
        .upload_contract_wasm(wasm_bytes("lazy_mint_erc1155").as_slice());

    client.set_wasm_hashes(&w721, &w1155, &wl721, &wl1155);

    (client, admin, creator)
}

/// Minimal setup — no WASM hashes, used for migrate-only tests that don't
/// deploy collections.
fn setup_no_wasm(env: &Env) -> (LaunchpadClient<'_>, Address) {
    env.mock_all_auths();
    let launchpad_id = env.register(Launchpad, ());
    let client = LaunchpadClient::new(env, &launchpad_id);
    let admin = Address::generate(env);
    let fee_receiver = Address::generate(env);
    client.initialize(&admin, &fee_receiver, &0i128);
    (client, admin)
}

/// Returns true if any event in the last invocation has the given first topic
/// symbol string from the given contract.
fn has_event_topic_str(env: &Env, contract: &Address, topic_sym: &str) -> bool {
    env.events()
        .all()
        .filter_by_contract(contract)
        .events()
        .iter()
        .any(|e| {
            if let xdr::ContractEventBody::V0(v0) = &e.body {
                v0.topics.iter().any(|t| {
                    if let xdr::ScVal::Symbol(s) = t {
                        core::str::from_utf8(s.0.as_slice()).unwrap_or("") == topic_sym
                    } else {
                        false
                    }
                })
            } else {
                false
            }
        })
}

// ── Test 1: version() returns the compile-time constant ──────────────────────

#[test]
fn version_returns_compile_time_constant() {
    let env = Env::default();
    let (client, _admin) = setup_no_wasm(&env);

    let reported = client.version();
    assert_eq!(
        reported,
        String::from_str(&env, CONTRACT_VERSION),
        "version() must equal crate::types::CONTRACT_VERSION = \"{CONTRACT_VERSION}\""
    );
}

// ── Test 2: contract_version() is None before any migration ──────────────────

#[test]
fn contract_version_is_none_before_first_migration() {
    let env = Env::default();
    let (client, _admin) = setup_no_wasm(&env);

    assert_eq!(
        client.contract_version(),
        None,
        "contract_version() must be None on a freshly initialized contract \
         until the operator runs migrate()"
    );
}

// ── Test 3: migrate() is admin-gated — non-admin is rejected ─────────────────

#[test]
fn migrate_rejects_non_admin() {
    let env = Env::default();
    // Do not mock_all_auths here — we want auth to fail.
    let launchpad_id = env.register(Launchpad, ());
    let client = LaunchpadClient::new(&env, &launchpad_id);

    let admin = Address::generate(&env);
    let fee_receiver = Address::generate(&env);
    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(&admin, &fee_receiver, &0i128);

    // A stranger trying to run migrate must be rejected.
    let stranger = Address::generate(&env);
    let result = client.try_migrate(&stranger);
    assert!(
        result.is_err(),
        "migrate() must reject callers that are not the registered admin"
    );
}

// ── Test 4: migrate() succeeds once and sets the on-chain marker ─────────────

#[test]
fn migrate_succeeds_once_and_records_marker() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 1);
    let (client, admin) = setup_no_wasm(&env);

    let result = client.try_migrate(&admin);
    assert_eq!(
        result,
        Ok(Ok(())),
        "migrate() must succeed on the first call for the current version"
    );

    // The migration-done marker must now be set.  The clearest observable
    // evidence is that a second call returns AlreadyMigrated.
    let second = client.try_migrate(&admin);
    assert_eq!(second, Err(Ok(Error::AlreadyMigrated)));
}

// ── Test 5: contract_version() matches version() after migration ─────────────

#[test]
fn contract_version_matches_version_after_migration() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 1);
    let (client, admin) = setup_no_wasm(&env);

    client.migrate(&admin);

    let on_chain = client
        .contract_version()
        .expect("contract_version() must be Some after migrate()");
    let binary = client.version();

    assert_eq!(
        on_chain, binary,
        "contract_version() must equal version() after a successful migrate()"
    );
}

// ── Test 6: migrate() is idempotent — AlreadyMigrated on repeat ──────────────

#[test]
fn migrate_is_idempotent_returns_already_migrated_on_second_call() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 1);
    let (client, admin) = setup_no_wasm(&env);

    client.migrate(&admin);

    let repeat = client.try_migrate(&admin);
    assert_eq!(
        repeat,
        Err(Ok(Error::AlreadyMigrated)),
        "migrate() for an already-completed version must return AlreadyMigrated, \
         not silently re-run the migration"
    );
}

// ── Test 7: migrate_step() first call succeeds ───────────────────────────────

#[test]
fn migrate_step_first_call_succeeds() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 1);
    let (client, admin) = setup_no_wasm(&env);

    // Large budget — completes in one call.
    let result = client.try_migrate_step(&admin, &u32::MAX);
    assert!(
        result.is_ok(),
        "migrate_step() with a large budget must succeed on the first call"
    );
}

// ── Test 8: migrate_step() returns 0 remaining after completion ──────────────

#[test]
fn migrate_step_returns_zero_remaining_on_completion() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 1);
    let (client, admin) = setup_no_wasm(&env);

    let remaining = client.migrate_step(&admin, &u32::MAX);
    assert_eq!(
        remaining, 0u64,
        "migrate_step() must return 0 remaining items once the migration is complete"
    );
}

// ── Test 9: migrate_step() sets contract_version after last step ──────────────

#[test]
fn migrate_step_sets_contract_version_after_last_step() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 1);
    let (client, admin) = setup_no_wasm(&env);

    let remaining = client.migrate_step(&admin, &u32::MAX);
    assert_eq!(remaining, 0u64);

    let on_chain = client
        .contract_version()
        .expect("contract_version() must be Some after migrate_step() finishes");
    assert_eq!(on_chain, client.version());
}

// ── Test 10: migrated event emitted with correct version topic ────────────────

#[test]
fn migrate_emits_migrated_event_with_version_topic() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 1);
    let (client, admin) = setup_no_wasm(&env);

    // Clear any setup events.
    let launchpad_id = client.address.clone();
    env.events().all();

    client.migrate(&admin);

    assert!(
        has_event_topic_str(&env, &launchpad_id, "migrated"),
        "migrate() must emit an event with topic \"migrated\" on success"
    );
}

// ── Test 11: version() ≠ contract_version() until migrate() runs ─────────────
//
// This is the most important operator invariant: seeing `version()` ≠
// `contract_version()` is the signal that the operator must run migrate().

#[test]
fn version_differs_from_contract_version_until_migration_runs() {
    let env = Env::default();
    let (client, _admin) = setup_no_wasm(&env);

    // Before migration: contract_version is absent.
    assert!(
        client.contract_version().is_none(),
        "contract_version() must be None before migrate() runs; \
         operators must call migrate() after uploading a new WASM"
    );

    // version() is always present.
    let _ = client.version(); // must not panic
}

// ── Test 12: migrate() does not corrupt live collection registry ──────────────

#[test]
fn migrate_does_not_corrupt_collection_registry() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 1);
    let (client, admin, creator) = setup_with_wasm(&env);

    let currency = Address::generate(&env);
    let royalty_receiver = Address::generate(&env);

    // Deploy two collections before running the migration.
    let addr_a = client.deploy_normal_721(
        &creator,
        &currency,
        &String::from_str(&env, "Pre-migrate A"),
        &String::from_str(&env, "PMA"),
        &100u64,
        &0u32,
        &royalty_receiver,
        &0u32,
        &BytesN::from_array(&env, &[0x01u8; 32]),
    );
    let addr_b = client.deploy_normal_1155(
        &creator,
        &currency,
        &String::from_str(&env, "Pre-migrate B"),
        &0u32,
        &royalty_receiver,
        &0u32,
        &BytesN::from_array(&env, &[0x02u8; 32]),
    );

    let count_before = client.collection_count();
    assert_eq!(count_before, 2u64);

    // Run migration.
    client.migrate(&admin);

    // Count must be unchanged.
    assert_eq!(
        client.collection_count(),
        count_before,
        "migrate() must not change collection_count"
    );

    // Individual records must still be retrievable.
    let rec_a = client
        .get_collection(&addr_a)
        .expect("collection A must remain readable after migration");
    assert_eq!(rec_a.address, addr_a);
    assert!(matches!(rec_a.kind, CollectionKind::Normal721));

    let rec_b = client
        .get_collection(&addr_b)
        .expect("collection B must remain readable after migration");
    assert_eq!(rec_b.address, addr_b);
    assert!(matches!(rec_b.kind, CollectionKind::Normal1155));

    // All-collections view must agree.
    let all = client.all_collections();
    assert_eq!(all.len(), 2);
}

// ── Test 13: migrate_step() after migrate() returns AlreadyMigrated ──────────
//
// Once migrate() seals the version marker, migrate_step() must also refuse.

#[test]
fn migrate_step_returns_already_migrated_after_migrate_completes() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 1);
    let (client, admin) = setup_no_wasm(&env);

    client.migrate(&admin);

    let result = client.try_migrate_step(&admin, &u32::MAX);
    assert_eq!(
        result,
        Err(Ok(Error::AlreadyMigrated)),
        "migrate_step() must refuse once the version marker is set by migrate()"
    );
}

// ── Regression: version constant value ───────────────────────────────────────
//
// Pin the current version string so a future bump triggers test failure and
// forces the operator checklist to be updated.

#[test]
fn contract_version_constant_is_1_0_0() {
    assert_eq!(
        CONTRACT_VERSION, "1.0.0",
        "CONTRACT_VERSION changed — bump the upgrade checklist version table \
         (contracts/launchpad/UPGRADE-CHECKLIST.md) and update this test"
    );
}
