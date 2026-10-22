/**
 * rpc-provider-pool.ts — Ordered RPC provider pool with health scoring,
 * failover cooldown, and network-passphrase verification.
 *
 * Features:
 *   - Ordered pool: providers tried in priority order; first healthy wins.
 *   - Health scoring: tracks latency, errors, and consecutive failures per provider.
 *   - Failover cooldown: a failed primary stays in cooldown before re-promotion.
 *   - Network-passphrase guard: rejects providers whose chain does not match the
 *     active network passphrase without explicit recovery handling.
 *   - Stale ledger guard: rejects providers whose latest ledger is behind the
 *     current active provider by more than STALE_LEDGER_THRESHOLD.
 *   - Recovery to primary: primary is re-probed after RECOVERY_PROBE_INTERVAL_MS
 *     and promoted back if healthy and chain-compatible.
 *
 * Usage:
 *   const pool = new RpcProviderPool([
 *     { url: 'https://primary.rpc', priority: 0 },
 *     { url: 'https://fallback.rpc', priority: 1 },
 *   ]);
 *   const server = await pool.getHealthyServer();
 *   const ledger = await pool.call((s) => s.getLatestLedger());
 */

import { rpc } from '@stellar/stellar-sdk';
import { logger } from './logger.js';
import client from 'prom-client';

// ── Stable provider label (Issue #928) ────────────────────────────────────────
//
// Metric labels must never contain raw URLs, credentials, or unbounded strings.
// `resolveProviderLabel` derives a short, stable identifier from the optional
// human-readable `label` field.  When no label is supplied it falls back to
// just the hostname extracted from the URL (strips scheme, credentials, path,
// and query string).  This keeps cardinality bounded and secrets out of labels.
//
// Examples:
//   label="primary"                  → "primary"
//   label=undefined, url="https://user:pass@rpc.example.com/v1?key=abc"
//                                    → "rpc.example.com"

export function resolveProviderLabel(config: Pick<ProviderConfig, 'url' | 'label'>): string {
  if (config.label && config.label.trim() !== '') {
    // Use the human-readable label as-is — it is always operator-supplied and
    // bounded by convention (e.g. "primary", "fallback", "regional-eu").
    return config.label.trim();
  }
  // Extract just the hostname; discard scheme, credentials, path, and query.
  try {
    return new URL(config.url).hostname;
  } catch {
    // URL is malformed — use a fixed placeholder so labels remain bounded.
    return 'unknown';
  }
}

// ── Prometheus metrics ─────────────────────────────────────────────────────────
//
// All labels use the stable provider identifier returned by resolveProviderLabel,
// never raw URLs or credential-bearing strings (Issue #928).

export const rpcProviderActiveGauge = new client.Gauge({
  name: 'indexer_rpc_provider_active',
  help: 'Index of the currently active RPC provider (0=primary)',
  labelNames: ['provider'],
});

export const rpcProviderFailoversTotal = new client.Counter({
  name: 'indexer_rpc_provider_failovers_total',
  help: 'Total RPC provider failovers',
  labelNames: ['from', 'to'],
});

export const rpcProviderRecoveriesTotal = new client.Counter({
  name: 'indexer_rpc_provider_recoveries_total',
  help: 'Total recoveries back to the primary provider',
  labelNames: ['provider'],
});

export const rpcProviderErrorsTotal = new client.Counter({
  name: 'indexer_rpc_provider_errors_total',
  help: 'Total RPC errors per provider',
  labelNames: ['provider'],
});

export const rpcProviderLatencyHistogram = new client.Histogram({
  name: 'indexer_rpc_provider_latency_seconds',
  help: 'RPC call latency per provider',
  labelNames: ['provider'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

// ── Configuration ──────────────────────────────────────────────────────────────

export interface ProviderConfig {
  /** Stellar RPC URL. */
  url: string;
  /** Priority order (0 = highest priority / primary). */
  priority: number;
  /** Optional human-readable label for logs/metrics. */
  label?: string;
}

/**
 * Parse an environment variable as a positive integer within an inclusive
 * [min, max] range.  Fails fast at startup so misconfigured timers or
 * thresholds are caught before they influence any failover or recovery
 * decision.
 *
 * - When the variable is unset the `defaultValue` is returned without
 *   validation (defaults are always in-range by construction).
 * - The error message names the environment variable but never echoes its
 *   value — this prevents endpoint URLs or tokens embedded in the string
 *   from appearing in logs or process output.
 */
export function parsePositiveIntEnv(
  name: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return defaultValue;
  }

  const parsed = parseInt(raw, 10);

  if (!Number.isFinite(parsed) || String(parsed) !== raw.trim()) {
    throw new Error(
      `[RpcProviderPool] ${name} must be a finite integer (received non-numeric value)`,
    );
  }
  if (parsed < min || parsed > max) {
    throw new Error(
      `[RpcProviderPool] ${name} must be between ${min} and ${max} (inclusive)`,
    );
  }

  return parsed;
}

// Accepted bounds are chosen to match operational expectations:
//   FAILOVER_COOLDOWN_MS     : 1 s – 1 h  (prevents instant re-promotion or infinite lockout)
//   STALE_LEDGER_THRESHOLD   : 1 – 10 000 (one ledger minimum; 10 k ledgers ≈ ~14 hours of drift)
//   RECOVERY_PROBE_INTERVAL_MS: 1 s – 1 h  (prevents hammering or no-op recovery timer)
//   MAX_CONSECUTIVE_ERRORS   : 1 – 1 000  (at least one error before failover; upper cap prevents overflow)

const FAILOVER_COOLDOWN_MS = parsePositiveIntEnv(
  'RPC_FAILOVER_COOLDOWN_MS',
  60_000,   // 60 s default
  1_000,    // min: 1 s
  3_600_000 // max: 1 h
);

const STALE_LEDGER_THRESHOLD = parsePositiveIntEnv(
  'RPC_STALE_LEDGER_THRESHOLD',
  50,    // default: 50 ledgers
  1,     // min: 1 ledger
  10_000 // max: ~14 h of ledgers
);

const RECOVERY_PROBE_INTERVAL_MS = parsePositiveIntEnv(
  'RPC_RECOVERY_PROBE_MS',
  30_000,   // 30 s default
  1_000,    // min: 1 s
  3_600_000 // max: 1 h
);

const MAX_CONSECUTIVE_ERRORS = parsePositiveIntEnv(
  'RPC_MAX_CONSECUTIVE_ERRORS',
  5,    // default: 5 errors
  1,    // min: 1 (fail over after the very first error if desired)
  1_000 // max: 1 000 (sanity cap)
);

// ── Provider health state ──────────────────────────────────────────────────────

export interface ProviderHealth {
  config: ProviderConfig;
  /** Stable, bounded metric label derived via resolveProviderLabel (Issue #928). */
  providerLabel: string;
  server: rpc.Server;
  consecutiveErrors: number;
  totalErrors: number;
  totalCalls: number;
  cumulativeLatencyMs: number;
  /** When this provider entered cooldown (null if not in cooldown). */
  cooldownSince: number | null;
  /** Last known ledger sequence from a successful health check. */
  lastKnownLedger: number;
  /** Network passphrase returned by this provider (null until first check). */
  networkPassphrase: string | null;
  /** Whether this provider has been verified as chain-compatible. */
  chainVerified: boolean;
}

/** Returns average latency in ms, or 0 when no calls have been made. */
export function avgLatencyMs(health: ProviderHealth): number {
  if (health.totalCalls === 0) return 0;
  return health.cumulativeLatencyMs / health.totalCalls;
}

// ── RpcProviderPool ────────────────────────────────────────────────────────────

export class RpcProviderPool {
  private readonly providers: ProviderHealth[];
  /** Index of the currently active provider in this.providers. */
  private activeIndex: number = 0;
  /** Expected network passphrase (set from first successful getNetwork call). */
  private expectedNetworkPassphrase: string | null =
    process.env.STELLAR_NETWORK ?? null;
  /** Last ledger seen across all providers — used for stale detection. */
  private globalLatestLedger: number = 0;
  /** Timer reference for periodic primary recovery probes. */
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(configs: ProviderConfig[]) {
    if (configs.length === 0) {
      throw new Error('[RpcProviderPool] At least one provider config is required');
    }

    // Sort by priority ascending (0 = primary)
    const sorted = [...configs].sort((a, b) => a.priority - b.priority);

    this.providers = sorted.map((cfg) => ({
      config: cfg,
      providerLabel: resolveProviderLabel(cfg),
      server: new rpc.Server(cfg.url),
      consecutiveErrors: 0,
      totalErrors: 0,
      totalCalls: 0,
      cumulativeLatencyMs: 0,
      cooldownSince: null,
      lastKnownLedger: 0,
      networkPassphrase: null,
      chainVerified: false,
    }));

    logger.info('[RpcProviderPool] Initialized', {
      providers: sorted.map((c) => ({ url: c.url, priority: c.priority })),
    });

    // Start periodic primary recovery probing if we have more than one provider
    if (this.providers.length > 1) {
      this.recoveryTimer = setInterval(
        () => void this.probePrimaryRecovery(),
        RECOVERY_PROBE_INTERVAL_MS
      );
    }
  }

  /** Release resources (clears recovery timer). */
  destroy(): void {
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Returns the currently active healthy provider's rpc.Server instance.
   * Triggers failover if the active provider is unhealthy.
   */
  async getHealthyServer(): Promise<rpc.Server> {
    const health = await this.selectHealthyProvider();
    return health.server;
  }

  /**
   * Execute an RPC call through the pool, automatically failing over to
   * the next healthy provider on error.
   *
   * @param fn  Function that receives an rpc.Server and returns a promise.
   */
  async call<T>(fn: (server: rpc.Server) => Promise<T>): Promise<T> {
    let lastErr: unknown;

    for (let attempt = 0; attempt < this.providers.length; attempt++) {
      const health = await this.selectHealthyProvider();
      const start = Date.now();

      try {
        const result = await fn(health.server);
        const latencyMs = Date.now() - start;

        this.recordSuccess(health, latencyMs);
        rpcProviderLatencyHistogram.labels(health.providerLabel).observe(latencyMs / 1000);

        return result;
      } catch (err) {
        lastErr = err;
        const latencyMs = Date.now() - start;
        rpcProviderLatencyHistogram.labels(health.providerLabel).observe(latencyMs / 1000);
        rpcProviderErrorsTotal.labels(health.providerLabel).inc();

        this.recordError(health);

        if (health.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          await this.failover(health);
        }
      }
    }

    throw lastErr;
  }

  /** Returns current pool status for health/metrics endpoints. */
  getStatus(): {
    activeUrl: string;
    activeIndex: number;
    expectedNetworkPassphrase: string | null;
    providers: Array<{
      url: string;
      label: string;
      priority: number;
      consecutiveErrors: number;
      inCooldown: boolean;
      cooldownRemainingMs: number;
      lastKnownLedger: number;
      chainVerified: boolean;
      avgLatencyMs: number;
    }>;
  } {
    const active = this.providers[this.activeIndex];
    return {
      activeUrl: active.config.url,
      activeIndex: this.activeIndex,
      expectedNetworkPassphrase: this.expectedNetworkPassphrase,
      providers: this.providers.map((p) => ({
        url: p.config.url,
        label: p.providerLabel,
        priority: p.config.priority,
        consecutiveErrors: p.consecutiveErrors,
        inCooldown: this.isInCooldown(p),
        cooldownRemainingMs: this.cooldownRemainingMs(p),
        lastKnownLedger: p.lastKnownLedger,
        chainVerified: p.chainVerified,
        avgLatencyMs: avgLatencyMs(p),
      })),
    };
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private async selectHealthyProvider(): Promise<ProviderHealth> {
    // Try active provider first
    const active = this.providers[this.activeIndex];
    if (!this.isInCooldown(active)) {
      return active;
    }

    // Active is in cooldown — find next healthy candidate
    for (let i = 0; i < this.providers.length; i++) {
      if (i === this.activeIndex) continue;
      const candidate = this.providers[i];
      if (!this.isInCooldown(candidate)) {
        // Verify chain compatibility before switching
        const compatible = await this.verifyChainCompatibility(candidate);
        if (compatible) {
          await this.failover(active, candidate);
          return candidate;
        }
        logger.warn('[RpcProviderPool] Candidate provider chain mismatch — skipping', {
          url: candidate.config.url,
          expectedPassphrase: this.expectedNetworkPassphrase,
          candidatePassphrase: candidate.networkPassphrase,
        });
      }
    }

    // All providers exhausted — return active anyway (let caller handle errors)
    logger.error('[RpcProviderPool] All providers in cooldown or incompatible — using primary', {
      activeUrl: active.config.url,
    });
    return active;
  }

  private async verifyChainCompatibility(health: ProviderHealth): Promise<boolean> {
    if (health.chainVerified && health.networkPassphrase !== null) {
      // Already verified — fast path
      if (this.expectedNetworkPassphrase === null) return true;
      return health.networkPassphrase === this.expectedNetworkPassphrase;
    }

    try {
      const network = await health.server.getNetwork();
      health.networkPassphrase = network.passphrase ?? null;

      if (this.expectedNetworkPassphrase === null) {
        // First provider — set the baseline
        this.expectedNetworkPassphrase = health.networkPassphrase;
        health.chainVerified = true;
        return true;
      }

      if (health.networkPassphrase !== this.expectedNetworkPassphrase) {
        logger.error('[RpcProviderPool] Provider network passphrase mismatch', {
          url: health.config.url,
          expected: this.expectedNetworkPassphrase,
          got: health.networkPassphrase,
        });
        return false;
      }

      health.chainVerified = true;
      return true;
    } catch (err) {
      logger.warn('[RpcProviderPool] Could not verify network passphrase', {
        url: health.config.url,
        err: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private async failover(
    fromHealth: ProviderHealth,
    toHealth?: ProviderHealth
  ): Promise<void> {
    // Put the failing provider into cooldown
    fromHealth.cooldownSince = Date.now();

    let nextHealth = toHealth;
    if (!nextHealth) {
      // Find first non-cooldown provider
      for (const p of this.providers) {
        if (!this.isInCooldown(p) && p !== fromHealth) {
          const compatible = await this.verifyChainCompatibility(p);
          if (compatible) {
            nextHealth = p;
            break;
          }
        }
      }
    }

    if (!nextHealth) {
      logger.error('[RpcProviderPool] No healthy provider available for failover');
      return;
    }

    const prevIndex = this.activeIndex;
    this.activeIndex = this.providers.indexOf(nextHealth);

    rpcProviderFailoversTotal
      .labels(fromHealth.providerLabel, nextHealth.providerLabel)
      .inc();

    rpcProviderActiveGauge.labels(fromHealth.providerLabel).set(0);
    rpcProviderActiveGauge.labels(nextHealth.providerLabel).set(1);

    logger.warn('[RpcProviderPool] Failover triggered', {
      from: fromHealth.providerLabel,
      to: nextHealth.providerLabel,
      prevIndex,
      newIndex: this.activeIndex,
    });
  }

  private async probePrimaryRecovery(): Promise<void> {
    const primary = this.providers[0];
    if (this.activeIndex === 0) return; // already on primary

    // Only probe if cooldown has elapsed
    if (this.isInCooldown(primary)) return;

    try {
      const latestLedger = await primary.server.getLatestLedger();
      const ledger = latestLedger.sequence;

      // Stale check: primary ledger must not be far behind the active provider
      if (this.globalLatestLedger > 0 && ledger < this.globalLatestLedger - STALE_LEDGER_THRESHOLD) {
        logger.warn('[RpcProviderPool] Primary still stale — not recovering', {
          primaryLedger: ledger,
          globalLatest: this.globalLatestLedger,
          threshold: STALE_LEDGER_THRESHOLD,
        });
        return;
      }

      const compatible = await this.verifyChainCompatibility(primary);
      if (!compatible) {
        logger.warn('[RpcProviderPool] Primary chain incompatible — not recovering');
        return;
      }

      // Primary is healthy and chain-compatible — recover
      const prevLabel = this.providers[this.activeIndex].providerLabel;
      this.activeIndex = 0;
      primary.consecutiveErrors = 0;
      primary.cooldownSince = null;

      rpcProviderRecoveriesTotal.labels(primary.providerLabel).inc();
      rpcProviderActiveGauge.labels(prevLabel).set(0);
      rpcProviderActiveGauge.labels(primary.providerLabel).set(1);

      logger.info('[RpcProviderPool] Recovered to primary', {
        provider: primary.providerLabel,
        ledger,
      });
    } catch (err) {
      logger.debug('[RpcProviderPool] Primary recovery probe failed', {
        url: primary.config.url,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private recordSuccess(health: ProviderHealth, latencyMs: number): void {
    health.consecutiveErrors = 0;
    health.totalCalls++;
    health.cumulativeLatencyMs += latencyMs;

    // Update global latest ledger if this was a ledger query (best effort)
    // The caller handles ledger tracking; we just record call success here.
  }

  private recordError(health: ProviderHealth): void {
    health.consecutiveErrors++;
    health.totalErrors++;
  }

  private isInCooldown(health: ProviderHealth): boolean {
    if (health.cooldownSince === null) return false;
    return Date.now() - health.cooldownSince < FAILOVER_COOLDOWN_MS;
  }

  private cooldownRemainingMs(health: ProviderHealth): number {
    if (!this.isInCooldown(health)) return 0;
    return FAILOVER_COOLDOWN_MS - (Date.now() - (health.cooldownSince ?? 0));
  }

  /** Record the latest known ledger from any successful RPC call. */
  updateLatestLedger(ledger: number): void {
    if (ledger > this.globalLatestLedger) {
      this.globalLatestLedger = ledger;
      // Update the active provider's lastKnownLedger
      this.providers[this.activeIndex].lastKnownLedger = ledger;
    }
  }
}

// ── Singleton pool builder ─────────────────────────────────────────────────────

/**
 * Build an RpcProviderPool from environment variables.
 *
 * RPC_PROVIDER_POOL (JSON array, optional) takes priority:
 *   [{"url":"https://primary.rpc","priority":0},{"url":"https://fallback.rpc","priority":1}]
 *
 * Falls back to a single-provider pool from STELLAR_RPC_URL.
 */
export function buildProviderPoolFromEnv(): RpcProviderPool {
  const raw = process.env.RPC_PROVIDER_POOL;

  if (raw && raw.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('[RpcProviderPool] RPC_PROVIDER_POOL is not valid JSON');
    }

    if (!Array.isArray(parsed)) {
      throw new Error('[RpcProviderPool] RPC_PROVIDER_POOL must be a JSON array');
    }

    const configs = parsed as ProviderConfig[];
    if (configs.length === 0) {
      throw new Error('[RpcProviderPool] RPC_PROVIDER_POOL must have at least one entry');
    }

    return new RpcProviderPool(configs);
  }

  // Single-provider fallback
  const url = process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org';
  return new RpcProviderPool([{ url, priority: 0, label: 'primary' }]);
}
