# Contract Deploy Dry-Run Output Guide

**Issue**: [#1117](https://github.com/Elcare-care/elcare-care-app/issues/1117)  
**Category**: Reliability, Security, and Operations  
**Severity**: HIGH  
**Owner**: Deploy operator  
**Last updated**: 2026-07-27

---

## Overview

Before any on-chain contract deployment is confirmed, the operator must verify five
pieces of information: the target network, the contract package version, the source
commit, the WASM hash, and the resulting contract ID. This document defines which
flags and log lines produce that information and what a mandatory pre-confirmation
checklist looks like.

---

## 1. Existing Dry-Run Support

`scripts/deploy/deploy_contract.sh` and `scripts/deploy/deploy_launchpad.sh` both
accept `--dry-run`. When passed, the script validates all prerequisites and prints what
it would do, then exits without making any on-chain changes.

```bash
cd scripts/deploy

# Marketplace contract
./deploy_contract.sh --dry-run

# Launchpad + NFT contracts
./deploy_launchpad.sh --dry-run
```

A clean dry-run prints output similar to:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ELCARE-HUB — Deploy Soroban Contract to Testnet
  (DRY RUN — no on-chain changes will be made)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DRY RUN: Prerequisites OK.
DRY RUN: Would build contracts/soroban-marketplace
DRY RUN: Would install WASM to testnet via https://soroban-testnet.stellar.org
DRY RUN: Would deploy contract and write IDs to:
         scripts/deploy/deployed_ids.env
         frontend/elcarehub-app/.env.local
```

---

## 2. The Five Required Pre-Confirmation Fields

A live deployment (without `--dry-run`) must log all five fields before any on-chain
transaction is submitted. The table below shows where each value comes from.

| # | Field | Source in deploy script | Example |
|---|-------|-------------------------|---------|
| 1 | **Network** | `$NETWORK` from `.env.deploy` | `testnet` |
| 2 | **Contract package version** | `grep '^version' Cargo.toml` | `0.1.0` |
| 3 | **Source commit** | `git rev-parse --short HEAD` | `a1b2c3d` |
| 4 | **WASM hash** | Output of `stellar contract install` | `abc123…` |
| 5 | **Contract ID** | Output of `stellar contract deploy` | `CABC…` |

After a successful run these values are also persisted in
`scripts/deploy/deployed_versions.json`:

```json
{
  "deployments": [
    {
      "contract": "soroban-marketplace",
      "contract_id": "CABC…",
      "wasm_hash": "abc123…",
      "cargo_version": "0.1.0",
      "contract_version": "1.1.0",
      "git_sha": "a1b2c3d",
      "network": "testnet",
      "deployed_at": "2026-07-27T12:00:00Z"
    }
  ]
}
```

---

## 3. Shell-Level Validation Checklist

Run this checklist immediately after the dry-run passes and **before** starting the live
deployment. All commands are read-only.

```bash
#!/usr/bin/env bash
# Pre-deployment validation checklist
# Source .env.deploy first: source scripts/deploy/.env.deploy

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
DEPLOY_DIR="$REPO_ROOT/scripts/deploy"

echo "=== Pre-Deployment Validation Checklist ==="
echo ""

# 1. Network
echo "1. Network"
echo "   NETWORK        : ${NETWORK:?NETWORK not set in .env.deploy}"
echo "   RPC_URL        : ${RPC_URL:?RPC_URL not set}"
echo "   RPC reachable  : $(curl -sf "${RPC_URL}/status" | jq -r '.infoResponse.networkPassphrase' 2>/dev/null || echo 'UNREACHABLE')"
echo ""

# 2. Contract package version
CARGO_VERSION=$(grep '^version' "$REPO_ROOT/contracts/soroban-marketplace/Cargo.toml" | head -1 | sed 's/.*"\(.*\)".*/\1/')
VERSIONS_TOML_VERSION=$(grep 'version = ' "$REPO_ROOT/versions.toml" | head -1 | sed 's/.*"\(.*\)".*/\1/')
echo "2. Contract package version"
echo "   Cargo.toml     : ${CARGO_VERSION}"
echo "   versions.toml  : ${VERSIONS_TOML_VERSION}"
if [[ "$CARGO_VERSION" != "$VERSIONS_TOML_VERSION" ]]; then
  echo "   WARNING: Version mismatch — update versions.toml before deploying"
fi
echo ""

# 3. Source commit
GIT_SHA=$(git -C "$REPO_ROOT" rev-parse HEAD)
GIT_SHORT=$(git -C "$REPO_ROOT" rev-parse --short HEAD)
GIT_STATUS=$(git -C "$REPO_ROOT" status --porcelain | wc -l | tr -d ' ')
echo "3. Source commit"
echo "   Commit         : ${GIT_SHA}"
echo "   Short SHA      : ${GIT_SHORT}"
if [[ "$GIT_STATUS" -gt 0 ]]; then
  echo "   WARNING: Working tree has ${GIT_STATUS} uncommitted change(s)"
  echo "            Deploy from a clean commit for reproducibility"
fi
echo ""

# 4. WASM hash (pre-build — only available after a previous deploy or CI run)
if [[ -f "$DEPLOY_DIR/deployed_versions.json" ]]; then
  LAST_HASH=$(jq -r '.deployments[-1].wasm_hash' "$DEPLOY_DIR/deployed_versions.json")
  echo "4. Last known WASM hash (from deployed_versions.json)"
  echo "   Last hash      : ${LAST_HASH}"
  echo "   (The live deployment will print the new hash and update this file)"
else
  echo "4. WASM hash"
  echo "   deployed_versions.json not found — this appears to be a first deploy"
fi
echo ""

# 5. Contract ID (pre-deploy — from most recent entry)
if [[ -f "$DEPLOY_DIR/deployed_versions.json" ]]; then
  LAST_CONTRACT_ID=$(jq -r '.deployments[-1].contract_id' "$DEPLOY_DIR/deployed_versions.json")
  LAST_NETWORK=$(jq -r '.deployments[-1].network' "$DEPLOY_DIR/deployed_versions.json")
  echo "5. Last deployed contract ID"
  echo "   Contract ID    : ${LAST_CONTRACT_ID}"
  echo "   Network        : ${LAST_NETWORK}"
  echo "   (A new contract ID will be assigned for this deployment)"
else
  echo "5. Contract ID"
  echo "   No prior deployment found in deployed_versions.json"
fi
echo ""

echo "=== Checklist complete. Review all values before proceeding. ==="
```

Save this as `scripts/deploy/pre-deploy-check.sh`, make it executable, and run it
before every live deployment.

---

## 4. Making the Checklist Mandatory in CI

For deployments triggered through the release workflow, add a job step that runs the
checklist in dry-run mode before the live deploy step. The existing
`workflow_dispatch` trigger in `.github/workflows/release.yml` is the right place:

```yaml
# In .github/workflows/release.yml, add before the deploy step:
- name: Pre-deployment validation checklist
  run: |
    source scripts/deploy/.env.deploy
    bash scripts/deploy/pre-deploy-check.sh
    bash scripts/deploy/deploy_contract.sh --dry-run
```

The dry-run step must exit 0 before the live step is reached. If either command fails,
the workflow stops and the operator receives the full output as a failed check annotation.

---

## 5. Production Gate

When `DEPLOY_ENV=production`, `--skip-verification` is refused at the script level and
`RELEASE_ARTIFACTS_DIR` must be set. The dry-run flag works in production mode and is
encouraged as a final sanity check even after CI has passed:

```bash
DEPLOY_ENV=production \
RELEASE_ARTIFACTS_DIR=./release-assets \
./deploy_contract.sh --dry-run
```

This confirms that the production environment variables and artifact directory are
correctly set without submitting any transaction.

---

## 6. Rollback and Escalation

| Condition | Action |
|-----------|--------|
| Dry-run exits non-zero | Fix the prerequisite error before proceeding |
| Version mismatch between `Cargo.toml` and `versions.toml` | Update `versions.toml`, commit, and re-run the checklist |
| Uncommitted changes in the working tree | Commit or stash, then re-run |
| RPC unreachable during checklist | Follow [rpc-fallback-activation.md](./rpc-fallback-activation.md) before deploying |
| Live deploy emits a WASM hash that does not match the expected value from CI | Abort, compare hashes with `scripts/release/verify-artifact.sh`, escalate to the security channel |

---

## Related

- `scripts/deploy/deploy_contract.sh` — `--dry-run` and `--help` flags
- `scripts/deploy/deploy_launchpad.sh` — same flags
- `scripts/deploy/deployed_versions.json` — historical WASM hash → source version map
- `versions.toml` — single source of truth for component versions
- [wasm-reproducibility-checklist.md](./wasm-reproducibility-checklist.md) — artifact hash verification
- `docs/RELEASE_VERIFICATION.md` — full artifact signing and verification procedure
