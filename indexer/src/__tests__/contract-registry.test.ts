/**
 * contract-registry.test.ts
 *
 * Unit tests for the formal multi-contract registry (Issue #441).
 *
 * Coverage targets:
 *   ✓ Registry lifecycle (register, enable, disable)
 *   ✓ Per-contract progress recording and cursor isolation
 *   ✓ Error accumulation and auto-disable after MAX_CONTRACT_ERRORS
 *   ✓ Stall detection (checkStalls) with time-based threshold
 *   ✓ Gap detection (recordGap) — isolated per contract
 *   ✓ Health state transitions: idle → syncing → stalled / gapped / failed / disabled
 *   ✓ healthSummary() shape
 *   ✓ loadFromDb() idempotency — re-registration preserves runtime state
 *   ✓ updateLagMetrics() updates lag gauge without throwing
 *   ✓ Partial registry writes — unknown contract operations throw correctly
 *   ✓ Stale hash — contracts without progress do not affect siblings
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock prom-client so metric creation is a no-op ───────────────────────────

vi.mock('prom-client', () => {
  const stub = () => ({ set: vi.fn(), inc: vi.fn(), observe: vi.fn(), labels: () => stub() });
  return {
    default: {
      Gauge:     class { set = vi.fn(); labels = () => ({ set: vi.fn() }); },
      Counter:   class { inc = vi.fn(); labels = () => ({ inc: vi.fn() }); },
      Histogram: class { observe = vi.fn(); labels = () => ({ observe: vi.fn() }); },
      register: { getSingleMetric: vi.fn(() => null) },
    },
  };
});

// ── Mock prisma-write (loadFromDb calls prisma.trackedContract.findMany) ──────

const mockPrisma = vi.hoisted(() => ({
  trackedContract: {
    findMany: vi.fn(),
    update:   vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../prisma-write', () => ({ default: mockPrisma }));

// ── Import under test (after mocks are set up) ────────────────────────────────

import {
  ContractRegistry,
  MAX_CONTRACT_ERRORS,
  CONTRACT_STALL_THRESHOLD_MS,
  type ContractEntry,
} from '../contract-registry';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDbRow(overrides: Partial<{
  id: number;
  contractId: string;
  type: string;
  label: string;
  startLedger: number;
  lastLedger: number;
  lastLedgerHash: string | null;
  active: boolean;
}> = {}) {
  return {
    id:            overrides.id         ?? 1,
    contractId:    overrides.contractId ?? 'C_TEST',
    type:          overrides.type       ?? 'marketplace',
    label:         overrides.label      ?? 'test',
    startLedger:   overrides.startLedger ?? 0,
    lastLedger:    overrides.lastLedger  ?? 0,
    lastLedgerHash: overrides.lastLedgerHash ?? null,
    active:        overrides.active     ?? true,
  };
}

function makeRegistry(): ContractRegistry {
  const r = new ContractRegistry();
  r._resetForTest();
  return r;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ContractRegistry.register', () => {
  let registry: ContractRegistry;

  beforeEach(() => {
    registry = makeRegistry();
  });

  it('registers a new contract entry', () => {
    registry.register({ id: 'CA', dbId: 1, type: 'marketplace', label: 'alpha', startLedger: 0, lastLedger: 0, lastLedgerHash: null });
    const entry = registry.get('CA');
    expect(entry).toBeDefined();
    expect(entry!.id).toBe('CA');
    expect(entry!.health).toBe('idle');
    expect(entry!.active).toBe(true);
    expect(entry!.consecutiveErrors).toBe(0);
  });

  it('updating an existing entry does not reset runtime state', () => {
    registry.register({ id: 'CA', dbId: 1, type: 'marketplace', label: 'alpha', startLedger: 0, lastLedger: 100, lastLedgerHash: 'hash1' });
    // Simulate some runtime progress
    registry.recordProgress('CA', 150, 'hash2');

    // Re-register (e.g. operator changes label)
    registry.register({ id: 'CA', dbId: 1, type: 'marketplace', label: 'renamed', startLedger: 0, lastLedger: 150, lastLedgerHash: 'hash2' });
    const entry = registry.get('CA')!;

    // label should be updated
    expect(entry.label).toBe('renamed');
    // runtime state should be preserved
    expect(entry.lastLedger).toBe(150);
    expect(entry.health).toBe('syncing');
    expect(entry.consecutiveErrors).toBe(0);
  });

  it('lists all active contracts', () => {
    registry.register({ id: 'CA', dbId: 1, type: 'marketplace', label: 'a', startLedger: 0, lastLedger: 0, lastLedgerHash: null });
    registry.register({ id: 'CB', dbId: 2, type: 'launchpad',   label: 'b', startLedger: 0, lastLedger: 0, lastLedgerHash: null });
    expect(registry.active()).toHaveLength(2);
  });
});

// ── loadFromDb ────────────────────────────────────────────────────────────────

describe('ContractRegistry.loadFromDb', () => {
  let registry: ContractRegistry;

  beforeEach(() => {
    registry = makeRegistry();
    vi.clearAllMocks();
  });

  it('populates the registry from DB rows', async () => {
    mockPrisma.trackedContract.findMany.mockResolvedValue([
      makeDbRow({ id: 1, contractId: 'CA', type: 'marketplace', label: 'mainnet', lastLedger: 500 }),
      makeDbRow({ id: 2, contractId: 'CB', type: 'launchpad',   label: 'launch',  lastLedger: 100 }),
    ]);
    const active = await registry.loadFromDb();
    expect(active).toHaveLength(2);
    expect(registry.get('CA')?.lastLedger).toBe(500);
    expect(registry.get('CB')?.lastLedger).toBe(100);
  });

  it('is idempotent — a second call refreshes cursor without resetting health', async () => {
    mockPrisma.trackedContract.findMany.mockResolvedValue([
      makeDbRow({ id: 1, contractId: 'CA', lastLedger: 500 }),
    ]);
    await registry.loadFromDb();

    // Simulate progress in the running loop
    registry.recordProgress('CA', 600, 'newhash');
    expect(registry.get('CA')?.health).toBe('syncing');

    // Second seed call (e.g. on config reload) — DB still shows 500
    mockPrisma.trackedContract.findMany.mockResolvedValue([
      makeDbRow({ id: 1, contractId: 'CA', lastLedger: 600 }),
    ]);
    await registry.loadFromDb();

    // Runtime health state should be preserved, lastLedger refreshed from DB
    expect(registry.get('CA')?.health).toBe('syncing');
    expect(registry.get('CA')?.lastLedger).toBe(600);
  });

  it('only returns active contracts from DB', async () => {
    mockPrisma.trackedContract.findMany.mockResolvedValue([
      makeDbRow({ id: 1, contractId: 'CA', active: true  }),
      // inactive rows are filtered by the findMany { where: { active: true } } call
    ]);
    const result = await registry.loadFromDb();
    expect(result).toHaveLength(1);
  });
});

// ── recordProgress ────────────────────────────────────────────────────────────

describe('ContractRegistry.recordProgress', () => {
  let registry: ContractRegistry;

  beforeEach(() => {
    registry = makeRegistry();
    registry.register({ id: 'CA', dbId: 1, type: 'marketplace', label: 'a', startLedger: 0, lastLedger: 100, lastLedgerHash: 'h1' });
  });

  it('transitions to syncing and updates cursor fields', () => {
    registry.recordProgress('CA', 150, 'h2');
    const entry = registry.get('CA')!;
    expect(entry.health).toBe('syncing');
    expect(entry.lastLedger).toBe(150);
    expect(entry.lastLedgerHash).toBe('h2');
    expect(entry.consecutiveErrors).toBe(0);
    expect(entry.lastProgressAt).not.toBeNull();
  });

  it('tracks the maximum ledger jump', () => {
    registry.recordProgress('CA', 200, 'h2'); // jump = 100
    registry.recordProgress('CA', 250, 'h3'); // jump = 50
    expect(registry.get('CA')!.maxLedgerJump).toBe(100);
  });

  it('resets consecutiveErrors on success', () => {
    registry.recordError('CA', 'some error');
    registry.recordError('CA', 'another error');
    registry.recordProgress('CA', 200, 'h2');
    expect(registry.get('CA')!.consecutiveErrors).toBe(0);
  });

  it('throws for an unknown contract', () => {
    expect(() => registry.recordProgress('UNKNOWN', 200, null)).toThrow('unknown contract');
  });
});

// ── recordError and auto-disable ──────────────────────────────────────────────

describe('ContractRegistry.recordError — auto-disable', () => {
  let registry: ContractRegistry;

  beforeEach(() => {
    registry = makeRegistry();
    registry.register({ id: 'CA', dbId: 1, type: 'marketplace', label: 'a', startLedger: 0, lastLedger: 0, lastLedgerHash: null });
  });

  it('accumulates consecutive errors', () => {
    registry.recordError('CA', 'err 1');
    registry.recordError('CA', 'err 2');
    expect(registry.get('CA')!.consecutiveErrors).toBe(2);
  });

  it('sets health to failed and disables after MAX_CONTRACT_ERRORS', () => {
    for (let i = 0; i < MAX_CONTRACT_ERRORS; i++) {
      registry.recordError('CA', `error ${i}`);
    }
    const entry = registry.get('CA')!;
    expect(entry.health).toBe('failed');
    expect(entry.active).toBe(false);
    expect(registry.isActive('CA')).toBe(false);
  });

  it('a contract exceeding error threshold is absent from active()', () => {
    for (let i = 0; i < MAX_CONTRACT_ERRORS; i++) {
      registry.recordError('CA', 'err');
    }
    expect(registry.active().find((e) => e.id === 'CA')).toBeUndefined();
  });

  it('a sibling contract is unaffected by another contract\'s errors', () => {
    registry.register({ id: 'CB', dbId: 2, type: 'launchpad', label: 'b', startLedger: 0, lastLedger: 0, lastLedgerHash: null });
    for (let i = 0; i < MAX_CONTRACT_ERRORS; i++) {
      registry.recordError('CA', 'err');
    }
    // CB must still be active and healthy
    const cb = registry.get('CB')!;
    expect(cb.active).toBe(true);
    expect(cb.health).toBe('idle');
    expect(registry.isActive('CB')).toBe(true);
  });
});

// ── enable / disable ─────────────────────────────────────────────────────────

describe('ContractRegistry enable/disable', () => {
  let registry: ContractRegistry;

  beforeEach(() => {
    registry = makeRegistry();
    registry.register({ id: 'CA', dbId: 1, type: 'marketplace', label: 'a', startLedger: 0, lastLedger: 0, lastLedgerHash: null });
  });

  it('disables a contract and sets health to disabled', () => {
    registry.disable('CA', 'operator test');
    expect(registry.get('CA')!.active).toBe(false);
    expect(registry.get('CA')!.health).toBe('disabled');
    expect(registry.isActive('CA')).toBe(false);
  });

  it('enables a disabled contract and resets to idle', () => {
    registry.disable('CA');
    registry.enable('CA');
    expect(registry.get('CA')!.active).toBe(true);
    expect(registry.get('CA')!.health).toBe('idle');
    expect(registry.get('CA')!.consecutiveErrors).toBe(0);
  });

  it('disable on an unknown contract throws', () => {
    expect(() => registry.disable('UNKNOWN')).toThrow('unknown contract');
  });

  it('enable on an unknown contract throws', () => {
    expect(() => registry.enable('UNKNOWN')).toThrow('unknown contract');
  });

  it('disabling one contract does not affect siblings', () => {
    registry.register({ id: 'CB', dbId: 2, type: 'launchpad', label: 'b', startLedger: 0, lastLedger: 0, lastLedgerHash: null });
    registry.disable('CA');
    expect(registry.isActive('CB')).toBe(true);
    expect(registry.active()).toHaveLength(1);
  });
});

// ── Stall detection ───────────────────────────────────────────────────────────

describe('ContractRegistry.checkStalls', () => {
  let registry: ContractRegistry;

  beforeEach(() => {
    registry = makeRegistry();
  });

  it('detects a stall when lastProgressAt is older than the threshold', () => {
    registry.register({
      id: 'CA', dbId: 1, type: 'marketplace', label: 'a',
      startLedger: 0, lastLedger: 100, lastLedgerHash: null,
    });
    // Manually set lastProgressAt to long ago and health to syncing
    const entry = registry.get('CA')!;
    (entry as any).health = 'syncing';
    (entry as any).lastProgressAt = new Date(
      Date.now() - CONTRACT_STALL_THRESHOLD_MS - 1000
    ).toISOString();

    const stalled = registry.checkStalls();
    expect(stalled).toContain('CA');
    expect(registry.get('CA')!.health).toBe('stalled');
    expect(registry.get('CA')!.totalStalls).toBe(1);
  });

  it('does not stall a contract that has progressed recently', () => {
    registry.register({
      id: 'CA', dbId: 1, type: 'marketplace', label: 'a',
      startLedger: 0, lastLedger: 100, lastLedgerHash: null,
    });
    registry.recordProgress('CA', 100, null);
    const stalled = registry.checkStalls();
    expect(stalled).not.toContain('CA');
    expect(registry.get('CA')!.health).toBe('syncing');
  });

  it('does not re-stall a contract already in stalled state', () => {
    registry.register({
      id: 'CA', dbId: 1, type: 'marketplace', label: 'a',
      startLedger: 0, lastLedger: 100, lastLedgerHash: null,
    });
    const entry = registry.get('CA')!;
    (entry as any).health = 'syncing';
    (entry as any).lastProgressAt = new Date(
      Date.now() - CONTRACT_STALL_THRESHOLD_MS - 1000
    ).toISOString();

    registry.checkStalls(); // first call
    const stalledBefore = entry.totalStalls;
    registry.checkStalls(); // second call — should be a no-op
    expect(entry.totalStalls).toBe(stalledBefore);
  });

  it('stalling one contract does not affect siblings', () => {
    registry.register({ id: 'CA', dbId: 1, type: 'marketplace', label: 'a', startLedger: 0, lastLedger: 0, lastLedgerHash: null });
    registry.register({ id: 'CB', dbId: 2, type: 'launchpad',   label: 'b', startLedger: 0, lastLedger: 0, lastLedgerHash: null });

    const entryA = registry.get('CA')!;
    (entryA as any).health = 'syncing';
    (entryA as any).lastProgressAt = new Date(
      Date.now() - CONTRACT_STALL_THRESHOLD_MS - 1000
    ).toISOString();

    // CB has no lastProgressAt — skipped by checkStalls
    registry.checkStalls();

    expect(registry.get('CA')!.health).toBe('stalled');
    expect(registry.get('CB')!.health).toBe('idle'); // unchanged
  });
});

// ── Gap detection ─────────────────────────────────────────────────────────────

describe('ContractRegistry.recordGap', () => {
  let registry: ContractRegistry;

  beforeEach(() => {
    registry = makeRegistry();
    registry.register({ id: 'CA', dbId: 1, type: 'marketplace', label: 'a', startLedger: 0, lastLedger: 100, lastLedgerHash: null });
    registry.register({ id: 'CB', dbId: 2, type: 'launchpad',   label: 'b', startLedger: 0, lastLedger: 50,  lastLedgerHash: null });
  });

  it('transitions to gapped state and increments totalGaps', () => {
    registry.recordGap('CA', 101, 200);
    expect(registry.get('CA')!.health).toBe('gapped');
    expect(registry.get('CA')!.totalGaps).toBe(1);
  });

  it('a gap on one contract does not affect a sibling', () => {
    registry.recordGap('CA', 101, 200);
    expect(registry.get('CB')!.health).toBe('idle');
    expect(registry.get('CB')!.totalGaps).toBe(0);
  });

  it('throws for an unknown contract', () => {
    expect(() => registry.recordGap('UNKNOWN', 0, 10)).toThrow('unknown contract');
  });
});

// ── healthSummary ─────────────────────────────────────────────────────────────

describe('ContractRegistry.healthSummary', () => {
  let registry: ContractRegistry;

  beforeEach(() => {
    registry = makeRegistry();
    registry.register({ id: 'CA', dbId: 1, type: 'marketplace', label: 'mainnet', startLedger: 0, lastLedger: 500, lastLedgerHash: 'hash1' });
  });

  it('returns a summary entry for each registered contract', () => {
    const summary = registry.healthSummary();
    expect(summary).toHaveLength(1);
    const s = summary[0];
    expect(s.contractId).toBe('CA');
    expect(s.type).toBe('marketplace');
    expect(s.label).toBe('mainnet');
    expect(s.health).toBe('idle');
    expect(s.lastLedger).toBe(500);
    expect(s.lastLedgerHash).toBe('hash1');
    expect(s.totalGaps).toBe(0);
    expect(s.totalStalls).toBe(0);
    expect(s.consecutiveErrors).toBe(0);
    expect(typeof s.registeredAt).toBe('string');
  });

  it('reflects updated health after a progress call', () => {
    registry.recordProgress('CA', 600, 'hash2');
    const s = registry.healthSummary()[0];
    expect(s.health).toBe('syncing');
    expect(s.lastLedger).toBe(600);
    expect(s.maxLedgerJump).toBe(100);
  });

  it('includes inactive contracts in the summary', () => {
    registry.disable('CA');
    const summary = registry.healthSummary();
    expect(summary).toHaveLength(1);
    expect(summary[0].active).toBe(false);
    expect(summary[0].health).toBe('disabled');
  });
});

// ── updateLagMetrics ──────────────────────────────────────────────────────────

describe('ContractRegistry.updateLagMetrics', () => {
  it('does not throw when called with valid contracts', () => {
    const registry = makeRegistry();
    registry.register({ id: 'CA', dbId: 1, type: 'marketplace', label: 'a', startLedger: 0, lastLedger: 500, lastLedgerHash: null });
    registry.register({ id: 'CB', dbId: 2, type: 'launchpad',   label: 'b', startLedger: 0, lastLedger: 200, lastLedgerHash: null });
    expect(() => registry.updateLagMetrics(1000)).not.toThrow();
  });

  it('does not throw on empty registry', () => {
    const registry = makeRegistry();
    expect(() => registry.updateLagMetrics(1000)).not.toThrow();
  });
});

// ── isActive / get ────────────────────────────────────────────────────────────

describe('ContractRegistry.isActive / get', () => {
  let registry: ContractRegistry;

  beforeEach(() => {
    registry = makeRegistry();
    registry.register({ id: 'CA', dbId: 1, type: 'marketplace', label: 'a', startLedger: 0, lastLedger: 0, lastLedgerHash: null });
  });

  it('isActive returns true for a registered active contract', () => {
    expect(registry.isActive('CA')).toBe(true);
  });

  it('isActive returns false for an unknown contract', () => {
    expect(registry.isActive('UNKNOWN')).toBe(false);
  });

  it('get returns undefined for an unknown contract', () => {
    expect(registry.get('UNKNOWN')).toBeUndefined();
  });
});

// ── Partial registry write — stale hash mismatch ──────────────────────────────

describe('Contract cursor isolation during partial write failures', () => {
  let registry: ContractRegistry;

  beforeEach(() => {
    registry = makeRegistry();
    registry.register({ id: 'CA', dbId: 1, type: 'marketplace', label: 'a', startLedger: 0, lastLedger: 100, lastLedgerHash: 'old_hash' });
    registry.register({ id: 'CB', dbId: 2, type: 'launchpad',   label: 'b', startLedger: 0, lastLedger: 50,  lastLedgerHash: null });
  });

  it('a stale hash mismatch on CA does not corrupt CB cursor', () => {
    // Simulate CA stalling due to a bad hash (no progress recorded)
    registry.recordError('CA', 'hash mismatch: expected old_hash got new_hash');

    // CB continues to advance normally
    registry.recordProgress('CB', 75, 'cb_hash');

    expect(registry.get('CA')!.lastLedger).toBe(100); // unchanged
    expect(registry.get('CA')!.consecutiveErrors).toBe(1);
    expect(registry.get('CB')!.lastLedger).toBe(75);
    expect(registry.get('CB')!.health).toBe('syncing');
  });

  it('CA auto-disable does not affect CB active status', () => {
    for (let i = 0; i < MAX_CONTRACT_ERRORS; i++) {
      registry.recordError('CA', 'error');
    }
    expect(registry.isActive('CB')).toBe(true);
    expect(registry.active()).toHaveLength(1);
    expect(registry.active()[0].id).toBe('CB');
  });
});

// ── Startup determinism — no duplicates on reconfiguration ───────────────────

describe('ContractRegistry startup determinism', () => {
  it('seeding the same contract twice does not create a duplicate entry', async () => {
    const registry = makeRegistry();
    mockPrisma.trackedContract.findMany.mockResolvedValue([
      makeDbRow({ id: 1, contractId: 'CA', lastLedger: 100 }),
    ]);
    await registry.loadFromDb();
    await registry.loadFromDb(); // second call
    expect(registry.all()).toHaveLength(1);
  });

  it('adding a new contract at runtime registers it without touching existing entries', async () => {
    const registry = makeRegistry();
    mockPrisma.trackedContract.findMany.mockResolvedValue([
      makeDbRow({ id: 1, contractId: 'CA', lastLedger: 100 }),
    ]);
    await registry.loadFromDb();
    registry.recordProgress('CA', 200, 'h');

    // New contract appears in the DB on reconfiguration
    mockPrisma.trackedContract.findMany.mockResolvedValue([
      makeDbRow({ id: 1, contractId: 'CA', lastLedger: 200 }),
      makeDbRow({ id: 2, contractId: 'CB', lastLedger: 0 }),
    ]);
    await registry.loadFromDb();

    expect(registry.all()).toHaveLength(2);
    // CA runtime state must be preserved
    expect(registry.get('CA')!.health).toBe('syncing');
    expect(registry.get('CA')!.lastLedger).toBe(200);
    // CB freshly registered
    expect(registry.get('CB')!.health).toBe('idle');
  });
});

// ── persistCursor ─────────────────────────────────────────────────────────────

describe('ContractRegistry.persistCursor', () => {
  let registry: ContractRegistry;

  beforeEach(() => {
    registry = makeRegistry();
    registry.register({ id: 'CA', dbId: 42, type: 'marketplace', label: 'a', startLedger: 0, lastLedger: 100, lastLedgerHash: null });
    vi.clearAllMocks();
  });

  it('calls trackedContract.update with lastLedger when hash is null', async () => {
    mockPrisma.trackedContract.update.mockResolvedValue({});
    await registry.persistCursor('CA', 200, null);
    expect(mockPrisma.trackedContract.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { lastLedger: 200 },
    });
    // lastLedgerHash must not be included when null — avoids clearing prior hash
    const data = mockPrisma.trackedContract.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('lastLedgerHash');
  });

  it('includes lastLedgerHash when hash is provided', async () => {
    mockPrisma.trackedContract.update.mockResolvedValue({});
    await registry.persistCursor('CA', 200, 'newhash');
    const data = mockPrisma.trackedContract.update.mock.calls[0][0].data;
    expect(data.lastLedgerHash).toBe('newhash');
  });

  it('throws for unknown contract', async () => {
    await expect(registry.persistCursor('UNKNOWN', 1, null)).rejects.toThrow('unknown contract');
  });
});
