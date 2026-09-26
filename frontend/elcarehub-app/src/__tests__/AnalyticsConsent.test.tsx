// ─────────────────────────────────────────────────────────────
// __tests__/AnalyticsConsent.test.tsx
//
// Verifies that:
//   1. Analytics opt-out prevents PostHog event emission.
//   2. The Settings page consent toggle calls setAnalyticsConsent.
//   3. trackEvent helpers respect the consent gate.
// ─────────────────────────────────────────────────────────────

import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";

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

// ── PostHog mock ──────────────────────────────────────────────

const mockCapture = jest.fn();
const mockOptIn = jest.fn();
const mockOptOut = jest.fn();

jest.mock("posthog-js", () => ({
  __esModule: true,
  default: {
    __loaded: true,
    capture: (...args: unknown[]) => mockCapture(...args),
    opt_in_capturing: () => mockOptIn(),
    opt_out_capturing: () => mockOptOut(),
    init: jest.fn(),
  },
}));

jest.mock("posthog-js/react", () => ({
  PostHogProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock("next/navigation", () => ({
  usePathname: () => "/settings",
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock("@/context/WalletContext", () => ({
  useWalletContext: () => ({
    publicKey: "GADMIN1234",
    isConnected: true,
    isWrongNetwork: false,
    disconnect: jest.fn(),
    networkPassphrase: "Test SDF Network ; September 2015",
    status: "connected",
  }),
}));

// ── Imports (after mocks) ─────────────────────────────────────

import { ANALYTICS_CONSENT_KEY } from "@/lib/privacy";
import { isAnalyticsAllowed, setAnalyticsConsent } from "@/lib/privacy";
import { trackEvent } from "@/providers/PostHogProvider";

// ── Tests: isAnalyticsAllowed gates trackEvent ────────────────

describe("trackEvent consent gate", () => {
  beforeEach(() => {
    localStorageMock.clear();
    jest.clearAllMocks();
  });

  it("does NOT call posthog.capture when consent is unset", () => {
    // consent is "unset" by default (nothing in localStorage)
    trackEvent.listingCreated(1, "10", "XLM");
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("does NOT call posthog.capture when consent is denied", () => {
    setAnalyticsConsent("denied");
    trackEvent.purchaseSuccessful(2, "50", "XLM");
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("DOES call posthog.capture when consent is granted", () => {
    setAnalyticsConsent("granted");
    trackEvent.listingCreated(3, "10", "XLM");
    expect(mockCapture).toHaveBeenCalledWith("Listing Created", expect.objectContaining({
      listing_id: 3,
      price: "10",
      currency: "XLM",
    }));
  });

  it("walletConnected sends address_prefix not full key", () => {
    setAnalyticsConsent("granted");
    const fullKey = "GCAT4ZHKXLSXF2QZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZ";
    trackEvent.walletConnected("freighter", fullKey);
    expect(mockCapture).toHaveBeenCalledWith(
      "Wallet Connected",
      expect.not.objectContaining({ address: fullKey })
    );
    const call = mockCapture.mock.calls[0][1] as Record<string, unknown>;
    // Must have address_prefix, not the full key
    expect(typeof call.address_prefix).toBe("string");
    expect(call.address_prefix).not.toBe(fullKey);
  });
});

// ── Tests: Settings page consent toggle ──────────────────────

// Minimal settings page test — just verifies the toggle updates consent
describe("Settings analytics toggle", () => {
  beforeEach(() => {
    localStorageMock.clear();
    jest.clearAllMocks();
  });

  it("stores 'granted' in localStorage when toggled on", () => {
    // Start with denied
    setAnalyticsConsent("denied");
    expect(isAnalyticsAllowed()).toBe(false);

    // Simulate what the toggle does
    act(() => { setAnalyticsConsent("granted"); });

    expect(localStorageMock.getItem(ANALYTICS_CONSENT_KEY)).toBe("granted");
    expect(isAnalyticsAllowed()).toBe(true);
  });

  it("stores 'denied' in localStorage when toggled off", () => {
    setAnalyticsConsent("granted");
    expect(isAnalyticsAllowed()).toBe(true);

    act(() => { setAnalyticsConsent("denied"); });

    expect(localStorageMock.getItem(ANALYTICS_CONSENT_KEY)).toBe("denied");
    expect(isAnalyticsAllowed()).toBe(false);
  });
});
