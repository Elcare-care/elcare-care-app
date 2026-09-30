/**
 * contract-registry.ts
 *
 * Formal multi-contract registry for all tracked Soroban deployments.
 *
 * Issue #441 — Build a formal multi-contract poller and dynamic contract
 * registry for all tracked Soroban deployments.
 *
 * ## Design goals
 *
 * 1. Each tracked contract is a first-class runtime entity with a
 *    well-defined type, polling lifecycle, start ledger, last ledger hash,
 *    and per-contract health state.
 *
 * 2. A single contract's stall, gap, or reorg cannot corrupt the cursor
 *    or health state of any sibling contract.
 *
 * 3. Startup and reconfiguration flows are deterministic — seeding from env
 *    or the DB is idempotent and never creates duplicates or gaps.
 *
 * 4. The registry exposes per-contract metrics (lag, max ledger jump, health
 *    state, startup timestamp) so dashboards can show each stream individually.
 *
 * ## Lifecycle
 *
 *   idle      — registered but poll loop not yet started (startup window)
 *   syncing   — poll loop running, advancing ledger-by-ledger normally
 *   stalled   — no ledger progress for STALL_THRESHOLD_MS
 *   gapped    — detected a gap (outside RPC window / reorg skip)
 *   failed    — consecutive errors exceeded MAX_CONTRACT_ERRORS; disabled
 *   disabled  — operator or poller explicitly disabled this contract
 *
 * ## Thread safety
 *
 * Each `ContractEntry` is mutated only by its own `pollContract` coroutine
 * (one per contract, launched in parallel).  The registry's shared maps are
 * mutated only during startup seeding and operator enable/disable calls
 * (which are serialised by Node's single event loop).  No additional locking
 * is needed.
 */

import { logger } from './logger.js';
import prisma from './prisma-write.js';
import {
  contractLagLedgersGauge,
  contractLastLedgerGauge,
  contractHealthGauge,
  contractStallEventsTotal,
  contractGapEventsTotal,
  contractMaxLedgerJumpGauge,
  contractStartupTimestampGauge,
} from './contract-registry-metrics.js';

// ── Contract types ────────────────────────────────────────────────────────────

export type ContractType = 'marketplace' | 'launchpad';

export type ContractHealthState =
  | 'idle'
  | 'syncing'
  | 'stalled'
  | 'gapped'
  | 'failed'
  | 'disabled';

const HEALTH_STATE_VALUES: Record<ContractHealthState, number> = {
  idle:     0,
  syncing:  1,
  stalled:  2,
  gapped:   3,
  failed:   4,
  disabled: 5,
};

/** Maximum consecutive errors before a contract is auto-disabled. */
export const MAX_CONTRACT_ERRORS = 10;

/**
 * Milliseconds of no ledger progress before a contract is considered stalled.
 * Defaults to 2× POLL_INTERVAL (10 s) so a single missed cycle doesn't fire.
 */
export const CONTRACT_STALL_THRESHOLD_MS = parseInt(
  process.env.CONTRACT_STALL_THRESHOLD_MS || '60000',
  10
);

// ── Core data structures ──────────────────────────────────────────────────────

export interface ContractConfig {
  /** Soroban contract address (C…). */
  id: string;
  /** 'marketplace' | 'launchpad' */
  type: ContractType;
  /** Human-readable label for logs and metrics. */
  label: string;
  /** First ledger to index for this contract; cursor starts here on fresh DB. */
  startLedger: number;
}

export interface ContractEntry extends ContractConfig {
  /** Database primary key (TrackedContract.id). */
  dbId: number;
  /** Last ledger sequence fully processed and committed. */
  lastLedger: number;
  /** Hash of `lastLedger` — used for chain continuity / reorg detection. */
  lastLedgerHash: string | null;
  /** Current health state of this contract's poll stream. */
  health: ContractHealthState;
  /** ISO-8601 timestamp when this entry was registered in the runtime registry. */
  registeredAt: string;
  /** ISO-8601 timestamp when the poll loop last successfully advanced. */
  lastProgressAt: string | null;
  /** Consecutive error count in the current error run (reset on success). */
  consecutiveErrors: number;
  /** Maximum ledger-sequence jump observed in a single polling batch. */
  maxLedgerJump: number;
  /** Total gap events detected for this contract since startup. */
  totalGaps: number;
  /** Total stall events detected since startup. */
  totalStalls: number;
  /** Whether the contract is enabled for polling. */
  active: boolean;
}

// ── Registry class ────────────────────────────────────────────────────────────

export class ContractRegistry {
  /** contractId → ContractEntry */
  private entries = new Map<string, ContractEntry>();

  // ── Read ────────────────────────────────────────────────────────────────────

  /** All registered contracts (active and inactive). */
  all(): ContractEntry[] {
    return Array.from(this.entries.values());
  }

  /** Active contracts only (eligible for polling). */
  active(): ContractEntry[] {
    return this.all().filter((e) => e.active);
  }

  /** Look up a single contract by its Soroban address. */
  get(contractId: string): ContractEntry | undefined {
    return this.entries.get(contractId);
  }

  /** Returns true if the contract is registered and active. */
  isActive(contractId: string): boolean {
    return this.entries.get(contractId)?.active === true;
  }

  // ── Seeding ─────────────────────────────────────────────────────────────────

  /**
   * Populate the registry from the DB `TrackedContract` table.
   *
   * Called once during startup after `seedTrackedContracts()` has ensured
   * the DB rows are consistent with the environment config.  Idempotent:
   * calling it again only updates fields that may have changed in the DB.
   */
  async loadFromDb(): Promise<ContractEntry[]> {
    const rows = await prisma.trackedContract.findMany({ where: { active: true } });

    for (const row of rows) {
      const existing = this.entries.get(row.contractId);
      if (existing) {
        // Refresh mutable DB fields but preserve in-flight runtime state.
        existing.lastLedger = row.lastLedger;
        existing.lastLedgerHash = row.lastLedgerHash;
        existing.active = row.active;
      } else {
        const entry: ContractEntry = {
          dbId:             row.id,
          id:               row.contractId,
          contractId:       row.contractId,
          type:             row.type as ContractType,
          label:            row.label,
          startLedger:      row.startLedger,
          lastLedger:       row.lastLedger,
          lastLedgerHash:   row.lastLedgerHash,
          health:           'idle',
          registeredAt:     new Date().toISOString(),
          lastProgressAt:   null,
          consecutiveErrors: 0,
          maxLedgerJump:    0,
          totalGaps:        0,
          totalStalls:      0,
          active:           row.active,
        } as ContractEntry;
        this.entries.set(row.contractId, entry);

        // Initialise per-contract metrics with identity labels.
        this._updateMetrics(entry);
        contractStartupTimestampGauge
          .labels(row.contractId, row.label, row.type)
          .set(Date.now() / 1000);
      }
    }

    logger.info('contract-registry: loaded contracts from DB', {
      total: rows.length,
      contractIds: rows.map((r) => r.contractId),
    });

    return this.active();
  }

  // ── Lifecycle transitions ────────────────────────────────────────────────────

  /**
   * Called when the poll loop for a contract successfully advances its cursor.
   *
   * @param contractId   The Soroban contract address.
   * @param newLedger    The ledger just committed.
   * @param newHash      Hash of `newLedger` (may be null if RPC hash fetch failed).
   */
  recordProgress(
    contractId: string,
    newLedger: number,
    newHash: string | null,
  ): void {
    const entry = this._require(contractId);
    const jump = newLedger - entry.lastLedger;

    entry.lastLedger = newLedger;
    entry.lastLedgerHash = newHash;
    entry.lastProgressAt = new Date().toISOString();
    entry.consecutiveErrors = 0;
    entry.health = 'syncing';

    if (jump > entry.maxLedgerJump) {
      entry.maxLedgerJump = jump;
      contractMaxLedgerJumpGauge
        .labels(contractId, entry.label, entry.type)
        .set(jump);
    }

    this._updateMetrics(entry);
  }

  /**
   * Record a polling error for a contract.
   * After MAX_CONTRACT_ERRORS consecutive errors the contract is auto-disabled.
   */
  recordError(contractId: string, reason: string): void {
    const entry = this._require(contractId);
    entry.consecutiveErrors += 1;

    if (entry.consecutiveErrors >= MAX_CONTRACT_ERRORS) {
      logger.error(
        'contract-registry: auto-disabling contract after too many consecutive errors',
        { contractId, consecutiveErrors: entry.consecutiveErrors, reason },
      );
      entry.health = 'failed';
      entry.active = false;
    } else {
      logger.warn('contract-registry: contract error', {
        contractId,
        consecutiveErrors: entry.consecutiveErrors,
        reason,
      });
    }

    this._updateMetrics(entry);
  }

  /**
   * Mark a contract as stalled (no ledger progress for CONTRACT_STALL_THRESHOLD_MS).
   * Idempotent — repeated calls only increment the counter once per transition.
   */
  recordStall(contractId: string): void {
    const entry = this._require(contractId);
    if (entry.health === 'stalled') return; // already stalled

    entry.health = 'stalled';
    entry.totalStalls += 1;
    contractStallEventsTotal.labels(contractId, entry.label, entry.type).inc();

    logger.warn('contract-registry: contract stalled', {
      contractId,
      label: entry.label,
      lastProgressAt: entry.lastProgressAt,
      totalStalls: entry.totalStalls,
    });

    this._updateMetrics(entry);
  }

  /**
   * Mark a contract as having a gap (outside the RPC retention window or
   * after a reorg-triggered skip).  Independent from sibling contracts.
   */
  recordGap(contractId: string, fromLedger: number, toLedger: number): void {
    const entry = this._require(contractId);
    entry.health = 'gapped';
    entry.totalGaps += 1;
    contractGapEventsTotal.labels(contractId, entry.label, entry.type).inc();

    logger.warn('contract-registry: gap detected for contract', {
      contractId,
      label: entry.label,
      fromLedger,
      toLedger,
      totalGaps: entry.totalGaps,
    });

    this._updateMetrics(entry);
  }

  /**
   * Enable a contract and reset its error counter.
   * Called by the operator via POST /admin/contracts or after a manual recovery.
   */
  enable(contractId: string): void {
    const entry = this.entries.get(contractId);
    if (!entry) {
      throw new Error(`contract-registry: unknown contract "${contractId}"`);
    }
    entry.active = true;
    entry.consecutiveErrors = 0;
    entry.health = 'idle';
    this._updateMetrics(entry);
    logger.info('contract-registry: contract enabled', { contractId });
  }

  /**
   * Disable a contract.  Its poll loop exits gracefully on the next iteration.
   */
  disable(contractId: string, reason = 'operator'): void {
    const entry = this.entries.get(contractId);
    if (!entry) {
      throw new Error(`contract-registry: unknown contract "${contractId}"`);
    }
    entry.active = false;
    entry.health = 'disabled';
    this._updateMetrics(entry);
    logger.info('contract-registry: contract disabled', { contractId, reason });
  }

  /**
   * Upsert a new contract entry (dynamic registration at runtime).
   * If the contract is already registered, updates label/type only.
   *
   * Returns the final entry.
   */
  register(config: ContractConfig & { dbId: number; lastLedger: number; lastLedgerHash: string | null }): ContractEntry {
    const existing = this.entries.get(config.id);
    if (existing) {
      existing.label = config.label;
      existing.type = config.type;
      existing.active = true;
      this._updateMetrics(existing);
      return existing;
    }

    const entry: ContractEntry = {
      dbId:             config.dbId,
      id:               config.id,
      contractId:       config.id,
      type:             config.type,
      label:            config.label,
      startLedger:      config.startLedger,
      lastLedger:       config.lastLedger,
      lastLedgerHash:   config.lastLedgerHash,
      health:           'idle',
      registeredAt:     new Date().toISOString(),
      lastProgressAt:   null,
      consecutiveErrors: 0,
      maxLedgerJump:    0,
      totalGaps:        0,
      totalStalls:      0,
      active:           true,
    } as ContractEntry;

    this.entries.set(config.id, entry);
    this._updateMetrics(entry);
    contractStartupTimestampGauge
      .labels(config.id, config.label, config.type)
      .set(Date.now() / 1000);

    logger.info('contract-registry: new contract registered', {
      contractId: config.id,
      type: config.type,
      label: config.label,
    });

    return entry;
  }

  // ── Health summary (for /health/details) ───────────────────────────────────

  /**
   * Return a structured summary of all registered contracts for monitoring.
   */
  healthSummary(): ContractHealthSummary[] {
    return this.all().map((entry) => ({
      contractId:        entry.id,
      type:              entry.type,
      label:             entry.label,
      active:            entry.active,
      health:            entry.health,
      lastLedger:        entry.lastLedger,
      lastLedgerHash:    entry.lastLedgerHash,
      lastProgressAt:    entry.lastProgressAt,
      consecutiveErrors: entry.consecutiveErrors,
      maxLedgerJump:     entry.maxLedgerJump,
      totalGaps:         entry.totalGaps,
      totalStalls:       entry.totalStalls,
      registeredAt:      entry.registeredAt,
    }));
  }

  // ── Cross-contract consistency (Issue #486) ────────────────────────────────

  /**
   * Returns the lowest `lastLedger` across all active contracts.
   *
   * This is the shared consistency floor: API views that join data from
   * multiple contracts are guaranteed coherent only up to this ledger.
   * Returns 0 when no active contracts are registered.
   */
  sharedConsistencyLedger(): number {
    const actives = this.active();
    if (actives.length === 0) return 0;
    return Math.min(...actives.map((e) => e.lastLedger));
  }

  /**
   * Returns the ledger difference between the most-advanced and least-advanced
   * active contract cursors.  A value of 0 means all cursors are in sync.
   * High values indicate one contract is lagging and cross-contract joins may
   * surface stale references.
   */
  crossContractLag(): number {
    const actives = this.active();
    if (actives.length < 2) return 0;
    const ledgers = actives.map((e) => e.lastLedger);
    return Math.max(...ledgers) - Math.min(...ledgers);
  }

  /**
   * Returns an aggregate consistency snapshot suitable for the /health/details
   * and API freshness headers.
   */
  consistencySnapshot(): CrossContractConsistencySnapshot {
    const actives = this.active();
    return {
      sharedConsistencyLedger: this.sharedConsistencyLedger(),
      crossContractLag:        this.crossContractLag(),
      contractCount:           actives.length,
      cursors: actives.map((e) => ({
        contractId:     e.id,
        label:          e.label,
        type:           e.type,
        lastLedger:     e.lastLedger,
        lastProgressAt: e.lastProgressAt,
        health:         e.health,
      })),
    };
  }

  /**
   * Detect and record stalls for all active contracts based on the time
   * elapsed since their last progress.
   *
   * Returns an array of contract IDs that transitioned to 'stalled'.
   * Intended to be called from the watchdog timer.
   */
  checkStalls(): string[] {
    const now = Date.now();
    const stalled: string[] = [];

    for (const entry of this.active()) {
      if (entry.health !== 'syncing' && entry.health !== 'idle') continue;
      if (!entry.lastProgressAt) continue;

      const elapsedMs = now - new Date(entry.lastProgressAt).getTime();
      if (elapsedMs > CONTRACT_STALL_THRESHOLD_MS) {
        this.recordStall(entry.id);
        stalled.push(entry.id);
      }
    }

    return stalled;
  }

  // ── Persistence helpers ──────────────────────────────────────────────────────

  /**
   * Persist a cursor advance to the database for a single contract.
   * This is called OUTSIDE the domain transaction (after commitCheckpoint).
   * For cursor advances inside a transaction, use commitCheckpoint() directly.
   */
  async persistCursor(
    contractId: string,
    lastLedger: number,
    lastLedgerHash: string | null,
    tx?: any,
  ): Promise<void> {
    const entry = this._require(contractId);
    const db = tx ?? prisma;

    await db.trackedContract.update({
      where: { id: entry.dbId },
      data: {
        lastLedger,
        ...(lastLedgerHash !== null ? { lastLedgerHash } : {}),
      },
    });
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  private _require(contractId: string): ContractEntry {
    const entry = this.entries.get(contractId);
    if (!entry) {
      throw new Error(`contract-registry: unknown contract "${contractId}"`);
    }
    return entry;
  }

  private _updateMetrics(entry: ContractEntry): void {
    const labels = [entry.id, entry.label, entry.type] as const;
    contractHealthGauge.labels(...labels).set(HEALTH_STATE_VALUES[entry.health]);
    contractLastLedgerGauge.labels(...labels).set(entry.lastLedger);
  }

  /**
   * Update the lag gauges for all active contracts given the current network tip.
   * Called after each getLatestLedger() RPC call in the polling loop.
   */
  updateLagMetrics(networkTip: number): void {
    for (const entry of this.active()) {
      const lag = Math.max(0, networkTip - entry.lastLedger);
      contractLagLedgersGauge
        .labels(entry.id, entry.label, entry.type)
        .set(lag);
    }
  }

  /** Reset all entries — for use in tests only. */
  _resetForTest(): void {
    this.entries.clear();
  }
}

// ── Exported types ────────────────────────────────────────────────────────────

/** Per-cursor entry in a CrossContractConsistencySnapshot. */
export interface ContractCursorEntry {
  contractId:     string;
  label:          string;
  type:           ContractType;
  lastLedger:     number;
  lastProgressAt: string | null;
  health:         ContractHealthState;
}

/**
 * Aggregate cross-contract consistency state (Issue #486).
 * Included in /health/details and API X-Consistency-Ledger headers.
 */
export interface CrossContractConsistencySnapshot {
  /** Lowest lastLedger across all active contracts — the coherent view floor. */
  sharedConsistencyLedger: number;
  /** Ledger difference between the fastest and slowest active contract cursors. */
  crossContractLag: number;
  /** Number of active contracts in the registry. */
  contractCount: number;
  /** Per-contract cursor details. */
  cursors: ContractCursorEntry[];
}

export interface ContractHealthSummary {
  contractId:        string;
  type:              ContractType;
  label:             string;
  active:            boolean;
  health:            ContractHealthState;
  lastLedger:        number;
  lastLedgerHash:    string | null;
  lastProgressAt:    string | null;
  consecutiveErrors: number;
  maxLedgerJump:     number;
  totalGaps:         number;
  totalStalls:       number;
  registeredAt:      string;
}

// ── Singleton registry export ─────────────────────────────────────────────────

/**
 * The global contract registry singleton.
 *
 * All subsystems (poller, admin routes, health endpoint) should import this
 * instance rather than constructing their own.
 */
export const contractRegistry = new ContractRegistry();

// Needed because ContractEntry uses `contractId` as an alias for `id`
// to stay compatible with the TrackedContract Prisma model shape.
declare module './contract-registry.js' {
  interface ContractEntry {
    contractId: string;
  }
}
