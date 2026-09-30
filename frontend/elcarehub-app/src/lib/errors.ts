import { CONTRACT_ERROR_CATALOG } from "./contractErrors/catalog";

/**
 * Flat code → message map for the marketplace contract, derived from the
 * authoritative catalog in lib/contractErrors/catalog.ts so this file can't
 * silently drift out of sync with it (a prior hand-maintained copy of this
 * map had codes 22-24 mapped to the wrong messages after the contract's
 * error enum grew past 24 variants). New code should prefer
 * `decodeContractError` directly; this is kept for existing callers of
 * `getReadableErrorMessage` / `mapSorobanErrorMessage`.
 */
export const SOROBAN_ERROR_MESSAGES: Record<number, string> = Object.fromEntries(
  CONTRACT_ERROR_CATALOG.marketplace.map((def) => [def.code, def.message])
);

/**
 * Phrases that indicate the user cancelled signing in their wallet extension.
 * Checked case-insensitively against the raw error message string.
 */
const USER_REJECTION_PHRASES: string[] = [
  "user rejected",
  "user denied",
  "user cancelled",
  "user canceled",
  "rejected by user",
  "transaction was rejected",
  "sign request was rejected",
  "request rejected",
];

/**
 * Returns true when the error was caused by the user explicitly declining
 * the signing request in their wallet (Freighter, LOBSTR, etc.).
 */
export function isUserRejectionError(error: unknown): boolean {
  const msg =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const lower = msg.toLowerCase();
  return USER_REJECTION_PHRASES.some((phrase) => lower.includes(phrase));
}

const CONTRACT_CODE_PATTERNS: RegExp[] = [
  /Error\(Contract,\s*#(\d+)\)/i,
  /Contract(?:Error)?[^\d#]*(?:#|code[:=\s])\s*(\d+)/i,
  /"contractCode"\s*:\s*(\d+)/i,
];

export function extractSorobanContractCode(raw: string): number | null {
  for (const pattern of CONTRACT_CODE_PATTERNS) {
    const match = raw.match(pattern);
    if (match?.[1]) {
      const parsed = Number.parseInt(match[1], 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

export function mapSorobanErrorMessage(raw: string): string | null {
  const code = extractSorobanContractCode(raw);
  if (code === null) return null;
  const mapped = SOROBAN_ERROR_MESSAGES[code];
  return mapped ? `${mapped} (code ${code})` : null;
}

/**
 * Default user-facing fallback message used by `getReadableErrorMessage` and
 * any UI component that needs a generic error string. Centralised here so
 * copy changes only need to happen in one place.
 */
export const DEFAULT_ERROR_MESSAGE = "Something went wrong. Please try again.";

export function getReadableErrorMessage(
  error: unknown,
  fallback = DEFAULT_ERROR_MESSAGE
): string {
  if (error instanceof Error) {
    const mapped = mapSorobanErrorMessage(error.message);
    return mapped ?? (error.message || fallback);
  }
  if (typeof error === "string") {
    const mapped = mapSorobanErrorMessage(error);
    return mapped ?? error;
  }
  return fallback;
}

/**
 * Returns true when the error represents a network-level failure — i.e. the
 * request never received an HTTP response (no connectivity, DNS failure, CORS
 * block, request timeout, etc.). Distinct from `isServerError`, which
 * indicates the server responded with a 5xx status.
 *
 * Only recognises Axios errors. All other values (plain Error, string,
 * unknown) return false.
 */
export function isNetworkError(err: unknown): boolean {
  return (
    isAxiosError(err) &&
    err.response === undefined &&
    err.request !== undefined
  );
}

/**
 * Returns true when the error is an Axios error with an HTTP response whose
 * status code is 500 or higher (server-side error). These warrant a "try
 * again later" UI message, distinct from network errors ("check your
 * connection") and 4xx client errors (actionable by the user).
 *
 * Only recognises Axios errors. All other values return false.
 */
export function isServerError(err: unknown): boolean {
  return isAxiosError(err) && (err.response?.status ?? 0) >= 500;
}

// ── Internal Axios type guard ─────────────────────────────────

/** Lightweight type guard that identifies Axios errors without importing axios. */
interface AxiosLikeError {
  isAxiosError: true;
  response?: { status: number };
  request?: unknown;
}

function isAxiosError(err: unknown): err is AxiosLikeError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as Record<string, unknown>).isAxiosError === true
  );
}

/**
 * Structured logger for React error boundaries.
 *
 * Call this inside a class component's `componentDidCatch` to produce a
 * consistent, searchable log entry that includes both the error details and
 * the React component stack. Using a centralised helper means every error
 * boundary in the app emits the same shape, making log aggregation and
 * alerting rules straightforward.
 *
 * @param error - The Error object caught by the boundary.
 * @param info  - The React ErrorInfo object containing `componentStack`.
 */
export function onErrorBoundary(
  error: Error,
  info: { componentStack: string }
): void {
  console.error("[ErrorBoundary]", {
    error: error.message,
    stack: error.stack,
    componentStack: info.componentStack,
  });
}
