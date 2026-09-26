/**
 * lib/wallet-telemetry.ts
 *
 * Structured wallet failure analytics via PostHog.
 *
 * All wallet-related events are funnelled through this module so:
 *   - Event names are consistent and never typo'd across components
 *   - Properties are fully typed — no ad-hoc `any` objects in call sites
 *   - PII scrubbing is centralised (public keys are truncated)
 *   - Future changes to the analytics provider touch only this file
 *
 * Usage:
 *   import { walletTelemetry } from "@/lib/wallet-telemetry";
 *   walletTelemetry.connectionError("freighter", error);
 *   walletTelemetry.signingRejected("lobstr");
 */

import posthog from "posthog-js";
import type { WalletAdapterError, WalletAdapterType } from "@/lib/wallet-adapter";
import type { TxErrorCategory } from "@/hooks/useTxLifecycle";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Truncate a Stellar public key to a safe non-PII form for analytics. */
function truncatePubkey(key: string | null | undefined): string | null {
  if (!key || key.length < 10) return null;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

/** Safely extract a string from any thrown value. */
function errMsg(raw: unknown): string {
  if (raw instanceof Error) return raw.message.slice(0, 200);
  if (typeof raw === "string") return raw.slice(0, 200);
  return "unknown";
}

// ── Guard: only capture when PostHog is initialised ───────────────────────────

function capture(event: string, props: Record<string, unknown>): void {
  try {
    posthog.capture(event, props);
  } catch {
    // PostHog may not be initialised in SSR / test environments — swallow silently
  }
}

// ── Connection events ─────────────────────────────────────────────────────────

/**
 * Fired when wallet connection fails with a typed error.
 * Covers NOT_INSTALLED, USER_REJECTED, WRONG_NETWORK, ACCOUNT_UNAVAILABLE,
 * SIGN_FAILED, PROVIDER_CONFLICT, UNKNOWN.
 */
function connectionError(
  provider: WalletAdapterType | string,
  error: WalletAdapterError
): void {
  capture("wallet_connection_error", {
    provider,
    error_kind:    error.kind,
    error_message: error.kind === "WRONG_NETWORK"
      ? `expected=${error.expected} detected=${error.detected ?? "unknown"}`
      : ("message" in error ? errMsg(error.message) : ""),
  });
}

/**
 * Fired when a wallet successfully connects.
 */
function connected(
  provider: WalletAdapterType | string,
  publicKey: string | null,
  surface: "connect_modal" | "onboarding" | "guard" | "auto_reconnect"
): void {
  capture("wallet_connected", {
    provider,
    public_key_prefix: truncatePubkey(publicKey),
    surface,
  });
}

/**
 * Fired when a user abandons the connection modal without completing.
 */
function connectionAbandoned(
  provider: WalletAdapterType | string | "none",
  step: string
): void {
  capture("wallet_connection_abandoned", { provider, step });
}

/**
 * Fired when auto-reconnect on page load fails.
 */
function autoReconnectFailed(
  provider: WalletAdapterType | string,
  raw: unknown
): void {
  capture("wallet_auto_reconnect_failed", {
    provider,
    error_message: errMsg(raw),
  });
}

// ── Network events ────────────────────────────────────────────────────────────

/**
 * Fired every time a WRONG_NETWORK error is shown (connection or preflight).
 */
function wrongNetwork(
  provider: WalletAdapterType | string,
  expected: string,
  detected: string | null
): void {
  capture("wallet_wrong_network", { provider, expected, detected });
}

// ── Signing / transaction events ──────────────────────────────────────────────

/**
 * Fired when the user rejects a signing request in their wallet.
 */
function signingRejected(
  provider: WalletAdapterType | string,
  action: string
): void {
  capture("wallet_signing_rejected", { provider, action });
}

/**
 * Fired when a transaction fails after signing.
 */
function transactionFailed(
  category: TxErrorCategory,
  action: string,
  raw: unknown
): void {
  capture("wallet_transaction_failed", {
    category,
    action,
    error_message: errMsg(raw),
  });
}

/**
 * Fired when indexer confirmation takes longer than the configured timeout.
 */
function indexerConfirmTimeout(
  txHash: string | null,
  action: string,
  waitedMs: number
): void {
  capture("wallet_indexer_confirm_timeout", {
    tx_hash_prefix: txHash ? txHash.slice(0, 12) : null,
    action,
    waited_ms: waitedMs,
  });
}

/**
 * Fired when the transaction intent re-derived immediately before signing
 * (Issue #536) does not match the intent that was rendered in the
 * confirmation UI moments earlier. Signing is aborted whenever this fires.
 *
 * The payload intentionally carries only field *names* that mismatched and
 * the method/contract/network involved — never the full argument values —
 * so this is safe to send even though the underlying mismatch could in
 * theory be adversarial. Method, contract id, and network passphrase are
 * public transaction parameters (they are not secrets), so including them
 * is fine for diagnosis; no wallet secrets are ever touched by this path.
 */
function txIntentMismatch(
  context: string,
  method: string,
  contractId: string,
  mismatchedFields: string[]
): void {
  capture("tx_intent_mismatch", {
    context,
    method,
    contract_id: contractId,
    mismatched_fields: mismatchedFields,
  });
}

/**
 * Fired when a transaction succeeds end-to-end.
 */
function transactionSuccess(
  action: string,
  provider: WalletAdapterType | string,
  txHash: string | null
): void {
  capture("wallet_transaction_success", {
    action,
    provider,
    tx_hash_prefix: txHash ? txHash.slice(0, 12) : null,
  });
}

// ── Onboarding events ─────────────────────────────────────────────────────────

function onboardingStepViewed(stepId: string, stepIndex: number): void {
  capture("onboarding_step_viewed", { step_id: stepId, step_index: stepIndex });
}

function onboardingCompleted(provider: WalletAdapterType | string | "none"): void {
  capture("onboarding_completed", { provider });
}

function onboardingSkipped(lastStepId: string): void {
  capture("onboarding_skipped", { last_step_id: lastStepId });
}

// ── Named export ──────────────────────────────────────────────────────────────

export const walletTelemetry = {
  // connection
  connectionError,
  connected,
  connectionAbandoned,
  autoReconnectFailed,
  // network
  wrongNetwork,
  // signing / tx
  signingRejected,
  transactionFailed,
  txIntentMismatch,
  indexerConfirmTimeout,
  transactionSuccess,
  // onboarding
  onboardingStepViewed,
  onboardingCompleted,
  onboardingSkipped,
} as const;
