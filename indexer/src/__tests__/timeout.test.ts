/**
 * timeout.test.ts
 *
 * Tests for timeout budgets, abort signal propagation, and cancellation semantics.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  withTimeout,
  withRpcTimeout,
  withDbTimeout,
  withRedisTimeout,
  withIpfsTimeout,
  withShutdownTimeout,
  TIMEOUT_BUDGETS,
  TimeoutError,
  CancellationError,
  ProviderError,
  enforceDeadline,
  calculateRetryAttempts,
} from '../timeout.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockTimeoutCounter = vi.fn();
const mockCancellationCounter = vi.fn();
const mockProviderErrorCounter = vi.fn();

vi.mock('../timeout.js', async () => {
  const actual = await vi.importActual<any>('../timeout.js');
  return {
    ...actual,
    timeoutCounter: { inc: mockTimeoutCounter },
    cancellationCounter: { inc: mockCancellationCounter },
    providerErrorCounter: { inc: mockProviderErrorCounter },
  };
});

// ── Reset mocks before each test ─────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockTimeoutCounter.mockReset();
  mockCancellationCounter.mockReset();
  mockProviderErrorCounter.mockReset();
});

// ── Timeout Budget Tests ───────────────────────────────────────────────────────

describe('TIMEOUT_BUDGETS', () => {
  it('should have defined budgets for all dependencies', () => {
    expect(TIMEOUT_BUDGETS.rpc).toBeDefined();
    expect(TIMEOUT_BUDGETS.db).toBeDefined();
    expect(TIMEOUT_BUDGETS.redis).toBeDefined();
    expect(TIMEOUT_BUDGETS.ipfs).toBeDefined();
    expect(TIMEOUT_BUDGETS.shutdown).toBeDefined();
  });

  it('should have reasonable timeout values', () => {
    expect(TIMEOUT_BUDGETS.rpc.operationTimeoutMs).toBeGreaterThan(0);
    expect(TIMEOUT_BUDGETS.rpc.totalBudgetMs).toBeGreaterThan(TIMEOUT_BUDGETS.rpc.operationTimeoutMs);
    expect(TIMEOUT_BUDGETS.db.operationTimeoutMs).toBeGreaterThan(0);
    expect(TIMEOUT_BUDGETS.db.totalBudgetMs).toBeGreaterThan(TIMEOUT_BUDGETS.db.operationTimeoutMs);
  });

  it('should have useAbortSignal enabled by default', () => {
    expect(TIMEOUT_BUDGETS.rpc.useAbortSignal).toBe(true);
    expect(TIMEOUT_BUDGETS.db.useAbortSignal).toBe(true);
    expect(TIMEOUT_BUDGETS.redis.useAbortSignal).toBe(true);
    expect(TIMEOUT_BUDGETS.ipfs.useAbortSignal).toBe(true);
    expect(TIMEOUT_BUDGETS.shutdown.useAbortSignal).toBe(true);
  });
});

// ── withTimeout Tests ───────────────────────────────────────────────────────────

describe('withTimeout', () => {
  it('should complete successfully within timeout', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    
    const result = await withTimeout(
      fn,
      {
        budget: { operationTimeoutMs: 1000, totalBudgetMs: 5000, useAbortSignal: true },
        dependency: 'test',
        operation: 'test_operation',
      }
    );

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(mockTimeoutCounter).not.toHaveBeenCalled();
    expect(mockCancellationCounter).not.toHaveBeenCalled();
    expect(mockProviderErrorCounter).not.toHaveBeenCalled();
  });

  it('should throw TimeoutError when operation exceeds timeout', async () => {
    const fn = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 2000))
    );
    
    await expect(
      withTimeout(
        fn,
        {
          budget: { operationTimeoutMs: 100, totalBudgetMs: 5000, useAbortSignal: true },
          dependency: 'test',
          operation: 'test_operation',
        }
      )
    ).rejects.toThrow(TimeoutError);

    expect(mockTimeoutCounter).toHaveBeenCalledWith({ dependency: 'test', operation: 'test_operation' });
  });

  it('should throw CancellationError when parent signal aborts', async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockImplementation(
      (signal: AbortSignal) => {
        if (signal.aborted) throw new Error('aborted');
        return new Promise((resolve) => setTimeout(resolve, 1000));
      }
    );
    
    // Abort immediately
    controller.abort('user_cancelled');
    
    await expect(
      withTimeout(
        fn,
        {
          budget: { operationTimeoutMs: 5000, totalBudgetMs: 10000, useAbortSignal: true },
          signal: controller.signal,
          dependency: 'test',
          operation: 'test_operation',
        }
      )
    ).rejects.toThrow(CancellationError);

    expect(mockCancellationCounter).toHaveBeenCalledWith({ dependency: 'test', reason: 'user_cancelled' });
  });

  it('should wrap provider errors in ProviderError', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('connection failed'));
    
    await expect(
      withTimeout(
        fn,
        {
          budget: { operationTimeoutMs: 5000, totalBudgetMs: 10000, useAbortSignal: true },
          dependency: 'test',
          operation: 'test_operation',
        }
      )
    ).rejects.toThrow(ProviderError);

    expect(mockProviderErrorCounter).toHaveBeenCalledWith({ dependency: 'test', error_type: 'Error' });
  });

  it('should pass AbortSignal to the function', async () => {
    const fn = vi.fn().mockImplementation(
      (signal: AbortSignal) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        return Promise.resolve('success');
      }
    );
    
    await withTimeout(
      fn,
      {
        budget: { operationTimeoutMs: 5000, totalBudgetMs: 10000, useAbortSignal: true },
        dependency: 'test',
        operation: 'test_operation',
      }
    );

    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ── Convenience Wrapper Tests ───────────────────────────────────────────────────

describe('withRpcTimeout', () => {
  it('should use RPC timeout budget', async () => {
    const fn = vi.fn().mockResolvedValue('rpc_success');
    
    const result = await withRpcTimeout(fn, 'getLatestLedger');
    
    expect(result).toBe('rpc_success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should allow overriding budget', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    
    await withRpcTimeout(fn, 'getLatestLedger', {
      operationTimeoutMs: 500,
      totalBudgetMs: 2000,
    });

    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('withDbTimeout', () => {
  it('should use DB timeout budget', async () => {
    const fn = vi.fn().mockResolvedValue('db_success');
    
    const result = await withDbTimeout(fn, 'query_listings');
    
    expect(result).toBe('db_success');
  });
});

describe('withRedisTimeout', () => {
  it('should use Redis timeout budget', async () => {
    const fn = vi.fn().mockResolvedValue('redis_success');
    
    const result = await withRedisTimeout(fn, 'get_cache');
    
    expect(result).toBe('redis_success');
  });
});

describe('withIpfsTimeout', () => {
  it('should use IPFS timeout budget', async () => {
    const fn = vi.fn().mockResolvedValue('ipfs_success');
    
    const result = await withIpfsTimeout(fn, 'fetch_metadata');
    
    expect(result).toBe('ipfs_success');
  });
});

describe('withShutdownTimeout', () => {
  it('should use shutdown timeout budget', async () => {
    const fn = vi.fn().mockResolvedValue('shutdown_complete');
    
    const result = await withShutdownTimeout(fn, 'cleanup_resources');
    
    expect(result).toBe('shutdown_complete');
  });
});

// ── Deadline Enforcement Tests ───────────────────────────────────────────────────

describe('enforceDeadline', () => {
  it('should return remaining budget when not exceeded', () => {
    const startTime = Date.now() - 1000; // 1 second elapsed
    const totalBudgetMs = 10000; // 10 seconds total
    
    const remaining = enforceDeadline(startTime, totalBudgetMs, 'test_operation');
    
    expect(remaining).toBe(9000);
  });

  it('should throw TimeoutError when deadline exceeded', () => {
    const startTime = Date.now() - 11000; // 11 seconds elapsed
    const totalBudgetMs = 10000; // 10 seconds total
    
    expect(() => enforceDeadline(startTime, totalBudgetMs, 'test_operation')).toThrow(TimeoutError);
  });

  it('should throw TimeoutError with operation name', () => {
    const startTime = Date.now() - 11000;
    const totalBudgetMs = 10000;
    
    expect(() => enforceDeadline(startTime, totalBudgetMs, 'my_operation')).toThrow(TimeoutError);
    expect(() => enforceDeadline(startTime, totalBudgetMs, 'my_operation')).toThrow('my_operation');
  });
});

// ── Retry Calculation Tests ───────────────────────────────────────────────────

describe('calculateRetryAttempts', () => {
  it('should calculate attempts that fit within budget', () => {
    const remainingMs = 10000;
    const baseDelayMs = 500;
    const maxDelayMs = 5000;
    const maxAttempts = 5;
    
    const attempts = calculateRetryAttempts(remainingMs, baseDelayMs, maxDelayMs, maxAttempts);
    
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThanOrEqual(maxAttempts);
  });

  it('should return 1 when budget is too small for any retry', () => {
    const remainingMs = 100;
    const baseDelayMs = 500;
    const maxDelayMs = 5000;
    const maxAttempts = 5;
    
    const attempts = calculateRetryAttempts(remainingMs, baseDelayMs, maxDelayMs, maxAttempts);
    
    expect(attempts).toBe(1);
  });

  it('should return maxAttempts when budget allows all retries', () => {
    const remainingMs = 100000;
    const baseDelayMs = 100;
    const maxDelayMs = 1000;
    const maxAttempts = 5;
    
    const attempts = calculateRetryAttempts(remainingMs, baseDelayMs, maxDelayMs, maxAttempts);
    
    expect(attempts).toBe(maxAttempts);
  });

  it('should respect maxDelayMs ceiling', () => {
    const remainingMs = 10000;
    const baseDelayMs = 100;
    const maxDelayMs = 200;
    const maxAttempts = 10;
    
    const attempts = calculateRetryAttempts(remainingMs, baseDelayMs, maxDelayMs, maxAttempts);
    
    // With maxDelayMs=200, exponential backoff will cap quickly
    expect(attempts).toBeLessThan(maxAttempts);
  });
});

// ── Signal Combination Tests ───────────────────────────────────────────────────

describe('abort signal combination', () => {
  it('should abort when timeout signal fires', async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockImplementation(
      (signal: AbortSignal) => {
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
    );
    
    // Abort after short delay
    setTimeout(() => controller.abort('timeout'), 50);
    
    await expect(
      withTimeout(
        fn,
        {
          budget: { operationTimeoutMs: 100, totalBudgetMs: 1000, useAbortSignal: true },
          dependency: 'test',
          operation: 'test_operation',
        }
      )
    ).rejects.toThrow();
  });

  it('should abort when parent signal fires', async () => {
    const parentController = new AbortController();
    const fn = vi.fn().mockImplementation(
      (signal: AbortSignal) => {
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
    );
    
    // Abort parent immediately
    parentController.abort('parent_cancelled');
    
    await expect(
      withTimeout(
        fn,
        {
          budget: { operationTimeoutMs: 5000, totalBudgetMs: 10000, useAbortSignal: true },
          signal: parentController.signal,
          dependency: 'test',
          operation: 'test_operation',
        }
      )
    ).rejects.toThrow();
  });

  it('should abort when either signal fires', async () => {
    const parentController = new AbortController();
    const fn = vi.fn().mockImplementation(
      (signal: AbortSignal) => {
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
    );
    
    // Abort parent after short delay (before timeout)
    setTimeout(() => parentController.abort('parent'), 50);
    
    await expect(
      withTimeout(
        fn,
        {
          budget: { operationTimeoutMs: 5000, totalBudgetMs: 10000, useAbortSignal: true },
          signal: parentController.signal,
          dependency: 'test',
          operation: 'test_operation',
        }
      )
    ).rejects.toThrow();
  });
});
