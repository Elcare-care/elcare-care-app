/**
 * db-health.ts — Connection pool health probe.
 *
 * Runs a lightweight `SELECT 1` query every DB_HEALTH_INTERVAL_MS (default 30 s).
 * If the probe takes longer than DB_HEALTH_WARN_THRESHOLD_MS (default 1 000 ms),
 * a warning is logged: this is a reliable signal of pool exhaustion or
 * PostgreSQL under severe load before requests start timing out visibly.
 *
 * Usage (call once at startup in index.ts):
 *   import { startDbHealthProbe, stopDbHealthProbe } from './db-health.js';
 *   const stopProbe = startDbHealthProbe();
 *   // ... on shutdown ...
 *   stopProbe();
 */

import prisma from './db.js';
import { logger } from './logger.js';

// ── Configuration ─────────────────────────────────────────────────────────────

const PROBE_INTERVAL_MS = parseInt(
  process.env.DB_HEALTH_INTERVAL_MS || '30000', // 30 s
  10,
);

const WARN_THRESHOLD_MS = parseInt(
  process.env.DB_HEALTH_WARN_THRESHOLD_MS || '1000', // 1 s
  10,
);

// ── Probe implementation ──────────────────────────────────────────────────────

/**
 * Execute a single `SELECT 1` health probe.
 * Returns the round-trip latency in ms.
 * Throws when the query itself fails (connection refused, auth error, etc.).
 */
export async function runDbHealthProbe(): Promise<number> {
  const start = Date.now();
  await prisma.$queryRaw`SELECT 1`;
  return Date.now() - start;
}

// ── Scheduled probe ───────────────────────────────────────────────────────────

let probeInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic health probe.
 * Returns a stop function; call it during graceful shutdown to cancel the timer.
 */
export function startDbHealthProbe(): () => void {
  if (probeInterval !== null) {
    logger.warn('[db-health] Probe already running — ignoring duplicate start');
    return () => {};
  }

  logger.info('[db-health] Starting health probe', {
    intervalMs:    PROBE_INTERVAL_MS,
    warnThresholdMs: WARN_THRESHOLD_MS,
  });

  probeInterval = setInterval(async () => {
    try {
      const latencyMs = await runDbHealthProbe();

      if (latencyMs > WARN_THRESHOLD_MS) {
        // Latency above threshold — likely indicates pool exhaustion or slow PG.
        logger.warn('[db-health] SELECT 1 probe slow — possible pool exhaustion', {
          latencyMs,
          warnThresholdMs: WARN_THRESHOLD_MS,
        });
      } else {
        logger.debug('[db-health] SELECT 1 probe OK', { latencyMs });
      }
    } catch (err) {
      // Complete probe failure — DB unreachable or pool totally exhausted.
      logger.error('[db-health] SELECT 1 probe failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, PROBE_INTERVAL_MS);

  // Allow Node.js to exit even if this timer is still scheduled.
  if (probeInterval.unref) probeInterval.unref();

  return () => {
    if (probeInterval !== null) {
      clearInterval(probeInterval);
      probeInterval = null;
      logger.info('[db-health] Health probe stopped');
    }
  };
}

export function stopDbHealthProbe(): void {
  if (probeInterval !== null) {
    clearInterval(probeInterval);
    probeInterval = null;
  }
}
