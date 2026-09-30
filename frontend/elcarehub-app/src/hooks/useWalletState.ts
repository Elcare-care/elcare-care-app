"use client";

/**
 * hooks/useWalletState.ts — Unified wallet error state model
 *
 * Introduces a `WalletErrorState` that separates the four independently
 * observable failure planes:
 *
 *   connection  — wallet extension not found, auth rejected, wrong network,
 *                 account unavailable, provider conflict
 *   signing     — user rejected signing, XDR malformed, extension error
 *   transaction — simulation/preflight failure, RPC submission error,
 *                 timeout waiting for confirmation
 *   general     — catch-all for unexpected runtime errors
 *
 * Each plane holds a `WalletAdapterError | null`.  Components subscribe only
 * to the plane they care about, reducing unnecessary re-renders and allowing
 * each surface (modal, checkout, bidding panel) to show exactly the right
 * contextual message.
 *
 * Usage:
 *   const { walletErrorState, setConnectionError, clearAllErrors } = useWalletErrorState();
 */

import { useCallback, useReducer } from "react";
import { normalizeWalletError } from "@/lib/wallet-adapter";
import type { WalletAdapterError } from "@/lib/wallet-adapter";
import { config } from "@/lib/config";

// ── State model ───────────────────────────────────────────────────────────────

/**
 * Four independent error planes for wallet interactions.
 * Each is a typed WalletAdapterError or null when no error is present.
 */
export interface WalletErrorState {
  /** Errors during wallet connection (install, rejection, wrong network). */
  connection: WalletAdapterError | null;
  /** Errors during transaction signing (user declined, sign failed). */
  signing: WalletAdapterError | null;
  /** Errors during transaction submission / confirmation (RPC, timeout). */
  transaction: WalletAdapterError | null;
  /** Catch-all for unexpected runtime errors that don't fit other planes. */
  general: WalletAdapterError | null;
}

const INITIAL_ERROR_STATE: WalletErrorState = {
  connection: null,
  signing: null,
  transaction: null,
  general: null,
};

// ── Reducer ───────────────────────────────────────────────────────────────────

type ErrorPlane = keyof WalletErrorState;

type ErrorAction =
  | { type: "SET"; plane: ErrorPlane; error: WalletAdapterError }
  | { type: "CLEAR"; plane: ErrorPlane }
  | { type: "CLEAR_ALL" };

function errorReducer(
  state: WalletErrorState,
  action: ErrorAction
): WalletErrorState {
  switch (action.type) {
    case "SET":
      if (state[action.plane] === action.error) return state;
      return { ...state, [action.plane]: action.error };
    case "CLEAR":
      if (state[action.plane] === null) return state;
      return { ...state, [action.plane]: null };
    case "CLEAR_ALL":
      if (
        state.connection === null &&
        state.signing === null &&
        state.transaction === null &&
        state.general === null
      ) {
        return state;
      }
      return INITIAL_ERROR_STATE;
    default:
      return state;
  }
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export interface UseWalletErrorStateResult {
  /** The current per-plane error state. */
  walletErrorState: WalletErrorState;

  /** Set an error on the connection plane (raw error is normalized). */
  setConnectionError(raw: unknown): void;
  /** Set an error on the signing plane. */
  setSigningError(raw: unknown): void;
  /** Set an error on the transaction plane. */
  setTransactionError(raw: unknown): void;
  /** Set an error on the general plane. */
  setGeneralError(raw: unknown): void;

  /** Clear the connection plane. */
  clearConnectionError(): void;
  /** Clear the signing plane. */
  clearSigningError(): void;
  /** Clear the transaction plane. */
  clearTransactionError(): void;
  /** Clear all error planes at once (e.g. on disconnect). */
  clearAllErrors(): void;

  /**
   * The highest-priority user-facing error to display.
   * Priority: signing > connection > transaction > general.
   * Returns null when no errors are set.
   */
  activeError: WalletAdapterError | null;

  /**
   * Returns true when any error plane has an error.
   */
  hasError: boolean;
}

export function useWalletErrorState(): UseWalletErrorStateResult {
  const [walletErrorState, dispatch] = useReducer(
    errorReducer,
    INITIAL_ERROR_STATE
  );

  const normalize = useCallback(
    (raw: unknown): WalletAdapterError =>
      normalizeWalletError(raw, config.networkPassphrase),
    []
  );

  const setConnectionError = useCallback(
    (raw: unknown) =>
      dispatch({ type: "SET", plane: "connection", error: normalize(raw) }),
    [normalize]
  );
  const setSigningError = useCallback(
    (raw: unknown) =>
      dispatch({ type: "SET", plane: "signing", error: normalize(raw) }),
    [normalize]
  );
  const setTransactionError = useCallback(
    (raw: unknown) =>
      dispatch({ type: "SET", plane: "transaction", error: normalize(raw) }),
    [normalize]
  );
  const setGeneralError = useCallback(
    (raw: unknown) =>
      dispatch({ type: "SET", plane: "general", error: normalize(raw) }),
    [normalize]
  );

  const clearConnectionError = useCallback(
    () => dispatch({ type: "CLEAR", plane: "connection" }),
    []
  );
  const clearSigningError = useCallback(
    () => dispatch({ type: "CLEAR", plane: "signing" }),
    []
  );
  const clearTransactionError = useCallback(
    () => dispatch({ type: "CLEAR", plane: "transaction" }),
    []
  );
  const clearAllErrors = useCallback(
    () => dispatch({ type: "CLEAR_ALL" }),
    []
  );

  // Priority ordering: signing > connection > transaction > general
  const activeError =
    walletErrorState.signing ??
    walletErrorState.connection ??
    walletErrorState.transaction ??
    walletErrorState.general ??
    null;

  const hasError = activeError !== null;

  return {
    walletErrorState,
    setConnectionError,
    setSigningError,
    setTransactionError,
    setGeneralError,
    clearConnectionError,
    clearSigningError,
    clearTransactionError,
    clearAllErrors,
    activeError,
    hasError,
  };
}

// ── Helpers consumed by WalletContext ─────────────────────────────────────────

/**
 * Derive a WalletAdapterError from the raw string error exposed by
 * useFreighterWallet / useLobstrWallet, or null if no error is present.
 *
 * This is a pure function (no hooks) so it can be called inside useMemo
 * and useCallback in WalletContext without ordering constraints.
 */
export function normalizeProviderError(
  raw: string | null | undefined
): WalletAdapterError | null {
  if (!raw) return null;
  return normalizeWalletError(raw, config.networkPassphrase);
}

/**
 * Return the "best" WalletAdapterError from the active provider's raw error
 * string and its isWrongNetwork / isInstalled flags, merging them into a
 * single typed value.
 *
 * Used in WalletContext to keep the unified `walletError` field always typed.
 */
export function resolveProviderError(opts: {
  rawError: string | null | undefined;
  isWrongNetwork: boolean;
  isInstalled: boolean;
  networkPassphrase: string | null;
  expectedPassphrase: string;
  providerName: string;
}): WalletAdapterError | null {
  // Explicit NOT_INSTALLED flag takes priority over any raw error string
  if (!opts.isInstalled) {
    return {
      kind: "NOT_INSTALLED",
      message: `${opts.providerName} is not installed.`,
    };
  }

  // Explicit wrong-network flag is more reliable than string matching
  if (opts.isWrongNetwork) {
    const detected = opts.networkPassphrase;
    const detectedLabel = detected
      ? `"${detected.slice(0, 40)}${detected.length > 40 ? "…" : ""}"`
      : "an unknown network";
    return {
      kind: "WRONG_NETWORK",
      message: `${opts.providerName} is connected to ${detectedLabel}. Please switch to "${opts.expectedPassphrase}".`,
      expected: opts.expectedPassphrase,
      detected,
    };
  }

  // Fall through to string-based normalization
  return normalizeProviderError(opts.rawError);
}
