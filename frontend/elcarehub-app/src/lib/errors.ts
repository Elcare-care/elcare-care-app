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

export function getReadableErrorMessage(
  error: unknown,
  fallback = "Something went wrong. Please try again."
): string {
  if (error instanceof Error) {
    const mapped = mapSorobanErrorMessage(error.message);
    return mapped ?? error.message ?? fallback;
  }
  if (typeof error === "string") {
    const mapped = mapSorobanErrorMessage(error);
    return mapped ?? error;
  }
  return fallback;
}
