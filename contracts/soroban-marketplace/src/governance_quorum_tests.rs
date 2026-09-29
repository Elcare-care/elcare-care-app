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

// ── §11  Execute-after-cancel is blocked (GovernanceProposalCancelled = 72) ──

/// Cancelling a proposal must block execution, not just approval.
/// Both approve and execute must return GovernanceProposalCancelled = 72.
#[test]
#[should_panic(expected = "Error(Contract, #72)")]
fn test_governance_execute_after_cancel_panics() {
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
        &Some(200u32),
        &None::<bool>,
    );
    // Reach threshold so execute would otherwise succeed.
    client.approve_governance_action(&signers.get(0).unwrap(), &pid);
    client.approve_governance_action(&signers.get(1).unwrap(), &pid);
    // Now cancel — execution must still be blocked.
    client.cancel_governance_action(&admin, &pid);
    // GovernanceProposalCancelled = 72
    client.execute_governance_action(&admin, &pid);
}

// ── §12  Approve-after-execute is blocked (GovernanceProposalAlreadyExecuted = 71)

/// Once a proposal is executed the executed flag must block further approvals.
#[test]
#[should_panic(expected = "Error(Contract, #71)")]
fn test_governance_approve_after_execute_panics() {
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
        &Some(100u32),
        &None::<bool>,
    );
    client.approve_governance_action(&signers.get(0).unwrap(), &pid);
    client.approve_governance_action(&signers.get(1).unwrap(), &pid);
    client.execute_governance_action(&admin, &pid);
    // Third signer tries to approve an already-executed proposal.
    // GovernanceProposalAlreadyExecuted = 71
    client.approve_governance_action(&signers.get(2).unwrap(), &pid);
}

// ── §13  Propose with past expiry is rejected (GovernanceProposalExpired = 70)

/// propose_governance_action with expires_at <= current timestamp must panic.
#[test]
#[should_panic(expected = "Error(Contract, #70)")]
fn test_governance_propose_with_past_expiry_panics() {
    let (env, client, admin) = quorum_setup();
    let signers = make_signers(&env, 1);
    let now = env.ledger().timestamp();
    // Expiry at exactly now — already expired.
    client.propose_governance_action(
        &admin,
        &GovernanceProposalType::FeeIncrease,
        &signers,
        &1u32,
        &now, // <= now → GovernanceProposalExpired = 70
        &None::<Address>,
        &Some(100u32),
        &None::<bool>,
    );
}

// ── §14  Concurrent proposals are independent ─────────────────────────────────

/// Two proposals created in sequence must have independent IDs and not
/// interfere with each other's approval or execution state.
#[test]
fn test_governance_proposal_overwrite() {
    let (env, client, admin) = quorum_setup();
    let signers_a = make_signers(&env, 2);
    let signers_b = make_signers(&env, 2);
    let expires = future_expires(&env);

    // Proposal A — FeeIncrease to 100 bps.
    let pid_a = client.propose_governance_action(
        &admin,
        &GovernanceProposalType::FeeIncrease,
        &signers_a,
        &2u32,
        &expires,
        &None::<Address>,
        &Some(100u32),
        &None::<bool>,
    );
    // Proposal B — FeeIncrease to 200 bps.
    let pid_b = client.propose_governance_action(
        &admin,
        &GovernanceProposalType::FeeIncrease,
        &signers_b,
        &2u32,
        &expires,
        &None::<Address>,
        &Some(200u32),
        &None::<bool>,
    );

    // The two proposals must have distinct IDs.
    assert_ne!(pid_a, pid_b);

    // Approve and execute proposal B only.
    client.approve_governance_action(&signers_b.get(0).unwrap(), &pid_b);
    client.approve_governance_action(&signers_b.get(1).unwrap(), &pid_b);
    client.execute_governance_action(&admin, &pid_b);

    // Proposal B executed → fee = 200.
    assert_eq!(client.get_protocol_fee(), 200u32);

    // Proposal A is still pending and unaffected.
    let prop_a = client.get_governance_proposal(&pid_a);
    assert!(!prop_a.executed);
    assert!(!prop_a.cancelled);

    // Proposal A's approvals are independent.
    assert_eq!(client.get_governance_approvals(&pid_a).len(), 0);

    // Now execute proposal A — fee should move to 100.
    client.approve_governance_action(&signers_a.get(0).unwrap(), &pid_a);
    client.approve_governance_action(&signers_a.get(1).unwrap(), &pid_a);
    client.execute_governance_action(&admin, &pid_a);
    assert_eq!(client.get_protocol_fee(), 100u32);
}

// ── §15  GlobalPause unpause (payload_bool = false) ───────────────────────────

/// A GlobalPause proposal with payload_bool = false must clear the paused
/// state when executed.
#[test]
fn test_governance_global_pause_unpause() {
    let (env, client, admin) = quorum_setup();
    let signers = make_signers(&env, 1);
    let expires = future_expires(&env);

    // First pause the contract.
    client.admin_pause(&admin);
    assert!(client.is_paused());

    // Propose and execute GlobalPause(false) to unpause.
    let pid = client.propose_governance_action(
        &admin,
        &GovernanceProposalType::GlobalPause,
        &signers,
        &1u32,
        &expires,
        &None::<Address>,
        &None::<u32>,
        &Some(false),
    );
    client.approve_governance_action(&signers.get(0).unwrap(), &pid);
    client.execute_governance_action(&admin, &pid);

    assert!(!client.is_paused());
}

// ── §16  TreasuryRotation full end-to-end cycle ────────────────────────────────

/// Full cycle: propose TreasuryRotation with 3 signers and threshold 2,
/// get 2 approvals, execute, verify treasury storage is updated.
#[test]
fn test_governance_treasury_rotation_full_cycle() {
    let (env, client, admin) = quorum_setup();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let charlie = Address::generate(&env);
    let mut signers = soroban_sdk::Vec::new(&env);
    signers.push_back(alice.clone());
    signers.push_back(bob.clone());
    signers.push_back(charlie.clone());
    let new_treasury = Address::generate(&env);
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

    // Only 2 of 3 required approvals.
    client.approve_governance_action(&alice, &pid);
    client.approve_governance_action(&bob, &pid);

    // Threshold met — execute.
    client.execute_governance_action(&admin, &pid);

    // Treasury must now be new_treasury.
    assert_eq!(client.get_treasury(), Some(new_treasury));

    // Proposal must be marked executed.
    assert!(client.get_governance_proposal(&pid).executed);

    // Charlie's approval is no longer needed — charlie cannot approve after execution.
    let result = client.try_approve_governance_action(&charlie, &pid);
    assert!(result.is_err());
}

// ── §17  FeeIncrease full end-to-end cycle ────────────────────────────────────

/// Full cycle for FeeIncrease: 3 signers, threshold 2, verify fee storage.
#[test]
fn test_governance_fee_increase_full_cycle() {
    let (env, client, admin) = quorum_setup();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let charlie = Address::generate(&env);
    let mut signers = soroban_sdk::Vec::new(&env);
    signers.push_back(alice.clone());
    signers.push_back(bob.clone());
    signers.push_back(charlie.clone());
    let expires = future_expires(&env);

    let pid = client.propose_governance_action(
        &admin,
        &GovernanceProposalType::FeeIncrease,
        &signers,
        &2u32,
        &expires,
        &None::<Address>,
        &Some(750u32), // 7.5%
        &None::<bool>,
    );

    client.approve_governance_action(&alice, &pid);
    client.approve_governance_action(&bob, &pid);
    client.execute_governance_action(&admin, &pid);

    assert_eq!(client.get_protocol_fee(), 750u32);
    assert!(client.get_governance_proposal(&pid).executed);
}

// ── §18  GlobalPause full end-to-end cycle ────────────────────────────────────

/// Full cycle for GlobalPause: 3 signers, threshold 2, verify is_paused().
#[test]
fn test_governance_global_pause_full_cycle() {
    let (env, client, admin) = quorum_setup();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let charlie = Address::generate(&env);
    let mut signers = soroban_sdk::Vec::new(&env);
    signers.push_back(alice.clone());
    signers.push_back(bob.clone());
    signers.push_back(charlie.clone());
    let expires = future_expires(&env);

    assert!(!client.is_paused());

    let pid = client.propose_governance_action(
        &admin,
        &GovernanceProposalType::GlobalPause,
        &signers,
        &2u32,
        &expires,
        &None::<Address>,
        &None::<u32>,
        &Some(true),
    );

    client.approve_governance_action(&alice, &pid);
    client.approve_governance_action(&bob, &pid);
    client.execute_governance_action(&admin, &pid);

    assert!(client.is_paused());
    assert!(client.get_governance_proposal(&pid).executed);
}

// ── §19  Threshold not met blocks execute ─────────────────────────────────────

/// test_governance_threshold_not_met_blocks_execute: exactly one of two
/// required approvals — execution must fail with GovernanceThresholdNotMet.
#[test]
fn test_governance_threshold_not_met_blocks_execute() {
    let (env, client, admin) = quorum_setup();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let mut signers = soroban_sdk::Vec::new(&env);
    signers.push_back(alice.clone());
    signers.push_back(bob.clone());
    let expires = future_expires(&env);

    let pid = client.propose_governance_action(
        &admin,
        &GovernanceProposalType::FeeIncrease,
        &signers,
        &2u32, // threshold = 2
        &expires,
        &None::<Address>,
        &Some(500u32),
        &None::<bool>,
    );

    // Only alice approves — one of two required.
    client.approve_governance_action(&alice, &pid);
    assert_eq!(client.get_governance_approvals(&pid).len(), 1);

    // Attempt to execute — must fail with GovernanceThresholdNotMet = 68.
    let result = client.try_execute_governance_action(&admin, &pid);
    match result {
        Err(Ok(MarketplaceError::GovernanceThresholdNotMet)) => {}
        other => panic!("expected GovernanceThresholdNotMet, got {:?}", other),
    }

    // Bob approves — threshold now met.
    client.approve_governance_action(&bob, &pid);
    // Now execution succeeds.
    client.execute_governance_action(&admin, &pid);
    assert_eq!(client.get_protocol_fee(), 500u32);
}

// ── §20  get_governance_proposal returns correct fields ────────────────────────

/// Proposal metadata fields (proposed_by, signers, threshold, executed,
/// cancelled) must be stored and retrieved accurately.
#[test]
fn test_governance_proposal_fields_stored_correctly() {
    let (env, client, admin) = quorum_setup();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let mut signers = soroban_sdk::Vec::new(&env);
    signers.push_back(alice.clone());
    signers.push_back(bob.clone());
    let expires = future_expires(&env);

    let pid = client.propose_governance_action(
        &admin,
        &GovernanceProposalType::TreasuryRotation,
        &signers,
        &2u32,
        &expires,
        &Some(Address::generate(&env)),
        &None::<u32>,
        &None::<bool>,
    );

    let p = client.get_governance_proposal(&pid);
    assert_eq!(p.proposal_id, pid);
    assert_eq!(p.proposed_by, admin);
    assert_eq!(p.threshold, 2u32);
    assert_eq!(p.expires_at, expires);
    assert!(!p.executed);
    assert!(!p.cancelled);
    assert_eq!(p.signers.len(), 2);
}

// ── §21  Cancelling already-cancelled proposal panics (GovernanceProposalCancelled)

#[test]
#[should_panic(expected = "Error(Contract, #72)")]
fn test_governance_cancel_already_cancelled_panics() {
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
    client.cancel_governance_action(&admin, &pid);
    // Second cancel must panic with GovernanceProposalCancelled = 72.
    client.cancel_governance_action(&admin, &pid);
}

// ── §22  Cancelling an already-executed proposal panics (GovernanceProposalAlreadyExecuted)

#[test]
#[should_panic(expected = "Error(Contract, #71)")]
fn test_governance_cancel_already_executed_panics() {
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
    // Cancel after execution must panic with GovernanceProposalAlreadyExecuted = 71.
    client.cancel_governance_action(&admin, &pid);
}
