/**
 * retry.test.ts
 *
 * Unit tests for the exponential-backoff retry module and circuit breaker.
 *
 * All tests use baseDelayMs: 0 / jitterFactor: 0 to avoid real waits.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock prom-client BEFORE importing retry ───────────────────────────────────
// prom-client uses module-level singletons; we must prevent double-registration
// across tests by replacing it with a simple stub.

vi.mock('prom-client', () => {
  const makeMetric = () => ({
    labels: vi.fn().mockReturnThis(),
    set:    vi.fn(),
    inc:    vi.fn(),
    observe: vi.fn(),
    startTimer: vi.fn(() => vi.fn()),
  });

  return {
    default: {
      Gauge:   vi.fn(function() { return makeMetric(); }),
      Counter: vi.fn(function() { return makeMetric(); }),
      Histogram: vi.fn(function() { return makeMetric(); }),
      collectDefaultMetrics: vi.fn(),
      register: {
        contentType: 'text/plain',
        metrics: vi.fn().mockResolvedValue(''),
        getSingleMetric: vi.fn().mockReturnValue(null),
      },
    },
  };
});

const mockRpcRetryExhaustedCounter = vi.hoisted(() => ({ inc: vi.fn() }));

vi.mock('../metrics.js', () => ({
  rpcRetryExhaustedCounter: mockRpcRetryExhaustedCounter,
  decodeErrorsCounter: { inc: vi.fn() },
  eventDecodeErrorsCounter: { inc: vi.fn() },
  stalledGauge: { set: vi.fn() },
  latestLedgerProcessedGauge: { set: vi.fn() },
  networkLatestLedgerGauge: { set: vi.fn() },
  syncLatencyGauge: { set: vi.fn() },
}));

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  withRetry,
  withExponentialBackoff,
  withRpcRetry,
  withDbRetry,
  withIpfsRetry,
  CircuitBreaker,
  CircuitOpenError,
  isRpcRetryable,
  isDbRetryable,
  isIpfsRetryable,
  STELLAR_RPC_RETRY_CONFIG,
  DB_RETRY_CONFIG,
  IPFS_RETRY_CONFIG,
  circuitBreakers,
} from '../retry.js';

// Reset all singleton circuit breakers before each test so circuit state
// does not leak across describe blocks.
beforeEach(() => {
  vi.clearAllMocks();
  // Force all singletons back to closed by recording a success
  Object.values(circuitBreakers).forEach((cb) => cb.recordSuccess());
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeHttpError(status: number): Error {
  const err = new Error(`HTTP ${status}`) as any;
  err.response = { status };
  return err as Error;
}

function makeNetworkError(code: string): Error {
  const err = new Error(`Network error: ${code}`) as any;
  err.code = code;
  return err as Error;
}

// ── withRetry (legacy API) ────────────────────────────────────────────────────

describe('withRetry (legacy)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns result immediately on first success', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 0, jitterMs: 0 });
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries after a transient failure and returns on second attempt', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue('recovered');

    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 0, jitterMs: 0 });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries the configured number of times before giving up', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('persistent'));

    await expect(
      withRetry(fn, { maxAttempts: 4, baseDelayMs: 0, jitterMs: 0 })
    ).rejects.toThrow('persistent');

    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('increments rpcRetryExhaustedCounter with the operation label on exhaustion', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('rpc down'));

    await withRetry(fn, {
      maxAttempts: 2,
      baseDelayMs: 0,
      jitterMs: 0,
      operation: 'getLatestLedger',
    }).catch(() => {});

    expect(mockRpcRetryExhaustedCounter.inc).toHaveBeenCalledOnce();
    expect(mockRpcRetryExhaustedCounter.inc).toHaveBeenCalledWith({ operation: 'getLatestLedger' });
  });

  it('does NOT increment the counter when the function eventually succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValue('ok');

    await withRetry(fn, { maxAttempts: 3, baseDelayMs: 0, jitterMs: 0 });
    expect(mockRpcRetryExhaustedCounter.inc).not.toHaveBeenCalled();
  });

  it('re-throws the last error so the caller can handle it', async () => {
    const err = new Error('root cause');
    const fn = vi.fn().mockRejectedValue(err);

    await expect(
      withRetry(fn, { maxAttempts: 2, baseDelayMs: 0, jitterMs: 0 })
    ).rejects.toBe(err);
  });

  it('uses default operation label when none is provided', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('err'));
    await withRetry(fn, { maxAttempts: 1, baseDelayMs: 0, jitterMs: 0 }).catch(() => {});
    expect(mockRpcRetryExhaustedCounter.inc).toHaveBeenCalledWith({ operation: 'rpc' });
  });
});

// ── withExponentialBackoff — backoff timing ───────────────────────────────────

describe('withExponentialBackoff — backoff timing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('computes delay as base * 2^n * (1 + jitter) capped at maxDelay', async () => {
    const delays: number[] = [];
    vi.spyOn(global, 'setTimeout').mockImplementation((fn: any, ms: number) => {
      delays.push(ms);
      fn();
      return 0 as any;
    });

    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockRejectedValueOnce(new Error('fail2'))
      .mockResolvedValue('ok');

    await withExponentialBackoff(fn, {
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 10_000,
      jitterFactor: 0,  // no jitter — deterministic
    });

    // attempt 1 failed → delay = 100 * 2^0 * 1 = 100
    // attempt 2 failed → delay = 100 * 2^1 * 1 = 200
    expect(delays[0]).toBeCloseTo(100, -1);
    expect(delays[1]).toBeCloseTo(200, -1);

    vi.restoreAllMocks();
  });

  it('caps delay at maxDelayMs', async () => {
    const delays: number[] = [];
    vi.spyOn(global, 'setTimeout').mockImplementation((fn: any, ms: number) => {
      delays.push(ms);
      fn();
      return 0 as any;
    });

    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('x'))
      .mockRejectedValueOnce(new Error('x'))
      .mockRejectedValueOnce(new Error('x'))
      .mockResolvedValue('ok');

    await withExponentialBackoff(fn, {
      maxAttempts: 4,
      baseDelayMs: 1_000,
      maxDelayMs: 1_500,
      jitterFactor: 0,
    });

    // All delays capped at 1_500
    for (const d of delays) {
      expect(d).toBeLessThanOrEqual(1_500);
    }

    vi.restoreAllMocks();
  });

  it('jitter is within [0, base * jitterFactor] for each attempt', async () => {
    const delays: number[] = [];
    vi.spyOn(global, 'setTimeout').mockImplementation((fn: any, ms: number) => {
      delays.push(ms);
      fn();
      return 0 as any;
    });

    // Spy on Math.random to be deterministic
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('a'))
      .mockResolvedValue('ok');

    await withExponentialBackoff(fn, {
      maxAttempts: 2,
      baseDelayMs: 100,
      maxDelayMs: 100_000,
      jitterFactor: 0.3,
    });

    // delay = 100 * 2^0 * (1 + 0.5 * 0.3) = 100 * 1.15 = 115
    expect(delays[0]).toBeCloseTo(115, 0);

    vi.restoreAllMocks();
  });

  it('never sleeps when baseDelayMs is 0', async () => {
    const setSpy = vi.spyOn(global, 'setTimeout');

    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValue('ok');

    await withExponentialBackoff(fn, { maxAttempts: 2, baseDelayMs: 0, jitterFactor: 0 });

    // setTimeout should have been called with 0ms
    for (const call of setSpy.mock.calls) {
      expect(call[1]).toBe(0);
    }

    vi.restoreAllMocks();
  });
});

// ── Non-retryable errors ──────────────────────────────────────────────────────

describe('withExponentialBackoff — non-retryable errors', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not retry when retryable returns false', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fatal'));

    await expect(
      withExponentialBackoff(fn, {
        maxAttempts: 5,
        baseDelayMs: 0,
        retryable: () => false,
      })
    ).rejects.toThrow('fatal');

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not increment exhausted counter on non-retryable error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fatal'));

    await withExponentialBackoff(fn, {
      maxAttempts: 5,
      baseDelayMs: 0,
      retryable: () => false,
    }).catch(() => {});

    expect(mockRpcRetryExhaustedCounter.inc).not.toHaveBeenCalled();
  });

  it('retries retryable errors and stops on non-retryable', async () => {
    const retryableErr = new Error('transient');
    const fatalErr = new Error('404 not found') as any;
    fatalErr.response = { status: 404 };

    const fn = vi.fn()
      .mockRejectedValueOnce(retryableErr)
      .mockRejectedValue(fatalErr);

    await expect(
      withExponentialBackoff(fn, {
        maxAttempts: 5,
        baseDelayMs: 0,
        retryable: (err: unknown) => !((err as any)?.response?.status === 404),
      })
    ).rejects.toBe(fatalErr);

    // First attempt (retried) + second attempt (non-retryable, throws immediately)
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// ── Retryability predicates ───────────────────────────────────────────────────

describe('isRpcRetryable', () => {
  it('retries on network errors (ECONNRESET)', () => {
    expect(isRpcRetryable(makeNetworkError('ECONNRESET'))).toBe(true);
  });

  it('retries on 429 rate-limit', () => {
    expect(isRpcRetryable(makeHttpError(429))).toBe(true);
  });

  it('retries on 500 server error', () => {
    expect(isRpcRetryable(makeHttpError(500))).toBe(true);
  });

  it('does NOT retry on 404', () => {
    expect(isRpcRetryable(makeHttpError(404))).toBe(false);
  });

  it('does NOT retry on 400 bad request', () => {
    expect(isRpcRetryable(makeHttpError(400))).toBe(false);
  });
});

describe('isDbRetryable', () => {
  it('retries on connection timeout', () => {
    const err = new Error('connection timeout');
    expect(isDbRetryable(err)).toBe(true);
  });

  it('retries on pool exhaustion', () => {
    const err = new Error('pool queue full');
    expect(isDbRetryable(err)).toBe(true);
  });

  it('retries on P1001 Prisma error code', () => {
    const err = new Error('P1001: Can\'t reach database server');
    expect(isDbRetryable(err)).toBe(true);
  });

  it('does NOT retry on unique constraint violations', () => {
    const err = new Error('Unique constraint failed on the fields: (`listingId`)');
    expect(isDbRetryable(err)).toBe(false);
  });

  it('does NOT retry on invalid data errors', () => {
    const err = new Error('Invalid data: expected string got number');
    expect(isDbRetryable(err)).toBe(false);
  });
});

describe('isIpfsRetryable', () => {
  it('retries on 504 gateway timeout', () => {
    expect(isIpfsRetryable(makeHttpError(504))).toBe(true);
  });

  it('retries on 503 service unavailable', () => {
    expect(isIpfsRetryable(makeHttpError(503))).toBe(true);
  });

  it('retries on 429 rate-limit', () => {
    expect(isIpfsRetryable(makeHttpError(429))).toBe(true);
  });

  it('retries on network errors', () => {
    expect(isIpfsRetryable(makeNetworkError('ETIMEDOUT'))).toBe(true);
  });

  it('does NOT retry on 404 not found', () => {
    expect(isIpfsRetryable(makeHttpError(404))).toBe(false);
  });
});

// ── Per-dependency configs ────────────────────────────────────────────────────

describe('per-dependency retry configs', () => {
  it('STELLAR_RPC_RETRY_CONFIG has correct values', () => {
    expect(STELLAR_RPC_RETRY_CONFIG.maxAttempts).toBe(5);
    expect(STELLAR_RPC_RETRY_CONFIG.baseDelayMs).toBe(500);
    expect(STELLAR_RPC_RETRY_CONFIG.maxDelayMs).toBe(30_000);
    expect(typeof STELLAR_RPC_RETRY_CONFIG.jitterFactor).toBe('number');
    expect(STELLAR_RPC_RETRY_CONFIG.retryable).toBeTypeOf('function');
  });

  it('DB_RETRY_CONFIG has correct values', () => {
    expect(DB_RETRY_CONFIG.maxAttempts).toBe(3);
    expect(DB_RETRY_CONFIG.baseDelayMs).toBe(100);
    expect(DB_RETRY_CONFIG.maxDelayMs).toBe(5_000);
    expect(DB_RETRY_CONFIG.retryable).toBeTypeOf('function');
  });

  it('IPFS_RETRY_CONFIG has correct values', () => {
    expect(IPFS_RETRY_CONFIG.maxAttempts).toBe(3);
    expect(IPFS_RETRY_CONFIG.baseDelayMs).toBe(1_000);
    expect(IPFS_RETRY_CONFIG.maxDelayMs).toBe(10_000);
    expect(IPFS_RETRY_CONFIG.retryable).toBeTypeOf('function');
  });
});

// ── CircuitBreaker state transitions ─────────────────────────────────────────

describe('CircuitBreaker', () => {
  function makeCb(overrides: Partial<{ failureThreshold: number; resetTimeoutMs: number }> = {}) {
    return new CircuitBreaker({
      dependency: 'test',
      failureThreshold: overrides.failureThreshold ?? 3,
      resetTimeoutMs:   overrides.resetTimeoutMs   ?? 60_000,
    });
  }

  it('starts closed', () => {
    const cb = makeCb();
    expect(cb.getState()).toBe('closed');
  });

  it('stays closed below the failure threshold', () => {
    const cb = makeCb({ failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('closed');
  });

  it('opens after exactly failureThreshold consecutive failures', () => {
    const cb = makeCb({ failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
  });

  it('resets failure counter and closes on success', () => {
    const cb = makeCb({ failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    // Only 2 failures, then reset — should still be closed
    expect(cb.getState()).toBe('closed');

    // Now needs 3 more consecutive failures to open
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('closed');
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
  });

  it('transitions to half-open after resetTimeoutMs', async () => {
    const cb = makeCb({ failureThreshold: 2, resetTimeoutMs: 50 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('open');

    await new Promise((r) => setTimeout(r, 60));
    expect(cb.getState()).toBe('half-open');
  });

  it('closes after one success in half-open state', async () => {
    const cb = makeCb({ failureThreshold: 2, resetTimeoutMs: 50 });
    cb.recordFailure();
    cb.recordFailure();

    await new Promise((r) => setTimeout(r, 60));
    expect(cb.getState()).toBe('half-open');

    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');
  });

  it('goes back to open when probe fails in half-open state', async () => {
    const cb = makeCb({ failureThreshold: 2, resetTimeoutMs: 50 });
    cb.recordFailure();
    cb.recordFailure();

    await new Promise((r) => setTimeout(r, 60));
    expect(cb.getState()).toBe('half-open');

    cb.recordFailure();
    expect(cb.getState()).toBe('open');
  });
});

// ── Circuit breaker integration with withExponentialBackoff ───────────────────

describe('withExponentialBackoff + circuit breaker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws CircuitOpenError immediately when circuit is open', async () => {
    const cb = new CircuitBreaker({ dependency: 'test-open', failureThreshold: 1 });
    cb.recordFailure(); // opens the circuit
    expect(cb.getState()).toBe('open');

    const fn = vi.fn().mockResolvedValue('ok');

    await expect(
      withExponentialBackoff(fn, { maxAttempts: 3, baseDelayMs: 0 }, cb)
    ).rejects.toThrow(CircuitOpenError);

    // fn should never have been called
    expect(fn).not.toHaveBeenCalled();
  });

  it('records success and closes the circuit on a successful call', async () => {
    const cb = new CircuitBreaker({ dependency: 'test-success', failureThreshold: 5 });
    cb.recordFailure();
    cb.recordFailure(); // 2 failures, still closed

    const fn = vi.fn().mockResolvedValue('good');
    await withExponentialBackoff(fn, { maxAttempts: 1, baseDelayMs: 0 }, cb);

    expect(cb.getState()).toBe('closed');
  });

  it('records failure and can open circuit after enough withExponentialBackoff exhaustions', async () => {
    const cb = new CircuitBreaker({ dependency: 'test-open-auto', failureThreshold: 2 });

    const fn = vi.fn().mockRejectedValue(new Error('down'));

    // First call: 1 attempt → 1 failure recorded
    await withExponentialBackoff(fn, { maxAttempts: 1, baseDelayMs: 0 }, cb).catch(() => {});
    expect(cb.getState()).toBe('closed');

    // Second call: 1 attempt → 2nd failure → circuit opens
    await withExponentialBackoff(fn, { maxAttempts: 1, baseDelayMs: 0 }, cb).catch(() => {});
    expect(cb.getState()).toBe('open');

    // Third call: fast-fails with CircuitOpenError
    await expect(
      withExponentialBackoff(fn, { maxAttempts: 1, baseDelayMs: 0 }, cb)
    ).rejects.toThrow(CircuitOpenError);
  });
});

// ── Convenience wrappers ──────────────────────────────────────────────────────

describe('withRpcRetry', () => {
  it('succeeds on first attempt', async () => {
    const fn = vi.fn().mockResolvedValue(42);
    await expect(withRpcRetry(fn, { baseDelayMs: 0, jitterFactor: 0 })).resolves.toBe(42);
  });

  it('does not retry 404 (non-retryable)', async () => {
    const fn = vi.fn().mockRejectedValue(makeHttpError(404));
    await expect(withRpcRetry(fn, { baseDelayMs: 0 })).rejects.toThrow('HTTP 404');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries 429 rate-limit responses', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(makeHttpError(429))
      .mockResolvedValue('ok');
    await expect(withRpcRetry(fn, { baseDelayMs: 0, jitterFactor: 0 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('withDbRetry', () => {
  it('succeeds on first attempt', async () => {
    const fn = vi.fn().mockResolvedValue('row');
    await expect(withDbRetry(fn, { baseDelayMs: 0, jitterFactor: 0 })).resolves.toBe('row');
  });

  it('does not retry constraint violations', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Unique constraint failed'));
    await expect(withDbRetry(fn, { baseDelayMs: 0 })).rejects.toThrow('Unique constraint failed');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on connection timeout', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('connection timeout'))
      .mockResolvedValue('ok');
    await expect(withDbRetry(fn, { baseDelayMs: 0, jitterFactor: 0 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('withIpfsRetry', () => {
  it('succeeds on first attempt', async () => {
    const fn = vi.fn().mockResolvedValue({ title: 'art' });
    await expect(withIpfsRetry(fn, { baseDelayMs: 0, jitterFactor: 0 })).resolves.toEqual({ title: 'art' });
  });

  it('does not retry 404', async () => {
    const fn = vi.fn().mockRejectedValue(makeHttpError(404));
    await expect(withIpfsRetry(fn, { baseDelayMs: 0 })).rejects.toThrow('HTTP 404');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries 504 gateway timeout', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(makeHttpError(504))
      .mockResolvedValue({ title: 'ok' });
    await expect(withIpfsRetry(fn, { baseDelayMs: 0, jitterFactor: 0 })).resolves.toEqual({ title: 'ok' });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
