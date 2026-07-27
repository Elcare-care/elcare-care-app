// ─────────────────────────────────────────────────────────────
// lib/auditLog.ts — Privacy-conscious admin audit event emitter
//
// Every privileged UI action (moderation, token whitelist, pause,
// admin transfer, fee change, session lifecycle) emits a structured
// audit record that is:
//
//   - Stored in sessionStorage for the current admin session
//   - Forwarded to the Sentry "admin_audit" breadcrumb trail
//   - Never includes: private keys, signatures, raw payloads,
//     full wallet addresses (only pseudonymised prefixes)
//
// The record is intentionally minimal. It answers:
//   WHO (pseudonymised admin prefix) took WHAT ACTION on WHICH TARGET,
//   in WHICH ENVIRONMENT, with WHAT OUTCOME (success/rejected/failed),
//   and can be linked to WHICH transaction hash.
// ─────────────────────────────────────────────────────────────

import { pseudonymiseAddress, redactSensitiveFields } from "./privacy";

// ── Event catalogue ───────────────────────────────────────────

export type AuditAction =
  // Artist moderation
  | "artist.revoke"
  | "artist.reinstate"
  | "artist.status_check"
  // Token whitelist
  | "token.whitelist_add"
  | "token.whitelist_remove"
  // Circuit breaker
  | "pause.global_enable"
  | "pause.global_disable"
  | "pause.function_enable"
  | "pause.function_disable"
  | "pause.collection_enable"
  | "pause.collection_disable"
  // Admin key rotation
  | "admin.transfer_propose"
  | "admin.transfer_accept"
  | "admin.transfer_cancel"
  // Fee management
  | "fee.collection_set"
  | "fee.collection_clear"
  // Session lifecycle
  | "session.start"
  | "session.end"
  | "session.expired";

export type AuditOutcome = "success" | "rejected" | "failed" | "initiated";

export interface AuditEvent {
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Low-cardinality action name. */
  action: AuditAction;
  /** Pseudonymised admin address (first 4 + last 4 chars). */
  adminPrefix: string;
  /** Outcome of the action. */
  outcome: AuditOutcome;
  /** Target resource (pseudonymised address, function name, token prefix, etc.). */
  target?: string;
  /** On-chain transaction hash if available. */
  txHash?: string;
  /** Contract ID the action was directed at. */
  contractId?: string;
  /** Stellar network (testnet / mainnet). */
  network?: string;
  /** Human-readable detail — must not contain keys, signatures, or secrets. */
  detail?: string;
  /** Error message when outcome is "failed" or "rejected". */
  errorMessage?: string;
}

// ── Storage ───────────────────────────────────────────────────

const SESSION_STORAGE_KEY = "elcarehub:audit_log";
const MAX_EVENTS = 200; // cap to avoid unbounded growth within a session

function loadSessionLog(): AuditEvent[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AuditEvent[]) : [];
  } catch {
    return [];
  }
}

function saveSessionLog(events: AuditEvent[]): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(events));
  } catch {
    // sessionStorage full — trim oldest half and retry
    try {
      const trimmed = events.slice(-Math.floor(MAX_EVENTS / 2));
      sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(trimmed));
    } catch {
      /* give up silently */
    }
  }
}

// ── Core emitter ──────────────────────────────────────────────

/**
 * Emit a structured audit event.
 *
 * @param action   - The audit action name from the catalogue.
 * @param adminKey - The connected admin wallet's public key. Will be pseudonymised.
 * @param outcome  - Result of the action.
 * @param extras   - Optional additional context (target, txHash, errorMessage, etc.).
 *                   All values are passed through `redactSensitiveFields`.
 */
export function emitAuditEvent(
  action: AuditAction,
  adminKey: string | null,
  outcome: AuditOutcome,
  extras: Partial<
    Pick<AuditEvent, "target" | "txHash" | "contractId" | "network" | "detail" | "errorMessage">
  > = {}
): void {
  // Sanitise extras — never forward raw secrets
  const safeExtras = redactSensitiveFields(
    extras as Record<string, unknown>
  ) as typeof extras;

  const event: AuditEvent = {
    timestamp: new Date().toISOString(),
    action,
    adminPrefix: adminKey ? pseudonymiseAddress(adminKey) : "[unknown]",
    outcome,
    ...safeExtras,
  };

  // 1. Persist to sessionStorage for the current admin session
  const log = loadSessionLog();
  log.push(event);
  // Keep only the most recent MAX_EVENTS entries
  saveSessionLog(log.slice(-MAX_EVENTS));

  // 2. Forward to Sentry as a breadcrumb (no PII beyond the prefix)
  if (typeof window !== "undefined") {
    import("@sentry/nextjs")
      .then((Sentry) => {
        Sentry.addBreadcrumb({
          category: "admin_audit",
          message: `${action} → ${outcome}`,
          level: outcome === "failed" ? "error" : outcome === "rejected" ? "warning" : "info",
          data: {
            action,
            adminPrefix: event.adminPrefix,
            outcome,
            target: event.target,
            txHash: event.txHash,
            contractId: event.contractId,
            network: event.network,
          },
        });
      })
      .catch(() => {
        /* Sentry not loaded — silent fallback */
      });
  }

  // 3. Console output in development only (structured, no secrets)
  if (process.env.NODE_ENV === "development") {
    const style =
      outcome === "failed"
        ? "color: red"
        : outcome === "rejected"
        ? "color: orange"
        : "color: green";
    // eslint-disable-next-line no-console
    console.groupCollapsed(
      `%c[AuditLog] ${event.timestamp} ${action} → ${outcome}`,
      style
    );
    // eslint-disable-next-line no-console
    console.table({ adminPrefix: event.adminPrefix, target: event.target, txHash: event.txHash });
    // eslint-disable-next-line no-console
    console.groupEnd();
  }
}

// ── Session log accessors ─────────────────────────────────────

/** Return all audit events recorded in the current session. */
export function getSessionAuditLog(): AuditEvent[] {
  return loadSessionLog();
}

/** Clear the session audit log (called on session end/logout). */
export function clearSessionAuditLog(): void {
  if (typeof window !== "undefined") {
    try {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
}

// ── Explorer link helper ──────────────────────────────────────

/**
 * Returns a Stellar Expert or Stellar.org explorer link for a transaction hash.
 * Used by the admin UI to link audit records to the on-chain outcome.
 */
export function explorerTxUrl(txHash: string, network: string = "testnet"): string {
  const base =
    network === "mainnet"
      ? "https://stellar.expert/explorer/public/tx"
      : "https://stellar.expert/explorer/testnet/tx";
  return `${base}/${txHash}`;
}
