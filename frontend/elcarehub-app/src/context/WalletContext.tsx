"use client";

import {
  createContext,
  useContext,
  ReactNode,
  useMemo,
  useCallback,
  useEffect,
  useState,
} from "react";
import { useWallet, WalletState, WalletStatus } from "@/hooks/useWallet";
import { useMagicWallet, MagicWalletState } from "@/hooks/useMagicWallet";
import { useLobstrWallet } from "@/hooks/useLobstrWallet";
import {
  saveWalletState,
  loadWalletState,
  clearWalletState,
  clearPendingActionState,
  WalletConnectorId,
  // Legacy imports for backwards compat
  loadWalletProvider,
  clearWalletProvider,
} from "@/lib/wallet-persistence";
import { getWalletPreferences } from "@/lib/wallet-preferences";
import { config } from "@/lib/config";
import type { WalletAdapterError } from "@/lib/wallet-adapter";
import {
  useWalletErrorState,
  resolveProviderError,
  type WalletErrorState,
} from "@/hooks/useWalletState";

export type WalletType = "freighter" | "lobstr" | "magic" | null;

// ── Unified wallet state ──────────────────────────────────────────────────────

export interface UnifiedWalletState {
  walletType: WalletType;
  publicKey: string | null;
  balance: string | null;
  isLoadingBalance: boolean;
  isConnected: boolean;
  isConnecting: boolean;
  isWrongNetwork: boolean;
  /** @deprecated Use `walletErrorState` for typed errors. Kept for back-compat. */
  error: string | null;
  status: WalletStatus | "MAGIC_CONNECTED" | "DISCONNECTED";
  networkPassphrase: string | null;
  isInstalled: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  refresh: () => Promise<void>;
  freighter: WalletState;
  lobstr: WalletState;
  magic: MagicWalletState;
  // Per-wallet connect helpers for the modal
  connectFreighter: () => Promise<void>;
  connectLobstr: () => Promise<void>;
  connectMagicEmail: (email: string) => Promise<void>;
  connectMagicPasskey: () => Promise<void>;

  // ── Structured error state (new) ──────────────────────────────────────────

  /**
   * Per-plane structured error state. Prefer this over `error` (string) for
   * any new UI that needs contextual guidance or typed error handling.
   *
   * Planes:
   *   connection  — install / rejection / wrong-network / account-unavailable
   *   signing     — user declined signing / sign failed
   *   transaction — simulation failure / RPC error / indexer timeout
   *   general     — unexpected catch-all
   */
  walletErrorState: WalletErrorState;

  /**
   * Highest-priority active error across all planes.
   * Priority order: signing > connection > transaction > general.
   */
  activeWalletError: WalletAdapterError | null;

  /** True when any error plane has a value. */
  hasWalletError: boolean;

  /**
   * Set an error on the signing plane (call from transaction hooks after a
   * wallet rejection or sign failure).
   */
  setSigningError(raw: unknown): void;

  /**
   * Set an error on the transaction plane (call from contract.ts / useTxLifecycle
   * after an RPC or simulation error).
   */
  setTransactionError(raw: unknown): void;

  /** Clear all error planes (called on disconnect, modal close, or retry). */
  clearAllWalletErrors(): void;
}

const WalletContext = createContext<UnifiedWalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const freighter = useWallet();
  const lobstr = useLobstrWallet();
  const magic = useMagicWallet();
  const [initialized, setInitialized] = useState(false);

  // Structured error state
  const {
    walletErrorState,
    activeError: activeWalletError,
    hasError: hasWalletError,
    setConnectionError,
    setSigningError,
    setTransactionError,
    clearAllErrors: clearAllWalletErrors,
    clearConnectionError,
  } = useWalletErrorState();

  // ── Auto-reconnect on mount ────────────────────────────────────────────────
  useEffect(() => {
    const reconnect = async () => {
      const prefs = getWalletPreferences();

      if (!prefs.autoConnect || !prefs.rememberWallet) {
        setInitialized(true);
        return;
      }

      const savedWallet = loadWalletState();
      if (!savedWallet) {
        setInitialized(true);
        return;
      }

      try {
        if (savedWallet.connectorId === "freighter" && freighter.isInstalled) {
          await freighter.connect();
        } else if (savedWallet.connectorId === "lobstr" && lobstr.isInstalled) {
          await lobstr.connect();
        } else if (savedWallet.connectorId === "magic") {
          await magic.refresh();
        } else {
          clearWalletState();
        }
      } catch (err) {
        console.error("Auto-reconnect failed:", err);
        clearWalletState();
        // Don't surface auto-reconnect errors to the user — they'll see the
        // disconnected state and can connect manually.
      } finally {
        setInitialized(true);
      }
    };

    reconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only on mount

  // ── Derive active provider ─────────────────────────────────────────────────
  const walletType: WalletType = freighter.isConnected
    ? "freighter"
    : lobstr.isConnected
    ? "lobstr"
    : magic.isConnected
    ? "magic"
    : null;

  const activeWallet = freighter.isConnected
    ? freighter
    : lobstr.isConnected
    ? lobstr
    : null;

  const publicKey = activeWallet?.publicKey ?? magic.publicAddress ?? null;
  const balance = activeWallet?.balance ?? null;
  const isLoadingBalance = activeWallet?.isLoadingBalance ?? false;

  const status: UnifiedWalletState["status"] = freighter.isConnected
    ? freighter.status
    : lobstr.isConnected
    ? lobstr.status
    : magic.isConnected
    ? "MAGIC_CONNECTED"
    : "DISCONNECTED";

  // ── Sync provider string errors → structured connection error ──────────────
  // This runs on every render but is guarded by the reducer's identity check
  // so it only dispatches when something actually changes.
  useEffect(() => {
    // Resolve the active provider's error into a typed WalletAdapterError
    let resolved: WalletAdapterError | null = null;

    if (walletType === "freighter") {
      resolved = resolveProviderError({
        rawError: freighter.error,
        isWrongNetwork: freighter.isWrongNetwork,
        isInstalled: freighter.isInstalled,
        networkPassphrase: freighter.networkPassphrase,
        expectedPassphrase: config.networkPassphrase,
        providerName: "Freighter",
      });
    } else if (walletType === "lobstr") {
      resolved = resolveProviderError({
        rawError: lobstr.error,
        isWrongNetwork: lobstr.isWrongNetwork,
        isInstalled: lobstr.isInstalled,
        networkPassphrase: lobstr.networkPassphrase,
        expectedPassphrase: config.networkPassphrase,
        providerName: "Lobstr",
      });
    } else if (walletType === "magic") {
      resolved = magic.error
        ? { kind: "UNKNOWN", message: magic.error }
        : null;
    }

    if (resolved) {
      setConnectionError(resolved);
    } else {
      clearConnectionError();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    walletType,
    freighter.error,
    freighter.isWrongNetwork,
    lobstr.error,
    lobstr.isWrongNetwork,
    magic.error,
  ]);

  // ── Legacy `error` string (backwards compat) ───────────────────────────────
  const legacyError: string | null =
    freighter.error ?? lobstr.error ?? magic.error ?? null;

  // ── Actions ────────────────────────────────────────────────────────────────
  const connect = useCallback(async () => {
    await freighter.connect();
  }, [freighter]);

  const disconnect = useCallback(() => {
    clearPendingActionState();
    freighter.disconnect();
    lobstr.disconnect();
    if (magic.isConnected) magic.logout().catch(console.error);
    clearWalletState();
    clearAllWalletErrors();
  }, [freighter, lobstr, magic, clearAllWalletErrors]);

  const refresh = useCallback(async () => {
    await Promise.all([freighter.refresh(), lobstr.refresh()]);
  }, [freighter, lobstr]);

  // ── Per-wallet connect helpers with persistence ────────────────────────────
  const connectFreighterWithPersist = useCallback(async () => {
    clearAllWalletErrors();
    try {
      await freighter.connect();
      if (freighter.isConnected && freighter.publicKey) {
        const chainId =
          freighter.networkPassphrase === "Test SDF Network ; September 2015"
            ? 0
            : 1;
        saveWalletState(freighter.publicKey, "freighter", chainId);
      }
    } catch (err) {
      setConnectionError(err);
      throw err;
    }
  }, [freighter, clearAllWalletErrors, setConnectionError]);

  const connectLobstrWithPersist = useCallback(async () => {
    clearAllWalletErrors();
    try {
      await lobstr.connect();
      if (lobstr.isConnected && lobstr.publicKey) {
        saveWalletState(lobstr.publicKey, "lobstr", 1);
      }
    } catch (err) {
      setConnectionError(err);
      throw err;
    }
  }, [lobstr, clearAllWalletErrors, setConnectionError]);

  const connectMagicEmail = useCallback(
    async (email: string) => {
      clearAllWalletErrors();
      try {
        await magic.loginWithEmail(email);
        if (magic.isConnected && magic.publicAddress) {
          saveWalletState(magic.publicAddress, "magic", 1);
        }
      } catch (err) {
        setConnectionError(err);
        throw err;
      }
    },
    [magic, clearAllWalletErrors, setConnectionError]
  );

  const connectMagicPasskey = useCallback(async () => {
    clearAllWalletErrors();
    try {
      await magic.loginWithPasskey();
      if (magic.isConnected && magic.publicAddress) {
        saveWalletState(magic.publicAddress, "magic", 1);
      }
    } catch (err) {
      setConnectionError(err);
      throw err;
    }
  }, [magic, clearAllWalletErrors, setConnectionError]);

  // ── Context value ─────────────────────────────────────────────────────────
  const value = useMemo<UnifiedWalletState>(
    () => ({
      walletType,
      publicKey,
      balance,
      isLoadingBalance,
      isConnected: freighter.isConnected || lobstr.isConnected || magic.isConnected,
      isConnecting:
        freighter.isConnecting || lobstr.isConnecting || magic.isConnecting,
      isWrongNetwork: activeWallet?.isWrongNetwork ?? false,
      networkPassphrase: activeWallet?.networkPassphrase ?? null,
      isInstalled: freighter.isInstalled || lobstr.isInstalled,
      // Legacy string error (back-compat)
      error: legacyError,
      status,
      connect,
      disconnect,
      refresh,
      freighter,
      lobstr,
      magic,
      connectFreighter: connectFreighterWithPersist,
      connectLobstr: connectLobstrWithPersist,
      connectMagicEmail,
      connectMagicPasskey,
      // Structured error state
      walletErrorState,
      activeWalletError,
      hasWalletError,
      setSigningError,
      setTransactionError,
      clearAllWalletErrors,
    }),
    [
      walletType,
      publicKey,
      balance,
      isLoadingBalance,
      status,
      activeWallet,
      legacyError,
      freighter,
      lobstr,
      magic,
      connect,
      disconnect,
      refresh,
      connectFreighterWithPersist,
      connectLobstrWithPersist,
      connectMagicEmail,
      connectMagicPasskey,
      walletErrorState,
      activeWalletError,
      hasWalletError,
      setSigningError,
      setTransactionError,
      clearAllWalletErrors,
    ]
  );

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}

export function useWalletContext(): UnifiedWalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error("useWalletContext must be used inside <WalletProvider>");
  }
  return ctx;
}
