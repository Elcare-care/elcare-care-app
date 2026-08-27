// ─────────────────────────────────────────────────────────────
// lib/validation.ts — Shared validation utilities
// ─────────────────────────────────────────────────────────────

import { StrKey } from "@stellar/stellar-sdk";

/** Format-only fallback: 56-char base32 string starting with G, C, or M. */
function looksLikeStellarAddress(trimmed: string): boolean {
  if (trimmed.length !== 56) return false;
  if (!/^[GCM]/.test(trimmed)) return false;
  return /^[A-Z2-7]{56}$/.test(trimmed);
}

/**
 * Returns true if the given string is a checksum-valid Stellar address:
 *   - G... — Ed25519 public key (verified via StrKey checksum)
 *   - C... — contract address (verified via StrKey checksum)
 *   - M... — muxed account (verified via StrKey checksum)
 *
 * Falls back to format-only regex validation for any address kind the
 * installed `@stellar/stellar-sdk` version does not expose a StrKey
 * checksum verifier for.
 */
export function isValidStellarAddress(address: string): boolean {
  if (!address || typeof address !== "string") return false;
  const trimmed = address.trim();
  if (!looksLikeStellarAddress(trimmed)) return false;

  try {
    switch (trimmed[0]) {
      case "G":
        return StrKey.isValidEd25519PublicKey(trimmed);
      case "C":
        return StrKey.isValidContract(trimmed);
      case "M":
        return StrKey.isValidMed25519PublicKey(trimmed);
      default:
        // Unreachable given looksLikeStellarAddress, but fall back safely.
        return true;
    }
  } catch {
    return false;
  }
}

/**
 * Returns true if the given string is a checksum-valid Stellar public key (G...).
 */
export function isValidStellarPublicKey(address: string): boolean {
  if (!address || typeof address !== "string") return false;
  const trimmed = address.trim();
  if (trimmed.length !== 56 || !/^G[A-Z2-7]{55}$/.test(trimmed)) return false;
  try {
    return StrKey.isValidEd25519PublicKey(trimmed);
  } catch {
    return false;
  }
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

// ── Collection metadata validation (Issue #476) ───────────────────────────────
//
// These constraints mirror the on-chain rules in contracts/*/src/metadata.rs
// exactly. Changing either side without updating the other will cause the
// preflight to pass while the transaction rejects (or vice versa).

/** Maximum collection name length in UTF-8 bytes (mirrors metadata.rs MAX_NAME_LEN). */
export const COLLECTION_NAME_MAX_BYTES = 64;
/** Maximum collection symbol length in UTF-8 bytes (mirrors metadata.rs MAX_SYMBOL_LEN). */
export const COLLECTION_SYMBOL_MAX_BYTES = 16;
/** Maximum per-token or base URI length in bytes (mirrors MAX_URI_LEN). */
export const COLLECTION_URI_MAX_BYTES = 2048;
/** Maximum max_supply value accepted at initialise (mirrors MAX_SUPPLY_LIMIT). */
export const COLLECTION_MAX_SUPPLY_LIMIT = 1_000_000_000;

/**
 * Validates a collection name.
 * @returns `null` when valid, or a human-readable error string.
 */
export function validateCollectionName(name: string): string | null {
  if (!name || name.trim().length === 0) {
    return "Collection name cannot be empty.";
  }
  const byteLen = new TextEncoder().encode(name).length;
  if (byteLen > COLLECTION_NAME_MAX_BYTES) {
    return `Collection name is too long (${byteLen} bytes). Maximum is ${COLLECTION_NAME_MAX_BYTES} bytes.`;
  }
  return null;
}

/**
 * Validates a collection symbol (721-shaped collections only).
 * @returns `null` when valid, or a human-readable error string.
 */
export function validateCollectionSymbol(symbol: string): string | null {
  if (!symbol || symbol.trim().length === 0) {
    return "Collection symbol cannot be empty.";
  }
  const byteLen = new TextEncoder().encode(symbol).length;
  if (byteLen > COLLECTION_SYMBOL_MAX_BYTES) {
    return `Collection symbol is too long (${byteLen} bytes). Maximum is ${COLLECTION_SYMBOL_MAX_BYTES} bytes.`;
  }
  return null;
}

/**
 * Validates a collection max_supply value.
 * @returns `null` when valid, or a human-readable error string.
 */
export function validateCollectionMaxSupply(maxSupply: number | string): string | null {
  const val = typeof maxSupply === "string" ? parseInt(maxSupply, 10) : maxSupply;
  if (!Number.isFinite(val) || val <= 0) {
    return "Max supply must be greater than zero.";
  }
  if (val > COLLECTION_MAX_SUPPLY_LIMIT) {
    return `Max supply cannot exceed ${COLLECTION_MAX_SUPPLY_LIMIT.toLocaleString()}.`;
  }
  return null;
}

/**
 * Validates a token URI or base URI string.
 * @returns `null` when valid, or a human-readable error string.
 */
export function validateCollectionUri(uri: string): string | null {
  if (!uri || uri.length === 0) {
    return "URI cannot be empty.";
  }
  const byteLen = new TextEncoder().encode(uri).length;
  if (byteLen > COLLECTION_URI_MAX_BYTES) {
    return `URI is too long (${byteLen} bytes). Maximum is ${COLLECTION_URI_MAX_BYTES} bytes.`;
  }
  return null;
}
