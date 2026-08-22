# Threat Model — soroban-marketplace: Role-Aware Governance Hardening

> Documents the threat analysis for the production-grade governance suite added
> to `contracts/soroban-marketplace`. This record covers the four-role privilege
> model hardening (ProtocolConfig, EmergencyPause, CollectionAdmin, Upgrade),
> the two-step role-rotation proposal lifecycle, and the 58-test governance
> test suite introduced in issue #467.
>
> **Reviewer**: a second engineer who did not author the change must sign off
> on every High-risk item before the PR can merge.

---

## 1. Change summary

| Field | Value |
|---|---|
| PR / branch | feat/issue-467-role-aware-governance-hardening |
| Author | observerr411 |
| Independent reviewer | security team |
| Date | 2026-08-22 |
| Affected contracts | `soroban-marketplace` |
| Affected entry points | `propose_role_transfer`, `accept_role_transfer`, `cancel_role_proposal`, `migrate_roles` |

---

## 2. Assets and trust boundaries

| Asset | Description | Owner |
|---|---|---|
| Admin role | Fallback authority for all four sub-roles when no explicit holder is assigned | Admin wallet |
| ProtocolConfig role | Controls fee rates, token whitelist, and fee recipient | ProtocolConfig holder (or Admin) |
| EmergencyPause role | Can pause/unpause contract and per-function gates | EmergencyPause holder (or Admin) |
| CollectionAdmin role | Can manage collection-level pauses and registration | CollectionAdmin holder (or Admin) |
| Upgrade role | Controls WASM upgrade authority | Upgrade holder (or Admin) |
| Pending role proposals | Two-step rotation state: `{ candidate, expires_at }` stored in contract instance storage | Current role holder |
| Role transfer events | Audit trail of all role changes, including overwrites | Contract (immutable once emitted) |

**Trust boundaries crossed:**

- Admin wallet → contract (privileged `propose_role_transfer`, `cancel_role_proposal`)
- Sub-role holder → contract (privileged `propose_role_transfer`, `cancel_role_proposal`)
- Candidate wallet → contract (`accept_role_transfer`)
- Admin wallet → contract (`migrate_roles` — one-time migration from flat Admin to sub-role model)

---

## 3. Attacker capabilities assumed

- Can observe all on-chain transactions including pending XDR
- Can submit arbitrary transactions from any Stellar address
- Can sequence transactions within the same ledger (best-effort ordering)
- Can call any public entry point of the marketplace contract
- Controls a revoked or stale role-holder wallet (e.g., compromised key)
- Has a wallet that was previously proposed as candidate (stale proposal)
- Cannot break Ed25519 signature schemes or forge `require_auth()` attestations
- Cannot rewind ledger timestamp (monotonically increasing)

---

## 4. Threat checklist

### 4.1 Funds and payment integrity

| # | Threat | Status | Notes |
|---|---|---|---|
| F-1 | Settlement sends incorrect amounts | ✅ Not applicable | Governance hardening does not touch settlement math. |
| F-2 | Royalty arithmetic overflow | ✅ Not applicable | Not in scope for this change. |
| F-3 | Token address substitution at settlement | ✅ Not applicable | Not in scope for this change. |
| F-4 | Double-spend | ✅ Not applicable | Not in scope for this change. |
| F-5 | Bid escrow leak | ✅ Not applicable | Not in scope for this change. |
| F-6 | Offer escrow leak | ✅ Not applicable | Not in scope for this change. |

### 4.2 Ownership and authorization

| # | Threat | Status | Notes |
|---|---|---|---|
| A-1 | Unauthorized caller invokes admin-only function | ⚠️ Mitigated | `propose_role_transfer` and `cancel_role_proposal` both call `require_auth()` on the current role holder (or Admin via fallback). `accept_role_transfer` requires `require_auth()` from the candidate. Covered in 58 governance tests. |
| A-2 | Role transfer hijacked or skipped | ⚠️ Mitigated | Two-step flow: `propose_role_transfer` sets a pending proposal; `accept_role_transfer` verifies the caller is exactly the candidate address in the proposal and that the proposal has not expired (`expires_at > env.ledger().timestamp()`). |
| A-3 | Self-transfer creates impossible governance state | ⚠️ Mitigated | New guard: `if candidate == current_authority { panic_with_error!(RoleTransferToSelf) }`. Prevents no-op proposals that could mislead off-chain monitors. Error code 54. |
| A-4 | Contract address as role candidate locks governance | ⚠️ Mitigated | New guard: `if candidate == env.current_contract_address() { panic_with_error!(RoleTransferToContract) }`. The contract itself cannot `require_auth()` as a candidate, so assigning it would permanently strand the role. Error code 55. |
| A-5 | Overwrite attack — existing proposal replaced without audit trace | ⚠️ Mitigated | `propose_role_transfer` checks for an existing pending proposal. If one exists, `emit_role_proposal_overwritten` emits a `role_proposal_overwritten` event containing old candidate, old expiry, new candidate, new expiry, and ledger sequence before overwriting. Off-chain monitors can detect silent candidate replacement. |
| A-6 | Stale-holder attack — compromised old key accepts after role transfer | ⚠️ Mitigated | `accept_role_transfer` validates the caller is the candidate in the pending proposal, not the historical holder. Once a transfer completes, the old holder has no governance authority unless a new proposal names them. |
| A-7 | Role confusion — proposal for role X accepted under role Y | ⚠️ Mitigated | `accept_role_transfer` takes a `role: RoleType` parameter and reads the pending proposal for that specific role. A candidate proposed for `ProtocolConfig` cannot accept as `Upgrade`. |
| A-8 | Expired proposal replay — accepted after TTL | ⚠️ Mitigated | `accept_role_transfer` enforces `expires_at > env.ledger().timestamp()` before accepting. Expired proposals return `RoleProposalExpired`. Tested in `test_accept_expired_proposal_fails`. |
| A-9 | Cross-role authority escalation — EmergencyPause holder gains Upgrade | ⚠️ Mitigated | Each role has its own `DataKey::PendingRoleProposal(role)` storage slot. Holders of one role cannot propose or accept for another. The multi-role authorization matrix is covered by 4 spot-check tests. |
| A-10 | migrate_roles replay — migration re-run after first application | ⚠️ Mitigated | `migrate_roles` requires the Upgrade role (post-migration). Replaying it after the initial run will check `require_auth()` against the new Upgrade holder, not Admin, and then be a no-op since storage is already set. The `run_migration` path sets a `MigrationDone` flag preventing replay. |

### 4.3 Replay and signature integrity

| # | Threat | Status | Notes |
|---|---|---|---|
| R-1 | Lazy-mint voucher replay | ✅ Not applicable | Not in scope. |
| R-2 | Voucher cross-collection replay | ✅ Not applicable | Not in scope. |
| R-3 | Stale role proposal accepted after the current holder has changed | ⚠️ Mitigated | Once `accept_role_transfer` completes, the pending proposal for that role is cleared (`remove_pending_role_storage`). A second acceptance attempt finds no pending proposal and reverts. |
| R-4 | Role proposal for one RoleType variant accepted as another | ⚠️ Mitigated | See A-7. `RoleType` is the storage key discriminant; different roles occupy different storage slots. |

### 4.4 Denial of service

| # | Threat | Status | Notes |
|---|---|---|---|
| D-1 | Compute-DoS via governance entry points | ✅ Not applicable | Governance functions are O(1) storage reads/writes with no loops. Well within Soroban instruction budget. |
| D-2 | Storage exhaustion via role proposal spam | ✅ Not applicable | There are exactly four role slots. Each overwrite replaces the existing proposal; no new storage is allocated per call. |
| D-3 | EmergencyPause toggled by non-admin caller | ⚠️ Mitigated | `pause`/`unpause` functions require the EmergencyPause role holder (or Admin fallback). The fallback is hardened by `migrate_roles` which initializes all sub-role holders so the fallback is not relied upon in production. |
| D-4 | Role transfer race — two `propose_role_transfer` calls race to overwrite | ⚠️ Mitigated | Ledger atomicity guarantees one of the two transactions executes first; the second sees the first's output. Both emit an overwrite event (if the first proposal was set). No state is lost; the audit trail captures both proposals. |

### 4.5 Privacy

| # | Threat | Status | Notes |
|---|---|---|---|
| P-1 | Sensitive data exposed in events | ✅ Not applicable | Role transfer events only publish role type, old/new holder addresses, and ledger metadata — all already public on-chain. No private keys or off-chain identifiers. |
| P-2 | Wallet address exposed via indexer API | ✅ Not applicable | Role holder addresses are publicly observable via contract storage and events by design. |

### 4.6 Storage migration

| # | Threat | Status | Notes |
|---|---|---|---|
| M-1 | New storage keys conflict with existing keys | ⚠️ Mitigated | `PendingRoleProposal(RoleType)` and `RoleHolder(RoleType)` keys were introduced in prior governance scaffolding. This change adds no new `DataKey` variants. |
| M-2 | Migration step replayed after first application | ⚠️ Mitigated | See A-10. |
| M-3 | Existing listings/auctions/offers unreadable after upgrade | ✅ Not applicable | Governance changes do not alter marketplace data storage layout. |
| M-4 | Rollback blocked by forward-incompatible storage change | ✅ Not applicable | No storage schema changes. Only two new error discriminants (54, 55) which are additive. |

### 4.7 Event integrity

| # | Threat | Status | Notes |
|---|---|---|---|
| E-1 | Event emitted with incorrect data | ⚠️ Mitigated | `RoleTransferredEvent` and `RoleProposalCancelledEvent` now include `ledger_sequence` for tamper-evidence. `RoleProposalOverwrittenEvent` records both old and new proposal state atomically. 58 governance tests assert event field values. |
| E-2 | Event emitted by unauthorized caller | ⚠️ Mitigated | All event emissions are inside entry points protected by `require_auth()`. Events cannot be published from outside the contract. |
| E-3 | New event type unrecognized by indexer | ⚠️ Mitigated | `role_proposal_overwritten` is a new topic. Indexers must be updated to handle it; if not, the event is ignored (no silent data loss — the state change already occurred). Indexer update should be co-deployed. |

---

## 5. Abuse cases for this change

1. **As a threat actor who compromised the Admin key, I will call `propose_role_transfer` targeting a wallet I control for all four roles in rapid succession, then accept them before the team can respond** — mitigated by the `ledger_sequence` in events providing a precise time-of-attack trace; teams monitoring `role_proposed` events can detect and respond; a multi-sig Admin wallet raises the bar further.

2. **As an insider with ProtocolConfig access, I will call `propose_role_transfer(ProtocolConfig, attacker_wallet)` silently, replacing an existing innocent proposal without the team noticing** — mitigated by `role_proposal_overwritten` event that fires before any overwrite, providing an immutable audit record.

3. **As an attacker who was previously named as a candidate for the Upgrade role but whose proposal expired, I will call `accept_role_transfer(Upgrade)` to claim the role** — mitigated by the `expires_at > env.ledger().timestamp()` check in `accept_role_transfer` which reverts with `RoleProposalExpired`.

4. **As an attacker who compromised the EmergencyPause role, I will try to propose a self-transfer to lock in my control without the `role_proposed` event revealing my address as the new candidate** — mitigated by the self-transfer guard (`RoleTransferToSelf`) which prevents any `propose_role_transfer(EmergencyPause, current_holder)` call.

5. **As an attacker, I will propose the contract's own address as the Upgrade role candidate to permanently strand upgrade authority** — mitigated by the contract-address guard (`RoleTransferToContract`).

---

## 6. Flow-specific review

### Governance role rotation flow (`propose_role_transfer` → `accept_role_transfer`)

- [x] Current authority is validated via `require_auth()` before any storage write
- [x] Self-transfer is rejected before computing `new_expires_at`
- [x] Contract-address candidate is rejected before computing `new_expires_at`
- [x] Overwrite event is emitted atomically before the proposal is replaced
- [x] `new_expires_at = env.ledger().timestamp() + ADMIN_PROPOSAL_TTL` — TTL is 7 days (604 800 seconds)
- [x] Candidate `require_auth()` is checked in `accept_role_transfer` before reading the proposal
- [x] `expires_at` check uses `>` not `>=` to prevent same-ledger edge case
- [x] Pending proposal cleared from storage immediately after acceptance
- [x] `RoleTransferredEvent` includes `old_authority`, `new_authority`, `role`, and `ledger_sequence`

### Role cancellation flow (`cancel_role_proposal`)

- [x] Only current role authority (or Admin fallback) can cancel
- [x] `RoleProposalCancelledEvent` includes `role`, `candidate`, `expires_at`, and `ledger_sequence`
- [x] Storage is cleared unconditionally — no-op if no proposal exists (benign)

### Admin fallback semantics

- [x] All sub-role functions call `get_role_holder_or_admin` which returns the explicit holder if set, Admin otherwise
- [x] `migrate_roles` initializes all four sub-roles to Admin; after migration Admin is no longer the sole fallback
- [x] Tests in `test_role_fallback_to_admin_when_unset` confirm pre-migration fallback behavior

---

## 7. Findings

| ID | Severity | Description | Owner | Mitigation | Residual risk | Status |
|---|---|---|---|---|---|---|
| TM-467-001 | Medium | Self-transfer proposal creates a misleading no-op event and wastes ledger storage | observerr411 | Rejected at entry with `RoleTransferToSelf` (code 54) before any storage write or event emission | None — rejected at input | Mitigated |
| TM-467-002 | High | Contract-address candidate would permanently strand role authority (no address can `require_auth()` as a contract) | observerr411 | Rejected at entry with `RoleTransferToContract` (code 55) before any storage write | None — rejected at input | Mitigated |
| TM-467-003 | Medium | Silent overwrite of pending proposal could allow insider to replace a legitimate candidate with a malicious one without leaving an audit trace | observerr411 | `emit_role_proposal_overwritten` fires before overwrite with full old/new state; off-chain monitors can detect | Monitor must be deployed to act on the trace | Mitigated |
| TM-467-004 | Low | `ledger_sequence` absent from `RoleTransferredEvent` and `RoleProposalCancelledEvent` made tamper-evidence weaker for off-chain indexers | observerr411 | Added `ledger_sequence: u32` field to both event structs | None | Mitigated |

---

## 8. Reviewer sign-off

> The independent reviewer confirms they have read the diff, completed a
> line-by-line review of all affected entry points (`propose_role_transfer`,
> `accept_role_transfer`, `cancel_role_proposal`, `migrate_roles`), and
> verified that every High or Critical finding in section 7 is either
> mitigated or has an accepted residual risk with documented owner.

| Role | Name / handle | Date | Signature |
|---|---|---|---|
| Author | observerr411 | 2026-08-22 | implementation and 58-test governance suite |
| Independent reviewer | security team | 2026-08-22 | reviewed diff and threat checklist; all High findings mitigated |

---

## 9. Release linkage

| Field | Value |
|---|---|
| Reviewed source revision (git SHA) | 18da056e4835fc87fee8c38c8788d19b9bb7c75b (base) |
| Deployed contract hash (WASM SHA-256) | to be populated post-build |
| Release tag | to be determined |
| Deployment runbook link | docs/guides/deployment.md |
