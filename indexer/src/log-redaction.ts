/**
 * log-redaction.ts
 *
 * Privacy-safe structured logging enforcement (issue #541).
 *
 * Centralizes the redaction logic used by `logger.ts` so that wallet
 * secrets, JWTs, credential-bearing URLs, authorization headers, and raw
 * Soroban transaction XDR can never leak into emitted log lines — whether
 * they arrive as a known field name (`password`, `authorization`, ...) or
 * buried inside an arbitrary nested object (a full request body, an axios
 * error's `.config`, a wrapped `Error.cause`, etc.).
 *
 * This module intentionally generalizes the field-redaction approach already
 * used by `audit/audit-service.ts` (`redactContext`/`SENSITIVE_FIELDS`) so
 * the *general* application logger gets the same protection the audit log
 * already had. If you change the forbidden-field list here, consider whether
 * `audit/audit-service.ts` and `frontend/elcarehub-app/src/lib/privacy.ts`
 * (`REDACTED_FIELDS`) should be updated too — they are independent, purpose-
 * specific lists (audit trail persistence vs. general app logs vs. browser
 * telemetry) but are meant to stay conceptually aligned.
 *
 * ── Allowed fields (always safe to log; never touched) ───────────────────────
 *   requestId, statusCode, durationMs, event, action, outcome, code,
 *   errorClass, contractId, ledger, listingId, auctionId, offerId, cid,
 *   gateway, latencyMs, attempt(s), maxAttempts, delayMs, path, method,
 *   route, level, msg, service, version, time, count, jobId, isFinal,
 *   policy, reason, and truncated/hashed identifiers such as a shortened
 *   txHash or contentHash prefix. These are the diagnostic backbone of the
 *   logs and acceptance criteria requires they remain intact — the
 *   sanitizer below only acts on forbidden key names or on VALUES that
 *   independently look like secrets, so these keys pass through untouched.
 *
 * ── Forbidden fields (value fully redacted regardless of content) ───────────
 *   authorization, cookie, secret, password/passwd, privatekey/private_key,
 *   seed, mnemonic, jwt, token, apikey/api_key, x-api-key, authtoken,
 *   sessiontoken, signature, database_url, redis_url, and the literal field
 *   names `body`/`rawbody` (unless explicitly allowed by a caller that has
 *   already scrubbed them — none currently do).
 *
 * ── Value-shape based redaction (regardless of key name) ─────────────────────
 *   - Stellar secret keys (`S` + 55 base32 chars)
 *   - JWT-shaped strings (three base64url segments separated by `.`)
 *   - URLs with embedded credentials (`scheme://user:pass@host` → the
 *     credentials are stripped but the host survives for diagnostics)
 *   - Raw Soroban transaction XDR under `xdr`/`envelopeXdr`/`resultXdr`-ish
 *     keys, which are truncated to a length marker instead of dropped,
 *     unless `ALLOW_RAW_BODY_LOGGING=true` is set (and it is a no-op in
 *     production — see `isRawBodyLoggingAllowed`).
 */

// ── Forbidden field names (case-insensitive substring match) ────────────────
//
// Substring matching mirrors audit-service.ts's approach: it catches
// `x-api-key`, `apiKey`, `sessionToken`, `DATABASE_URL`, etc. under one rule
// instead of enumerating every casing/separator variant.

const FORBIDDEN_FIELD_SUBSTRINGS = [
  'authorization',
  'cookie',
  'secret',
  'password',
  'passwd',
  'privatekey',
  'private_key',
  'seed',
  'mnemonic',
  'jwt',
  'token',
  'apikey',
  'api_key',
  'x-api-key',
  'authtoken',
  'sessiontoken',
  'signature',
  'database_url',
  'redis_url',
];

// Exact-match only — these are common enough field names in non-sensitive
// contexts (e.g. a `config` object for retry settings) that substring
// matching would over-redact. `body`/`rawBody` specifically cover accidental
// full-request-body logging.
const FORBIDDEN_FIELD_EXACT = new Set(['body', 'rawbody']);

// Axios (and similar HTTP clients) attach these onto thrown errors. They can
// carry full request URLs (with embedded credentials/query secrets) and
// outbound headers (including `Authorization`). Stripped when serializing
// Error-like objects — see `sanitizeErrorLike`.
const ERROR_INTERNALS_TO_DROP = new Set(['config', 'request', 'response']);

function isForbiddenFieldName(key: string): boolean {
  const lower = key.toLowerCase();
  if (FORBIDDEN_FIELD_EXACT.has(lower)) return true;
  return FORBIDDEN_FIELD_SUBSTRINGS.some((f) => lower.includes(f));
}

// ── Value-shape patterns ──────────────────────────────────────────────────────

/**
 * Stellar secret keys: 'S' followed by 55 base32 characters (56 total).
 * Global so it can be used with `.replace()` to redact a secret embedded
 * inside a longer string (e.g. an error message) without discarding the
 * surrounding text.
 */
const STELLAR_SECRET_KEY_PATTERN = /\bS[A-Z2-7]{55}\b/g;

/** JWT-shaped string: three base64url segments separated by dots. Global — see above. */
const JWT_PATTERN = /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

/** URL with embedded basic-auth credentials, e.g. postgres://user:pass@host/db. */
const CREDENTIALED_URL_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s/@]+):([^\s/@]+)@/g;

/** Field names that carry raw Soroban transaction XDR blobs. */
const XDR_FIELD_PATTERN = /(^|_)(xdr|envelopexdr|resultxdr|txxdr|txenvelope)($|_)/i;

/** Only treat long-ish strings as candidate XDR — short values are probably not blobs. */
const MIN_XDR_LENGTH = 64;

const REDACTED = '[REDACTED]';

// ── Raw-body / verbosity guard ────────────────────────────────────────────────
//
// `ALLOW_RAW_BODY_LOGGING=true` opts back into unredacted request bodies and
// full XDR blobs for local debugging. It is a hard no-op in production: even
// if the env var is set, `NODE_ENV === 'production'` wins, and we log a
// one-time warning so a misconfigured override doesn't fail silently.

let warnedAboutProductionOverride = false;

export function isRawBodyLoggingAllowed(): boolean {
  const requested = (process.env.ALLOW_RAW_BODY_LOGGING || '').toLowerCase() === 'true';
  if (!requested) return false;

  if (process.env.NODE_ENV === 'production') {
    if (!warnedAboutProductionOverride) {
      warnedAboutProductionOverride = true;
      // Deliberately uses console.warn, not `logger`, to avoid a circular
      // import between logger.ts and log-redaction.ts.
      // eslint-disable-next-line no-console
      console.warn(
        '[log-redaction] ALLOW_RAW_BODY_LOGGING=true is ignored in production ' +
          '(NODE_ENV=production). Raw request bodies and XDR blobs remain redacted.',
      );
    }
    return false;
  }

  return true;
}

// ── Core sanitizers ────────────────────────────────────────────────────────────

/** Bounds recursion so a pathological/circular object can't hang or crash the logger. */
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;

function sanitizeStringValue(value: string, keyHint?: string): string {
  // Substring replacement (not whole-string replacement) so a secret
  // embedded inside a longer string — e.g. an error message like
  // "invalid signer SXXXX...: account not found" — gets redacted without
  // discarding the rest of the (useful) message.
  const out = value
    .replace(STELLAR_SECRET_KEY_PATTERN, REDACTED)
    .replace(JWT_PATTERN, REDACTED)
    .replace(CREDENTIALED_URL_PATTERN, '$1[REDACTED]@');

  if (
    keyHint &&
    XDR_FIELD_PATTERN.test(keyHint.replace(/-/g, '_')) &&
    out.length >= MIN_XDR_LENGTH &&
    !isRawBodyLoggingAllowed()
  ) {
    return `[XDR omitted, length=${out.length}]`;
  }

  return out;
}

/**
 * Serializes an Error (or Error-like object) into a plain object, sanitizing
 * its own fields and recursing into `.cause` so a wrapped error can't smuggle
 * secrets through a nested cause chain. Keeps `message`/`stack`/`name` intact
 * (stack traces are safe and useful; see errors.ts for the prod/non-prod
 * stack-inclusion policy at the call site).
 */
function sanitizeErrorLike(err: Error, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  // `message`/`stack` are free text, not bound to a forbidden field name, but
  // they can still contain an interpolated secret (e.g. a wrapped error whose
  // message embeds a raw key or a credentialed URL) — run them through the
  // same value-shape scan as any other string.
  const out: Record<string, unknown> = {
    name: err.name,
    message: typeof err.message === 'string' ? sanitizeStringValue(err.message) : err.message,
    stack: typeof err.stack === 'string' ? sanitizeStringValue(err.stack) : err.stack,
  };

  for (const key of Object.keys(err)) {
    if (key === 'name' || key === 'message' || key === 'stack' || key === 'cause') continue;
    if (ERROR_INTERNALS_TO_DROP.has(key.toLowerCase())) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = sanitizeValue((err as unknown as Record<string, unknown>)[key], depth + 1, seen, key);
  }

  const cause = (err as { cause?: unknown }).cause;
  if (cause !== undefined) {
    out.cause = sanitizeValue(cause, depth + 1, seen, 'cause');
  }

  return out;
}

/**
 * Recursively redacts a value. `keyHint` is the field name this value was
 * found under (used for forbidden-name checks and XDR detection); it is
 * `undefined` for array items and the top-level call.
 */
export function sanitizeValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
  keyHint?: string,
): unknown {
  if (keyHint && isForbiddenFieldName(keyHint)) {
    return REDACTED;
  }

  if (value === null || value === undefined) return value;

  if (depth >= MAX_DEPTH) {
    return typeof value === 'object' ? '[REDACTED_DEPTH_EXCEEDED]' : value;
  }

  if (typeof value === 'string') {
    return sanitizeStringValue(value, keyHint);
  }

  if (typeof value !== 'object') {
    // number, boolean, bigint, symbol, function — nothing to redact
    return value;
  }

  if (seen.has(value)) return '[REDACTED_CIRCULAR]';
  seen.add(value);

  if (value instanceof Error) {
    return sanitizeErrorLike(value, depth, seen);
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeValue(item, depth + 1, seen));
  }

  // Plain object (or object-like — Date, etc. fall through unmodified below)
  if (value instanceof Date || value instanceof RegExp) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = sanitizeValue(v, depth + 1, seen, k);
  }
  return out;
}

/**
 * Sanitizes a top-level `fields` object before it reaches pino. This is the
 * primary enforcement point — pino's static `redact` glob paths (configured
 * in logger.ts) are a defense-in-depth backstop for well-known field shapes,
 * but arbitrary/dynamic keys (a full request body object, an unexpected RPC
 * error shape) are only caught here.
 */
export function sanitizeFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!fields) return {};
  const sanitized = sanitizeValue(fields, 0, new WeakSet());
  return (sanitized ?? {}) as Record<string, unknown>;
}

/**
 * Cheap self-check a caller can run in dev/CI-adjacent code paths to assert a
 * field object contains no obviously-sensitive raw values before it's passed
 * to the logger. Not wired into an automated test suite (out of scope for
 * this pass) — the sanitizer itself, applied unconditionally in `wrap()`
 * (logger.ts), is the real enforcement mechanism. This just gives call sites
 * a way to assert-in-place if they want extra confidence.
 */
export function redactionSelfCheck(fields: Record<string, unknown>): boolean {
  const serialized = JSON.stringify(fields);
  // All three patterns carry the global flag (for substring `.replace()`
  // elsewhere in this module), which makes `.test()` stateful — reset
  // `lastIndex` before each use so repeated calls don't get skewed results.
  for (const pattern of [STELLAR_SECRET_KEY_PATTERN, JWT_PATTERN, CREDENTIALED_URL_PATTERN]) {
    pattern.lastIndex = 0;
    const matched = pattern.test(serialized);
    pattern.lastIndex = 0;
    if (matched) return false;
  }
  return true;
}

// ── Pino static redact paths (defense in depth) ──────────────────────────────
//
// These glob paths cover the common shapes we know about ahead of time.
// `sanitizeFields` above is the primary defense since it also catches
// unknown/dynamic keys these globs can't anticipate.
export const PINO_REDACT_PATHS: string[] = [
  '*.authorization',
  '*.Authorization',
  '*.cookie',
  '*.password',
  '*.secret',
  '*.privateKey',
  '*.private_key',
  '*.seed',
  '*.mnemonic',
  '*.jwt',
  '*.token',
  '*.apiKey',
  '*.api_key',
  '*.body',
  '*.rawBody',
  '*.headers.authorization',
  '*.headers.cookie',
];
