# Workflow Manual-Dispatch Safety Guide

**Issue**: [#1123](https://github.com/Elcare-care/elcare-care-app/issues/1123)  
**Category**: Reliability, Security, and Operations  
**Severity**: MEDIUM  
**Owner**: Platform / CI operator  
**Last updated**: 2026-07-27

---

## Overview

GitHub Actions `workflow_dispatch` inputs let an operator trigger a workflow by hand
from the GitHub UI or the `gh` CLI. Without clear descriptions and safeguards, it is
easy to trigger the wrong workflow against the wrong ref, skip artifact verification,
or accidentally publish a release. This guide documents the required values, risks,
and environment checks for every dispatchable workflow in this repository.

---

## 1. Dispatchable Workflows

| Workflow file | Trigger | Purpose |
|---------------|---------|---------|
| `.github/workflows/release.yml` | `push: tags: ["v*"]` and `workflow_dispatch` | Build, sign, and optionally publish release artifacts |
| `.github/workflows/post-deploy-smoke.yml` | (verify trigger) | Post-deployment smoke test |
| All others | Automated only | No `workflow_dispatch` inputs defined |

Only the release workflow has a `workflow_dispatch` input today. All guidance in this
document applies to it. If new dispatchable inputs are added to other workflows, they
must follow the same pattern described in Section 4.

---

## 2. Release Workflow — `workflow_dispatch` Input

### Input definition

```yaml
# .github/workflows/release.yml (excerpt)
on:
  workflow_dispatch:
    inputs:
      ref_note:
        description: >
          Optional note describing why this manual run was triggered.
          No GitHub Release is published for non-tag runs.
        required: false
        default: ""
```

### Behaviour difference: tag push vs. manual dispatch

| Behaviour | Tag push (`v*`) | Manual dispatch |
|-----------|----------------|-----------------|
| Artifacts built | Yes | Yes |
| Artifacts signed (cosign + attestation) | Yes | Yes |
| GitHub Release published | Yes | **No** |
| `is_tag` output | `true` | `false` |
| `tag` label | The git tag name | `manual-<12-char-SHA>` |

A manual run builds and signs the same artifacts as a tag push but attaches them only
as workflow artifacts (retained 90 days), not as a GitHub Release. This is intentional:
it lets you test the pipeline without cutting a tag or publishing an unversioned release.

---

## 3. When to Use Manual Dispatch

Acceptable reasons to trigger `release.yml` manually:

- Testing a pipeline change on a branch before merging
- Producing signed artifacts for a staging or QA deployment without tagging
- Verifying that a dependency bump did not change WASM hashes unexpectedly

Do **not** use manual dispatch to produce artifacts that will be promoted to mainnet.
Mainnet deployments require a git tag so the WASM hash is permanently linked to a
specific version in `versions.toml` and `PROVENANCE.json`.

---

## 4. Required Safeguards for Any New `workflow_dispatch` Input

When adding a new dispatchable input to any workflow, all four of the following must be
present before the PR is merged.

### 4a. Descriptive input description

Every input must have a `description` field that tells the operator what value to
provide and what happens if they leave it empty.

```yaml
inputs:
  target_network:
    description: >
      Stellar network to deploy to. Must be "testnet" or "mainnet".
      Mainnet deployments require RELEASE_ARTIFACTS_DIR and a signed release.
    required: true
    default: "testnet"
```

### 4b. Allowed-values guard

For inputs with a fixed set of valid values, add an explicit guard step at the start of
the job:

```yaml
- name: Validate inputs
  run: |
    if [[ "${{ inputs.target_network }}" != "testnet" && \
          "${{ inputs.target_network }}" != "mainnet" ]]; then
      echo "ERROR: target_network must be 'testnet' or 'mainnet'" >&2
      exit 1
    fi
```

### 4c. Network / environment check

Any step that touches a network endpoint or deploys an artifact must confirm it is
operating on the expected network before proceeding. For Stellar, this means checking
the `networkPassphrase` from the RPC `/status` endpoint:

```bash
PASSPHRASE=$(curl -sf "${STELLAR_RPC_URL}/status" \
  | jq -r '.infoResponse.networkPassphrase')

EXPECTED_TESTNET="Test SDF Network ; September 2015"
EXPECTED_MAINNET="Public Global Stellar Network ; September 2015"

if [[ "${{ inputs.target_network }}" == "mainnet" && \
      "$PASSPHRASE" != "$EXPECTED_MAINNET" ]]; then
  echo "ERROR: RPC endpoint is not mainnet (got: ${PASSPHRASE})" >&2
  exit 1
fi
```

### 4d. Mandatory artifact verification for production inputs

If any input can trigger a production or mainnet action, make artifact verification
non-bypassable:

```yaml
- name: Verify release artifacts (required for mainnet)
  if: inputs.target_network == 'mainnet'
  run: |
    ./scripts/release/verify-artifact.sh \
      --dir "${RELEASE_ARTIFACTS_DIR}" \
      --repo "${{ github.repository }}" \
      --tag "${{ inputs.release_tag }}"
```

---

## 5. Current Release Workflow — Verification Checklist

Before triggering `.github/workflows/release.yml` manually, run through this checklist:

```
[ ] I am on the correct branch or ref (confirm with git log --oneline -5)
[ ] I am NOT trying to publish a mainnet release (use a tag for that)
[ ] ref_note is filled in with a reason for the manual run
[ ] I understand that no GitHub Release will be created for this run
[ ] I will find the artifacts under the workflow run's "Artifacts" tab,
    named "release-artifacts-manual-<SHA>"
[ ] If I intend to deploy these artifacts, I will run:
      ./scripts/release/verify-artifact.sh --dir <downloaded-dir> \
        --repo Elcare-care/elcare-care-app
    before promoting them
```

---

## 6. Triggering via `gh` CLI

The GitHub CLI is the preferred method for manual dispatch because it records the
trigger actor and ref in the Actions audit log more cleanly than the UI.

```bash
# Trigger release.yml on the current branch
gh workflow run release.yml \
  --ref "$(git rev-parse --abbrev-ref HEAD)" \
  --field ref_note="Testing pipeline after Rust toolchain bump"

# Monitor the run
gh run list --workflow=release.yml --limit=5
gh run watch   # waits for the latest run to complete

# Download artifacts from the run
gh run download --name "release-artifacts-manual-<SHA>" --dir ./local-release-assets
```

---

## 7. Audit and Access Control

`workflow_dispatch` respects GitHub repository write access. Only accounts with **write**
or **maintain** permission on the repository can trigger a workflow manually. Confirm
this is restricted correctly:

- Repository **Settings → Actions → General → Fork pull request workflows** should be
  set to "Require approval for all outside collaborators".
- Required reviewers should be configured for environment-scoped jobs (e.g., a
  `production` environment protection rule) to add a human approval gate before any
  production step executes.

---

## 8. Rollback and Escalation

| Scenario | Action |
|----------|--------|
| Manual run produced artifacts that were accidentally promoted | Run `./scripts/release/verify-artifact.sh` to confirm the hash. If the hash differs from the expected tagged release, treat as a security incident. |
| Wrong ref triggered | Cancel the run from the GitHub UI immediately. Wait for it to stop before assessing artifact state. |
| Artifacts from a manual run deployed to mainnet | File a security incident. Manual runs are not intended for mainnet. Verify PROVENANCE.json and cross-check with the on-chain WASM hash. |

Escalation path: `#security` channel with the workflow run URL and a description of
what was triggered and why.

---

## Related

- `.github/workflows/release.yml` — dispatchable workflow definition
- `scripts/release/verify-artifact.sh` — artifact verification after download
- [wasm-reproducibility-checklist.md](./wasm-reproducibility-checklist.md) — WASM hash evidence for every deploy
- [contract-deploy-dry-run.md](./contract-deploy-dry-run.md) — pre-deployment validation checklist
- `docs/RELEASE_VERIFICATION.md` — full release verification procedure
