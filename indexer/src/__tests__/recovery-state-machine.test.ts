/**
 * __tests__/recovery-state-machine.test.ts
 *
 * Unit tests for RecoveryStateMachine covering:
 *   - All mode transitions
 *   - Consecutive-retry counter
 *   - Reorg rollback depth tracking
 *   - Gap repair lifecycle
 *   - Operator resume
 *   - Health summary shape
 *   - Idempotency of toSync()
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── Mock dependencies before importing the FSM ────────────────────────────────

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../api/routes.js', () => ({
  emitSSEEvent: vi.fn(),
}));

vi.mock('../recovery-metrics.js', () => ({
  recoveryModeGauge:            { set: vi.fn() },
  recoveryTransitionsTotal:     { labels: () => ({ inc: vi.fn() }), inc: vi.fn() },
  reorgRollbackTotal:           { inc: vi.fn() },
  reorgRollbackDepthHistogram:  { observe: vi.fn() },
  gapRepairStartedTotal:        { inc: vi.fn() },
  gapRepairCompletedTotal:      { inc: vi.fn() },
  gapRepairFailedTotal:         { inc: vi.fn() },
  recoveryRetryTotal:           { inc: vi.fn() },
  gapRepairDurationSeconds:     { observe: vi.fn() },
  gapLengthLedgers:             { observe: vi.fn() },
  reorgRollbackDurationSeconds: { observe: vi.fn() },
  replayRangeStartedTotal:      { inc: vi.fn() },
  replayRangeCompletedTotal:    { inc: vi.fn() },
  replayRangeDurationSeconds:   { observe: vi.fn() },
  replayEventsInserted:         { observe: vi.fn() },
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { recoveryFSM } from '../recovery-state-machine.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  recoveryFSM._resetForTest();
});

// ── Initial state ─────────────────────────────────────────────────────────────

describe('initial state', () => {
  it('starts in sync mode', () => {
    expect(recoveryFSM.getMode()).toBe('sync');
  });

  it('isHealthy() is true initially', () => {
    expect(recoveryFSM.isHealthy()).toBe(true);
  });

  it('isHalted() is false initially', () => {
    expect(recoveryFSM.isHalted()).toBe(false);
  });

  it('healthSummary has expected shape', () => {
    const s = recoveryFSM.healthSummary();
    expect(s.mode).toBe('sync');
    expect(s.healthy).toBe(true);
    expect(s.halted).toBe(false);
    expect(s.consecutiveRetries).toBe(0);
    expect(s.totalReorgRollbacks).toBe(0);
    expect(s.totalGapRepairs).toBe(0);
  });
});

// ── sync → retry → sync ───────────────────────────────────────────────────────

describe('retry transitions', () => {
  it('transitions to retry on toRetry()', () => {
    recoveryFSM.toRetry('rpc timed out');
    expect(recoveryFSM.getMode()).toBe('retry');
  });

  it('increments consecutiveRetries on each toRetry()', () => {
    recoveryFSM.toRetry('err1');
    recoveryFSM.toRetry('err2');
    recoveryFSM.toRetry('err3');
    expect(recoveryFSM.healthSummary().consecutiveRetries).toBe(3);
  });

  it('toSync() resets consecutiveRetries and returns to sync', () => {
    recoveryFSM.toRetry('err');
    recoveryFSM.toRetry('err');
    recoveryFSM.toSync();
    expect(recoveryFSM.getMode()).toBe('sync');
    expect(recoveryFSM.healthSummary().consecutiveRetries).toBe(0);
  });

  it('isHealthy() is false in retry mode', () => {
    recoveryFSM.toRetry('err');
    expect(recoveryFSM.isHealthy()).toBe(false);
  });
});

// ── Reorg rollback ────────────────────────────────────────────────────────────

describe('reorg rollback', () => {
  it('transitions to reorg_rollback', () => {
    recoveryFSM.toReorgRollback(1000, 990, 10);
    expect(recoveryFSM.getMode()).toBe('reorg_rollback');
  });

  it('records safeLedger and depth', () => {
    recoveryFSM.toReorgRollback(1000, 990, 10);
    const s = recoveryFSM.healthSummary();
    expect(s.lastReorgSafeLedger).toBe(990);
    expect(s.lastReorgDepth).toBe(10);
  });

  it('reorgRollbackComplete() returns to sync and increments counter', () => {
    recoveryFSM.toReorgRollback(1000, 990, 10);
    recoveryFSM.reorgRollbackComplete(990);
    expect(recoveryFSM.getMode()).toBe('sync');
    expect(recoveryFSM.healthSummary().totalReorgRollbacks).toBe(1);
  });

  it('accumulates totalReorgRollbacks over multiple reorgs', () => {
    recoveryFSM.toReorgRollback(100, 95, 5);
    recoveryFSM.reorgRollbackComplete(95);
    recoveryFSM.toReorgRollback(200, 195, 5);
    recoveryFSM.reorgRollbackComplete(195);
    expect(recoveryFSM.healthSummary().totalReorgRollbacks).toBe(2);
  });
});

// ── Gap repair ────────────────────────────────────────────────────────────────

describe('gap repair', () => {
  it('transitions to gap_repair', () => {
    recoveryFSM.toGapRepair(42, 5000, 6000);
    expect(recoveryFSM.getMode()).toBe('gap_repair');
    expect(recoveryFSM.healthSummary().activeGapId).toBe(42);
  });

  it('gapRepairComplete() returns to sync and increments counter', () => {
    recoveryFSM.toGapRepair(42, 5000, 6000);
    recoveryFSM.gapRepairComplete(42);
    expect(recoveryFSM.getMode()).toBe('sync');
    expect(recoveryFSM.healthSummary().totalGapRepairs).toBe(1);
    expect(recoveryFSM.healthSummary().activeGapId).toBeNull();
  });

  it('gapRepairFailed() returns to sync and increments failure counter', () => {
    recoveryFSM.toGapRepair(99, 1000, 2000);
    recoveryFSM.gapRepairFailed(99, 'archival RPC unreachable');
    expect(recoveryFSM.getMode()).toBe('sync');
    expect(recoveryFSM.healthSummary().totalGapRepairFailures).toBe(1);
    expect(recoveryFSM.healthSummary().activeGapId).toBeNull();
  });

  it('accumulates totalGapRepairs across multiple repairs', () => {
    for (let i = 0; i < 3; i++) {
      recoveryFSM.toGapRepair(i, i * 1000, i * 1000 + 500);
      recoveryFSM.gapRepairComplete(i);
    }
    expect(recoveryFSM.healthSummary().totalGapRepairs).toBe(3);
  });
});

// ── Halted ────────────────────────────────────────────────────────────────────

describe('halted', () => {
  it('toHalted() transitions to halted mode', () => {
    recoveryFSM.toHalted('critical reorg depth 150 > 100');
    expect(recoveryFSM.getMode()).toBe('halted');
    expect(recoveryFSM.isHalted()).toBe(true);
    expect(recoveryFSM.isHealthy()).toBe(false);
  });

  it('operatorResume() returns to sync', () => {
    recoveryFSM.toHalted('critical');
    recoveryFSM.operatorResume('ops-user-1');
    expect(recoveryFSM.getMode()).toBe('sync');
    expect(recoveryFSM.isHalted()).toBe(false);
  });

  it('healthSummary.halted is true when halted', () => {
    recoveryFSM.toHalted('test halt');
    expect(recoveryFSM.healthSummary().halted).toBe(true);
  });
});

// ── Idempotency ───────────────────────────────────────────────────────────────

describe('idempotency', () => {
  it('multiple toSync() calls do not increment transitions unexpectedly', () => {
    recoveryFSM.toSync();
    recoveryFSM.toSync();
    // Still in sync
    expect(recoveryFSM.getMode()).toBe('sync');
  });
});

// ── healthSummary completeness ────────────────────────────────────────────────

describe('healthSummary', () => {
  it('contains all expected keys', () => {
    const s = recoveryFSM.healthSummary();
    const expectedKeys = [
      'mode', 'healthy', 'halted', 'enteredAt', 'reason',
      'consecutiveRetries', 'lastReorgDepth', 'lastReorgSafeLedger',
      'activeGapId', 'totalReorgRollbacks', 'totalGapRepairs', 'totalGapRepairFailures',
    ];
    for (const key of expectedKeys) {
      expect(s).toHaveProperty(key);
    }
  });

  it('enteredAt is a valid ISO string', () => {
    const { enteredAt } = recoveryFSM.healthSummary();
    expect(() => new Date(enteredAt).toISOString()).not.toThrow();
  });
});
