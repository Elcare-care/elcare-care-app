// ─────────────────────────────────────────────────────────────────────────────
// hooks/useTxState.ts — Shared transaction state context (Issue #300)
//
// Provides a React context that lets a page or modal tree expose a single
// useTxLifecycle instance to all child components.  Without this, each
// component that imports useTxLifecycle gets its own independent state
// machine, which means:
//   - Two components can both think they are "idle" and both start a run
//   - The duplicate-submission guard in useTxLifecycle only protects within
//     a single hook instance
//
// Usage pattern
// ─────────────
//   // In a page or modal:
//   const txState = useTxLifecycle({ persistKey: "purchase" });
//   <TxStateProvider value={txState}>
//     <CheckoutModal />
//     <TxStatusBar />
//   </TxStateProvider>
//
//   // In any child component:
//   const { txState, isActive, run, reset } = useTxStateContext();
//
// When NOT wrapping with TxStateProvider the hook falls back to creating its
// own local useTxLifecycle instance, so it is always safe to call even in
// components that are used both inside and outside a provider.
//
// Duplicate-submission guard at the context level
// ────────────────────────────────────────────────
// useTxState re-exports the same `run` from the underlying useTxLifecycle
// which already contains the `runningRef` guard.  Sharing the context means
// all consumers reference the same guard, so a "Place Bid" button and a
// "Finalize Auction" button inside the same panel cannot both fire at once.
// ─────────────────────────────────────────────────────────────────────────────

"use client";

import { createContext, useContext } from "react";
import {
  useTxLifecycle,
  UseTxLifecycleResult,
  TxLifecycleOptions,
  TxLifecycleState,
  TxState,
  TxErrorCategory,
  TxError,
  txStateLabel,
  isTxTerminal,
  isTxActive,
} from "./useTxLifecycle";

// Re-export everything callers need so they only import from this file
export type {
  TxLifecycleState,
  TxState,
  TxErrorCategory,
  TxError,
  TxLifecycleOptions,
  UseTxLifecycleResult,
};
export { txStateLabel, isTxTerminal, isTxActive };

// ── Context ───────────────────────────────────────────────────────────────────

/**
 * Context value is either an existing UseTxLifecycleResult (shared) or null
 * (no provider — each consumer creates its own instance).
 */
const TxStateContext = createContext<UseTxLifecycleResult | null>(null);

TxStateContext.displayName = "TxStateContext";

/**
 * Provide a shared transaction lifecycle instance to all children.
 *
 * @example
 * const lifecycle = useTxLifecycle({ persistKey: "purchase" });
 * return (
 *   <TxStateProvider value={lifecycle}>
 *     <CheckoutModal />
 *   </TxStateProvider>
 * );
 */
export const TxStateProvider = TxStateContext.Provider;

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Returns the shared transaction lifecycle state from the nearest
 * TxStateProvider, or creates a local instance if no provider is present.
 *
 * When called outside a TxStateProvider the `opts` parameter is forwarded to
 * useTxLifecycle for the local instance.  Inside a provider, `opts` is
 * ignored because the lifecycle was already configured at the provider level.
 *
 * @param opts  Lifecycle options for the fallback local instance.
 */
export function useTxStateContext(
  opts: TxLifecycleOptions = {}
): UseTxLifecycleResult {
  const shared = useContext(TxStateContext);
  // Local instance created only when no provider wraps this component.
  // Rules of Hooks: this call is always made so the hook count is stable.
  const local = useTxLifecycle(opts);
  return shared ?? local;
}

// ── Convenience selector hooks ────────────────────────────────────────────────

/**
 * Returns just the current TxState string, useful for purely display
 * components that only need to know "what phase are we in".
 *
 * @example
 * const phase = useTxPhase();
 * if (phase === "signing") return <SigningSpinner />;
 */
export function useTxPhase(): TxState {
  const { txState } = useTxStateContext();
  return txState.state;
}

/**
 * Returns true while the transaction is in any active (non-idle, non-terminal)
 * state.  Useful for disabling buttons.
 */
export function useTxIsActive(): boolean {
  const { isActive } = useTxStateContext();
  return isActive;
}

/**
 * Returns the current TxError, or null when there is no error.
 * Useful for conditionally rendering TxErrorPanel.
 */
export function useTxError(): TxError | null {
  const { txState } = useTxStateContext();
  return txState.error;
}

/**
 * Returns the current transaction hash (if one has been submitted), or null.
 * Useful for building explorer links.
 */
export function useTxHash(): string | null {
  const { txState } = useTxStateContext();
  return txState.txHash;
}

/**
 * Returns a human-readable status label for the current phase.
 * Suitable for aria-live regions and progress indicators.
 */
export function useTxLabel(): string {
  const { txState } = useTxStateContext();
  return txStateLabel(txState.state);
}
