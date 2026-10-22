/**
 * Image-layer scan gate fixture — Issue #998
 *
 * Purpose
 * -------
 * This file exists solely to verify that the `gitleaks-docker-image` CI job
 * (see .github/workflows/secret-scan.yml) would correctly FAIL on a non-
 * allowlisted secret baked into an image layer — proving the gate is active —
 * without ever printing the full matched value in CI logs (--redact).
 *
 * The value below is a synthetic, clearly-labelled Stellar-shaped key.  It
 * matches the `stellar-secret-key` gitleaks rule (S + 55 base32 chars) and is
 * explicitly added to the [allowlist] regexes in .gitleaks.toml so normal CI
 * passes.  Remove the allowlist entry to confirm the gate fires.
 *
 * IMPORTANT — this is NOT a real or derivable secret:
 *   - It is constructed from the repeating pattern "IMAGELAYER" padded to 56
 *     chars, not a valid Stellar keypair seed.
 *   - It cannot be used to sign or derive any real account.
 *   - It is present in source only; it is never set as an environment variable
 *     or written to any file outside of this comment block.
 *
 * How to manually verify the gate
 * --------------------------------
 * 1. Remove the `img_layer_scan_gate_fixture` allowlist entry from
 *    .gitleaks.toml.
 * 2. Run: gitleaks detect --no-git --source indexer --config .gitleaks.toml
 *         --redact --exit-code 1
 * 3. Confirm gitleaks exits 1 and that the logged finding shows only a
 *    redacted value (REDACTED), not the full string.
 * 4. Re-add the allowlist entry before committing.
 *
 * The synthetic value (allowlisted in .gitleaks.toml):
 *   SIMAGEL4YERSCANGATE000000000000000000000000000000000000X
 *
 * Allowlist entry in .gitleaks.toml:
 *   # Synthetic fixture for image-layer scan gate (Issue #998) — not a real key.
 *   '''SIMAGEL4YERSCANGATE000000000000000000000000000000000000X''',
 */

// No runtime code — this file is a documentation fixture only.
export {};
