// governance_tests.rs — Production-grade role-aware emergency governance suite
//
// Coverage:
//   - Proposal lifecycle: create, accept, expire, cancel, overwrite
//   - Failure cases: wrong candidate, wrong caller, stale holder, expired proposal
//   - Role-confusion / stale-holder attacks after rotation
//   - Multi-role authorization matrix (each role gate independent)
//   - Pause × governance interaction (governance ops unaffected by pause)
//   - migrate_roles edge cases
//   - Event emission: proposed, transferred, cancelled, overwritten audit trail
//   - Impossible-governance-state guards (self-transfer, contract-address)

use super::*;
use crate::{
    events::{
        RoleProposalCancelledEvent, RoleProposalOverwrittenEvent, RoleTransferProposedEvent,
        RoleTransferredEvent, ROLE_PROPOSAL_CANCELLED, ROLE_PROPOSAL_OVERWRITTEN,
        ROLE_TRANSFER_PROPOSED, ROLE_TRANSFERRED,
    },
    types::RoleType,
};
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger},
    Address, Env,
};

// ── Shared test setup ─────────────────────────────────────────────────────────

/// Standard governance test fixture:
/// - fresh env + contract
/// - `admin` holds all four roles via `migrate_roles`
/// - `other` is an unprivileged address
fn gov_setup() -> (
    Env,
    MarketplaceContractClient<'static>,
    Address, // admin (all roles)
    Address, // other (no roles)
) {
    let env = Env::default();
    env.mock_all_auths();
    let cid = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &cid);
    let admin = Address::generate(&env);
    let other = Address::generate(&env);
    client.set_admin(&admin);
    client.migrate_roles(&admin);
    (env, client, admin, other)
}

// ── Event scanning helpers ────────────────────────────────────────────────────

fn has_event_topic(events: &soroban_sdk::testutils::ContractEvents, topic: &str) -> bool {
    use soroban_sdk::xdr::{ContractEventBody, ScVal};
    events.events().iter().any(|e| {
        if let ContractEventBody::V0(body) = &e.body {
            body.topics.iter().any(|t| match t {
                ScVal::Symbol(s) => core::str::from_utf8(s.0.as_slice()).unwrap_or("") == topic,
                ScVal::String(s) => core::str::from_utf8(s.0.as_slice()).unwrap_or("") == topic,
                _ => false,
            })
        } else {
            false
        }
    })
}

fn decode_event<T>(
    env: &Env,
    events: &soroban_sdk::testutils::ContractEvents,
    topic: &str,
) -> Option<T>
where
    T: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>,
{
    use soroban_sdk::{xdr::{ContractEventBody, ScVal}, FromVal};
    events.events().iter().find_map(|e| {
        if let ContractEventBody::V0(body) = &e.body {
            let matches = body.topics.iter().any(|t| match t {
                ScVal::Symbol(s) => core::str::from_utf8(s.0.as_slice()).unwrap_or("") == topic,
                ScVal::String(s) => core::str::from_utf8(s.0.as_slice()).unwrap_or("") == topic,
                _ => false,
            });
            if matches {
                let val = soroban_sdk::Val::from_val(env, &body.data);
                T::try_from_val(env, &val).ok()
            } else {
                None
            }
        } else {
            None
        }
    })
}

// ── §1  Proposal creation ─────────────────────────────────────────────────────

#[test]
fn test_propose_creates_pending_proposal() {
    let (env, client, admin, _) = gov_setup();
    let candidate = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &candidate);

    let pending = client
        .get_pending_role(&RoleType::ProtocolConfig)
        .expect("proposal must be pending");
    assert_eq!(pending.candidate, candidate);
    assert_eq!(pending.expires_at, env.ledger().timestamp() + 604_800);
}

#[test]
fn test_propose_stores_correct_expiry() {
    let (env, client, admin, _) = gov_setup();
    let candidate = Address::generate(&env);
    let now = env.ledger().timestamp();
    client.propose_role_transfer(&admin, &RoleType::EmergencyPause, &candidate);

    let pending = client.get_pending_role(&RoleType::EmergencyPause).unwrap();
    assert_eq!(pending.expires_at, now + 604_800, "expiry must be now + 7 days");
}

#[test]
fn test_propose_does_not_change_current_holder() {
    let (env, client, admin, _) = gov_setup();
    let candidate = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::CollectionAdmin, &candidate);

    assert_eq!(
        client.get_role(&RoleType::CollectionAdmin),
        admin,
        "proposing must not change the current holder"
    );
}

#[test]
fn test_propose_emits_role_transfer_proposed_event() {
    let (env, client, admin, _) = gov_setup();
    let candidate = Address::generate(&env);
    let now = env.ledger().timestamp();
    client.propose_role_transfer(&admin, &RoleType::Upgrade, &candidate);

    let ev = decode_event::<RoleTransferProposedEvent>(&env, &env.events().all(), ROLE_TRANSFER_PROPOSED)
        .expect("role_transfer_proposed event must be emitted");
    assert_eq!(ev.role, RoleType::Upgrade);
    assert_eq!(ev.current_authority, admin);
    assert_eq!(ev.proposed_authority, candidate);
    assert_eq!(ev.expires_at, now + 604_800);
}

// ── §2  Self-transfer and contract-address guards ─────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #54)")]
fn test_propose_to_self_panics_with_role_transfer_to_self() {
    let (_, client, admin, _) = gov_setup();
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &admin);
}

#[test]
#[should_panic(expected = "Error(Contract, #55)")]
fn test_propose_to_contract_address_panics() {
    // Build setup manually so we have the contract's own address (`cid`).
    // Passing `cid` as the candidate replicates "the contract tries to own its
    // own role" — `env.current_contract_address()` inside `propose_role_transfer`
    // returns `cid`, so the guard fires exactly as intended.
    let env = Env::default();
    env.mock_all_auths();
    let cid = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &cid);
    let admin = Address::generate(&env);
    client.set_admin(&admin);
    client.migrate_roles(&admin);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &cid);
}

// ── §3  Proposal acceptance ───────────────────────────────────────────────────

#[test]
fn test_accept_role_transfer_succeeds() {
    let (env, client, admin, _) = gov_setup();
    let candidate = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &candidate);
    client.accept_role_transfer(&RoleType::ProtocolConfig, &candidate);

    assert_eq!(client.get_role(&RoleType::ProtocolConfig), candidate);
    assert!(
        client.get_pending_role(&RoleType::ProtocolConfig).is_none(),
        "pending slot must be cleared after acceptance"
    );
}

#[test]
fn test_accept_emits_role_transferred_event_with_ledger_sequence() {
    let (env, client, admin, _) = gov_setup();
    let candidate = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::EmergencyPause, &candidate);
    let seq = env.ledger().sequence();
    client.accept_role_transfer(&RoleType::EmergencyPause, &candidate);

    let ev = decode_event::<RoleTransferredEvent>(&env, &env.events().all(), ROLE_TRANSFERRED)
        .expect("role_transferred event must be emitted");
    assert_eq!(ev.role, RoleType::EmergencyPause);
    assert_eq!(ev.old_authority, admin);
    assert_eq!(ev.new_authority, candidate);
    assert_eq!(ev.ledger_sequence, seq);
}

#[test]
#[should_panic(expected = "Error(Contract, #52)")]
fn test_accept_with_no_pending_proposal_panics() {
    let (env, client, _, _) = gov_setup();
    let dummy = Address::generate(&env);
    client.accept_role_transfer(&RoleType::ProtocolConfig, &dummy);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_accept_wrong_candidate_panics() {
    let (env, client, admin, _) = gov_setup();
    let candidate = Address::generate(&env);
    let wrong = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &candidate);
    client.accept_role_transfer(&RoleType::ProtocolConfig, &wrong);
}

#[test]
#[should_panic(expected = "Error(Contract, #53)")]
fn test_accept_after_expiry_panics() {
    let (env, client, admin, _) = gov_setup();
    let candidate = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &candidate);
    env.ledger().with_mut(|l| l.timestamp += 604_801);
    client.accept_role_transfer(&RoleType::ProtocolConfig, &candidate);
}

#[test]
fn test_accept_exactly_at_deadline_succeeds() {
    let (env, client, admin, _) = gov_setup();
    let candidate = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::CollectionAdmin, &candidate);
    // Exactly at expires_at — strict `>` means this is still valid
    env.ledger().with_mut(|l| l.timestamp += 604_800);
    client.accept_role_transfer(&RoleType::CollectionAdmin, &candidate);
    assert_eq!(client.get_role(&RoleType::CollectionAdmin), candidate);
}

// ── §4  Proposal cancellation ─────────────────────────────────────────────────

#[test]
fn test_cancel_role_proposal_clears_pending() {
    let (env, client, admin, _) = gov_setup();
    let candidate = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &candidate);
    client.cancel_role_proposal(&admin, &RoleType::ProtocolConfig);
    assert!(client.get_pending_role(&RoleType::ProtocolConfig).is_none());
}

#[test]
fn test_cancel_role_proposal_holder_unchanged() {
    let (env, client, admin, _) = gov_setup();
    let candidate = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::Upgrade, &candidate);
    client.cancel_role_proposal(&admin, &RoleType::Upgrade);
    assert_eq!(client.get_role(&RoleType::Upgrade), admin);
}

#[test]
fn test_cancel_emits_event_with_ledger_sequence() {
    let (env, client, admin, _) = gov_setup();
    let candidate = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::EmergencyPause, &candidate);
    let seq = env.ledger().sequence();
    client.cancel_role_proposal(&admin, &RoleType::EmergencyPause);

    let ev = decode_event::<RoleProposalCancelledEvent>(
        &env,
        &env.events().all(),
        ROLE_PROPOSAL_CANCELLED,
    )
    .expect("role_proposal_cancelled event must be emitted");
    assert_eq!(ev.role, RoleType::EmergencyPause);
    assert_eq!(ev.current_authority, admin);
    assert_eq!(ev.cancelled_candidate, candidate);
    assert_eq!(ev.ledger_sequence, seq);
}

#[test]
fn test_former_candidate_cannot_accept_after_cancel() {
    let (env, client, admin, _) = gov_setup();
    let candidate = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &candidate);
    client.cancel_role_proposal(&admin, &RoleType::ProtocolConfig);
    let res = client.try_accept_role_transfer(&RoleType::ProtocolConfig, &candidate);
    assert!(res.is_err(), "cancelled candidate must not be able to accept");
}

#[test]
#[should_panic(expected = "Error(Contract, #52)")]
fn test_cancel_with_nothing_pending_panics() {
    let (_, client, admin, _) = gov_setup();
    client.cancel_role_proposal(&admin, &RoleType::ProtocolConfig);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_cancel_by_wrong_caller_panics() {
    let (env, client, admin, other) = gov_setup();
    let candidate = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &candidate);
    client.cancel_role_proposal(&other, &RoleType::ProtocolConfig);
}

// ── §5  Proposal overwrite ────────────────────────────────────────────────────

#[test]
fn test_overwrite_replaces_pending_candidate() {
    let (env, client, admin, _) = gov_setup();
    let first = Address::generate(&env);
    let second = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &first);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &second);

    let pending = client.get_pending_role(&RoleType::ProtocolConfig).unwrap();
    assert_eq!(pending.candidate, second, "second proposal must be active");
}

#[test]
fn test_overwritten_candidate_cannot_accept() {
    let (env, client, admin, _) = gov_setup();
    let first = Address::generate(&env);
    let second = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &first);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &second);
    let res = client.try_accept_role_transfer(&RoleType::ProtocolConfig, &first);
    assert!(res.is_err(), "superseded candidate must not be able to accept");
}

#[test]
fn test_new_candidate_can_accept_after_overwrite() {
    let (env, client, admin, _) = gov_setup();
    let first = Address::generate(&env);
    let second = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::CollectionAdmin, &first);
    client.propose_role_transfer(&admin, &RoleType::CollectionAdmin, &second);
    client.accept_role_transfer(&RoleType::CollectionAdmin, &second);
    assert_eq!(client.get_role(&RoleType::CollectionAdmin), second);
}

#[test]
fn test_overwrite_emits_overwritten_event_with_old_candidate() {
    let (env, client, admin, _) = gov_setup();
    let first = Address::generate(&env);
    let second = Address::generate(&env);
    let now1 = env.ledger().timestamp();
    client.propose_role_transfer(&admin, &RoleType::Upgrade, &first);
    // Advance ledger so the two proposals get distinct timestamps
    env.ledger().with_mut(|l| l.timestamp += 100);
    let now2 = env.ledger().timestamp();
    client.propose_role_transfer(&admin, &RoleType::Upgrade, &second);

    let ev = decode_event::<RoleProposalOverwrittenEvent>(
        &env,
        &env.events().all(),
        ROLE_PROPOSAL_OVERWRITTEN,
    )
    .expect("role_proposal_overwritten event must be emitted");
    assert_eq!(ev.role, RoleType::Upgrade);
    assert_eq!(ev.current_authority, admin);
    assert_eq!(ev.old_candidate, first);
    assert_eq!(ev.old_expires_at, now1 + 604_800);
    assert_eq!(ev.new_candidate, second);
    assert_eq!(ev.new_expires_at, now2 + 604_800);
}

#[test]
fn test_overwrite_no_overwritten_event_on_first_proposal() {
    let (env, client, admin, _) = gov_setup();
    let candidate = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &candidate);
    // No overwrite event on the first proposal
    assert!(
        !has_event_topic(&env.events().all(), ROLE_PROPOSAL_OVERWRITTEN),
        "no overwrite event must be emitted for the first proposal"
    );
}

// ── §6  Fallback semantics (Admin fallback when no explicit holder) ────────────

#[test]
fn test_role_falls_back_to_admin_without_explicit_holder() {
    let env = Env::default();
    env.mock_all_auths();
    let cid = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &cid);
    let admin = Address::generate(&env);
    client.set_admin(&admin);
    // No migrate_roles — no explicit holders assigned
    assert_eq!(client.get_role(&RoleType::ProtocolConfig), admin);
    assert_eq!(client.get_role(&RoleType::EmergencyPause), admin);
    assert_eq!(client.get_role(&RoleType::CollectionAdmin), admin);
    assert_eq!(client.get_role(&RoleType::Upgrade), admin);
}

#[test]
fn test_admin_can_exercise_role_when_no_explicit_holder() {
    let env = Env::default();
    env.mock_all_auths();
    let cid = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &cid);
    let admin = Address::generate(&env);
    client.set_admin(&admin);
    // Admin implicitly holds all roles — pause must succeed
    client.admin_pause(&admin);
    assert!(client.is_paused());
}

#[test]
fn test_explicit_holder_has_priority_over_admin_fallback() {
    let (env, client, admin, _) = gov_setup();
    let specialist = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &specialist);
    client.accept_role_transfer(&RoleType::ProtocolConfig, &specialist);

    assert_eq!(client.get_role(&RoleType::ProtocolConfig), specialist);
    // Admin no longer resolves as ProtocolConfig
    assert_ne!(client.get_role(&RoleType::ProtocolConfig), admin);
}

// ── §7  Stale-holder / role-confusion attacks ─────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_old_holder_blocked_after_role_rotation() {
    let (env, client, admin, _) = gov_setup();
    let new_config = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &new_config);
    client.accept_role_transfer(&RoleType::ProtocolConfig, &new_config);
    // admin used to hold ProtocolConfig — must now be rejected
    client.set_protocol_fee(&admin, &100u32);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_stale_admin_cannot_pause_after_emergency_pause_rotated() {
    let (env, client, admin, _) = gov_setup();
    let pause_holder = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::EmergencyPause, &pause_holder);
    client.accept_role_transfer(&RoleType::EmergencyPause, &pause_holder);
    // Admin is no longer the EmergencyPause holder
    client.admin_pause(&admin);
}

#[test]
fn test_new_holder_can_act_after_rotation() {
    let (env, client, admin, _) = gov_setup();
    let pause_holder = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::EmergencyPause, &pause_holder);
    client.accept_role_transfer(&RoleType::EmergencyPause, &pause_holder);
    client.admin_pause(&pause_holder);
    assert!(client.is_paused());
    client.admin_unpause(&pause_holder);
    assert!(!client.is_paused());
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_old_collection_admin_cannot_revoke_after_rotation() {
    let (env, client, admin, _) = gov_setup();
    let new_col_admin = Address::generate(&env);
    let artist = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::CollectionAdmin, &new_col_admin);
    client.accept_role_transfer(&RoleType::CollectionAdmin, &new_col_admin);
    // admin no longer holds CollectionAdmin
    client.revoke_artist(&admin, &artist);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_stale_protocol_config_holder_cannot_set_fee_after_rotation() {
    let (env, client, admin, _) = gov_setup();
    let new_config = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &new_config);
    client.accept_role_transfer(&RoleType::ProtocolConfig, &new_config);
    // Admin tries to update price bounds — must fail
    client.set_price_bounds(&admin, &1_000_000_i128, &100_000_000_i128);
}

// ── §8  Expired-proposal policy ───────────────────────────────────────────────

#[test]
fn test_expired_proposal_remains_in_storage() {
    let (env, client, admin, _) = gov_setup();
    let candidate = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &candidate);
    // Advance past expiry — the proposal is NOT auto-cleared
    env.ledger().with_mut(|l| l.timestamp += 604_801);
    assert!(
        client.get_pending_role(&RoleType::ProtocolConfig).is_some(),
        "expired proposal must not be auto-cleared"
    );
    assert_eq!(client.get_role(&RoleType::ProtocolConfig), admin);
}

#[test]
fn test_new_proposal_after_expired_one_succeeds() {
    let (env, client, admin, _) = gov_setup();
    let first = Address::generate(&env);
    let second = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::CollectionAdmin, &first);
    env.ledger().with_mut(|l| l.timestamp += 604_801);
    // Admin issues a new proposal overwriting the stale one
    client.propose_role_transfer(&admin, &RoleType::CollectionAdmin, &second);
    let pending = client.get_pending_role(&RoleType::CollectionAdmin).unwrap();
    assert_eq!(pending.candidate, second);
    client.accept_role_transfer(&RoleType::CollectionAdmin, &second);
    assert_eq!(client.get_role(&RoleType::CollectionAdmin), second);
}

// ── §9  Multi-role authorization matrix ──────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_emergency_pause_holder_cannot_set_protocol_fee() {
    let (env, client, admin, _) = gov_setup();
    let pause_holder = Address::generate(&env);
    let config_holder = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::EmergencyPause, &pause_holder);
    client.accept_role_transfer(&RoleType::EmergencyPause, &pause_holder);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &config_holder);
    client.accept_role_transfer(&RoleType::ProtocolConfig, &config_holder);
    // EmergencyPause holder must NOT be able to call a ProtocolConfig function
    client.set_protocol_fee(&pause_holder, &100u32);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_protocol_config_holder_cannot_pause() {
    let (env, client, admin, _) = gov_setup();
    let config_holder = Address::generate(&env);
    let pause_holder = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &config_holder);
    client.accept_role_transfer(&RoleType::ProtocolConfig, &config_holder);
    client.propose_role_transfer(&admin, &RoleType::EmergencyPause, &pause_holder);
    client.accept_role_transfer(&RoleType::EmergencyPause, &pause_holder);
    // ProtocolConfig holder must NOT be able to pause
    client.admin_pause(&config_holder);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_upgrade_role_cannot_revoke_artist() {
    let (env, client, admin, _) = gov_setup();
    let upgrade_holder = Address::generate(&env);
    let col_admin_holder = Address::generate(&env);
    let artist = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::Upgrade, &upgrade_holder);
    client.accept_role_transfer(&RoleType::Upgrade, &upgrade_holder);
    client.propose_role_transfer(&admin, &RoleType::CollectionAdmin, &col_admin_holder);
    client.accept_role_transfer(&RoleType::CollectionAdmin, &col_admin_holder);
    // Upgrade role holder must NOT be able to revoke artists
    client.revoke_artist(&upgrade_holder, &artist);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_collection_admin_cannot_set_fee() {
    let (env, client, admin, _) = gov_setup();
    let col_admin_holder = Address::generate(&env);
    let config_holder = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::CollectionAdmin, &col_admin_holder);
    client.accept_role_transfer(&RoleType::CollectionAdmin, &col_admin_holder);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &config_holder);
    client.accept_role_transfer(&RoleType::ProtocolConfig, &config_holder);
    // CollectionAdmin must NOT be able to set protocol fee
    client.set_protocol_fee(&col_admin_holder, &500u32);
}

#[test]
fn test_all_four_roles_independently_exercisable() {
    let (env, client, admin, _) = gov_setup();
    let config_holder = Address::generate(&env);
    let pause_holder = Address::generate(&env);
    let col_admin_holder = Address::generate(&env);
    let upgrade_holder = Address::generate(&env);
    let artist = Address::generate(&env);

    // Distribute all four roles to distinct addresses
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &config_holder);
    client.accept_role_transfer(&RoleType::ProtocolConfig, &config_holder);
    client.propose_role_transfer(&admin, &RoleType::EmergencyPause, &pause_holder);
    client.accept_role_transfer(&RoleType::EmergencyPause, &pause_holder);
    client.propose_role_transfer(&admin, &RoleType::CollectionAdmin, &col_admin_holder);
    client.accept_role_transfer(&RoleType::CollectionAdmin, &col_admin_holder);
    client.propose_role_transfer(&admin, &RoleType::Upgrade, &upgrade_holder);
    client.accept_role_transfer(&RoleType::Upgrade, &upgrade_holder);

    // Verify each role holder can exercise only its own axis
    client.set_protocol_fee(&config_holder, &200u32);
    assert_eq!(client.get_protocol_fee(), 200u32);

    client.admin_pause(&pause_holder);
    assert!(client.is_paused());
    client.admin_unpause(&pause_holder);

    client.revoke_artist(&col_admin_holder, &artist);

    // Upgrade role: admin is no longer the Upgrade holder — must be rejected
    let res = client.try_migrate(&admin);
    assert!(res.is_err(), "admin must be Unauthorized for Upgrade role after rotation");

    // upgrade_holder is the Upgrade holder — migration succeeds (no prior data)
    client.migrate(&upgrade_holder);
}

// ── §10  Pause × governance interaction ──────────────────────────────────────

#[test]
fn test_governance_ops_not_blocked_by_global_pause() {
    let (env, client, admin, _) = gov_setup();
    let candidate = Address::generate(&env);

    client.admin_pause(&admin);
    assert!(client.is_paused());

    // propose / cancel / accept must all work while paused
    client.propose_role_transfer(&admin, &RoleType::CollectionAdmin, &candidate);
    assert!(client.get_pending_role(&RoleType::CollectionAdmin).is_some());

    client.cancel_role_proposal(&admin, &RoleType::CollectionAdmin);
    assert!(client.get_pending_role(&RoleType::CollectionAdmin).is_none());

    client.propose_role_transfer(&admin, &RoleType::CollectionAdmin, &candidate);
    client.accept_role_transfer(&RoleType::CollectionAdmin, &candidate);
    assert_eq!(client.get_role(&RoleType::CollectionAdmin), candidate);

    client.admin_unpause(&admin);
    assert!(!client.is_paused());
}

#[test]
fn test_admin_transfer_not_blocked_by_pause() {
    let (env, client, admin, _) = gov_setup();
    let new_admin = Address::generate(&env);
    client.admin_pause(&admin);
    client.transfer_admin(&admin, &new_admin);
    client.accept_admin(&new_admin);
    assert_eq!(client.get_admin(), Some(new_admin));
}

// ── §11  migrate_roles edge cases ─────────────────────────────────────────────

#[test]
fn test_migrate_roles_assigns_all_four_roles() {
    let env = Env::default();
    env.mock_all_auths();
    let cid = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &cid);
    let admin = Address::generate(&env);
    client.set_admin(&admin);
    client.migrate_roles(&admin);

    for role in [
        RoleType::ProtocolConfig,
        RoleType::EmergencyPause,
        RoleType::CollectionAdmin,
        RoleType::Upgrade,
    ] {
        assert_eq!(
            client.get_role(&role),
            admin,
            "migrate_roles must assign admin to every role"
        );
    }
}

#[test]
fn test_migrate_roles_is_idempotent() {
    let (_, client, admin, _) = gov_setup();
    // Already ran in gov_setup; calling again must be a no-op
    client.migrate_roles(&admin);
    assert_eq!(client.get_role(&RoleType::ProtocolConfig), admin);
    assert_eq!(client.get_role(&RoleType::EmergencyPause), admin);
    assert_eq!(client.get_role(&RoleType::CollectionAdmin), admin);
    assert_eq!(client.get_role(&RoleType::Upgrade), admin);
}

#[test]
fn test_migrate_roles_does_not_overwrite_already_rotated_role() {
    let (env, client, admin, _) = gov_setup();
    let specialist = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &specialist);
    client.accept_role_transfer(&RoleType::ProtocolConfig, &specialist);

    // Re-run migrate_roles — must not overwrite the rotated role
    client.migrate_roles(&admin);
    assert_eq!(
        client.get_role(&RoleType::ProtocolConfig),
        specialist,
        "migrate_roles must not overwrite an already-assigned role"
    );
    assert_eq!(client.get_role(&RoleType::EmergencyPause), admin);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_migrate_roles_by_non_admin_panics() {
    let (_, client, _, other) = gov_setup();
    client.migrate_roles(&other);
}

// ── §12  View functions ───────────────────────────────────────────────────────

#[test]
fn test_get_role_returns_explicit_holder() {
    let (env, client, admin, _) = gov_setup();
    let holder = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::Upgrade, &holder);
    client.accept_role_transfer(&RoleType::Upgrade, &holder);
    assert_eq!(client.get_role(&RoleType::Upgrade), holder);
}

#[test]
fn test_get_pending_role_none_when_no_proposal() {
    let (_, client, _, _) = gov_setup();
    assert!(client.get_pending_role(&RoleType::ProtocolConfig).is_none());
    assert!(client.get_pending_role(&RoleType::EmergencyPause).is_none());
    assert!(client.get_pending_role(&RoleType::CollectionAdmin).is_none());
    assert!(client.get_pending_role(&RoleType::Upgrade).is_none());
}

#[test]
fn test_get_pending_role_returns_correct_proposal() {
    let (env, client, admin, _) = gov_setup();
    let candidate = Address::generate(&env);
    let now = env.ledger().timestamp();
    client.propose_role_transfer(&admin, &RoleType::CollectionAdmin, &candidate);

    let pending = client.get_pending_role(&RoleType::CollectionAdmin).unwrap();
    assert_eq!(pending.candidate, candidate);
    assert_eq!(pending.expires_at, now + 604_800);
}

// ── §13  Event audit field coverage ──────────────────────────────────────────

#[test]
fn test_proposal_event_carries_all_audit_fields() {
    let (env, client, admin, _) = gov_setup();
    let candidate = Address::generate(&env);
    let now = env.ledger().timestamp();
    client.propose_role_transfer(&admin, &RoleType::Upgrade, &candidate);

    let ev = decode_event::<RoleTransferProposedEvent>(
        &env,
        &env.events().all(),
        ROLE_TRANSFER_PROPOSED,
    )
    .expect("role_transfer_proposed event must be emitted");
    assert_eq!(ev.role, RoleType::Upgrade);
    assert_eq!(ev.current_authority, admin);
    assert_eq!(ev.proposed_authority, candidate);
    assert_eq!(ev.expires_at, now + 604_800);
}

#[test]
fn test_cancelled_event_carries_all_audit_fields() {
    let (env, client, admin, _) = gov_setup();
    let candidate = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &candidate);
    let seq = env.ledger().sequence();
    client.cancel_role_proposal(&admin, &RoleType::ProtocolConfig);

    let ev = decode_event::<RoleProposalCancelledEvent>(
        &env,
        &env.events().all(),
        ROLE_PROPOSAL_CANCELLED,
    )
    .expect("role_proposal_cancelled event must be emitted");
    assert_eq!(ev.role, RoleType::ProtocolConfig);
    assert_eq!(ev.current_authority, admin);
    assert_eq!(ev.cancelled_candidate, candidate);
    assert_eq!(ev.ledger_sequence, seq);
}

#[test]
fn test_transferred_event_carries_old_and_new_holder_with_sequence() {
    let (env, client, admin, _) = gov_setup();
    let candidate = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &candidate);
    let seq = env.ledger().sequence();
    client.accept_role_transfer(&RoleType::ProtocolConfig, &candidate);

    let ev = decode_event::<RoleTransferredEvent>(&env, &env.events().all(), ROLE_TRANSFERRED)
        .expect("role_transferred event must be emitted");
    assert_eq!(ev.role, RoleType::ProtocolConfig);
    assert_eq!(ev.old_authority, admin);
    assert_eq!(ev.new_authority, candidate);
    assert_eq!(ev.ledger_sequence, seq);
}

// ── §14  Complete round-trip lifecycle ────────────────────────────────────────

#[test]
fn test_full_governance_lifecycle() {
    let (env, client, admin, _) = gov_setup();
    let step1 = Address::generate(&env);
    let step2 = Address::generate(&env);

    // Phase A: propose → accept
    client.propose_role_transfer(&admin, &RoleType::EmergencyPause, &step1);
    client.accept_role_transfer(&RoleType::EmergencyPause, &step1);
    assert_eq!(client.get_role(&RoleType::EmergencyPause), step1);

    // Phase B: new holder proposes to step2
    client.propose_role_transfer(&step1, &RoleType::EmergencyPause, &step2);
    assert_eq!(
        client.get_role(&RoleType::EmergencyPause),
        step1,
        "holder must not change during proposal"
    );

    // Phase C: step1 changes mind and cancels
    client.cancel_role_proposal(&step1, &RoleType::EmergencyPause);
    assert!(client.get_pending_role(&RoleType::EmergencyPause).is_none());
    assert_eq!(client.get_role(&RoleType::EmergencyPause), step1);

    // Phase D: step1 re-proposes and step2 accepts
    client.propose_role_transfer(&step1, &RoleType::EmergencyPause, &step2);
    client.accept_role_transfer(&RoleType::EmergencyPause, &step2);
    assert_eq!(client.get_role(&RoleType::EmergencyPause), step2);

    // Phase E: step1 is now blocked
    let blocked = client.try_admin_pause(&step1);
    assert!(blocked.is_err(), "step1 must be blocked after rotation");

    // Phase F: step2 can exercise the role
    client.admin_pause(&step2);
    assert!(client.is_paused());
}

// ── §15  Wrong-caller edge cases ─────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_propose_by_non_holder_panics() {
    let (env, client, _, other) = gov_setup();
    let candidate = Address::generate(&env);
    client.propose_role_transfer(&other, &RoleType::ProtocolConfig, &candidate);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_cancel_by_candidate_not_holder_panics() {
    let (env, client, admin, _) = gov_setup();
    let candidate = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::Upgrade, &candidate);
    // Candidate is not the holder — only the holder can cancel
    client.cancel_role_proposal(&candidate, &RoleType::Upgrade);
}

// ── §16  Individual role-gate spot checks ────────────────────────────────────

#[test]
fn test_protocol_config_gates_treasury() {
    let (env, client, admin, _) = gov_setup();
    let specialist = Address::generate(&env);
    let treasury = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &specialist);
    client.accept_role_transfer(&RoleType::ProtocolConfig, &specialist);
    client.set_treasury(&specialist, &treasury);
    assert_eq!(client.get_treasury(), Some(treasury));
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_non_protocol_config_cannot_set_treasury() {
    let (env, client, admin, _) = gov_setup();
    let pause_holder = Address::generate(&env);
    let treasury = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::EmergencyPause, &pause_holder);
    client.accept_role_transfer(&RoleType::EmergencyPause, &pause_holder);
    // pause_holder has EmergencyPause, not ProtocolConfig
    client.set_treasury(&pause_holder, &treasury);
}

#[test]
fn test_emergency_pause_gates_collection_pause() {
    let (env, client, admin, _) = gov_setup();
    let pause_holder = Address::generate(&env);
    let collection = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::EmergencyPause, &pause_holder);
    client.accept_role_transfer(&RoleType::EmergencyPause, &pause_holder);
    client.pause_collection(&pause_holder, &collection);
    assert!(client.is_collection_paused(&collection));
}

#[test]
fn test_collection_admin_gates_reinstate_artist() {
    let (env, client, admin, _) = gov_setup();
    let col_admin = Address::generate(&env);
    let artist = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::CollectionAdmin, &col_admin);
    client.accept_role_transfer(&RoleType::CollectionAdmin, &col_admin);
    client.revoke_artist(&col_admin, &artist);
    client.reinstate_artist(&col_admin, &artist);
}

#[test]
fn test_protocol_config_gates_price_bounds() {
    let (env, client, admin, _) = gov_setup();
    let config_holder = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::ProtocolConfig, &config_holder);
    client.accept_role_transfer(&RoleType::ProtocolConfig, &config_holder);
    client.set_price_bounds(&config_holder, &1_000_000_i128, &100_000_000_i128);
    let (min, max) = client.get_price_bounds();
    assert_eq!(min, Some(1_000_000_i128));
    assert_eq!(max, Some(100_000_000_i128));
}
