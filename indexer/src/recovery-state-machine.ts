/**
 * recovery-state-machine.ts — Indexer recovery state machine
 *
 * Tracks the indexer's current operational mode so every subsystem
 * (poller, gap-repair, reconciler, health endpoint) can inspect and
 * react to the current recovery phase without duplicating logic.
 *
 * Modes
 * ─────
 *   sync          Normal operation: poller advancing ledger-by-ledger.
 *   retry         Transient RPC / DB failure; poller backing off and retrying.
 *   gap_repair    Gap-repair worker is replaying a missed ledger range.
 *   reorg_rollback  Chain re-org detected; rolling back domain state.
 *   halted        Critical re-org or manual operator halt; awaiting recovery.
 *
 * Transitions
 * ───────────
 *   sync          → retry          (RPC / DB error)
 *   retry         → sync           (success after back-off)
 *   retry         → gap_repair     (consecutive failures exceed threshold)
 *   sync / retry  → reorg_rollback (hash continuity failure)
 *   reorg_rollback→ sync           (rollback committed)
 *   reorg_rollback→ halted         (depth > MAX_ROLLBACK_DEPTH)
 *   any           → gap_repair     (gap worker claims an Open gap)
 *   gap_repair    → sync           (gap repaired)
 *   gap_repair    → halted         (all retries exhausted)
 *   halted        → sync           (operator calls resumePoller())
 *
 * Usage
 * ─────
 *   import { recoveryFSM } from './recovery-state-machine.js';
 *   recoveryFSM.toRetry('getEvents timed out');
 *   recoveryFSM.toSync();
 */

import { logger } from './logger.js';
import { emitSSEEvent } from './api/routes.js';
import {
  recoveryModeGauge,
  recoveryTransitionsTotal,
  reorgRollbackTotal,
  reorgRollbackDepthHistogram,
  gapRepairStartedTotal,
  gapRepairCompletedTotal,
  gapRepairFailedTotal,
  recoveryRetryTotal,
} from './recovery-metrics.js';

// ── Mode enum ─────────────────────────────────────────────────────────────────

export type RecoveryMode =
  | 'sync'
  | 'retry'
  | 'gap_repair'
  | 'reorg_rollback'
  | 'halted';

// Numeric values for the Prometheus gauge
const MODE_VALUES: Record<RecoveryMode, number> = {
  sync:           0,
  retry:          1,
  gap_repair:     2,
  reorg_rollback: 3,
  halted:         4,
};

// ── State ─────────────────────────────────────────────────────────────────────

export interface RecoveryState {
  mode: RecoveryMode;
  /** ISO-8601 timestamp when the current mode was entered. */
  enteredAt: string;
  /** Human-readable reason for the last transition. */
  reason: string | null;
  /** Number of consecutive retries in the current retry run (reset on sync). */
  consecutiveRetries: number;
  /** Ledger the last reorg rolled back to, or null. */
  lastReorgSafeLedger: number | null;
  /** Depth of the last detected reorg, or null. */
  lastReorgDepth: number | null;
  /** Gap ID currently being repaired, or null. */
  activeGapId: number | null;
  /** Total completed reorg rollbacks since startup. */
  totalReorgRollbacks: number;
  /** Total gap repairs completed since startup. */
  totalGapRepairs: number;
  /** Total gap repairs failed since startup. */
  totalGapRepairFailures: number;
}

const INITIAL_STATE: RecoveryState = {
  mode: 'sync',
  enteredAt: new Date().toISOString(),
  reason: null,
  consecutiveRetries: 0,
  lastReorgSafeLedger: null,
  lastReorgDepth: null,
  activeGapId: null,
  totalReorgRollbacks: 0,
  totalGapRepairs: 0,
  totalGapRepairFailures: 0,
};

// ── FSM class ─────────────────────────────────────────────────────────────────

class RecoveryStateMachine {
  private state: RecoveryState = { ...INITIAL_STATE };

  // ── Read ────────────────────────────────────────────────────────────────────

  getMode(): RecoveryMode { return this.state.mode; }
  getState(): Readonly<RecoveryState> { return { ...this.state }; }
  isHealthy(): boolean { return this.state.mode === 'sync'; }
  isHalted(): boolean { return this.state.mode === 'halted'; }

  // ── Transition helpers ──────────────────────────────────────────────────────

  private transition(next: RecoveryMode, patch: Partial<RecoveryState>, reason: string): void {
    const prev = this.state.mode;
    if (prev === next && next !== 'retry') return; // idempotent for most modes

    this.state = {
      ...this.state,
      ...patch,
      mode: next,
      enteredAt: new Date().toISOString(),
      reason,
    };

    // Metrics
    recoveryModeGauge.set(MODE_VALUES[next]);
    recoveryTransitionsTotal.labels({ from: prev, to: next }).inc();

    // Structured log
    logger.info('recovery-fsm: transition', {
      from: prev,
      to: next,
      reason,
      consecutiveRetries: this.state.consecutiveRetries,
    });

    // SSE broadcast so connected frontends can react in real-time
    try {
      emitSSEEvent({
        type: 'indexer-recovery-mode',
        mode: next,
        previousMode: prev,
        reason,
        timestamp: this.state.enteredAt,
      });
    } catch { /* never crash the FSM because of SSE */ }
  }

  // ── Public transition methods ───────────────────────────────────────────────

  /** Normal ledger advance succeeded — return to (or stay in) sync mode. */
  toSync(): void {
    this.transition('sync', { consecutiveRetries: 0, activeGapId: null }, 'ledger advance succeeded');
  }

  /**
   * A transient error occurred (RPC timeout, DB pool exhaustion, etc.).
   * Increments the consecutive-retry counter.
   */
  toRetry(reason: string): void {
    const retries = this.state.consecutiveRetries + 1;
    recoveryRetryTotal.inc();
    this.transition('retry', { consecutiveRetries: retries }, reason);
  }

  /**
   * Gap-repair worker has claimed a gap and started backfilling.
   * @param gapId  The LedgerGap.id being repaired.
   * @param from   fromLedger of the gap.
   * @param to     toLedger of the gap.
   */
  toGapRepair(gapId: number, from: number, to: number): void {
    gapRepairStartedTotal.inc();
    this.transition('gap_repair', { activeGapId: gapId },
      `repairing gap #${gapId} ledgers ${from}–${to}`);
  }

  /**
   * Gap repair completed successfully.
   */
  gapRepairComplete(gapId: number): void {
    const total = this.state.totalGapRepairs + 1;
    gapRepairCompletedTotal.inc();
    this.transition('sync', { activeGapId: null, consecutiveRetries: 0, totalGapRepairs: total },
      `gap #${gapId} repaired`);
  }

  /**
   * Gap repair failed after all retries.
   */
  gapRepairFailed(gapId: number, reason: string): void {
    const total = this.state.totalGapRepairFailures + 1;
    gapRepairFailedTotal.inc();
    logger.error('recovery-fsm: gap repair failed', { gapId, reason, total });
    // Return to sync so the poller keeps running — the Failed gap is persisted
    // in the DB for operator inspection.
    this.transition('sync', {
      activeGapId: null,
      totalGapRepairFailures: total,
    }, `gap #${gapId} repair failed: ${reason}`);
  }

  /**
   * Chain re-org detected; beginning rollback to safeLedger.
   * @param fromLedger   The diverged ledger where mismatch was found.
   * @param safeLedger   The safe rollback point.
   * @param depth        Number of ledgers being rolled back.
   */
  toReorgRollback(fromLedger: number, safeLedger: number, depth: number): void {
    reorgRollbackTotal.inc();
    reorgRollbackDepthHistogram.observe(depth);
    this.transition('reorg_rollback', {
      lastReorgSafeLedger: safeLedger,
      lastReorgDepth: depth,
    }, `reorg at ledger ${fromLedger}, rolling back to ${safeLedger} (depth=${depth})`);
  }

  /**
   * Re-org rollback committed successfully; resume normal sync.
   */
  reorgRollbackComplete(safeLedger: number): void {
    const total = this.state.totalReorgRollbacks + 1;
    this.transition('sync', {
      consecutiveRetries: 0,
      totalReorgRollbacks: total,
    }, `reorg rollback complete, resumed from ledger ${safeLedger}`);
  }

  /**
   * Critical re-org depth exceeded MAX_ROLLBACK_DEPTH — halt the poller.
   * Operator must call toSync() after manual verification.
   */
  toHalted(reason: string): void {
    this.transition('halted', {}, reason);
    logger.error('recovery-fsm: HALTED — manual operator action required', { reason });
  }

  /**
   * Operator has verified chain state and authorised resume.
   * Called by POST /admin/reorg-recovery.
   */
  operatorResume(operator?: string): void {
    this.transition('sync', { consecutiveRetries: 0 },
      `operator resume${operator ? ` by ${operator}` : ''}`);
    logger.info('recovery-fsm: operator resume accepted', { operator });
  }

  // ── Health summary (for /health/details) ───────────────────────────────────

  healthSummary(): {
    mode: RecoveryMode;
    healthy: boolean;
    halted: boolean;
    enteredAt: string;
    reason: string | null;
    consecutiveRetries: number;
    lastReorgDepth: number | null;
    lastReorgSafeLedger: number | null;
    activeGapId: number | null;
    totalReorgRollbacks: number;
    totalGapRepairs: number;
    totalGapRepairFailures: number;
  } {
    const s = this.state;
    return {
      mode: s.mode,
      healthy: s.mode === 'sync',
      halted: s.mode === 'halted',
      enteredAt: s.enteredAt,
      reason: s.reason,
      consecutiveRetries: s.consecutiveRetries,
      lastReorgDepth: s.lastReorgDepth,
      lastReorgSafeLedger: s.lastReorgSafeLedger,
      activeGapId: s.activeGapId,
      totalReorgRollbacks: s.totalReorgRollbacks,
      totalGapRepairs: s.totalGapRepairs,
      totalGapRepairFailures: s.totalGapRepairFailures,
    };
  }

  /** Reset to initial state — for use in tests only. */
  _resetForTest(): void {
    this.state = { ...INITIAL_STATE, enteredAt: new Date().toISOString() };
    try { recoveryModeGauge.set(MODE_VALUES['sync']); } catch { /* ignore in tests */ }
  }
}

// ── Singleton export ──────────────────────────────────────────────────────────

export const recoveryFSM = new RecoveryStateMachine();
