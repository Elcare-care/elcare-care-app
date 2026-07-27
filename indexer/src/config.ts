import { z } from 'zod';

// ── Version metadata ─────────────────────────────────────────────────────────
// Sourced from versions.toml at build time.  Dockerfile and CI set these via
// build args or environment variables.  Fallback values allow local dev without
// the build args present.

export const VERSION = {
  /** Application version — matches indexer/package.json */
  app: process.env.INDEXER_VERSION || process.env.npm_package_version || '0.0.0-dev',
  /** OpenAPI / REST API version — must match openapi.json info.version */
  api: process.env.API_VERSION || '1.0.0',
  /** Event schema version — bump when contract event fields change */
  eventSchema: process.env.EVENT_SCHEMA_VERSION || '1',
  /** Latest Prisma migration prefix (YYYYMMDDNNNNNN) */
  dbMigration: process.env.DB_MIGRATION_VERSION || '20260724000000',
  /** Git commit SHA embedded at build time */
  gitSha: process.env.BUILD_SHA || 'unknown',
  /** ISO-8601 build timestamp */
  buildTime: process.env.BUILD_TIME || 'unknown',
} as const;

// ── Generic helpers ──────────────────────────────────────────────────────────

function parsePositiveInt(name: string, raw: string | undefined, defaultVal: number): number {
  if (raw === undefined || raw === '') return defaultVal;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Config error: ${name} must be a positive integer, got "${raw}"`);
  }
  return n;
}

// ── TrackedContract definition ───────────────────────────────────────────────

export interface TrackedContractConfig {
  id: string;
  type: 'marketplace' | 'launchpad';
  label: string;
  startLedger: number;
}

const trackedContractSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['marketplace', 'launchpad']),
  label: z.string().default(''),
  startLedger: z.number().int().min(0).default(0),
});

/**
 * Parses the TRACKED_CONTRACTS environment variable.
 *
 * TRACKED_CONTRACTS should be a JSON array:
 *   [{"id":"C...","type":"marketplace","label":"mainnet","startLedger":1000000}]
 *
 * Falls back to the legacy single-contract MARKETPLACE_CONTRACT_ID /
 * LAUNCHPAD_CONTRACT_ID variables so existing deployments keep working
 * without any config changes.
 */
export function parseTrackedContracts(): TrackedContractConfig[] {
  const raw = process.env.TRACKED_CONTRACTS;

  if (raw && raw.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        '[indexer] TRACKED_CONTRACTS is not valid JSON. ' +
          'Expected a JSON array: [{"id":"C...","type":"marketplace","label":"...","startLedger":0}]'
      );
    }

    if (!Array.isArray(parsed)) {
      throw new Error('[indexer] TRACKED_CONTRACTS must be a JSON array.');
    }

    const contracts: TrackedContractConfig[] = [];
    for (const [i, item] of parsed.entries()) {
      const result = trackedContractSchema.safeParse(item);
      if (!result.success) {
        const msgs = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
        throw new Error(`[indexer] TRACKED_CONTRACTS[${i}] is invalid: ${msgs}`);
      }
      contracts.push(result.data as TrackedContractConfig);
    }

    if (contracts.length === 0) {
      throw new Error('[indexer] TRACKED_CONTRACTS must contain at least one entry.');
    }

    return contracts;
  }

  // ── Legacy fallback ────────────────────────────────────────────────────────
  const contracts: TrackedContractConfig[] = [];
  if (process.env.MARKETPLACE_CONTRACT_ID) {
    contracts.push({
      id: process.env.MARKETPLACE_CONTRACT_ID,
      type: 'marketplace',
      label: 'marketplace',
      startLedger: 0,
    });
  }
  if (process.env.LAUNCHPAD_CONTRACT_ID) {
    contracts.push({
      id: process.env.LAUNCHPAD_CONTRACT_ID,
      type: 'launchpad',
      label: 'launchpad',
      startLedger: 0,
    });
  }
  return contracts;
}

// ── Required env-var list (non-keeper) ──────────────────────────────────────

const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
  'REDIS_URL',
  'STELLAR_RPC_URL',
  'STELLAR_NETWORK',
] as const;

// At least one of TRACKED_CONTRACTS or MARKETPLACE_CONTRACT_ID must be set.
const CONTRACT_ENV_VARS = ['TRACKED_CONTRACTS', 'MARKETPLACE_CONTRACT_ID'] as const;

/**
 * Validates that all required environment variables are present.
 * Throws a single aggregated error listing every missing variable so the
 * operator can fix all problems in one restart rather than discovering them
 * one-by-one.
 */
export function validateRequiredEnv(): void {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);

  // Must have either TRACKED_CONTRACTS or legacy MARKETPLACE_CONTRACT_ID
  const hasContractConfig = CONTRACT_ENV_VARS.some((name) => process.env[name]);
  if (!hasContractConfig) {
    missing.push('MARKETPLACE_CONTRACT_ID (or TRACKED_CONTRACTS)' as any);
  }

  if (missing.length > 0) {
    throw new Error(
      `[indexer] Missing required environment variables: ${missing.join(', ')}.\n` +
        'Check indexer/.env and ensure all required vars are set (see README for the full table).'
    );
  }
}

export function loadConfig() {
  // MAX_ROLLBACK_DEPTH: the maximum number of ledgers the poller will roll back
  // automatically when a re-org is detected.  If a re-org requires rolling back
  // MORE than this many ledgers the poller halts and emits a CRITICAL_REORG SSE
  // event rather than executing a potentially destructive deep rollback.
  const maxRollbackDepth = parsePositiveInt(
    'MAX_ROLLBACK_DEPTH',
    process.env.MAX_ROLLBACK_DEPTH,
    100
  );

  // REORG_HALT_ON_DEEP: when true (default) the poller halts on deep re-orgs
  // instead of attempting them.  Set to "false" to disable the safety guard
  // (not recommended for production).
  const reorgHaltOnDeep = process.env.REORG_HALT_ON_DEEP !== 'false';

  return {
    pollIntervalMs: parsePositiveInt('POLL_INTERVAL_MS', process.env.POLL_INTERVAL_MS, 5000),
    maxLedgersPerCycle: parsePositiveInt('MAX_LEDGERS_PER_CYCLE', process.env.MAX_LEDGERS_PER_CYCLE, 1000),
    shutdownTimeoutMs: parsePositiveInt('SHUTDOWN_TIMEOUT_MS', process.env.SHUTDOWN_TIMEOUT_MS, 30_000),
    // ── Reconciler config ──────────────────────────────────────────────────
    /**
     * When true, the reconciler writes DB corrections when chain state disagrees.
     * Defaults to false (detect-only / dry-run safe).
     * Set RECONCILER_AUTO_REPAIR=true to enable.
     */
    reconcilerAutoRepair: process.env.RECONCILER_AUTO_REPAIR === 'true',
    /**
     * Maximum total number of records (listings + auctions) the reconciler
     * will read from chain in a single run.  Prevents runaway RPC spend.
     */
    reconcilerBudgetPerRun: parsePositiveInt(
      'RECONCILER_BUDGET_PER_RUN',
      process.env.RECONCILER_BUDGET_PER_RUN,
      200
    ),
    /**
     * Chain-state read mode:
     *   ledger_entries (default) — getLedgerEntries with DataKey ScVal keys
     *   simulate                  — simulateTransaction of get_listing/get_auction
     */
    chainStateMode: (process.env.CHAIN_STATE_MODE === 'simulate'
      ? 'simulate'
      : 'ledger_entries') as 'ledger_entries' | 'simulate',
    /**
     * Issue #286: Number of ledgers that must accumulate on top of a window
     * before its events are considered "confirmed" (finalized enough).
     *
     * Stellar testnet/mainnet achieves practical finality within 1-2 ledgers,
     * but a conservative default of 10 gives a safety margin without
     * meaningfully delaying UI visibility.
     *
     * Set to 0 to mark all events confirmed immediately (useful for testnet
     * environments with no reorg risk).
     *
     * Configurable via CONFIRMATION_DEPTH environment variable.
     */
    confirmationDepth: parseInt(process.env.CONFIRMATION_DEPTH || '10', 10),
  };
}

export type Config = ReturnType<typeof loadConfig>;

// ── Realtime SSE configuration (#192) ────────────────────────────────────────

export function loadRealtimeConfig() {
  return {
    /** Hard cap on concurrent SSE connections per API instance. */
    sseMaxConnections: parsePositiveInt('SSE_MAX_CONNECTIONS', process.env.SSE_MAX_CONNECTIONS, 100),
    /** Interval between `: heartbeat` comment frames. */
    sseHeartbeatMs: parsePositiveInt('SSE_HEARTBEAT_MS', process.env.SSE_HEARTBEAT_MS, 30_000),
    /**
     * XADD MAXLEN~ cap on the Redis Stream — the durable replay horizon.
     * Clients resuming from an id older than the retained window receive
     * only what the stream still holds.
     */
    sseStreamMaxLen: parsePositiveInt('SSE_STREAM_MAXLEN', process.env.SSE_STREAM_MAXLEN, 1000),
    /** Per-client send-queue cap; overflow drops the oldest frames. */
    sseClientQueueMax: parsePositiveInt('SSE_CLIENT_QUEUE_MAX', process.env.SSE_CLIENT_QUEUE_MAX, 100),
    /** Degraded-mode in-memory ring size (single-process fallback). */
    sseLocalBufferSize: parsePositiveInt('SSE_LOCAL_BUFFER_SIZE', process.env.SSE_LOCAL_BUFFER_SIZE, 200),
  };
}

export type RealtimeConfig = ReturnType<typeof loadRealtimeConfig>;

// ── Keeper configuration ─────────────────────────────────────────────────────
//
// All keeper env vars are optional at process start so that the main indexer
// can boot without them.  loadKeeperConfig() throws at keeper-startup time if
// KEEPER_ENABLED=true but required vars are missing.

/** Zod schema for the raw env vars consumed by the keeper. */
const keeperEnvSchema = z.object({
  // Whether the keeper loop should run at all (default: false → dry-run safe).
  KEEPER_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),

  // Stellar secret key for the keeper account (required when KEEPER_ENABLED=true).
  KEEPER_SECRET: z
    .string()
    .optional()
    .refine((v) => v === undefined || v.startsWith('S'), {
      message: 'KEEPER_SECRET must be a Stellar secret key starting with "S"',
    }),

  // Whether to simulate only and never broadcast (default: true — safe default).
  KEEPER_DRY_RUN: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),   // anything other than explicit "false" = dry-run

  // How often to run the keeper sweep cycle (milliseconds).
  KEEPER_INTERVAL_MS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 60_000))
    .pipe(z.number().int().positive()),

  // Maximum number of actions the keeper will attempt in a single cycle.
  KEEPER_MAX_ACTIONS_PER_CYCLE: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 20))
    .pipe(z.number().int().positive()),

  // Maximum fee in stroops allowed for a single transaction.
  KEEPER_MAX_FEE_STROOPS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 1_000_000))   // ~0.1 XLM
    .pipe(z.number().int().positive()),

  // Daily fee budget in stroops; keeper halts cycle when exhausted.
  KEEPER_DAILY_FEE_BUDGET_STROOPS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 10_000_000))  // ~1 XLM / day
    .pipe(z.number().int().positive()),

  // Fee-bump multiplier applied on each escalation step (e.g. 1.5 = +50%).
  KEEPER_FEE_BUMP_MULTIPLIER: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 1.5))
    .pipe(z.number().min(1.01).max(10)),

  // Maximum number of fee-bump retries before marking action Failed.
  KEEPER_FEE_BUMP_MAX_RETRIES: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 3))
    .pipe(z.number().int().min(0).max(10)),

  // How long to wait for a submitted tx to appear before triggering a fee-bump (ms).
  KEEPER_SUBMIT_TIMEOUT_MS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 30_000))
    .pipe(z.number().int().positive()),

  // How long to poll getTransaction after submit before giving up (ms).
  KEEPER_POLL_TIMEOUT_MS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 60_000))
    .pipe(z.number().int().positive()),

  // Interval between getTransaction polls (ms).
  KEEPER_POLL_INTERVAL_MS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 2_000))
    .pipe(z.number().int().positive()),
});

export type KeeperConfig = z.infer<typeof keeperEnvSchema>;

/**
 * Parse and validate all keeper-related environment variables.
 *
 * Throws a descriptive ZodError if any value fails validation.
 * Also throws if KEEPER_ENABLED=true but KEEPER_SECRET is missing.
 */
export function loadKeeperConfig(): KeeperConfig {
  const result = keeperEnvSchema.safeParse(process.env);
  if (!result.success) {
    const messages = result.error.issues.map((e) => `  ${e.path.join('.')}: ${e.message}`).join('\n');
    throw new Error(`[keeper] Invalid configuration:\n${messages}`);
  }

  const cfg = result.data;

  if (cfg.KEEPER_ENABLED && !cfg.KEEPER_SECRET) {
    throw new Error(
      '[keeper] KEEPER_ENABLED=true requires KEEPER_SECRET to be set.\n' +
        'Generate a funded Stellar keypair and export its secret as KEEPER_SECRET.'
    );
  }

  return cfg;
}
