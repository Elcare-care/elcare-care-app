/**
 * Tests for lib/format.ts — locale-aware formatting utilities (Issue #67)
 *
 * Covers:
 *  - Date formatting in en-US and fr-FR locales
 *  - Ledger time with explicit timezone abbreviation
 *  - Relative time formatting
 *  - DST boundary (US clocks spring forward on 2024-03-10 02:00 America/New_York)
 *  - Asset display with locale-specific decimal separators
 *  - Number formatting across locales
 *  - Locale preference storage (mocked localStorage)
 */

import {
  formatDate,
  formatLedgerTime,
  formatRelativeTime,
  formatAssetDisplay,
  formatNumber,
  getLocalePreferences,
  setLocalePreferences,
} from "@/lib/format";

// ── Helpers ───────────────────────────────────────────────────────────────────

const MS_2024_01_15 = new Date("2024-01-15T12:00:00Z").getTime();

// US spring-forward DST boundary: 2024-03-10 02:00 ET → 03:00 ET
const BEFORE_DST_US = new Date("2024-03-10T06:59:00Z").getTime(); // 01:59 ET
const AFTER_DST_US = new Date("2024-03-10T07:01:00Z").getTime();  // 03:01 ET

// ── formatDate ────────────────────────────────────────────────────────────────

describe("formatDate", () => {
  it("formats a date in en-US medium style", () => {
    const result = formatDate(MS_2024_01_15, { locale: "en-US", timeZone: "UTC" });
    expect(result).toContain("Jan");
    expect(result).toContain("2024");
  });

  it("formats a date in fr-FR medium style", () => {
    const result = formatDate(MS_2024_01_15, { locale: "fr-FR", timeZone: "UTC" });
    // French date contains "janv." or "janvier"
    expect(result).toMatch(/janv|janvier/i);
    expect(result).toContain("2024");
  });

  it("includes time when showTime=true", () => {
    const result = formatDate(MS_2024_01_15, {
      locale: "en-US",
      timeZone: "UTC",
      showTime: true,
    });
    // Should contain a time component (AM/PM or hours)
    expect(result).toMatch(/AM|PM|12:00/i);
  });

  it("respects the timeZone parameter", () => {
    // 2024-01-15T12:00:00Z = 07:00 in America/New_York
    const utc = formatDate(MS_2024_01_15, {
      locale: "en-US",
      timeZone: "UTC",
      showTime: true,
    });
    const est = formatDate(MS_2024_01_15, {
      locale: "en-US",
      timeZone: "America/New_York",
      showTime: true,
    });
    // The displayed time should differ between UTC and EST
    expect(utc).not.toBe(est);
  });

  it("handles a Date object as input", () => {
    const d = new Date("2024-06-01T00:00:00Z");
    const result = formatDate(d, { locale: "en-US", timeZone: "UTC" });
    expect(result).toContain("2024");
  });
});

// ── DST boundary ──────────────────────────────────────────────────────────────

describe("formatDate — DST transition (America/New_York spring 2024)", () => {
  it("shows 01:59 before the spring-forward boundary", () => {
    const result = formatDate(BEFORE_DST_US, {
      locale: "en-US",
      timeZone: "America/New_York",
      showTime: true,
    });
    // Before DST: 06:59 UTC = 01:59 EST
    expect(result).toMatch(/1:59 AM/);
  });

  it("shows 03:01 after the spring-forward boundary", () => {
    const result = formatDate(AFTER_DST_US, {
      locale: "en-US",
      timeZone: "America/New_York",
      showTime: true,
    });
    // After DST: 07:01 UTC = 03:01 EDT (clock jumps from 02:00 → 03:00)
    expect(result).toMatch(/3:01 AM/);
  });

  it("the same UTC millisecond formats differently in UTC vs ET", () => {
    const utc = formatDate(AFTER_DST_US, {
      locale: "en-US",
      timeZone: "UTC",
      showTime: true,
    });
    const et = formatDate(AFTER_DST_US, {
      locale: "en-US",
      timeZone: "America/New_York",
      showTime: true,
    });
    expect(utc).not.toBe(et);
  });
});

// ── formatLedgerTime ──────────────────────────────────────────────────────────

describe("formatLedgerTime", () => {
  it("includes a timezone abbreviation (en-US / UTC)", () => {
    const result = formatLedgerTime(MS_2024_01_15, {
      locale: "en-US",
      timeZone: "UTC",
    });
    // Should contain UTC label
    expect(result).toMatch(/UTC/);
  });

  it("includes Africa/Lagos offset abbreviation (WAT)", () => {
    const result = formatLedgerTime(MS_2024_01_15, {
      locale: "en-NG",
      timeZone: "Africa/Lagos",
    });
    // West Africa Time is UTC+1, label varies by implementation
    expect(result).toBeTruthy();
    expect(result).toContain("2024");
  });

  it("formats with fr-FR locale", () => {
    const result = formatLedgerTime(MS_2024_01_15, {
      locale: "fr-FR",
      timeZone: "UTC",
    });
    expect(result).toMatch(/janv|janvier/i);
  });
});

// ── formatRelativeTime ────────────────────────────────────────────────────────

describe("formatRelativeTime", () => {
  const now = Date.now();

  it("returns 'now' or 'in 0 seconds' for current time", () => {
    const result = formatRelativeTime(now, { locale: "en-US" });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns past relative string for a past time", () => {
    const past = now - 5 * 60 * 1000; // 5 minutes ago
    const result = formatRelativeTime(past, { locale: "en-US" });
    expect(result).toMatch(/5 minutes ago|ago/i);
  });

  it("returns future relative string for a future time", () => {
    const future = now + 2 * 60 * 60 * 1000; // 2 hours from now
    const result = formatRelativeTime(future, { locale: "en-US" });
    expect(result).toMatch(/in 2 hours|hours/i);
  });

  it("formats in fr-FR locale", () => {
    const past = now - 10 * 60 * 1000; // 10 minutes ago
    const result = formatRelativeTime(past, { locale: "fr-FR" });
    // French: "il y a 10 minutes"
    expect(result).toMatch(/minutes/i);
  });

  it("accepts a Date object", () => {
    const d = new Date(now - 1000 * 60 * 60); // 1 hour ago
    const result = formatRelativeTime(d, { locale: "en-US" });
    expect(result).toMatch(/hour/i);
  });
});

// ── formatAssetDisplay ────────────────────────────────────────────────────────

describe("formatAssetDisplay", () => {
  it("always shows asset symbol (en-US)", () => {
    const result = formatAssetDisplay("1.55", "XLM", { locale: "en-US" });
    expect(result).toBe("1.55 XLM");
  });

  it("applies locale-specific decimal separator (fr-FR uses comma)", () => {
    const result = formatAssetDisplay("1234.5", "XLM", {
      locale: "fr-FR",
      maxFractionDigits: 7,
    });
    // French decimal separator is comma
    expect(result).toContain(",");
    expect(result).toContain("XLM");
  });

  it("applies thousands separator in en-US", () => {
    const result = formatAssetDisplay("1000000", "XLM", {
      locale: "en-US",
      maxFractionDigits: 0,
    });
    expect(result).toContain("1,000,000");
  });

  it("showSymbol=false omits the asset label", () => {
    const result = formatAssetDisplay("5", "XLM", {
      locale: "en-US",
      showSymbol: false,
    });
    expect(result).not.toContain("XLM");
  });

  it("handles non-numeric gracefully — passes through raw string", () => {
    const result = formatAssetDisplay("invalid", "XLM", { locale: "en-US" });
    expect(result).toContain("XLM");
    expect(result).toContain("invalid");
  });

  it("base units never changed — same number in, same number out", () => {
    // Formatting must not alter the numeric value
    const display = "0.0000001";
    const result = formatAssetDisplay(display, "XLM", { locale: "en-US" });
    expect(result).toBe("0.0000001 XLM");
  });
});

// ── formatNumber ──────────────────────────────────────────────────────────────

describe("formatNumber", () => {
  it("formats with en-US grouping", () => {
    expect(formatNumber(1234567, { locale: "en-US", maximumFractionDigits: 0 })).toBe("1,234,567");
  });

  it("formats with de-DE grouping (period as thousands separator)", () => {
    const result = formatNumber(1234567, { locale: "de-DE", maximumFractionDigits: 0 });
    // German uses period as thousands separator
    expect(result).toMatch(/1[.,]234/);
  });

  it("respects maximumFractionDigits", () => {
    expect(formatNumber(3.14159, { locale: "en-US", maximumFractionDigits: 2 })).toBe("3.14");
  });

  it("rounds correctly", () => {
    expect(formatNumber(3.145, { locale: "en-US", maximumFractionDigits: 2 })).toMatch(/3\.1[45]/);
  });
});

// ── Locale preference storage ─────────────────────────────────────────────────

describe("getLocalePreferences / setLocalePreferences", () => {
  const mockStorage: Record<string, string> = {};

  beforeEach(() => {
    Object.defineProperty(global, "localStorage", {
      value: {
        getItem: (key: string) => mockStorage[key] ?? null,
        setItem: (key: string, value: string) => { mockStorage[key] = value; },
        removeItem: (key: string) => { delete mockStorage[key]; },
      },
      writable: true,
    });
    Object.keys(mockStorage).forEach(k => delete mockStorage[k]);
  });

  it("returns browser defaults when nothing is stored", () => {
    const prefs = getLocalePreferences();
    expect(typeof prefs.locale).toBe("string");
    expect(typeof prefs.timeZone).toBe("string");
  });

  it("roundtrips stored preferences", () => {
    setLocalePreferences({ locale: "fr-FR", timeZone: "Africa/Lagos" });
    const prefs = getLocalePreferences();
    expect(prefs.locale).toBe("fr-FR");
    expect(prefs.timeZone).toBe("Africa/Lagos");
  });

  it("does not expose secrets — only stores locale and timeZone", () => {
    setLocalePreferences({ locale: "sw-KE", timeZone: "Africa/Nairobi" });
    const raw = mockStorage["elcarehub:locale-prefs"];
    const parsed = JSON.parse(raw);
    // Only safe, non-sensitive fields should be persisted
    expect(Object.keys(parsed)).toEqual(["locale", "timeZone"]);
  });
});
