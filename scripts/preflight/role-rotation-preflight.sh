#!/usr/bin/env bash
# scripts/preflight/role-rotation-preflight.sh
#
# Issue #473 — Role-holder rotation dry-run preflight.
#
# Reads on-chain state and validates inputs WITHOUT submitting any transaction.
# Prints the exact `propose_role_transfer` command to run when ready.
#
# IMPORTANT: This script NEVER prints private keys.
# All --source values are key *names* managed by the Stellar CLI key store.
#
# Usage:
#   bash scripts/preflight/role-rotation-preflight.sh \
#     --contract <CONTRACT_ID> \
#     --network  <testnet|mainnet> \
#     --role     <ProtocolConfig|EmergencyPause|CollectionAdmin|Upgrade> \
#     --candidate <NEW_HOLDER_ADDRESS> \
#     --source   <CURRENT_HOLDER_KEY_NAME>
#
# Example (dry run only — no transaction submitted):
#   bash scripts/preflight/role-rotation-preflight.sh \
#     --contract CB74XQOHEVOL2NQ376JLVW5IGVM6I5VFDSHG66YKSHDQKRNTYGGXW25E \
#     --network testnet \
#     --role ProtocolConfig \
#     --candidate GBXXX...YYYY \
#     --source my-admin-key
#
# Exit codes:
#   0  — all checks pass; command printed is safe to run
#   1  — validation failure (see output for details)
# ─────────────────────────────────────────────────────────────

set -euo pipefail

# ── Argument parsing ─────────────────────────────────────────────────────────

CONTRACT=""
NETWORK=""
ROLE=""
CANDIDATE=""
SOURCE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --contract)  CONTRACT="$2";  shift 2 ;;
    --network)   NETWORK="$2";   shift 2 ;;
    --role)      ROLE="$2";      shift 2 ;;
    --candidate) CANDIDATE="$2"; shift 2 ;;
    --source)    SOURCE="$2";    shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

ERRORS=0

check() {
  local label="$1"
  local ok="$2"
  local detail="${3:-}"
  if [[ "$ok" == "true" ]]; then
    echo "  ✓ $label"
    [[ -n "$detail" ]] && echo "    $detail"
  else
    echo "  ✗ $label"
    [[ -n "$detail" ]] && echo "    $detail"
    ERRORS=$((ERRORS + 1))
  fi
}

# ── Required argument checks ─────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Role Rotation Preflight (dry run — no transaction)"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Inputs:"
echo "  Contract : ${CONTRACT:-<not set>}"
echo "  Network  : ${NETWORK:-<not set>}"
echo "  Role     : ${ROLE:-<not set>}"
echo "  Candidate: ${CANDIDATE:0:8}…${CANDIDATE: -4} (redacted middle)"
echo "  Source   : ${SOURCE:-<not set>}"
echo ""
echo "── Input validation ─────────────────────────────────────"

[[ -n "$CONTRACT" ]]  && check "CONTRACT_ID provided"  "true"  "$CONTRACT" \
                      || check "CONTRACT_ID provided"  "false" "Pass --contract <id>"
[[ -n "$NETWORK" ]]   && check "Network provided"      "true"  "$NETWORK" \
                      || check "Network provided"      "false" "Pass --network <testnet|mainnet>"
[[ -n "$SOURCE" ]]    && check "Source key provided"   "true"  "$SOURCE" \
                      || check "Source key provided"   "false" "Pass --source <key-name>"
[[ -n "$CANDIDATE" ]] && check "Candidate provided"    "true"  \
                      || check "Candidate provided"    "false" "Pass --candidate <address>"

# Validate role name
VALID_ROLES=("ProtocolConfig" "EmergencyPause" "CollectionAdmin" "Upgrade")
ROLE_OK=false
for r in "${VALID_ROLES[@]}"; do
  [[ "$ROLE" == "$r" ]] && ROLE_OK=true && break
done
check "Role name is valid" "$ROLE_OK" \
  "Must be one of: ${VALID_ROLES[*]}"

# Validate candidate address format (G... public key, 56 chars, base32)
if [[ "$CANDIDATE" =~ ^G[A-Z2-7]{55}$ ]]; then
  check "Candidate address format" "true"
else
  check "Candidate address format" "false" \
    "Expected a 56-char Stellar Ed25519 public key starting with G"
fi

# Guard: candidate must not equal the contract itself (C...)
if [[ "$CANDIDATE" =~ ^C ]]; then
  check "Candidate is not a contract address" "false" \
    "Assigning a role to a contract address would make it irrecoverable"
else
  check "Candidate is not a contract address" "true"
fi

if [[ "$ERRORS" -gt 0 ]]; then
  echo ""
  echo "✗ Input validation failed ($ERRORS error(s)). Fix above issues before proceeding."
  exit 1
fi

# ── Stellar CLI check ────────────────────────────────────────────────────────

echo ""
echo "── Environment ──────────────────────────────────────────"
if command -v stellar &>/dev/null; then
  STELLAR_VERSION=$(stellar --version 2>&1 | head -1)
  check "stellar CLI installed" "true" "$STELLAR_VERSION"
else
  check "stellar CLI installed" "false" "Install with: cargo install --locked stellar-cli --features opt"
  exit 1
fi

# ── On-chain state read ──────────────────────────────────────────────────────

echo ""
echo "── On-chain state (read-only) ───────────────────────────"

INVENTORY_JSON=$(stellar contract invoke \
  --id "$CONTRACT" \
  --network "$NETWORK" \
  -- get_role_inventory 2>&1) || {
  echo "  ✗ Failed to read role inventory from chain:"
  echo "    $INVENTORY_JSON"
  exit 1
}

echo "  ✓ Role inventory read successfully"

# Extract current holder for the target role (simple grep; not JSON-parsing for portability)
CURRENT_HOLDER=$(echo "$INVENTORY_JSON" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for entry in data.get('roles', []):
    if entry['role'] == sys.argv[1]:
        print(entry['holder'])
        break
" "$ROLE" 2>/dev/null || echo "")

PENDING_CANDIDATE=$(echo "$INVENTORY_JSON" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for entry in data.get('roles', []):
    if entry['role'] == sys.argv[1]:
        pc = entry.get('pending_candidate')
        print(pc if pc else 'none')
        break
" "$ROLE" 2>/dev/null || echo "unknown")

PENDING_EXPIRES=$(echo "$INVENTORY_JSON" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for entry in data.get('roles', []):
    if entry['role'] == sys.argv[1]:
        pe = entry.get('pending_expires_at')
        print(pe if pe else 'none')
        break
" "$ROLE" 2>/dev/null || echo "unknown")

LEDGER_TS=$(echo "$INVENTORY_JSON" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('ledger_timestamp', 0))
" 2>/dev/null || echo "0")

echo ""
echo "  Current holder of $ROLE:"
# Redact middle of address for safety
if [[ ${#CURRENT_HOLDER} -ge 12 ]]; then
  echo "    ${CURRENT_HOLDER:0:8}…${CURRENT_HOLDER: -4}"
else
  echo "    ${CURRENT_HOLDER:-<not found>}"
fi

if [[ "$PENDING_CANDIDATE" != "none" && "$PENDING_CANDIDATE" != "unknown" ]]; then
  echo "  ⚠ Pending proposal already exists:"
  echo "    Candidate: ${PENDING_CANDIDATE:0:8}…${PENDING_CANDIDATE: -4}"
  echo "    Expires at: $PENDING_EXPIRES"
  echo "  → A new proposal_role_transfer call will OVERWRITE the existing proposal."
fi

# Warn if candidate equals current holder
if [[ "$CANDIDATE" == "$CURRENT_HOLDER" ]]; then
  echo ""
  echo "  ✗ Candidate is already the current holder of this role."
  echo "    This would be rejected by the contract with RoleTransferToSelf."
  exit 1
fi

echo ""
echo "── Pre-flight result ────────────────────────────────────"
echo "  ✓ All checks passed. No transaction has been submitted."
echo ""
echo "  To proceed with the rotation, run:"
echo ""
echo "  stellar contract invoke \\"
echo "    --id $CONTRACT \\"
echo "    --network $NETWORK \\"
echo "    --source $SOURCE \\"
echo "    -- propose_role_transfer \\"
echo "      --current_authority \$(stellar keys address $SOURCE) \\"
echo "      --role $ROLE \\"
echo "      --candidate $CANDIDATE"
echo ""
echo "  Then the candidate accepts with:"
echo ""
echo "  stellar contract invoke \\"
echo "    --id $CONTRACT \\"
echo "    --network $NETWORK \\"
echo "    --source <CANDIDATE_KEY_NAME> \\"
echo "    -- accept_role_transfer \\"
echo "      --role $ROLE \\"
echo "      --candidate $CANDIDATE"
echo ""
echo "  After acceptance, verify with:"
echo "  stellar contract invoke --id $CONTRACT --network $NETWORK -- get_role_inventory"
echo ""
