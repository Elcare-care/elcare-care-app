// lib/format.ts — Locale-aware formatting utilities (Issue #67)
//
// Centralises date, time-zone, number, and currency presentation.
// Base units (XLM stroops, token amounts) are NEVER modified here —
// this module only formats pre-converted display values for presentation.

// ── User locale preferences ──────────────────────────────────────────────────

export interface LocalePreferences {
  locale: string;
  timeZone: string;
}

const PREFS_KEY = "elcarehub:locale-prefs";

export function getLocalePreferences(): LocalePreferences {
  if (typeof localStorage === "undefined") {
    return { locale: "en-US", timeZone: "UTC" };
  }
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LocalePreferences>;
      if (typeof parsed.locale === "string" && typeof parsed.timeZone === "string") {
        return { locale: parsed.locale, timeZone: parsed.timeZone };
      }
    }
  } catch {
    // fall through to browser defaults
  }
  const locale =
    (typeof navigator !== "undefined" && navigator.language) || "en-US";
  const timeZone =
    (typeof Intl !== "undefined" &&
      Intl.DateTimeFormat().resolvedOptions().timeZone) ||
    "UTC";
  return { locale, timeZone };
}

export function setLocalePreferences(prefs: LocalePreferences): void {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  }
}

// ── Date / time formatting ────────────────────────────────────────────────────

const VALID_DATE_STYLES = ["full", "long", "medium", "short"] as const;

export type ValidDateFormat = (typeof VALID_DATE_STYLES)[number];

export interface DateFormatOptions {
  locale?: string;
  timeZone?: string;
  format?: ValidDateFormat;
  showTime?: boolean;
}

export function formatDate(
  date: Date | number,
  opts: DateFormatOptions = {}
): string {
  const ts = typeof date === "number" ? date : date.getTime();
  const {
    locale = "en-US",
    timeZone = "UTC",
    format = "medium",
    showTime = false,
  } = opts;

  // Runtime guard: `Intl.DateTimeFormat` throws a RangeError for any
  // unrecognized dateStyle, so fall back to "medium" for invalid values.
  const safeFormat: Intl.DateTimeFormatOptions["dateStyle"] =
    VALID_DATE_STYLES.includes(format) ? format : "medium";

  const options: Intl.DateTimeFormatOptions = {
    dateStyle: safeFormat,
    timeZone,
  };
  if (showTime) {
    options.timeStyle = "short";
  }
  return new Intl.DateTimeFormat(locale, options).format(new Date(ts));
}

/**
 * Formats a ledger timestamp with explicit time-zone abbreviation so the
 * displayed time can always be traced back to ledger close time.
 */
export function formatLedgerTime(
  ts: number,
  opts: DateFormatOptions = {}
): string {
  const { locale = "en-US", timeZone = "UTC" } = opts;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
    timeZoneName: "short",
  }).format(new Date(ts));
}

// ── Relative time ─────────────────────────────────────────────────────────────

const MS_PER_SECOND = 1_000;

export interface RelativeTimeOptions {
  locale?: string;
}

export function formatRelativeTime(
  date: Date | number,
  opts: RelativeTimeOptions = {}
): string {
  const { locale = "en-US" } = opts;
  const ts = typeof date === "number" ? date : date.getTime();
  const diffMs = ts - Date.now();
  const diffSec = Math.round(diffMs / MS_PER_SECOND);
  const diffMin = Math.round(diffSec / 60);
  const diffHr = Math.round(diffMin / 60);
  const diffDay = Math.round(diffHr / 24);
  // Using average days for more accurate month/year calculations
  const diffMonth = Math.round(diffDay / 30.4375);
  const diffYear = Math.round(diffDay / 365.25);

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });

  // Prioritize larger units to ensure "last year" instead of "12 months ago"
  if (Math.abs(diffYear) >= 1) return rtf.format(diffYear, "year");
  if (Math.abs(diffMonth) >= 1) return rtf.format(diffMonth, "month");
  if (Math.abs(diffDay) >= 1) return rtf.format(diffDay, "day");
  if (Math.abs(diffHr) >= 1) return rtf.format(diffHr, "hour");
  if (Math.abs(diffMin) >= 1) return rtf.format(diffMin, "minute");
  return rtf.format(diffSec, "second");
}

// ── Asset amount display ──────────────────────────────────────────────────────

export interface AssetFormatOptions {
  locale?: string;
  maxFractionDigits?: number;
  showSymbol?: boolean;
}

/**
 * Formats a display-unit value string with locale-aware grouping and always-
 * visible asset symbol. Does NOT modify base units — call baseToDisplay first.
 *
 * Financial values always show the asset symbol to avoid ambiguity (e.g. XLM
 * vs NGN) per the non-custodial model.
 */
export function formatAssetDisplay(
  displayValue: string,
  symbol: string,
  opts: AssetFormatOptions = {}
): string {
  const {
    locale = "en-US",
    maxFractionDigits = 7,
    showSymbol = true,
  } = opts;
  const num = Number(displayValue.trim());
  if (!Number.isFinite(num) || String(num) !== displayValue.trim()) {
    return showSymbol ? `${displayValue} ${symbol}` : displayValue;
  }
  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxFractionDigits,
  }).format(num);
  return showSymbol ? `${formatted} ${symbol}` : formatted;
}

// ── Generic number formatting ─────────────────────────────────────────────────

export interface NumberFormatOptions {
  locale?: string;
  maximumFractionDigits?: number;
  minimumFractionDigits?: number;
}

export function formatNumber(
  value: number,
  opts: NumberFormatOptions = {}
): string {
  if (!Number.isFinite(value)) {
    return "---"; // Guard against NaN or Infinity input
  }
  const {
    locale = "en-US",
    maximumFractionDigits = 2,
    minimumFractionDigits = 0,
  } = opts;
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits,
    maximumFractionDigits,
  }).format(value);
}
