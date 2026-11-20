// ─────────────────────────────────────────────────────────────
// hooks/useTxToast.ts — Transaction lifecycle toast helper
//
// Wraps an async on-chain action and fires standardised toasts
// for each phase of the Soroban transaction lifecycle.
//
// Issue #300: now delegates the lifecycle state tracking to
// useTxLifecycle so all actions share the same state machine.
// The public API (run, isRunning, phase) is unchanged so
// existing callers require no migration.
//
// Usage:
//   const { run, isRunning } = useTxToast();
//   const ok = await run(() => buyArtwork(publicKey, listingId), {
//     action: "Purchase",
//   });
// ─────────────────────────────────────────────────────────────

"use client";

import { useCallback, useState } from "react";
import { useToast } from "@/components/ToastProvider";
import { getReadableErrorMessage, isUserRejectionError } from "@/lib/errors";
import { config } from "@/lib/config";
import {
  useTxLifecycle,
  txActionLabel,
  TxState,
  extractTxHash,
  classifyTxError,
} from "./useTxLifecycle";
import { isValidTxHash } from "@/lib/txLookup";
import { t, type TranslationKey } from "@/lib/i18n";

// ── Types ─────────────────────────────────────────────────────

/**
 * Legacy phase type — kept for backwards compatibility with components
 * that read the `phase` field from useTxToast.
 */
export type TxLifecyclePhase =
  | "idle"
  | "submitting"
  | "signing"
  | "broadcasting"
  | "confirming"
  | "success"
  | "error";

export interface UseTxToastOptions {
  /**
   * Short human-readable label for the action shown in toast messages,
   * e.g. "Purchase", "Bid", "Listing", "Offer".
   * Defaults to "Transaction".
   */
  action?: string;

  /**
   * Override the success message. Receives the transaction hash (if
   * available) and must return a string.
   */
  successMessage?: (txHash: string | null) => string;

  /**
   * Duration (ms) for the success toast. Defaults to 8 000 ms so the
   * explorer URL stays visible long enough for users to copy it.
   */
  successDurationMs?: number;

  /**
   * Duration (ms) for error toasts. Defaults to 6 000 ms.
   */
  errorDurationMs?: number;
}

export interface UseTxToastResult {
  /** Execute the async callback with lifecycle toasts. Returns true on success. */
  run: <T>(
    fn: () => Promise<T>,
    opts?: UseTxToastOptions
  ) => Promise<T | null>;

  /** True while the transaction is in any non-idle phase. */
  isRunning: boolean;

  /** Current lifecycle phase (legacy alias). */
  phase: TxLifecyclePhase;

  /**
   * The real transaction hash once known (set as soon as broadcasting
   * succeeds — before on-chain/indexer confirmation). Issue #520: callers
   * that track provisional/optimistic state (useReconciliation) should key
   * their pending mutation on this value once it's non-null, rather than
   * relying solely on a locally-generated id, so the mutation can be
   * reconciled against the real transaction identity end-to-end.
   */
  txHash: string | null;
}

// ── Explorer URL helper ───────────────────────────────────────

/**
 * Returns the stellar.expert URL for a transaction hash.
 * Falls back gracefully when hash is null/undefined.
 */
export function getTxExplorerUrl(txHash: string | null | undefined): string | null {
  if (!txHash || !isValidTxHash(txHash)) return null;
  const network = config.network === "mainnet" ? "mainnet" : "testnet";
  return `https://stellar.expert/explorer/${network}/tx/${txHash}`;
}

// ── Success guidance ─────────────────────────────────────────
//
// Maps the same free-form action labels used for lifecycle copy onto the
// tx_guidance_* locale entries, so every success notification ends with a
// concise, outcome-specific next action instead of a bare "Success".

const TX_GUIDANCE_KEYS: Record<string, TranslationKey> = {
  "purchase": "tx_guidance_purchase",
  "bid": "tx_guidance_bid",
  "create listing": "tx_guidance_listing",
  "listing": "tx_guidance_listing",
  "update listing": "tx_guidance_listing",
  "create auction": "tx_guidance_auction_create",
  "auction": "tx_guidance_auction_create",
  "place offer": "tx_guidance_offer",
  "placing offer": "tx_guidance_offer",
  "offer": "tx_guidance_offer",
  "accept offer": "tx_guidance_offer_response",
  "accepting offer": "tx_guidance_offer_response",
  "reject offer": "tx_guidance_offer_response",
  "rejecting offer": "tx_guidance_offer_response",
  "finalize auction": "tx_guidance_finalize",
  "cancel auction": "tx_guidance_cancel",
  "cancel listing": "tx_guidance_cancel",
  "cancel listings": "tx_guidance_cancel",
  "claim refund": "tx_guidance_refund",
};

function txSuccessGuidance(action: string): string {
  const key = TX_GUIDANCE_KEYS[action.trim().toLowerCase()];
  return t(key ?? "tx_guidance_generic");
}

function capitalizeFirst(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/**
 * Builds the localized success toast: "<Action> confirmed!" followed by
 * outcome-specific next-action guidance and, when a transaction hash is
 * available, an explorer link (the hash itself stays available via the URL).
 */
export function buildTxSuccessMessage(
  action: string,
  txHash: string | null,
  customMessage?: (txHash: string | null) => string
): string {
  if (customMessage) return customMessage(txHash);

  const actionLabel = capitalizeFirst(txActionLabel(action));
  const base = t("tx_state_success").replace(/\{action\}/g, actionLabel);
  const explorerUrl = getTxExplorerUrl(txHash);
  const suffix = explorerUrl
    ? ` ${t("tx_success_view_explorer")}: ${explorerUrl}`
    : "";
  return `${base} ${txSuccessGuidance(action)}${suffix}`;
}

// ── Map TxState → legacy TxLifecyclePhase ────────────────────

function toPhase(state: TxState): TxLifecyclePhase {
  switch (state) {
    case "idle":             return "idle";
    case "simulating":       return "submitting";
    case "signing":          return "signing";
    case "broadcasting":     return "broadcasting";
    case "confirming":
    case "indexer_pending":  return "confirming";
    case "success":          return "success";
    case "error":            return "error";
  }
}

// ── Hook ──────────────────────────────────────────────────────

export function useTxToast(): UseTxToastResult {
  const { pushToast } = useToast();
  // Delegate all lifecycle tracking to useTxLifecycle.
  // Disable sessionStorage persistence here — useTxToast callers that want
  // persistence should use useTxLifecycle directly.
  const { txState, run: lifecycleRun } = useTxLifecycle({
    persistKey: null,
  });

  const run = useCallback(
    async <T>(
      fn: () => Promise<T>,
      opts: UseTxToastOptions = {}
    ): Promise<T | null> => {
      const {
        action = "Transaction",
        successMessage,
        successDurationMs = 8_000,
        errorDurationMs = 6_000,
      } = opts;

      // Toast: building
      pushToast(`${action}: building transaction…`, "info");

      // Toast: awaiting signature (just before we call fn)
      pushToast(`${action}: awaiting wallet signature…`, "info");

      const result = await lifecycleRun(
        async () => {
          const r = await fn();
          return r;
        },
        { action }
      );

      if (result === null) {
        // Determine what went wrong from the lifecycle error
        const { error } = txState;
        if (error) {
          if (error.category === "wallet_rejection") {
            pushToast(`${action} cancelled — you rejected the request.`, "error", errorDurationMs);
          } else {
            const msg = getReadableErrorMessage(
              error.originalError ?? error.message,
              `${action} failed. Please try again.`
            );
            pushToast(msg, "error", errorDurationMs);
          }
        }
        return null;
      }

      // Toast: broadcasting — note that the UI updates after ledger confirmation
      pushToast(`${action}: broadcasting to the network — this page will update once the ledger confirms…`, "info");

      // Build success message — localized, outcome-specific next action,
      // explorer link preserved when a tx hash is available.
      const txHash = extractTxHash(result);
      const successMsg = buildTxSuccessMessage(action, txHash, successMessage);
      pushToast(successMsg, "success", successDurationMs);

      return result;
    },
    [pushToast, lifecycleRun, txState]
  );

  return {
    run,
    isRunning: txState.state !== "idle" && txState.state !== "success" && txState.state !== "error",
    phase: toPhase(txState.state),
    txHash: txState.txHash,
  };
}

