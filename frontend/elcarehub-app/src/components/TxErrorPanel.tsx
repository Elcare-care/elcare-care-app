"use client";

/**
 * components/TxErrorPanel.tsx
 *
 * Contextual guidance panel for transaction-lifecycle errors.
 *
 * Accepts a `TxError` (from useTxLifecycle) and renders a rich panel with:
 *   - Human-readable title and explanation per TxErrorCategory
 *   - A concrete "what to do next" instruction
 *   - Primary action button (retry, refresh, contact support)
 *   - Optional transaction hash for on-chain lookup
 *   - Optional "view on explorer" link
 *   - IndexerDelayNotice variant for indexer_delay category
 *
 * Used by: CheckoutModal, BiddingPanel, OfferPanel, ListingForm,
 *          LaunchpadForm, and any page that runs useTxLifecycle.
 */

import React from "react";
import {
  AlertTriangle, XCircle, WifiOff, Clock,
  RefreshCw, ExternalLink, HelpCircle, X,
} from "lucide-react";
import type { TxError, TxErrorCategory } from "@/hooks/useTxLifecycle";
import { IndexerDelayNotice } from "@/components/WalletErrorDisplay";
import { config } from "@/lib/config";

// ── Per-category display config ───────────────────────────────────────────────

interface CategoryConfig {
  icon: React.ReactNode;
  title: string;
  explanation: string;
  instruction: string;
  primaryLabel: string;
  severity: "warning" | "error" | "info";
}

function getCategoryConfig(category: TxErrorCategory): CategoryConfig {
  switch (category) {
    case "wallet_rejection":
      return {
        icon: <XCircle size={20} aria-hidden="true" />,
        title: "Signing Request Declined",
        explanation:
          "You declined the signing request in your wallet. Your transaction was not submitted and nothing was charged.",
        instruction:
          'Click "Try Again" and when your wallet opens, click "Approve" or "Accept" to authorise the transaction.',
        primaryLabel: "Try Again",
        severity: "info",
      };

    case "simulation_failure":
      return {
        icon: <AlertTriangle size={20} aria-hidden="true" />,
        title: "Transaction Preview Failed",
        explanation:
          "The transaction could not be simulated before signing. This usually means the listing state changed, your account lacks funds, or the contract returned an error.",
        instruction:
          "Refresh the page to get the latest state, check you have enough XLM to cover the transaction and fees, then try again.",
        primaryLabel: "Refresh & Retry",
        severity: "error",
      };

    case "rpc_failure":
      return {
        icon: <WifiOff size={20} aria-hidden="true" />,
        title: "Network Error",
        explanation:
          "The Stellar RPC could not process your request. This is usually a temporary network issue — your transaction was not submitted.",
        instruction:
          "Wait a few seconds, then try again. If the problem persists, check the Stellar Network status page.",
        primaryLabel: "Try Again",
        severity: "error",
      };

    case "indexer_delay":
      return {
        icon: <Clock size={20} aria-hidden="true" />,
        title: "Transaction Confirmed — Indexer Catching Up",
        explanation:
          "Your transaction landed on-chain successfully, but the ELCARE-HUB indexer hasn't processed it yet.",
        instruction:
          "This usually resolves within 30 seconds. Refresh the page to check for the updated state.",
        primaryLabel: "Refresh",
        severity: "warning",
      };

    case "unknown":
    default:
      return {
        icon: <HelpCircle size={20} aria-hidden="true" />,
        title: "Transaction Failed",
        explanation:
          "An unexpected error occurred while processing your transaction.",
        instruction:
          "Try again. If the problem persists, copy the error message below and contact support.",
        primaryLabel: "Try Again",
        severity: "error",
      };
  }
}

// ── Severity → colour classes ─────────────────────────────────────────────────

const SEVERITY = {
  warning: {
    wrapper: "border-amber-200 bg-amber-50",
    icon:    "bg-amber-100 text-amber-600",
    title:   "text-amber-900",
    body:    "text-amber-800",
    hint:    "text-amber-700",
    btn:     "bg-amber-500 hover:bg-amber-600 text-white",
  },
  error: {
    wrapper: "border-red-200 bg-red-50",
    icon:    "bg-red-100 text-red-600",
    title:   "text-red-900",
    body:    "text-red-800",
    hint:    "text-red-700",
    btn:     "bg-red-500 hover:bg-red-600 text-white",
  },
  info: {
    wrapper: "border-brand-200 bg-brand-50",
    icon:    "bg-brand-100 text-brand-600",
    title:   "text-brand-900",
    body:    "text-brand-800",
    hint:    "text-brand-700",
    btn:     "bg-brand-500 hover:bg-brand-600 text-white",
  },
} as const;

// ── Component ─────────────────────────────────────────────────────────────────

export interface TxErrorPanelProps {
  /** The error object from useTxLifecycle. */
  error: TxError;
  /** Transaction hash, if available (for explorer link). */
  txHash?: string | null;
  /** Called when user clicks the primary retry button. */
  onRetry?: () => void;
  /** Called when user clicks dismiss / X. Pass null to hide dismiss. */
  onDismiss?: (() => void) | null;
  /** Extra Tailwind classes on the wrapper. */
  className?: string;
}

export function TxErrorPanel({
  error,
  txHash,
  onRetry,
  onDismiss,
  className = "",
}: TxErrorPanelProps) {
  // indexer_delay gets its own specialised component
  if (error.category === "indexer_delay") {
    return (
      <IndexerDelayNotice
        txHash={txHash}
        onRefresh={onRetry}
        className={className}
      />
    );
  }

  const cfg = getCategoryConfig(error.category);
  const sc  = SEVERITY[cfg.severity];

  const explorerUrl =
    txHash && config.explorerBaseUrl
      ? `${config.explorerBaseUrl}/tx/${txHash}`
      : null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      data-testid="tx-error-panel"
      className={`relative rounded-2xl border p-4 ${sc.wrapper} ${className}`}
    >
      {onDismiss != null && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss error"
          className="absolute right-3 top-3 rounded-full p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors">
          <X size={14} aria-hidden="true" />
        </button>
      )}

      <div className="flex gap-3">
        {/* icon */}
        <div className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl ${sc.icon}`}
          aria-hidden="true">
          {cfg.icon}
        </div>

        {/* content */}
        <div className="flex-1 min-w-0 pr-5">
          <p className={`text-sm font-bold ${sc.title}`}>{cfg.title}</p>
          <p className={`mt-0.5 text-xs leading-relaxed ${sc.body}`}>{cfg.explanation}</p>
          <p className={`mt-1.5 text-xs font-medium ${sc.hint}`}>
            <span className="font-semibold">What to do: </span>{cfg.instruction}
          </p>

          {/* raw error (collapsible for debugging) */}
          {error.message && error.message !== cfg.explanation && (
            <details className="mt-2">
              <summary className={`cursor-pointer text-[11px] font-medium ${sc.hint} select-none`}>
                Technical details
              </summary>
              <p className="mt-1 rounded-lg bg-black/5 px-2 py-1.5 font-mono text-[10px] text-gray-600 break-all">
                {error.message}
              </p>
            </details>
          )}

          {/* actions */}
          <div className="mt-3 flex flex-wrap gap-2 items-center">
            {onRetry && (
              <button type="button" onClick={onRetry}
                className={`inline-flex items-center gap-1.5 rounded-xl px-4 py-1.5 text-xs font-bold transition-all ${sc.btn}`}>
                <RefreshCw size={11} aria-hidden="true" />
                {cfg.primaryLabel}
              </button>
            )}
            {explorerUrl && (
              <a href={explorerUrl} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-midnight-900 transition-colors">
                View on explorer <ExternalLink size={11} aria-hidden="true" />
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Compact inline variant ────────────────────────────────────────────────────

/**
 * Single-line compact version for tight spaces (e.g. inside button rows).
 */
export function TxErrorInline({
  error,
  onRetry,
  className = "",
}: Pick<TxErrorPanelProps, "error" | "onRetry" | "className">) {
  const cfg = getCategoryConfig(error.category);
  const sc  = SEVERITY[cfg.severity];

  return (
    <div role="alert" aria-live="assertive" data-testid="tx-error-inline"
      className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs ${sc.wrapper} ${className}`}>
      <span className={sc.icon} aria-hidden="true">{cfg.icon}</span>
      <span className={`flex-1 font-medium ${sc.body}`}>{cfg.title}</span>
      {onRetry && (
        <button type="button" onClick={onRetry}
          className={`ml-auto shrink-0 rounded-lg px-2 py-1 text-[11px] font-bold transition-all ${sc.btn}`}>
          {cfg.primaryLabel}
        </button>
      )}
    </div>
  );
}
