/**
 * Tests for wallet-adapter.ts and wallet-adapters.ts (Issue #304)
 *
 * Covers:
 * - normalizeWalletError: all error kinds
 * - createExtensionAdapter: connect, disconnect, sign, capability flags
 * - createMagicAdapter: connect, disconnect, sign, capability flags
 * - Provider-unavailable, user-rejection, wrong-network, unsupported capability
 */

import {
  normalizeWalletError,
  wrongNetworkError,
  unsupportedCapabilityError,
  WalletAdapterError,
} from "@/lib/wallet-adapter";
import { createExtensionAdapter, createMagicAdapter } from "@/lib/wallet-adapters";
import type { WalletState } from "@/hooks/useWallet";
import type { MagicWalletState } from "@/hooks/useMagicWallet";

// ── normalizeWalletError ─────────────────────────────────────────────────────

describe("normalizeWalletError", () => {
  test("maps user rejection phrase to USER_REJECTED", () => {
    const err = normalizeWalletError(new Error("User rejected the request"));
    expect(err.kind).toBe("USER_REJECTED");
  });

  test("maps 'user denied' to USER_REJECTED", () => {
    const err = normalizeWalletError("user denied transaction");
    expect(err.kind).toBe("USER_REJECTED");
  });

  test("maps 'freighter is not installed' to NOT_INSTALLED", () => {
    const err = normalizeWalletError(new Error("Freighter is not installed"));
    expect(err.kind).toBe("NOT_INSTALLED");
  });

  test("maps 'wallet not installed' to NOT_INSTALLED", () => {
    const err = normalizeWalletError("wallet not installed");
    expect(err.kind).toBe("NOT_INSTALLED");
  });

  test("maps network passphrase mismatch to WRONG_NETWORK", () => {
    const expected = "Test SDF Network ; September 2015";
    const err = normalizeWalletError(
      new Error('network passphrase mismatch: expected "Test SDF Network ; September 2015" got "Public Global Stellar Network ; September 2015"'),
      expected
    );
    expect(err.kind).toBe("WRONG_NETWORK");
    if (err.kind === "WRONG_NETWORK") {
      expect(err.expected).toBe(expected);
    }
  });

  test("maps account unavailable to ACCOUNT_UNAVAILABLE", () => {
    const err = normalizeWalletError("account unavailable");
    expect(err.kind).toBe("ACCOUNT_UNAVAILABLE");
  });

  test("maps XDR error to SIGN_FAILED", () => {
    const err = normalizeWalletError("invalid xdr envelope");
    expect(err.kind).toBe("SIGN_FAILED");
  });

  test("unknown error falls through to UNKNOWN", () => {
    const err = normalizeWalletError("something completely different happened");
    expect(err.kind).toBe("UNKNOWN");
    expect(err.message).toBe("something completely different happened");
  });

  test("non-Error non-string value → UNKNOWN", () => {
    const err = normalizeWalletError({ code: 42 });
    expect(err.kind).toBe("UNKNOWN");
  });
});

// ── wrongNetworkError ────────────────────────────────────────────────────────

describe("wrongNetworkError", () => {
  test("includes expected and detected in message", () => {
    const err = wrongNetworkError("testnet", "mainnet");
    expect(err.kind).toBe("WRONG_NETWORK");
    expect(err.message).toContain("testnet");
    expect(err.message).toContain("mainnet");
    if (err.kind === "WRONG_NETWORK") {
      expect(err.expected).toBe("testnet");
      expect(err.detected).toBe("mainnet");
    }
  });

  test("null detected shows 'unknown network'", () => {
    const err = wrongNetworkError("testnet", null);
    expect(err.message).toContain("unknown network");
  });
});

// ── unsupportedCapabilityError ───────────────────────────────────────────────

describe("unsupportedCapabilityError", () => {
  test("returns UNSUPPORTED_CAPABILITY error", () => {
    const err = unsupportedCapabilityError("canUsePasskey", "Freighter");
    expect(err.kind).toBe("UNSUPPORTED_CAPABILITY");
    if (err.kind === "UNSUPPORTED_CAPABILITY") {
      expect(err.capability).toBe("canUsePasskey");
    }
    expect(err.message).toContain("Freighter");
  });
});

// ── Helper: build a mock WalletState ────────────────────────────────────────

function makeMockExtensionState(overrides: Partial<WalletState> = {}): WalletState {
  return {
    publicKey: "GTEST123",
    balance: null,
    isLoadingBalance: false,
    networkPassphrase: "Test SDF Network ; September 2015",
    status: "CONNECTED",
    isInstalled: true,
    isConnecting: false,
    isConnected: true,
    isWrongNetwork: false,
    error: null,
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn(),
    refresh: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeMockMagicState(overrides: Partial<MagicWalletState> = {}): MagicWalletState {
  return {
    email: "test@example.com",
    publicAddress: "GMAGIC123",
    status: "CONNECTED",
    isConnecting: false,
    isConnected: true,
    error: null,
    loginWithEmail: jest.fn().mockResolvedValue(undefined),
    loginWithPasskey: jest.fn().mockResolvedValue(undefined),
    logout: jest.fn().mockResolvedValue(undefined),
    refresh: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ── createExtensionAdapter ───────────────────────────────────────────────────

describe("createExtensionAdapter", () => {
  test("exposes correct capability flags", () => {
    const adapter = createExtensionAdapter(makeMockExtensionState(), undefined, "Freighter");
    expect(adapter.capabilities.isExtension).toBe(true);
    expect(adapter.capabilities.canUsePasskey).toBe(false);
    expect(adapter.capabilities.canUseEmail).toBe(false);
    expect(adapter.capabilities.canReportNetwork).toBe(true);
  });

  test("exposes name", () => {
    const adapter = createExtensionAdapter(makeMockExtensionState(), undefined, "LOBSTR");
    expect(adapter.name).toBe("LOBSTR");
  });

  test("normalizes null error to null", () => {
    const adapter = createExtensionAdapter(makeMockExtensionState());
    expect(adapter.error).toBeNull();
  });

  test("normalizes string error to WalletAdapterError", () => {
    const state = makeMockExtensionState({ error: "user rejected the request" });
    const adapter = createExtensionAdapter(state);
    expect(adapter.error?.kind).toBe("USER_REJECTED");
  });

  test("connect delegates to state.connect", async () => {
    const mockConnect = jest.fn().mockResolvedValue(undefined);
    const state = makeMockExtensionState({ connect: mockConnect });
    const adapter = createExtensionAdapter(state);
    await adapter.connect();
    expect(mockConnect).toHaveBeenCalled();
  });

  test("disconnect delegates to state.disconnect", () => {
    const mockDisconnect = jest.fn();
    const state = makeMockExtensionState({ disconnect: mockDisconnect });
    const adapter = createExtensionAdapter(state);
    adapter.disconnect();
    expect(mockDisconnect).toHaveBeenCalled();
  });

  test("signTransaction uses provided signFn", async () => {
    const mockSign = jest.fn().mockResolvedValue("signed-xdr");
    const adapter = createExtensionAdapter(makeMockExtensionState(), mockSign);
    const result = await adapter.signTransaction("raw-xdr");
    expect(mockSign).toHaveBeenCalledWith("raw-xdr", undefined);
    expect(result).toBe("signed-xdr");
  });

  test("signTransaction wraps rejection as USER_REJECTED", async () => {
    const mockSign = jest.fn().mockRejectedValue(new Error("user denied transaction"));
    const adapter = createExtensionAdapter(makeMockExtensionState(), mockSign);
    await expect(adapter.signTransaction("raw-xdr")).rejects.toMatchObject({
      kind: "USER_REJECTED",
    });
  });

  test("throws UNSUPPORTED_CAPABILITY when no signFn provided", async () => {
    const adapter = createExtensionAdapter(makeMockExtensionState());
    await expect(adapter.signTransaction("raw-xdr")).rejects.toMatchObject({
      kind: "UNSUPPORTED_CAPABILITY",
    });
  });

  test("connect throws WRONG_NETWORK when wallet on wrong network", async () => {
    const state = makeMockExtensionState({
      isWrongNetwork: true,
      networkPassphrase: "Public Global Stellar Network ; September 2015",
      connect: jest.fn().mockResolvedValue(undefined),
    });
    const adapter = createExtensionAdapter(state);
    // After connect() completes, the adapter checks isWrongNetwork
    await expect(adapter.connect()).rejects.toMatchObject({ kind: "WRONG_NETWORK" });
  });

  test("isConnected reflects state", () => {
    const disconnected = createExtensionAdapter(
      makeMockExtensionState({ isConnected: false })
    );
    expect(disconnected.isConnected).toBe(false);
  });

  test("publicKey reflects state", () => {
    const adapter = createExtensionAdapter(
      makeMockExtensionState({ publicKey: "GABC" })
    );
    expect(adapter.publicKey).toBe("GABC");
  });
});

// ── createMagicAdapter ───────────────────────────────────────────────────────

describe("createMagicAdapter", () => {
  test("exposes correct capability flags", () => {
    const adapter = createMagicAdapter(makeMockMagicState());
    expect(adapter.capabilities.canUsePasskey).toBe(true);
    expect(adapter.capabilities.canUseEmail).toBe(true);
    expect(adapter.capabilities.isExtension).toBe(false);
    expect(adapter.capabilities.canReportNetwork).toBe(false);
  });

  test("networkPassphrase is always null", () => {
    const adapter = createMagicAdapter(makeMockMagicState());
    expect(adapter.networkPassphrase).toBeNull();
  });

  test("publicKey maps from publicAddress", () => {
    const adapter = createMagicAdapter(makeMockMagicState({ publicAddress: "GMAGIC" }));
    expect(adapter.publicKey).toBe("GMAGIC");
  });

  test("normalizes string error to WalletAdapterError", () => {
    const state = makeMockMagicState({ error: "user rejected" });
    const adapter = createMagicAdapter(state);
    expect(adapter.error?.kind).toBe("USER_REJECTED");
  });

  test("connect delegates to loginPasskey when provided", async () => {
    const mockPasskey = jest.fn().mockResolvedValue(undefined);
    const state = makeMockMagicState({ loginWithPasskey: mockPasskey });
    const adapter = createMagicAdapter(state, undefined, mockPasskey);
    await adapter.connect();
    expect(mockPasskey).toHaveBeenCalled();
  });

  test("disconnect resolves even when logout throws", async () => {
    const state = makeMockMagicState({
      logout: jest.fn().mockRejectedValue(new Error("session expired")),
    });
    const adapter = createMagicAdapter(state);
    await expect(adapter.disconnect()).resolves.not.toThrow();
  });

  test("signTransaction uses provided signFn", async () => {
    const mockSign = jest.fn().mockResolvedValue("magic-signed");
    const adapter = createMagicAdapter(makeMockMagicState(), undefined, undefined, mockSign);
    const result = await adapter.signTransaction("xdr-blob");
    expect(result).toBe("magic-signed");
  });

  test("signTransaction throws SIGN_FAILED when no signFn", async () => {
    const adapter = createMagicAdapter(makeMockMagicState());
    await expect(adapter.signTransaction("xdr-blob")).rejects.toMatchObject({
      kind: "SIGN_FAILED",
    });
  });

  test("wraps sign rejection as WalletAdapterError", async () => {
    const mockSign = jest.fn().mockRejectedValue(new Error("user canceled signing"));
    const adapter = createMagicAdapter(makeMockMagicState(), undefined, undefined, mockSign);
    await expect(adapter.signTransaction("xdr")).rejects.toMatchObject({
      kind: "USER_REJECTED",
    });
  });
});
