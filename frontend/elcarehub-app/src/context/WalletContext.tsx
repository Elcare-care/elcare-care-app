"use client";

import { createContext, useContext, ReactNode, useMemo, useCallback, useEffect, useState } from "react";
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

export type WalletType = "freighter" | "lobstr" | "magic" | null;

export interface UnifiedWalletState {
  walletType: WalletType;
  publicKey: string | null;
  balance: string | null;
  isLoadingBalance: boolean;
  isConnected: boolean;
  isConnecting: boolean;
  isWrongNetwork: boolean;
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
}

const WalletContext = createContext<UnifiedWalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const freighter = useWallet();
  const lobstr = useLobstrWallet();
  const magic = useMagicWallet();
  const [initialized, setInitialized] = useState(false);

  // Auto-reconnect on mount (respects user preference and expiration)
  useEffect(() => {
    const reconnect = async () => {
      const prefs = getWalletPreferences();
      
      // If user disabled auto-connect or remember-wallet, skip
      if (!prefs.autoConnect || !prefs.rememberWallet) {
        setInitialized(true);
        return;
      }

      // Try to load persisted wallet state
      const savedWallet = loadWalletState();
      if (!savedWallet) {
        setInitialized(true);
        return;
      }

      // If state is expired or corrupted, it will have been cleared by loadWalletState
      try {
        if (savedWallet.connectorId === 'freighter' && freighter.isInstalled) {
          await freighter.connect();
        } else if (savedWallet.connectorId === 'lobstr' && lobstr.isInstalled) {
          await lobstr.connect();
        } else if (savedWallet.connectorId === 'magic') {
          await magic.refresh();
        } else {
          clearWalletState();
        }
      } catch (err) {
        console.error('Auto-reconnect failed:', err);
        clearWalletState();
      } finally {
        setInitialized(true);
      }
    };

    reconnect();
  }, []); // Only on mount

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

  const publicKey =
    activeWallet?.publicKey ?? magic.publicAddress ?? null;

  const balance = activeWallet?.balance ?? null;
  const isLoadingBalance = activeWallet?.isLoadingBalance ?? false;

  const status: UnifiedWalletState["status"] = freighter.isConnected
    ? freighter.status
    : lobstr.isConnected
    ? lobstr.status
    : magic.isConnected
    ? "MAGIC_CONNECTED"
    : "DISCONNECTED";

  const connect = useCallback(async () => {
    // Default connect tries Freighter first
    await freighter.connect();
  }, [freighter]);

  const disconnect = useCallback(() => {
    // Clear pending action state on disconnect (safety: prevents orphaned state)
    clearPendingActionState();
    
    freighter.disconnect();
    lobstr.disconnect();
    // Magic logout is async; fire and forget
    if (magic.isConnected) magic.logout().catch(console.error);
    clearWalletState();
  }, [freighter, lobstr, magic]);

  const refresh = useCallback(async () => {
    await Promise.all([freighter.refresh(), lobstr.refresh()]);
  }, [freighter, lobstr]);

  // Wrapper to persist provider choice with new schema
  const connectFreighterWithPersist = useCallback(async () => {
    await freighter.connect();
    if (freighter.isConnected && freighter.publicKey) {
      // Persist wallet state: address + connector + network
      const chainId = freighter.networkPassphrase === 'Test SDF Network ; September 2015'
        ? 0 // Testnet
        : 1; // Public
      saveWalletState(freighter.publicKey, 'freighter', chainId);
    }
  }, [freighter]);

  const connectLobstrWithPersist = useCallback(async () => {
    await lobstr.connect();
    if (lobstr.isConnected && lobstr.publicKey) {
      // Lobstr doesn't expose network passphrase; default to chainId 1 (public)
      saveWalletState(lobstr.publicKey, 'lobstr', 1);
    }
  }, [lobstr]);

  // Magic connect wrappers
  const connectMagicEmail = useCallback(async (email: string) => {
    await magic.loginWithEmail(email);
    if (magic.isConnected && magic.publicAddress) {
      // Magic network: assume public (1)
      saveWalletState(magic.publicAddress, 'magic', 1);
    }
  }, [magic]);

  const connectMagicPasskey = useCallback(async () => {
    await magic.loginWithPasskey();
    if (magic.isConnected && magic.publicAddress) {
      saveWalletState(magic.publicAddress, 'magic', 1);
    }
  }, [magic]);

  const value = useMemo(
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
      error: freighter.error ?? lobstr.error ?? magic.error,
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
    }),
    [
      walletType,
      publicKey,
      balance,
      isLoadingBalance,
      status,
      activeWallet,
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
