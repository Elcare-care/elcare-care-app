/**
 * lib/wallet-adapter.ts — Unified wallet adapter interface (Issue #304)
 *
 * Defines the normalized WalletAdapter interface that all wallet providers
 * (Freighter, Lobstr, Magic) must implement, plus:
 *
 *  - WalletCapabilities: explicit feature flags per provider
 *  - WalletAdapterError: normalized, actionable error types
 *  - normalizeWalletError: maps raw provider errors to WalletAdapterError
 */

// ── Capability flags ─────────────────────────────────────────────────────────

/**
 * Explicit capability flags for each wallet provider.
 * Pages should check capabilities before calling optional operations
 * rather than branching on provider type.
 */
export interface WalletCapabilities {
  /** Provider supports programmatic account change detection via events */
  canDetectAccountChange: boolean;
  /** Provider supports programmatic network change detection via events */
  canDetectNetworkChange: boolean;
  /** Provider can report the network passphrase */
  canReportNetwork: boolean;
  /** Provider supports passkey-based authentication (Magic only) */
  canUsePasskey: boolean;
  /** Provider supports email-based authentication (Magic only) */
  canUseEmail: boolean;
  /** Provider is a browser extension (Freighter, Lobstr) */
  isExtension: boolean;
  /** Provider requires explicit disconnect (vs. session expiry) */
  requiresExplicitDisconnect: boolean;
}

// ── Normalized error types ───────────────────────────────────────────────────

/**
 * Discriminated union of every error category a wallet adapter can produce.
 * Each variant carries a `message` for display and optional `cause` for
 * logging. Callers can switch on `kind` to take provider-agnostic action.
 */
export type WalletAdapterError =
  | { kind: "NOT_INSTALLED";       message: string; cause?: unknown }
  | { kind: "USER_REJECTED";       message: string; cause?: unknown }
  | { kind: "WRONG_NETWORK";       message: string; expected: string; detected: string | null }
  | { kind: "ACCOUNT_UNAVAILABLE"; message: string; cause?: unknown }
  | { kind: "SIGN_FAILED";         message: string; cause?: unknown }
  | { kind: "UNSUPPORTED_CAPABILITY"; message: string; capability: keyof WalletCapabilities }
  | { kind: "PROVIDER_CONFLICT";   message: string; cause?: unknown }
  | { kind: "UNKNOWN";             message: string; cause?: unknown };

/** Phrases that indicate the user explicitly rejected a request */
const USER_REJECTION_PHRASES = [
  "user rejected",
  "user denied",
  "user cancelled",
  "user canceled",
  "rejected by user",
  "transaction was rejected",
  "sign request was rejected",
  "request rejected",
  "declined",
] as const;

/** Phrases that indicate the extension is not installed */
const NOT_INSTALLED_PHRASES = [
  "freighter is not installed",
  "freighter not found",
  "lobstr wallet not found",
  "no provider",
  "wallet not installed",
] as const;

/**
 * Normalize a raw provider error (any shape) into a typed WalletAdapterError.
 *
 * @param raw      - The caught error from any wallet provider call
 * @param expected - The configured network passphrase (for WRONG_NETWORK detection)
 */
export function normalizeWalletError(
  raw: unknown,
  expected?: string
): WalletAdapterError {
  const msg =
    raw instanceof Error
      ? raw.message
      : typeof raw === "string"
      ? raw
      : "Unknown wallet error";

  const lower = msg.toLowerCase();

  if (NOT_INSTALLED_PHRASES.some((p) => lower.includes(p))) {
    return { kind: "NOT_INSTALLED", message: "Wallet extension is not installed.", cause: raw };
  }

  if (USER_REJECTION_PHRASES.some((p) => lower.includes(p))) {
    return { kind: "USER_REJECTED", message: "You declined the request in your wallet.", cause: raw };
  }

  // Network mismatch: look for passphrase-shaped strings differing from expected
  if (expected && lower.includes("network") && lower.includes("passphrase")) {
    // Try to extract the detected passphrase from the message
    const detected = extractNetworkPassphrase(msg);
    return {
      kind: "WRONG_NETWORK",
      message: `Your wallet is connected to the wrong network. Switch to "${expected}".`,
      expected,
      detected,
    };
  }

  if (lower.includes("account") && (lower.includes("unavailable") || lower.includes("not found"))) {
    return { kind: "ACCOUNT_UNAVAILABLE", message: "Wallet account is unavailable.", cause: raw };
  }

  if (lower.includes("sign") || lower.includes("xdr")) {
    return { kind: "SIGN_FAILED", message: "Transaction signing failed.", cause: raw };
  }

  return { kind: "UNKNOWN", message: msg, cause: raw };
}

/**
 * Create an UNSUPPORTED_CAPABILITY error for when a page tries to use a
 * feature the active wallet does not support.
 */
export function unsupportedCapabilityError(
  capability: keyof WalletCapabilities,
  providerName: string
): WalletAdapterError {
  return {
    kind: "UNSUPPORTED_CAPABILITY",
    message: `The "${providerName}" wallet does not support ${capability}.`,
    capability,
  };
}

/**
 * Create a WRONG_NETWORK error with explicit expected/detected names.
 */
export function wrongNetworkError(expected: string, detected: string | null): WalletAdapterError {
  const detectedLabel = detected ? `"${detected}"` : "an unknown network";
  return {
    kind: "WRONG_NETWORK",
    message: `Wallet is connected to ${detectedLabel}. Please switch to "${expected}".`,
    expected,
    detected,
  };
}

/** Attempt to extract the passphrase portion from an error message string */
function extractNetworkPassphrase(msg: string): string | null {
  // Look for patterns like: 'expected "Test SDF..." but got "..."'
  const quoted = msg.match(/"([^"]{10,80})"/g);
  if (quoted && quoted.length > 1) {
    return quoted[quoted.length - 1].replace(/^"|"$/g, "");
  }
  return null;
}

// ── Core adapter interface ───────────────────────────────────────────────────

/**
 * Unified wallet adapter interface.
 *
 * All wallet providers implement this contract so that pages and hooks
 * can depend on a single normalized API without provider-specific branches.
 */
export interface WalletAdapter {
  /** Display name for this provider (e.g. "Freighter", "LOBSTR", "Magic") */
  readonly name: string;

  /** Explicit capability flags — check before calling optional operations */
  readonly capabilities: WalletCapabilities;

  // ── Connection state ─────────────────────────────────────────────────
  readonly isConnected: boolean;
  readonly isConnecting: boolean;
  readonly publicKey: string | null;
  readonly networkPassphrase: string | null;

  /** Normalized error — null when no error */
  readonly error: WalletAdapterError | null;

  // ── Operations ───────────────────────────────────────────────────────

  /** Initiate connection. Throws WalletAdapterError on failure. */
  connect(): Promise<void>;

  /**
   * Disconnect and clear sensitive state (keys, tokens) from memory and
   * any persistence layer. Must always resolve (never throw).
   */
  disconnect(): void | Promise<void>;

  /**
   * Sign an XDR-encoded transaction.
   * @throws WalletAdapterError on user rejection or signing failure
   */
  signTransaction(xdr: string, networkPassphrase?: string): Promise<string>;

  /**
   * Register a callback for account changes.
   * Returns an unsubscribe function, or null if not supported.
   */
  onAccountChange?: (cb: (publicKey: string | null) => void) => (() => void) | null;

  /**
   * Register a callback for network changes.
   * Returns an unsubscribe function, or null if not supported.
   */
  onNetworkChange?: (cb: (passphrase: string | null) => void) => (() => void) | null;
}

export type WalletAdapterType = "freighter" | "lobstr" | "magic";
