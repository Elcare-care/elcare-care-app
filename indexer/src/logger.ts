import pino from 'pino';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { redact, redactString } from './redact.js';
import { PINO_REDACT_PATHS } from './log-redaction.js';

// ── Service metadata ─────────────────────────────────────────────────────────
//
// Every log line carries `service` + `version` so log aggregators (CloudWatch,
// Datadog, etc.) can distinguish the indexer from other services and pin an
// entry to the exact deploy that produced it.

const __dirname = dirname(fileURLToPath(import.meta.url));

let packageVersion = '0.0.0';
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8')) as {
    version?: string;
  };
  packageVersion = pkg.version ?? packageVersion;
} catch {
  // Fall back to the default version if package.json can't be read (e.g. from dist/)
}

const SERVICE_NAME = 'elcarehub-indexer';

// ── Level / format configuration ─────────────────────────────────────────────

const VALID_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

function resolveLogLevel(): string {
  const raw = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return VALID_LEVELS.has(raw) ? raw : 'info';
}

function resolveLogFormat(): 'json' | 'pretty' {
  return (process.env.LOG_FORMAT || 'json').toLowerCase() === 'pretty' ? 'pretty' : 'json';
}

const level = resolveLogLevel();
const format = resolveLogFormat();

const baseOptions: pino.LoggerOptions = {
  level,
  // Replace pino's default {pid, hostname} base with our own service identity.
  base: {
    service: SERVICE_NAME,
    version: packageVersion,
  },
  // Emit the level as its string label ("info") rather than pino's default
  // numeric severity, matching the shape the rest of the codebase expects.
  formatters: {
    level: (label) => ({ level: label }),
  },
  // Defense-in-depth: static glob-path redaction for well-known sensitive
  // field shapes (see log-redaction.ts). This is a backstop, not the primary
  // guard — arbitrary/dynamic keys (e.g. a full request body object) are
  // caught by `sanitizeFields` in `wrap()` below, which pino's static paths
  // can't anticipate.
  redact: {
    paths: PINO_REDACT_PATHS,
    censor: '[REDACTED]',
  },
};

const pinoInstance: pino.Logger =
  format === 'pretty'
    ? pino({
        ...baseOptions,
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        },
      })
    : pino(baseOptions);

// ── Public logger API ────────────────────────────────────────────────────────
//
// Callers use `logger.info(msg, fields?)` — the same call signature the
// hand-rolled logger exposed. Internally this maps to pino's
// `(mergingObject, msg)` signature so `fields` are merged as top-level JSON
// keys alongside `service`, `version`, `level`, `time`, and `msg`.

export interface StructuredLogger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Creates a child logger with `bindings` merged into every log line it emits. */
  child(bindings: Record<string, unknown>): StructuredLogger;
}

// Every field object and message string is passed through `redact` /
// `redactString` before it reaches pino's serializer. This is the last line
// of defense if a Stellar key, DB URL, Pinata token, or other secret shape
// ends up interpolated into a log call — see redact.ts and
// src/__tests__/log-redaction.test.ts.
function wrap(instance: pino.Logger): StructuredLogger {
  return {
    debug: (msg, fields) => instance.debug(redact(fields ?? {}) as Record<string, unknown>, redactString(msg)),
    info: (msg, fields) => instance.info(redact(fields ?? {}) as Record<string, unknown>, redactString(msg)),
    warn: (msg, fields) => instance.warn(redact(fields ?? {}) as Record<string, unknown>, redactString(msg)),
    error: (msg, fields) => instance.error(redact(fields ?? {}) as Record<string, unknown>, redactString(msg)),
    child: (bindings) => wrap(instance.child(redact(bindings) as Record<string, unknown>)),
  };
}

export const logger: StructuredLogger = wrap(pinoInstance);
