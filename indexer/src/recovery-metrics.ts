/**
 * recovery-metrics.ts — Prometheus metrics for the recovery state machine.
 *
 * Kept in a separate file so recovery-state-machine.ts can import them
 * without pulling in the full metrics.ts module (which registers 40+
 * counters and would double-register them in tests).
 *
 * All metric names use the `indexer_recovery_` prefix so they are trivially
 * groupable in Grafana dashboards.
 */

import client from 'prom-client';

function safeGauge(opts: client.GaugeConfiguration<string>): client.Gauge {
  try {
    return new client.Gauge(opts);
  } catch {
    const reg = client.register as any;
    const existing = typeof reg.getSingleMetric === 'function'
      ? reg.getSingleMetric(opts.name) : null;
    return existing ?? ({ set: () => {}, labels: () => ({ set: () => {} }) } as unknown as client.Gauge);
  }
}

function safeCounter(opts: client.CounterConfiguration<string>): client.Counter {
  try {
    return new client.Counter(opts);
  } catch {
    const reg = client.register as any;
    const existing = typeof reg.getSingleMetric === 'function'
      ? reg.getSingleMetric(opts.name) : null;
    return existing ?? ({ inc: () => {}, labels: () => ({ inc: () => {} }) } as unknown as client.Counter);
  }
}

function safeHistogram(opts: client.HistogramConfiguration<string>): client.Histogram {
  try {
    return new client.Histogram(opts);
  } catch {
    const reg = client.register as any;
    const existing = typeof reg.getSingleMetric === 'function'
      ? reg.getSingleMetric(opts.name) : null;
    return existing ?? ({ observe: () => {}, labels: () => ({ observe: () => {} }) } as unknown as client.Histogram);
  }
}

// ── Recovery mode gauge ───────────────────────────────────────────────────────
// 0=sync 1=retry 2=gap_repair 3=reorg_rollback 4=halted

export const recoveryModeGauge = safeGauge({
  name: 'indexer_recovery_mode',
  help: 'Current recovery mode of the indexer (0=sync,1=retry,2=gap_repair,3=reorg_rollback,4=halted)',
});

// ── Transition counter ────────────────────────────────────────────────────────

export const recoveryTransitionsTotal = safeCounter({
  name: 'indexer_recovery_transitions_total',
  help: 'Total recovery mode transitions, labelled by from→to',
  labelNames: ['from', 'to'],
});

// ── Retry counter ─────────────────────────────────────────────────────────────

export const recoveryRetryTotal = safeCounter({
  name: 'indexer_recovery_retry_total',
  help: 'Total retry events entered by the recovery FSM',
});

// ── Reorg metrics ─────────────────────────────────────────────────────────────

export const reorgRollbackTotal = safeCounter({
  name: 'indexer_reorg_rollback_total',
  help: 'Total chain reorg rollbacks initiated',
});

export const reorgRollbackDepthHistogram = safeHistogram({
  name: 'indexer_reorg_rollback_depth',
  help: 'Depth (ledger count) of each chain reorg rollback',
  buckets: [1, 2, 5, 10, 20, 50, 100],
});

export const reorgRollbackDurationSeconds = safeHistogram({
  name: 'indexer_reorg_rollback_duration_seconds',
  help: 'Wall-clock duration of each reorg rollback operation',
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30],
});

// ── Gap-repair metrics ────────────────────────────────────────────────────────

export const gapRepairStartedTotal = safeCounter({
  name: 'indexer_gap_repair_started_total',
  help: 'Total gap repair operations started',
});

export const gapRepairCompletedTotal = safeCounter({
  name: 'indexer_gap_repair_completed_total',
  help: 'Total gap repair operations completed successfully',
});

export const gapRepairFailedTotal = safeCounter({
  name: 'indexer_gap_repair_failed_total',
  help: 'Total gap repair operations that failed after all retries',
});

export const gapRepairDurationSeconds = safeHistogram({
  name: 'indexer_gap_repair_duration_seconds',
  help: 'Wall-clock duration of each gap repair operation in seconds',
  buckets: [1, 5, 15, 30, 60, 120, 300, 600],
});

export const gapLengthLedgers = safeHistogram({
  name: 'indexer_gap_length_ledgers',
  help: 'Number of ledgers covered by each repaired gap',
  buckets: [10, 100, 500, 1000, 5000, 10000, 50000],
});

// ── Replay metrics ────────────────────────────────────────────────────────────

export const replayRangeStartedTotal = safeCounter({
  name: 'indexer_replay_range_started_total',
  help: 'Total ledger-range replay operations initiated (from checkpoint or gap)',
});

export const replayRangeCompletedTotal = safeCounter({
  name: 'indexer_replay_range_completed_total',
  help: 'Total ledger-range replay operations completed successfully',
});

export const replayRangeDurationSeconds = safeHistogram({
  name: 'indexer_replay_range_duration_seconds',
  help: 'Duration of ledger-range replay operations in seconds',
  buckets: [1, 5, 15, 30, 60, 120, 300],
});

export const replayEventsInserted = safeHistogram({
  name: 'indexer_replay_events_inserted',
  help: 'Number of events inserted during a replay operation',
  buckets: [0, 1, 10, 50, 100, 500, 1000],
});
