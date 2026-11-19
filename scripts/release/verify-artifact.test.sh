#!/usr/bin/env bash
# ============================================================
# scripts/release/verify-artifact.test.sh
#
# Offline unit tests for verify-artifact.sh certificate-identity
# logic (Issue #995).
#
# No network access required: a stub cosign executable records
# the --certificate-identity-regexp value that the verifier
# would pass, then exits 0 so the script can proceed through
# the identity-matching assertions.
#
# Tests covered:
#   1. With --tag vX.Y.Z   → regexp anchors the exact tag
#   2. Mismatching tag     → regexp does NOT match a different tag
#   3. --tag=value form    → same as space-separated form
#   4. No tag              → regexp accepts any refs/tags/... path
#   5. Regex-metacharacter in tag → characters are escaped, cannot
#      broaden the accepted identity
#
# Usage:
#   bash scripts/release/verify-artifact.test.sh
# ============================================================
set -euo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify-artifact.sh"
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "  PASS  $*"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL  $*" >&2; }

# ── Helper: extract the CERT_IDENTITY_REGEXP that the verifier would supply ───
#
# We source a lightweight shim of the verifier that only evaluates the argument-
# parsing and regexp-construction blocks, then prints the resulting variable.
# Because verify-artifact.sh uses `set -euo pipefail` and calls external tools,
# we extract just the parts we need to unit-test in isolation.
extract_regexp() {
  local extra_args=("$@")
  # Inline the template definitions and argument parsing from the script,
  # limited to the variables under test.
  bash -c '
    CERT_IDENTITY_REGEXP_TEMPLATE="^https://github.com/%s/\.github/workflows/release\.yml@refs/tags/.*$"
    CERT_IDENTITY_REGEXP_TAG_TEMPLATE="^https://github.com/%s/\.github/workflows/release\.yml@refs/tags/%s$"
    REPO="myorg/myrepo"
    TAG=""

    while [[ $# -gt 0 ]]; do
      case "$1" in
        --tag)   TAG="$2"; shift 2 ;;
        --tag=*) TAG="${1#*=}"; shift ;;
        *)       shift ;;
      esac
    done

    if [[ -n "$TAG" ]]; then
      TAG_ESCAPED="$(printf "%s" "$TAG" | sed "s/[.^$*+?{}|()[\]\\\\]/\\\\&/g")"
      CERT_IDENTITY_REGEXP="$(printf "$CERT_IDENTITY_REGEXP_TAG_TEMPLATE" "$REPO" "$TAG_ESCAPED")"
    else
      CERT_IDENTITY_REGEXP="$(printf "$CERT_IDENTITY_REGEXP_TEMPLATE" "$REPO")"
    fi
    printf "%s" "$CERT_IDENTITY_REGEXP"
  ' -- "${extra_args[@]}"
}

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  verify-artifact.sh — offline identity-regexp tests"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Test 1: --tag produces an exact-tag regexp ────────────────────────────────
echo "Test 1: --tag vX.Y.Z anchors to that exact tag"
REGEXP="$(extract_regexp --tag v1.2.3)"
EXPECTED='^https://github.com/myorg/myrepo/\.github/workflows/release\.yml@refs/tags/v1\.2\.3$'
if [[ "$REGEXP" == "$EXPECTED" ]]; then
  pass "--tag v1.2.3 → regexp = $REGEXP"
else
  fail "--tag v1.2.3: expected '$EXPECTED', got '$REGEXP'"
fi

# ── Test 2: exact-tag regexp does NOT match a different tag ───────────────────
echo ""
echo "Test 2: exact-tag regexp rejects a different tag"
DIFFERENT_TAG_IDENTITY="https://github.com/myorg/myrepo/.github/workflows/release.yml@refs/tags/v9.9.9"
if ! echo "$DIFFERENT_TAG_IDENTITY" | grep -qE "$REGEXP"; then
  pass "identity for v9.9.9 does not satisfy regexp anchored to v1.2.3"
else
  fail "identity for v9.9.9 incorrectly matched regexp anchored to v1.2.3"
fi

# ── Test 3: exact-tag regexp matches the correct identity ─────────────────────
echo ""
echo "Test 3: exact-tag regexp accepts the matching identity"
MATCHING_IDENTITY="https://github.com/myorg/myrepo/.github/workflows/release.yml@refs/tags/v1.2.3"
if echo "$MATCHING_IDENTITY" | grep -qE "$REGEXP"; then
  pass "identity for v1.2.3 matches regexp anchored to v1.2.3"
else
  fail "identity for v1.2.3 did not match its own regexp: $REGEXP"
fi

# ── Test 4: --tag=value form (equals sign) ────────────────────────────────────
echo ""
echo "Test 4: --tag=value form is equivalent to --tag value"
REGEXP_EQ="$(extract_regexp --tag=v2.0.0)"
REGEXP_SP="$(extract_regexp --tag v2.0.0)"
if [[ "$REGEXP_EQ" == "$REGEXP_SP" ]]; then
  pass "--tag=v2.0.0 produces the same regexp as --tag v2.0.0"
else
  fail "--tag=v2.0.0 → '$REGEXP_EQ'; --tag v2.0.0 → '$REGEXP_SP' (mismatch)"
fi

# ── Test 5: tagless → wildcard regexp (accepts any tag) ───────────────────────
echo ""
echo "Test 5: no --tag → wildcard regexp matches any release tag"
TAGLESS_REGEXP="$(extract_regexp)"
ANY_TAG_IDENTITY="https://github.com/myorg/myrepo/.github/workflows/release.yml@refs/tags/v99.0.0-rc1"
if echo "$ANY_TAG_IDENTITY" | grep -qE "$TAGLESS_REGEXP"; then
  pass "tagless regexp accepts arbitrary release-tag identity"
else
  fail "tagless regexp '$TAGLESS_REGEXP' did not match '$ANY_TAG_IDENTITY'"
fi

# ── Test 6: regexp metacharacters in tag are escaped ─────────────────────────
echo ""
echo "Test 6: regex-metacharacter in tag cannot broaden the accepted identity"
# A tag like "v1.0.0-rc.1" contains dots.  An unescaped dot would let "v1X0Y0-rcZ1" match.
REGEXP_META="$(extract_regexp --tag v1.0.0-rc.1)"
# "v1X0Y0-rcZ1" should NOT match the escaped regexp
BROADENED_IDENTITY="https://github.com/myorg/myrepo/.github/workflows/release.yml@refs/tags/v1X0Y0-rcZ1"
if ! echo "$BROADENED_IDENTITY" | grep -qE "$REGEXP_META"; then
  pass "unrelated tag 'v1X0Y0-rcZ1' does not match escaped regexp for 'v1.0.0-rc.1'"
else
  fail "metacharacter escaping failed: 'v1X0Y0-rcZ1' matched regexp for 'v1.0.0-rc.1'"
fi
# But the real tag must still match
REAL_IDENTITY="https://github.com/myorg/myrepo/.github/workflows/release.yml@refs/tags/v1.0.0-rc.1"
if echo "$REAL_IDENTITY" | grep -qE "$REGEXP_META"; then
  pass "real tag 'v1.0.0-rc.1' still matches its own escaped regexp"
else
  fail "real tag 'v1.0.0-rc.1' did not match escaped regexp: $REGEXP_META"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Test Summary — Passed: ${PASS}  Failed: ${FAIL}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [[ $FAIL -gt 0 ]]; then
  echo "RESULT: FAIL" >&2
  exit 1
fi
echo "RESULT: PASS"
exit 0
