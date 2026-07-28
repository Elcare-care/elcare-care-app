import pino from 'pino';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

function wrap(instance: pino.Logger): StructuredLogger {
  return {
    debug: (msg, fields) => instance.debug(fields ?? {}, msg),
    info: (msg, fields) => instance.info(fields ?? {}, msg),
    warn: (msg, fields) => instance.warn(fields ?? {}, msg),
    error: (msg, fields) => instance.error(fields ?? {}, msg),
    child: (bindings) => wrap(instance.child(bindings)),
  };
}

export const logger: StructuredLogger = wrap(pinoInstance);
