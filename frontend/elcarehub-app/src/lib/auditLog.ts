/**
 * lib/auditLog.ts
 *
 * Lightweight client-side audit log persisted to sessionStorage.
 *
 * - Entries are appended via `appendAuditEntry` and read via `getAuditEntries`.
 * - On QuotaExceededError the oldest half of the log is evicted and the write
 *   is retried once; if storage is still full the write is silently dropped
 *   (#807).
 * - The log is scoped to the current browser session (cleared on tab close).
 */

const KEY = 'elcarehub:auditLog';

export interface AuditEntry {
  timestamp: string; // ISO-8601
  action: string;
  details?: Record<string, unknown>;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function load(): AuditEntry[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return [];
    return JSON.parse(raw) as AuditEntry[];
  } catch {
    return [];
  }
}

function save(entries: AuditEntry[]): void {
  // Fix #807: wrap setItem in try/catch; on QuotaExceededError evict the oldest
  // half of log entries and retry once. If the retry also fails, give up silently.
  try {
    sessionStorage.setItem(KEY, JSON.stringify(entries));
  } catch (e) {
    if (e instanceof DOMException && e.name === 'QuotaExceededError') {
      // Evict oldest half of entries and retry once
      const trimmed = entries.slice(Math.ceil(entries.length / 2));
      try {
        sessionStorage.setItem(KEY, JSON.stringify(trimmed));
      } catch {
        // Storage still full — silently give up
      }
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Append a new entry to the session-scoped audit log.
 * The timestamp is set automatically to the current UTC time.
 */
export function appendAuditEntry(
  action: string,
  details?: Record<string, unknown>,
): void {
  const entries = load();
  entries.push({
    timestamp: new Date().toISOString(),
    action,
    details,
  });
  save(entries);
}

/**
 * Return all entries currently in the session audit log.
 * Returns an empty array if nothing has been logged yet.
 */
export function getAuditEntries(): AuditEntry[] {
  return load();
}

/**
 * Clear all entries from the session audit log.
 */
export function clearAuditLog(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Ignore — storage may be unavailable (e.g. private browsing in some browsers)
  }
}
