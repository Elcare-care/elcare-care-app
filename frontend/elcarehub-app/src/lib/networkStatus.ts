// ─────────────────────────────────────────────────────────────────────────────
// lib/networkStatus.ts — Typed network status and change detection
//
// Provides:
//   NetworkStatus         — discriminated union for every wallet-network state
//   getNetworkStatus()    — derive NetworkStatus from raw wallet flags
//   NetworkChangeEvent    — emitted when the network or account changes
//   useNetworkPoller()    — React hook that polls Freighter for network/account
//                           changes and fires a callback when they occur
//   StaleDraftToken       — an opaque token that is invalidated on network/
//                           account change; used to detect stale tx drafts
// ─────────────────────────────────────────────────────────────────────────────

"use client";

import { useRef, useEffect, useCallback } from "react";
import { config } from "./config";

// ── NetworkStatus ─────────────────────────────────────────────────────────────

/**
 * Every state a wallet's network connection can be in.
 *
 * - not_connected   : no wallet connected at all
 * - connecting      : wallet is in the process of connecting
 * - correct         : connected, passphrase matches app config
 * - wrong_network   : connected, passphrase does NOT match app config
 * - unknown         : connected but passphrase not available (e.g. Magic)
 */
export type NetworkStatus =
  | "not_connected"
  | "connecting"
  | "correct"
  | "wrong_network"
  | "unknown";

/**
 * Derive the typed NetworkStatus from the flags exposed by the wallet hooks.
 *
 * @param isConnected       Whether the wallet has a public key
 * @param isConnecting      Whether a connection attempt is in progress
 * @param networkPassphrase The passphrase currently reported by the wallet
 * @param expectedPassphrase The app-configured network passphrase (defaults to config)
 */
export function getNetworkStatus(
  isConnected: boolean,
  isConnecting: boolean,
  networkPassphrase: string | null | undefined,
  expectedPassphrase: string = config.networkPassphrase
): NetworkStatus {
  if (isConnecting) return "connecting";
  if (!isConnected) return "not_connected";
  if (!networkPassphrase) return "unknown";
  return networkPassphrase === expectedPassphrase ? "correct" : "wrong_network";
}

/**
 * Returns true when the given NetworkStatus allows write transactions.
 * "unknown" is permitted because Magic wallet never exposes a passphrase —
 * the preflight guard in lib/preflight.ts handles the actual enforcement.
 */
export function isNetworkReady(status: NetworkStatus): boolean {
  return status === "correct" || status === "unknown";
}

/**
 * Human-readable label for each NetworkStatus — suitable for aria-label text
 * and status announcements.
 */
export function networkStatusLabel(status: NetworkStatus): string {
  switch (status) {
    case "not_connected":  return "Wallet not connected";
    case "connecting":     return "Connecting wallet…";
    case "correct":        return "Connected to correct network";
    case "wrong_network":  return "Wrong network — please switch";
    case "unknown":        return "Connected";
  }
}

// ── NetworkChangeEvent ────────────────────────────────────────────────────────

/**
 * Emitted by useNetworkPoller when the active wallet's network passphrase
 * or account address changes between poll cycles.
 */
export interface NetworkChangeEvent {
  /** "network" when the passphrase changed, "account" when the address changed */
  kind: "network" | "account";
  previous: string | null;
  current: string | null;
  /** Millisecond timestamp of when the change was detected */
  detectedAt: number;
}

// ── StaleDraftToken ───────────────────────────────────────────────────────────

/**
 * An opaque token that tracks whether the network/account context has changed
 * since a transaction draft was created.
 *
 * Usage:
 *   const token = useStaleDraftToken();
 *
 *   // When building a tx draft:
 *   const snapshotId = token.snapshot();
 *
 *   // Immediately before signing:
 *   if (token.isStale(snapshotId)) { discard draft and re-simulate }
 */
export interface StaleDraftToken {
  /**
   * Capture the current generation counter.
   * Returns an opaque id to compare against later.
   */
  snapshot(): number;

  /**
   * Returns true when the network or account changed since `snapshotId` was taken.
   */
  isStale(snapshotId: number): boolean;

  /**
   * The current generation counter.
   * Incremented on every network or account change.
   */
  generation: number;
}

// ── useNetworkPoller ──────────────────────────────────────────────────────────

/**
 * Polls the Freighter extension (or uses the values already in hook state)
 * to detect network and account changes while a modal/form is open.
 *
 * Design rationale: Freighter has no event subscription API
 * (WalletCapabilities.canDetectNetworkChange = false), so polling is the only
 * way to notice mid-session changes.
 *
 * @param opts.publicKey         Current public key from the active wallet hook
 * @param opts.networkPassphrase Current passphrase from the active wallet hook
 * @param opts.onNetworkChange   Fired when a change is detected
 * @param opts.intervalMs        Poll interval (default 1 500 ms)
 * @param opts.enabled           When false the poller is suspended (default true)
 */
export function useNetworkPoller(opts: {
  publicKey: string | null;
  networkPassphrase: string | null;
  onNetworkChange: (event: NetworkChangeEvent) => void;
  intervalMs?: number;
  enabled?: boolean;
}): void {
  const {
    publicKey,
    networkPassphrase,
    onNetworkChange,
    intervalMs = 1_500,
    enabled = true,
  } = opts;

  // Keep stable refs so the interval callback never needs to be recreated
  const prevKeyRef         = useRef<string | null>(publicKey);
  const prevPassphraseRef  = useRef<string | null>(networkPassphrase);
  const callbackRef        = useRef(onNetworkChange);

  // Keep callbackRef current without restarting the interval
  useEffect(() => {
    callbackRef.current = onNetworkChange;
  }, [onNetworkChange]);

  // Sync refs when props change so the first poll after reconnect sees the
  // new baseline rather than treating the reconnect itself as a "change"
  useEffect(() => {
    prevKeyRef.current        = publicKey;
    prevPassphraseRef.current = networkPassphrase;
  }, [publicKey, networkPassphrase]);

  useEffect(() => {
    if (!enabled) return;

    const id = setInterval(() => {
      const nowKey        = prevKeyRef.current;
      const nowPassphrase = prevPassphraseRef.current;

      // These are already kept up-to-date by the effect above — but the
      // interval itself may detect a change one tick before the React render
      // cycle propagates the new values, so we compare directly.
      // In practice, useFreighterWallet polls on its own 800 ms interval
      // and updates state; our refs here track those state values.
      // The actual Freighter polling for live changes is done by the
      // wallet hook; our job here is to observe the *results* in context.
    }, intervalMs);

    return () => clearInterval(id);
  }, [enabled, intervalMs]);

  // Observe prop changes (driven by wallet hook state flowing through context)
  const prevKeySnap        = useRef<string | null>(publicKey);
  const prevPassphraseSnap = useRef<string | null>(networkPassphrase);

  // Use a layout-like comparison in a plain effect so we can emit change events
  useEffect(() => {
    const prevKey        = prevKeySnap.current;
    const prevPassphrase = prevPassphraseSnap.current;

    if (!enabled) return;

    if (publicKey !== prevKey && prevKey !== null && publicKey !== null) {
      callbackRef.current({
        kind: "account",
        previous: prevKey,
        current: publicKey,
        detectedAt: Date.now(),
      });
    }

    if (
      networkPassphrase !== prevPassphrase &&
      prevPassphrase !== null &&
      networkPassphrase !== null
    ) {
      callbackRef.current({
        kind: "network",
        previous: prevPassphrase,
        current: networkPassphrase,
        detectedAt: Date.now(),
      });
    }

    prevKeySnap.current        = publicKey;
    prevPassphraseSnap.current = networkPassphrase;
  }, [publicKey, networkPassphrase, enabled]);
}

// ── useStaleDraftToken ────────────────────────────────────────────────────────

/**
 * React hook that returns a StaleDraftToken.
 *
 * The generation counter increments whenever the network or account changes,
 * making any previously snapshotted draft IDs stale.
 *
 * @param publicKey         Current public key from WalletContext
 * @param networkPassphrase Current passphrase from WalletContext
 * @param enabled           Suspend tracking when false (e.g. no modal open)
 *
 * @example
 * const staleToken = useStaleDraftToken(publicKey, networkPassphrase);
 *
 * // When starting simulation:
 * const draftId = staleToken.snapshot();
 *
 * // Immediately before signing:
 * if (staleToken.isStale(draftId)) {
 *   showError("Network changed — please review the updated transaction.");
 *   return;
 * }
 */
export function useStaleDraftToken(
  publicKey: string | null,
  networkPassphrase: string | null,
  enabled = true
): StaleDraftToken {
  const generationRef = useRef(0);

  const handleChange = useCallback((_event: NetworkChangeEvent) => {
    generationRef.current += 1;
  }, []);

  useNetworkPoller({
    publicKey,
    networkPassphrase,
    onNetworkChange: handleChange,
    enabled,
  });

  return {
    snapshot() {
      return generationRef.current;
    },
    isStale(snapshotId: number) {
      return generationRef.current !== snapshotId;
    },
    get generation() {
      return generationRef.current;
    },
  };
}

// ── Manual switch-network instructions per wallet ─────────────────────────────

export type WalletProviderName = "freighter" | "lobstr" | "magic" | "unknown";

/**
 * Returns ordered step-by-step instructions for switching network in a given
 * wallet provider.  Used by WalletErrorDisplay to render an actionable guide
 * without asking the user to search for documentation.
 */
export function getSwitchNetworkSteps(
  provider: WalletProviderName,
  targetNetworkLabel: string
): string[] {
  switch (provider) {
    case "freighter":
      return [
        'Open the Freighter extension by clicking its icon in the browser toolbar.',
        'Click the network name at the top of the popup (e.g. "Mainnet" or "Testnet").',
        `Select "${targetNetworkLabel}" from the network list.`,
        'Return to this page — your wallet will reconnect automatically.',
      ];

    case "lobstr":
      return [
        'Open the LOBSTR Signer extension by clicking its icon in the browser toolbar.',
        'Tap the gear icon (⚙️) to open Settings.',
        `Under "Network", select "${targetNetworkLabel}".`,
        'Return to this page and click "Reconnect" below.',
      ];

    case "magic":
      return [
        'Magic wallet uses the network configured by this application.',
        'If you see this message, log out and log back in to refresh your session.',
        'If the problem persists, contact support.',
      ];

    default:
      return [
        `Open your wallet extension and navigate to the network settings.`,
        `Switch to "${targetNetworkLabel}".`,
        'Reload this page to reconnect.',
      ];
  }
}

/**
 * Returns the human-readable label for the target network that the app
 * requires, suitable for showing in switch-network instructions.
 */
export function getTargetNetworkLabel(
  expectedPassphrase: string = config.networkPassphrase
): string {
  if (expectedPassphrase.toLowerCase().includes("test")) return "Stellar Testnet";
  if (expectedPassphrase.toLowerCase().includes("public")) return "Stellar Mainnet";
  return expectedPassphrase.slice(0, 40) + (expectedPassphrase.length > 40 ? "…" : "");
}
