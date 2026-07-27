/**
 * stall.ts — Multi-signal stall detector for the indexer polling loop.
 *
 * Monitors three independent signals:
 *   1. Time since last successful ledger advance (existing signal)
 *   2. Consecutive RPC failures (new signal)
 *   3. Time since last database write (new signal)
 *
 * Escalates through three severity levels based on the worst-case signal:
 *
 *   WARNING  (>stallWarningMs)  : increment Prometheus counter + log warn
 *   CRITICAL (>stallCriticalMs) : WARNING actions + emit SSE "indexer-stalled"
 *   FATAL    (>stallFatalMs)    : CRITICAL actions + restart poller (up to
 *                                 MAX_RESTART_ATTEMPTS times, then process.exit)
 *
 * The detector runs on a fixed poll interval (WATCHDOG_INTERVAL_MS). It keeps
 * track of which level it last fired at so repeated firings at the same level
 * do not re-emit SSE events or attempt a second restart until the stall
 * resolves and re-escalates.
 */

import { stalledGauge, pollerStallTotal, pollerRestartTotal } from './metrics.js';
import { logger } from './logger.js';
import { loadConfig } from './config.js';
import { emitSSEEvent } from './api/routes.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** How often the watchdog timer fires to evaluate all signals (ms). */
const WATCHDOG_INTERVAL_MS = 5_000;

/** Maximum number of automatic restarts before giving up and exiting. */
export const MAX_RESTART_ATTEMPTS = 3;

/** How many consecutive RPC failures trigger a WARNING-level stall signal. */
export const RPC_FAILURE_WARNING_THRESHOLD = 5;

// ── Stall levels ─────────────────────────────────────────────────────────────

export type StallLevel = 'none' | 'warning' | 'critical' | 'fatal';

const LEVEL_ORDER: StallLevel[] = ['none', 'warning', 'critical', 'fatal'];

function isHigherLevel(a: StallLevel, b: StallLevel): boolean {
  return LEVEL_ORDER.indexOf(a) > LEVEL_ORDER.indexOf(b);
}

// ── Mutable signal state ──────────────────────────────────────────────────────

/** Timestamp (ms) of the last call to recordProgress(). 0 = never. */
let lastProgressAt = 0;

/** Timestamp (ms) of the last call to recordDbWrite(). 0 = never. */
let lastDbWriteAt = 0;

/** Number of consecutive RPC failures since the last success. */
let consecutiveRpcFailures = 0;

/** The stall level that was fired on the previous watchdog tick. */
let lastFiredLevel: StallLevel = 'none';

/** Number of automatic restart attempts made so far. */
let restartAttempts = 0;

/** Handle for the watchdog setInterval (used to stop it in tests). */
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

/** Legacy single-threshold timer handle (kept for backward compat / existing tests). */
let stallTimer: ReturnType<typeof setTimeout> | null = null;

// ── Poller lifecycle hooks (injected at startup to avoid circular deps) ───────

type PollerLifecycle = {
  stopPoller: () => void;
  startPoller: () => Promise<void>;
};

let _pollerLifecycle: PollerLifecycle | null = null;

/**
 * Register the poller start/stop functions so the stall detector can restart
 * the poller on a FATAL stall without importing poller.ts directly (which
 * would create a circular dependency via the stall → routes → poller chain).
 *
 * Must be called once during process startup, before the watchdog starts.
 */
export function registerPollerLifecycle(lifecycle: PollerLifecycle): void {
  _pollerLifecycle = lifecycle;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Record that a ledger batch was processed successfully.
 * Resets the stalledGauge to 0 and refreshes the progress timestamp.
 * Also counts as a DB write (the ledger advance always writes to the DB).
 */
export function recordProgress(): void {
  lastProgressAt = Date.now();
  lastDbWriteAt = Date.now();
  consecutiveRpcFailures = 0;
  stalledGauge.set(0);
  lastFiredLevel = 'none';
  restartAttempts = 0;

  if (stallTimer) {
    clearTimeout(stallTimer);
    stallTimer = null;
  }
}

/**
 * Record that a database write succeeded (e.g. event insertion, sync state
 * update).  Call this any time the poller successfully commits data.
 */
export function recordDbWrite(): void {
  lastDbWriteAt = Date.now();
}

/**
 * Record that an RPC call failed.  Consecutive failures accumulate; a
 * successful call (via recordProgress) resets the counter.
 */
export function recordRpcFailure(): void {
  consecutiveRpcFailures += 1;
}

/**
 * Returns true when the indexer is considered stalled (any signal exceeds the
 * WARNING threshold).  Used by the /readyz health endpoint.
 */
export function isStalled(): boolean {
  return computeStallLevel() !== 'none';
}

// ── Internal evaluation ───────────────────────────────────────────────────────

function computeStallLevel(): StallLevel {
  const cfg = loadConfig();
  const now = Date.now();

  // Signal 1: time since last ledger advance
  const ledgerStaleMs = lastProgressAt > 0 ? now - lastProgressAt : 0;
  // Signal 2: time since last DB write (independent of ledger advance)
  const dbStaleMs = lastDbWriteAt > 0 ? now - lastDbWriteAt : 0;
  // Largest of the two time-based signals drives the level determination
  const worstTimeMs = Math.max(ledgerStaleMs, dbStaleMs);

  // Signal 3: consecutive RPC failures mapped to a time-equivalent bucket
  // We treat sustained RPC failures as a WARNING regardless of elapsed time so
  // that a fast-failing loop (low poll interval) does not need to wait 30 s.
  const rpcSignalLevel: StallLevel =
    consecutiveRpcFailures >= RPC_FAILURE_WARNING_THRESHOLD ? 'warning' : 'none';

  // Time-based level
  let timeLevel: StallLevel = 'none';
  if (lastProgressAt > 0 || lastDbWriteAt > 0) {
    if (worstTimeMs > cfg.stallFatalMs) {
      timeLevel = 'fatal';
    } else if (worstTimeMs > cfg.stallCriticalMs) {
      timeLevel = 'critical';
    } else if (worstTimeMs > cfg.stallWarningMs) {
      timeLevel = 'warning';
    }
  }

  // Take the worst of both signals
  return isHigherLevel(rpcSignalLevel, timeLevel) ? rpcSignalLevel : timeLevel;
}

async function handleStallLevel(level: StallLevel): Promise<void> {
  if (level === 'none') {
    // Resolved — if we were previously stalled, clear the gauge
    if (lastFiredLevel !== 'none') {
      stalledGauge.set(0);
      lastFiredLevel = 'none';
    }
    return;
  }

  const cfg = loadConfig();
  const now = Date.now();
  const ledgerStaleMs = lastProgressAt > 0 ? now - lastProgressAt : 0;
  const dbStaleMs = lastDbWriteAt > 0 ? now - lastDbWriteAt : 0;
  const stallDurationMs = Math.max(ledgerStaleMs, dbStaleMs);

  // ── WARNING ───────────────────────────────────────────────────────────────
  // Always fire on each new level (including re-fires at the same level) so
  // the counter faithfully tracks how many watchdog ticks detected a stall.
  pollerStallTotal.labels(level).inc();
  stalledGauge.set(1);

  if (level === 'warning') {
    logger.warn('stall-detector: WARNING — indexer stall detected', {
      stallDurationMs,
      consecutiveRpcFailures,
      lastProgressAt: lastProgressAt ? new Date(lastProgressAt).toISOString() : 'never',
      lastDbWriteAt: lastDbWriteAt ? new Date(lastDbWriteAt).toISOString() : 'never',
    });
  }

  // ── CRITICAL ──────────────────────────────────────────────────────────────
  if (level === 'critical' || level === 'fatal') {
    logger.error('stall-detector: CRITICAL — indexer stall escalated', {
      level,
      stallDurationMs,
      consecutiveRpcFailures,
    });

    // Only emit the SSE event once per escalation to this level (not on every
    // repeated tick) so frontend clients get one notification per incident.
    if (!isHigherLevel(lastFiredLevel, 'critical') && lastFiredLevel !== 'critical') {
      emitSSEEvent({
        type: 'indexer-stalled',
        stallDurationMs,
        level,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // ── FATAL ─────────────────────────────────────────────────────────────────
  if (level === 'fatal' && lastFiredLevel !== 'fatal') {
    if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
      logger.error(
        'stall-detector: FATAL — max restart attempts reached, exiting process',
        { restartAttempts, stallDurationMs }
      );
      process.exit(1);
    }

    restartAttempts += 1;
    pollerRestartTotal.inc();
    logger.error('stall-detector: FATAL — attempting automatic poller restart', {
      attempt: restartAttempts,
      maxAttempts: MAX_RESTART_ATTEMPTS,
      stallDurationMs,
    });

    if (_pollerLifecycle) {
      try {
        _pollerLifecycle.stopPoller();
        // Brief pause to let in-flight operations drain before restarting
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        await _pollerLifecycle.startPoller();
        logger.info('stall-detector: poller restarted successfully', {
          attempt: restartAttempts,
        });
        // Reset time signals after a successful restart; RPC failures will
        // clear on the next successful recordProgress() call from the new loop.
        lastProgressAt = Date.now();
        lastDbWriteAt = Date.now();
      } catch (err) {
        logger.error('stall-detector: poller restart failed', {
          attempt: restartAttempts,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      logger.warn('stall-detector: no poller lifecycle registered — cannot restart');
    }
  }

  lastFiredLevel = level;
}

// ── Watchdog lifecycle ────────────────────────────────────────────────────────

/**
 * Start the periodic watchdog that evaluates all stall signals and escalates
 * through WARNING → CRITICAL → FATAL as the stall persists.
 *
 * Safe to call multiple times — a second call is a no-op if the watchdog is
 * already running.
 */
export function startWatchdog(): void {
  if (watchdogTimer !== null) return;
  watchdogTimer = setInterval(() => {
    const level = computeStallLevel();
    handleStallLevel(level).catch((err) => {
      logger.error('stall-detector: unhandled error in watchdog handler', { err });
    });
  }, WATCHDOG_INTERVAL_MS);
  // Allow the Node.js event loop to exit even if this timer is still pending
  if (typeof watchdogTimer === 'object' && watchdogTimer !== null && 'unref' in watchdogTimer) {
    (watchdogTimer as any).unref();
  }
}

/**
 * Stop the watchdog interval.  Primarily used in tests and during graceful
 * shutdown to prevent late-firing callbacks after the process is winding down.
 */
export function stopWatchdog(): void {
  if (watchdogTimer !== null) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

/**
 * Reset all internal state.  Used exclusively in tests to ensure each test
 * case starts from a clean slate without module re-imports.
 */
export function resetStallStateForTest(): void {
  lastProgressAt = 0;
  lastDbWriteAt = 0;
  consecutiveRpcFailures = 0;
  lastFiredLevel = 'none';
  restartAttempts = 0;
  if (stallTimer) {
    clearTimeout(stallTimer);
    stallTimer = null;
  }
  stopWatchdog();
  _pollerLifecycle = null;
}

// ── Legacy single-threshold compatibility ─────────────────────────────────────
//
// STALL_THRESHOLD_MS is retained so existing callers that read it from this
// module keep working.  The watchdog supersedes the old setTimeout approach.

export const STALL_THRESHOLD_MS = parseInt(process.env.STALL_THRESHOLD_MS || '60000');
