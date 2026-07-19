import type { CorsOptions } from 'cors';

/**
 * Parse CORS_ORIGIN env var into a trimmed, deduplicated array of allowed origins.
 * Returns an empty array when the variable is absent or blank.
 */
export function parseCorsOrigins(raw: string | undefined): string[] {
  if (!raw || raw.trim() === '') return [];
  return [...new Set(raw.split(',').map((o) => o.trim()).filter(Boolean))];
}

/**
 * Build a cors() options object from the allowed-origins list.
 *
 * Behaviour:
 *   - Development (allowlist empty): reflect any origin — convenient for local work.
 *   - Production (allowlist non-empty): only origins present in the list receive
 *     Access-Control-Allow-Origin; all others get no CORS headers (browser blocks them).
 *
 * Every allowed request also gets:
 *   - Access-Control-Allow-Credentials: true  (needed for X-API-Key cookies/headers)
 *   - Access-Control-Max-Age: 86400           (cache preflight for 24 h)
 */
export function buildCorsOptions(allowedOrigins: string[]): CorsOptions {
  const isDev = allowedOrigins.length === 0;

  return {
    origin(requestOrigin, callback) {
      // Same-origin / server-to-server requests carry no Origin header — always allow.
      if (!requestOrigin) return callback(null, true);

      // Dev mode: reflect every origin.
      if (isDev) return callback(null, requestOrigin);

      // Production: exact match against the whitelist only.
      if (allowedOrigins.includes(requestOrigin)) {
        return callback(null, requestOrigin);
      }

      // Not in whitelist — return no CORS headers; browser will block.
      return callback(null, false);
    },

    credentials: true,

    // Cache preflight results for 24 hours — reduces redundant OPTIONS round-trips.
    // The cors package sends this as Access-Control-Max-Age.
    preflightContinue: false,
    optionsSuccessStatus: 204,

    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-API-Key',
      'Last-Event-ID',
    ],
    exposedHeaders: ['X-Request-Id'],

    // 86400 seconds = 24 hours
    maxAge: 86400,
  };
}
