#!/usr/bin/env bash
# ============================================================
# scripts/release/verify-artifact.sh
#
# Verifies the integrity and provenance of ElcareHub release
# artifacts (contract WASM, ABI package, frontend build, indexer
# image) downloaded from a GitHub Release, before they are
# promoted to any deployment. Never requires production secrets:
# checksum verification is local, and both signature checks use
# keyless/OIDC-based public verification (Sigstore + GitHub's
# Sigstore-backed attestation transparency log).
#
# Usage:
#   ./verify-artifact.sh --dir <path-to-downloaded-release-assets> \
#                         --repo <owner>/<repo> [--tag <vX.Y.Z>]
#
#   ./verify-artifact.sh --dir ./release-assets --repo your-org/elcarehub
#
# What it checks, in order:
#   1. SHA256SUMS  — every file listed matches its checksum on disk.
#   2. cosign       — SHA256SUMS.bundle (or .sig + .pem) verifies in
#                     keyless mode against the GitHub Actions OIDC
#                     issuer, scoped to this repo's release workflow.
#   3. gh attestation — each individual artifact verifies against
#                     GitHub's build-provenance attestation store.
#
# Exit codes:
#   0 — all checks passed, artifacts are verified.
#   1 — one or more checks failed. Treat the release as UNTRUSTED.
#   2 — usage error / missing prerequisites.
#
# Required tools: sha256sum (or shasum), cosign, gh (GitHub CLI).
# None of these require a production secret — cosign verification
# uses Sigstore's public transparency log, and `gh attestation
# verify` works unauthenticated for public repos (a plain
# read-only GITHUB_TOKEN is enough for private ones).
#
# ── Manual tamper-test (demonstrates detection without a test suite) ──
#   1. Run this script once against a downloaded release directory
#      and confirm it PASSes.
#   2. Flip one byte in any artifact, e.g.:
#        printf '\x00' | dd of=./release-assets/abi.json bs=1 seek=4 count=1 conv=notrunc
#   3. Re-run this script. It MUST fail at the SHA256SUMS step
#      (checksum mismatch) — and, if you also re-sign a tampered
#      SHA256SUMS to hide that, the cosign/attestation steps will
#      fail instead because the signature no longer covers the
#      tampered bytes. Either path proves tamper detection works.
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ARTIFACT_DIR=""
REPO=""
TAG=""
OIDC_ISSUER="https://token.actions.githubusercontent.com"
# Scoped to this repo's release workflow so a signature from an unrelated
# workflow/repo cannot be substituted.
CERT_IDENTITY_REGEXP_TEMPLATE='^https://github.com/%s/\.github/workflows/release\.yml@refs/tags/.*$'

usage() {
  grep '^#' "$0" | grep -v '^#!/' | sed 's/^# \{0,1\}//'
}

# Manual arg parsing (supports both --flag value and --flag=value)
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) ARTIFACT_DIR="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --dir=*) ARTIFACT_DIR="${1#*=}"; shift ;;
    --repo=*) REPO="${1#*=}"; shift ;;
    --tag=*) TAG="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: Unknown argument: $1"; usage; exit 2 ;;
  esac
done

if [[ -z "$ARTIFACT_DIR" || -z "$REPO" ]]; then
  echo "ERROR: --dir and --repo are required." >&2
  usage
  exit 2
fi

if [[ ! -d "$ARTIFACT_DIR" ]]; then
  echo "ERROR: Directory not found: $ARTIFACT_DIR" >&2
  exit 2
fi

CERT_IDENTITY_REGEXP="$(printf "$CERT_IDENTITY_REGEXP_TEMPLATE" "$REPO")"

CHECKS_PASSED=0
CHECKS_FAILED=0

pass() { CHECKS_PASSED=$((CHECKS_PASSED + 1)); echo "  PASS  $*"; }
fail() { CHECKS_FAILED=$((CHECKS_FAILED + 1)); echo "  FAIL  $*" >&2; }

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ELCARE-HUB — Release Artifact Verification"
echo "  Directory : $ARTIFACT_DIR"
echo "  Repo      : $REPO"
[[ -n "$TAG" ]] && echo "  Tag       : $TAG"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

cd "$ARTIFACT_DIR"

# ── Prerequisite tools ────────────────────────────────────────────────────────
for cmd in cosign gh; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: '$cmd' is not installed. See docs/RELEASE_VERIFICATION.md." >&2
    exit 2
  fi
done
SHASUM_CMD=""
if command -v sha256sum &>/dev/null; then
  SHASUM_CMD="sha256sum"
elif command -v shasum &>/dev/null; then
  SHASUM_CMD="shasum -a 256"
else
  echo "ERROR: neither sha256sum nor shasum is available." >&2
  exit 2
fi

# ── 1. Checksums ──────────────────────────────────────────────────────────────
echo "Step 1/3  Verifying SHA256SUMS..."
if [[ ! -f SHA256SUMS ]]; then
  fail "SHA256SUMS not found in $ARTIFACT_DIR"
else
  if $SHASUM_CMD -c SHA256SUMS --strict 2>&1 | tee /tmp/verify-artifact-checksums.log; then
    pass "All checksums in SHA256SUMS match the files on disk"
  else
    fail "One or more files do not match SHA256SUMS (see above) — artifact is TAMPERED or CORRUPT"
  fi
fi
echo ""

# ── 2. cosign keyless signature over SHA256SUMS ──────────────────────────────
echo "Step 2/3  Verifying cosign keyless signature on SHA256SUMS..."
if [[ -f SHA256SUMS.bundle ]]; then
  if cosign verify-blob \
    --bundle SHA256SUMS.bundle \
    --certificate-identity-regexp "$CERT_IDENTITY_REGEXP" \
    --certificate-oidc-issuer "$OIDC_ISSUER" \
    SHA256SUMS; then
    pass "cosign verified SHA256SUMS.bundle against GitHub Actions OIDC identity"
  else
    fail "cosign could not verify SHA256SUMS.bundle — signature invalid or identity mismatch"
  fi
elif [[ -f SHA256SUMS.sig && -f SHA256SUMS.pem ]]; then
  if cosign verify-blob \
    --signature SHA256SUMS.sig \
    --certificate SHA256SUMS.pem \
    --certificate-identity-regexp "$CERT_IDENTITY_REGEXP" \
    --certificate-oidc-issuer "$OIDC_ISSUER" \
    SHA256SUMS; then
    pass "cosign verified SHA256SUMS.sig/.pem against GitHub Actions OIDC identity"
  else
    fail "cosign could not verify SHA256SUMS.sig/.pem — signature invalid or identity mismatch"
  fi
else
  fail "No cosign signature found (expected SHA256SUMS.bundle or SHA256SUMS.sig + SHA256SUMS.pem)"
fi
echo ""

# ── 3. GitHub build-provenance attestations ──────────────────────────────────
echo "Step 3/3  Verifying GitHub build-provenance attestations..."
ATTESTED_ANY=false
while IFS= read -r -d '' f; do
  # Skip the checksum/signature/provenance sidecar files themselves — they are
  # covered by cosign above and are also individually attested, but the WASM,
  # ABI, frontend, and indexer artifacts are the primary subjects to check.
  case "$f" in
    *SHA256SUMS*|*.sig|*.pem|*.bundle) continue ;;
  esac
  ATTESTED_ANY=true
  echo "  Checking: $f"
  if gh attestation verify "$f" --repo "$REPO" >/tmp/verify-artifact-attest.log 2>&1; then
    pass "GitHub attestation verified for $f"
  else
    fail "GitHub attestation FAILED for $f (see /tmp/verify-artifact-attest.log)"
  fi
done < <(find . -maxdepth 3 -type f -print0)

if [[ "$ATTESTED_ANY" == "false" ]]; then
  fail "No artifact files found to attest-verify in $ARTIFACT_DIR"
fi
echo ""

# ── Summary ───────────────────────────────────────────────────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Verification Summary — Passed: ${CHECKS_PASSED}  Failed: ${CHECKS_FAILED}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [[ $CHECKS_FAILED -gt 0 ]]; then
  echo "RESULT: FAIL — do not deploy or promote these artifacts." >&2
  exit 1
fi

echo "RESULT: PASS — artifacts are verified. Safe to promote."
exit 0
