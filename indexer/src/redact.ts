/**
 * redact.ts
 *
 * Lightweight, dependency-free secret redaction applied at the logger and
 * error-response serialization boundaries.
 *
 * This mirrors (conceptually, not by import — the two run in different
 * processes: CI vs. the running indexer) the secret shapes enforced at
 * commit time by `.gitleaks.toml`: Stellar secret keys, database connection
 * strings, Pinata JWTs, and generic bearer/API tokens. The goal is that even
 * if one of those values ends up interpolated into an error message or log
 * field at runtime, it never reaches stdout or an HTTP error payload intact.
 *
 * This is defense-in-depth, not a replacement for not logging secrets in the
 * first place — see docs/secret-inventory.md and SECURITY_SCANNING_TRIAGE.md.
 */

const REDACTED = '[REDACTED]';

// Field names that are always fully redacted regardless of their value shape.
const SENSITIVE_KEY_PATTERN =
  /secret|password|passwd|token|api[-_]?key|private[-_]?key|seed|mnemonic|authorization|cookie|jwt|database[-_]?url|redis[-_]?url|signature/i;

// Value shapes that get masked wherever they appear in a string, even inside
// an unlabeled field (e.g. a raw error message that happens to embed one).
const VALUE_PATTERNS: RegExp[] = [
  // Stellar secret (seed) key: 'S' + 55 base32 chars (RFC 4648 alphabet, no 0/1/8/9).
  /\bS[A-Z2-7]{55}\b/g,
  // Database connection string with embedded credentials (postgres/mysql).
  /\b(postgres(?:ql)?|mysql):\/\/[^:\s"'<>]+:[^@\s"'<>]+@[^\s"'<>]+/gi,
  // JWT-shaped tokens (Pinata JWTs and other bearer JWTs alike).
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  // "Bearer <token>" / "Authorization: Bearer <token>" style headers echoed into text.
  /\bBearer\s+[A-Za-z0-9._-]{16,}/gi,
];

const MAX_DEPTH = 6;

/** Masks any recognized secret shape found inside a string. */
export function redactString(value: string): string {
  let out = value;
  for (const pattern of VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * Deep-redacts a value for safe logging / serialization:
 *  - strings are scanned for embedded secret shapes (`redactString`)
 *  - object fields whose *name* looks sensitive are fully replaced
 *  - Error instances are flattened to a plain, redacted {name, message, stack}
 *  - arrays and nested objects are walked recursively (bounded depth)
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    return typeof value === 'string' ? redactString(value) : value;
  }

  if (typeof value === 'string') {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      ...(value.stack ? { stack: redactString(value.stack) } : {}),
    };
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redact(val, depth + 1);
    }
    return out;
  }

  return value;
}
