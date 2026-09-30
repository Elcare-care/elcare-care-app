/**
 * Tests for validateIpfsCid — lib/validation.ts (Issue #206).
 *
 * Mirrors the Rust contract-level CID validation so the frontend rejects
 * malformed CIDs before a transaction is ever submitted.
 *
 * Rules under test:
 *   CIDv1 base32 — prefix 'b', 46–100 chars, alphabet a-z and 2-7
 *   CIDv0 base58 — prefix 'Qm', exactly 46 chars, base58 alphabet
 *                  (1-9, A-H, J-N, P-Z, a-k, m-z)
 */
import { validateIpfsCid } from "@/lib/validation";

// ── Test fixtures ──────────────────────────────────────────────────────────────

/** A real-world CIDv1 base32 (59 chars). */
const VALID_V1 = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

/** A real-world CIDv0 base58 (46 chars). */
const VALID_V0 = "QmPK1s3pNYLi9ERiq3BDxKa4XosgWwFRQUydHUtz4YgpqB";

// ── Valid CIDs ─────────────────────────────────────────────────────────────────

describe("validateIpfsCid — valid CIDs", () => {
  it("returns null for a well-formed CIDv1 base32 (59 chars)", () => {
    expect(validateIpfsCid(VALID_V1)).toBeNull();
  });

  it("returns null for a well-formed CIDv0 base58 (46 chars)", () => {
    expect(validateIpfsCid(VALID_V0)).toBeNull();
  });

  it("returns null for CIDv1 at minimum length (46 chars)", () => {
    const cid = "b" + "a".repeat(45); // 1 + 45 = 46
    expect(validateIpfsCid(cid)).toBeNull();
  });

  it("returns null for CIDv1 at maximum length (100 chars)", () => {
    const cid = "b" + "a".repeat(99); // 1 + 99 = 100
    expect(validateIpfsCid(cid)).toBeNull();
  });

  it("returns null for CIDv1 containing valid base32 digits 2-7", () => {
    const cid = "b" + "a2b3c4d5e6f7".repeat(4) + "aaaaaaa"; // 59 chars
    expect(validateIpfsCid(cid)).toBeNull();
  });

  it("returns null for CIDv0 with full base58 uppercase range A-H", () => {
    const cid = "QmABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwx"; // 46 chars
    expect(validateIpfsCid(cid)).toBeNull();
  });

  it("returns null for CIDv0 with base58 digits 1-9", () => {
    const cid = "Qm1111111111111111111111111111111111111111111111"; // 46 chars
    expect(validateIpfsCid(cid)).toBeNull();
  });
});

// ── Length violations ──────────────────────────────────────────────────────────

describe("validateIpfsCid — length violations", () => {
  it("rejects an empty string", () => {
    expect(validateIpfsCid("")).not.toBeNull();
  });

  it("rejects a string of only whitespace", () => {
    expect(validateIpfsCid("   ")).not.toBeNull();
  });

  it("rejects a CID that is too short (45 chars)", () => {
    expect(validateIpfsCid("b" + "a".repeat(44))).not.toBeNull();
  });

  it("rejects a CID that is too long (101 chars)", () => {
    expect(validateIpfsCid("b" + "a".repeat(100))).not.toBeNull();
  });
});

// ── Wrong prefix ───────────────────────────────────────────────────────────────

describe("validateIpfsCid — wrong prefix", () => {
  it("rejects a CID starting with 'z' (unknown multibase prefix)", () => {
    expect(validateIpfsCid("z" + "a".repeat(58))).not.toBeNull();
  });

  it("rejects a CID starting with uppercase 'B' (must be lowercase 'b')", () => {
    expect(validateIpfsCid("B" + "a".repeat(58))).not.toBeNull();
  });

  it("rejects CIDv0 starting with 'Qn' instead of 'Qm'", () => {
    expect(validateIpfsCid("Qn" + "a".repeat(44))).not.toBeNull();
  });

  it("rejects a plain hex multihash string", () => {
    expect(validateIpfsCid("1220" + "a".repeat(60))).not.toBeNull();
  });
});

// ── Illegal characters ─────────────────────────────────────────────────────────

describe("validateIpfsCid — illegal characters", () => {
  it("rejects CIDv1 with uppercase letters (base32 requires lowercase)", () => {
    const cid = "bAFYBEIGDYRZT5SFP7UDM7HU76UH7Y26NF3EFUYLQABF3OC";
    expect(validateIpfsCid(cid)).not.toBeNull();
  });

  it("rejects CIDv1 with digits '8' or '9' (not in base32 alphabet)", () => {
    const cid = "b" + "a".repeat(55) + "89"; // 59 chars, '8'/'9' at end
    expect(validateIpfsCid(cid)).not.toBeNull();
  });

  it("rejects CIDv1 with a hyphen character", () => {
    const cid = "b" + "a".repeat(54) + "-aaa"; // 59 chars with '-'
    expect(validateIpfsCid(cid)).not.toBeNull();
  });

  it("rejects CIDv1 with an embedded space", () => {
    const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y 6nf3efuylqabf3oclgtqy55fbzdi";
    expect(validateIpfsCid(cid)).not.toBeNull();
  });

  it("rejects CIDv0 with '0' (zero — excluded from base58 alphabet)", () => {
    const cid = VALID_V0.slice(0, 45) + "0"; // replace last char with '0'
    expect(validateIpfsCid(cid)).not.toBeNull();
  });

  it("rejects CIDv0 with 'O' (capital O — excluded from base58 alphabet)", () => {
    const cid = VALID_V0.slice(0, 45) + "O";
    expect(validateIpfsCid(cid)).not.toBeNull();
  });

  it("rejects CIDv0 with 'I' (capital I — excluded from base58 alphabet)", () => {
    const cid = VALID_V0.slice(0, 45) + "I";
    expect(validateIpfsCid(cid)).not.toBeNull();
  });

  it("rejects CIDv0 with 'l' (lowercase l — excluded from base58 alphabet)", () => {
    const cid = VALID_V0.slice(0, 45) + "l";
    expect(validateIpfsCid(cid)).not.toBeNull();
  });
});

// ── CIDv0 exact-length enforcement ────────────────────────────────────────────

describe("validateIpfsCid — CIDv0 exact-length enforcement", () => {
  it("rejects CIDv0 with 47 chars (one too long)", () => {
    expect(validateIpfsCid(VALID_V0 + "B")).not.toBeNull();
  });

  it("rejects CIDv0 with 45 chars (one too short)", () => {
    expect(validateIpfsCid(VALID_V0.slice(0, 45))).not.toBeNull();
  });
});

// ── Return-type contract ───────────────────────────────────────────────────────

describe("validateIpfsCid — return type contract", () => {
  it("returns exactly null (not undefined, false, or empty string) for a valid CID", () => {
    expect(validateIpfsCid(VALID_V1)).toBeNull();
  });

  it("returns a non-empty string for an invalid CID", () => {
    const result = validateIpfsCid("bad");
    expect(typeof result).toBe("string");
    expect((result as string).length).toBeGreaterThan(0);
  });

  it("error message mentions CID for an unknown-prefix input", () => {
    const result = validateIpfsCid("x" + "a".repeat(58));
    expect(result).toMatch(/CID/i);
  });

  it("error message mentions the length for a too-short input", () => {
    const result = validateIpfsCid("b" + "a".repeat(10));
    expect(result).toMatch(/short|length|chars/i);
  });

  it("error message mentions the length for a too-long input", () => {
    const result = validateIpfsCid("b" + "a".repeat(105));
    expect(result).toMatch(/long|length|chars/i);
  });
});
