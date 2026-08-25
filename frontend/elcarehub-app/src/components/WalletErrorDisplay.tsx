"use client";

/**
 * components/WalletErrorDisplay.tsx
 *
 * Unified, actionable wallet error display component.
 *
 * Accepts a `WalletAdapterError` (discriminated union from wallet-adapter.ts)
 * and renders:
 *   - A human-readable title and explanation
 *   - A concrete "what to do next" instruction
 *   - An optional primary action button (install, switch network, retry, etc.)
 *   - An optional secondary dismiss action
 *
 * WRONG_NETWORK errors additionally render a NetworkSwitchPanel with:
 *   - Step-by-step per-provider manual instructions
 *   - A "Checking…" waiting state after the user acts
 *   - A post-switch re-simulation trigger once the correct network is detected
 *
 * Used by ConnectWalletModal, WalletGuard, CheckoutModal, BiddingPanel,
 * OfferPanel, and any other component that surfaces wallet errors.
 */

import React, { useRef, useEffect, useState, useCallback } from "react";
import {
  AlertTriangle,
  WifiOff,
  Download,
  ArrowRightLeft,
  XCircle,
  RefreshCw,
  Clock,
  HelpCircle,
  ExternalLink,
  X,
  CheckCircle2,
  List,
  Loader2,
} from "lucide-react";
import type { WalletAdapterError } from "@/lib/wallet-adapter";
import {
  getSwitchNetworkSteps,
  getTargetNetworkLabel,
  type WalletProviderName,
} from "@/lib/networkStatus";

// ── Per-kind display config ──────────────────────────────────────────────────

interface ErrorDisplayConfig {
  icon: React.ReactNode;
  title: string;
  explanation: string;
  instruction: string;
  primaryLabel?: string;
  primaryHref?: string;
  primaryAction?: () => void;
  severity: "warning" | "error" | "info";
}

function getDisplayConfig(
  error: WalletAdapterError,
  onRetry?: () => void,
  onSwitchNetwork?: () => void
): ErrorDisplayConfig {
  switch (error.kind) {
    case "NOT_INSTALLED":
      return {
        icon: <Download size={20} aria-hidden="true" />,
        title: "Wallet Extension Not Found",
        explanation:
          "The required wallet extension is not installed in your browser.",
        instruction:
          "Install the extension from the official source, refresh this page, and try connecting again.",
        primaryLabel: "Install Freighter",
        primaryHref: "https://www.freighter.app/",
        severity: "warning",
      };

    case "USER_REJECTED":
      return {
        icon: <XCircle size={20} aria-hidden="true" />,
        title: "Request Declined",
        explanation: "You declined the request in your wallet.",
        instruction:
          "When your wallet prompts you to approve or sign, click "Accept" or "Approve" to continue.",
        primaryLabel: "Try Again",
        primaryAction: onRetry,
        severity: "info",
      };

    case "WRONG_NETWORK": {
      const expected = error.expected ?? "the required network";
      const detected = error.detected;
      const detectedLabel = detected
        ? `"${networkShortLabel(detected)}"`
        : "a different network";
      return {
        icon: <ArrowRightLeft size={20} aria-hidden="true" />,
        title: "Wrong Network",
        explanation: `Your wallet is connected to ${detectedLabel}. This app requires "${networkShortLabel(expected)}".`,
        instruction:
          "Follow the steps below to switch networks in your wallet, then return to this page.",
        primaryLabel: "Refresh Connection",
        primaryAction: onSwitchNetwork ?? onRetry,
        severity: "error",
      };
    }

    case "ACCOUNT_UNAVAILABLE":
      return {
        icon: <WifiOff size={20} aria-hidden="true" />,
        title: "Account Unavailable",
        explanation:
          "Your wallet account could not be read. The extension may be locked or the account removed.",
        instruction:
          "Unlock your wallet extension and make sure an account is active, then reconnect.",
        primaryLabel: "Reconnect",
        primaryAction: onRetry,
        severity: "error",
      };

    case "SIGN_FAILED":
      return {
        icon: <AlertTriangle size={20} aria-hidden="true" />,
        title: "Signing Failed",
        explanation:
          "The wallet was unable to sign this transaction. This can happen when the transaction XDR is malformed or the extension encountered an internal error.",
        instruction:
          "Reload the page and try again. If the problem persists, check the browser console for details.",
        primaryLabel: "Try Again",
        primaryAction: onRetry,
        severity: "error",
      };

    case "UNSUPPORTED_CAPABILITY":
      return {
        icon: <HelpCircle size={20} aria-hidden="true" />,
        title: "Feature Not Supported",
        explanation: error.message,
        instruction:
          "Switch to a wallet that supports this feature, or use an alternative flow.",
        severity: "info",
      };

    case "PROVIDER_CONFLICT":
      return {
        icon: <AlertTriangle size={20} aria-hidden="true" />,
        title: "Wallet Conflict Detected",
        explanation:
          "Multiple wallet extensions are active and conflicting with each other.",
        instruction:
          "Disable all wallet extensions except the one you want to use, then reload the page.",
        primaryLabel: "Reload Page",
        primaryAction: () => window.location.reload(),
        severity: "error",
      };

    case "UNKNOWN":
    default:
      return {
        icon: <RefreshCw size={20} aria-hidden="true" />,
        title: "Wallet Error",
        explanation: error.message || "An unexpected error occurred.",
        instruction:
          "Reload the page and try again. If the issue continues, contact support.",
        primaryLabel: "Try Again",
        primaryAction: onRetry,
        severity: "error",
      };
  }
}

function networkShortLabel(passphrase: string): string {
  if (!passphrase) return "Unknown";
  if (passphrase.toLowerCase().includes("test")) return "Stellar Testnet";
  if (passphrase.toLowerCase().includes("public")) return "Stellar Mainnet";
  return passphrase.length > 30
    ? passphrase.slice(0, 28) + "…"
    : passphrase;
}

// ── Severity → Tailwind class maps ───────────────────────────────────────────

const SEVERITY_CLASSES = {
  warning: {
    wrapper: "border-amber-200 bg-amber-50",
    icon: "text-amber-600 bg-amber-100",
    title: "text-amber-900",
    body: "text-amber-800",
    instruction: "text-amber-700",
    primary:
      "bg-amber-500 text-white hover:bg-amber-600 focus-visible:ring-amber-400",
  },
  error: {
    wrapper: "border-red-200 bg-red-50",
    icon: "text-red-600 bg-red-100",
    title: "text-red-900",
    body: "text-red-800",
    instruction: "text-red-700",
    primary:
      "bg-red-500 text-white hover:bg-red-600 focus-visible:ring-red-400",
  },
  info: {
    wrapper: "border-brand-200 bg-brand-50",
    icon: "text-brand-600 bg-brand-100",
    title: "text-brand-900",
    body: "text-brand-800",
    instruction: "text-brand-700",
    primary:
      "bg-brand-500 text-white hover:bg-brand-600 focus-visible:ring-brand-400",
  },
} as const;

// ── Component ────────────────────────────────────────────────────────────────

export interface WalletErrorDisplayProps {
  /** The normalized wallet error to display. */
  error: WalletAdapterError;
  /** Called when the user clicks the primary "Try Again" / "Reconnect" button. */
  onRetry?: () => void;
  /** Called when the user clicks "Refresh Connection" on WRONG_NETWORK errors. */
  onSwitchNetwork?: () => void;
  /** Called when the user dismisses the error panel. Pass null to hide dismiss button. */
  onDismiss?: (() => void) | null;
  /** Extra Tailwind classes applied to the outer wrapper. */
  className?: string;
  /**
   * When true, auto-focuses the primary action button when the component mounts.
   * Useful inside modals where focus management is important.
   */
  autoFocusPrimary?: boolean;
  /**
   * Which wallet provider is active — used to show provider-specific switch
   * instructions in the WRONG_NETWORK panel.
   * Defaults to "unknown".
   */
  provider?: WalletProviderName;
  /**
   * Called after the user has followed the switch steps and this component
   * detects (or the parent signals) the network is now correct.
   * The parent should re-run simulation after this fires.
   */
  onReadyToResimulate?: () => void;
  /**
   * When true the WRONG_NETWORK panel shows a "Checking network…" spinner
   * instead of the step list — set this while the parent is polling to
   * confirm the switch completed.
   */
  isCheckingNetwork?: boolean;
}

export function WalletErrorDisplay({
  error,
  onRetry,
  onSwitchNetwork,
  onDismiss,
  className = "",
  autoFocusPrimary = false,
  provider = "unknown",
  onReadyToResimulate,
  isCheckingNetwork = false,
}: WalletErrorDisplayProps) {
  const primaryRef = useRef<HTMLButtonElement | HTMLAnchorElement | null>(null);
  const cfg = getDisplayConfig(error, onRetry, onSwitchNetwork);
  const sc = SEVERITY_CLASSES[cfg.severity];

  useEffect(() => {
    if (autoFocusPrimary && primaryRef.current) {
      primaryRef.current.focus();
    }
  }, [autoFocusPrimary]);

  return (
    <div
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      data-testid="wallet-error-display"
      className={`relative rounded-2xl border p-4 ${sc.wrapper} ${className}`}
    >
      {/* Dismiss button */}
      {onDismiss != null && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss error"
          className="absolute right-3 top-3 rounded-full p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors"
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}

      <div className="flex gap-3">
        {/* Icon */}
        <div
          className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl ${sc.icon}`}
          aria-hidden="true"
        >
          {cfg.icon}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 pr-4">
          <p className={`text-sm font-bold ${sc.title}`}>{cfg.title}</p>
          <p className={`mt-0.5 text-xs leading-relaxed ${sc.body}`}>
            {cfg.explanation}
          </p>
          <p className={`mt-1.5 text-xs font-medium ${sc.instruction}`}>
            <span className="font-semibold">What to do: </span>
            {cfg.instruction}
          </p>

          {/* WRONG_NETWORK: inline step-by-step switch panel */}
          {error.kind === "WRONG_NETWORK" && (
            <NetworkSwitchPanel
              provider={provider}
              expectedPassphrase={error.expected}
              isChecking={isCheckingNetwork}
              onDoneSteps={onSwitchNetwork ?? onRetry}
              onReadyToResimulate={onReadyToResimulate}
              className="mt-3"
            />
          )}

          {/* Actions for non-WRONG_NETWORK errors */}
          {error.kind !== "WRONG_NETWORK" &&
            (cfg.primaryLabel || onDismiss !== null) && (
            <div className="mt-3 flex flex-wrap gap-2">
              {cfg.primaryHref ? (
                <a
                  ref={primaryRef as React.RefObject<HTMLAnchorElement>}
                  href={cfg.primaryHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`inline-flex items-center gap-1.5 rounded-xl px-4 py-1.5 text-xs font-bold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 ${sc.primary}`}
                >
                  {cfg.primaryLabel}
                  <ExternalLink size={11} aria-hidden="true" />
                </a>
              ) : cfg.primaryAction ? (
                <button
                  ref={primaryRef as React.RefObject<HTMLButtonElement>}
                  type="button"
                  onClick={cfg.primaryAction}
                  className={`inline-flex items-center gap-1.5 rounded-xl px-4 py-1.5 text-xs font-bold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 ${sc.primary}`}
                >
                  {cfg.primaryLabel}
                </button>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── NetworkSwitchPanel ───────────────────────────────────────────────────────

/**
 * Step-by-step guided panel for switching the wallet network.
 *
 * Shown inline inside WalletErrorDisplay for WRONG_NETWORK errors.
 * Also exported for use in WalletGuard and ConnectWalletModal.
 *
 * States:
 *  - default   : numbered step list with "I've switched" CTA
 *  - checking  : spinner while parent polls for the new network
 *  - confirmed : success tick + "Re-simulate" CTA
 */
export interface NetworkSwitchPanelProps {
  provider?: WalletProviderName;
  expectedPassphrase?: string;
  /** When true show the checking spinner instead of steps */
  isChecking?: boolean;
  /** Called when user clicks "I've switched — check now" */
  onDoneSteps?: () => void;
  /** Called when the user clicks "Re-simulate transaction" */
  onReadyToResimulate?: () => void;
  className?: string;
}

export function NetworkSwitchPanel({
  provider = "unknown",
  expectedPassphrase,
  isChecking = false,
  onDoneSteps,
  onReadyToResimulate,
  className = "",
}: NetworkSwitchPanelProps) {
  const targetLabel = getTargetNetworkLabel(expectedPassphrase);
  const steps = getSwitchNetworkSteps(provider, targetLabel);
  const [done, setDone] = useState(false);

  const handleDone = useCallback(() => {
    setDone(true);
    onDoneSteps?.();
  }, [onDoneSteps]);

  const handleResimulate = useCallback(() => {
    setDone(false);
    onReadyToResimulate?.();
  }, [onReadyToResimulate]);

  if (isChecking) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="network-switch-checking"
        className={`flex items-center gap-2 rounded-xl bg-yellow-50 border border-yellow-200 px-3 py-2.5 text-xs text-yellow-800 ${className}`}
      >
        <Loader2 size={14} className="animate-spin shrink-0 text-yellow-600" aria-hidden="true" />
        <span>Checking network… this will update automatically.</span>
      </div>
    );
  }

  if (done && onReadyToResimulate) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="network-switch-confirmed"
        className={`rounded-xl border border-green-200 bg-green-50 px-3 py-2.5 space-y-2 ${className}`}
      >
        <div className="flex items-center gap-2 text-xs font-semibold text-green-800">
          <CheckCircle2 size={14} className="text-green-600" aria-hidden="true" />
          Wallet switched — your previous transaction preview is no longer valid.
        </div>
        <button
          type="button"
          onClick={handleResimulate}
          data-testid="network-switch-resimulate-btn"
          className="inline-flex items-center gap-1.5 rounded-xl bg-green-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-green-700 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-400 focus-visible:ring-offset-1"
        >
          <RefreshCw size={11} aria-hidden="true" />
          Re-simulate transaction
        </button>
      </div>
    );
  }

  return (
    <div
      data-testid="network-switch-steps"
      className={`rounded-xl border border-red-100 bg-white/60 px-3 py-2.5 space-y-2 ${className}`}
    >
      <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-red-700">
        <List size={11} aria-hidden="true" />
        How to switch to {targetLabel}
      </p>
      <ol
        aria-label={`Steps to switch to ${targetLabel}`}
        className="space-y-1.5 pl-1"
      >
        {steps.map((step, i) => (
          <li key={i} className="flex gap-2 text-xs text-gray-700">
            <span
              className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-red-100 text-[10px] font-bold text-red-700"
              aria-hidden="true"
            >
              {i + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      {onDoneSteps && (
        <button
          type="button"
          onClick={handleDone}
          data-testid="network-switch-done-btn"
          className="mt-1 inline-flex items-center gap-1.5 rounded-xl bg-red-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-red-700 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-1"
        >
          <RefreshCw size={11} aria-hidden="true" />
          I&apos;ve switched — check now
        </button>
      )}
    </div>
  );
}

// ── WrongNetworkBanner ───────────────────────────────────────────────────────

/**
 * Convenience banner for use in WalletGuard and page-level wrong-network states.
 * Composes WalletErrorDisplay with a WRONG_NETWORK error and the NetworkSwitchPanel.
 */
export interface WrongNetworkBannerProps {
  expectedPassphrase?: string;
  detectedPassphrase?: string | null;
  provider?: WalletProviderName;
  onSwitchNetwork?: () => void;
  /** Called when user clicks "I've switched — check now" */
  onDoneSteps?: () => void;
  onReadyToResimulate?: () => void;
  isCheckingNetwork?: boolean;
  onDismiss?: (() => void) | null;
  className?: string;
}

export function WrongNetworkBanner({
  expectedPassphrase,
  detectedPassphrase,
  provider,
  onSwitchNetwork,
  onDoneSteps,
  onReadyToResimulate,
  isCheckingNetwork,
  onDismiss,
  className = "",
}: WrongNetworkBannerProps) {
  const error: WalletAdapterError = {
    kind: "WRONG_NETWORK",
    message: `Wrong network detected.`,
    expected: expectedPassphrase ?? "",
    detected: detectedPassphrase ?? null,
  };

  return (
    <WalletErrorDisplay
      error={error}
      onSwitchNetwork={onSwitchNetwork ?? onDoneSteps}
      onReadyToResimulate={onReadyToResimulate}
      isCheckingNetwork={isCheckingNetwork}
      onDismiss={onDismiss}
      provider={provider}
      autoFocusPrimary
      className={className}
    />
  );
}

// ── Compact inline variant ───────────────────────────────────────────────────

/**
 * A minimal single-line variant for use inside form fields or small spaces.
 * Shows only the title and a retry button.
 */
export function WalletErrorInline({
  error,
  onRetry,
  className = "",
}: Pick<WalletErrorDisplayProps, "error" | "onRetry" | "className">) {
  const cfg = getDisplayConfig(error, onRetry);
  const sc = SEVERITY_CLASSES[cfg.severity];

  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid="wallet-error-inline"
      className={`flex items-center gap-2 rounded-xl px-3 py-2 text-xs ${sc.wrapper} border ${className}`}
    >
      <span className={sc.icon} aria-hidden="true">
        {cfg.icon}
      </span>
      <span className={`flex-1 font-medium ${sc.body}`}>{cfg.title}</span>
      {cfg.primaryAction && (
        <button
          type="button"
          onClick={cfg.primaryAction}
          className={`ml-auto shrink-0 rounded-lg px-2 py-1 text-[11px] font-bold transition-all ${sc.primary}`}
        >
          {cfg.primaryLabel}
        </button>
      )}
    </div>
  );
}

// ── Pending transaction timeout variant ─────────────────────────────────────

/**
 * Displayed when a transaction is confirmed on-chain but the indexer
 * has not confirmed it yet (indexer_delay category).
 */
export function IndexerDelayNotice({
  txHash,
  onRefresh,
  className = "",
}: {
  txHash?: string | null;
  onRefresh?: () => void;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="indexer-delay-notice"
      className={`flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 ${className}`}
    >
      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-600">
        <Clock size={20} aria-hidden="true" />
      </div>
      <div className="flex-1">
        <p className="text-sm font-bold text-amber-900">
          Transaction Confirmed — Waiting for Indexer
        </p>
        <p className="mt-0.5 text-xs text-amber-800">
          Your transaction landed on-chain, but the marketplace indexer hasn't
          picked it up yet. This usually resolves within 30 seconds.
        </p>
        {txHash && (
          <p className="mt-1 font-mono text-[10px] text-amber-700 break-all">
            TX: {txHash}
          </p>
        )}
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            className="mt-2 inline-flex items-center gap-1.5 rounded-xl bg-amber-500 px-3 py-1.5 text-xs font-bold text-white hover:bg-amber-600 transition-all"
          >
            <RefreshCw size={11} aria-hidden="true" />
            Refresh
          </button>
        )}
      </div>
    </div>
  );
}
