// governance_quorum_tests.rs — Governance role quorum (Issue #472)
//
// Coverage:
//   - TreasuryRotation: 2-of-3 quorum → treasury updated on execute
//   - FeeIncrease: threshold met → protocol fee bps updated
//   - GlobalPause: EmergencyPause role required; sets pause state on execute
//   - Execute before threshold met panics (GovernanceThresholdNotMet)
//   - Non-signer cannot approve (GovernanceSignerNotAuthorized)
//   - Double-approve by same signer panics (GovernanceAlreadyApproved)
//   - Expired proposal cannot be approved (GovernanceProposalExpired)
//   - Expired proposal cannot be executed (GovernanceProposalExpired)
//   - Already-executed proposal cannot be executed again (replay protection)
//   - Proposer can cancel a pending proposal
//   - Approving a cancelled proposal panics (GovernanceProposalCancelled)
//   - Unauthorized cancel panics (Unauthorized)
//   - View: get_governance_approvals tracks approval count correctly
//   - View: get_governance_proposal panics for unknown ID (GovernanceProposalNotFound)

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Env,
};

// ── Shared setup ─────────────────────────────────────────────────────────────

fn quorum_setup() -> (
    Env,
    MarketplaceContractClient<'static>,
    Address, // admin (all four roles via migrate_roles)
) {
    let env = Env::default();
    env.mock_all_auths();
    let cid = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &cid);
    let admin = Address::generate(&env);
    client.set_admin(&admin);
    client.migrate_roles(&admin);
    (env, client, admin)
}

fn future_expires(env: &Env) -> u64 {
    env.ledger().timestamp() + 3_600
}

fn make_signers(env: &Env, n: u32) -> soroban_sdk::Vec<Address> {
    let mut v = soroban_sdk::Vec::new(env);
    for _ in 0..n {
        v.push_back(Address::generate(env));
    }
    v
}

// ── §1  TreasuryRotation happy path ──────────────────────────────────────────

#[test]
fn test_treasury_rotation_updates_treasury_after_quorum() {
    let (env, client, admin) = quorum_setup();
    let new_treasury = Address::generate(&env);
    let signers = make_signers(&env, 3);
    let expires = future_expires(&env);

    let pid = client.propose_governance_action(
        &admin,
        &GovernanceProposalType::TreasuryRotation,
        &signers,
        &2u32,
        &expires,
        &Some(new_treasury.clone()),
        &None::<u32>,
        &None::<bool>,
    );
    client.approve_governance_action(&signers.get(0).unwrap(), &pid);
    client.approve_governance_action(&signers.get(1).unwrap(), &pid);
    client.execute_governance_action(&admin, &pid);

    assert_eq!(client.get_treasury(), Some(new_treasury));
}

#[test]
fn test_propose_governance_stores_proposal_fields() {
    let (env, client, admin) = quorum_setup();
    let signers = make_signers(&env, 2);
    let expires = future_expires(&env);

    let pid = client.propose_governance_action(
        &admin,
        &GovernanceProposalType::FeeIncrease,
        &signers,
        &2u32,
        &expires,
        &None::<Address>,
        &Some(500u32),
        &None::<bool>,
    );

    let p = client.get_governance_proposal(&pid);
    assert_eq!(p.threshold, 2);
    assert_eq!(p.expires_at, expires);
    assert!(!p.executed);
    assert!(!p.cancelled);
    assert_eq!(p.proposed_by, admin);
}

// ── §2  FeeIncrease happy path ────────────────────────────────────────────────

#[test]
fn test_fee_increase_updates_protocol_fee_bps() {
    let (env, client, admin) = quorum_setup();
    let signers = make_signers(&env, 2);
    let expires = future_expires(&env);

    let pid = client.propose_governance_action(
        &admin,
        &GovernanceProposalType::FeeIncrease,
        &signers,
        &2u32,
        &expires,
        &None::<Address>,
        &Some(300u32),
        &None::<bool>,
    );
    client.approve_governance_action(&signers.get(0).unwrap(), &pid);
    client.approve_governance_action(&signers.get(1).unwrap(), &pid);
    client.execute_governance_action(&admin, &pid);

    assert_eq!(client.get_protocol_fee(), 300u32);
}

// ── §3  GlobalPause happy path ────────────────────────────────────────────────

#[test]
fn test_global_pause_sets_paused_state() {
    let (env, client, admin) = quorum_setup();
    let signers = make_signers(&env, 1);
    let expires = future_expires(&env);

    let pid = client.propose_governance_action(
        &admin,
        &GovernanceProposalType::GlobalPause,
        &signers,
        &1u32,
        &expires,
        &None::<Address>,
        &None::<u32>,
        &Some(true),
    );
    client.approve_governance_action(&signers.get(0).unwrap(), &pid);
    client.execute_governance_action(&admin, &pid);

    assert!(client.is_paused());
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_global_pause_proposal_rejected_without_emergency_pause_role() {
    let (env, client, admin) = quorum_setup();
    // Transfer EmergencyPause away from admin.
    let pause_holder = Address::generate(&env);
    client.propose_role_transfer(&admin, &RoleType::EmergencyPause, &pause_holder);
    client.accept_role_transfer(&RoleType::EmergencyPause, &pause_holder);

    let signers = make_signers(&env, 1);
    let expires = future_expires(&env);
    // Admin no longer holds EmergencyPause → Unauthorized = 5
    client.propose_governance_action(
        &admin,
        &GovernanceProposalType::GlobalPause,
        &signers,
        &1u32,
        &expires,
        &None::<Address>,
        &None::<u32>,
        &Some(true),
    );
}

// ── §4  Error: threshold not met ─────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #68)")]
fn test_execute_before_threshold_panics() {
    let (env, client, admin) = quorum_setup();
    let signers = make_signers(&env, 3);
    let expires = future_expires(&env);

    let pid = client.propose_governance_action(
        &admin,
        &GovernanceProposalType::FeeIncrease,
        &signers,
        &2u32,
        &expires,
        &None::<Address>,
        &Some(200u32),
        &None::<bool>,
    );
    client.approve_governance_action(&signers.get(0).unwrap(), &pid);
    // Only 1 of 2 required approvals — GovernanceThresholdNotMet = 68
    client.execute_governance_action(&admin, &pid);
}

// ── §5  Error: non-signer cannot approve ─────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #73)")]
fn test_non_signer_cannot_approve() {
    let (env, client, admin) = quorum_setup();
    let signers = make_signers(&env, 2);
    let outsider = Address::generate(&env);
    let expires = future_expires(&env);

    let pid = client.propose_governance_action(
        &admin,
        &GovernanceProposalType::FeeIncrease,
        &signers,
        &2u32,
        &expires,
        &None::<Address>,
        &Some(100u32),
        &None::<bool>,
    );
    // GovernanceSignerNotAuthorized = 73
    client.approve_governance_action(&outsider, &pid);
}

// ── §6  Error: double-approve by same signer ─────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #69)")]
fn test_double_approve_panics() {
    let (env, client, admin) = quorum_setup();
    let signers = make_signers(&env, 2);
    let expires = future_expires(&env);

    let pid = client.propose_governance_action(
        &admin,
        &GovernanceProposalType::FeeIncrease,
        &signers,
        &2u32,
        &expires,
        &None::<Address>,
        &Some(100u32),
        &None::<bool>,
    );
    let signer0 = signers.get(0).unwrap();
    client.approve_governance_action(&signer0, &pid);
    // GovernanceAlreadyApproved = 69
    client.approve_governance_action(&signer0, &pid);
}

// ── §7  Error: expired proposal ──────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #70)")]
fn test_approve_expired_proposal_panics() {
    let (env, client, admin) = quorum_setup();
    let signers = make_signers(&env, 2);
    let now = env.ledger().timestamp();
    let expires = now + 60;

    let pid = client.propose_governance_action(
        &admin,
        &GovernanceProposalType::FeeIncrease,
        &signers,
        &1u32,
        &expires,
        &None::<Address>,
        &Some(100u32),
        &None::<bool>,
    );
    env.ledger().with_mut(|l| l.timestamp = now + 61);
    // GovernanceProposalExpired = 70
    client.approve_governance_action(&signers.get(0).unwrap(), &pid);
}

#[test]
#[should_panic(expected = "Error(Contract, #70)")]
fn test_execute_expired_proposal_panics() {
    let (env, client, admin) = quorum_setup();
    let signers = make_signers(&env, 1);
    let now = env.ledger().timestamp();
    let expires = now + 60;

    let pid = client.propose_governance_action(
        &admin,
        &GovernanceProposalType::FeeIncrease,
        &signers,
        &1u32,
        &expires,
        &None::<Address>,
        &Some(100u32),
        &None::<bool>,
    );
    client.approve_governance_action(&signers.get(0).unwrap(), &pid);
    env.ledger().with_mut(|l| l.timestamp = now + 61);
    // GovernanceProposalExpired = 70
    client.execute_governance_action(&admin, &pid);
}

// ── §8  Error: replay protection ─────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #71)")]
fn test_execute_twice_panics() {
    let (env, client, admin) = quorum_setup();
    let signers = make_signers(&env, 1);
    let expires = future_expires(&env);

    let pid = client.propose_governance_action(
        &admin,
        &GovernanceProposalType::FeeIncrease,
        &signers,
        &1u32,
        &expires,
        &None::<Address>,
        &Some(100u32),
        &None::<bool>,
    );
    client.approve_governance_action(&signers.get(0).unwrap(), &pid);
    client.execute_governance_action(&admin, &pid);
    // GovernanceProposalAlreadyExecuted = 71
    client.execute_governance_action(&admin, &pid);
}

// ── §9  Cancel by proposer / role holder ─────────────────────────────────────

#[test]
fn test_proposer_can_cancel_pending_proposal() {
    let (env, client, admin) = quorum_setup();
    let signers = make_signers(&env, 2);
    let expires = future_expires(&env);

    let pid = client.propose_governance_action(
        &admin,
        &GovernanceProposalType::FeeIncrease,
        &signers,
        &2u32,
        &expires,
        &None::<Address>,
        &Some(100u32),
        &None::<bool>,
    );
    client.cancel_governance_action(&admin, &pid);

    assert!(client.get_governance_proposal(&pid).cancelled);
}

#[test]
#[should_panic(expected = "Error(Contract, #72)")]
fn test_approve_after_cancel_panics() {
    let (env, client, admin) = quorum_setup();
    let signers = make_signers(&env, 2);
    let expires = future_expires(&env);

    let pid = client.propose_governance_action(
        &admin,
        &GovernanceProposalType::FeeIncrease,
        &signers,
        &2u32,
        &expires,
        &None::<Address>,
        &Some(100u32),
        &None::<bool>,
    );
    client.cancel_governance_action(&admin, &pid);
    // GovernanceProposalCancelled = 72
    client.approve_governance_action(&signers.get(0).unwrap(), &pid);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_unauthorized_cancel_panics() {
    let (env, client, admin) = quorum_setup();
    let attacker = Address::generate(&env);
    let signers = make_signers(&env, 2);
    let expires = future_expires(&env);

    let pid = client.propose_governance_action(
        &admin,
        &GovernanceProposalType::FeeIncrease,
        &signers,
        &2u32,
        &expires,
        &None::<Address>,
        &Some(100u32),
        &None::<bool>,
    );
    // Unauthorized = 5
    client.cancel_governance_action(&attacker, &pid);
}

// ── §10  View helpers ─────────────────────────────────────────────────────────

#[test]
fn test_get_governance_approvals_tracks_count() {
    let (env, client, admin) = quorum_setup();
    let signers = make_signers(&env, 3);
    let expires = future_expires(&env);

    let pid = client.propose_governance_action(
        &admin,
        &GovernanceProposalType::FeeIncrease,
        &signers,
        &3u32,
        &expires,
        &None::<Address>,
        &Some(100u32),
        &None::<bool>,
    );

    assert_eq!(client.get_governance_approvals(&pid).len(), 0);
    client.approve_governance_action(&signers.get(0).unwrap(), &pid);
    assert_eq!(client.get_governance_approvals(&pid).len(), 1);
    client.approve_governance_action(&signers.get(1).unwrap(), &pid);
    assert_eq!(client.get_governance_approvals(&pid).len(), 2);
    client.approve_governance_action(&signers.get(2).unwrap(), &pid);
    assert_eq!(client.get_governance_approvals(&pid).len(), 3);
}

#[test]
#[should_panic(expected = "Error(Contract, #67)")]
fn test_get_nonexistent_proposal_panics() {
    let (_, client, _) = quorum_setup();
    // GovernanceProposalNotFound = 67
    client.get_governance_proposal(&9999u64);
}
