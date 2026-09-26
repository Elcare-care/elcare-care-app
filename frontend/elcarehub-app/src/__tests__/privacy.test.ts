// ─────────────────────────────────────────────────────────────
// __tests__/privacy.test.ts
//
// Unit tests for lib/privacy.ts — consent management,
// log redaction, and wallet pseudonymisation.
// ─────────────────────────────────────────────────────────────

import {
  getAnalyticsConsent,
  setAnalyticsConsent,
  isAnalyticsAllowed,
  pseudonymiseAddress,
  shortAddress,
  redactSensitiveFields,
  redactAddressesFromString,
  ANALYTICS_CONSENT_KEY,
} from "@/lib/privacy";

// ── localStorage stub ─────────────────────────────────────────

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();

Object.defineProperty(global, "localStorage", { value: localStorageMock });
Object.defineProperty(global, "window", { value: global, writable: true });

beforeEach(() => {
  localStorageMock.clear();
});

// ── getAnalyticsConsent ───────────────────────────────────────

describe("getAnalyticsConsent", () => {
  it("returns 'unset' when nothing stored", () => {
    expect(getAnalyticsConsent()).toBe("unset");
  });

  it("returns 'granted' when stored value is 'granted'", () => {
    localStorageMock.setItem(ANALYTICS_CONSENT_KEY, "granted");
    expect(getAnalyticsConsent()).toBe("granted");
  });

  it("returns 'denied' when stored value is 'denied'", () => {
    localStorageMock.setItem(ANALYTICS_CONSENT_KEY, "denied");
    expect(getAnalyticsConsent()).toBe("denied");
  });

  it("returns 'unset' for unknown stored values", () => {
    localStorageMock.setItem(ANALYTICS_CONSENT_KEY, "maybe");
    expect(getAnalyticsConsent()).toBe("unset");
  });
});

// ── setAnalyticsConsent ───────────────────────────────────────

describe("setAnalyticsConsent", () => {
  it("persists 'granted' to localStorage", () => {
    setAnalyticsConsent("granted");
    expect(localStorageMock.getItem(ANALYTICS_CONSENT_KEY)).toBe("granted");
  });

  it("persists 'denied' to localStorage", () => {
    setAnalyticsConsent("denied");
    expect(localStorageMock.getItem(ANALYTICS_CONSENT_KEY)).toBe("denied");
  });

  it("reads back the value after setting", () => {
    setAnalyticsConsent("granted");
    expect(getAnalyticsConsent()).toBe("granted");

    setAnalyticsConsent("denied");
    expect(getAnalyticsConsent()).toBe("denied");
  });
});

// ── isAnalyticsAllowed ────────────────────────────────────────

describe("isAnalyticsAllowed", () => {
  it("returns false when consent is unset", () => {
    expect(isAnalyticsAllowed()).toBe(false);
  });

  it("returns false when consent is denied", () => {
    setAnalyticsConsent("denied");
    expect(isAnalyticsAllowed()).toBe(false);
  });

  it("returns true when consent is granted", () => {
    setAnalyticsConsent("granted");
    expect(isAnalyticsAllowed()).toBe(true);
  });

  it("toggles correctly: grant then deny", () => {
    setAnalyticsConsent("granted");
    expect(isAnalyticsAllowed()).toBe(true);
    setAnalyticsConsent("denied");
    expect(isAnalyticsAllowed()).toBe(false);
  });
});

// ── pseudonymiseAddress ───────────────────────────────────────

describe("pseudonymiseAddress", () => {
  const FULL = "GCAT4ZHKXLSXF2QZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZ";

  it("returns first4…last4", () => {
    const result = pseudonymiseAddress(FULL);
    expect(result).toBe(`${FULL.slice(0, 4)}…${FULL.slice(-4)}`);
  });

  it("returns '[address]' for a string that's too short", () => {
    expect(pseudonymiseAddress("short")).toBe("[address]");
  });

  it("returns '[address]' for an empty string", () => {
    expect(pseudonymiseAddress("")).toBe("[address]");
  });
});

// ── shortAddress ──────────────────────────────────────────────

describe("shortAddress", () => {
  it("returns first8 with ellipsis", () => {
    const addr = "GABCDEFGHIJKLMNOPQRSTUVWXYZ";
    expect(shortAddress(addr)).toBe("GABCDEFG…");
  });
});

// ── redactSensitiveFields ─────────────────────────────────────

describe("redactSensitiveFields", () => {
  it("replaces known sensitive keys with [REDACTED]", () => {
    const input = { authorization: "Bearer token123", userId: "u-42" };
    const out = redactSensitiveFields(input);
    expect(out.authorization).toBe("[REDACTED]");
    expect(out.userId).toBe("u-42");
  });

  it("redacts 'signature' key", () => {
    const out = redactSensitiveFields({ signature: "abc123def" });
    expect(out.signature).toBe("[REDACTED]");
  });

  it("is case-insensitive on key matching", () => {
    const out = redactSensitiveFields({ Authorization: "secret" });
    expect(out.Authorization).toBe("[REDACTED]");
  });

  it("handles nested objects one level deep", () => {
    const out = redactSensitiveFields({
      meta: { secret: "hidden", name: "test" },
    });
    const nested = out.meta as Record<string, unknown>;
    expect(nested.secret).toBe("[REDACTED]");
    expect(nested.name).toBe("test");
  });

  it("does not mutate the original object", () => {
    const input = { authorization: "Bearer abc" };
    const out = redactSensitiveFields(input);
    expect(input.authorization).toBe("Bearer abc");
    expect(out.authorization).toBe("[REDACTED]");
  });

  it("leaves safe fields intact", () => {
    const out = redactSensitiveFields({ listing_id: 42, status: "Active" });
    expect(out.listing_id).toBe(42);
    expect(out.status).toBe("Active");
  });
});

// ── redactAddressesFromString ─────────────────────────────────

describe("redactAddressesFromString", () => {
  it("replaces full Stellar G-address with pseudonym", () => {
    const addr = "GCAT4ZHKXLSXF2QZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZ";
    const msg = `Artist ${addr} revoked`;
    const out = redactAddressesFromString(msg);
    expect(out).not.toContain(addr);
    expect(out).toContain("GCAT");
    expect(out).toContain("…");
  });

  it("leaves non-address text unchanged", () => {
    const msg = "Listing #42 sold for 10 XLM";
    expect(redactAddressesFromString(msg)).toBe(msg);
  });
});
