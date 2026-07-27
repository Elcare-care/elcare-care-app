/**
 * lib/preflight.ts — Network and contract preflight guard (Issue #305)
 *
 * Every write flow (buy, bid, offer, listing, launchpad deployment) must call
 * `assertWritePreflight` before simulation/signing. The guard checks:
 *
 *  1. Wallet is connected
 *  2. Wallet network passphrase matches the app-configured passphrase
 *  3. Contract IDs are configured and non-empty
 *
 * The guard throws `PreflightError` — a typed error with an `action` field
 * that tells the UI exactly what recovery step to present to the user.
 *
 * Usage:
 *   assertWritePreflight({ walletPassphrase, contractId });
 */

import { config } from "./config";

// ── Error types ───────────────────────────────────────────────────────────────

/** Recovery actions the UI should offer after a preflight failure */
export type PreflightAction =
  | "CONNECT_WALLET"
  | "SWITCH_NETWORK"
  | "CONFIGURE_CONTRACT";

export class PreflightError extends Error {
  readonly kind = "PREFLIGHT_ERROR" as const;
  constructor(
    message: string,
    public readonly action: PreflightAction,
    public readonly details?: { expected?: string; detected?: string | null }
  ) {
    super(message);
    this.name = "PreflightError";
  }
}

// ── Guard options ─────────────────────────────────────────────────────────────

export interface PreflightOptions {
  /**
   * The network passphrase currently reported by the wallet.
   * Pass null/undefined when the wallet does not expose a passphrase (Magic).
   */
  walletPassphrase: string | null | undefined;

  /**
   * Whether the wallet is connected at call time.
   * Default: inferred from walletPassphrase being non-null.
   */
  isConnected?: boolean;

  /**
   * Contract ID to validate. Defaults to the marketplace contract ID from
   * env config. Pass the launchpad ID for launchpad write flows.
   */
  contractId?: string;

  /**
   * When true, skip the network passphrase check (e.g. Magic wallet, where
   * the passphrase is not available — the signing layer enforces network).
   * Default: false.
   */
  skipNetworkCheck?: boolean;
}

// ── Core guard ────────────────────────────────────────────────────────────────

/**
 * Assert that it is safe to build and sign a write transaction.
 *
 * @throws {PreflightError} with an actionable `action` field on any failure.
 *
 * @example
 * // In a hook or component before invoking a contract write:
 * assertWritePreflight({
 *   walletPassphrase: activeWallet?.networkPassphrase,
 *   isConnected: activeWallet?.isConnected,
 * });
 */
export function assertWritePreflight(opts: PreflightOptions): void {
  const {
    walletPassphrase,
    isConnected,
    contractId = config.contractId,
    skipNetworkCheck = false,
  } = opts;

  // ── 1. Wallet connected ──────────────────────────────────────────────────
  const connected = isConnected ?? walletPassphrase != null;
  if (!connected) {
    throw new PreflightError(
      "Your wallet is not connected. Please connect your wallet to continue.",
      "CONNECT_WALLET"
    );
  }

  // ── 2. Network passphrase match ──────────────────────────────────────────
  if (!skipNetworkCheck && walletPassphrase != null) {
    const expected = config.networkPassphrase;
    if (walletPassphrase !== expected) {
      const networkLabel = getNetworkLabel(walletPassphrase);
      const expectedLabel = getNetworkLabel(expected);
      throw new PreflightError(
        `Your wallet is connected to ${networkLabel}, but this app requires ${expectedLabel}. ` +
          `Please switch networks in your wallet.`,
        "SWITCH_NETWORK",
        { expected, detected: walletPassphrase }
      );
    }
  }

  // ── 3. Contract configured ───────────────────────────────────────────────
  if (!contractId) {
    throw new PreflightError(
      "The contract address is not configured. This is a configuration error — please contact support.",
      "CONFIGURE_CONTRACT"
    );
  }
}

/**
 * Returns a human-friendly network label from a passphrase.
 * Unknown passphrases are shown truncated.
 */
export function getNetworkLabel(passphrase: string): string {
  if (passphrase.toLowerCase().includes("test")) return "Testnet";
  if (passphrase.toLowerCase().includes("public")) return "Mainnet";
  return `"${passphrase.slice(0, 30)}${passphrase.length > 30 ? "…" : ""}"`;
}

/**
 * Returns true if the given passphrase matches the app-configured network.
 * Safe to call without throwing — use for conditional rendering.
 */
export function isCorrectNetwork(passphrase: string | null | undefined): boolean {
  if (!passphrase) return false;
  return passphrase === config.networkPassphrase;
}
