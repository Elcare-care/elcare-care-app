import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPrisma: any = vi.hoisted(() => {
  const mPrisma: any = {
    marketplaceEvent: {
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    listing: {
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    syncState: {
      update: vi.fn().mockResolvedValue({ id: 1, lastLedger: 100, lastLedgerHash: null }),
    },
    collection: {
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  mPrisma.$transaction = vi.fn((callback: (tx: typeof mPrisma) => Promise<void>) => callback(mPrisma));
  return mPrisma;
});

vi.mock('../db', () => ({ default: mockPrisma }));

vi.mock('@stellar/stellar-sdk', () => ({
  rpc: {
    Server: class {
      getLedgers = vi.fn();
      getLatestLedger = vi.fn();
      getEvents = vi.fn();
    },
  },
}));

import { revertLedgers } from '../poller';

describe('Chain Re-organization Rollback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(
      (callback: (tx: typeof mockPrisma) => Promise<void>) => callback(mockPrisma)
    );
  });

  it('deletes events and listings created after the safe ledger', async () => {
    await revertLedgers(100);

    expect(mockPrisma.$transaction).toHaveBeenCalledOnce();

    expect(mockPrisma.marketplaceEvent.deleteMany).toHaveBeenCalledWith({
      where: { ledgerSequence: { gt: 100 } },
    });

    expect(mockPrisma.listing.deleteMany).toHaveBeenCalledWith({
      where: { createdAtLedger: { gt: 100 } },
    });
  });

  it('reverts listing status for listings updated after the safe ledger', async () => {
    await revertLedgers(100);

    expect(mockPrisma.listing.updateMany).toHaveBeenCalledWith({
      where: { updatedAtLedger: { gt: 100 } },
      data: { status: 'Active', updatedAtLedger: 100 },
    });
  });

  it('deletes collections deployed after the safe ledger', async () => {
    await revertLedgers(100);

    expect(mockPrisma.collection.deleteMany).toHaveBeenCalledWith({
      where: { deployedAtLedger: { gt: 100 } },
    });
  });

  it('resets SyncState to the safe ledger with null hash', async () => {
    await revertLedgers(100);

    expect(mockPrisma.syncState.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { lastLedger: 100, lastLedgerHash: null },
    });
  });

  it('wraps all operations in a single transaction', async () => {
    await revertLedgers(50);

    expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
    // All DB calls happen inside the transaction callback
    expect(mockPrisma.marketplaceEvent.deleteMany).toHaveBeenCalledOnce();
    expect(mockPrisma.listing.deleteMany).toHaveBeenCalledOnce();
    expect(mockPrisma.listing.updateMany).toHaveBeenCalledOnce();
    expect(mockPrisma.collection.deleteMany).toHaveBeenCalledOnce();
    expect(mockPrisma.syncState.update).toHaveBeenCalledOnce();
  });
});
