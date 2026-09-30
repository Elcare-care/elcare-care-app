/**
 * multi-contract-cursor.test.ts
 *
 * Acceptance criteria for Issue #486 — Add multi-contract cursor consistency guarantees.
 *
 *   ✓ ContractRegistry.sharedConsistencyLedger() returns the min lastLedger
 *     across all active contracts (the coherent view floor).
 *   ✓ ContractRegistry.crossContractLag() returns the max spread between
 *     active contract cursors (0 when only one contract or all at the same ledger).
 *   ✓ consistencySnapshot() includes per-contract cursor detail and aggregate state.
 *   ✓ Inactive contracts are excluded from consistency calculations.
 *   ✓ sharedConsistencyLedger() returns 0 when no active contracts exist.
 *   ✓ crossContractLag() returns 0 for a single active contract.
 *   ✓ recordProgress() and disable() keep consistency state current.
 *   ✓ Replaying the same ledger range for two contracts in different batch
 *     partitions produces the same shared consistency floor.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ContractRegistry } from '../src/contract-registry.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../src/prisma-write.js', () => ({
  default: {
    trackedContract: {
      update: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/contract-registry-metrics.js', () => ({
  contractLagLedgersGauge:        { labels: () => ({ set: vi.fn() }) },
  contractLastLedgerGauge:        { labels: () => ({ set: vi.fn() }) },
  contractHealthGauge:            { labels: () => ({ set: vi.fn() }) },
  contractStallEventsTotal:       { labels: () => ({ inc: vi.fn() }) },
  contractGapEventsTotal:         { labels: () => ({ inc: vi.fn() }) },
  contractMaxLedgerJumpGauge:     { labels: () => ({ set: vi.fn() }) },
  contractStartupTimestampGauge:  { labels: () => ({ set: vi.fn() }) },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEntry(
  registry: ContractRegistry,
  contractId: string,
  lastLedger: number,
  active = true,
): void {
  registry.register({
    id: contractId,
    dbId: Math.random(),
    type: 'marketplace',
    label: contractId,
    startLedger: 0,
    lastLedger,
    lastLedgerHash: null,
  } as any);
  if (!active) {
    registry.disable(contractId, 'test');
  } else {
    // Advance the cursor to the desired ledger so lastLedger is correct.
    registry.recordProgress(contractId, lastLedger, null);
  }
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('ContractRegistry — cross-contract cursor consistency', () => {
  let registry: ContractRegistry;

  beforeEach(() => {
    registry = new ContractRegistry();
  });

  it('sharedConsistencyLedger returns 0 when no active contracts are registered', () => {
    expect(registry.sharedConsistencyLedger()).toBe(0);
  });

  it('sharedConsistencyLedger returns the contracts own ledger for a single contract', () => {
    makeEntry(registry, 'C1', 1000);
    expect(registry.sharedConsistencyLedger()).toBe(1000);
  });

  it('sharedConsistencyLedger returns the minimum across multiple contracts', () => {
    makeEntry(registry, 'C1', 1500);
    makeEntry(registry, 'C2', 1000);
    makeEntry(registry, 'C3', 2000);
    expect(registry.sharedConsistencyLedger()).toBe(1000);
  });

  it('crossContractLag returns 0 for a single active contract', () => {
    makeEntry(registry, 'C1', 1000);
    expect(registry.crossContractLag()).toBe(0);
  });

  it('crossContractLag returns 0 when all contracts are at the same ledger', () => {
    makeEntry(registry, 'C1', 1000);
    makeEntry(registry, 'C2', 1000);
    expect(registry.crossContractLag()).toBe(0);
  });

  it('crossContractLag returns the spread between fastest and slowest', () => {
    makeEntry(registry, 'C1', 1200);
    makeEntry(registry, 'C2', 1000);
    expect(registry.crossContractLag()).toBe(200);
  });

  it('excludes inactive contracts from consistency calculations', () => {
    makeEntry(registry, 'C1', 1000);
    makeEntry(registry, 'C2', 2000);
    makeEntry(registry, 'C_inactive', 500, false); // inactive — should be excluded

    // The inactive contract at ledger 500 must NOT pull the floor below 1000.
    expect(registry.sharedConsistencyLedger()).toBe(1000);
    // The lag should only consider C1 and C2.
    expect(registry.crossContractLag()).toBe(1000);
  });

  it('consistencySnapshot includes sharedConsistencyLedger and crossContractLag', () => {
    makeEntry(registry, 'C1', 1000);
    makeEntry(registry, 'C2', 1500);

    const snap = registry.consistencySnapshot();
    expect(snap.sharedConsistencyLedger).toBe(1000);
    expect(snap.crossContractLag).toBe(500);
    expect(snap.contractCount).toBe(2);
  });

  it('consistencySnapshot includes per-contract cursor detail', () => {
    makeEntry(registry, 'marketplace-1', 1200);
    makeEntry(registry, 'launchpad-1', 1000);

    const snap = registry.consistencySnapshot();
    expect(snap.cursors).toHaveLength(2);
    const ids = snap.cursors.map((c) => c.contractId);
    expect(ids).toContain('marketplace-1');
    expect(ids).toContain('launchpad-1');
  });

  it('updates shared consistency ledger after progress is recorded', () => {
    makeEntry(registry, 'C1', 1000);
    makeEntry(registry, 'C2', 800);

    expect(registry.sharedConsistencyLedger()).toBe(800);

    // Advance the lagging contract
    registry.recordProgress('C2', 1000, null);
    expect(registry.sharedConsistencyLedger()).toBe(1000);
    expect(registry.crossContractLag()).toBe(0);
  });

  it('replay invariant: same ledger ranges in any partition order produce the same consistency floor', () => {
    // Simulate two independent replay runs — same final ledger, different intermediate states.
    const registryA = new ContractRegistry();
    const registryB = new ContractRegistry();

    // Run A: C1 advances first, then C2
    makeEntry(registryA, 'C1', 0);
    makeEntry(registryA, 'C2', 0);
    registryA.recordProgress('C1', 1500, null);
    registryA.recordProgress('C2', 1500, null);

    // Run B: C2 advances first, then C1
    makeEntry(registryB, 'C1', 0);
    makeEntry(registryB, 'C2', 0);
    registryB.recordProgress('C2', 1500, null);
    registryB.recordProgress('C1', 1500, null);

    // The final shared consistency floor must be identical regardless of order.
    expect(registryA.sharedConsistencyLedger()).toBe(registryB.sharedConsistencyLedger());
    expect(registryA.crossContractLag()).toBe(0);
    expect(registryB.crossContractLag()).toBe(0);
  });

  it('disabling a contract removes it from the consistency floor', () => {
    makeEntry(registry, 'C1', 1000);
    makeEntry(registry, 'C2', 500); // lagging contract

    expect(registry.sharedConsistencyLedger()).toBe(500);

    // Disabling the lagging contract should raise the shared floor to C1's ledger.
    registry.disable('C2', 'test');
    expect(registry.sharedConsistencyLedger()).toBe(1000);
  });

  it('consistencySnapshot cursors include health state for operator visibility', () => {
    makeEntry(registry, 'C1', 1000);
    const snap = registry.consistencySnapshot();
    expect(snap.cursors[0]).toHaveProperty('health');
  });
});
