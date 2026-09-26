// ─────────────────────────────────────────────────────────────
// lib/privacy.ts — Privacy utilities
//
// Centralises:
//   - Analytics consent read/write (localStorage-backed)
//   - Log field redaction (wallets, IPs, request IDs)
//   - Wallet address pseudonymisation helpers
//
// All browser-storage operations are guarded against SSR.
// ─────────────────────────────────────────────────────────────

// ── Constants ─────────────────────────────────────────────────

export const ANALYTICS_CONSENT_KEY = "elcarehub:analytics_consent";
export const AUDIT_LOG_KEY_PREFIX = "elcarehub:audit";

/**
 * Fields that must never appear in logs or telemetry.
 *
 * Kept in sync (conceptually, not code-shared — see issue #541) with the
 * indexer's forbidden-field list in `indexer/src/log-redaction.ts` and the
 * audit trail's `SENSITIVE_FIELDS` in `indexer/src/audit/audit-service.ts`.
 * If you add a field here, consider whether the indexer-side lists need the
 * same addition (and vice versa) — unifying them into a shared package is
 * out of scope for now.
 */
const REDACTED_FIELDS = new Set([
  "authorization",
  "cookie",
  "x-api-key",
  "private_key",
  "privatekey",
  "secret",
  "mnemonic",
  "seed",
  "signature",
  "sig",
  "jwt",
  "token",
  "password",
  "passwd",
]);

// ── Consent ───────────────────────────────────────────────────

export type AnalyticsConsent = "granted" | "denied" | "unset";

/** Read the stored consent value. Returns "unset" outside the browser. */
export function getAnalyticsConsent(): AnalyticsConsent {
  if (typeof window === "undefined") return "unset";
  const v = localStorage.getItem(ANALYTICS_CONSENT_KEY);
  if (v === "granted" || v === "denied") return v;
  return "unset";
}

/** Persist consent and apply it to PostHog immediately if loaded. */
export function setAnalyticsConsent(value: "granted" | "denied"): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(ANALYTICS_CONSENT_KEY, value);

  // Apply to PostHog at runtime without requiring a re-import cycle.
  // posthog-js exposes a global `window.posthog` when initialised.
  const ph = (window as any).posthog;
  if (!ph) return;
  if (value === "denied") {
    ph.opt_out_capturing();
  } else {
    ph.opt_in_capturing();
  }
}

/** True if analytics may fire for this session. */
export function isAnalyticsAllowed(): boolean {
  return getAnalyticsConsent() === "granted";
}

// ── Wallet pseudonymisation ───────────────────────────────────

/**
 * Returns the first 4 and last 4 characters of a Stellar public key.
 * Safe to include in logs and analytics — not reversible to the full key.
 *
 * e.g. "GCAT…ZXAB"
 */
export function pseudonymiseAddress(address: string): string {
  if (!address || address.length < 12) return "[address]";
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/**
 * Returns only the first 8 characters — suitable for high-cardinality
 * log fields where even the suffix adds unnecessary specificity.
 */
export function shortAddress(address: string): string {
  if (!address || address.length < 8) return "[address]";
  return `${address.slice(0, 8)}…`;
}

// ── Log redaction ─────────────────────────────────────────────

type LogRecord = Record<string, unknown>;

/**
 * Recursively scrubs keys in `REDACTED_FIELDS` from an object,
 * replacing their values with `"[REDACTED]"`.
 *
 * - Does not mutate the original object (returns a new object).
 * - Handles nested objects one level deep.
 * - Arrays are left untouched (their items are not traversed).
 */
export function redactSensitiveFields(obj: LogRecord): LogRecord {
  const out: LogRecord = {};
  for (const [k, v] of Object.entries(obj)) {
    if (REDACTED_FIELDS.has(k.toLowerCase())) {
      out[k] = "[REDACTED]";
    } else if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      out[k] = redactSensitiveFields(v as LogRecord);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Scrubs full Stellar public keys (G…, 56 chars) from a string,
 * replacing them with their pseudonymised form.
 *
 * Use on free-text log messages before writing to external sinks.
 */
export function redactAddressesFromString(message: string): string {
  // Stellar ed25519 public keys: G followed by 55 base32 characters
  return message.replace(/\bG[A-Z2-7]{55}\b/g, (addr) =>
    pseudonymiseAddress(addr)
  );
}
