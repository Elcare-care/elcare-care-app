# ElcareHub Logging Policy

**Last Updated:** 2026-08-25
**Owner:** Backend / Platform Team

This document defines what is safe to put in a structured log line, how the
indexer enforces that automatically, and the guardrails around verbose/raw
logging modes. It exists because structured logs are extremely useful for
diagnosis, but the same request/response objects, RPC error payloads, and
database configuration that make debugging easy can also carry wallet
secrets, session tokens, or connection-string credentials if logged
carelessly. See also `docs/secret-inventory.md` (secret classification and
rotation) and `docs/PRIVACY_POLICY.md` (user-facing data handling).

---

## 1. Enforcement point

Every log line in the indexer goes through `indexer/src/logger.ts`, which
wraps [pino](https://getpino.io). Before any `fields` object reaches pino,
it is passed through `sanitizeFields()` in `indexer/src/log-redaction.ts`.
This is the primary enforcement mechanism — it recursively walks nested
objects/arrays (bounded to 6 levels deep) so a full request body, a wrapped
`Error.cause`, or an unexpected RPC error shape can't smuggle a secret
through under a key name the code didn't anticipate.

Pino's static `redact` glob paths (also configured in `logger.ts`) are a
second, defense-in-depth layer for a handful of well-known shapes
(`*.authorization`, `*.body`, `*.headers.cookie`, etc.) — they exist in case
a caller ever bypasses `logger.ts` and talks to a raw pino instance
directly.

The browser-side equivalent is `frontend/elcarehub-app/src/lib/privacy.ts`
(`redactSensitiveFields`), used for client-side audit/telemetry logs. It is
a separate, independent implementation — not code-shared with the indexer —
but its forbidden-field list is meant to stay conceptually aligned with the
one below.

## 2. Allowed fields (safe to log as-is)

These are the diagnostic backbone of the logs. The sanitizer never touches
them unless their *value* independently looks like a secret (see §4):

`requestId`, `statusCode`, `durationMs`, `event`, `action`, `outcome`,
`code`, `errorClass`, `contractId`, `ledger`, `listingId`, `auctionId`,
`offerId`, `cid`, `gateway`, `latencyMs`, `attempt`/`attempts`,
`maxAttempts`, `delayMs`, `path`, `method`, `route`, `count`, `jobId`,
`isFinal`, `policy`, `reason`, and truncated/hashed identifiers (e.g. a
16-character `contentHash` prefix, a shortened transaction hash).

Wallet public keys (`G...`) and transaction hashes are public Stellar-ledger
data, not secrets — they may appear in full where useful (e.g. auth audit
logs), consistent with `docs/PRIVACY_POLICY.md`.

## 3. Forbidden fields (value always redacted, by key name)

Case-insensitive match on the field name, regardless of what the value looks
like: `authorization`, `cookie`, `secret`, `password`/`passwd`,
`privateKey`/`private_key`, `seed`, `mnemonic`, `jwt`, `token` (and
`apiKey`/`api_key`/`x-api-key`, `authToken`, `sessionToken`), `signature`,
`database_url`, `redis_url`, and the literal field names `body`/`rawBody`.

Additionally, when serializing an `Error` object, its `config` and
`request`/`response` properties (attached by HTTP clients like axios — these
can contain full outbound URLs, query strings, and request headers including
`Authorization`) are dropped. `message` and `stack` are kept — stack traces
are safe and are the main tool for triage. Production error responses omit
`stack` regardless of this (see `indexer/src/api/errors.ts`).

## 4. Value-shape redaction (regardless of key name)

Even under an allowed key name, a value is redacted if it looks like:

- **A Stellar secret key** — `S` followed by 55 base32 characters.
- **A JWT** — three base64url segments separated by `.`.
- **A credentialed URL** — `scheme://user:pass@host` is rewritten to
  `scheme://[REDACTED]@host`, so the host/scheme (useful for diagnosing
  "which DB/Redis instance") survives without the password.
- **Raw Soroban transaction XDR** — long base64 blobs under a key like
  `xdr`, `envelopeXdr`, `resultXdr`, or `txXdr` are replaced with
  `[XDR omitted, length=N]`. The length is kept so "did we get a
  suspiciously truncated/empty XDR blob" is still debuggable without ever
  printing the blob itself.

## 5. Raw-body / verbose debug mode — guarded override

Full request bodies and full XDR blobs are sometimes genuinely useful when
chasing a hard bug locally. This is available behind one explicit env var:

```
ALLOW_RAW_BODY_LOGGING=true
```

Guardrails (`indexer/src/log-redaction.ts`, `isRawBodyLoggingAllowed()`):

- **Hard no-op in production.** If `NODE_ENV=production`, the override is
  ignored entirely — even if the env var is set — and a one-time warning is
  logged so a leaked/misconfigured override doesn't fail silently.
- Field-name redaction (`authorization`, `secret`, `password`, etc.) is
  **never** affected by this flag — it only relaxes the XDR-truncation
  behavior in non-production environments. Credentials and secret keys stay
  redacted regardless.

## 6. What was audited for this pass (issue #541)

Reviewed for direct logging of request bodies, raw RPC/HTTP client error
objects, and full connection strings: `indexer/src/api/auth-middleware.ts`,
`indexer/src/api/errors.ts`, `indexer/src/api/request-id-middleware.ts`,
`indexer/src/db-health.ts`, `indexer/src/chain-state.ts`,
`indexer/src/retry.ts`, `indexer/src/ipfs-cache.ts`, `indexer/src/poller.ts`,
`indexer/src/metrics.ts`, `indexer/src/stall.ts`,
`indexer/src/stats-scheduler.ts`, `indexer/src/index.ts`. Most call sites
already extracted `err.message`/`err.stack` rather than logging whole error
objects; the handful that pass a whole `Error` (e.g.
`logger.error('...', { err })` in `metrics.ts`, `poller.ts`, `index.ts`,
`stall.ts`, `stats-scheduler.ts`) are now covered automatically by the
centralized sanitizer rather than being rewritten individually — that
generality is the point of enforcing this in `logger.ts` instead of at each
call site.

Not in scope for this pass: unifying the indexer, audit-service, and
frontend redaction implementations into one shared package; wiring
`redactionSelfCheck()` into an automated test suite; Sentry-side scrubbing
(already covered separately — see `docs/PRIVACY_POLICY.md` §3).
