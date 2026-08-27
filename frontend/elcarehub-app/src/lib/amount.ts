/**
 * lib/amount.ts — Shared amount, asset, and fee formatting utility (Issue #303)
 *
 * All monetary values in the contract are stored as base units (i128 on-chain,
 * represented as bigint in JS). Every token declares a `decimals` field that
 * is the exponent of the divisor, e.g. decimals=7 means 1 XLM = 10_000_000
 * base units (stroops).
 *
 * This module provides:
 *  - `baseToDisplay`  — bigint base units → human-readable string
 *  - `displayToBase`  — user-input string → bigint base units (safe parse)
 *  - `formatAmount`   — locale-aware display with asset symbol
 *  - `formatFeePreview` — fee breakdown line items
 *  - `validateAmountInput` — rejects invalid user input before signing
 *
 * Arithmetic is done entirely in bigint to avoid floating-point errors.
 * Floating-point is only used for the final locale-aware string render.
 */

import type { TokenConfig } from "@/config/tokens";

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum i128 value representable on-chain */
export const MAX_I128 = 170_141_183_460_469_231_731_687_303_715_884_105_727n;

/** Maximum number of decimal places any supported token can have */
const MAX_SUPPORTED_DECIMALS = 18;

// ── Core conversion helpers ──────────────────────────────────────────────────

/**
 * Convert base units (bigint) to a decimal string with exactly `decimals`
 * fractional digits, then strip trailing zeros.
 *
 * @example
 * baseToDecimalString(10_000_000n, 7) // "1"
 * baseToDecimalString(1n, 7)          // "0.0000001"
 * baseToDecimalString(15_500_000n, 7) // "1.55"
 */
export function baseToDecimalString(base: bigint, decimals: number): string {
  if (decimals < 0 || decimals > MAX_SUPPORTED_DECIMALS) {
    throw new RangeError(`decimals must be 0–${MAX_SUPPORTED_DECIMALS}, got ${decimals}`);
  }

  const isNegative = base < 0n;
  const abs = isNegative ? -base : base;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;

  if (decimals === 0 || frac === 0n) {
    return `${isNegative ? "-" : ""}${whole}`;
  }

  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${isNegative ? "-" : ""}${whole}.${fracStr}`;
}

/**
 * Convert a decimal string produced by user input into base units (bigint).
 * Returns null when the input is not a valid non-negative decimal number.
 * Does NOT accept negative values — those are rejected at input time.
 *
 * @example
 * decimalStringToBase("1.55", 7) // 15_500_000n
 * decimalStringToBase("0.0000001", 7) // 1n
 * decimalStringToBase("-1", 7) // null  (negative rejected)
 * decimalStringToBase("abc", 7) // null
 */
export function decimalStringToBase(input: string, decimals: number): bigint | null {
  if (decimals < 0 || decimals > MAX_SUPPORTED_DECIMALS) return null;

  const trimmed = input.trim();
  if (!trimmed) return null;

  // Reject negatives, exponent notation, and anything non-numeric
  if (!/^\d+(\.\d*)?$/.test(trimmed)) return null;

  const [wholePart, fracPart = ""] = trimmed.split(".");

  // Reject more decimal places than the token supports
  if (fracPart.length > decimals) return null;

  const fracPadded = fracPart.padEnd(decimals, "0");

  try {
    const result = BigInt(wholePart) * 10n ** BigInt(decimals) + BigInt(fracPadded);
    return result;
  } catch {
    return null;
  }
}

/**
 * Parse a raw base-unit amount string returned by an API/indexer (e.g. an
 * aggregate sum) into a bigint, without ever routing it through a JS
 * float. Base units are always integers; some aggregate endpoints emit a
 * trailing ".0" (or more), which is simply truncated — the same tolerant
 * behaviour the previous ad hoc `split(".")[0]` call sites relied on.
 *
 * This exists because `BigInt(Math.round(parseFloat(raw)))` — a pattern
 * that has crept into a few display call sites — silently loses precision
 * for sums beyond `Number.MAX_SAFE_INTEGER` (~9e15 base units).
 *
 * @example
 * baseUnitsStringToBigInt("15500000")   // 15_500_000n
 * baseUnitsStringToBigInt("15500000.0") // 15_500_000n
 * baseUnitsStringToBigInt("")           // 0n
 */
export function baseUnitsStringToBigInt(raw: string): bigint {
  const trimmed = raw.trim();
  if (!trimmed) return 0n;

  const wholePart = trimmed.split(".")[0];
  if (!/^-?\d*$/.test(wholePart) || wholePart === "" || wholePart === "-") return 0n;

  return BigInt(wholePart);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Convert base units to a display string for a given asset.
 *
 * @example
 * baseToDisplay(10_000_000n, xlmToken) // "1"
 */
export function baseToDisplay(base: bigint, token: TokenConfig): string {
  return baseToDecimalString(base, token.decimals);
}

/**
 * Parse user input (display units) into base units for a given asset.
 * Returns null when input is invalid or has more precision than the token supports.
 *
 * @example
 * displayToBase("1.5", xlmToken) // 15_000_000n
 * displayToBase("abc", xlmToken) // null
 */
export function displayToBase(input: string, token: TokenConfig): bigint | null {
  return decimalStringToBase(input, token.decimals);
}

// ── Validation ───────────────────────────────────────────────────────────────

export type AmountValidationError =
  | "EMPTY"
  | "INVALID_FORMAT"
  | "NEGATIVE"
  | "TOO_MANY_DECIMALS"
  | "ZERO"
  | "OVERFLOW"
  | "BELOW_MIN";

export interface AmountValidationResult {
  valid: boolean;
  baseUnits: bigint | null;
  error: AmountValidationError | null;
  /** Human-readable error message suitable for display */
  message: string | null;
}

/**
 * Validate user-entered amount string and convert to base units.
 * Returns a result object with either `baseUnits` or an `error`.
 *
 * @param input   - Raw string from an <input> element
 * @param token   - Asset metadata (decimals, symbol)
 * @param minBase - Optional minimum accepted value in base units (default 1n)
 */
export function validateAmountInput(
  input: string,
  token: TokenConfig,
  minBase = 1n
): AmountValidationResult {
  const fail = (error: AmountValidationError, message: string): AmountValidationResult => ({
    valid: false,
    baseUnits: null,
    error,
    message,
  });

  const trimmed = input.trim();
  if (!trimmed) return fail("EMPTY", "Please enter an amount.");

  // Reject leading minus sign explicitly for a clear message
  if (trimmed.startsWith("-")) return fail("NEGATIVE", "Amount must be positive.");

  // Reject exponent notation and non-numeric characters
  if (!/^\d+(\.\d*)?$/.test(trimmed)) {
    return fail("INVALID_FORMAT", "Please enter a valid number.");
  }

  const [, fracPart = ""] = trimmed.split(".");
  if (fracPart.length > token.decimals) {
    return fail(
      "TOO_MANY_DECIMALS",
      `${token.symbol} supports at most ${token.decimals} decimal places.`
    );
  }

  const base = decimalStringToBase(trimmed, token.decimals);
  if (base === null) return fail("INVALID_FORMAT", "Please enter a valid number.");

  if (base === 0n) return fail("ZERO", "Amount must be greater than zero.");

  if (base > MAX_I128) {
    return fail("OVERFLOW", "Amount exceeds the maximum value supported by the contract.");
  }

  if (base < minBase) {
    const minDisplay = baseToDecimalString(minBase, token.decimals);
    return fail("BELOW_MIN", `Minimum amount is ${minDisplay} ${token.symbol}.`);
  }

  return { valid: true, baseUnits: base, error: null, message: null };
}

// ── Locale-aware display formatting ─────────────────────────────────────────

export interface FormatOptions {
  /** Include asset symbol suffix, e.g. "1.55 XLM". Default: true */
  showSymbol?: boolean;
  /** Max fractional digits shown. Default: strips trailing zeros naturally */
  maxFractionDigits?: number;
  /** Locale for Intl.NumberFormat. Default: "en-US" */
  locale?: string;
}

/**
 * Format base units as a human-readable amount string with optional symbol.
 *
 * Uses Intl.NumberFormat for locale-aware grouping and rounding of the
 * display value; the actual base-unit conversion is bigint-based.
 *
 * @example
 * formatAmount(10_000_000n, xlmToken)                // "1 XLM"
 * formatAmount(1_555_000n, xlmToken, { locale: "de-DE" }) // "0,1555 XLM"
 */
export function formatAmount(
  base: bigint,
  token: TokenConfig,
  options: FormatOptions = {}
): string {
  const { showSymbol = true, maxFractionDigits, locale = "en-US" } = options;

  const decimalStr = baseToDecimalString(base, token.decimals);
  const num = Number(decimalStr); // safe: only for display, bigint already converted

  const fractionDigits =
    maxFractionDigits !== undefined ? maxFractionDigits : token.decimals;

  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: fractionDigits,
  }).format(num);

  return showSymbol ? `${formatted} ${token.symbol}` : formatted;
}

// ── Basis point helpers ─────────────────────────────────────────────────────

/**
 * Convert basis points (0–10,000) to a percentage (0–100).
 *
 * @example
 * bpsToPercent(250) // 2.5
 */
export function bpsToPercent(bps: number): number {
  return bps / 100;
}

/**
 * Convert a percentage (0–100) to basis points (0–10,000), rounded to the
 * nearest whole bps.
 *
 * @example
 * percentToBps(2.5) // 250
 */
export function percentToBps(percent: number): number {
  return Math.round(percent * 100);
}

/**
 * Format basis points for display alongside their percentage equivalent.
 *
 * @example
 * formatBps(250) // "250 bps (2.50%)"
 */
export function formatBps(bps: number): string {
  return `${bps} bps (${bpsToPercent(bps).toFixed(2)}%)`;
}

// ── Fee preview ───────────────────────────────────────────────────────────────

export interface FeeLineItem {
  label: string;
  baseUnits: bigint;
  /** Display string including symbol */
  display: string;
}

export interface FeePreview {
  /** Item price before fees */
  price: FeeLineItem;
  /** Protocol fee (basis points applied to price) */
  protocolFee: FeeLineItem;
  /** Total = price + protocolFee */
  total: FeeLineItem;
  /** Rounding note — communicates truncation policy */
  roundingNote: string;
}

/**
 * Compute a fee preview from a price in base units and protocol fee bps.
 *
 * Fee is computed in base units using integer arithmetic (floor division),
 * matching the on-chain behaviour. The `roundingNote` describes this so the
 * user is not surprised by minor discrepancies.
 *
 * @param priceBase       - Listing/bid price in base units
 * @param protocolFeeBps  - Protocol fee in basis points (0–10_000)
 * @param token           - Payment asset metadata
 */
export function buildFeePreview(
  priceBase: bigint,
  protocolFeeBps: number,
  token: TokenConfig
): FeePreview {
  if (protocolFeeBps < 0 || protocolFeeBps > 10_000) {
    throw new RangeError(`protocolFeeBps must be 0–10_000, got ${protocolFeeBps}`);
  }

  // Integer arithmetic — floor division matching contract behaviour
  const feeBps = BigInt(protocolFeeBps);
  const protocolFeeBase = (priceBase * feeBps) / 10_000n;
  const totalBase = priceBase + protocolFeeBase;

  const mkLine = (label: string, base: bigint): FeeLineItem => ({
    label,
    baseUnits: base,
    display: formatAmount(base, token),
  });

  return {
    price: mkLine("Item Price", priceBase),
    protocolFee: mkLine(`Protocol Fee (${protocolFeeBps / 100}%)`, protocolFeeBase),
    total: mkLine("Total", totalBase),
    roundingNote: `Fees are calculated in ${token.symbol} base units using floor division, matching on-chain contract arithmetic.`,
  };
}
