/**
 * fenced-lease.test.ts
 *
 * Tests for monotonic fencing tokens on lease-guarded writes covering:
 *   - acquireFencedLease: success and contention
 *   - renewFencedLease: token increments; lost lease returns false
 *   - assertCurrentToken: passes when token matches; throws StaleWriterError when stale
 *   - fencedWrite: commits write when token is current; rolls back on stale
 *   - Two simulated pollers: delayed write from previous leader is rejected
 *   - releaseFencedLease: cleans up without throwing
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Stub prom-client ──────────────────────────────────────────────────────────

vi.mock('prom-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('prom-client')>();
  return {
    ...actual,
    Gauge:   class { labels = () => ({ set: vi.fn() }); set = vi.fn() },
    Counter: class { labels = () => ({ inc: vi.fn() }); inc = vi.fn() },
    collectDefaultMetrics: vi.fn(),
    register: { contentType: 'text/plain', metrics: vi.fn().mockResolvedValue(''), getSingleMetric: vi.fn() },
  };
});

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Mock prisma-write ─────────────────────────────────────────────────────────

const { mockPrismaWrite } = vi.hoisted(() => ({
  mockPrismaWrite: {
    workerLease: {
      create:    vi.fn(),
      update:    vi.fn(),
      delete:    vi.fn(),
      findFirst: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('../prisma-write.js', () => ({ default: mockPrismaWrite }));

import {
  acquireFencedLease,
  renewFencedLease,
  releaseFencedLease,
  assertCurrentToken,
  fencedWrite,
  getCurrentFencedLease,
  StaleWriterError,
} from '../fenced-lease.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function resetInternalState() {
  // Reset the module-level _fencedLease and timer by releasing any held lease
  try { releaseFencedLease('poller'); } catch { /* ignore */ }
  try { releaseFencedLease('backfill'); } catch { /* ignore */ }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FencedLease', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetInternalState();
  });

  // ── acquireFencedLease ─────────────────────────────────────────────────────

  it('acquires lease and returns a FencedLease with a bigint token', async () => {
    const token = BigInt(Date.now());
    mockPrismaWrite.workerLease.create.mockResolvedValue({
      role: 'poller',
      ownerId: 'test-owner',
      token,
      expiresAt: new Date(Date.now() + 15000),
    });

    const lease = await acquireFencedLease('poller');

    expect(lease).not.toBeNull();
    expect(lease!.token).toBe(token);
    expect(typeof lease!.token).toBe('bigint');
    expect(lease!.role).toBe('poller');
  });

  it('returns null on contention (P2002 unique constraint violation)', async () => {
    mockPrismaWrite.workerLease.create.mockRejectedValue({ code: 'P2002' });

    const lease = await acquireFencedLease('poller');
    expect(lease).toBeNull();
  });

  it('rethrows non-contention errors', async () => {
    mockPrismaWrite.workerLease.create.mockRejectedValue(new Error('DB connection lost'));

    await expect(acquireFencedLease('poller')).rejects.toThrow('DB connection lost');
  });

  // ── renewFencedLease ───────────────────────────────────────────────────────

  it('increments the fencing token on successful renewal', async () => {
    const initialToken = BigInt(1000);
    mockPrismaWrite.workerLease.create.mockResolvedValue({
      role: 'poller', ownerId: 'test', token: initialToken,
      expiresAt: new Date(Date.now() + 15000),
    });

    await acquireFencedLease('poller');

    const newToken = initialToken + 1n;
    mockPrismaWrite.workerLease.update.mockResolvedValue({
      expiresAt: new Date(Date.now() + 15000),
      token: newToken,
    });

    const renewed = await renewFencedLease('poller');
    expect(renewed).toBe(true);
    expect(getCurrentFencedLease()!.token).toBe(newToken);
  });

  it('returns false and clears lease when renewal fails (lost lease)', async () => {
    const token = BigInt(1000);
    mockPrismaWrite.workerLease.create.mockResolvedValue({
      role: 'poller', ownerId: 'test', token,
      expiresAt: new Date(Date.now() + 15000),
    });

    await acquireFencedLease('poller');

    mockPrismaWrite.workerLease.update.mockRejectedValue(new Error('record not found'));

    const renewed = await renewFencedLease('poller');
    expect(renewed).toBe(false);
    expect(getCurrentFencedLease()).toBeNull();
  });

  it('returns false when no lease is held', async () => {
    const renewed = await renewFencedLease('poller');
    expect(renewed).toBe(false);
  });

  // ── assertCurrentToken ─────────────────────────────────────────────────────

  it('passes when DB token matches our token', async () => {
    const token = BigInt(5000);
    mockPrismaWrite.workerLease.create.mockResolvedValue({
      role: 'poller', ownerId: 'test', token,
      expiresAt: new Date(Date.now() + 15000),
    });
    await acquireFencedLease('poller');

    const mockTx = {
      workerLease: {
        findFirst: vi.fn().mockResolvedValue({ token, ownerId: 'test' }),
      },
    };

    await expect(assertCurrentToken('poller', mockTx)).resolves.toBeUndefined();
  });

  it('throws StaleWriterError when DB token is ahead of our token', async () => {
    const ourToken = BigInt(5000);
    const dbToken  = BigInt(9999); // another leader renewed past us

    mockPrismaWrite.workerLease.create.mockResolvedValue({
      role: 'poller', ownerId: 'test', token: ourToken,
      expiresAt: new Date(Date.now() + 15000),
    });
    await acquireFencedLease('poller');

    const mockTx = {
      workerLease: {
        findFirst: vi.fn().mockResolvedValue({ token: dbToken, ownerId: 'new-leader' }),
      },
    };

    await expect(assertCurrentToken('poller', mockTx)).rejects.toThrow(StaleWriterError);
  });

  it('throws StaleWriterError when the lease row is gone', async () => {
    const token = BigInt(5000);
    mockPrismaWrite.workerLease.create.mockResolvedValue({
      role: 'poller', ownerId: 'test', token,
      expiresAt: new Date(Date.now() + 15000),
    });
    await acquireFencedLease('poller');

    const mockTx = {
      workerLease: { findFirst: vi.fn().mockResolvedValue(null) },
    };

    await expect(assertCurrentToken('poller', mockTx)).rejects.toThrow(StaleWriterError);
  });

  it('throws StaleWriterError when no lease is held at all', async () => {
    const mockTx = {
      workerLease: { findFirst: vi.fn().mockResolvedValue(null) },
    };

    await expect(assertCurrentToken('poller', mockTx)).rejects.toThrow(StaleWriterError);
  });

  // ── fencedWrite ────────────────────────────────────────────────────────────

  it('executes the write function within a transaction when token is current', async () => {
    const token = BigInt(7000);
    mockPrismaWrite.workerLease.create.mockResolvedValue({
      role: 'poller', ownerId: 'test', token,
      expiresAt: new Date(Date.now() + 15000),
    });
    await acquireFencedLease('poller');

    const writeFn = vi.fn().mockResolvedValue('write-result');

    mockPrismaWrite.$transaction.mockImplementation(async (fn: any) => {
      const tx = {
        workerLease: { findFirst: vi.fn().mockResolvedValue({ token, ownerId: 'test' }) },
      };
      return fn(tx);
    });

    const result = await fencedWrite('poller', writeFn);
    expect(result).toBe('write-result');
    expect(writeFn).toHaveBeenCalledTimes(1);
  });

  it('rolls back (StaleWriterError) when write is attempted with stale token', async () => {
    const ourToken = BigInt(7000);
    const dbToken  = BigInt(8000);

    mockPrismaWrite.workerLease.create.mockResolvedValue({
      role: 'poller', ownerId: 'test', token: ourToken,
      expiresAt: new Date(Date.now() + 15000),
    });
    await acquireFencedLease('poller');

    const writeFn = vi.fn().mockResolvedValue('should-not-run');

    mockPrismaWrite.$transaction.mockImplementation(async (fn: any) => {
      const tx = {
        workerLease: { findFirst: vi.fn().mockResolvedValue({ token: dbToken, ownerId: 'new' }) },
      };
      return fn(tx);
    });

    await expect(fencedWrite('poller', writeFn)).rejects.toThrow(StaleWriterError);
    // writeFn should not have been called because assertCurrentToken threw first
    expect(writeFn).not.toHaveBeenCalled();
  });

  // ── Two pollers scenario ───────────────────────────────────────────────────

  it('delayed write from previous leader is rejected after takeover', async () => {
    // Leader A acquires lease with token 100
    const tokenA = BigInt(100);
    mockPrismaWrite.workerLease.create.mockResolvedValue({
      role: 'poller', ownerId: 'leader-a', token: tokenA,
      expiresAt: new Date(Date.now() + 15000),
    });
    await acquireFencedLease('poller');

    // Simulate: leader B takes over and DB token is now 200
    const tokenB = BigInt(200);

    mockPrismaWrite.$transaction.mockImplementation(async (fn: any) => {
      const tx = {
        workerLease: { findFirst: vi.fn().mockResolvedValue({ token: tokenB, ownerId: 'leader-b' }) },
      };
      return fn(tx);
    });

    const staleWrite = vi.fn().mockResolvedValue('stale-result');

    // Leader A's delayed write is now rejected
    await expect(fencedWrite('poller', staleWrite)).rejects.toThrow(StaleWriterError);
    expect(staleWrite).not.toHaveBeenCalled();
  });

  // ── releaseFencedLease ─────────────────────────────────────────────────────

  it('releases lease without throwing', async () => {
    const token = BigInt(1234);
    mockPrismaWrite.workerLease.create.mockResolvedValue({
      role: 'backfill', ownerId: 'test', token,
      expiresAt: new Date(Date.now() + 15000),
    });
    await acquireFencedLease('backfill');

    mockPrismaWrite.workerLease.delete.mockResolvedValue({});
    expect(() => releaseFencedLease('backfill')).not.toThrow();
    expect(getCurrentFencedLease()).toBeNull();
  });

  it('is a no-op when no lease is held', () => {
    expect(() => releaseFencedLease('poller')).not.toThrow();
  });
});
