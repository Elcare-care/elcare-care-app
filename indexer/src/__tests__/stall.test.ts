/**
 * stall.test.ts — Multi-signal stall detector tests
 *
 * Uses vi.useFakeTimers() to control Date.now() and setInterval timing.
 * All module-level mocks are hoisted so they are in place before any import.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mocks (must be declared before any import that uses these modules) ─

const mockStalledGauge = vi.hoisted(() => ({ set: vi.fn() }));
const mockPollerStallTotal = vi.hoisted(() => ({
  labels: vi.fn().mockReturnValue({ inc: vi.fn() }),
}));
const mockPollerRestartTotal = vi.hoisted(() => ({ inc: vi.fn() }));

vi.mock('../metrics.js', () => ({
  stalledGauge: mockStalledGauge,
  pollerStallTotal: mockPollerStallTotal,
  pollerRestartTotal: mockPollerRestartTotal,
  latestLedgerProcessedGauge: { set: vi.fn() },
  networkLatestLedgerGauge: { set: vi.fn() },
  syncLatencyGauge: { set: vi.fn() },
}));

const mockEmitSSEEvent = vi.hoisted(() => vi.fn());
vi.mock('../api/routes.js', () => ({
  emitSSEEvent: mockEmitSSEEvent,
}));

const mockLogger = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('../logger.js', () => ({ logger: mockLogger }));

// ── Module under test ─────────────────────────────────────────────────────────

import {
  recordProgress,
  recordDbWrite,
  recordRpcFailure,
  isStalled,
  resetStallStateForTest,
  registerPollerLifecycle,
  startWatchdog,
  stopWatchdog,
  STALL_THRESHOLD_MS,
  MAX_RESTART_ATTEMPTS,
  RPC_FAILURE_WARNING_THRESHOLD,
} from '../stall.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Advance fake timers AND Date.now by the given ms. */
function advanceTime(ms: number): void {
  vi.advanceTimersByTime(ms);
}

/** Shorthand: run the watchdog tick count times. */
function tickWatchdog(ticks = 1): void {
  // The watchdog fires every 5 000 ms.
  advanceTime(5_000 * ticks);
}

// env vars for stall thresholds — set before module is loaded via vi.mock
const WARNING_MS  = 30_000;
const CRITICAL_MS = 120_000;
const FATAL_MS    = 300_000;

beforeEach(() => {
  process.env.STALL_WARNING_MS  = String(WARNING_MS);
  process.env.STALL_CRITICAL_MS = String(CRITICAL_MS);
  process.env.STALL_FATAL_MS    = String(FATAL_MS);
  process.env.POLL_INTERVAL_MS  = '5000';
  process.env.MAX_LEDGERS_PER_CYCLE = '1000';
  process.env.SHUTDOWN_TIMEOUT_MS   = '30000';
});

// ── Test suites ───────────────────────────────────────────────────────────────

describe('legacy isStalled() compatibility', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStallStateForTest();
    mockStalledGauge.set.mockClear();
  });

  afterEach(() => {
    stopWatchdog();
    vi.useRealTimers();
  });

  it('returns false before any progress has been recorded', () => {
    expect(isStalled()).toBe(false);
  });

  it('returns false immediately after recordProgress()', () => {
    recordProgress();
    expect(isStalled()).toBe(false);
  });

  it('returns true after the warning threshold elapses without progress', () => {
    recordProgress();
    advanceTime(WARNING_MS + 1);
    expect(isStalled()).toBe(true);
  });

  it('stalledGauge is set to 0 on each recordProgress() call', () => {
    recordProgress();
    expect(mockStalledGauge.set).toHaveBeenCalledWith(0);
  });

  it('recovery: isStalled() returns false again after a new recordProgress()', () => {
    recordProgress();
    advanceTime(WARNING_MS + 1);
    expect(isStalled()).toBe(true);
    recordProgress();
    expect(isStalled()).toBe(false);
  });

  it('isStalled() stays false just below the warning threshold', () => {
    recordProgress();
    advanceTime(WARNING_MS - 1);
    expect(isStalled()).toBe(false);
  });
});

describe('recordDbWrite() signal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStallStateForTest();
  });

  afterEach(() => {
    stopWatchdog();
    vi.useRealTimers();
  });

  it('a stale DB write (no progress) still triggers a stall', () => {
    recordDbWrite();
    advanceTime(WARNING_MS + 1);
    expect(isStalled()).toBe(true);
  });

  it('a fresh DB write resets DB staleness (but not ledger staleness)', () => {
    recordProgress();
    advanceTime(WARNING_MS - 1);
    recordDbWrite();
    advanceTime(2); // total > WARNING_MS since last progress, but DB write is fresh
    // ledger stale > WARNING_MS, DB stale < WARNING_MS → ledger signal dominates
    expect(isStalled()).toBe(true);
  });

  it('both signals fresh → not stalled', () => {
    recordProgress();
    recordDbWrite();
    advanceTime(WARNING_MS - 1);
    expect(isStalled()).toBe(false);
  });
});

describe('recordRpcFailure() signal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStallStateForTest();
  });

  afterEach(() => {
    stopWatchdog();
    vi.useRealTimers();
  });

  it('fewer than threshold failures do not trigger a stall', () => {
    recordProgress();
    for (let i = 0; i < RPC_FAILURE_WARNING_THRESHOLD - 1; i++) {
      recordRpcFailure();
    }
    expect(isStalled()).toBe(false);
  });

  it('reaching the threshold triggers a stall immediately (no time needed)', () => {
    recordProgress();
    for (let i = 0; i < RPC_FAILURE_WARNING_THRESHOLD; i++) {
      recordRpcFailure();
    }
    expect(isStalled()).toBe(true);
  });

  it('recordProgress() resets the RPC failure counter', () => {
    recordProgress();
    for (let i = 0; i < RPC_FAILURE_WARNING_THRESHOLD; i++) {
      recordRpcFailure();
    }
    expect(isStalled()).toBe(true);
    recordProgress();
    expect(isStalled()).toBe(false);
  });
});

describe('WARNING level watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStallStateForTest();
    mockStalledGauge.set.mockClear();
    mockPollerStallTotal.labels.mockClear();
    mockLogger.warn.mockClear();
  });

  afterEach(() => {
    stopWatchdog();
    vi.useRealTimers();
  });

  it('increments the warning counter and logs at WARNING level', async () => {
    recordProgress();
    startWatchdog();

    // Advance past WARNING threshold, then tick the watchdog
    advanceTime(WARNING_MS + 5_001); // also covers one watchdog tick

    // Allow any microtask/promise callbacks from handleStallLevel to flush
    await vi.runAllTimersAsync();

    expect(mockPollerStallTotal.labels).toHaveBeenCalledWith('warning');
    expect(mockPollerStallTotal.labels('warning').inc).toHaveBeenCalled();
    expect(mockStalledGauge.set).toHaveBeenCalledWith(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('WARNING'),
      expect.any(Object),
    );
  });

  it('does NOT emit an SSE event at WARNING level', async () => {
    recordProgress();
    startWatchdog();
    advanceTime(WARNING_MS + 5_001);
    await vi.runAllTimersAsync();
    expect(mockEmitSSEEvent).not.toHaveBeenCalled();
  });
});

describe('CRITICAL level watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStallStateForTest();
    mockStalledGauge.set.mockClear();
    mockPollerStallTotal.labels.mockClear();
    mockEmitSSEEvent.mockClear();
    mockLogger.error.mockClear();
  });

  afterEach(() => {
    stopWatchdog();
    vi.useRealTimers();
  });

  it('increments the critical counter, logs error, and emits SSE event', async () => {
    recordProgress();
    startWatchdog();

    advanceTime(CRITICAL_MS + 5_001);
    await vi.runAllTimersAsync();

    expect(mockPollerStallTotal.labels).toHaveBeenCalledWith('critical');
    expect(mockStalledGauge.set).toHaveBeenCalledWith(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('CRITICAL'),
      expect.any(Object),
    );
    expect(mockEmitSSEEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'indexer-stalled',
        level: 'critical',
        stallDurationMs: expect.any(Number),
      }),
    );
  });

  it('SSE event is emitted only once per escalation (not on every tick)', async () => {
    recordProgress();
    startWatchdog();

    // First tick at CRITICAL
    advanceTime(CRITICAL_MS + 5_001);
    await vi.runAllTimersAsync();

    const firstEmitCount = mockEmitSSEEvent.mock.calls.length;

    // Second tick still at CRITICAL
    advanceTime(5_000);
    await vi.runAllTimersAsync();

    // Count should not have increased
    expect(mockEmitSSEEvent.mock.calls.length).toBe(firstEmitCount);
  });

  it('SSE payload contains stallDurationMs greater than CRITICAL_MS', async () => {
    recordProgress();
    startWatchdog();

    advanceTime(CRITICAL_MS + 5_001);
    await vi.runAllTimersAsync();

    const payload = mockEmitSSEEvent.mock.calls[0][0];
    expect(payload.stallDurationMs).toBeGreaterThan(CRITICAL_MS);
  });
});

describe('FATAL level watchdog — restart logic', () => {
  let mockStop: ReturnType<typeof vi.fn>;
  let mockStart: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    resetStallStateForTest();
    mockPollerStallTotal.labels.mockClear();
    mockPollerRestartTotal.inc.mockClear();
    mockLogger.error.mockClear();
    mockEmitSSEEvent.mockClear();

    mockStop = vi.fn();
    mockStart = vi.fn().mockResolvedValue(undefined);
    registerPollerLifecycle({ stopPoller: mockStop, startPoller: mockStart });
  });

  afterEach(() => {
    stopWatchdog();
    vi.useRealTimers();
  });

  it('calls stopPoller() then startPoller() on first FATAL escalation', async () => {
    recordProgress();
    startWatchdog();

    advanceTime(FATAL_MS + 5_001);
    await vi.runAllTimersAsync();

    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockPollerRestartTotal.inc).toHaveBeenCalledTimes(1);
  });

  it('increments the fatal stall counter', async () => {
    recordProgress();
    startWatchdog();

    advanceTime(FATAL_MS + 5_001);
    await vi.runAllTimersAsync();

    expect(mockPollerStallTotal.labels).toHaveBeenCalledWith('fatal');
  });

  it('attempts exactly MAX_RESTART_ATTEMPTS restarts then exits', async () => {
    // Make startPoller() always succeed so we can control timing
    mockStart.mockResolvedValue(undefined);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as any);

    recordProgress();
    startWatchdog();

    // Each FATAL tick that is the "first" at that level triggers a restart.
    // After a restart, lastProgressAt is refreshed, so we need to stall again.
    // We simulate MAX_RESTART_ATTEMPTS + 1 separate FATAL events by letting
    // the restart "succeed" but never recording real progress, so the stall
    // re-escalates after each restart.

    for (let attempt = 0; attempt < MAX_RESTART_ATTEMPTS; attempt++) {
      advanceTime(FATAL_MS + 5_001);
      await vi.runAllTimersAsync();
    }

    // One more tick should hit the exit path
    try {
      advanceTime(FATAL_MS + 5_001);
      await vi.runAllTimersAsync();
    } catch (err: any) {
      expect(err.message).toBe('process.exit called');
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('does not restart more than MAX_RESTART_ATTEMPTS times', async () => {
    mockStart.mockResolvedValue(undefined);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    recordProgress();
    startWatchdog();

    // Drive enough ticks to exhaust the restart budget
    for (let i = 0; i <= MAX_RESTART_ATTEMPTS + 1; i++) {
      advanceTime(FATAL_MS + 5_001);
      await vi.runAllTimersAsync();
    }

    expect(mockStart.mock.calls.length).toBeLessThanOrEqual(MAX_RESTART_ATTEMPTS);
    exitSpy.mockRestore();
  });

  it('logs an error on FATAL stall', async () => {
    recordProgress();
    startWatchdog();

    advanceTime(FATAL_MS + 5_001);
    await vi.runAllTimersAsync();

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('FATAL'),
      expect.any(Object),
    );
  });
});

describe('stall progression through all three levels', () => {
  let mockStop: ReturnType<typeof vi.fn>;
  let mockStart: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    resetStallStateForTest();
    mockPollerStallTotal.labels.mockClear();
    mockEmitSSEEvent.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockStalledGauge.set.mockClear();

    mockStop = vi.fn();
    mockStart = vi.fn().mockResolvedValue(undefined);
    registerPollerLifecycle({ stopPoller: mockStop, startPoller: mockStart });
  });

  afterEach(() => {
    stopWatchdog();
    vi.useRealTimers();
  });

  it('escalates: WARNING → CRITICAL → FATAL in order', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    recordProgress();
    startWatchdog();

    // ── WARNING ──
    advanceTime(WARNING_MS + 5_001);
    await vi.runAllTimersAsync();

    expect(mockPollerStallTotal.labels).toHaveBeenCalledWith('warning');
    expect(mockEmitSSEEvent).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalled();

    // ── CRITICAL ──
    advanceTime(CRITICAL_MS - WARNING_MS); // advance to CRITICAL threshold
    await vi.runAllTimersAsync();

    expect(mockPollerStallTotal.labels).toHaveBeenCalledWith('critical');
    expect(mockEmitSSEEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'indexer-stalled', level: 'critical' }),
    );

    // ── FATAL ──
    advanceTime(FATAL_MS - CRITICAL_MS); // advance to FATAL threshold
    await vi.runAllTimersAsync();

    expect(mockPollerStallTotal.labels).toHaveBeenCalledWith('fatal');
    expect(mockStop).toHaveBeenCalled();
    expect(mockStart).toHaveBeenCalled();
    expect(mockPollerRestartTotal.inc).toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it('recovery resets level so a fresh stall re-escalates from WARNING', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    recordProgress();
    startWatchdog();

    // Stall to CRITICAL
    advanceTime(CRITICAL_MS + 5_001);
    await vi.runAllTimersAsync();
    expect(mockPollerStallTotal.labels).toHaveBeenCalledWith('critical');

    // Recovery
    recordProgress();
    advanceTime(5_000);
    await vi.runAllTimersAsync();

    // Stall again — should restart from WARNING not CRITICAL
    mockPollerStallTotal.labels.mockClear();
    mockEmitSSEEvent.mockClear();
    advanceTime(WARNING_MS + 5_001);
    await vi.runAllTimersAsync();

    expect(mockPollerStallTotal.labels).toHaveBeenCalledWith('warning');
    // SSE must NOT fire at WARNING
    expect(mockEmitSSEEvent).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });
});

describe('RPC failure + time signal combination', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStallStateForTest();
    mockPollerStallTotal.labels.mockClear();
    mockEmitSSEEvent.mockClear();
  });

  afterEach(() => {
    stopWatchdog();
    vi.useRealTimers();
  });

  it('RPC failures alone (no time elapsed) trigger WARNING watchdog action', async () => {
    recordProgress();
    startWatchdog();

    // Inject failures without advancing time significantly
    for (let i = 0; i < RPC_FAILURE_WARNING_THRESHOLD; i++) {
      recordRpcFailure();
    }

    // One watchdog tick
    advanceTime(5_000);
    await vi.runAllTimersAsync();

    expect(mockPollerStallTotal.labels).toHaveBeenCalledWith('warning');
    expect(mockEmitSSEEvent).not.toHaveBeenCalled(); // still only WARNING
  });

  it('time-based signal dominates when it exceeds CRITICAL even if RPC signal is only WARNING', async () => {
    recordProgress();
    startWatchdog();

    // Trigger RPC warning level
    for (let i = 0; i < RPC_FAILURE_WARNING_THRESHOLD; i++) {
      recordRpcFailure();
    }

    // Advance past CRITICAL threshold by time
    advanceTime(CRITICAL_MS + 5_001);
    await vi.runAllTimersAsync();

    // Time signal is CRITICAL, RPC signal is WARNING → CRITICAL wins
    expect(mockPollerStallTotal.labels).toHaveBeenCalledWith('critical');
    expect(mockEmitSSEEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'indexer-stalled', level: 'critical' }),
    );
  });
});
