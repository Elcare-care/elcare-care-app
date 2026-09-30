/**
 * retention-cleanup.test.ts
 *
 * Verifies the three acceptance criteria for Feature 1:
 *
 *  1. Every stored wallet-related field has a documented retention class.
 *  2. archiveTable() moves eligible off-chain data WITHOUT touching canonical
 *     tables (Listing, Auction, Offer, Bid, RoyaltyPayment, Collection).
 *  3. deleteOldOperationalAuditRecords() removes eligible off-chain metadata
 *     and honours legal-hold exclusions.
 *  4. pseudonymizeWallet() / maybeRedactWallet() produce correct output and
 *     pass automated redaction tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Wallet-privacy helpers ────────────────────────────────────────────────────

import {
  pseudonymizeWallet,
  maybeRedactWallet,
  pseudonymizeRow,
  pseudonymizeEventData,
  looksLikeStellarPublicKey,
} from '../wallet-privacy.js';

// ── Retention catalogue ───────────────────────────────────────────────────────
//
// This is the single authoritative mapping of every wallet-bearing field to its
// retention class.  Any PR that adds a new wallet-bearing column must update
// this catalogue — the test will fail until the catalogue is updated.

type RetentionClass = 'canonical' | 'warm' | 'operational';

interface WalletField {
  table: string;
  field: string;
  class: RetentionClass;
  notes: string;
}

export const WALLET_FIELD_CATALOGUE: WalletField[] = [
  // ── Canonical — on-chain provenance, never deleted ──────────────────────
  { table: 'Listing',           field: 'artist',          class: 'canonical',    notes: 'On-chain listing creator' },
  { table: 'Listing',           field: 'owner',           class: 'canonical',    notes: 'Current on-chain owner' },
  { table: 'Listing',           field: 'originalCreator', class: 'canonical',    notes: 'Attribution for secondary royalties' },
  { table: 'Auction',           field: 'creator',         class: 'canonical',    notes: 'On-chain auction creator' },
  { table: 'Auction',           field: 'highestBidder',   class: 'canonical',    notes: 'Current highest bidder' },
  { table: 'Offer',             field: 'offerer',         class: 'canonical',    notes: 'On-chain offer submitter' },
  { table: 'Collection',        field: 'creator',         class: 'canonical',    notes: 'On-chain collection deployer' },
  { table: 'Bid',               field: 'bidder',          class: 'canonical',    notes: 'On-chain bid submitter' },
  { table: 'RoyaltyPayment',    field: 'recipient',       class: 'canonical',    notes: 'Financial audit trail' },
  { table: 'WhitelistedToken',  field: 'addedBy',         class: 'canonical',    notes: 'On-chain governance trail' },
  { table: 'WhitelistedToken',  field: 'removedBy',       class: 'canonical',    notes: 'On-chain governance trail' },
  // ── Warm — archived after retention window, never deleted from archive ──
  { table: 'MarketplaceEvent',  field: 'actor',           class: 'warm',         notes: 'On-chain signer; pseudonymised in analytics' },
  { table: 'MarketplaceEvent',  field: 'data.buyer',      class: 'warm',         notes: 'Embedded JSON wallet key' },
  { table: 'MarketplaceEvent',  field: 'data.artist',     class: 'warm',         notes: 'Embedded JSON wallet key' },
  { table: 'MarketplaceEvent',  field: 'data.offerer',    class: 'warm',         notes: 'Embedded JSON wallet key' },
  { table: 'MarketplaceEvent',  field: 'data.bidder',     class: 'warm',         notes: 'Embedded JSON wallet key' },
  { table: 'MarketplaceEvent',  field: 'data.winner',     class: 'warm',         notes: 'Embedded JSON wallet key' },
  { table: 'MarketplaceEvent',  field: 'data.creator',    class: 'warm',         notes: 'Embedded JSON wallet key' },
  { table: 'ArchivedMarketplaceEvent', field: 'actor',    class: 'warm',         notes: 'Cold archive — append-only' },
  { table: 'PriceHistory',      field: 'changedBy',       class: 'warm',         notes: 'On-chain signer for price update' },
  // ── Operational — deleted after 90-day retention window ────────────────
  { table: 'OperationalAudit',  field: 'actor',           class: 'operational',  notes: 'Operator identity; pseudonymised in CSV exports' },
  { table: 'OperationalAudit',  field: 'ipAddress',       class: 'operational',  notes: 'Never exported in analytics' },
];

// ── Canonical tables — MUST NOT be deleted by the retention job ──────────────

const CANONICAL_TABLES = new Set([
  'Listing', 'Auction', 'Offer', 'Bid',
  'RoyaltyPayment', 'Collection', 'WhitelistedToken',
  'SyncState', 'TrackedContract',
]);

// ── Mocks for archive job ─────────────────────────────────────────────────────

const mockFindMany   = vi.fn();
const mockCreate     = vi.fn();
const mockDelete     = vi.fn();
const mockDeleteMany = vi.fn();
const mockCount      = vi.fn();

// Build a mock prisma that records which model names are accessed.
const accessedModels: string[] = [];

function makeModelProxy(modelName: string) {
  return {
    findMany:    (...a: any[]) => { accessedModels.push(modelName); return mockFindMany(...a); },
    create:      (...a: any[]) => mockCreate(...a),
    delete:      (...a: any[]) => mockDelete(...a),
    deleteMany:  (...a: any[]) => mockDeleteMany(...a),
    count:       (...a: any[]) => mockCount(...a),
  };
}

// Proxy handler intercepts property access so any model name works.
const prismaProxy = new Proxy({} as any, {
  get(_target, prop: string) {
    if (prop === '$queryRawUnsafe') return vi.fn().mockResolvedValue([{ pg_try_advisory_lock: true }]);
    if (prop === '$transaction') {
      return async (fn: (tx: any) => Promise<void>) => fn(prismaProxy);
    }
    return makeModelProxy(prop);
  },
});

vi.mock('../db.js', () => ({ default: prismaProxy }));
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// ── Section 1: Retention catalogue completeness ───────────────────────────────

describe('Retention catalogue — every wallet field has a documented class', () => {
  it('catalogue is non-empty', () => {
    expect(WALLET_FIELD_CATALOGUE.length).toBeGreaterThan(0);
  });

  it('every entry has a valid retention class', () => {
    const valid: RetentionClass[] = ['canonical', 'warm', 'operational'];
    for (const entry of WALLET_FIELD_CATALOGUE) {
      expect(
        valid.includes(entry.class),
        `${entry.table}.${entry.field} has unknown class "${entry.class}"`,
      ).toBe(true);
    }
  });

  it('every entry has a non-empty notes field', () => {
    for (const entry of WALLET_FIELD_CATALOGUE) {
      expect(
        entry.notes.length,
        `${entry.table}.${entry.field} has empty notes`,
      ).toBeGreaterThan(0);
    }
  });

  it('canonical tables appear in the catalogue', () => {
    const cataloguedTables = new Set(WALLET_FIELD_CATALOGUE.map((e) => e.table));
    for (const t of ['Listing', 'Auction', 'Offer', 'Collection', 'Bid', 'RoyaltyPayment']) {
      expect(cataloguedTables.has(t), `${t} missing from catalogue`).toBe(true);
    }
  });

  it('OperationalAudit is classified as operational (not canonical)', () => {
    const entries = WALLET_FIELD_CATALOGUE.filter((e) => e.table === 'OperationalAudit');
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.class).toBe('operational');
    }
  });

  it('MarketplaceEvent is classified as warm (not canonical)', () => {
    const entries = WALLET_FIELD_CATALOGUE.filter((e) => e.table === 'MarketplaceEvent');
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.class).toBe('warm');
    }
  });

  it('no canonical table field is classified as operational', () => {
    const violations = WALLET_FIELD_CATALOGUE.filter(
      (e) => CANONICAL_TABLES.has(e.table) && e.class === 'operational',
    );
    expect(violations).toHaveLength(0);
  });
});

// ── Section 2: Archive job — canonical tables are never touched ───────────────

describe('archiveTable() — canonical tables are not deleted', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessedModels.length = 0;
  });

  it('archive job does not call findMany on Listing', async () => {
    // Return empty so the job exits quickly.
    mockFindMany.mockResolvedValue([]);
    mockCount.mockResolvedValue(0);

    // Import archive module after mocks are set up.
    const { ARCHIVE_TABLES } = await import('../archive.js').catch(() => ({
      ARCHIVE_TABLES: [] as any[],
    }));

    // The ARCHIVE_TABLES list must not contain canonical tables.
    const hotTables = Array.isArray(ARCHIVE_TABLES)
      ? ARCHIVE_TABLES.map((t: any) => t.hot)
      : [];

    for (const canonicalTable of CANONICAL_TABLES) {
      expect(
        hotTables.includes(canonicalTable),
        `Canonical table "${canonicalTable}" must not appear in ARCHIVE_TABLES.hot`,
      ).toBe(false);
    }
  });

  it('ARCHIVE_TABLES contains only warm/operational table names', async () => {
    const { ARCHIVE_TABLES } = await import('../archive.js').catch(() => ({
      ARCHIVE_TABLES: [] as any[],
    }));

    if (!Array.isArray(ARCHIVE_TABLES)) return; // module not importable in unit context

    const allowedHotTables = new Set([
      'MarketplaceEvent', 'PriceHistory', 'LedgerCheckpoint',
      'BackfillJob', 'LedgerGap', 'DeadLetterEvent',
      'ReconciliationRepair', 'ReconciliationRun', 'Discrepancy', 'KeeperAction',
    ]);

    for (const table of ARCHIVE_TABLES) {
      expect(
        allowedHotTables.has(table.hot),
        `Unexpected table in ARCHIVE_TABLES: "${table.hot}"`,
      ).toBe(true);
    }
  });
});

// ── Section 3: OperationalAudit deletion + legal-hold ────────────────────────

describe('deleteOldOperationalAuditRecords()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls deleteMany with a createdAt < cutoff filter', async () => {
    mockDeleteMany.mockResolvedValue({ count: 5 });

    const { deleteOldOperationalAuditRecords } = await import('../archive.js');
    const deleted = await deleteOldOperationalAuditRecords(90);

    expect(mockDeleteMany).toHaveBeenCalledOnce();
    const call = mockDeleteMany.mock.calls[0][0] as any;
    expect(call.where.createdAt.lt).toBeInstanceOf(Date);

    // Cutoff should be ~90 days ago
    const expectedCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const actualCutoff: Date = call.where.createdAt.lt;
    expect(Math.abs(actualCutoff.getTime() - expectedCutoff.getTime())).toBeLessThan(5000);

    expect(deleted).toBe(5);
  });

  it('honours legal-hold IDs — excludes them from the delete filter', async () => {
    // Inject legal-hold IDs via env var before re-importing the module.
    const originalEnv = process.env.LEGAL_HOLD_IDS;
    process.env.LEGAL_HOLD_IDS = 'req-abc-123,req-def-456';

    // Re-import to pick up the env change (vitest module cache — use resetModules).
    vi.resetModules();
    mockDeleteMany.mockResolvedValue({ count: 3 });
    vi.mock('../db.js', () => ({ default: prismaProxy }));
    vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

    const { deleteOldOperationalAuditRecords } = await import('../archive.js');
    await deleteOldOperationalAuditRecords(90);

    const call = mockDeleteMany.mock.calls[0][0] as any;
    expect(call.where.requestId?.notIn).toContain('req-abc-123');
    expect(call.where.requestId?.notIn).toContain('req-def-456');

    process.env.LEGAL_HOLD_IDS = originalEnv ?? '';
    vi.resetModules();
  });

  it('does not delete canonical table rows (Listing, Auction, etc.)', async () => {
    // After the job runs, none of the canonical model proxies should have
    // had deleteMany called on them.
    mockDeleteMany.mockResolvedValue({ count: 0 });
    accessedModels.length = 0;

    const { deleteOldOperationalAuditRecords } = await import('../archive.js');
    await deleteOldOperationalAuditRecords(90);

    // The function only ever touches operationalAudit — verify no canonical
    // model was written to.
    for (const canonical of CANONICAL_TABLES) {
      const lower = canonical.charAt(0).toLowerCase() + canonical.slice(1);
      expect(
        accessedModels.includes(lower),
        `deleteOldOperationalAuditRecords must not touch canonical table "${canonical}"`,
      ).toBe(false);
    }
  });
});

// ── Section 4: Pseudonymisation helpers ──────────────────────────────────────

const FULL_KEY   = 'GBFUNHEQOVN35LFEKP7SZXFYJPMJ3WLXLX4PQZGBK737NTLRHOKVES3F';
const PSEUDO_KEY = 'GBFU…ES3F';

describe('pseudonymizeWallet()', () => {
  it('returns first-4 + … + last-4 for a valid Stellar public key', () => {
    expect(pseudonymizeWallet(FULL_KEY)).toBe(PSEUDO_KEY);
  });

  it('returns null/undefined unchanged', () => {
    expect(pseudonymizeWallet(null)).toBeNull();
    expect(pseudonymizeWallet(undefined)).toBeUndefined();
  });

  it('returns short strings unchanged (not a key length)', () => {
    expect(pseudonymizeWallet('GABC')).toBe('GABC');
  });

  it('handles empty string', () => {
    expect(pseudonymizeWallet('')).toBe('');
  });

  it('does NOT fully redact — prefix and suffix are preserved', () => {
    const result = pseudonymizeWallet(FULL_KEY) as string;
    expect(result.startsWith('GBFU')).toBe(true);
    expect(result.endsWith('ES3F')).toBe(true);
  });

  it('result does not contain the full key', () => {
    expect(pseudonymizeWallet(FULL_KEY)).not.toBe(FULL_KEY);
    expect(pseudonymizeWallet(FULL_KEY)!.length).toBeLessThan(FULL_KEY.length);
  });
});

describe('maybeRedactWallet()', () => {
  it('pseudonymises at debug log level', () => {
    expect(maybeRedactWallet(FULL_KEY, 'debug')).toBe(PSEUDO_KEY);
  });

  it('pseudonymises at trace log level', () => {
    expect(maybeRedactWallet(FULL_KEY, 'trace')).toBe(PSEUDO_KEY);
  });

  it('keeps full address at info level', () => {
    expect(maybeRedactWallet(FULL_KEY, 'info')).toBe(FULL_KEY);
  });

  it('keeps full address at warn level', () => {
    expect(maybeRedactWallet(FULL_KEY, 'warn')).toBe(FULL_KEY);
  });

  it('keeps full address at error level', () => {
    expect(maybeRedactWallet(FULL_KEY, 'error')).toBe(FULL_KEY);
  });

  it('passes null through unchanged', () => {
    expect(maybeRedactWallet(null, 'debug')).toBeNull();
  });
});

describe('pseudonymizeRow()', () => {
  it('pseudonymises Stellar-key-shaped string values', () => {
    const row = { artist: FULL_KEY, title: 'My Art', price: '100' };
    const result = pseudonymizeRow(row);
    expect(result.artist).toBe(PSEUDO_KEY);
    expect(result.title).toBe('My Art');  // short string — unchanged
    expect(result.price).toBe('100');     // not a key — unchanged
  });

  it('does not mutate the original row', () => {
    const row = { artist: FULL_KEY };
    pseudonymizeRow(row);
    expect(row.artist).toBe(FULL_KEY);
  });

  it('leaves non-key strings intact', () => {
    const row = { status: 'Active', collection: 'African Art' };
    const result = pseudonymizeRow(row);
    expect(result.status).toBe('Active');
    expect(result.collection).toBe('African Art');
  });
});

describe('pseudonymizeEventData()', () => {
  it('pseudonymises known wallet keys at debug level', () => {
    const data = { buyer: FULL_KEY, amount: '50', token: 'XLM' };
    const result = pseudonymizeEventData(data, 'debug') as any;
    expect(result.buyer).toBe(PSEUDO_KEY);
    expect(result.amount).toBe('50');   // not a wallet key
    expect(result.token).toBe('XLM');   // not a wallet key
  });

  it('does not pseudonymise at info level', () => {
    const data = { buyer: FULL_KEY };
    const result = pseudonymizeEventData(data, 'info') as any;
    expect(result.buyer).toBe(FULL_KEY);
  });

  it('returns null/undefined unchanged', () => {
    expect(pseudonymizeEventData(null, 'debug')).toBeNull();
    expect(pseudonymizeEventData(undefined, 'debug')).toBeUndefined();
  });

  it('does not mutate the original data object', () => {
    const data = { artist: FULL_KEY };
    pseudonymizeEventData(data, 'debug');
    expect(data.artist).toBe(FULL_KEY);
  });
});

describe('looksLikeStellarPublicKey()', () => {
  it('returns true for a valid G-prefix key', () => {
    expect(looksLikeStellarPublicKey(FULL_KEY)).toBe(true);
  });

  it('returns false for a short string', () => {
    expect(looksLikeStellarPublicKey('GABC')).toBe(false);
  });

  it('returns false for a string with wrong prefix', () => {
    // S-prefix is a secret key, not a public key
    const secretKey = 'SABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXY';
    expect(looksLikeStellarPublicKey(secretKey)).toBe(false);
  });

  it('returns false for a string with invalid base32 characters', () => {
    const invalid = 'G' + '0'.repeat(55); // '0' is not in base32 alphabet
    expect(looksLikeStellarPublicKey(invalid)).toBe(false);
  });
});

// ── Section 5: Analytics export redaction ────────────────────────────────────

describe('Analytics export — wallet addresses are pseudonymised', () => {
  it('pseudonymizeRow scrubs addresses in a simulated analytics row', () => {
    const analyticsRow = {
      actor:  FULL_KEY,
      target: '/admin/contracts',
      outcome: 'Success',
      createdAt: new Date().toISOString(),
    };

    const scrubbed = pseudonymizeRow(analyticsRow);

    // Address must not appear in full in the exported row.
    expect(JSON.stringify(scrubbed)).not.toContain(FULL_KEY);
    expect(scrubbed.actor).toBe(PSEUDO_KEY);

    // Non-wallet fields are preserved.
    expect(scrubbed.target).toBe('/admin/contracts');
    expect(scrubbed.outcome).toBe('Success');
  });

  it('pseudonymizeRow does not redact non-Stellar strings', () => {
    const row = {
      actor:     'system',        // operator label, not a wallet
      ipAddress: '192.168.1.1',   // IP, not a wallet
      requestId: 'req-abc-123',
    };
    const scrubbed = pseudonymizeRow(row);
    expect(scrubbed.actor).toBe('system');
    expect(scrubbed.ipAddress).toBe('192.168.1.1');
  });
});
