/**
 * Tests for lib/preflight.ts — network/contract preflight guard (Issue #305)
 */

import {
  assertWritePreflight,
  getNetworkLabel,
  isCorrectNetwork,
  PreflightError,
} from "@/lib/preflight";

// ── Mock the config module ───────────────────────────────────────────────────

jest.mock("@/lib/config", () => ({
  config: {
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CTEST_CONTRACT_ID_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    launchpadContractId: "CLAUNCHPAD_ID_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    network: "testnet",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    pinataGateway: "https://gateway.pinata.cloud",
    indexerUrl: "http://localhost:4000",
    baseUrl: "http://localhost:3000",
    isDevelopment: true,
    isMainnet: false,
  },
  assertConfig: jest.fn(),
}));

const CORRECT_PASSPHRASE = "Test SDF Network ; September 2015";
const WRONG_PASSPHRASE = "Public Global Stellar Network ; September 2015";
const CONTRACT_ID = "CTEST_CONTRACT_ID_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// ════════════════════════════════════════════════════════════════════════════
// assertWritePreflight
// ════════════════════════════════════════════════════════════════════════════

describe("assertWritePreflight", () => {
  // ── Happy path ──────────────────────────────────────────────────────────

  test("succeeds when wallet passphrase matches and contract is set", () => {
    expect(() =>
      assertWritePreflight({
        walletPassphrase: CORRECT_PASSPHRASE,
        isConnected: true,
        contractId: CONTRACT_ID,
      })
    ).not.toThrow();
  });

  test("succeeds when skipNetworkCheck=true even with wrong passphrase", () => {
    expect(() =>
      assertWritePreflight({
        walletPassphrase: WRONG_PASSPHRASE,
        isConnected: true,
        contractId: CONTRACT_ID,
        skipNetworkCheck: true,
      })
    ).not.toThrow();
  });

  test("succeeds when walletPassphrase is null and skipNetworkCheck=true", () => {
    // Magic wallet: passphrase not available
    expect(() =>
      assertWritePreflight({
        walletPassphrase: null,
        isConnected: true,
        contractId: CONTRACT_ID,
        skipNetworkCheck: true,
      })
    ).not.toThrow();
  });

  // ── Wallet not connected ────────────────────────────────────────────────

  test("throws CONNECT_WALLET when isConnected=false", () => {
    expect(() =>
      assertWritePreflight({
        walletPassphrase: CORRECT_PASSPHRASE,
        isConnected: false,
        contractId: CONTRACT_ID,
      })
    ).toThrow(PreflightError);

    try {
      assertWritePreflight({
        walletPassphrase: CORRECT_PASSPHRASE,
        isConnected: false,
        contractId: CONTRACT_ID,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(PreflightError);
      expect((err as PreflightError).action).toBe("CONNECT_WALLET");
    }
  });

  test("throws CONNECT_WALLET when walletPassphrase is null and isConnected not set", () => {
    try {
      assertWritePreflight({ walletPassphrase: null, contractId: CONTRACT_ID });
    } catch (err) {
      expect(err).toBeInstanceOf(PreflightError);
      expect((err as PreflightError).action).toBe("CONNECT_WALLET");
    }
  });

  // ── Wrong network ───────────────────────────────────────────────────────

  test("throws SWITCH_NETWORK when passphrase does not match", () => {
    expect(() =>
      assertWritePreflight({
        walletPassphrase: WRONG_PASSPHRASE,
        isConnected: true,
        contractId: CONTRACT_ID,
      })
    ).toThrow(PreflightError);

    let caught: PreflightError | null = null;
    try {
      assertWritePreflight({
        walletPassphrase: WRONG_PASSPHRASE,
        isConnected: true,
        contractId: CONTRACT_ID,
      });
    } catch (err) {
      caught = err as PreflightError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.action).toBe("SWITCH_NETWORK");
    expect(caught!.details?.expected).toBe(CORRECT_PASSPHRASE);
    expect(caught!.details?.detected).toBe(WRONG_PASSPHRASE);
    expect(caught!.message).toContain("Testnet");
    expect(caught!.message).toContain("Mainnet");
  });

  test("error message includes expected network name", () => {
    let caught: PreflightError | null = null;
    try {
      assertWritePreflight({
        walletPassphrase: WRONG_PASSPHRASE,
        isConnected: true,
        contractId: CONTRACT_ID,
      });
    } catch (err) {
      caught = err as PreflightError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("Testnet");
  });

  // ── Contract not configured ─────────────────────────────────────────────

  test("throws CONFIGURE_CONTRACT when contractId is empty string", () => {
    expect(() =>
      assertWritePreflight({
        walletPassphrase: CORRECT_PASSPHRASE,
        isConnected: true,
        contractId: "",
      })
    ).toThrow(PreflightError);

    try {
      assertWritePreflight({
        walletPassphrase: CORRECT_PASSPHRASE,
        isConnected: true,
        contractId: "",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(PreflightError);
      expect((err as PreflightError).action).toBe("CONFIGURE_CONTRACT");
    }
  });

  test("throws CONFIGURE_CONTRACT when contractId is empty or falsy", () => {
    // The real production case: env var not set → empty string
    let threw = false;
    try {
      assertWritePreflight({
        walletPassphrase: CORRECT_PASSPHRASE,
        isConnected: true,
        contractId: "",
      });
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(PreflightError);
      expect((err as PreflightError).action).toBe("CONFIGURE_CONTRACT");
    }
    expect(threw).toBe(true);
  });

  // ── Error is a PreflightError ───────────────────────────────────────────

  test("thrown error has name PreflightError", () => {
    try {
      assertWritePreflight({
        walletPassphrase: WRONG_PASSPHRASE,
        isConnected: true,
        contractId: CONTRACT_ID,
      });
    } catch (err) {
      expect((err as Error).name).toBe("PreflightError");
    }
  });

  test("thrown error is an instance of Error", () => {
    try {
      assertWritePreflight({ walletPassphrase: null });
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// getNetworkLabel
// ════════════════════════════════════════════════════════════════════════════

describe("getNetworkLabel", () => {
  test("testnet passphrase returns 'Testnet'", () => {
    expect(getNetworkLabel("Test SDF Network ; September 2015")).toBe("Testnet");
  });

  test("mainnet passphrase returns 'Mainnet'", () => {
    expect(getNetworkLabel("Public Global Stellar Network ; September 2015")).toBe("Mainnet");
  });

  test("unknown passphrase returns quoted prefix", () => {
    const result = getNetworkLabel("Some Custom Network ; 2026");
    expect(result).toContain("Some Custom Network");
  });

  test("long unknown passphrase is truncated", () => {
    const long = "A".repeat(60);
    const result = getNetworkLabel(long);
    expect(result).toContain("…");
    expect(result.length).toBeLessThan(80);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// isCorrectNetwork
// ════════════════════════════════════════════════════════════════════════════

describe("isCorrectNetwork", () => {
  test("returns true for correct passphrase", () => {
    expect(isCorrectNetwork(CORRECT_PASSPHRASE)).toBe(true);
  });

  test("returns false for wrong passphrase", () => {
    expect(isCorrectNetwork(WRONG_PASSPHRASE)).toBe(false);
  });

  test("returns false for null", () => {
    expect(isCorrectNetwork(null)).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isCorrectNetwork(undefined)).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isCorrectNetwork("")).toBe(false);
  });
});
