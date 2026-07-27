// ─────────────────────────────────────────────────────────────
// lib/validation.ts — Shared validation utilities
// ─────────────────────────────────────────────────────────────

/**
 * Returns true if the given string looks like a valid Stellar public key (G...)
 * or a valid Stellar contract address (C...).
 *
 * Stellar addresses are 56-character base-32 strings:
 *   - Public keys start with G
 *   - Contract addresses start with C
 */
export function isValidStellarAddress(address: string): boolean {
  if (!address || typeof address !== "string") return false;
  const trimmed = address.trim();
  // Must be 56 characters, start with G (public key) or C (contract/muxed)
  if (trimmed.length !== 56) return false;
  if (!/^[GCM]/.test(trimmed)) return false;
  // Must consist only of base-32 characters (uppercase alphanumeric excluding 0, O, I, L)
  return /^[A-Z2-7]{56}$/.test(trimmed);
}

/**
 * Returns true if the given string looks like a valid Stellar public key (G...).
 */
export function isValidStellarPublicKey(address: string): boolean {
  if (!address || typeof address !== "string") return false;
  const trimmed = address.trim();
  return trimmed.length === 56 && /^G[A-Z2-7]{55}$/.test(trimmed);
}

// ── IPFS CID validation (Issue #206) ─────────────────────────────────────────
//
// Mirrors the Rust contract validate_cid logic so the frontend rejects
// malformed CIDs before a transaction is ever submitted.
//
// Accepted formats:
//   CIDv1 base32: starts with 'b', 46–100 chars, alphabet: a-z and 2-7
//   CIDv0 base58: starts with 'Qm', exactly 46 chars, base58 alphabet
//                 (1-9, A-H, J-N, P-Z, a-k, m-z — excludes 0, I, O, l)

/** Regex for a well-formed CIDv0: "Qm" + 44 base58 chars = 46 total. */
const CIDv0_REGEX = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;

/** Regex for a well-formed CIDv1 base32: "b" + 45-99 lowercase base32 chars = 46-100 total. */
const CIDv1_REGEX = /^b[a-z2-7]{45,99}$/;

/**
 * Validate an IPFS CID string against CIDv0 and CIDv1 base32 rules.
 *
 * @returns `null` when the CID is valid, or a human-readable error string.
 *
 * @example
 * validateIpfsCid("bafybeig...")  // → null  (valid CIDv1)
 * validateIpfsCid("QmPK1s3...")   // → null  (valid CIDv0)
 * validateIpfsCid("")             // → "CID cannot be empty."
 * validateIpfsCid("bad")          // → "CID is too short (3 chars)…"
 */
export function validateIpfsCid(cid: string): string | null {
  if (!cid || typeof cid !== "string") {
    return "CID is required.";
  }
  const trimmed = cid.trim();
  if (trimmed.length === 0) {
    return "CID cannot be empty.";
  }
  if (trimmed.length < 46) {
    return `CID is too short (${trimmed.length} chars). A valid CID is at least 46 characters.`;
  }
  if (trimmed.length > 100) {
    return `CID is too long (${trimmed.length} chars). A valid CID is at most 100 characters.`;
  }
  if (trimmed.startsWith("Qm")) {
    if (!CIDv0_REGEX.test(trimmed)) {
      return "Invalid CIDv0: must be exactly 46 base58 characters starting with 'Qm'.";
    }
    return null;
  }
  if (trimmed.startsWith("b")) {
    if (!CIDv1_REGEX.test(trimmed)) {
      return "Invalid CIDv1: must be 46–100 lowercase base32 characters (a-z, 2-7) starting with 'b'.";
    }
    return null;
  }
  return "Invalid CID: must start with 'b' (CIDv1 base32) or 'Qm' (CIDv0 base58).";
}
