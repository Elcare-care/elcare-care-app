/**
 * lib/wallet-adapters.ts — Adapter implementations (Issue #304)
 *
 * Implements the WalletAdapter interface for each supported provider.
 * All provider-specific logic lives here; context and pages consume the
 * normalized interface only.
 */

import {
  WalletAdapter,
  WalletCapabilities,
  WalletAdapterError,
  normalizeWalletError,
  wrongNetworkError,
  unsupportedCapabilityError,
} from "./wallet-adapter";
import type { WalletState } from "@/hooks/useWallet";
import type { MagicWalletState } from "@/hooks/useMagicWallet";
import { config } from "./config";

// ── Freighter / Lobstr (extension) capabilities ──────────────────────────────

const EXTENSION_CAPABILITIES: WalletCapabilities = {
  canDetectAccountChange: false,  // Freighter/Lobstr have no event subscription API
  canDetectNetworkChange: false,
  canReportNetwork: true,
  canUsePasskey: false,
  canUseEmail: false,
  isExtension: true,
  requiresExplicitDisconnect: true,
};

// ── Magic capabilities ────────────────────────────────────────────────────────

const MAGIC_CAPABILITIES: WalletCapabilities = {
  canDetectAccountChange: false,
  canDetectNetworkChange: false,
  canReportNetwork: false,  // Magic does not expose the network passphrase
  canUsePasskey: true,
  canUseEmail: true,
  isExtension: false,
  requiresExplicitDisconnect: true,
};

// ── Helper: wrap a provider error into WalletAdapterError ────────────────────

function wrapError(raw: unknown): WalletAdapterError {
  return normalizeWalletError(raw, config.networkPassphrase);
}

// ── createExtensionAdapter ────────────────────────────────────────────────────

/**
 * Adapts a Freighter or LOBSTR WalletState to the WalletAdapter interface.
 *
 * @param state      - Hook state from useFreighterWallet / useLobstrWallet
 * @param name       - Display name ("Freighter" | "LOBSTR")
 * @param signFn     - Provider-specific signing function
 */
export function createExtensionAdapter(
  state: WalletState,
  signFn?: (xdr: string, passphrase?: string) => Promise<string>,
  name = "Extension Wallet"
): WalletAdapter {
  // Normalize the raw `state.error` string into WalletAdapterError | null
  const error: WalletAdapterError | null = state.error
    ? normalizeWalletError(state.error, config.networkPassphrase)
    : null;

  return {
    name,
    capabilities: EXTENSION_CAPABILITIES,
    isConnected: state.isConnected,
    isConnecting: state.isConnecting,
    publicKey: state.publicKey,
    networkPassphrase: state.networkPassphrase,
    error,

    async connect() {
      try {
        await state.connect();
        // Post-connect: check for network mismatch
        if (state.isWrongNetwork && state.networkPassphrase) {
          throw wrongNetworkError(config.networkPassphrase, state.networkPassphrase);
        }
      } catch (raw) {
        // If already a WalletAdapterError (thrown above), re-throw as-is
        if (raw && typeof raw === "object" && "kind" in raw) throw raw;
        throw wrapError(raw);
      }
    },

    disconnect() {
      state.disconnect();
    },

    async signTransaction(xdr: string, passphrase?: string) {
      if (!signFn) {
        throw unsupportedCapabilityError("canReportNetwork", name);
      }
      try {
        return await signFn(xdr, passphrase);
      } catch (raw) {
        throw wrapError(raw);
      }
    },
  };
}

// ── createMagicAdapter ────────────────────────────────────────────────────────

/**
 * Adapts MagicWalletState to the WalletAdapter interface.
 *
 * @param state       - Hook state from useMagicWallet
 * @param loginEmail  - Email login helper
 * @param loginPasskey - Passkey login helper
 * @param signFn      - Magic signing function
 */
export function createMagicAdapter(
  state: MagicWalletState,
  loginEmail?: (email: string) => Promise<void>,
  loginPasskey?: () => Promise<void>,
  signFn?: (xdr: string) => Promise<string>
): WalletAdapter {
  const error: WalletAdapterError | null = state.error
    ? normalizeWalletError(state.error)
    : null;

  return {
    name: "Magic",
    capabilities: MAGIC_CAPABILITIES,
    isConnected: state.isConnected,
    isConnecting: state.isConnecting,
    publicKey: state.publicAddress,
    // Magic does not expose the network passphrase — callers must use the
    // app-configured passphrase directly; WRONG_NETWORK detection relies on
    // the preflight guard instead.
    networkPassphrase: null,
    error,

    async connect() {
      const fn = loginPasskey ?? loginEmail?.bind(null, "");
      if (!fn) {
        throw unsupportedCapabilityError("canUsePasskey", "Magic");
      }
      try {
        await fn();
      } catch (raw) {
        throw wrapError(raw);
      }
    },

    async disconnect() {
      try {
        await state.logout();
      } catch {
        // Logout errors are swallowed so disconnect always resolves
      }
    },

    async signTransaction(xdr: string) {
      if (!signFn) {
        throw {
          kind: "SIGN_FAILED",
          message: "signTransaction is not configured for Magic.",
        } satisfies WalletAdapterError;
      }
      try {
        return await signFn(xdr);
      } catch (raw) {
        throw wrapError(raw);
      }
    },
  };
}
