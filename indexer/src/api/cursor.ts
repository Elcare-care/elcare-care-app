/**
 * cursor.ts
 *
 * Opaque, tamper-proof cursor for deterministic forward pagination under
 * concurrent ingestion.
 *
 * ── Design ────────────────────────────────────────────────────────────────────
 *
 * A cursor encodes two stable sort-key dimensions:
 *
 *   ledger  — ledgerSequence / updatedAtLedger / deployedAtLedger (the
 *             primary sort key, common across all list endpoints)
 *   id      — the row's integer primary key as a tiebreaker when multiple
 *             rows share the same ledger sequence (e.g. a backfill inserts
 *             many events in one ledger)
 *
 * The cursor is serialised as a base64-url encoded JSON envelope:
 *
 *   { v: 1, l: <ledger>, i: <id>, e: "<endpoint-tag>", s: "<hmac-hex>" }
 *
 * The HMAC-SHA-256 signature (key = CURSOR_SECRET env var or a stable default
 * for test environments) covers `v`, `l`, `i`, and `e`.  Any tampering —
 * including changing the endpoint tag to re-use a cursor on a different
 * endpoint — produces a signature mismatch and the cursor is rejected with a
 * 400 BAD_REQUEST.
 *
 * ── Endpoint tags ─────────────────────────────────────────────────────────────
 *
 * Each list endpoint registers a stable tag.  A cursor issued for `/listings`
 * cannot be used on `/auctions` — the endpoint tag is part of the HMAC input
 * so the signature won't verify.
 *
 * ── Backwards compatibility ───────────────────────────────────────────────────
 *
 * Legacy plain-integer cursors (the current `cursor_ledger` param) continue to
 * work: `decodeCursor()` detects an integer string and returns a plain ledger
 * cursor without an id tiebreaker.  This lets existing clients migrate
 * incrementally.
 *
 * ── Environment ───────────────────────────────────────────────────────────────
 *
 *   CURSOR_SECRET  — 32+ char secret for HMAC signing.  Required in production.
 *                    Falls back to a hard-coded test secret in non-production
 *                    environments so unit tests don't need env configuration.
 */

import { createHmac } from 'node:crypto';
import { badRequest } from './errors.js';
import type { ApiError } from './errors.js';

// ── Endpoint tags ─────────────────────────────────────────────────────────────

export const CursorEndpoint = {
  LISTINGS:             'lst',
  AUCTIONS:             'auc',
  OFFERS:               'off',
  COLLECTIONS:          'col',
  CREATOR_COLLECTIONS:  'crc',
  WALLET_ACTIVITY:      'wac',
  ROYALTIES:            'roy',
} as const;

export type CursorEndpoint = (typeof CursorEndpoint)[keyof typeof CursorEndpoint];

// ── Internal types ─────────────────────────────────────────────────────────────

interface CursorPayload {
  v: 1;          // schema version
  l: number;     // ledger sequence (sort key)
  i: number;     // row id (tiebreaker)
  e: string;     // endpoint tag
}

export interface DecodedCursor {
  ledger: number;
  id: number;
  endpoint: string;
  /** true when the cursor was decoded from a legacy plain-integer string */
  isLegacy: boolean;
}

// ── HMAC helpers ──────────────────────────────────────────────────────────────

const TEST_SECRET = 'elcarehub-cursor-test-secret-dev-only-32chars';

function getCursorSecret(): string {
  const secret = process.env.CURSOR_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[cursor] CURSOR_SECRET must be set in production');
    }
    return TEST_SECRET;
  }
  return secret;
}

function sign(payload: Omit<CursorPayload, never>): string {
  const data = `${payload.v}:${payload.l}:${payload.i}:${payload.e}`;
  return createHmac('sha256', getCursorSecret()).update(data).digest('hex');
}

function verify(payload: CursorPayload, sig: string): boolean {
  const expected = sign(payload);
  // Constant-time comparison to prevent timing attacks.
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return diff === 0;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Encodes a composite cursor for the given ledger sequence, row id, and
 * endpoint tag.  Returns an opaque base64url string safe for use in
 * HTTP headers and query parameters.
 */
export function encodeCursor(ledger: number, id: number, endpoint: CursorEndpoint): string {
  const payload: CursorPayload = { v: 1, l: ledger, i: id, e: endpoint };
  const sig = sign(payload);
  const envelope = { ...payload, s: sig };
  return Buffer.from(JSON.stringify(envelope)).toString('base64url');
}

/**
 * Decodes and verifies a cursor string.
 *
 * Returns a `DecodedCursor` on success.
 * Throws an `ApiError` (400) on any of:
 *   - malformed base64 / JSON
 *   - unknown schema version
 *   - HMAC signature mismatch (tampering or wrong endpoint)
 *   - endpoint tag mismatch when `expectedEndpoint` is supplied
 */
export function decodeCursor(
  raw: string,
  expectedEndpoint: CursorEndpoint,
): DecodedCursor {
  // ── Legacy integer cursor (backwards compat) ──────────────────────────────
  if (/^\d+$/.test(raw)) {
    const ledger = parseInt(raw, 10);
    if (isNaN(ledger) || ledger < 0) {
      throw badRequest('Invalid cursor: must be a non-negative integer or an opaque cursor token');
    }
    return { ledger, id: 0, endpoint: expectedEndpoint, isLegacy: true };
  }

  // ── Opaque cursor ──────────────────────────────────────────────────────────
  let envelope: any;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    envelope = JSON.parse(json);
  } catch {
    throw badRequest('Invalid cursor: malformed token');
  }

  if (envelope.v !== 1) {
    throw badRequest(`Invalid cursor: unsupported schema version ${envelope.v}`);
  }

  if (
    typeof envelope.l !== 'number' ||
    typeof envelope.i !== 'number' ||
    typeof envelope.e !== 'string' ||
    typeof envelope.s !== 'string'
  ) {
    throw badRequest('Invalid cursor: missing required fields');
  }

  const payload: CursorPayload = { v: 1, l: envelope.l, i: envelope.i, e: envelope.e };

  if (!verify(payload, envelope.s)) {
    throw badRequest('Invalid cursor: signature verification failed');
  }

  // Reject cursors issued for a different endpoint.
  if (envelope.e !== expectedEndpoint) {
    throw badRequest(
      `Invalid cursor: cursor was issued for endpoint "${envelope.e}" but used on "${expectedEndpoint}"`,
    );
  }

  return {
    ledger:     envelope.l,
    id:         envelope.i,
    endpoint:   envelope.e,
    isLegacy:   false,
  };
}

/**
 * Builds Prisma `where` clauses for cursor-based pagination.
 *
 * For composite cursors, applies a compound condition:
 *   DESC → (ledgerField < ledger) OR (ledgerField = ledger AND idField < id)
 *   ASC  → (ledgerField > ledger) OR (ledgerField = ledger AND idField > id)
 *
 * For legacy integer cursors (isLegacy=true), falls back to the simple
 * single-field boundary already in use.
 *
 * @param cursor         Decoded cursor from decodeCursor()
 * @param direction      'asc' | 'desc'
 * @param ledgerField    Prisma field name for the ledger sort key
 * @param idField        Prisma field name for the id tiebreaker (default 'id')
 */
export function buildCursorWhere(
  cursor: DecodedCursor,
  direction: 'asc' | 'desc',
  ledgerField: string,
  idField: string = 'id',
): Record<string, unknown> {
  if (cursor.isLegacy || cursor.id === 0) {
    // Simple single-field boundary (legacy / no tiebreaker needed).
    return {
      [ledgerField]: direction === 'desc'
        ? { lt: cursor.ledger }
        : { gt: cursor.ledger },
    };
  }

  // Composite boundary: same-ledger rows are included/excluded by id.
  if (direction === 'desc') {
    return {
      OR: [
        { [ledgerField]: { lt: cursor.ledger } },
        { [ledgerField]: cursor.ledger, [idField]: { lt: cursor.id } },
      ],
    };
  } else {
    return {
      OR: [
        { [ledgerField]: { gt: cursor.ledger } },
        { [ledgerField]: cursor.ledger, [idField]: { gt: cursor.id } },
      ],
    };
  }
}

/**
 * Extracts the next-cursor value from the last row of a result page.
 *
 * Returns an empty string when the page is exhausted (fewer results than
 * the requested page size), signalling "no more pages".
 *
 * @param rows         Array of result rows
 * @param pageSize     The requested page size (limit / take)
 * @param ledgerField  Field name on each row carrying the ledger sequence
 * @param idField      Field name on each row carrying the row id (default 'id')
 * @param endpoint     Endpoint tag for the HMAC signature
 */
export function nextCursorFromRows(
  rows: Record<string, any>[],
  pageSize: number,
  ledgerField: string,
  endpoint: CursorEndpoint,
  idField: string = 'id',
): string {
  if (rows.length < pageSize) return '';
  const last = rows[rows.length - 1];
  const ledger = Number(last[ledgerField]);
  const id     = Number(last[idField] ?? 0);
  if (isNaN(ledger)) return '';
  return encodeCursor(ledger, id, endpoint);
}

// ── Frontend client helpers ───────────────────────────────────────────────────
//
// These helpers are re-exported as documentation and can be copy-pasted into
// the frontend client. They are pure functions with no Node.js dependencies.

/**
 * Extracts `X-Next-Cursor` from a fetch Response and returns it, or `null`
 * when the response indicates the last page (header value is empty string).
 *
 * Usage (browser / Next.js):
 *   const cursor = extractNextCursor(response);
 *   if (cursor) setNextCursor(cursor);
 */
export function extractNextCursor(response: { headers: { get(name: string): string | null } }): string | null {
  const raw = response.headers.get('X-Next-Cursor');
  if (raw === null || raw === '') return null;
  return raw;
}

/**
 * Appends (or replaces) `cursor` in a URLSearchParams object while preserving
 * all existing filter parameters.  Deletes `offset` when a cursor is present
 * (cursor and offset pagination are mutually exclusive).
 *
 * Usage:
 *   const params = new URLSearchParams(currentQuery);
 *   const nextParams = applyCursorToParams(params, nextCursor);
 *   router.push(`/listings?${nextParams}`);
 */
export function applyCursorToParams(
  current: URLSearchParams,
  cursor: string | null,
): URLSearchParams {
  const next = new URLSearchParams(current);
  if (cursor) {
    next.set('cursor', cursor);
    next.delete('offset'); // cursor and offset are mutually exclusive
  } else {
    next.delete('cursor');
  }
  return next;
}
