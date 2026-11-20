# Role-Holder Rotation Runbook

**Issue:** [#473](https://github.com/Elcare-care/elcare-care-app/issues/473)  
**Severity:** HIGH — a rotation mistake can lock the system or leave teams unsure
which key is authoritative.  
**Prerequisites:** Stellar CLI installed, access to the current role holder's
signing key.

---

## Role inventory

The marketplace contract has five governance axes:

| Axis | Role key | Default fallback | Controls |
|------|----------|-----------------|---------|
| Admin | — (special) | — | Contract init, transfer_admin, migrate, pause/unpause global |
| ProtocolConfig | `RoleType::ProtocolConfig` | Admin | Price bounds, treasury, fees, bid/auction config |
| EmergencyPause | `RoleType::EmergencyPause` | Admin | Global/collection/function circuit breakers |
| CollectionAdmin | `RoleType::CollectionAdmin` | Admin | Artist revocation, reinstatement, collection listing cleanup |
| Upgrade | `RoleType::Upgrade` | Admin | Storage migrations |

When no explicit holder has been assigned for a role via `propose_role_transfer` /
`accept_role_transfer`, the **Admin** key is the fallback holder.

---

## Step 0 — Read the current inventory (dry run, no transaction)

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --network <testnet|mainnet> \
  -- get_role_inventory
```

This returns a `RoleInventory` JSON object with:
- `admin` — current admin address
- `pending_admin_candidate` / `pending_admin_expires_at` — pending admin rotation if any
- `roles` — array of `{role, holder, pending_candidate, pending_expires_at}` for each axis
- `ledger_sequence`, `ledger_timestamp` — snapshot time

**Verify:** the `holder` field for the target role matches your records before
proceeding. If `pending_candidate` is already set, decide whether to let it expire
or call `cancel_role_proposal` first.

---

## Step 1 — Rehearse without submitting (dry run)

Use the preflight script to verify inputs and estimate fees:

```bash
bash scripts/preflight/role-rotation-preflight.sh \
  --contract <CONTRACT_ID> \
  --network <testnet|mainnet> \
  --role <ProtocolConfig|EmergencyPause|CollectionAdmin|Upgrade> \
  --candidate <NEW_HOLDER_ADDRESS> \
  --source <CURRENT_HOLDER_KEY_NAME>
```

The script prints:
- Current holder (read-only, no transaction)
- Whether the candidate address looks valid
- Whether a proposal is already pending
- The `propose_role_transfer` command to submit (not executed)

---

## Step 2 — Submit the proposal

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --network <testnet|mainnet> \
  --source <CURRENT_HOLDER_KEY_NAME> \
  -- propose_role_transfer \
     --current_authority <CURRENT_HOLDER_ADDRESS> \
     --role <ROLE_TYPE> \
     --candidate <CANDIDATE_ADDRESS>
```

The proposal is valid for **7 days** (604 800 seconds). After that it expires
and must be re-issued.

---

## Step 3 — Verify the proposal was recorded

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --network <testnet|mainnet> \
  -- get_role_inventory
```

Confirm `pending_candidate` matches `<CANDIDATE_ADDRESS>` for the correct role,
and `pending_expires_at` is in the future.

---

## Step 4 — Candidate accepts the role

The candidate (new key holder) signs and submits:

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --network <testnet|mainnet> \
  --source <CANDIDATE_KEY_NAME> \
  -- accept_role_transfer \
     --role <ROLE_TYPE> \
     --candidate <CANDIDATE_ADDRESS>
```

---

## Step 5 — Post-acceptance verification

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --network <testnet|mainnet> \
  -- get_role_inventory
```

Verify:
- `holder` for the role now equals `<CANDIDATE_ADDRESS>`
- `pending_candidate` is `null` (proposal cleared)

Test a no-op call that requires the role to confirm the new key works:

```bash
# ProtocolConfig — read current fee
stellar contract invoke \
  --id <CONTRACT_ID> --network <testnet|mainnet> \
  -- get_protocol_fee_bps

# EmergencyPause — read pause state
stellar contract invoke \
  --id <CONTRACT_ID> --network <testnet|mainnet> \
  -- is_paused
```

---

## Recovery — expired or misdirected proposal

### Proposal expired before acceptance

The proposal is automatically invalidated after `expires_at`. The current holder
simply re-issues the proposal (Step 2). The previous expired proposal is overwritten.

### Wrong candidate proposed

The current holder can overwrite the proposal by calling `propose_role_transfer`
again with the correct candidate — **no cancel step needed**. The contract emits
`role_proposal_overwritten` so the indexer marks the old one as superseded.

To explicitly cancel before re-issuing:

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --network <testnet|mainnet> \
  --source <CURRENT_HOLDER_KEY_NAME> \
  -- cancel_role_proposal \
     --current_authority <CURRENT_HOLDER_ADDRESS> \
     --role <ROLE_TYPE>
```

### Candidate lost their key before accepting

Cancel the proposal (above) and re-issue with the correct key.

### Current holder key compromised

Follow [compromised-admin-key.md](./compromised-admin-key.md) first to pause the
contract. Then coordinate with another role holder (or admin) to issue an emergency
rotation.

---

## Admin rotation (special axis)

The admin role uses a separate two-step flow:

```bash
# Step 1 — current admin proposes
stellar contract invoke \
  --id <CONTRACT_ID> --network <testnet|mainnet> \
  --source <ADMIN_KEY_NAME> \
  -- transfer_admin \
     --admin <CURRENT_ADMIN_ADDRESS> \
     --new_admin <CANDIDATE_ADDRESS>

# Step 2 — candidate accepts
stellar contract invoke \
  --id <CONTRACT_ID> --network <testnet|mainnet> \
  --source <CANDIDATE_KEY_NAME> \
  -- accept_admin \
     --new_admin <CANDIDATE_ADDRESS>
```

---

## Reference

| Contract entry point | When to use |
|---|---|
| `get_role_inventory` | Read all role holders and pending proposals (no auth) |
| `get_role` | Read a single role holder (no auth) |
| `get_pending_role` | Read pending proposal for a role (no auth) |
| `propose_role_transfer` | Current holder proposes a new holder |
| `accept_role_transfer` | Candidate accepts |
| `cancel_role_proposal` | Current holder cancels a pending proposal |

See also:
- [contract-upgrade-runbook.md](contract-upgrade-runbook.md) — post-upgrade role verification
- [compromised-admin-key.md](../runbooks/compromised-admin-key.md) — key compromise emergency procedure
- `scripts/preflight/role-rotation-preflight.sh` — dry-run preflight script

---

## Role-Transfer Operator Verification & Test Checklist (Issue #1097)

Use this checklist to verify all six role-transfer lifecycle scenarios against the contract test suite (`cargo test -p soroban-marketplace`) and during staging/testnet rehearsals:

| Scenario | Entry Point / Mechanism | Expected Invariant & Error Code | Verification Command / Test Check |
|---|---|---|---|
| **1. Propose transfer** | `propose_role_transfer(current_authority, role, candidate)` | Requires auth from current role holder (or `Admin` if role uses fallback); records `pending_candidate` with 7-day (`604_800`s) expiry and emits `RoleTransferProposed`. Unauthorized caller fails with `Unauthorized`. | `stellar contract invoke ... -- get_role_inventory` shows `pending_candidate == candidate` and `pending_expires_at == now + 604800`. |
| **2. Accept transfer** | `accept_role_transfer(role, candidate)` | Requires `candidate.require_auth()`; promotes `candidate` to active role holder, clears pending proposal, and emits `RoleTransferAccepted`. Wrong caller fails with `Unauthorized` / `NoPendingRoleTransfer`. | `get_role_inventory` shows `holder == candidate` and `pending_candidate == null`. |
| **3. Cancel proposal** | `cancel_role_proposal(authority, role)` | Current role holder or `Admin` cancels an active proposal before acceptance; clears `pending_candidate` and emits `RoleProposalCancelled`. | Subsequent `accept_role_transfer` by the former candidate fails with `NoPendingRoleTransfer`. |
| **4. Proposal expiry** | Ledger timestamp advances past `pending_expires_at` (`> 604_800`s) | Expired proposal cannot be accepted; calling `accept_role_transfer` after expiry fails with `RoleProposalExpired` and preserves existing holder. | Advance ledger timestamp > 7 days in unit test; assert `RoleProposalExpired`. |
| **5. Admin fallback** | No explicit holder assigned for `ProtocolConfig`, `EmergencyPause`, `CollectionAdmin`, or `Upgrade` | `Admin` address is authoritative for the axis until an explicit holder accepts a transfer. | `get_role_inventory` reports `Admin` as effective authority when explicit role slot is unset. |
| **6. Legacy role migration** | `migrate_roles(admin)` | Idempotently initializes/migrates role storage slots under `Admin` authority during schema upgrades without revoking active holders. | Run `cargo test -p soroban-marketplace role` and confirm all role lifecycle tests pass. |

### Ownership & Rollback
- **Owner:** Contract & Security Operations (`ops@elcarehub.xyz`).
- **Rollback Path:** If a wrong `candidate` address is proposed, immediately invoke `cancel_role_proposal` using the current role holder or `Admin` key before the candidate can accept.
