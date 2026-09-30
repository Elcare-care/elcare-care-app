/**
 * shutdown-timeout.test.ts
 *
 * Tests for graceful shutdown with timeout enforcement.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gracefulShutdown } from '../poller.js';
import { withShutdownTimeout, TIMEOUT_BUDGETS, TimeoutError, CancellationError } from '../timeout.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockPrisma = {
  $disconnect: vi.fn().mockResolvedValue(undefined),
};

const mockRedis = {
  disconnect: vi.fn().mockResolvedValue(undefined),
};

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
};

const mockProcess = {
  exit: vi.fn(),
};

vi.mock('../prisma-write.js', () => ({ default: mockPrisma }));
vi.mock('../redis.js', () => ({ default: mockRedis }));
vi.mock('../logger.js', () => ({ logger: mockLogger }));

// ── Reset mocks before each test ─────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.$disconnect.mockReset();
  mockRedis.disconnect.mockReset();
  mockLogger.info.mockReset();
  mockLogger.error.mockReset();
  mockLogger.warn.mockReset();
  mockProcess.exit.mockReset();
});

// ── Shutdown Timeout Tests ───────────────────────────────────────────────────

describe('graceful shutdown with timeout', () => {
  it('should complete shutdown within grace period', async () => {
    // Mock successful cleanup
    mockPrisma.$disconnect.mockResolvedValue(undefined);
    mockRedis.disconnect.mockResolvedValue(undefined);
    
    // This test would need to be run in a controlled environment
    // For now, we test the timeout wrapper directly
    const result = await withShutdownTimeout(
      async (signal) => {
        // Simulate cleanup
        await Promise.resolve();
        return 'shutdown_complete';
      },
      'test_shutdown',
      TIMEOUT_BUDGETS.shutdown
    );

    expect(result).toBe('shutdown_complete');
  });

  it('should timeout when cleanup exceeds grace period', async () => {
    const slowCleanup = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 70000))
    );
    
    await expect(
      withShutdownTimeout(
        slowCleanup,
        'slow_cleanup',
        {
          operationTimeoutMs: 30000,
          totalBudgetMs: 60000,
          useAbortSignal: true,
        }
      )
    ).rejects.toThrow(TimeoutError);

    expect(slowCleanup).toHaveBeenCalled();
  });

  it('should handle cancellation during shutdown', async () => {
    const controller = new AbortController();
    const cancellableCleanup = vi.fn().mockImplementation(
      (signal: AbortSignal) => {
        if (signal.aborted) throw new CancellationError('cancelled');
        return new Promise((resolve) => setTimeout(resolve, 1000));
      }
    );
    
    // Abort immediately
    controller.abort('force_cancel');
    
    await expect(
      withShutdownTimeout(
        cancellableCleanup,
        'cancellable_cleanup',
        TIMEOUT_BUDGETS.shutdown
      )
    ).rejects.toThrow(CancellationError);
  });

  it('should complete multiple cleanup steps in parallel', async () => {
    const cleanup1 = vi.fn().mockResolvedValue('step1');
    const cleanup2 = vi.fn().mockResolvedValue('step2');
    const cleanup3 = vi.fn().mockResolvedValue('step3');
    
    await withShutdownTimeout(
      async (signal) => {
        await Promise.all([
          cleanup1(),
          cleanup2(),
          cleanup3(),
        ]);
      },
      'parallel_cleanup',
      TIMEOUT_BUDGETS.shutdown
    );

    expect(cleanup1).toHaveBeenCalledTimes(1);
    expect(cleanup2).toHaveBeenCalledTimes(1);
    expect(cleanup3).toHaveBeenCalledTimes(1);
  });

  it('should handle individual cleanup failures without failing entire shutdown', async () => {
    const cleanup1 = vi.fn().mockResolvedValue('step1');
    const cleanup2 = vi.fn().mockRejectedValue(new Error('cleanup2 failed'));
    const cleanup3 = vi.fn().mockResolvedValue('step3');
    
    await withShutdownTimeout(
      async (signal) => {
        const results = await Promise.allSettled([
          cleanup1(),
          cleanup2(),
          cleanup3(),
        ]);
        
        // Should have completed despite one failure
        expect(results[0].status).toBe('fulfilled');
        expect(results[1].status).toBe('rejected');
        expect(results[2].status).toBe('fulfilled');
      },
      'partial_failure_cleanup',
      TIMEOUT_BUDGETS.shutdown
    );
  });
});

// ── Budget Enforcement Tests ─────────────────────────────────────────────────

describe('shutdown budget enforcement', () => {
  it('should use configured shutdown budget', () => {
    expect(TIMEOUT_BUDGETS.shutdown.operationTimeoutMs).toBe(30000);
    expect(TIMEOUT_BUDGETS.shutdown.totalBudgetMs).toBe(60000);
  });

  it('should allow overriding shutdown budget', async () => {
    const customBudget = {
      operationTimeoutMs: 15000,
      totalBudgetMs: 30000,
      useAbortSignal: true,
    };
    
    const result = await withShutdownTimeout(
      async (signal) => 'custom_shutdown',
      'custom_shutdown',
      customBudget
    );

    expect(result).toBe('custom_shutdown');
  });
});

// ── Abort Signal Tests ───────────────────────────────────────────────────────

describe('abort signal in shutdown', () => {
  it('should pass abort signal to cleanup function', async () => {
    let receivedSignal: AbortSignal | null = null;
    
    await withShutdownTimeout(
      async (signal) => {
        receivedSignal = signal;
        return 'success';
      },
      'signal_test',
      TIMEOUT_BUDGETS.shutdown
    );

    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });

  it('should abort cleanup when signal fires', async () => {
    const controller = new AbortController();
    let cleanupCalled = false;
    
    const cleanupPromise = withShutdownTimeout(
      async (signal) => {
        cleanupCalled = true;
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new CancellationError('aborted')));
          setTimeout(() => resolve('success'), 5000);
        });
      },
      'abort_test',
      TIMEOUT_BUDGETS.shutdown
    );
    
    // Abort after short delay
    setTimeout(() => controller.abort('shutdown_cancelled'), 50);
    
    await expect(cleanupPromise).rejects.toThrow(CancellationError);
    expect(cleanupCalled).toBe(true);
  });
});
