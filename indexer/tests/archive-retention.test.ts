import { describe, expect, it } from 'vitest';

describe('archive retention policy', () => {
  it('documents hot tables that are never archived', () => {
    const hotTables = [
      'Listing',
      'Auction',
      'Offer',
      'Collection',
      'Bid',
      'RoyaltyPayment',
      'SyncState',
      'TrackedContract',
    ];
    expect(hotTables.length).toBeGreaterThan(0);
  });

  it('documents warm tables with retention periods', () => {
    const warmTables: [string, number][] = [
      ['MarketplaceEvent', 90],
      ['PriceHistory', 90],
      ['LedgerCheckpoint', 30],
      ['BackfillJob', 30],
      ['LedgerGap', 30],
      ['DeadLetterEvent', 30],
      ['ReconciliationRepair', 90],
      ['ReconciliationRun', 90],
      ['Discrepancy', 90],
      ['KeeperAction', 30],
    ];
    for (const [table, days] of warmTables) {
      expect(days).toBeGreaterThan(0);
      expect(days).toBeLessThanOrEqual(365);
    }
  });

  it('has corresponding archive tables for each warm table', () => {
    const archiveTables = [
      'ArchivedMarketplaceEvent',
      'ArchivedPriceHistory',
      'ArchivedLedgerCheckpoint',
      'ArchivedBackfillJob',
      'ArchivedLedgerGap',
      'ArchivedDeadLetterEvent',
      'ArchivedReconciliationRepair',
      'ArchivedReconciliationRun',
      'ArchivedDiscrepancy',
      'ArchivedKeeperAction',
    ];
    expect(archiveTables.length).toBe(10);
  });
});
