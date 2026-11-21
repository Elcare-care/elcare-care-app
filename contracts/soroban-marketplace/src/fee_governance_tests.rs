// fee_governance_tests.rs — Issue 078
//
// Admin-only fee configuration should explicitly reject a non-admin caller.
// These tests pin the authorization guard on `set_protocol_fee` (and its
// per-collection companion `set_collection_fee_bps`) so a regression in the
// role-check path is immediately visible.
//
// Acceptance criteria:
//   • A non-admin caller cannot update the global protocol fee.
//   • The fee state is unchanged after the rejected call.
//   • The authorized admin path continues to work (existing passing coverage
//     in `governance_tests.rs` and `fee_attribution_tests.rs` covers this;
//     the positive path here serves as a local sanity-check only).

use crate::test::mock_nft;
use crate::contract::{MarketplaceContract, MarketplaceContractClient};
use soroban_sdk::{testutils::Address as _, Address, Env};

// ── Setup ─────────────────────────────────────────────────────────────────────

fn setup() -> (Env, MarketplaceContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.set_admin(&admin);
    client.migrate_roles(&admin);
    (env, client, admin)
}

// ── Global protocol fee — unauthorized rejection ──────────────────────────────

/// A non-admin caller must be rejected with `Unauthorized` (#5).
///
/// The stored fee must remain at the pre-call value so no partial state update
/// can occur even on a failed call.
#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_set_protocol_fee_rejects_non_admin_caller() {
    let (env, client, _admin) = setup();
    let stranger = Address::generate(&env);
    // Pre-condition: fee is 0 (default).
    assert_eq!(client.get_protocol_fee(), 0u32);
    // Attempt to set the fee as an unrelated address — must panic.
    client.set_protocol_fee(&stranger, &300u32);
}

/// After a rejected non-admin call, the fee state must be unchanged.
#[test]
fn test_set_protocol_fee_fee_unchanged_after_rejection() {
    let (env, client, _admin) = setup();
    let stranger = Address::generate(&env);

    let fee_before = client.get_protocol_fee();

    // Drive a rejected call; catch the panic so we can assert the invariant.
    let result = client.try_set_protocol_fee(&stranger, &500u32);
    assert!(result.is_err(), "non-admin call must be rejected");

    let fee_after = client.get_protocol_fee();
    assert_eq!(
        fee_before, fee_after,
        "fee state must be unchanged after a rejected non-admin call"
    );
}

/// Sanity check: the ProtocolConfig role holder (admin after `migrate_roles`)
/// can successfully update the protocol fee.  This confirms the guard itself
/// is working, not just that the contract always panics.
#[test]
fn test_set_protocol_fee_admin_succeeds() {
    let (_, client, admin) = setup();
    client.set_protocol_fee(&admin, &250u32);
    assert_eq!(client.get_protocol_fee(), 250u32);
}

// ── Per-collection fee override — unauthorized rejection ──────────────────────

/// A non-admin caller must be rejected for the per-collection fee override
/// (`set_collection_fee_bps`) as well.  Both entry-points share the same
/// `require_role(ProtocolConfig)` guard; this test ensures the guard fires on
/// the collection-level path too.
#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_set_collection_fee_bps_rejects_non_admin_caller() {
    let (env, client, _admin) = setup();
    let stranger = Address::generate(&env);
    let collection = env.register(mock_nft::MockNft, ());
    client.set_collection_fee_bps(&stranger, &collection, &700u32);
}

/// After a rejected non-admin call to `set_collection_fee_bps`, no override
/// must be stored for the collection.
#[test]
fn test_set_collection_fee_bps_state_unchanged_after_rejection() {
    let (env, client, _admin) = setup();
    let stranger = Address::generate(&env);
    let collection = env.register(mock_nft::MockNft, ());

    // No override exists yet.
    assert!(client.get_collection_fee_bps(&collection).is_none());

    let result = client.try_set_collection_fee_bps(&stranger, &collection, &700u32);
    assert!(result.is_err(), "non-admin call must be rejected");

    // Still no override after the rejected attempt.
    assert!(
        client.get_collection_fee_bps(&collection).is_none(),
        "collection fee override must not be stored after a rejected call"
    );
}

// ── Treasury authorization + pause fixture matrix ────────────────────────────
//
// Acceptance criteria:
//   • Changing treasury or fee settings is guarded by ProtocolConfig role.
//   • A global pause does NOT block governance/treasury entry points.
//   • Unauthorized callers are rejected on every treasury and fee entry point.
//   • State is never mutated by a rejected call.
//
// Fixture matrix:
//   Row  | Caller       | Paused | Expected result
//   ─────┼──────────────┼────────┼────────────────
//   A    | ProtocolConfig holder | No  | success
//   B    | ProtocolConfig holder | Yes | success (governance bypasses pause)
//   C    | Unauthorized address | No  | Unauthorized (#5)
//   D    | Unauthorized address | Yes | Unauthorized (#5)

use crate::types::RoleType;

fn setup_full() -> (Env, MarketplaceContractClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let stranger = Address::generate(&env);
    client.set_admin(&admin);
    client.migrate_roles(&admin);
    (env, client, admin, stranger)
}

// ── Row A: authorized, not paused ────────────────────────────────────────────

#[test]
fn test_set_protocol_fee_authorized_not_paused() {
    let (_, client, admin, _) = setup_full();
    client.set_protocol_fee(&admin, &150u32);
    assert_eq!(client.get_protocol_fee(), 150u32);
}

#[test]
fn test_set_treasury_authorized_not_paused() {
    let (env, client, admin, _) = setup_full();
    let treasury = Address::generate(&env);
    client.set_treasury(&admin, &treasury);
    assert_eq!(client.get_treasury(), Some(treasury));
}

#[test]
fn test_propose_treasury_authorized_not_paused() {
    let (env, client, admin, _) = setup_full();
    let candidate = Address::generate(&env);
    // propose_treasury should succeed for the ProtocolConfig role holder
    client.propose_treasury(&admin, &candidate);
    let pending = client.get_pending_treasury();
    assert!(pending.is_some());
    assert_eq!(pending.unwrap().candidate, candidate);
}

// ── Row B: authorized, paused (governance bypasses pause) ────────────────────

#[test]
fn test_set_protocol_fee_authorized_while_paused() {
    let (_, client, admin, _) = setup_full();
    client.admin_pause(&admin);
    assert!(client.is_paused());
    // ProtocolConfig operations must succeed even under global pause
    client.set_protocol_fee(&admin, &200u32);
    assert_eq!(client.get_protocol_fee(), 200u32);
}

#[test]
fn test_set_treasury_authorized_while_paused() {
    let (env, client, admin, _) = setup_full();
    let treasury = Address::generate(&env);
    client.admin_pause(&admin);
    client.set_treasury(&admin, &treasury);
    assert_eq!(client.get_treasury(), Some(treasury));
}

#[test]
fn test_propose_treasury_authorized_while_paused() {
    let (env, client, admin, _) = setup_full();
    let candidate = Address::generate(&env);
    client.admin_pause(&admin);
    // Treasury proposals must succeed under global pause
    client.propose_treasury(&admin, &candidate);
    assert!(client.get_pending_treasury().is_some());
}

#[test]
fn test_cancel_treasury_proposal_authorized_while_paused() {
    let (env, client, admin, _) = setup_full();
    let candidate = Address::generate(&env);
    client.propose_treasury(&admin, &candidate);
    client.admin_pause(&admin);
    // Cancellation must also succeed under pause
    client.cancel_treasury_proposal(&admin);
    assert!(client.get_pending_treasury().is_none());
}

// ── Row C: unauthorized, not paused ──────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_set_protocol_fee_unauthorized_not_paused() {
    let (env, client, admin, stranger) = setup_full();
    // Rotate ProtocolConfig away from admin so admin is no longer the holder
    let config_holder = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &config_holder);
    client.accept_role_transfer(&RoleType::ProtocolConfig, &config_holder);
    client.set_protocol_fee(&stranger, &300u32);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_set_treasury_unauthorized_not_paused() {
    let (env, client, admin, stranger) = setup_full();
    let config_holder = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &config_holder);
    client.accept_role_transfer(&RoleType::ProtocolConfig, &config_holder);
    let treasury = Address::generate(&env);
    client.set_treasury(&stranger, &treasury);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_propose_treasury_unauthorized_not_paused() {
    let (env, client, admin, stranger) = setup_full();
    let config_holder = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &config_holder);
    client.accept_role_transfer(&RoleType::ProtocolConfig, &config_holder);
    let candidate = Address::generate(&env);
    client.propose_treasury(&stranger, &candidate);
}

/// Treasury state must be unchanged after an unauthorized call.
#[test]
fn test_set_treasury_state_unchanged_after_unauthorized_rejection() {
    let (env, client, admin, _) = setup_full();
    // Set a known treasury first
    let original_treasury = Address::generate(&env);
    client.set_treasury(&admin, &original_treasury);

    // Rotate ProtocolConfig away
    let config_holder = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &config_holder);
    client.accept_role_transfer(&RoleType::ProtocolConfig, &config_holder);

    let stranger = Address::generate(&env);
    let new_treasury = Address::generate(&env);
    let result = client.try_set_treasury(&stranger, &new_treasury);
    assert!(result.is_err(), "unauthorized call must be rejected");

    // Treasury must remain unchanged
    assert_eq!(
        client.get_treasury(),
        Some(original_treasury),
        "treasury address must be unchanged after a rejected unauthorized call"
    );
}

/// Protocol fee state must be unchanged after an unauthorized call.
#[test]
fn test_set_protocol_fee_state_unchanged_after_rejection() {
    let (env, client, admin, _) = setup_full();
    client.set_protocol_fee(&admin, &100u32);

    let config_holder = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &config_holder);
    client.accept_role_transfer(&RoleType::ProtocolConfig, &config_holder);

    let stranger = Address::generate(&env);
    let result = client.try_set_protocol_fee(&stranger, &999u32);
    assert!(result.is_err());
    assert_eq!(
        client.get_protocol_fee(),
        100u32,
        "fee must be unchanged after rejected unauthorized call"
    );
}

// ── Row D: unauthorized, paused ───────────────────────────────────────────────

#[test]
fn test_set_protocol_fee_unauthorized_while_paused_still_rejected() {
    let (env, client, admin, _) = setup_full();
    // Keep admin as ProtocolConfig holder; create a stranger who is definitely not it
    let stranger = Address::generate(&env);
    client.admin_pause(&admin);

    let result = client.try_set_protocol_fee(&stranger, &500u32);
    assert!(result.is_err(),
        "unauthorized caller must be rejected even when the contract is paused");
    // Fee must be unchanged
    assert_eq!(client.get_protocol_fee(), 0u32);
}

#[test]
fn test_propose_treasury_unauthorized_while_paused_still_rejected() {
    let (env, client, admin, _) = setup_full();
    let config_holder = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &config_holder);
    client.accept_role_transfer(&RoleType::ProtocolConfig, &config_holder);

    client.admin_pause(&admin);

    let stranger = Address::generate(&env);
    let candidate = Address::generate(&env);
    let result = client.try_propose_treasury(&stranger, &candidate);
    assert!(result.is_err(),
        "unauthorized caller must be rejected on treasury proposals even when paused");
    assert!(client.get_pending_treasury().is_none());
}

// ── EmergencyPause role cannot change fee or treasury ────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_emergency_pause_role_cannot_set_protocol_fee() {
    let (env, client, admin, _) = setup_full();
    let pause_holder = Address::generate(&env);
    let config_holder = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::EmergencyPause, &pause_holder);
    client.accept_role_transfer(&RoleType::EmergencyPause, &pause_holder);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &config_holder);
    client.accept_role_transfer(&RoleType::ProtocolConfig, &config_holder);
    // pause_holder holds EmergencyPause only — must NOT be able to touch fee
    client.set_protocol_fee(&pause_holder, &100u32);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_emergency_pause_role_cannot_propose_treasury() {
    let (env, client, admin, _) = setup_full();
    let pause_holder = Address::generate(&env);
    let config_holder = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::EmergencyPause, &pause_holder);
    client.accept_role_transfer(&RoleType::EmergencyPause, &pause_holder);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &config_holder);
    client.accept_role_transfer(&RoleType::ProtocolConfig, &config_holder);
    let candidate = Address::generate(&env);
    client.propose_treasury(&pause_holder, &candidate);
}

// ── Role-separation sanity: ProtocolConfig cannot pause ──────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_protocol_config_role_cannot_pause() {
    let (env, client, admin, _) = setup_full();
    let config_holder = Address::generate(&env);
    let pause_holder = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &config_holder);
    client.accept_role_transfer(&RoleType::ProtocolConfig, &config_holder);
    client.propose_role_transfer(&admin, &RoleType::EmergencyPause, &pause_holder);
    client.accept_role_transfer(&RoleType::EmergencyPause, &pause_holder);
    // config_holder holds ProtocolConfig only — must NOT be able to pause
    client.admin_pause(&config_holder);
}

// ── Collection fee override — full matrix spot-check ─────────────────────────

#[test]
fn test_set_collection_fee_bps_authorized_not_paused() {
    let (env, client, admin, _) = setup_full();
    let collection = Address::generate(&env);
    client.set_collection_fee_bps(&admin, &collection, &500u32);
    assert_eq!(client.get_collection_fee_bps(&collection), Some(500u32));
}

#[test]
fn test_set_collection_fee_bps_authorized_while_paused() {
    let (env, client, admin, _) = setup_full();
    let collection = Address::generate(&env);
    client.admin_pause(&admin);
    // ProtocolConfig operations bypass pause
    client.set_collection_fee_bps(&admin, &collection, &750u32);
    assert_eq!(client.get_collection_fee_bps(&collection), Some(750u32));
}

#[test]
fn test_set_collection_fee_bps_state_unchanged_after_rejection() {
    let (env, client, admin, _) = setup_full();
    let collection = Address::generate(&env);
    // No override exists yet — None
    assert!(client.get_collection_fee_bps(&collection).is_none());

    let config_holder = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &config_holder);
    client.accept_role_transfer(&RoleType::ProtocolConfig, &config_holder);

    let stranger = Address::generate(&env);
    let result = client.try_set_collection_fee_bps(&stranger, &collection, &1000u32);
    assert!(result.is_err());
    // Still None after the failed call
    assert!(
        client.get_collection_fee_bps(&collection).is_none(),
        "collection fee override must not be set after a rejected call"
    );
}
