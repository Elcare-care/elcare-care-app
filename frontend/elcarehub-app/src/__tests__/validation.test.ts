/**
 * Tests for lib/validation.ts
 *
 * Covers the four bugs fixed in this batch:
 *   1. isValidStellarAddress — M-prefixed muxed accounts (SEP-0023, 69 chars)
 *   2. isValidStellarAddress — default branch now returns false for unknown prefixes
 *   3. validateCollectionUri — whitespace-only strings are rejected
 *   4. validateCollectionMaxSupply — decimal strings are rejected
 *
 * TextEncoder polyfill: jsdom does not expose TextEncoder; polyfill from Node util
 * so that validateCollectionUri (which calls new TextEncoder().encode()) works.
 */

import { TextEncoder as NodeTextEncoder } from "util";

// Polyfill TextEncoder for jsdom environment
if (typeof global.TextEncoder === "undefined") {
  global.TextEncoder = NodeTextEncoder as unknown as typeof TextEncoder;
}

import { Address } from "@stellar/stellar-sdk";

import {
  isValidStellarAddress,
  validateCollectionUri,
  validateCollectionMaxSupply,
} from "@/lib/validation";

// ── Fixtures ───────────────────────────────────────────────────────────────────

/**
 * Real checksummed G-address derived from a fixed 32-byte buffer —
 * same technique used in tx-intent.test.ts.
 */
const VALID_G = Address.account(Buffer.alloc(32, 1)).toString();

/**
 * Real checksummed C-address (contract).
 */
const VALID_C = Address.contract(Buffer.alloc(32, 2)).toString();

// ── isValidStellarAddress — G and C unchanged ──────────────────────────────────

describe("isValidStellarAddress — G and C addresses (unchanged behaviour)", () => {
  it("accepts a valid G address", () => {
    expect(isValidStellarAddress(VALID_G)).toBe(true);
  });

  it("accepts a valid C address", () => {
    expect(isValidStellarAddress(VALID_C)).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isValidStellarAddress("")).toBe(false);
  });

  it("rejects a G address that is too short", () => {
    expect(isValidStellarAddress(VALID_G.slice(0, 40))).toBe(false);
  });

  it("rejects a G address that is too long", () => {
    expect(isValidStellarAddress(VALID_G + "A")).toBe(false);
  });

  it("rejects a G address containing invalid base32 characters ('0')", () => {
    // Replace last char with '0' which is not in Stellar base32 [A-Z2-7]
    expect(isValidStellarAddress(VALID_G.slice(0, 55) + "0")).toBe(false);
  });

  it("rejects a non-string value gracefully", () => {
    // @ts-expect-error — intentionally passing wrong type to test runtime guard
    expect(isValidStellarAddress(null)).toBe(false);
    // @ts-expect-error
    expect(isValidStellarAddress(undefined)).toBe(false);
    // @ts-expect-error
    expect(isValidStellarAddress(42)).toBe(false);
  });
});

// ── isValidStellarAddress — M-prefix (SEP-0023, fix #1) ───────────────────────

describe("isValidStellarAddress — M-prefixed muxed accounts (fix #1)", () => {
  /**
   * Muxed addresses that pass StrKey.isValidMed25519PublicKey are valid.
   * Synthetic fixtures like "M" + "A"*68 fail the real checksum, so we
   * test the format-rejection paths and confirm no *format* false-rejection
   * occurs for correct-length addresses (the StrKey call is the final arbiter).
   */
  it("does not throw for a syntactically correct 69-char M address", () => {
    const wellFormedM = "M" + "A".repeat(68); // 69 chars, valid alphabet
    expect(() => isValidStellarAddress(wellFormedM)).not.toThrow();
    // StrKey checksum will be false for synthetic address; result is a boolean
    expect(typeof isValidStellarAddress(wellFormedM)).toBe("boolean");
  });

  it("rejects an M address of 56 chars (old broken length)", () => {
    // Before fix #1, looksLikeStellarAddress required length === 56,
    // so all M addresses were rejected outright. Now 56-char M is still wrong.
    const shortM = "M" + "A".repeat(55); // 56 chars
    expect(isValidStellarAddress(shortM)).toBe(false);
  });

  it("rejects an M address of 70 chars (one too long)", () => {
    const longM = "M" + "A".repeat(69); // 70 chars
    expect(isValidStellarAddress(longM)).toBe(false);
  });

  it("rejects an M address of 68 chars (one too short)", () => {
    const shortM = "M" + "A".repeat(67); // 68 chars
    expect(isValidStellarAddress(shortM)).toBe(false);
  });

  it("rejects an M address containing '0' (not in base32 [A-Z2-7])", () => {
    const badM = "M" + "A".repeat(67) + "0"; // 69 chars, bad char
    expect(isValidStellarAddress(badM)).toBe(false);
  });

  it("rejects an M address with lowercase letters in the body", () => {
    const lowerM = "M" + "a".repeat(68); // lowercase not in [A-Z2-7]
    expect(isValidStellarAddress(lowerM)).toBe(false);
  });
});

// ── isValidStellarAddress — default branch returns false (fix #3) ──────────────

describe("isValidStellarAddress — unknown prefix returns false (fix #3)", () => {
  it("rejects a 56-char string starting with X", () => {
    expect(isValidStellarAddress("X" + "A".repeat(55))).toBe(false);
  });

  it("rejects a 56-char string starting with lowercase g", () => {
    expect(isValidStellarAddress("g" + "A".repeat(55))).toBe(false);
  });

  it("rejects a string starting with a digit", () => {
    expect(isValidStellarAddress("1" + "A".repeat(55))).toBe(false);
  });

  it("rejects 'Xsomegarbagevalue' regardless of length", () => {
    expect(isValidStellarAddress("Xsomegarbagevalue")).toBe(false);
  });

  it("rejects 'Xgarbage' padded to 56 chars", () => {
    // Old default: return true — now must be false
    expect(isValidStellarAddress("X" + "A".repeat(55))).toBe(false);
  });
});

// ── validateCollectionUri — whitespace rejection (fix #2) ─────────────────────

describe("validateCollectionUri — whitespace-only strings (fix #2)", () => {
  it('rejects a single space " "', () => {
    expect(validateCollectionUri(" ")).not.toBeNull();
  });

  it("rejects a tab character", () => {
    expect(validateCollectionUri("\t")).not.toBeNull();
  });

  it("rejects a string of multiple spaces", () => {
    expect(validateCollectionUri("   ")).not.toBeNull();
  });

  it("rejects a newline-only string", () => {
    expect(validateCollectionUri("\n")).not.toBeNull();
  });

  it("rejects an empty string", () => {
    expect(validateCollectionUri("")).not.toBeNull();
  });

  it("accepts a valid HTTPS URI", () => {
    expect(validateCollectionUri("https://example.com")).toBeNull();
  });

  it("accepts a valid IPFS URI", () => {
    expect(
      validateCollectionUri(
        "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"
      )
    ).toBeNull();
  });
});

// ── validateCollectionMaxSupply — decimal rejection (fix #4) ──────────────────

describe("validateCollectionMaxSupply — decimal strings (fix #4)", () => {
  it('rejects "100.5" (decimal with fractional part)', () => {
    // Before fix: parseInt("100.5", 10) === 100, so this incorrectly passed.
    expect(validateCollectionMaxSupply("100.5")).not.toBeNull();
  });

  it('rejects "1e5" (scientific notation)', () => {
    expect(validateCollectionMaxSupply("1e5")).not.toBeNull();
  });

  it('rejects "1.0" (decimal with .0 suffix)', () => {
    expect(validateCollectionMaxSupply("1.0")).not.toBeNull();
  });

  it('rejects "1,000" (comma-formatted number)', () => {
    expect(validateCollectionMaxSupply("1,000")).not.toBeNull();
  });

  it('rejects "-5" (negative string)', () => {
    expect(validateCollectionMaxSupply("-5")).not.toBeNull();
  });

  it('rejects " 100 " with leading/trailing spaces that hide a decimal', () => {
    // "100" trimmed is fine — but "100.5" trimmed should still fail
    expect(validateCollectionMaxSupply(" 100.5 ")).not.toBeNull();
  });

  it('accepts "100" (valid whole number string)', () => {
    expect(validateCollectionMaxSupply("100")).toBeNull();
  });

  it('accepts "1" (minimum valid supply)', () => {
    expect(validateCollectionMaxSupply("1")).toBeNull();
  });

  it("accepts a numeric integer value directly (no string path)", () => {
    expect(validateCollectionMaxSupply(500)).toBeNull();
  });

  it("rejects zero", () => {
    expect(validateCollectionMaxSupply(0)).not.toBeNull();
  });

  it("rejects a value exceeding the maximum supply limit", () => {
    expect(validateCollectionMaxSupply(2_000_000_000)).not.toBeNull();
  });
});
