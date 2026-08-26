/**
 * timeout.ts
 *
 * Timeout budgets and abort signal propagation for external dependencies.
 *
 * Design:
 *  - TimeoutBudget: defines per-dependency timeout limits
 *  - withTimeout: wraps async functions with AbortSignal and timeout enforcement
 *  - TimeoutError: distinct error class for timeout vs cancellation vs provider error
 *  - Metrics: track timeouts, cancellations, and provider errors separately
 *
 * Abort signal propagation:
 *  - Parent signals are passed to child operations
 *  - Timeouts create their own AbortSignal that aborts when exceeded
 *  - Signals are combined (any signal aborting triggers cancellation)
 */

import client from 'prom-client';
import { logger } from './logger.js';

// ── Timeout Budget Configuration ───────────────────────────────────────────────

export interface TimeoutBudget {
  /** Per-operation timeout in milliseconds */
  operationTimeoutMs: number;
  /** Maximum total time including retries in milliseconds */
  totalBudgetMs: number;
  /** Whether to use AbortSignal for cancellation (default true) */
  useAbortSignal?: boolean;
}

// Per-dependency timeout budgets
export const TIMEOUT_BUDGETS = {
  /** Stellar RPC: individual calls timeout quickly, total budget allows retries */
  rpc: {
    operationTimeoutMs: 10_000,  // 10s per RPC call
    totalBudgetMs: 60_000,       // 60s total including retries
    useAbortSignal: true,
  } as TimeoutBudget,

  /** PostgreSQL: queries should be fast, connection pool has its own timeouts */
  db: {
    operationTimeoutMs: 5_000,   // 5s per query
    totalBudgetMs: 30_000,       // 30s total including retries
    useAbortSignal: true,
  } as TimeoutBudget,

  /** Redis: cache operations should be very fast */
  redis: {
    operationTimeoutMs: 2_000,   // 2s per operation
    totalBudgetMs: 10_000,       // 10s total including retries
    useAbortSignal: true,
  } as TimeoutBudget,

  /** IPFS: gateway fetches can be slow, but need timeout */
  ipfs: {
    operationTimeoutMs: 15_000,  // 15s per fetch
    totalBudgetMs: 45_000,       // 45s total including retries
    useAbortSignal: true,
  } as TimeoutBudget,

  /** Graceful shutdown: time to complete all cleanup */
  shutdown: {
    operationTimeoutMs: 30_000,  // 30s for individual cleanup steps
    totalBudgetMs: 60_000,       // 60s total shutdown grace period
    useAbortSignal: true,
  } as TimeoutBudget,
} as const;

// ── Error Classes ───────────────────────────────────────────────────────────────

export class TimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`Operation "${operation}" timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

export class CancellationError extends Error {
  constructor(reason: string) {
    super(`Operation cancelled: ${reason}`);
    this.name = 'CancellationError';
  }
}

export class ProviderError extends Error {
  cause?: Error;
  constructor(operation: string, provider: string, originalError: Error) {
    super(`Provider error in "${operation}" from ${provider}: ${originalError.message}`);
    this.name = 'ProviderError';
    this.cause = originalError;
  }
}

// ── Metrics ───────────────────────────────────────────────────────────────────

// Guard against double-registration
let timeoutCounter: client.Counter;
let cancellationCounter: client.Counter;
let providerErrorCounter: client.Counter;

try {
  timeoutCounter = new client.Counter({
    name: 'dependency_timeout_total',
    help: 'Total operation timeouts by dependency and operation type',
    labelNames: ['dependency', 'operation'],
  });

  cancellationCounter = new client.Counter({
    name: 'dependency_cancellation_total',
    help: 'Total operation cancellations by dependency and reason',
    labelNames: ['dependency', 'reason'],
  });

  providerErrorCounter = new client.Counter({
    name: 'dependency_provider_error_total',
    help: 'Total provider errors by dependency and error type',
    labelNames: ['dependency', 'error_type'],
  });
} catch {
  // Already registered — retrieve existing metrics
  const reg = client.register as any;
  timeoutCounter = (typeof reg.getSingleMetric === 'function'
    ? reg.getSingleMetric('dependency_timeout_total')
    : null) as client.Counter;
  cancellationCounter = (typeof reg.getSingleMetric === 'function'
    ? reg.getSingleMetric('dependency_cancellation_total')
    : null) as client.Counter;
  providerErrorCounter = (typeof reg.getSingleMetric === 'function'
    ? reg.getSingleMetric('dependency_provider_error_total')
    : null) as client.Counter;

  // Fallback stubs
  if (!timeoutCounter) timeoutCounter = { inc: () => {} } as unknown as client.Counter;
  if (!cancellationCounter) cancellationCounter = { inc: () => {} } as unknown as client.Counter;
  if (!providerErrorCounter) providerErrorCounter = { inc: () => {} } as unknown as client.Counter;
}

// ── Abort Signal Utilities ─────────────────────────────────────────────────────

/**
 * Combine multiple AbortSignals into one that aborts when any source aborts.
 */
function combineAbortSignals(signals: (AbortSignal | undefined)[]): AbortSignal {
  const controller = new AbortController();
  
  for (const signal of signals) {
    if (signal?.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    
    signal?.addEventListener('abort', () => {
      controller.abort(signal.reason);
    }, { once: true });
  }
  
  return controller.signal;
}

/**
 * Create an AbortSignal that aborts after the specified timeout.
 */
function createTimeoutSignal(timeoutMs: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new TimeoutError('timeout', timeoutMs));
  }, timeoutMs);
  
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeoutId),
  };
}

// ── Timeout Wrapper ───────────────────────────────────────────────────────────

export interface TimeoutOptions {
  /** Timeout budget configuration */
  budget: TimeoutBudget;
  /** Parent AbortSignal to propagate (optional) */
  signal?: AbortSignal;
  /** Dependency name for metrics */
  dependency: string;
  /** Operation name for metrics */
  operation: string;
}

/**
 * Execute an async function with timeout enforcement and abort signal propagation.
 *
 * @param fn - Async function to execute
 * @param options - Timeout configuration
 * @returns Promise<T> - Result of the function
 * @throws TimeoutError - If operation exceeds timeout
 * @throws CancellationError - If abort signal is triggered
 * @throws ProviderError - If underlying provider fails (wrapped)
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: TimeoutOptions
): Promise<T> {
  const { budget, signal: parentSignal, dependency, operation } = options;
  
  // Create timeout signal
  const { signal: timeoutSignal, clear } = createTimeoutSignal(budget.operationTimeoutMs);
  
  // Combine parent signal with timeout signal
  const combinedSignal = combineAbortSignals([parentSignal, timeoutSignal]);
  
  try {
    // Execute function with combined signal
    const result = await fn(combinedSignal);
    return result;
  } catch (err) {
    // Classify error type
    if (combinedSignal.aborted) {
      const reason = combinedSignal.reason;
      
      if (reason instanceof TimeoutError) {
        timeoutCounter.inc({ dependency, operation });
        logger.warn(`[timeout] ${dependency}:${operation} timed out after ${budget.operationTimeoutMs}ms`, {
          dependency,
          operation,
          timeoutMs: budget.operationTimeoutMs,
        });
        throw reason;
      } else {
        cancellationCounter.inc({ dependency, reason: String(reason) || 'unknown' });
        logger.warn(`[cancellation] ${dependency}:${operation} cancelled`, {
          dependency,
          operation,
          reason: String(reason),
        });
        throw new CancellationError(String(reason));
      }
    }
    
    // Provider error - wrap and classify
    providerErrorCounter.inc({ 
      dependency, 
      error_type: err instanceof Error ? err.constructor.name : 'unknown' 
    });
    
    logger.error(`[provider-error] ${dependency}:${operation} failed`, {
      dependency,
      operation,
      error: err instanceof Error ? err.message : String(err),
    });
    
    throw new ProviderError(operation, dependency, err instanceof Error ? err : new Error(String(err)));
  } finally {
    clear();
  }
}

// ── Convenience Wrappers per Dependency ───────────────────────────────────────

/**
 * Wrap an RPC call with RPC timeout budget.
 */
export function withRpcTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  operation: string,
  overrides?: Partial<TimeoutBudget>
): Promise<T> {
  return withTimeout(fn, {
    budget: { ...TIMEOUT_BUDGETS.rpc, ...overrides },
    dependency: 'rpc',
    operation,
  });
}

/**
 * Wrap a database call with DB timeout budget.
 */
export function withDbTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  operation: string,
  overrides?: Partial<TimeoutBudget>
): Promise<T> {
  return withTimeout(fn, {
    budget: { ...TIMEOUT_BUDGETS.db, ...overrides },
    dependency: 'db',
    operation,
  });
}

/**
 * Wrap a Redis operation with Redis timeout budget.
 */
export function withRedisTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  operation: string,
  overrides?: Partial<TimeoutBudget>
): Promise<T> {
  return withTimeout(fn, {
    budget: { ...TIMEOUT_BUDGETS.redis, ...overrides },
    dependency: 'redis',
    operation,
  });
}

/**
 * Wrap an IPFS fetch with IPFS timeout budget.
 */
export function withIpfsTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  operation: string,
  overrides?: Partial<TimeoutBudget>
): Promise<T> {
  return withTimeout(fn, {
    budget: { ...TIMEOUT_BUDGETS.ipfs, ...overrides },
    dependency: 'ipfs',
    operation,
  });
}

/**
 * Wrap a shutdown operation with shutdown timeout budget.
 */
export function withShutdownTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  operation: string,
  overrides?: Partial<TimeoutBudget>
): Promise<T> {
  return withTimeout(fn, {
    budget: { ...TIMEOUT_BUDGETS.shutdown, ...overrides },
    dependency: 'shutdown',
    operation,
  });
}

// ── Deadline Enforcement for Retry Operations ───────────────────────────────────

/**
 * Ensure that retry operations fit within the caller's overall deadline.
 * Returns the remaining budget or throws if deadline is exceeded.
 */
export function enforceDeadline(startTime: number, totalBudgetMs: number, operation: string): number {
  const elapsed = Date.now() - startTime;
  const remaining = totalBudgetMs - elapsed;
  
  if (remaining <= 0) {
    throw new TimeoutError(operation, totalBudgetMs);
  }
  
  return remaining;
}

/**
 * Calculate how many retry attempts can fit within the remaining budget.
 */
export function calculateRetryAttempts(
  remainingMs: number,
  baseDelayMs: number,
  maxDelayMs: number,
  maxAttempts: number
): number {
  let totalEstimate = 0;
  let attempts = 1; // Start with 1 (initial attempt)
  
  for (let i = 0; i < maxAttempts - 1; i++) {
    const delay = Math.min(baseDelayMs * Math.pow(2, i), maxDelayMs);
    if (totalEstimate + delay > remainingMs) {
      break;
    }
    totalEstimate += delay;
    attempts++;
  }
  
  return attempts;
}
