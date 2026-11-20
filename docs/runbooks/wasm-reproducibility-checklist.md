# WASM Reproducibility Evidence Checklist

**Issue**: [#1118](https://github.com/Elcare-care/elcare-care-app/issues/1118)  
**Category**: Reliability, Security, and Operations  
**Severity**: HIGH  
**Owner**: Release operator  
**Last updated**: 2026-07-27

---

## Overview

A deployed WASM binary must be traceable back to a specific source commit and build
environment. Without this traceability, there is no way to confirm that a contract
running on-chain was compiled from the reviewed source code and not from a modified or
malicious build.

This document describes the artifact evidence required for every release, the commands
to verify it, and the escalation path when verification fails.

---

## 1. Required Artifacts per Release

The release workflow (`.github/workflows/release.yml`) produces these files in the
`release-artifacts/` directory. All must be present before promoting a release to any
network.

| Artifact | Purpose |
|----------|---------|
| `wasm/*.wasm` | Compiled contract binaries |
| `SHA256SUMS` | SHA-256 hash of every artifact |
| `SHA256SUMS.bundle` | Sigstore cosign keyless signature bundle |
| `SHA256SUMS.sig` + `SHA256SUMS.pem` | Alternative cosign signature form |
| `PROVENANCE.json` | Source commit, workflow run URL, Rust toolchain version, Node version |

`PROVENANCE.json` is the primary evidence linking each WASM to its source. It records:

```json
{
  "source": {
    "repository": "Elcare-care/elcare-care-app",
    "ref": "refs/tags/v1.2.3",
    "tag": "v1.2.3",
    "commit": "<full SHA>",
    "commit_short": "<12-char SHA>"
  },
  "build": {
    "run_url": "https://github.com/Elcare-care/elcare-care-app/actions/runs/<id>",
    "triggered_by": "push"
  },
  "toolchain": {
    "rust": "rustc 1.xx.x (... )",
    "node": "v20.x.x"
  }
}
```

---

## 2. Verification Commands

### 2a. Full automated verification

Use `scripts/release/verify-artifact.sh` to run all three checks in sequence
(checksums → cosign signature → GitHub attestations):

```bash
./scripts/release/verify-artifact.sh \
  --dir ./release-assets \
  --repo Elcare-care/elcare-care-app \
  --tag v1.2.3        # omit to accept any tag from this repo
```

Expected output on a clean release:

```
Step 1/3  Verifying SHA256SUMS...
  PASS  All checksums in SHA256SUMS match the files on disk

Step 2/3  Verifying cosign keyless signature on SHA256SUMS...
  PASS  cosign verified SHA256SUMS.bundle against GitHub Actions OIDC identity

Step 3/3  Verifying GitHub build-provenance attestations...
  PASS  GitHub attestation verified for wasm/soroban_marketplace.wasm
  PASS  GitHub attestation verified for wasm/soroban_launchpad.wasm
  ...

RESULT: PASS — artifacts are verified. Safe to promote.
```

Exit code 0 means all three checks passed. Exit code 1 means at least one failed.

### 2b. Manual hash check (no tooling required)

If `cosign` or `gh` are unavailable, verify the WASM hash against `versions.toml` and
`deployed_versions.json` manually:

```bash
# Compute the hash of the downloaded WASM
sha256sum release-assets/wasm/soroban_marketplace.wasm

# Compare against SHA256SUMS
grep soroban_marketplace.wasm release-assets/SHA256SUMS

# Compare against the hash recorded after the last deploy
jq '.deployments[-1].wasm_hash' scripts/deploy/deployed_versions.json
```

The hash in `SHA256SUMS` and the hash in `deployed_versions.json` must agree with each
other and with the value you computed locally.

### 2c. Source commit cross-check

```bash
# Confirm PROVENANCE.json matches the git tag you intend to deploy
cat release-assets/PROVENANCE.json | jq '.source'

# Verify the tag points to the same commit in your local clone
git show v1.2.3 --format="%H %s" --no-patch
```

The commit SHA in `PROVENANCE.json` must match the SHA that the git tag resolves to.

### 2d. Toolchain check

Rust's WASM output is not fully deterministic across toolchain versions. Record the
Rust version from `PROVENANCE.json` and confirm it matches the toolchain pinned in
the repository:

```bash
# Toolchain from the release
cat release-assets/PROVENANCE.json | jq -r '.toolchain.rust'

# Toolchain from the repository (if rust-toolchain.toml is present)
cat rust-toolchain.toml 2>/dev/null || rustup show active-toolchain
```

A mismatch does not invalidate the release — the build still used a known toolchain —
but it should be noted in the evidence record.

---

## 3. versions.toml Consistency Check

Before promoting a release, confirm that the versions recorded in `versions.toml` match
the artifacts being deployed:

```bash
# Expected values from versions.toml
grep -A5 '\[components.contracts.marketplace\]' versions.toml

# Actual Cargo.toml version
grep '^version' contracts/soroban-marketplace/Cargo.toml | head -1

# Actual contract_version embedded in source
grep 'CONTRACT_VERSION' contracts/soroban-marketplace/src/contract.rs | head -1
```

All three must agree. If they diverge, do not deploy; open a patch to bring
`versions.toml` in sync and re-run the release workflow.

---

## 4. Evidence Record Template

Fill in one row per deployment and commit it to
`docs/releases/YYYY-MM-DD-<tag>-wasm-evidence.md`.

| Field | Value |
|-------|-------|
| Release tag | |
| Source commit (full SHA) | |
| GitHub Actions run URL | |
| Rust toolchain version | |
| `soroban_marketplace.wasm` SHA-256 | |
| `soroban_launchpad.wasm` SHA-256 | |
| SHA256SUMS cosign result | PASS / FAIL |
| GitHub attestation result | PASS / FAIL |
| versions.toml consistent | YES / NO |
| Operator who verified | |
| Promoted to network | testnet / mainnet |
| Date promoted | |

---

## 5. Mismatch Escalation

A mismatch at any verification step means the artifact is untrusted. Do not deploy.

| Failure | Immediate action |
|---------|-----------------|
| SHA-256 mismatch (file ≠ SHA256SUMS) | Do not deploy. The artifact was tampered with or corrupted in transit. File a security incident. |
| cosign verification fails | Do not deploy. The signature does not match this repo's release workflow. File a security incident. |
| GitHub attestation fails | Do not deploy. The artifact cannot be traced to a known CI run. Investigate the release workflow run URL in PROVENANCE.json. |
| PROVENANCE.json commit does not match the tag | Do not deploy. Rebuild from the correct tag. |
| versions.toml version mismatch | Block the deployment. Open a patch PR to fix versions.toml. |
| Toolchain version changed unexpectedly | Investigate whether the WASM output differs. Rebuild with the pinned toolchain and compare hashes. |

Escalation path: raise in the `#security` channel with the full verification output
attached. Do not share raw WASM binaries in public channels.

---

## 6. Tamper Detection Demo

The verify script includes a manual tamper-test procedure in its header comment. To
confirm detection works in your environment:

```bash
# 1. Run a clean verification — confirm PASS
./scripts/release/verify-artifact.sh --dir ./release-assets --repo Elcare-care/elcare-care-app

# 2. Flip one byte in a WASM binary
printf '\x00' | dd of=./release-assets/wasm/soroban_marketplace.wasm \
  bs=1 seek=4 count=1 conv=notrunc 2>/dev/null

# 3. Re-run — MUST fail at Step 1 (checksum mismatch)
./scripts/release/verify-artifact.sh --dir ./release-assets --repo Elcare-care/elcare-care-app
# Expected: FAIL at SHA256SUMS step, exit code 1
```

Run this test once per new environment to confirm the tooling is working correctly.

---

## Related

- `scripts/release/verify-artifact.sh` — full automated verification
- `scripts/release/verify-artifact.test.sh` — CI test for the verifier itself
- `.github/workflows/release.yml` — how artifacts are built and signed
- `.github/workflows/release-verifier-tests.yml` — CI validation of the verify script
- `versions.toml` — single source of truth for component and contract versions
- `scripts/deploy/deployed_versions.json` — per-deployment WASM hash → source version log
- [contract-deploy-dry-run.md](./contract-deploy-dry-run.md) — pre-deployment validation checklist
