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
    testutils::{Address as _, Events as _, Ledger},
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
// ── §8  Additional governance coverage (Issue #844) ───────────────────────────
//
// The audit below is included in the PR description. Gaps closed here:
//   - GovernanceProposalNotFound (67) on approve/execute (only the view was covered)
//   - GovernanceThresholdNotMet (68) as a non-panicking assertion, incl. that the
//     guarded execution leaves storage untouched and that the same proposal still
//     executes once the quorum is met
//   - GovernanceProposalAlreadyExecuted (71) on approve and on cancel
//   - GovernanceProposalCancelled (72) on execute (only approve was covered)
//   - GovernanceExecutedEvent / ProposedEvent / ApprovedEvent / CancelledEvent
//     emission, asserted by topic for all three proposal types
//   - two concurrent proposals stay independent (no cross-talk through shared keys)
//   - expiry boundary: the deadline itself is still actionable (`>` comparison)

/// True when an event carrying `symbol` as a topic was emitted.
#[allow(irrefutable_let_patterns)] // ContractEventBody has a single variant in this SDK version
fn has_event_with_topic(events: &soroban_sdk::testutils::ContractEvents, symbol: &str) -> bool {
    use soroban_sdk::xdr::{ContractEventBody, ScVal};
    events.events().iter().any(|e| {
        if let ContractEventBody::V0(body) = &e.body {
            body.topics.iter().any(|t| match t {
                ScVal::Symbol(s) => core::str::from_utf8(s.0.as_slice()).unwrap_or("") == symbol,
                ScVal::String(s) => core::str::from_utf8(s.0.as_slice()).unwrap_or("") == symbol,
                _ => false,
            })
        } else {
            false
        }
    })
}

/// Advance the ledger timestamp to `ts`.
fn set_timestamp(env: &Env, ts: u64) {
    env.ledger().with_mut(|li| li.timestamp = ts);
}

#[test]
fn test_governance_treasury_rotation_full_cycle() {
    let (env, client, admin) = quorum_setup();
    let new_treasury = Address::generate(&env);
    let signers = make_signers(&env, 3);
    let expires = future_expires(&env);
    let treasury_before = client.get_treasury();

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
    assert!(
        has_event_with_topic(&env.events().all(), "gov_proposed"),
        "proposal must be announced"
    );

    client.approve_governance_action(&signers.get(0).unwrap(), &pid);
    assert!(
        has_event_with_topic(&env.events().all(), "gov_approved"),
        "approval must be announced"
    );
    client.approve_governance_action(&signers.get(1).unwrap(), &pid);

    client.execute_governance_action(&admin, &pid);
    assert!(
        has_event_with_topic(&env.events().all(), "gov_executed"),
        "execution must be announced"
    );

    assert_ne!(client.get_treasury(), treasury_before);
    assert_eq!(client.get_treasury(), Some(new_treasury));
    let proposal = client.get_governance_proposal(&pid);
    assert!(proposal.executed);
    assert!(!proposal.cancelled);
    assert_eq!(client.get_governance_approvals(&pid).len(), 2);
}

#[test]
fn test_governance_fee_increase_full_cycle() {
    let (env, client, admin) = quorum_setup();
    let signers = make_signers(&env, 2);
    let expires = future_expires(&env);
    let fee_before = client.get_protocol_fee();

    let pid = client.propose_governance_action(
        &admin,
        &GovernanceProposalType::FeeIncrease,
        &signers,
        &2u32,
        &expires,
        &None::<Address>,
        &Some(350u32),
        &None::<bool>,
    );
    client.approve_governance_action(&signers.get(0).unwrap(), &pid);
    client.approve_governance_action(&signers.get(1).unwrap(), &pid);

    let proposal = client.get_governance_proposal(&pid);
    assert_eq!(proposal.payload_u32, Some(350u32));

    client.execute_governance_action(&admin, &pid);
    assert!(
        has_event_with_topic(&env.events().all(), "gov_executed"),
        "execution must be announced"
    );

    assert_ne!(fee_before, 350u32);
    assert_eq!(client.get_protocol_fee(), 350u32);
    assert!(client.get_governance_proposal(&pid).executed);
}

#[test]
fn test_governance_global_pause_full_cycle() {
    let (env, client, admin) = quorum_setup();
    let signers = make_signers(&env, 2);
    let expires = future_expires(&env);

    let pause = client.propose_governance_action(
        &admin,
        &GovernanceProposalType::GlobalPause,
        &signers,
        &2u32,
        &expires,
        &None::<Address>,
        &None::<u32>,
        &Some(true),
    );
    client.approve_governance_action(&signers.get(0).unwrap(), &pause);
    client.approve_governance_action(&signers.get(1).unwrap(), &pause);
    client.execute_governance_action(&admin, &pause);
    assert!(
        has_event_with_topic(&env.events().all(), "gov_executed"),
        "pausing must be announced"
    );
    assert!(client.is_paused());

    // The same quorum is what lifts the pause again.
    let unpause = client.propose_governance_action(
        &admin,
        &GovernanceProposalType::GlobalPause,
        &signers,
        &2u32,
        &expires,
        &None::<Address>,
        &None::<u32>,
        &Some(false),
    );
    client.approve_governance_action(&signers.get(0).unwrap(), &unpause);
    client.approve_governance_action(&signers.get(1).unwrap(), &unpause);
    client.execute_governance_action(&admin, &unpause);

    assert!(!client.is_paused());
    assert!(client.get_governance_proposal(&unpause).executed);
}

#[test]
fn test_governance_proposal_overwrite() {
    let (env, client, admin) = quorum_setup();
    let signers_a = make_signers(&env, 3);
    let signers_b = make_signers(&env, 2);
    let expires = future_expires(&env);
    let new_treasury = Address::generate(&env);
    let treasury_before = client.get_treasury();

    let fee_proposal = client.propose_governance_action(
        &admin,
        &GovernanceProposalType::FeeIncrease,
        &signers_a,
        &2u32,
        &expires,
        &None::<Address>,
        &Some(250u32),
        &None::<bool>,
    );
    let treasury_proposal = client.propose_governance_action(
        &admin,
        &GovernanceProposalType::TreasuryRotation,
        &signers_b,
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
        &Some(900u32),
        &None::<bool>,
    );
    client.approve_governance_action(&signers.get(0).unwrap(), &pid);

    // One of two required approvals.
    let blocked = client.try_execute_governance_action(&admin, &pid);
    assert_eq!(
        blocked.unwrap_err().unwrap(),
        MarketplaceError::GovernanceThresholdNotMet.into()
    );
    assert_eq!(client.get_protocol_fee(), fee_before);
    let proposal = client.get_governance_proposal(&pid);
    assert!(!proposal.executed);
    assert!(!proposal.cancelled);

    // The very same proposal executes once the quorum is met.
    client.approve_governance_action(&signers.get(1).unwrap(), &pid);
    client.execute_governance_action(&admin, &pid);
    assert_eq!(client.get_protocol_fee(), 900u32);
    assert!(client.get_governance_proposal(&pid).executed);
}

#[test]
fn test_governance_execute_after_cancel_rejected() {
    let (env, client, admin) = quorum_setup();
    let signers = make_signers(&env, 3);
    let expires = future_expires(&env);
    let fee_before = client.get_protocol_fee();

    let pid = client.propose_governance_action(
        &admin,
        &GovernanceProposalType::FeeIncrease,
        &signers,
        &2u32,
        &expires,
        &None::<Address>,
        &Some(700u32),
        &None::<bool>,
    );
    client.approve_governance_action(&signers.get(0).unwrap(), &pid);
    client.cancel_governance_action(&admin, &pid);
    assert!(
        has_event_with_topic(&env.events().all(), "gov_cancelled"),
        "cancellation must be announced"
    );

    // Cancel closes both the approval and the execution path.
    let late_approval = client.try_approve_governance_action(&signers.get(1).unwrap(), &pid);
    assert_eq!(
        late_approval.unwrap_err().unwrap(),
        MarketplaceError::GovernanceProposalCancelled.into()
    );
    let late_execution = client.try_execute_governance_action(&admin, &pid);
    assert_eq!(
        late_execution.unwrap_err().unwrap(),
        MarketplaceError::GovernanceProposalCancelled.into()
    );
    assert_eq!(client.get_protocol_fee(), fee_before);
    assert!(!client.get_governance_proposal(&pid).executed);
    assert!(client.get_governance_proposal(&pid).cancelled);
}

#[test]
fn test_governance_approve_after_execute_rejected() {
    let (env, client, admin) = quorum_setup();
    let signers = make_signers(&env, 3);
    let expires = future_expires(&env);

    let pid = client.propose_governance_action(
        &admin,
        &GovernanceProposalType::FeeIncrease,
        &signers,
        &1u32,
        &expires,
        &None::<Address>,
        &Some(150u32),
        &None::<bool>,
    );
    client.approve_governance_action(&signers.get(0).unwrap(), &pid);
    client.execute_governance_action(&admin, &pid);

    // A late approval from a remaining signer is a replay, not a new quorum.
    let late_approval = client.try_approve_governance_action(&signers.get(1).unwrap(), &pid);
    assert_eq!(
        late_approval.unwrap_err().unwrap(),
        MarketplaceError::GovernanceProposalAlreadyExecuted.into()
    );
    // Cancelling an executed proposal is rejected the same way.
    let late_cancel = client.try_cancel_governance_action(&admin, &pid);
    assert_eq!(
        late_cancel.unwrap_err().unwrap(),
        MarketplaceError::GovernanceProposalAlreadyExecuted.into()
    );
    // And it cannot be executed a second time.
    let replay = client.try_execute_governance_action(&admin, &pid);
    assert_eq!(
        replay.unwrap_err().unwrap(),
        MarketplaceError::GovernanceProposalAlreadyExecuted.into()
    );
}

#[test]
fn test_governance_unknown_proposal_id_is_not_found() {
    let (env, client, admin) = quorum_setup();
    let unknown = 4_242u64;

    let approval = client.try_approve_governance_action(&admin, &unknown);
    assert_eq!(
        approval.unwrap_err().unwrap(),
        MarketplaceError::GovernanceProposalNotFound.into()
    );
    let execution = client.try_execute_governance_action(&admin, &unknown);
    assert_eq!(
        execution.unwrap_err().unwrap(),
        MarketplaceError::GovernanceProposalNotFound.into()
    );
    let cancellation = client.try_cancel_governance_action(&admin, &unknown);
    assert_eq!(
        cancellation.unwrap_err().unwrap(),
        MarketplaceError::GovernanceProposalNotFound.into()
    );
    let view = client.try_get_governance_proposal(&unknown);
    assert_eq!(
        view.unwrap_err().unwrap(),
        MarketplaceError::GovernanceProposalNotFound.into()
    );
}

#[test]
fn test_governance_expiry_boundary_at_exact_deadline() {
    let (env, client, admin) = quorum_setup();
    let signers = make_signers(&env, 3);
    let expires = env.ledger().timestamp() + 10;

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

    // The deadline itself is still actionable: the guard rejects only `> expires_at`.
    set_timestamp(&env, expires);
    client.approve_governance_action(&signers.get(0).unwrap(), &pid);
    client.approve_governance_action(&signers.get(1).unwrap(), &pid);
    assert_eq!(client.get_governance_approvals(&pid).len(), 2);

    // One second later the quorum is already in place, but both approval and
    // execution are expired.
    set_timestamp(&env, expires + 1);
    let late_approval = client.try_approve_governance_action(&signers.get(2).unwrap(), &pid);
    assert_eq!(
        late_approval.unwrap_err().unwrap(),
        MarketplaceError::GovernanceProposalExpired.into()
    );
    let late_execution = client.try_execute_governance_action(&admin, &pid);
    assert_eq!(
        late_execution.unwrap_err().unwrap(),
        MarketplaceError::GovernanceProposalExpired.into()
    );
    assert!(!client.get_governance_proposal(&pid).executed);
}
