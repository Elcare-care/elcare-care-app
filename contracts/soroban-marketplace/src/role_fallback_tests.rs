/// # Role Fallback and Explicit-Holder Tests (Issue — Role RBAC)
///
/// ## Invariant documented here
///
/// `get_role(role)` resolves as follows:
///   1. If `DataKey::Role(role)` is present in persistent storage, return
///      the stored address (the **explicit holder**).
///   2. Otherwise, return the value of `DataKey::Admin` (the **admin fallback**).
///
/// This guarantees that existing single-admin deployments keep working without
/// any migration: until an operator explicitly assigns a role via
/// `propose_role_transfer` / `accept_role_transfer`, or `migrate_roles`, every
/// privileged entry point is owned by the admin.
///
/// ## Tests in this module
///
/// * `unassigned_role_resolves_to_admin` — the pure fallback case.
/// * `explicit_holder_overrides_admin` — once assigned, the explicit holder
///   takes precedence even if admin changes.
/// * `each_role_fallback_is_admin` — all four role axes independently resolve
///   to admin when none has been assigned.
/// * `roles_are_independent_after_assignment` — assigning one role does not
///   affect the others.
/// * `get_role_inventory_unassigned_entries_fallback_to_admin` — the diagnostic
///   view returns admin for every unassigned role entry.
/// * `get_role_inventory_assigned_entry_uses_explicit_holder` — once assigned,
///   the inventory entry carries the explicit holder.
/// * `migrate_roles_assigns_only_unassigned_roles` — idempotency: a role that
///   already has an explicit holder is never overwritten.
/// * `migrate_roles_does_not_affect_admin_key` — migrate_roles never mutates
///   the Admin storage key.
/// * `role_fallback_survives_admin_rotation` — after the admin is rotated, an
///   unassigned role falls back to the **new** admin.

#[cfg(test)]

use soroban_sdk::{testutils::Address as _, Address, Env};

use crate::{
    types::RoleType,
    contract::{MarketplaceContract, MarketplaceContractClient},
};

// ── Helper ────────────────────────────────────────────────────────────────────

fn setup() -> (Env, MarketplaceContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let cid = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &cid);
    let admin = Address::generate(&env);
    client.set_admin(&admin);
    (env, client, admin)
}

// ── Fallback tests ────────────────────────────────────────────────────────────

/// An unassigned role must resolve to the admin.
/// Boundary: applies to ALL four role axes independently of each other.
#[test]
fn unassigned_role_resolves_to_admin() {
    let (_env, client, admin) = setup();

    for role in [
        RoleType::ProtocolConfig,
        RoleType::EmergencyPause,
        RoleType::CollectionAdmin,
        RoleType::Upgrade,
    ] {
        assert_eq!(
            client.get_role(&role),
            admin,
            "{:?}: unassigned role must resolve to admin",
            role
        );
    }
}

/// Each of the four roles independently falls back to admin; none bleeds into
/// another.
#[test]
fn each_role_fallback_is_admin_independently() {
    let (_env, client, admin) = setup();

    // Confirm all four independently — no cross-contamination.
    assert_eq!(client.get_role(&RoleType::ProtocolConfig), admin);
    assert_eq!(client.get_role(&RoleType::EmergencyPause),  admin);
    assert_eq!(client.get_role(&RoleType::CollectionAdmin), admin);
    assert_eq!(client.get_role(&RoleType::Upgrade),         admin);
}

/// Once a role gets an explicit holder (via propose + accept), `get_role`
/// returns the explicit holder, not the admin.
#[test]
fn explicit_holder_overrides_admin() {
    let (env, client, admin) = setup();

    let holder = Address::generate(&env);

    // Two-step assignment: propose then accept.
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &holder);
    client.accept_role_transfer(&RoleType::ProtocolConfig, &holder);

    assert_eq!(
        client.get_role(&RoleType::ProtocolConfig),
        holder,
        "explicit holder must override admin fallback"
    );
    // Other roles are still unassigned and still fall back to admin.
    assert_eq!(client.get_role(&RoleType::EmergencyPause), admin);
    assert_eq!(client.get_role(&RoleType::CollectionAdmin), admin);
    assert_eq!(client.get_role(&RoleType::Upgrade), admin);
}

/// Assigning one role must NOT affect the other three.
#[test]
fn roles_are_independent_after_assignment() {
    let (env, client, admin) = setup();

    let pause_holder = Address::generate(&env);

    client.propose_role_transfer(&admin, &RoleType::EmergencyPause, &pause_holder);
    client.accept_role_transfer(&RoleType::EmergencyPause, &pause_holder);

    // Only EmergencyPause was assigned.
    assert_eq!(client.get_role(&RoleType::EmergencyPause),  pause_holder);
    assert_eq!(client.get_role(&RoleType::ProtocolConfig),  admin, "ProtocolConfig must still fall back to admin");
    assert_eq!(client.get_role(&RoleType::CollectionAdmin), admin, "CollectionAdmin must still fall back to admin");
    assert_eq!(client.get_role(&RoleType::Upgrade),         admin, "Upgrade must still fall back to admin");
}

/// After rotating the admin, unassigned roles now fall back to the NEW admin.
/// This validates that the fallback is a live lookup, not a snapshot.
#[test]
fn role_fallback_survives_admin_rotation() {
    let (env, client, admin) = setup();

    // All roles are unassigned → should resolve to admin now.
    assert_eq!(client.get_role(&RoleType::ProtocolConfig), admin);

    // Rotate the admin.
    let new_admin = Address::generate(&env);
    client.transfer_admin(&admin, &new_admin);
    client.accept_admin(&new_admin);

    // After rotation, unassigned roles resolve to the new admin.
    assert_eq!(
        client.get_role(&RoleType::ProtocolConfig),
        new_admin,
        "unassigned role must fall back to the new admin after rotation"
    );
    assert_eq!(client.get_role(&RoleType::EmergencyPause),  new_admin);
    assert_eq!(client.get_role(&RoleType::CollectionAdmin), new_admin);
    assert_eq!(client.get_role(&RoleType::Upgrade),         new_admin);
}

// ── get_role_inventory tests ──────────────────────────────────────────────────

/// When no roles are explicitly assigned, `get_role_inventory` reflects the
/// admin fallback for every role entry.
#[test]
fn get_role_inventory_unassigned_entries_fallback_to_admin() {
    let (_env, client, admin) = setup();

    let inv = client.get_role_inventory();

    // The admin field must be Some(admin).
    assert_eq!(inv.admin, Some(admin.clone()));
    assert!(inv.pending_admin_candidate.is_none());

    // Every role entry must carry admin as the holder.
    for entry in inv.roles.iter() {
        assert_eq!(
            entry.holder, admin,
            "{:?}: role inventory entry must show admin fallback",
            entry.role
        );
        assert!(entry.pending_candidate.is_none(), "{:?}: no pending candidate expected", entry.role);
    }
}

/// Once a role is explicitly assigned, the inventory entry carries the holder's
/// address (not the admin's), while unassigned roles remain at admin.
#[test]
fn get_role_inventory_assigned_entry_uses_explicit_holder() {
    let (env, client, admin) = setup();

    let upgrade_holder = Address::generate(&env);

    client.propose_role_transfer(&admin, &RoleType::Upgrade, &upgrade_holder);
    client.accept_role_transfer(&RoleType::Upgrade, &upgrade_holder);

    let inv = client.get_role_inventory();

    for entry in inv.roles.iter() {
        if entry.role == RoleType::Upgrade {
            assert_eq!(
                entry.holder, upgrade_holder,
                "Upgrade role inventory entry must show explicit holder"
            );
        } else {
            assert_eq!(
                entry.holder, admin,
                "{:?}: unassigned role must still show admin fallback in inventory",
                entry.role
            );
        }
    }
}

// ── migrate_roles idempotency tests ──────────────────────────────────────────

/// `migrate_roles` only assigns roles that have no explicit holder.
/// A role that already has an explicit holder must NOT be overwritten.
#[test]
fn migrate_roles_assigns_only_unassigned_roles() {
    let (env, client, admin) = setup();

    // Explicitly assign ProtocolConfig before calling migrate_roles.
    let protocol_holder = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &protocol_holder);
    client.accept_role_transfer(&RoleType::ProtocolConfig, &protocol_holder);

    // migrate_roles must skip ProtocolConfig (already assigned) and assign
    // the rest to admin.
    client.migrate_roles(&admin);

    // ProtocolConfig must still point to protocol_holder, not admin.
    assert_eq!(
        client.get_role(&RoleType::ProtocolConfig),
        protocol_holder,
        "migrate_roles must not overwrite an already-assigned role"
    );

    // All other roles now have admin as their explicit holder.
    assert_eq!(client.get_role(&RoleType::EmergencyPause),  admin);
    assert_eq!(client.get_role(&RoleType::CollectionAdmin), admin);
    assert_eq!(client.get_role(&RoleType::Upgrade),         admin);
}

/// Calling `migrate_roles` twice must leave all roles unchanged on the second
/// call — no role gets overwritten because all slots are filled after the first.
#[test]
fn migrate_roles_idempotent_called_twice() {
    let (_env, client, admin) = setup();

    client.migrate_roles(&admin);

    // Record holders after first call.
    let r1_protocol = client.get_role(&RoleType::ProtocolConfig);
    let r1_pause    = client.get_role(&RoleType::EmergencyPause);
    let r1_col      = client.get_role(&RoleType::CollectionAdmin);
    let r1_upgrade  = client.get_role(&RoleType::Upgrade);

    // Second call.
    client.migrate_roles(&admin);

    assert_eq!(client.get_role(&RoleType::ProtocolConfig), r1_protocol, "ProtocolConfig unchanged");
    assert_eq!(client.get_role(&RoleType::EmergencyPause), r1_pause,    "EmergencyPause unchanged");
    assert_eq!(client.get_role(&RoleType::CollectionAdmin), r1_col,      "CollectionAdmin unchanged");
    assert_eq!(client.get_role(&RoleType::Upgrade),         r1_upgrade,  "Upgrade unchanged");
}

/// `migrate_roles` must not alter the Admin storage key.
#[test]
fn migrate_roles_does_not_affect_admin_key() {
    let (_env, client, admin) = setup();

    client.migrate_roles(&admin);

    assert_eq!(
        client.get_admin().unwrap(),
        admin,
        "migrate_roles must not change the admin key"
    );
}
