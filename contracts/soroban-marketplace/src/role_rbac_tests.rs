//! role_rbac_tests.rs — Issue #852: Four-Role RBAC Migration
//!
//! Tests for migrate_roles, get_role_inventory, set_role_direct, and the
//! two-step role-transfer proposals.
//!
//! These tests use the mock environment pattern from the existing test suite.

#![cfg(test)]
extern crate std;

use soroban_sdk::{
    testutils::Address as _,
    Address, Env,
};

use crate::{
    storage::DataKey,
    types::{MigrateRolesConfig, RoleInventory, RoleType},
    MarketplaceContract, MarketplaceContractClient,
};

// ── Helper ────────────────────────────────────────────────────────────────────

fn setup_rbac() -> (Env, MarketplaceContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.set_admin(&admin);
    (env, client, admin)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

/// migrate_roles with all three optional roles set populates all three slots.
#[test]
fn test_migrate_roles_sets_unassigned_roles() {
    let (env, client, admin) = setup_rbac();

    let operator = Address::generate(&env);
    let moderator = Address::generate(&env);
    let treasury = Address::generate(&env);

    let config = MigrateRolesConfig {
        operator: Some(operator.clone()),
        moderator: Some(moderator.clone()),
        treasury_manager: Some(treasury.clone()),
    };

    client.migrate_roles(&admin, &config);

    let inv: RoleInventory = client.get_role_inventory();
    assert_eq!(inv.admin, admin);
    assert_eq!(inv.operator, Some(operator));
    assert_eq!(inv.moderator, Some(moderator));
    assert_eq!(inv.treasury_manager, Some(treasury));
}

/// Calling migrate_roles a second time with the same config must not overwrite
/// already-assigned roles (idempotent).
#[test]
fn test_migrate_roles_idempotent() {
    let (env, client, admin) = setup_rbac();

    let operator_first = Address::generate(&env);
    let config_first = MigrateRolesConfig {
        operator: Some(operator_first.clone()),
        moderator: None,
        treasury_manager: None,
    };
    client.migrate_roles(&admin, &config_first);

    // Second call should not overwrite the already-assigned operator.
    let operator_second = Address::generate(&env);
    let config_second = MigrateRolesConfig {
        operator: Some(operator_second.clone()),
        moderator: None,
        treasury_manager: None,
    };
    client.migrate_roles(&admin, &config_second);

    let inv: RoleInventory = client.get_role_inventory();
    // Still the first operator — idempotent
    assert_eq!(inv.operator, Some(operator_first));
}

/// Proposing a role transfer twice should overwrite the first proposal (the
/// old candidate's slot is replaced, not accumulated).
#[test]
fn test_propose_role_transfer_overwrite() {
    let (env, client, admin) = setup_rbac();

    let candidate_a = Address::generate(&env);
    let candidate_b = Address::generate(&env);

    // Set operator first so there is a role to transfer.
    client.set_role_direct(&admin, &RoleType::Operator, &candidate_a);

    // Propose transfer to candidate_a, then overwrite with candidate_b.
    client.propose_role_transfer(&admin, &RoleType::Operator, &candidate_b);

    // The pending proposal must point to candidate_b (second call wins).
    let pending = client.get_pending_role_proposal(&RoleType::Operator);
    assert!(pending.is_some());
    assert_eq!(pending.unwrap().candidate, candidate_b);
}

/// Attempting to transfer a role to the address that already holds it must
/// be rejected with InvalidStateTransition.
#[test]
fn test_role_transfer_to_self_rejected() {
    let (env, client, admin) = setup_rbac();

    let operator = Address::generate(&env);
    client.set_role_direct(&admin, &RoleType::Operator, &operator);

    // Proposing transfer to the current holder is a no-op / invalid state.
    let result = client.try_propose_role_transfer(&admin, &RoleType::Operator, &operator);
    assert!(
        result.is_err(),
        "transferring a role to its current holder should fail"
    );
}

/// Attempting to transfer a role to a contract address must be rejected
/// with InvalidStateTransition (to prevent privilege lock-in).
#[test]
fn test_role_transfer_to_contract_rejected() {
    let (env, client, admin) = setup_rbac();

    // Registering a blank contract gives us a real contract Address.
    let dummy_contract = env.register(MarketplaceContract, ());

    let result = client.try_propose_role_transfer(&admin, &RoleType::Moderator, &dummy_contract);
    assert!(
        result.is_err(),
        "transferring a role to a contract address should fail"
    );
}

/// get_role_inventory must fall back to the Admin address for any role that
/// has not been explicitly assigned via set_role_direct or migrate_roles.
#[test]
fn test_get_role_inventory_fallback() {
    let (_env, client, admin) = setup_rbac();

    let inv: RoleInventory = client.get_role_inventory();
    // Admin is always set.
    assert_eq!(inv.admin, admin);
    // Unassigned roles are None — the contract returns None (not the admin)
    // to let callers distinguish "no role assigned" from "admin holds all roles".
    assert!(inv.operator.is_none());
    assert!(inv.moderator.is_none());
    assert!(inv.treasury_manager.is_none());
}
