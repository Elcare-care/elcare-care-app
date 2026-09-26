/**
 * contract-registry-metrics.ts
 *
 * Per-contract Prometheus metrics for the formal contract registry (Issue #441).
 *
 * Metrics are labelled with three dimensions so every dashboard panel can
 * filter and group by contract, label, and type simultaneously:
 *
 *   contract_id  — the Soroban C… address
 *   label        — the human-readable label from config (e.g. "marketplace")
 *   contract_type — "marketplace" | "launchpad"
 *
 * Kept in a separate file (like recovery-metrics.ts) so the registry module
 * can import it without pulling in the full metrics.ts bundle and risking
 * double-registration in tests.
 */

import client from 'prom-client';

// ── Safe constructors (guard against double-registration in vitest) ───────────

function safeGauge(opts: client.GaugeConfiguration<string>): client.Gauge {
  try {
    return new client.Gauge(opts);
  } catch {
    const reg = client.register as any;
    const existing = typeof reg.getSingleMetric === 'function'
      ? reg.getSingleMetric(opts.name) : null;
    return existing ?? ({
      labels: () => ({ set: () => {} }),
      set: () => {},
    } as unknown as client.Gauge);
  }
}

function safeCounter(opts: client.CounterConfiguration<string>): client.Counter {
  try {
    return new client.Counter(opts);
  } catch {
    const reg = client.register as any;
    const existing = typeof reg.getSingleMetric === 'function'
      ? reg.getSingleMetric(opts.name) : null;
    return existing ?? ({
      labels: () => ({ inc: () => {} }),
      inc: () => {},
    } as unknown as client.Counter);
  }
}

// ── Per-contract metrics ──────────────────────────────────────────────────────

/**
 * How many ledgers this contract is behind the current network tip.
 * Updated after every getLatestLedger() call.
 */
export const contractLagLedgersGauge = safeGauge({
  name:       'elcarehub_contract_lag_ledgers',
  help:       'Number of ledgers each tracked contract is behind the network tip',
  labelNames: ['contract_id', 'label', 'contract_type'],
});

/**
 * The last committed ledger sequence for each tracked contract.
 */
export const contractLastLedgerGauge = safeGauge({
  name:       'elcarehub_contract_last_ledger',
  help:       'Last ledger sequence committed for each tracked contract',
  labelNames: ['contract_id', 'label', 'contract_type'],
});

/**
 * Current health state of each tracked contract.
 *
 *   0 = idle
 *   1 = syncing
 *   2 = stalled
 *   3 = gapped
 *   4 = failed
 *   5 = disabled
 */
export const contractHealthGauge = safeGauge({
  name:       'elcarehub_contract_health_state',
  help:       'Health state of each tracked contract (0=idle,1=syncing,2=stalled,3=gapped,4=failed,5=disabled)',
  labelNames: ['contract_id', 'label', 'contract_type'],
});

/**
 * Total stall events detected per contract since startup.
 * A stall event is when no ledger progress was made within CONTRACT_STALL_THRESHOLD_MS.
 */
export const contractStallEventsTotal = safeCounter({
  name:       'elcarehub_contract_stall_events_total',
  help:       'Total stall events (no progress for threshold duration) per tracked contract',
  labelNames: ['contract_id', 'label', 'contract_type'],
});

/**
 * Total gap events detected per contract since startup.
 * A gap event is when a range of ledgers had to be skipped (outside RPC window,
 * reorg skip, etc.).
 */
export const contractGapEventsTotal = safeCounter({
  name:       'elcarehub_contract_gap_events_total',
  help:       'Total gap events (skipped ledger ranges) per tracked contract',
  labelNames: ['contract_id', 'label', 'contract_type'],
});

/**
 * Maximum ledger jump (sequence advance) observed in a single polling batch
 * for each contract.  A large jump may indicate a reorg recovery or gap skip.
 */
export const contractMaxLedgerJumpGauge = safeGauge({
  name:       'elcarehub_contract_max_ledger_jump',
  help:       'Maximum ledger sequence jump seen in a single batch per tracked contract',
  labelNames: ['contract_id', 'label', 'contract_type'],
});

/**
 * Unix timestamp (seconds) when the contract was registered in the runtime
 * registry.  Useful for calculating how long a contract has been tracked.
 */
export const contractStartupTimestampGauge = safeGauge({
  name:       'elcarehub_contract_startup_timestamp_seconds',
  help:       'Unix timestamp when each contract was first registered in the runtime registry',
  labelNames: ['contract_id', 'label', 'contract_type'],
});
