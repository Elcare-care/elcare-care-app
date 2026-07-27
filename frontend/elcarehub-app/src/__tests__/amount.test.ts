/**
 * Tests for lib/amount.ts — shared amount formatting utility (Issue #303)
 */

import {
  baseToDecimalString,
  decimalStringToBase,
  baseToDisplay,
  displayToBase,
  validateAmountInput,
  formatAmount,
  buildFeePreview,
  MAX_I128,
} from "@/lib/amount";
import type { TokenConfig } from "@/config/tokens";

// ── Test fixtures ────────────────────────────────────────────────────────────

const XLM: TokenConfig = {
  symbol: "XLM",
  name: "Stellar Lumens",
  address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  decimals: 7,
};

const USDC: TokenConfig = {
  symbol: "USDC",
  name: "USD Coin",
  address: "CCW67ZMUSDC0000000000000000000000000000000000000000000000000",
  decimals: 7,
};

const ZERO_DEC: TokenConfig = { ...XLM, decimals: 0 };

// ════════════════════════════════════════════════════════════════════════════
// baseToDecimalString
// ════════════════════════════════════════════════════════════════════════════

describe("baseToDecimalString", () => {
  test("converts 1 XLM (10_000_000 stroops)", () => {
    expect(baseToDecimalString(10_000_000n, 7)).toBe("1");
  });

  test("converts smallest unit (1 stroop)", () => {
    expect(baseToDecimalString(1n, 7)).toBe("0.0000001");
  });

  test("strips trailing fractional zeros", () => {
    expect(baseToDecimalString(15_500_000n, 7)).toBe("1.55");
  });

  test("handles zero", () => {
    expect(baseToDecimalString(0n, 7)).toBe("0");
  });

  test("handles negative values", () => {
    expect(baseToDecimalString(-10_000_000n, 7)).toBe("-1");
  });

  test("handles large value", () => {
    expect(baseToDecimalString(1_000_000_000_000_000n, 7)).toBe("100000000");
  });

  test("zero decimals returns integer string", () => {
    expect(baseToDecimalString(42n, 0)).toBe("42");
  });

  test("throws for negative decimals", () => {
    expect(() => baseToDecimalString(1n, -1)).toThrow(RangeError);
  });

  test("handles all-fractional value (< 1 unit)", () => {
    expect(baseToDecimalString(500_000n, 7)).toBe("0.05");
  });

  test("very large amount near i128 max", () => {
    // Just test it doesn't throw and produces a long string
    const result = baseToDecimalString(MAX_I128, 7);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(10);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// decimalStringToBase
// ════════════════════════════════════════════════════════════════════════════

describe("decimalStringToBase", () => {
  test("parses '1' with 7 decimals", () => {
    expect(decimalStringToBase("1", 7)).toBe(10_000_000n);
  });

  test("parses '1.55' with 7 decimals", () => {
    expect(decimalStringToBase("1.55", 7)).toBe(15_500_000n);
  });

  test("parses '0.0000001' (min stroop)", () => {
    expect(decimalStringToBase("0.0000001", 7)).toBe(1n);
  });

  test("rejects negative values", () => {
    expect(decimalStringToBase("-1", 7)).toBeNull();
  });

  test("rejects alphabetic input", () => {
    expect(decimalStringToBase("abc", 7)).toBeNull();
  });

  test("rejects empty string", () => {
    expect(decimalStringToBase("", 7)).toBeNull();
  });

  test("rejects too many decimal places", () => {
    expect(decimalStringToBase("1.00000001", 7)).toBeNull(); // 8 decimals for 7-decimal token
  });

  test("accepts exactly max decimal places", () => {
    expect(decimalStringToBase("1.0000001", 7)).toBe(10_000_001n);
  });

  test("rejects exponent notation", () => {
    expect(decimalStringToBase("1e7", 7)).toBeNull();
  });

  test("handles trailing dot as zero fraction", () => {
    expect(decimalStringToBase("1.", 7)).toBe(10_000_000n);
  });

  test("zero decimals token", () => {
    expect(decimalStringToBase("42", 0)).toBe(42n);
    expect(decimalStringToBase("42.1", 0)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Round-trip: baseToDisplay / displayToBase
// ════════════════════════════════════════════════════════════════════════════

describe("round-trip baseToDisplay / displayToBase", () => {
  const cases: bigint[] = [
    1n,
    100n,
    10_000_000n,
    123_456_789n,
    999_999_999_999n,
  ];

  test.each(cases)("round-trip for %s stroops", (stroops) => {
    const display = baseToDisplay(stroops, XLM);
    const back = displayToBase(display, XLM);
    expect(back).toBe(stroops);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// validateAmountInput
// ════════════════════════════════════════════════════════════════════════════

describe("validateAmountInput", () => {
  test("valid amount returns baseUnits", () => {
    const res = validateAmountInput("1.5", XLM);
    expect(res.valid).toBe(true);
    expect(res.baseUnits).toBe(15_000_000n);
    expect(res.error).toBeNull();
  });

  test("empty string → EMPTY", () => {
    const res = validateAmountInput("", XLM);
    expect(res.valid).toBe(false);
    expect(res.error).toBe("EMPTY");
  });

  test("whitespace-only → EMPTY", () => {
    const res = validateAmountInput("   ", XLM);
    expect(res.valid).toBe(false);
    expect(res.error).toBe("EMPTY");
  });

  test("negative value → NEGATIVE", () => {
    const res = validateAmountInput("-1", XLM);
    expect(res.valid).toBe(false);
    expect(res.error).toBe("NEGATIVE");
  });

  test("non-numeric → INVALID_FORMAT", () => {
    const res = validateAmountInput("abc", XLM);
    expect(res.valid).toBe(false);
    expect(res.error).toBe("INVALID_FORMAT");
  });

  test("too many decimal places → TOO_MANY_DECIMALS", () => {
    const res = validateAmountInput("1.00000001", XLM); // 8 places
    expect(res.valid).toBe(false);
    expect(res.error).toBe("TOO_MANY_DECIMALS");
    expect(res.message).toContain("7 decimal places");
  });

  test("zero → ZERO", () => {
    const res = validateAmountInput("0", XLM);
    expect(res.valid).toBe(false);
    expect(res.error).toBe("ZERO");
  });

  test("zero with decimals → ZERO", () => {
    const res = validateAmountInput("0.0000000", XLM);
    expect(res.valid).toBe(false);
    expect(res.error).toBe("ZERO");
  });

  test("below minimum → BELOW_MIN", () => {
    const minBase = 10_000_000n; // 1 XLM minimum
    const res = validateAmountInput("0.5", XLM, minBase);
    expect(res.valid).toBe(false);
    expect(res.error).toBe("BELOW_MIN");
    expect(res.message).toContain("1 XLM");
  });

  test("overflow → OVERFLOW", () => {
    // Build a string larger than MAX_I128
    const huge = (MAX_I128 + 1n).toString(); // won't fit in i128
    // This is in base units already — we need display units
    const hugeDisplay = baseToDecimalString(MAX_I128 + 10_000_000n, 7);
    const res = validateAmountInput(hugeDisplay, XLM);
    expect(res.valid).toBe(false);
    expect(res.error).toBe("OVERFLOW");
  });

  test("valid edge: smallest possible value", () => {
    const res = validateAmountInput("0.0000001", XLM);
    expect(res.valid).toBe(true);
    expect(res.baseUnits).toBe(1n);
  });

  test("locale: value with leading spaces trimmed", () => {
    const res = validateAmountInput("  2.5  ", XLM);
    expect(res.valid).toBe(true);
    expect(res.baseUnits).toBe(25_000_000n);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// formatAmount
// ════════════════════════════════════════════════════════════════════════════

describe("formatAmount", () => {
  test("formats 1 XLM with symbol", () => {
    expect(formatAmount(10_000_000n, XLM)).toBe("1 XLM");
  });

  test("omits symbol when showSymbol=false", () => {
    const result = formatAmount(10_000_000n, XLM, { showSymbol: false });
    expect(result).not.toContain("XLM");
  });

  test("caps fraction digits via maxFractionDigits", () => {
    // 1.5 XLM but truncated to 2 decimal places
    const result = formatAmount(15_000_000n, XLM, { maxFractionDigits: 2 });
    expect(result).toBe("1.5 XLM");
  });

  test("very small amount", () => {
    const result = formatAmount(1n, XLM);
    expect(result).toContain("XLM");
    expect(result).toContain("0.0000001");
  });

  test("zero amount", () => {
    expect(formatAmount(0n, XLM)).toBe("0 XLM");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// buildFeePreview
// ════════════════════════════════════════════════════════════════════════════

describe("buildFeePreview", () => {
  test("zero fee gives total = price", () => {
    const preview = buildFeePreview(10_000_000n, 0, XLM);
    expect(preview.price.baseUnits).toBe(10_000_000n);
    expect(preview.protocolFee.baseUnits).toBe(0n);
    expect(preview.total.baseUnits).toBe(10_000_000n);
  });

  test("250 bps (2.5%) fee on 10 XLM", () => {
    const priceBase = 100_000_000n; // 10 XLM
    const preview = buildFeePreview(priceBase, 250, XLM);
    // 2.5% of 100_000_000 = 2_500_000
    expect(preview.protocolFee.baseUnits).toBe(2_500_000n);
    expect(preview.total.baseUnits).toBe(102_500_000n);
  });

  test("floor division for odd fee", () => {
    // 1 bps of 1_000_001 base units = floor(1_000_001 / 10_000) = 100
    const preview = buildFeePreview(1_000_001n, 1, XLM);
    expect(preview.protocolFee.baseUnits).toBe(100n);
  });

  test("displays correct symbol in line items", () => {
    const preview = buildFeePreview(10_000_000n, 100, XLM);
    expect(preview.price.display).toContain("XLM");
    expect(preview.protocolFee.display).toContain("XLM");
    expect(preview.total.display).toContain("XLM");
  });

  test("roundingNote mentions base units", () => {
    const preview = buildFeePreview(10_000_000n, 100, XLM);
    expect(preview.roundingNote).toContain("base units");
  });

  test("throws for out-of-range bps", () => {
    expect(() => buildFeePreview(10_000_000n, -1, XLM)).toThrow(RangeError);
    expect(() => buildFeePreview(10_000_000n, 10_001, XLM)).toThrow(RangeError);
  });

  test("maximum fee (100%) doubles price", () => {
    const price = 10_000_000n;
    const preview = buildFeePreview(price, 10_000, XLM);
    expect(preview.protocolFee.baseUnits).toBe(price);
    expect(preview.total.baseUnits).toBe(price * 2n);
  });
});
