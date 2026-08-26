# Release Verification

**Owner:** Platform / Release Engineering
**Related:** [`.github/workflows/release.yml`](../.github/workflows/release.yml) ·
[`scripts/release/verify-artifact.sh`](../scripts/release/verify-artifact.sh) ·
[`scripts/deploy/deploy_contract.sh`](../scripts/deploy/deploy_contract.sh) ·
[`versions.toml`](../versions.toml) · [`CHANGELOG.md`](../CHANGELOG.md)

Build badges tell you a workflow passed. They do not tell you that the file
you downloaded is the file the workflow produced. This document describes how
ElcareHub release artifacts are signed and how to independently verify each
one before deploying or promoting it — as a human running one command, or as
a deployment script gating itself automatically.

## What gets signed

Every push of a `v*` tag runs [`release.yml`](../.github/workflows/release.yml),
which builds and signs:

| Artifact | Contents |
|---|---|
| Contract WASM | `collection_nft_erc721.wasm`, `collection_nft_erc1155.wasm`, `lazy_mint_erc721.wasm`, `lazy_mint_erc1155.wasm`, `soroban_marketplace.wasm`, `soroban_launchpad.wasm` — release-profile builds, same `cargo build --target wasm32v1-none --release` commands as CI |
| ABI package | `abi.json` plus `contract-abi-dist.tar.gz` (the compiled `packages/contract-abi` TypeScript output) |
| Frontend build | `frontend-next-build-<tag>.tar.gz` — a tarball of the Next.js `.next` build output |
| Indexer image | `elcarehub-indexer-<tag>.tar` (a `docker save` of the built image) and `image-id.txt` (its local content digest) |
| `SHA256SUMS` | SHA-256 checksums of every artifact above |
| `PROVENANCE.json` | Build environment metadata (below) |

All of these are uploaded to the GitHub Release for the tag.

> **Indexer image note:** No container registry secret is configured for this
> repository, so the workflow builds and signs the image *locally* (via
> `docker save`) rather than pushing it. Once a registry (GHCR, ECR, etc.) is
> wired up, push the same image and re-run `cosign sign` /
> `attest-build-provenance` against the pushed registry digest — that is an
> operator follow-up, not something this workflow does today.

## The two signature mechanisms

Both are **keyless** — backed by Sigstore's public transparency log and
GitHub Actions' ambient OIDC identity token. Neither requires a stored
signing key or a repository secret, so verification never needs a production
credential.

### 1. GitHub build provenance attestations

`release.yml` calls
[`actions/attest-build-provenance@v1`](https://github.com/actions/attest-build-provenance)
on every artifact (all WASM files, `abi.json`, the ABI dist tarball, the
frontend tarball, the indexer image tarball, `SHA256SUMS`, and
`PROVENANCE.json`). This records a Sigstore-backed attestation in GitHub's
attestation store, cryptographically tying each file's digest to:

- this repository,
- the `release.yml` workflow,
- the exact commit and tag that triggered the run.

Verify it with the `gh` CLI (no token needed for a public repo):

```bash
gh attestation verify ./collection_nft_erc721.wasm --repo your-org/elcarehub
```

### 2. cosign keyless signature over SHA256SUMS

`release.yml` also uses
[`sigstore/cosign-installer`](https://github.com/sigstore/cosign-installer)
and `cosign sign-blob --yes` to sign the `SHA256SUMS` file itself, producing
`SHA256SUMS.bundle` (and, for compatibility, `SHA256SUMS.sig` +
`SHA256SUMS.pem`). This is a second, independently-verifiable signature
format over the *same checksums* that cover every artifact — so verifying
`SHA256SUMS` transitively verifies everything it lists.

Verify it with `cosign` in keyless mode, scoped to this repo's release
workflow identity:

```bash
cosign verify-blob \
  --bundle SHA256SUMS.bundle \
  --certificate-identity-regexp '^https://github.com/your-org/elcarehub/\.github/workflows/release\.yml@refs/tags/.*$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  SHA256SUMS
```

## How an operator verifies a release independently

Prerequisites: `cosign` ([install](https://docs.sigstore.dev/cosign/system_config/installation/)),
`gh` ([install](https://cli.github.com/)), and `sha256sum`/`shasum`.

```bash
# 1. Download every asset from the GitHub Release for the tag you're promoting.
gh release download v1.2.3 --repo your-org/elcarehub --dir ./release-assets

# 2. Run the bundled verification script.
./scripts/release/verify-artifact.sh --dir ./release-assets --repo your-org/elcarehub --tag v1.2.3
```

`verify-artifact.sh` runs, in order, and prints a clear `PASS`/`FAIL` per
check:

1. **Checksums** — every file in `SHA256SUMS` matches the bytes on disk
   (`sha256sum -c --strict`).
2. **cosign** — `SHA256SUMS` verifies against the GitHub Actions OIDC issuer,
   scoped to this repo's `release.yml` workflow (rejects a signature from an
   unrelated repo or workflow).
3. **GitHub attestation** — `gh attestation verify` against every artifact
   file individually.

It exits `0` only if every check passes, and non-zero (with `FAIL` lines) on
any mismatch — safe to use as an automated deployment gate.

### Manual tamper-test (demonstrates detection)

There is no automated test suite for this — it's a one-command manual check,
documented in comments at the top of `verify-artifact.sh` too:

```bash
# 1. Verify a real, unmodified release directory first — confirm it PASSes.
./scripts/release/verify-artifact.sh --dir ./release-assets --repo your-org/elcarehub

# 2. Flip one byte in any artifact.
printf '\x00' | dd of=./release-assets/abi.json bs=1 seek=4 count=1 conv=notrunc

# 3. Re-run. It MUST fail — either at the checksum step (the common case), or
#    at the cosign/attestation step if the tamper also touched SHA256SUMS
#    without a valid re-signature. Either failure path proves detection works.
./scripts/release/verify-artifact.sh --dir ./release-assets --repo your-org/elcarehub
```

## What `PROVENANCE.json` contains

Written by `release.yml` before signing (so it is itself attested and
covered by `SHA256SUMS`):

```jsonc
{
  "source": {
    "repository": "your-org/elcarehub",
    "ref": "refs/tags/v1.2.3",
    "tag": "v1.2.3",
    "commit": "<full sha>",
    "commit_short": "<12-char sha>"
  },
  "build": {
    "workflow": "Release",
    "run_id": "...",
    "run_attempt": "...",
    "run_url": "https://github.com/your-org/elcarehub/actions/runs/...",
    "triggered_by": "push",
    "actor": "...",
    "runner_os": "Linux",
    "runner_arch": "X64",
    "timestamp": "2026-08-25T12:00:00Z"
  },
  "toolchain": {
    "rust": "rustc 1.xx.x (...)",
    "node": "v20.x.x"
  },
  "signing": {
    "mechanisms": [
      "actions/attest-build-provenance (GitHub Sigstore-backed keyless attestation)",
      "cosign sign-blob --yes (Sigstore keyless, GitHub Actions OIDC identity)"
    ],
    "checksum_file": "SHA256SUMS"
  }
}
```

This gives an operator the source revision, build environment, and toolchain
versions without needing to trust anything beyond the signed file itself.

## How deployment enforcement works

[`scripts/deploy/deploy_contract.sh`](../scripts/deploy/deploy_contract.sh)
gates on release verification when an operator is promoting a specific,
downloaded release rather than building fresh from a working tree:

- Set `RELEASE_ARTIFACTS_DIR=/path/to/downloaded/release` (and optionally
  `RELEASE_REPO=owner/repo`, defaults to `your-org/elcarehub`) and the script
  runs `verify-artifact.sh` against that directory **before** building or
  deploying anything. A failed verification aborts the deployment
  (non-zero exit) with no on-chain changes made.
- If `RELEASE_ARTIFACTS_DIR` is unset, the script assumes the common
  testnet-iteration workflow — building directly from source — and skips the
  gate with a printed note. This is not "unverified deployment" in the
  release sense; there is no downloaded release artifact to verify.
- `--skip-verification` bypasses the gate for local/dev debugging only. Using
  it always prints an `UNSAFE` warning to the log.
- Setting `DEPLOY_ENV=production` (or `PRODUCTION=true`) makes verification
  **mandatory**: `RELEASE_ARTIFACTS_DIR` must be set and must pass
  verification, and `--skip-verification` is rejected outright — the script
  exits before touching any prerequisite or building anything.

This mirrors the existing fail-closed style of
[`scripts/deploy/health-gate.sh`](../scripts/deploy/health-gate.sh) (which
gates *post*-deploy traffic shifting on health checks) by adding a
symmetrical *pre*-deploy gate on artifact provenance.
