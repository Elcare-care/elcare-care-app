#!/usr/bin/env bash
# ============================================================
# scripts/release/verify-artifact-tamper.test.sh
#
# Offline tamper-detection tests for verify-artifact.sh (Issue #996).
#
# Every test runs entirely offline: no real cosign, no GitHub CLI,
# no network access.  Stub executables are injected ahead of the
# system PATH so the verifier never touches the network.
#
# Tamper classes tested:
#   A. Modified artifact (checksum mismatch)
#   B. Corrupted SHA256SUMS file
#   C. Missing signature sidecar
#   D. Missing attestation (stub cosign passes but stub gh fails)
#   E. Valid fixture — full happy path (must exit 0)
#
# Each test:
#   1. Creates an isolated workspace under $(mktemp -d).
#   2. Writes a minimal but structurally correct release directory.
#   3. Injects stub cosign / gh executables that record invocations
#      and return controlled exit codes.
#   4. Runs verify-artifact.sh and asserts the expected exit code.
#   5. Cleans up unconditionally via trap.
#
# Usage:
#   bash scripts/release/verify-artifact-tamper.test.sh
# ============================================================
set -euo pipefail

VERIFIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify-artifact.sh"
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "  PASS  $*"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL  $*" >&2; }

# ── Shared helper: build a minimal valid release directory ────────────────────
# Arguments: destination directory
make_release_dir() {
  local dir="$1"
  mkdir -p "$dir"

  # Minimal WASM artifact
  printf 'FAKE_WASM_BINARY_CONTENT' > "$dir/contract.wasm"

  # Correct SHA256SUMS (computed locally, offline)
  (cd "$dir" && sha256sum contract.wasm > SHA256SUMS)

  # Fake cosign bundle sidecar (content is irrelevant — the stub cosign ignores it)
  printf '{"bundle":"fake"}' > "$dir/SHA256SUMS.bundle"
}

# ── Shared helper: inject stub cosign that always passes ─────────────────────
make_stub_cosign_pass() {
  local bin_dir="$1"
  cat > "$bin_dir/cosign" <<'EOF'
#!/usr/bin/env bash
# Stub cosign — records arguments, always exits 0.
echo "[stub cosign] $*" >> /tmp/stub-cosign-calls.log
exit 0
EOF
  chmod +x "$bin_dir/cosign"
}

# ── Shared helper: inject stub cosign that always fails ──────────────────────
make_stub_cosign_fail() {
  local bin_dir="$1"
  cat > "$bin_dir/cosign" <<'EOF'
#!/usr/bin/env bash
echo "[stub cosign FAIL] $*" >&2
exit 1
EOF
  chmod +x "$bin_dir/cosign"
}

# ── Shared helper: inject stub gh that always passes attestation verify ───────
make_stub_gh_pass() {
  local bin_dir="$1"
  cat > "$bin_dir/gh" <<'EOF'
#!/usr/bin/env bash
# Stub gh — passes attestation verify unconditionally.
echo "[stub gh] $*" >> /tmp/stub-gh-calls.log
exit 0
EOF
  chmod +x "$bin_dir/gh"
}

# ── Shared helper: inject stub gh that always fails attestation verify ────────
make_stub_gh_fail() {
  local bin_dir="$1"
  cat > "$bin_dir/gh" <<'EOF'
#!/usr/bin/env bash
echo "[stub gh FAIL] attestation verification failed" >&2
exit 1
EOF
  chmod +x "$bin_dir/gh"
}

# ── Shared helper: inject stub sha256sum that wraps the real one ──────────────
# (identity passthrough — lets the verifier use the real checksum tool)
make_stub_sha256sum_passthrough() {
  local bin_dir="$1"
  # On macOS sha256sum may not exist; create a shim that calls shasum -a 256
  if command -v sha256sum &>/dev/null; then
    ln -sf "$(command -v sha256sum)" "$bin_dir/sha256sum"
  else
    cat > "$bin_dir/sha256sum" <<'EOF'
#!/usr/bin/env bash
shasum -a 256 "$@"
EOF
    chmod +x "$bin_dir/sha256sum"
  fi
}

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  verify-artifact.sh — offline tamper-detection tests"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ══════════════════════════════════════════════════════════════
# Test E (happy path first so we know the harness itself works)
# ══════════════════════════════════════════════════════════════
echo "Test E: valid fixture — all checks pass (exit 0)"
WORK_E="$(mktemp -d)"
BIN_E="$WORK_E/bin"
mkdir -p "$BIN_E"
trap 'rm -rf "$WORK_E"' EXIT INT TERM
make_release_dir "$WORK_E/assets"
make_stub_cosign_pass   "$BIN_E"
make_stub_gh_pass       "$BIN_E"
make_stub_sha256sum_passthrough "$BIN_E"

ACTUAL_E=0
PATH="$BIN_E:$PATH" bash "$VERIFIER" \
  --dir "$WORK_E/assets" \
  --repo testorg/testrepo \
  > /tmp/verifier-test-e.log 2>&1 || ACTUAL_E=$?

if [[ $ACTUAL_E -eq 0 ]]; then
  pass "valid fixture → exit 0"
else
  fail "valid fixture → expected exit 0, got $ACTUAL_E (see /tmp/verifier-test-e.log)"
fi

# Reset trap for next test (each test creates a new WORK dir)
trap - EXIT INT TERM

# ══════════════════════════════════════════════════════════════
# Test A: modified artifact — checksum mismatch
# ══════════════════════════════════════════════════════════════
echo ""
echo "Test A: modified artifact detected at checksum step (non-zero exit)"
WORK_A="$(mktemp -d)"
BIN_A="$WORK_A/bin"
mkdir -p "$BIN_A"
trap 'rm -rf "$WORK_A"' EXIT INT TERM
make_release_dir "$WORK_A/assets"
make_stub_cosign_pass "$BIN_A"
make_stub_gh_pass     "$BIN_A"
make_stub_sha256sum_passthrough "$BIN_A"

# Tamper: flip bytes in the artifact AFTER the checksum was written
printf '\xDE\xAD\xBE\xEF' | dd of="$WORK_A/assets/contract.wasm" bs=1 seek=0 count=4 conv=notrunc 2>/dev/null

ACTUAL_A=0
PATH="$BIN_A:$PATH" bash "$VERIFIER" \
  --dir "$WORK_A/assets" \
  --repo testorg/testrepo \
  > /tmp/verifier-test-a.log 2>&1 || ACTUAL_A=$?

if [[ $ACTUAL_A -ne 0 ]]; then
  pass "tampered artifact → exit $ACTUAL_A (non-zero, detection confirmed)"
else
  fail "tampered artifact → expected non-zero exit, got 0 (tamper NOT detected)"
fi

trap - EXIT INT TERM

# ══════════════════════════════════════════════════════════════
# Test B: corrupted SHA256SUMS
# ══════════════════════════════════════════════════════════════
echo ""
echo "Test B: corrupted SHA256SUMS is detected (non-zero exit)"
WORK_B="$(mktemp -d)"
BIN_B="$WORK_B/bin"
mkdir -p "$BIN_B"
trap 'rm -rf "$WORK_B"' EXIT INT TERM
make_release_dir "$WORK_B/assets"
make_stub_cosign_pass "$BIN_B"
make_stub_gh_pass     "$BIN_B"
make_stub_sha256sum_passthrough "$BIN_B"

# Corrupt the checksum file: replace the hash with zeros
sed -i.bak 's/^[0-9a-f]*/0000000000000000000000000000000000000000000000000000000000000000/' \
  "$WORK_B/assets/SHA256SUMS" 2>/dev/null || \
  perl -i -pe 's/^[0-9a-f]*/0000000000000000000000000000000000000000000000000000000000000000/' \
  "$WORK_B/assets/SHA256SUMS"

ACTUAL_B=0
PATH="$BIN_B:$PATH" bash "$VERIFIER" \
  --dir "$WORK_B/assets" \
  --repo testorg/testrepo \
  > /tmp/verifier-test-b.log 2>&1 || ACTUAL_B=$?

if [[ $ACTUAL_B -ne 0 ]]; then
  pass "corrupted SHA256SUMS → exit $ACTUAL_B (non-zero, detection confirmed)"
else
  fail "corrupted SHA256SUMS → expected non-zero exit, got 0 (NOT detected)"
fi

trap - EXIT INT TERM

# ══════════════════════════════════════════════════════════════
# Test C: missing cosign signature sidecar
# ══════════════════════════════════════════════════════════════
echo ""
echo "Test C: missing SHA256SUMS.bundle fails closed (non-zero exit)"
WORK_C="$(mktemp -d)"
BIN_C="$WORK_C/bin"
mkdir -p "$BIN_C"
trap 'rm -rf "$WORK_C"' EXIT INT TERM
make_release_dir "$WORK_C/assets"
make_stub_cosign_pass "$BIN_C"
make_stub_gh_pass     "$BIN_C"
make_stub_sha256sum_passthrough "$BIN_C"

# Remove all signature sidecars — no bundle, no .sig/.pem pair
rm -f "$WORK_C/assets/SHA256SUMS.bundle" \
      "$WORK_C/assets/SHA256SUMS.sig" \
      "$WORK_C/assets/SHA256SUMS.pem"

ACTUAL_C=0
PATH="$BIN_C:$PATH" bash "$VERIFIER" \
  --dir "$WORK_C/assets" \
  --repo testorg/testrepo \
  > /tmp/verifier-test-c.log 2>&1 || ACTUAL_C=$?

if [[ $ACTUAL_C -ne 0 ]]; then
  pass "missing signature sidecar → exit $ACTUAL_C (fails closed)"
else
  fail "missing signature sidecar → expected non-zero exit, got 0 (did NOT fail closed)"
fi

trap - EXIT INT TERM

# ══════════════════════════════════════════════════════════════
# Test D: stub gh fails attestation verify
# ══════════════════════════════════════════════════════════════
echo ""
echo "Test D: failed attestation verify fails closed (non-zero exit)"
WORK_D="$(mktemp -d)"
BIN_D="$WORK_D/bin"
mkdir -p "$BIN_D"
trap 'rm -rf "$WORK_D"' EXIT INT TERM
make_release_dir "$WORK_D/assets"
make_stub_cosign_pass "$BIN_D"
make_stub_gh_fail     "$BIN_D"       # <-- gh fails
make_stub_sha256sum_passthrough "$BIN_D"

ACTUAL_D=0
PATH="$BIN_D:$PATH" bash "$VERIFIER" \
  --dir "$WORK_D/assets" \
  --repo testorg/testrepo \
  > /tmp/verifier-test-d.log 2>&1 || ACTUAL_D=$?

if [[ $ACTUAL_D -ne 0 ]]; then
  pass "failed attestation → exit $ACTUAL_D (fails closed)"
else
  fail "failed attestation → expected non-zero exit, got 0 (did NOT fail closed)"
fi

trap - EXIT INT TERM

# ══════════════════════════════════════════════════════════════
# Test F: swapped signature (cosign verify-blob fails)
# ══════════════════════════════════════════════════════════════
echo ""
echo "Test F: swapped/invalid cosign signature fails closed (non-zero exit)"
WORK_F="$(mktemp -d)"
BIN_F="$WORK_F/bin"
mkdir -p "$BIN_F"
trap 'rm -rf "$WORK_F"' EXIT INT TERM
make_release_dir "$WORK_F/assets"
make_stub_cosign_fail "$BIN_F"       # <-- cosign fails
make_stub_gh_pass     "$BIN_F"
make_stub_sha256sum_passthrough "$BIN_F"

ACTUAL_F=0
PATH="$BIN_F:$PATH" bash "$VERIFIER" \
  --dir "$WORK_F/assets" \
  --repo testorg/testrepo \
  > /tmp/verifier-test-f.log 2>&1 || ACTUAL_F=$?

if [[ $ACTUAL_F -ne 0 ]]; then
  pass "invalid cosign signature → exit $ACTUAL_F (fails closed)"
else
  fail "invalid cosign signature → expected non-zero exit, got 0 (NOT detected)"
fi

trap - EXIT INT TERM

# ══════════════════════════════════════════════════════════════
# Test G: empty artifact directory — no artifact files to verify
# ══════════════════════════════════════════════════════════════
echo ""
echo "Test G: empty artifact directory fails closed (exit 1, no files to attest)"
WORK_G="$(mktemp -d)"
BIN_G="$WORK_G/bin"
ASSETS_G="$WORK_G/assets"
mkdir -p "$BIN_G" "$ASSETS_G"
trap 'rm -rf "$WORK_G"' EXIT INT TERM
make_stub_cosign_pass "$BIN_G"
make_stub_gh_pass     "$BIN_G"
make_stub_sha256sum_passthrough "$BIN_G"

ACTUAL_G=0
PATH="$BIN_G:$PATH" bash "$VERIFIER" \
  --dir "$ASSETS_G" \
  --repo testorg/testrepo \
  > /tmp/verifier-test-g.log 2>&1 || ACTUAL_G=$?

if [[ $ACTUAL_G -ne 0 ]]; then
  pass "empty directory → exit $ACTUAL_G (fails closed)"
else
  fail "empty directory → expected non-zero exit, got 0"
fi

trap - EXIT INT TERM

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
