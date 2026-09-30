/**
 * retry-timeout-integration.test.ts
 *
 * Integration tests for retry wrapper with timeout enforcement.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  withExponentialBackoff,
  STELLAR_RPC_RETRY_CONFIG,
  DB_RETRY_CONFIG,
  IPFS_RETRY_CONFIG,
  REDIS_RETRY_CONFIG,
  CircuitBreaker,
  CircuitOpenError,
} from '../retry.js';
import { TimeoutError, CancellationError, TIMEOUT_BUDGETS } from '../timeout.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockLogger = vi.fn();
vi.mock('../logger.js', () => ({
  logger: {
    warn: mockLogger,
    error: mockLogger,
  },
}));

const mockRpcRetryExhaustedCounter = vi.fn();
vi.mock('../metrics.js', () => ({
  rpcRetryExhaustedCounter: { inc: mockRpcRetryExhaustedCounter },
}));

// ── Reset mocks before each test ─────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockLogger.mockReset();
  mockRpcRetryExhaustedCounter.mockReset();
});

// ── Retry with Timeout Integration Tests ───────────────────────────────────────

describe('withExponentialBackoff with timeout budget', () => {
  it('should respect timeout budget and not retry on timeout', async () => {
    const fn = vi.fn().mockImplementation(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), 2000))
    );
    
    const breaker = new CircuitBreaker({ dependency: 'test', failureThreshold: 5, resetTimeoutMs: 60000 });
    
    await expect(
      withExponentialBackoff(
        fn,
        {
          ...STELLAR_RPC_RETRY_CONFIG,
          timeoutBudget: {
            operationTimeoutMs: 100,
            totalBudgetMs: 500,
            useAbortSignal: true,
          },
        },
        breaker
      )
    ).rejects.toThrow(TimeoutError);

    // Should only attempt once (timeout on first attempt, no retry)
    expect(fn).toHaveBeenCalledTimes(1);
    expect(mockRpcRetryExhaustedCounter).not.toHaveBeenCalled();
  });

  it('should adjust retry attempts based on remaining budget', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('transient'));
    
    const breaker = new CircuitBreaker({ dependency: 'test', failureThreshold: 5, resetTimeoutMs: 60000 });
    
    await expect(
      withExponentialBackoff(
        fn,
        {
          maxAttempts: 5,
          baseDelayMs: 100,
          maxDelayMs: 1000,
          timeoutBudget: {
            operationTimeoutMs: 50,
            totalBudgetMs: 200,
            useAbortSignal: true,
          },
        },
        breaker
      )
    ).rejects.toThrow();

    // With short budget, should attempt fewer than maxAttempts
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry within budget when timeout allows', async () => {
    let attemptCount = 0;
    const fn = vi.fn().mockImplementation(() => {
      attemptCount++;
      if (attemptCount < 2) {
        return Promise.reject(new Error('transient'));
      }
      return Promise.resolve('success');
    });
    
    const breaker = new CircuitBreaker({ dependency: 'test', failureThreshold: 5, resetTimeoutMs: 60000 });
    
    const result = await withExponentialBackoff(
      fn,
      {
        maxAttempts: 5,
        baseDelayMs: 50,
        maxDelayMs: 100,
        timeoutBudget: {
          operationTimeoutMs: 1000,
          totalBudgetMs: 5000,
          useAbortSignal: true,
        },
      },
      breaker
    );

    expect(result).toBe('success');
    expect(attemptCount).toBe(2);
  });

  it('should not retry on cancellation error', async () => {
    const fn = vi.fn().mockRejectedValue(new CancellationError('user_cancelled'));
    
    const breaker = new CircuitBreaker({ dependency: 'test', failureThreshold: 5, resetTimeoutMs: 60000 });
    
    await expect(
      withExponentialBackoff(
        fn,
        {
          ...STELLAR_RPC_RETRY_CONFIG,
          timeoutBudget: TIMEOUT_BUDGETS.rpc,
        },
        breaker
      )
    ).rejects.toThrow(CancellationError);

    // Should not retry cancellation errors
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should work without timeout budget (backward compatibility)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('transient'));
    
    const breaker = new CircuitBreaker({ dependency: 'test', failureThreshold: 5, resetTimeoutMs: 60000 });
    
    await expect(
      withExponentialBackoff(
        fn,
        {
          maxAttempts: 3,
          baseDelayMs: 10,
          maxDelayMs: 100,
        },
        breaker
      )
    ).rejects.toThrow();

    // Should attempt all configured attempts
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

// ── Circuit Breaker Integration Tests ───────────────────────────────────────────

describe('circuit breaker with timeout', () => {
  it('should fast-fail when circuit is open', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    
    const breaker = new CircuitBreaker({ dependency: 'test', failureThreshold: 2, resetTimeoutMs: 60000 });
    
    // Force circuit open
    breaker.recordFailure();
    breaker.recordFailure();
    
    await expect(
      withExponentialBackoff(
        fn,
        {
          ...STELLAR_RPC_RETRY_CONFIG,
          timeoutBudget: TIMEOUT_BUDGETS.rpc,
        },
        breaker
      )
    ).rejects.toThrow(CircuitOpenError);

    // Should not attempt when circuit is open
    expect(fn).not.toHaveBeenCalled();
  });

  it('should record success and close circuit on successful retry', async () => {
    let attemptCount = 0;
    const fn = vi.fn().mockImplementation(() => {
      attemptCount++;
      if (attemptCount < 2) {
        return Promise.reject(new Error('transient'));
      }
      return Promise.resolve('success');
    });
    
    const breaker = new CircuitBreaker({ dependency: 'test', failureThreshold: 5, resetTimeoutMs: 60000 });
    
    const result = await withExponentialBackoff(
      fn,
      {
        maxAttempts: 5,
        baseDelayMs: 10,
        maxDelayMs: 100,
        timeoutBudget: TIMEOUT_BUDGETS.rpc,
      },
      breaker
    );

    expect(result).toBe('success');
    expect(breaker.getState()).toBe('closed');
  });
});

// ── Per-Dependency Config Tests ───────────────────────────────────────────────────

describe('per-dependency retry configs', () => {
  it('RPC config should have timeout budget', () => {
    expect(STELLAR_RPC_RETRY_CONFIG.timeoutBudget).toBeDefined();
    expect(STELLAR_RPC_RETRY_CONFIG.timeoutBudget?.operationTimeoutMs).toBe(10_000);
    expect(STELLAR_RPC_RETRY_CONFIG.timeoutBudget?.totalBudgetMs).toBe(60_000);
  });

  it('DB config should have timeout budget', () => {
    expect(DB_RETRY_CONFIG.timeoutBudget).toBeDefined();
    expect(DB_RETRY_CONFIG.timeoutBudget?.operationTimeoutMs).toBe(5_000);
    expect(DB_RETRY_CONFIG.timeoutBudget?.totalBudgetMs).toBe(30_000);
  });

  it('IPFS config should have timeout budget', () => {
    expect(IPFS_RETRY_CONFIG.timeoutBudget).toBeDefined();
    expect(IPFS_RETRY_CONFIG.timeoutBudget?.operationTimeoutMs).toBe(15_000);
    expect(IPFS_RETRY_CONFIG.timeoutBudget?.totalBudgetMs).toBe(45_000);
  });

  it('Redis config should have timeout budget', () => {
    expect(REDIS_RETRY_CONFIG.timeoutBudget).toBeDefined();
    expect(REDIS_RETRY_CONFIG.timeoutBudget?.operationTimeoutMs).toBe(2_000);
    expect(REDIS_RETRY_CONFIG.timeoutBudget?.totalBudgetMs).toBe(10_000);
  });
});

// ── Abort Signal Propagation Tests ─────────────────────────────────────────────

describe('abort signal propagation in retry', () => {
  it('should propagate abort signal to retry attempts', async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockImplementation(
      (signal: AbortSignal) => {
        if (signal.aborted) throw new CancellationError('aborted');
        return Promise.reject(new Error('transient'));
      }
    );
    
    const breaker = new CircuitBreaker({ dependency: 'test', failureThreshold: 5, resetTimeoutMs: 60000 });
    
    // Abort after first attempt
    setTimeout(() => controller.abort('user_request'), 50);
    
    await expect(
      withExponentialBackoff(
        fn,
        {
          maxAttempts: 5,
          baseDelayMs: 100,
          maxDelayMs: 1000,
          timeoutBudget: TIMEOUT_BUDGETS.rpc,
          signal: controller.signal,
        },
        breaker
      )
    ).rejects.toThrow(CancellationError);
  });

  it('should combine timeout signal with parent signal', async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockImplementation(
      (signal: AbortSignal) => {
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new CancellationError('aborted')));
        });
      }
    );
    
    const breaker = new CircuitBreaker({ dependency: 'test', failureThreshold: 5, resetTimeoutMs: 60000 });
    
    // Abort parent immediately
    controller.abort('parent_cancelled');
    
    await expect(
      withExponentialBackoff(
        fn,
        {
          maxAttempts: 5,
          baseDelayMs: 100,
          maxDelayMs: 1000,
          timeoutBudget: TIMEOUT_BUDGETS.rpc,
          signal: controller.signal,
        },
        breaker
      )
    ).rejects.toThrow(CancellationError);
  });
});
