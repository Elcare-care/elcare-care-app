// ─────────────────────────────────────────────────────────────────────────────
// __tests__/networkStatus.test.ts
//
// Tests for lib/networkStatus.ts:
//   - getNetworkStatus() all state combinations
//   - isNetworkReady()
//   - networkStatusLabel()
//   - getSwitchNetworkSteps() per provider
//   - getTargetNetworkLabel()
//   - useStaleDraftToken() — generation counter, snapshot/isStale
//   - useNetworkPoller()   — fires callback on publicKey / passphrase change
// ─────────────────────────────────────────────────────────────────────────────

import { renderHook, act } from "@testing-library/react";
import {
  getNetworkStatus,
  isNetworkReady,
  networkStatusLabel,
  getSwitchNetworkSteps,
  getTargetNetworkLabel,
  useStaleDraftToken,
  useNetworkPoller,
} from "../lib/networkStatus";

jest.mock("@/lib/config", () => ({
  config: {
    networkPassphrase: "Test SDF Network ; September 2015",
    network: "testnet",
    rpcUrl: "https://soroban-testnet.stellar.org",
    indexerUrl: "http://localhost:4000",
    contractId: "CTEST",
    launchpadContractId: "CLAUNCHPAD",
    baseUrl: "http://localhost:3000",
    horizonUrl: "https://horizon-testnet.stellar.org",
    pinataGateway: "https://gateway.pinata.cloud",
    isDevelopment: true,
    isMainnet: false,
  },
  assertConfig: jest.fn(),
}));

const TESTNET = "Test SDF Network ; September 2015";
const MAINNET = "Public Global Stellar Network ; September 2015";

// ── getNetworkStatus ──────────────────────────────────────────────────────────

describe("getNetworkStatus", () => {
  it("returns not_connected when not connected and not connecting", () => {
    expect(getNetworkStatus(false, false, null)).toBe("not_connected");
  });

  it("returns connecting when isConnecting is true", () => {
    expect(getNetworkStatus(false, true, null)).toBe("connecting");
    expect(getNetworkStatus(true,  true, TESTNET)).toBe("connecting");
  });

  it("returns correct when passphrase matches expected", () => {
    expect(getNetworkStatus(true, false, TESTNET, TESTNET)).toBe("correct");
  });

  it("returns wrong_network when passphrase does not match", () => {
    expect(getNetworkStatus(true, false, MAINNET, TESTNET)).toBe("wrong_network");
  });

  it("returns unknown when connected but passphrase is null (Magic)", () => {
    expect(getNetworkStatus(true, false, null, TESTNET)).toBe("unknown");
  });

  it("uses config passphrase as default expected", () => {
    // Should match the mocked config passphrase
    expect(getNetworkStatus(true, false, TESTNET)).toBe("correct");
    expect(getNetworkStatus(true, false, MAINNET)).toBe("wrong_network");
  });
});

// ── isNetworkReady ────────────────────────────────────────────────────────────

describe("isNetworkReady", () => {
  it("returns true for correct", () => {
    expect(isNetworkReady("correct")).toBe(true);
  });

  it("returns true for unknown (Magic — preflight enforces at signing time)", () => {
    expect(isNetworkReady("unknown")).toBe(true);
  });

  it("returns false for wrong_network", () => {
    expect(isNetworkReady("wrong_network")).toBe(false);
  });

  it("returns false for not_connected", () => {
    expect(isNetworkReady("not_connected")).toBe(false);
  });

  it("returns false for connecting", () => {
    expect(isNetworkReady("connecting")).toBe(false);
  });
});

// ── networkStatusLabel ────────────────────────────────────────────────────────

describe("networkStatusLabel", () => {
  const cases = [
    ["not_connected",  "Wallet not connected"],
    ["connecting",     "Connecting wallet"],
    ["correct",        "Connected to correct network"],
    ["wrong_network",  "Wrong network"],
    ["unknown",        "Connected"],
  ] as const;

  for (const [status, expectedFragment] of cases) {
    it(`returns a label containing "${expectedFragment}" for "${status}"`, () => {
      expect(networkStatusLabel(status).toLowerCase()).toContain(
        expectedFragment.toLowerCase()
      );
    });
  }

  it("returns a non-empty string for every status", () => {
    const statuses = ["not_connected","connecting","correct","wrong_network","unknown"] as const;
    for (const s of statuses) {
      expect(networkStatusLabel(s).length).toBeGreaterThan(0);
    }
  });
});

// ── getSwitchNetworkSteps ─────────────────────────────────────────────────────

describe("getSwitchNetworkSteps", () => {
  it("returns 4 steps for freighter", () => {
    const steps = getSwitchNetworkSteps("freighter", "Stellar Testnet");
    expect(steps).toHaveLength(4);
    expect(steps[0]).toMatch(/freighter/i);
    expect(steps[2]).toContain("Stellar Testnet");
  });

  it("returns steps for lobstr that mention settings", () => {
    const steps = getSwitchNetworkSteps("lobstr", "Stellar Testnet");
    expect(steps.some(s => s.toLowerCase().includes("settings"))).toBe(true);
    expect(steps.some(s => s.includes("Stellar Testnet"))).toBe(true);
  });

  it("returns steps for magic that mention logging out", () => {
    const steps = getSwitchNetworkSteps("magic", "Stellar Testnet");
    expect(steps.some(s => s.toLowerCase().includes("log"))).toBe(true);
  });

  it("returns steps for unknown with generic guidance", () => {
    const steps = getSwitchNetworkSteps("unknown", "Stellar Testnet");
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.some(s => s.includes("Stellar Testnet"))).toBe(true);
  });

  it("injects the target network label into the freighter step 3", () => {
    const steps = getSwitchNetworkSteps("freighter", "My Custom Net");
    expect(steps[2]).toContain("My Custom Net");
  });
});

// ── getTargetNetworkLabel ─────────────────────────────────────────────────────

describe("getTargetNetworkLabel", () => {
  it("returns Stellar Testnet for the testnet passphrase", () => {
    expect(getTargetNetworkLabel(TESTNET)).toBe("Stellar Testnet");
  });

  it("returns Stellar Mainnet for the mainnet passphrase", () => {
    expect(getTargetNetworkLabel(MAINNET)).toBe("Stellar Mainnet");
  });

  it("uses config default when no argument passed", () => {
    // Mocked config has testnet passphrase
    expect(getTargetNetworkLabel()).toBe("Stellar Testnet");
  });

  it("truncates long unknown passphrases", () => {
    const long = "Custom Network X ; " + "A".repeat(60);
    const label = getTargetNetworkLabel(long);
    expect(label.length).toBeLessThanOrEqual(45);
    expect(label.endsWith("…")).toBe(true);
  });
});

// ── useStaleDraftToken ────────────────────────────────────────────────────────

describe("useStaleDraftToken", () => {
  it("starts at generation 0", () => {
    const { result } = renderHook(() =>
      useStaleDraftToken("GABC", TESTNET, true)
    );
    expect(result.current.generation).toBe(0);
  });

  it("snapshot is not stale before any change", () => {
    const { result } = renderHook(() =>
      useStaleDraftToken("GABC", TESTNET, true)
    );
    const id = result.current.snapshot();
    expect(result.current.isStale(id)).toBe(false);
  });

  it("snapshot becomes stale after the public key changes", () => {
    const { result, rerender } = renderHook(
      ({ pk, pp }: { pk: string; pp: string }) =>
        useStaleDraftToken(pk, pp, true),
      { initialProps: { pk: "GABC", pp: TESTNET } }
    );

    const id = result.current.snapshot();
    expect(result.current.isStale(id)).toBe(false);

    // Simulate account change
    act(() => {
      rerender({ pk: "GXYZ", pp: TESTNET });
    });

    expect(result.current.isStale(id)).toBe(true);
    expect(result.current.generation).toBe(1);
  });

  it("snapshot becomes stale after the network passphrase changes", () => {
    const { result, rerender } = renderHook(
      ({ pk, pp }: { pk: string; pp: string }) =>
        useStaleDraftToken(pk, pp, true),
      { initialProps: { pk: "GABC", pp: TESTNET } }
    );

    const id = result.current.snapshot();

    act(() => {
      rerender({ pk: "GABC", pp: MAINNET });
    });

    expect(result.current.isStale(id)).toBe(true);
  });

  it("does NOT increment generation when enabled=false", () => {
    const { result, rerender } = renderHook(
      ({ pk, pp, en }: { pk: string; pp: string; en: boolean }) =>
        useStaleDraftToken(pk, pp, en),
      { initialProps: { pk: "GABC", pp: TESTNET, en: false } }
    );

    const id = result.current.snapshot();

    act(() => {
      rerender({ pk: "GXYZ", pp: MAINNET, en: false });
    });

    // Poller is disabled — generation should remain 0
    expect(result.current.generation).toBe(0);
    expect(result.current.isStale(id)).toBe(false);
  });

  it("snapshot() always returns current generation", () => {
    const { result, rerender } = renderHook(
      ({ pk, pp }: { pk: string; pp: string }) =>
        useStaleDraftToken(pk, pp, true),
      { initialProps: { pk: "GABC", pp: TESTNET } }
    );

    act(() => { rerender({ pk: "GXYZ", pp: TESTNET }); });
    act(() => { rerender({ pk: "GIJK", pp: TESTNET }); });

    // After 2 account changes generation should be 2
    expect(result.current.generation).toBe(2);

    // A fresh snapshot is not stale
    const id = result.current.snapshot();
    expect(result.current.isStale(id)).toBe(false);
  });
});

// ── useNetworkPoller ──────────────────────────────────────────────────────────

describe("useNetworkPoller", () => {
  it("fires onNetworkChange with kind=account when publicKey changes", () => {
    const cb = jest.fn();
    const { rerender } = renderHook(
      ({ pk, pp }: { pk: string | null; pp: string | null }) =>
        useNetworkPoller({
          publicKey: pk,
          networkPassphrase: pp,
          onNetworkChange: cb,
          enabled: true,
        }),
      { initialProps: { pk: "GABC", pp: TESTNET } }
    );

    act(() => { rerender({ pk: "GXYZ", pp: TESTNET }); });

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toMatchObject({
      kind: "account",
      previous: "GABC",
      current: "GXYZ",
    });
  });

  it("fires onNetworkChange with kind=network when passphrase changes", () => {
    const cb = jest.fn();
    const { rerender } = renderHook(
      ({ pk, pp }: { pk: string | null; pp: string | null }) =>
        useNetworkPoller({
          publicKey: pk,
          networkPassphrase: pp,
          onNetworkChange: cb,
          enabled: true,
        }),
      { initialProps: { pk: "GABC", pp: TESTNET } }
    );

    act(() => { rerender({ pk: "GABC", pp: MAINNET }); });

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toMatchObject({
      kind: "network",
      previous: TESTNET,
      current: MAINNET,
    });
  });

  it("does NOT fire when publicKey goes from null to a value (initial connect)", () => {
    const cb = jest.fn();
    const { rerender } = renderHook(
      ({ pk, pp }: { pk: string | null; pp: string | null }) =>
        useNetworkPoller({
          publicKey: pk,
          networkPassphrase: pp,
          onNetworkChange: cb,
          enabled: true,
        }),
      { initialProps: { pk: null, pp: null } }
    );

    act(() => { rerender({ pk: "GABC", pp: TESTNET }); });

    // Null → value is initial connection, not a "change"
    expect(cb).not.toHaveBeenCalled();
  });

  it("does NOT fire when enabled=false", () => {
    const cb = jest.fn();
    const { rerender } = renderHook(
      ({ pk, pp }: { pk: string | null; pp: string | null }) =>
        useNetworkPoller({
          publicKey: pk,
          networkPassphrase: pp,
          onNetworkChange: cb,
          enabled: false,
        }),
      { initialProps: { pk: "GABC", pp: TESTNET } }
    );

    act(() => { rerender({ pk: "GXYZ", pp: MAINNET }); });

    expect(cb).not.toHaveBeenCalled();
  });

  it("includes a detectedAt timestamp on each event", () => {
    const cb = jest.fn();
    const before = Date.now();
    const { rerender } = renderHook(
      ({ pk, pp }: { pk: string | null; pp: string | null }) =>
        useNetworkPoller({
          publicKey: pk,
          networkPassphrase: pp,
          onNetworkChange: cb,
          enabled: true,
        }),
      { initialProps: { pk: "GABC", pp: TESTNET } }
    );

    act(() => { rerender({ pk: "GXYZ", pp: TESTNET }); });

    expect(cb.mock.calls[0][0].detectedAt).toBeGreaterThanOrEqual(before);
  });
});
