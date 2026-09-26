import { describe, expect, it } from 'vitest';

// Lightweight unit tests for lease coordination without hitting the DB.
// Full integration tests require a running Postgres instance.

describe('Lease types and helpers', () => {
  it('exports expected types and functions', async () => {
    const mod = await import('../coordination/lease.js');
    expect(typeof mod.acquireLease).toBe('function');
    expect(typeof mod.releaseLease).toBe('function');
    expect(typeof mod.renewLease).toBe('function');
    expect(typeof mod.getCurrentLease).toBe('function');
    expect(typeof mod.getLeaseStatus).toBe('function');
  });

  it('starts with no lease', async () => {
    const mod = await import('../coordination/lease.js');
    expect(mod.getCurrentLease()).toBeNull();
    expect(mod.getLeaseStatus().hasLease).toBe(false);
  });
});
