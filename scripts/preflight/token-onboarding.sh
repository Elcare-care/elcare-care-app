#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# token-onboarding.sh — Pre-flight checks before whitelisting a payment token
#
# Usage:
#   bash scripts/preflight/token-onboarding.sh \
#     --address C... \
#     --symbol USDC \
#     [--decimals 7] \
#     [--network testnet] \
#     [--marketplace CONTRACT_ID]
#
# Exit 0 = ready for operator review; Exit 1 = blocking issue found.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE="$REPO_ROOT/fixtures/test-token.json"
TOKENS_TS="$REPO_ROOT/frontend/elcarehub-app/src/config/tokens.ts"
TOKEN_METADATA_TS="$REPO_ROOT/indexer/src/token-metadata.ts"

ADDRESS=""
SYMBOL=""
DECIMALS="7"
NETWORK=""
MARKETPLACE=""

red()   { printf "\033[31m✗ %s\033[0m\n" "$1"; }
green() { printf "\033[32m✓ %s\033[0m\n" "$1"; }
warn()  { printf "\033[33m⚠ %s\033[0m\n" "$1"; }

usage() {
  sed -n '4,12p' "$0"
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --address)     ADDRESS="$2"; shift 2 ;;
    --symbol)      SYMBOL="$2"; shift 2 ;;
    --decimals)    DECIMALS="$2"; shift 2 ;;
    --network)     NETWORK="$2"; shift 2 ;;
    --marketplace) MARKETPLACE="$2"; shift 2 ;;
    -h|--help)     usage 0 ;;
    *) red "Unknown argument: $1"; usage 1 ;;
  esac
done

ERRORS=0

echo "━━━ token-onboarding preflight ━━━"
echo ""

# ── Required args ─────────────────────────────────────────────────────────────
if [[ -z "$ADDRESS" ]]; then
  red "--address is required"
  ERRORS=$((ERRORS + 1))
fi

if [[ -z "$SYMBOL" ]]; then
  red "--symbol is required"
  ERRORS=$((ERRORS + 1))
fi

# ── Stellar contract address format (C + 55 base32 chars) ───────────────────
if [[ -n "$ADDRESS" ]]; then
  if [[ "$ADDRESS" =~ ^C[A-Z2-7]{55}$ ]]; then
    green "Address format valid: ${ADDRESS:0:8}…"
  else
    red "Invalid Stellar contract address format (expected C + 55 chars): $ADDRESS"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ── Decimals range ────────────────────────────────────────────────────────────
if [[ "$DECIMALS" =~ ^[0-9]+$ ]] && [[ "$DECIMALS" -ge 0 && "$DECIMALS" -le 18 ]]; then
  green "Decimals: $DECIMALS"
  if [[ "$DECIMALS" != "7" ]]; then
    warn "Non-default decimals ($DECIMALS) — requires TOKEN_DECIMALS_JSON and engineering sign-off"
  fi
else
  red "Invalid --decimals (0–18): $DECIMALS"
  ERRORS=$((ERRORS + 1))
fi

# ── Fixture schema present ────────────────────────────────────────────────────
if [[ -f "$FIXTURE" ]]; then
  green "Test token fixture exists: fixtures/test-token.json"
  FIXTURE_SYMBOL=$(jq -r '.symbol // empty' "$FIXTURE" 2>/dev/null || echo "")
  FIXTURE_DECIMALS=$(jq -r '.decimals // empty' "$FIXTURE" 2>/dev/null || echo "")
  if [[ -n "$FIXTURE_DECIMALS" && "$FIXTURE_DECIMALS" != "$DECIMALS" ]]; then
    warn "Fixture decimals ($FIXTURE_DECIMALS) differ from --decimals ($DECIMALS)"
  fi
else
  warn "Missing fixtures/test-token.json — create before CI drills"
fi

# ── Frontend metadata ─────────────────────────────────────────────────────────
if [[ -f "$TOKENS_TS" ]]; then
  if grep -q "$SYMBOL" "$TOKENS_TS"; then
    green "Symbol $SYMBOL found in frontend tokens.ts"
  else
    warn "Symbol $SYMBOL not in tokens.ts — add TOKEN_METADATA before deploy"
  fi

  if grep -q "$ADDRESS" "$TOKENS_TS" 2>/dev/null; then
    green "Address found in frontend tokens.ts"
  else
    warn "Address not in tokens.ts — add to TOKEN_ADDRESSES_BY_NETWORK for $NETWORK"
  fi
else
  red "Frontend tokens.ts not found"
  ERRORS=$((ERRORS + 1))
fi

# ── Indexer decimal module ────────────────────────────────────────────────────
if [[ -f "$TOKEN_METADATA_TS" ]]; then
  green "Indexer token-metadata.ts present"
else
  red "Indexer token-metadata.ts not found"
  ERRORS=$((ERRORS + 1))
fi

# ── Optional on-chain whitelist check ─────────────────────────────────────────
if [[ -n "$NETWORK" && -n "$MARKETPLACE" ]]; then
  if command -v stellar >/dev/null 2>&1; then
    echo ""
    echo "Querying on-chain whitelist on $NETWORK…"
    WHITELIST=$(stellar contract invoke \
      --id "$MARKETPLACE" \
      --network "$NETWORK" \
      -- get_token_whitelist 2>/dev/null || echo "ERROR")

    if [[ "$WHITELIST" == "ERROR" ]]; then
      warn "Could not query get_token_whitelist — check MARKETPLACE id and network"
    elif echo "$WHITELIST" | grep -q "$ADDRESS"; then
      warn "Token already whitelisted on-chain"
    else
      green "Token not yet on-chain whitelist (expected for new onboarding)"
    fi
  else
    warn "stellar CLI not installed — skipping on-chain check"
  fi
elif [[ -n "$NETWORK" ]]; then
  warn "Pass --marketplace to verify on-chain whitelist state"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
if [[ $ERRORS -gt 0 ]]; then
  red "$ERRORS blocking error(s). Fix before whitelist transaction."
  exit 1
fi

green "Preflight complete — proceed with operator review checklist (docs/runbooks/token-onboarding.md §4)"
exit 0
