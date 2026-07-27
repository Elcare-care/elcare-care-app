/**
 * retry.ts
 *
 * Exponential backoff with jitter and per-dependency circuit breakers.
 *
 * Design:
 *  - withExponentialBackoff: generic retrier with per-call RetryConfig
 *  - Pre-built configs for each external dependency (rpc, db, ipfs)
 *  - CircuitBreaker: open after N consecutive failures, half-open after
 *    a cool-down window, closed again after one success
 *  - Prometheus gauge tracks circuit state per dependency label
 *
 * Thundering-herd prevention:
 *  delay = Math.min(baseDelayMs * 2^attempt * (1 + jitter), maxDelayMs)
 *  where jitter is uniform random in [0, jitterFactor].
 *  Every call therefore fires at a different time even when many arrive
 *  together after a failure burst.
 */

import client from 'prom-client';
import { rpcRetryExhaustedCounter } from './metrics.js';
import { logger } from './logger.js';

// ── Retry config ──────────────────────────────────────────────────────────────

export interface RetryConfig {
  /** Total call attempts including the first one (default 5). */
  maxAttempts?: number;
  /** Base delay before the first retry in ms (default 500). */
  baseDelayMs?: number;
  /** Hard ceiling on computed delay in ms (default 30 000). */
  maxDelayMs?: number;
  /**
   * Multiplier applied to a uniform-random value in [0, 1] then added to the
   * exponential term: delay = base * 2^n * (1 + rand * jitterFactor).
   * Set to 0 to disable jitter (useful in tests).
   */
  jitterFactor?: number;
  /**
   * Predicate that decides whether an error is worth retrying.
   * Non-retryable errors are re-thrown immediately without consuming attempts.
   * Defaults to always retrying.
   */
  retryable?: (err: unknown) => boolean;
  /** Label for metrics and logs. */
  operation?: string;
}

// Legacy interface kept for backward-compat with existing call sites
export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Flat random jitter added to the computed delay (legacy — maps to jitterFactor). */
  jitterMs?: number;
  operation?: string;
}

// ── Per-dependency retry configs ──────────────────────────────────────────────

/** Stellar RPC: tolerate network blips and 429 rate-limit responses. */
export const STELLAR_RPC_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  jitterFactor: 0.3,
  retryable: isRpcRetryable,
  operation: 'rpc',
};

/** PostgreSQL via Prisma: only retry on connection-pool errors. */
export const DB_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 5_000,
  jitterFactor: 0.2,
  retryable: isDbRetryable,
  operation: 'db',
};

/** IPFS gateway fetch: retry on network errors and gateway timeouts. */
export const IPFS_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 10_000,
  jitterFactor: 0.4,
  retryable: isIpfsRetryable,
  operation: 'ipfs',
};

// ── Retryability predicates ───────────────────────────────────────────────────

/** True for network-level errors or HTTP 429 from the Stellar RPC. */
export function isRpcRetryable(err: unknown): boolean {
  if (isNetworkError(err)) return true;
  const status = extractHttpStatus(err);
  if (status === 429) return true; // rate-limited
  if (status !== null && status >= 500) return true; // server-side transient
  return false;
}

/** True only for DB connection / pool errors; schema / constraint errors are fatal. */
export function isDbRetryable(err: unknown): boolean {
  if (isNetworkError(err)) return true;
  const msg = errorMessage(err).toLowerCase();
  // Prisma connection pool exhaustion / timeout codes
  if (msg.includes('connection') && msg.includes('timeout')) return true;
  if (msg.includes('pool')) return true;
  if (msg.includes('econnrefused')) return true;
  if (msg.includes('enotfound')) return true;
  if (msg.includes('p1001') || msg.includes('p1002') || msg.includes('p1008')) return true;
  return false;
}

/** True for network errors or HTTP 504 from an IPFS gateway. */
export function isIpfsRetryable(err: unknown): boolean {
  if (isNetworkError(err)) return true;
  const status = extractHttpStatus(err);
  if (status === 504) return true; // gateway timeout
  if (status === 503) return true; // service unavailable
  if (status === 429) return true; // rate-limited
  return false;
}

function isNetworkError(err: unknown): boolean {
  const msg = errorMessage(err).toLowerCase();
  const code = (err as any)?.code as string | undefined;
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
    return true;
  }
  if (msg.includes('network') || msg.includes('timeout') || msg.includes('econnreset')) {
    return true;
  }
  return false;
}

function extractHttpStatus(err: unknown): number | null {
  const e = err as any;
  if (typeof e?.response?.status === 'number') return e.response.status;
  if (typeof e?.status === 'number') return e.status;
  if (typeof e?.statusCode === 'number') return e.statusCode;
  return null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ── Circuit breaker ───────────────────────────────────────────────────────────

export type CircuitState = 'closed' | 'half-open' | 'open';

// Prometheus gauge: 0=closed, 1=half-open, 2=open
// Guard against double-registration in tests and hot-reload scenarios
// where the module may be evaluated more than once against the same
// prom-client registry.
let circuitStateGauge: client.Gauge;
try {
  circuitStateGauge = new client.Gauge({
    name: 'elcarehub_circuit_state',
    help: 'Current circuit-breaker state per dependency (0=closed, 1=half-open, 2=open)',
    labelNames: ['dependency'],
  });
} catch {
  // Already registered — retrieve the existing metric (real prom-client)
  const reg = client.register as any;
  circuitStateGauge = (typeof reg.getSingleMetric === 'function'
    ? reg.getSingleMetric('elcarehub_circuit_state')
    : null) as client.Gauge;
  // Fallback stub so CircuitBreaker construction never crashes
  if (!circuitStateGauge) {
    circuitStateGauge = { labels: () => ({ set: () => {} }) } as unknown as client.Gauge;
  }
}

const CIRCUIT_STATE_VALUES: Record<CircuitState, number> = {
  closed: 0,
  'half-open': 1,
  open: 2,
};

export interface CircuitBreakerOptions {
  /** Consecutive failure threshold before opening (default 5). */
  failureThreshold?: number;
  /** Milliseconds to wait in open state before transitioning to half-open (default 60 000). */
  resetTimeoutMs?: number;
  /** Dependency label used in Prometheus and logs. */
  dependency: string;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt: number | null = null;

  readonly failureThreshold: number;
  readonly resetTimeoutMs: number;
  readonly dependency: string;

  constructor(opts: CircuitBreakerOptions) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.resetTimeoutMs   = opts.resetTimeoutMs   ?? 60_000;
    this.dependency       = opts.dependency;

    circuitStateGauge.labels(this.dependency).set(CIRCUIT_STATE_VALUES['closed']);
  }

  getState(): CircuitState {
    // Transition open → half-open when the cool-down has elapsed
    if (this.state === 'open' && this.openedAt !== null) {
      if (Date.now() - this.openedAt >= this.resetTimeoutMs) {
        this._transition('half-open');
      }
    }
    return this.state;
  }

  /** Record a successful call; resets failure counter and closes the circuit. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
    if (this.state !== 'closed') {
      this._transition('closed');
    }
  }

  /** Record a failed call; opens the circuit when the threshold is reached. */
  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (
      this.state === 'closed' &&
      this.consecutiveFailures >= this.failureThreshold
    ) {
      this._transition('open');
    } else if (this.state === 'half-open') {
      // Probe failed — go back to open
      this._transition('open');
    }
  }

  private _transition(next: CircuitState): void {
    const prev = this.state;
    this.state = next;
    if (next === 'open') {
      this.openedAt = Date.now();
      this.consecutiveFailures = this.failureThreshold; // clamp to threshold
    }
    circuitStateGauge.labels(this.dependency).set(CIRCUIT_STATE_VALUES[next]);
    logger.warn('circuit-breaker: state transition', {
      dependency: this.dependency,
      from: prev,
      to: next,
      consecutiveFailures: this.consecutiveFailures,
    });
  }
}

// Singleton circuit breakers, one per external dependency
export const circuitBreakers = {
  rpc:  new CircuitBreaker({ dependency: 'rpc',  failureThreshold: 5, resetTimeoutMs: 60_000 }),
  db:   new CircuitBreaker({ dependency: 'db',   failureThreshold: 5, resetTimeoutMs: 60_000 }),
  ipfs: new CircuitBreaker({ dependency: 'ipfs', failureThreshold: 5, resetTimeoutMs: 60_000 }),
} as const;

export class CircuitOpenError extends Error {
  constructor(dependency: string) {
    super(`Circuit breaker OPEN for dependency: ${dependency} — fast-failing`);
    this.name = 'CircuitOpenError';
  }
}

// ── Core retry implementation ─────────────────────────────────────────────────

function computeDelay(
  attempt: number, // 0-indexed (0 = before first retry)
  baseDelayMs: number,
  maxDelayMs: number,
  jitterFactor: number,
): number {
  const jitter = jitterFactor > 0 ? Math.random() * jitterFactor : 0;
  return Math.min(baseDelayMs * Math.pow(2, attempt) * (1 + jitter), maxDelayMs);
}

/**
 * Execute `fn` with exponential backoff and optional circuit-breaker integration.
 *
 * @param fn          - Async function to invoke and retry
 * @param config      - RetryConfig governing timing, attempts, and retryability
 * @param breaker     - Optional CircuitBreaker; fast-fails when open
 */
export async function withExponentialBackoff<T>(
  fn: () => Promise<T>,
  config: RetryConfig = {},
  breaker?: CircuitBreaker,
): Promise<T> {
  const {
    maxAttempts = 5,
    baseDelayMs = 500,
    maxDelayMs  = 30_000,
    jitterFactor = 0.3,
    retryable   = () => true,
    operation   = 'unknown',
  } = config;

  // Fast-fail when the circuit is open
  if (breaker) {
    const state = breaker.getState();
    if (state === 'open') {
      throw new CircuitOpenError(breaker.dependency);
    }
  }

  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      breaker?.recordSuccess();
      return result;
    } catch (err) {
      lastErr = err;

      // Fast-fail non-retryable errors immediately
      if (!retryable(err)) {
        breaker?.recordFailure();
        throw err;
      }

      breaker?.recordFailure();

      if (attempt === maxAttempts) break;

      const delay = computeDelay(attempt - 1, baseDelayMs, maxDelayMs, jitterFactor);
      logger.warn(`[withExponentialBackoff] ${operation} failed — attempt ${attempt}/${maxAttempts}, retrying in ${delay.toFixed(0)}ms`, {
        operation,
        attempt,
        maxAttempts,
        delayMs: delay,
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  rpcRetryExhaustedCounter.inc({ operation });
  logger.error(`[withExponentialBackoff] ${operation} exhausted all ${maxAttempts} attempts`, {
    operation,
    error: lastErr instanceof Error ? lastErr.message : String(lastErr),
    stack: lastErr instanceof Error ? lastErr.stack : undefined,
  });
  throw lastErr;
}

// ── Convenience wrappers per dependency ───────────────────────────────────────

/** Wrap a Stellar RPC call with the RPC retry config + circuit breaker. */
export function withRpcRetry<T>(fn: () => Promise<T>, overrides?: Partial<RetryConfig>): Promise<T> {
  return withExponentialBackoff(fn, { ...STELLAR_RPC_RETRY_CONFIG, ...overrides }, circuitBreakers.rpc);
}

/** Wrap a database call with the DB retry config + circuit breaker. */
export function withDbRetry<T>(fn: () => Promise<T>, overrides?: Partial<RetryConfig>): Promise<T> {
  return withExponentialBackoff(fn, { ...DB_RETRY_CONFIG, ...overrides }, circuitBreakers.db);
}

/** Wrap an IPFS fetch with the IPFS retry config + circuit breaker. */
export function withIpfsRetry<T>(fn: () => Promise<T>, overrides?: Partial<RetryConfig>): Promise<T> {
  return withExponentialBackoff(fn, { ...IPFS_RETRY_CONFIG, ...overrides }, circuitBreakers.ipfs);
}

// ── Backward-compatible withRetry (legacy call sites) ─────────────────────────
//
// Existing callers pass RetryOptions (flat jitterMs).  We map that to a
// RetryConfig so all traffic flows through withExponentialBackoff, picking up
// the circuit-breaker and proper jitter behaviour transparently.
//
// The operation label determines which circuit breaker is selected:
//   - 'getLatestLedger', 'getEvents', anything 'rpc*' → rpc breaker
//   - 'db*', 'prisma*'                                 → db breaker
//   - 'ipfs*'                                          → ipfs breaker
//   - anything else (e.g. 'gap-repair-42')             → no breaker

function selectBreaker(operation: string): CircuitBreaker | undefined {
  const op = operation.toLowerCase();
  if (op === 'getlatestledger' || op === 'getevents' || op.startsWith('rpc')) {
    return circuitBreakers.rpc;
  }
  if (op.startsWith('db') || op.startsWith('prisma')) {
    return circuitBreakers.db;
  }
  if (op.startsWith('ipfs')) {
    return circuitBreakers.ipfs;
  }
  return undefined;
}

/**
 * Legacy entry-point — kept for backward compatibility.
 * New code should call withRpcRetry / withDbRetry / withIpfsRetry directly.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    maxAttempts = 5,
    baseDelayMs = 500,
    maxDelayMs  = 30_000,
    jitterMs    = 500,
    operation   = 'rpc',
  } = options;

  // Convert flat jitterMs to a jitterFactor relative to baseDelayMs.
  // Guard against baseDelayMs === 0 (test usage) to avoid NaN.
  const jitterFactor = baseDelayMs > 0 ? Math.min(jitterMs / baseDelayMs, 2) : 0;

  const config: RetryConfig = {
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    jitterFactor,
    retryable: () => true, // legacy behaviour: retry everything
    operation,
  };

  return withExponentialBackoff(fn, config, selectBreaker(operation));
}
