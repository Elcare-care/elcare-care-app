/**
 * wallet-privacy.ts
 *
 * Helpers for pseudonymising Stellar wallet addresses in analytics exports,
 * debug logs, and CSV outputs. Addresses are public on-chain data and are
 * stored in full in canonical tables; these helpers are used at the
 * *presentation* layer (log lines, CSV, analytics) to avoid surfacing
 * addresses in contexts where they are incidental rather than essential.
 *
 * Policy reference: docs/retention-archival.md §"Wallet data — retention
 * classes", docs/PRIVACY_POLICY.md §2.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Pseudonymisation format (consistent with privacy policy §2):
 *
 *   GBFUNHEQOVN35LFEKP7SZXFYJPMJ3WLXLX4PQZGBK737NTLRHOKVES3F
 *   → GBFU…ES3F
 *
 * The first 4 and last 4 characters are preserved. This is sufficient for a
 * human to recognise a known address from a list; it is not sufficient to
 * reconstruct the full key.
 *
 * NOTE: Stellar *secret* keys (S…) are always fully redacted by
 * `log-redaction.ts` and `redact.ts` and must never reach this layer.
 * ──────────────────────────────────────────────────────────────────────────────
 */

/** Minimum length of a Stellar public key (G/C prefix + 55 base32 chars). */
const STELLAR_PUBLIC_KEY_MIN_LEN = 56;

/**
 * Returns a pseudonymised form of a Stellar public key: first 4 chars +
 * `…` + last 4 chars.
 *
 * - If the value is null/undefined/empty, returns it unchanged.
 * - If the value is shorter than the minimum key length it is returned
 *   unchanged to avoid producing a confusing `AB…CD` for a short string.
 * - Non-string values are returned as-is.
 */
export function pseudonymizeWallet(address: string | null | undefined): string | null | undefined {
  if (!address) return address;
  if (typeof address !== 'string') return address;
  if (address.length < STELLAR_PUBLIC_KEY_MIN_LEN) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/**
 * Pseudonymises a wallet address in debug-log contexts where the address is
 * incidental (not the subject of the log event).
 *
 * When the log level is `info` or higher — normal production operation —
 * addresses are kept in full so operators can correlate log lines with
 * on-chain data. At `debug` level (local dev / verbose CI) the address is
 * pseudonymised to limit exposure.
 *
 * Usage:
 *   logger.debug('processing event', { actor: maybeRedactWallet(actor) });
 *
 * For audit logs where the address IS the subject of the operation (e.g. an
 * auth denial for a specific wallet), use the full address — the logging
 * policy explicitly allows wallet public keys in auth audit lines.
 */
export function maybeRedactWallet(
  address: string | null | undefined,
  logLevel: string = process.env.LOG_LEVEL ?? 'info',
): string | null | undefined {
  const level = logLevel.toLowerCase();
  if (level === 'debug' || level === 'trace') {
    return pseudonymizeWallet(address);
  }
  return address;
}

/**
 * Pseudonymises all wallet-like string values inside a plain key-value object.
 * Used for analytics CSV export rows to scrub any address fields before the
 * output leaves the service boundary.
 *
 * Only top-level string values that look like Stellar public keys
 * (`G`/`C` followed by 55 base32 characters) are pseudonymised; nested
 * objects, numbers, booleans, and non-key strings are left unchanged.
 *
 * @param row  A record of column-name → value (as produced by Prisma select).
 * @returns    A shallow copy of `row` with address values pseudonymised.
 */
export function pseudonymizeRow<T extends Record<string, unknown>>(row: T): T {
  const out = { ...row } as T;
  for (const key of Object.keys(out) as Array<keyof T>) {
    const value = out[key];
    if (typeof value === 'string' && looksLikeStellarPublicKey(value)) {
      (out as Record<string, unknown>)[key as string] = pseudonymizeWallet(value);
    }
  }
  return out;
}

/**
 * Returns true when the string looks like a Stellar public key
 * (starts with G or C, exactly 56 chars, base32 alphabet).
 */
export function looksLikeStellarPublicKey(value: string): boolean {
  if (value.length !== 56) return false;
  if (value[0] !== 'G' && value[0] !== 'C') return false;
  return /^[A-Z2-7]{56}$/.test(value);
}

/**
 * Pseudonymises wallet address fields that are known to appear in
 * `MarketplaceEvent.data` JSON payloads. Used before any debug-level log
 * line that serialises a raw event data blob.
 *
 * Known wallet-bearing JSON paths in event data:
 *   buyer, artist, offerer, bidder, winner, creator, recipient
 *
 * Returns a shallow-cloned object; the original is not modified.
 */
const EVENT_DATA_WALLET_KEYS = [
  'buyer', 'artist', 'offerer', 'bidder', 'winner', 'creator', 'recipient',
] as const;

export function pseudonymizeEventData(
  data: Record<string, unknown> | null | undefined,
  logLevel: string = process.env.LOG_LEVEL ?? 'info',
): Record<string, unknown> | null | undefined {
  if (!data) return data;
  const level = logLevel.toLowerCase();
  if (level !== 'debug' && level !== 'trace') return data;

  const out = { ...data };
  for (const key of EVENT_DATA_WALLET_KEYS) {
    if (typeof out[key] === 'string') {
      out[key] = pseudonymizeWallet(out[key] as string);
    }
  }
  return out;
}
