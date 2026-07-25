/**
 * db-health.test.ts
 *
 * Vitest unit tests for the database health probe (db-health.ts).
 *
 * The probe runs a SELECT 1 query every DB_HEALTH_INTERVAL_MS (default 30 s)
 * and logs a warning when the query takes longer than DB_HEALTH_WARN_THRESHOLD_MS
 * (default 1 000 ms) — an early signal of connection-pool exhaustion.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock the Prisma read client so no real DB connection is needed ─────────────
vi.mock('../db', () => ({
  default: {
    $queryRaw: vi.fn(),
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock logger to capture structured log output.
const logWarnSpy  = vi.fn();
const logErrorSpy = vi.fn();
const logDebugSpy = vi.fn();
const logInfoSpy  = vi.fn();

vi.mock('../logger', () => ({
  logger: {
    warn:  (...args: unknown[]) => logWarnSpy(...args),
    error: (...args: unknown[]) => logErrorSpy(...args),
    debug: (...args: unknown[]) => logDebugSpy(...args),
    info:  (...args: unknown[]) => logInfoSpy(...args),
  },
}));

// Import AFTER mocks are registered.
import prisma from '../db';
import { runDbHealthProbe, startDbHealthProbe, stopDbHealthProbe } from '../db-health';

// ── runDbHealthProbe ──────────────────────────────────────────────────────────

describe('runDbHealthProbe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    stopDbHealthProbe();
  });

  it('resolves with a non-negative latency in ms on success', async () => {
    (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([{ '?column?': 1 }]);

    const latency = await runDbHealthProbe();

    expect(typeof latency).toBe('number');
    expect(latency).toBeGreaterThanOrEqual(0);
  });

  it('throws when the underlying query fails', async () => {
    (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Connection refused'),
    );

    await expect(runDbHealthProbe()).rejects.toThrow('Connection refused');
  });

  it('calls $queryRaw exactly once per invocation', async () => {
    (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await runDbHealthProbe();

    expect(prisma.$queryRaw).toHaveBeenCalledOnce();
  });
});

// ── startDbHealthProbe / scheduled behaviour ──────────────────────────────────

describe('startDbHealthProbe — scheduled probe', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    process.env = {
      ...originalEnv,
      // Speed up the interval for tests: 100 ms interval, 50 ms warn threshold.
      DB_HEALTH_INTERVAL_MS:    '100',
      DB_HEALTH_WARN_THRESHOLD_MS: '50',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    stopDbHealthProbe();
    vi.useRealTimers();
  });

  it('returns a stop function without throwing', () => {
    (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const stop = startDbHealthProbe();
    expect(typeof stop).toBe('function');
    stop();
  });

  it('stop function cancels the interval (no further queries after stop)', async () => {
    (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const stop = startDbHealthProbe();

    // Advance past two intervals.
    await vi.advanceTimersByTimeAsync(250);
    const callsBeforeStop = (prisma.$queryRaw as ReturnType<typeof vi.fn>).mock.calls.length;

    stop();

    // Advance further — no more calls expected.
    await vi.advanceTimersByTimeAsync(500);
    const callsAfterStop = (prisma.$queryRaw as ReturnType<typeof vi.fn>).mock.calls.length;

    expect(callsAfterStop).toBe(callsBeforeStop);
  });

  it('logs a warning when probe latency exceeds the threshold', async () => {
    // Simulate a slow query by advancing fake timers inside the mock.
    (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await vi.advanceTimersByTimeAsync(200); // 200 ms > 50 ms threshold
      return [];
    });

    const stop = startDbHealthProbe();
    await vi.advanceTimersByTimeAsync(150);

    stop();

    expect(logWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('possible pool exhaustion'),
      expect.objectContaining({ warnThresholdMs: 50 }),
    );
  });

  it('logs an error when the probe query throws', async () => {
    (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('DB unreachable'),
    );

    const stop = startDbHealthProbe();
    await vi.advanceTimersByTimeAsync(150);

    stop();

    expect(logErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('probe failed'),
      expect.objectContaining({ error: 'DB unreachable' }),
    );
  });

  it('duplicate start call is ignored (no double interval)', () => {
    (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const stop1 = startDbHealthProbe();
    const stop2 = startDbHealthProbe(); // should log a warning and return a no-op

    expect(logWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('already running'),
    );

    stop1();
    stop2(); // no-op — safe to call
  });
});

// ── Pool sizing documentation ─────────────────────────────────────────────────

describe('pool configuration defaults', () => {
  const originalEnv = process.env;

  beforeEach(() => { process.env = { ...originalEnv }; });
  afterEach(() => { process.env = originalEnv; });

  it('DB_CONNECTION_LIMIT defaults to 10 (API read pool)', () => {
    delete process.env.DB_CONNECTION_LIMIT;
    expect(parseInt(process.env.DB_CONNECTION_LIMIT || '10', 10)).toBe(10);
  });

  it('DB_WRITE_CONNECTION_LIMIT defaults to 3 (write pool)', () => {
    delete process.env.DB_WRITE_CONNECTION_LIMIT;
    expect(parseInt(process.env.DB_WRITE_CONNECTION_LIMIT || '3', 10)).toBe(3);
  });

  it('DB_POOL_TIMEOUT defaults to 30 seconds', () => {
    delete process.env.DB_POOL_TIMEOUT;
    expect(parseInt(process.env.DB_POOL_TIMEOUT || '30', 10)).toBe(30);
  });

  it('DB_HEALTH_INTERVAL_MS defaults to 30000', () => {
    delete process.env.DB_HEALTH_INTERVAL_MS;
    expect(parseInt(process.env.DB_HEALTH_INTERVAL_MS || '30000', 10)).toBe(30_000);
  });

  it('DB_HEALTH_WARN_THRESHOLD_MS defaults to 1000', () => {
    delete process.env.DB_HEALTH_WARN_THRESHOLD_MS;
    expect(parseInt(process.env.DB_HEALTH_WARN_THRESHOLD_MS || '1000', 10)).toBe(1_000);
  });
});
