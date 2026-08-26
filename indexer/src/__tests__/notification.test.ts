/**
 * notification.test.ts
 *
 * Unit tests for the notification subsystem (Issue #8):
 *   - Event classification (domain, priority, notifiable flag)
 *   - isWalletInvolved field matching
 *   - buildSummary for every domain
 *   - buildNotification output shape
 *   - Notification filtering by priority / domain
 */

import { describe, it, expect } from 'vitest';
import {
  classifyEvent,
  isWalletInvolved,
  EVENT_CLASSIFICATIONS,
  type EventClassification,
} from '../notification/event-priority';
import {
  buildNotification,
  buildSummary,
  type IndexerNotification,
} from '../notification/notification-model';

// ── classifyEvent ─────────────────────────────────────────────────────────────

describe('classifyEvent', () => {
  it('classifies ARTWORK_SOLD as HIGH priority listing', () => {
    const cls = classifyEvent('ARTWORK_SOLD');
    expect(cls.domain).toBe('listing');
    expect(cls.priority).toBe('HIGH');
    expect(cls.notifiable).toBe(true);
  });

  it('classifies BID_PLACED as MEDIUM priority auction', () => {
    const cls = classifyEvent('BID_PLACED');
    expect(cls.domain).toBe('auction');
    expect(cls.priority).toBe('MEDIUM');
    expect(cls.notifiable).toBe(true);
  });

  it('classifies OFFER_ACCEPTED as HIGH priority offer', () => {
    const cls = classifyEvent('OFFER_ACCEPTED');
    expect(cls.domain).toBe('offer');
    expect(cls.priority).toBe('HIGH');
    expect(cls.notifiable).toBe(true);
  });

  it('classifies CONTRACT_PAUSED as HIGH non-notifiable admin', () => {
    const cls = classifyEvent('CONTRACT_PAUSED');
    expect(cls.domain).toBe('admin');
    expect(cls.priority).toBe('HIGH');
    expect(cls.notifiable).toBe(false);
  });

  it('classifies DEPLOY_NORMAL_721 as LOW notifiable deploy', () => {
    const cls = classifyEvent('DEPLOY_NORMAL_721');
    expect(cls.domain).toBe('deploy');
    expect(cls.priority).toBe('LOW');
    expect(cls.notifiable).toBe(true);
  });

  it('returns safe default for unknown event type', () => {
    const cls = classifyEvent('UNKNOWN_EVENT_XYZ');
    expect(cls.domain).toBe('system');
    expect(cls.priority).toBe('LOW');
    expect(cls.notifiable).toBe(false);
  });

  it('every registered event type has a valid classification shape', () => {
    for (const [type, cls] of Object.entries(EVENT_CLASSIFICATIONS)) {
      expect(['listing', 'auction', 'offer', 'deploy', 'admin', 'system']).toContain(
        cls.domain,
        `${type} has invalid domain`
      );
      expect(['HIGH', 'MEDIUM', 'LOW']).toContain(
        cls.priority,
        `${type} has invalid priority`
      );
      expect(typeof cls.notifiable).toBe('boolean');
    }
  });
});

// ── isWalletInvolved ──────────────────────────────────────────────────────────

describe('isWalletInvolved', () => {
  const wallet = 'GABC1234ABCD';

  it('returns true when wallet is the actor', () => {
    expect(isWalletInvolved(wallet, { actor: wallet })).toBe(true);
  });

  it('returns true when wallet is the buyer', () => {
    expect(isWalletInvolved(wallet, { buyer: wallet })).toBe(true);
  });

  it('returns true when wallet is the bidder', () => {
    expect(isWalletInvolved(wallet, { bidder: wallet, auction_id: 1n })).toBe(true);
  });

  it('returns true when wallet is the offerer', () => {
    expect(isWalletInvolved(wallet, { offerer: wallet })).toBe(true);
  });

  it('returns true when wallet is the winner', () => {
    expect(isWalletInvolved(wallet, { winner: wallet })).toBe(true);
  });

  it('returns false when wallet is not present in any field', () => {
    expect(isWalletInvolved(wallet, { buyer: 'GOTHER', artist: 'GOTHER2' })).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isWalletInvolved(wallet.toLowerCase(), { actor: wallet })).toBe(true);
  });

  it('returns false for empty data', () => {
    expect(isWalletInvolved(wallet, {})).toBe(false);
  });
});

// ── buildSummary ──────────────────────────────────────────────────────────────

describe('buildSummary', () => {
  it('formats ARTWORK_SOLD with price', () => {
    const s = buildSummary('ARTWORK_SOLD', { listing_id: 42n, price: 10_000_000n });
    expect(s).toContain('42');
    expect(s).toContain('1.0000 XLM');
  });

  it('formats BID_PLACED with bid amount', () => {
    const s = buildSummary('BID_PLACED', { auction_id: 7n, bid_amount: 50_000_000n });
    expect(s).toContain('7');
    expect(s).toContain('5.0000 XLM');
  });

  it('formats AUCTION_RESOLVED with winner', () => {
    const s = buildSummary('AUCTION_RESOLVED', {
      auction_id: 3n,
      winner: 'GABC',
      amount: 20_000_000n,
    });
    expect(s).toContain('3');
    expect(s).toContain('winner');
  });

  it('formats AUCTION_RESOLVED without winner (no bids)', () => {
    const s = buildSummary('AUCTION_RESOLVED', { auction_id: 5n, amount: 0n });
    expect(s).toContain('no bids');
  });

  it('formats OFFER_ACCEPTED', () => {
    const s = buildSummary('OFFER_ACCEPTED', { listing_id: 10n });
    expect(s).toContain('accepted');
    expect(s).toContain('10');
  });

  it('formats LISTING_PRICE_UPDATED', () => {
    const s = buildSummary('LISTING_PRICE_UPDATED', {
      listing_id: 1n,
      new_price: 15_000_000n,
    });
    expect(s).toContain('1.5000 XLM');
  });

  it('returns fallback for unknown event type', () => {
    const s = buildSummary('COMPLETELY_UNKNOWN', {});
    expect(s).toBe('Marketplace event: COMPLETELY_UNKNOWN');
  });

  it('handles CONTRACT_PAUSED', () => {
    const s = buildSummary('CONTRACT_PAUSED', {});
    expect(s.toLowerCase()).toContain('paused');
  });
});

// ── buildNotification ─────────────────────────────────────────────────────────

const MOCK_SOLD_ROW = {
  id: 99,
  eventType: 'ARTWORK_SOLD',
  listingId: '42',
  actor: 'GARTIST',
  data: { listing_id: 42n, price: 10_000_000n, buyer: 'GBUYER' },
  ledgerSequence: 1234,
  ledgerTimestamp: new Date('2025-01-01T12:00:00Z'),
};

const MOCK_BID_ROW = {
  id: 7,
  eventType: 'BID_PLACED',
  listingId: null,
  actor: 'GBIDDER',
  data: { auction_id: 3n, bid_amount: 5_000_000n, bidder: 'GBIDDER' },
  ledgerSequence: 999,
  ledgerTimestamp: null,
};

describe('buildNotification', () => {
  it('builds a notification for ARTWORK_SOLD', () => {
    const cls = classifyEvent('ARTWORK_SOLD');
    const n = buildNotification(MOCK_SOLD_ROW, cls, 'GBUYER');
    expect(n.eventType).toBe('ARTWORK_SOLD');
    expect(n.domain).toBe('listing');
    expect(n.priority).toBe('HIGH');
    expect(n.resourceType).toBe('listing');
    expect(n.resourceId).toBe('42');
    expect(n.targetWallet).toBe('GBUYER');
    expect(n.id).toContain('ARTWORK_SOLD');
    expect(n.id).toContain('42');
    expect(n.summary).toBeTruthy();
    expect(n.ledgerTimestamp).toBe('2025-01-01T12:00:00.000Z');
  });

  it('builds a notification for BID_PLACED', () => {
    const cls = classifyEvent('BID_PLACED');
    const n = buildNotification(MOCK_BID_ROW, cls, null);
    expect(n.domain).toBe('auction');
    expect(n.resourceType).toBe('auction');
    expect(n.resourceId).toBe('3');   // from data.auction_id
    expect(n.amount).toBe('5000000'); // stroop string
    expect(n.ledgerTimestamp).toBeNull();
  });

  it('sets amount from bid_amount field', () => {
    const cls = classifyEvent('BID_PLACED');
    const n = buildNotification(MOCK_BID_ROW, cls, null);
    expect(n.amount).toBe('5000000');
  });

  it('returns null amount when no amount field present', () => {
    const cls = classifyEvent('LISTING_CANCELLED');
    const row = {
      id: 1,
      eventType: 'LISTING_CANCELLED',
      listingId: '5',
      actor: 'GARTIST',
      data: {},
      ledgerSequence: 100,
      ledgerTimestamp: null,
    };
    const n = buildNotification(row, cls, null);
    expect(n.amount).toBeNull();
  });

  it('id is deterministic for same event+ledger', () => {
    const cls = classifyEvent('ARTWORK_SOLD');
    const n1 = buildNotification(MOCK_SOLD_ROW, cls, 'GBUYER');
    const n2 = buildNotification(MOCK_SOLD_ROW, cls, 'GBUYER');
    expect(n1.id).toBe(n2.id);
  });

  it('serialises data field through without mutation', () => {
    const cls = classifyEvent('ARTWORK_SOLD');
    const n = buildNotification(MOCK_SOLD_ROW, cls, null);
    expect(n.data).toEqual(MOCK_SOLD_ROW.data);
  });
});

// ── Filtering helpers (domain / priority) ─────────────────────────────────────

describe('notification filtering', () => {
  const makeNotif = (eventType: string): IndexerNotification => {
    const cls = classifyEvent(eventType);
    return buildNotification(
      {
        id: Math.random(),
        eventType,
        listingId: '1',
        actor: 'G',
        data: {},
        ledgerSequence: 1,
        ledgerTimestamp: null,
      },
      cls,
      null
    );
  };

  it('can filter by HIGH priority only', () => {
    const notifs = [
      makeNotif('ARTWORK_SOLD'),   // HIGH
      makeNotif('BID_PLACED'),     // MEDIUM
      makeNotif('LISTING_CREATED'), // MEDIUM
      makeNotif('OFFER_ACCEPTED'), // HIGH
    ];
    const high = notifs.filter((n) => n.priority === 'HIGH');
    expect(high).toHaveLength(2);
    expect(high.map((n) => n.eventType)).toEqual(
      expect.arrayContaining(['ARTWORK_SOLD', 'OFFER_ACCEPTED'])
    );
  });

  it('can filter by auction domain', () => {
    const notifs = [
      makeNotif('BID_PLACED'),
      makeNotif('AUCTION_EXTENDED'),
      makeNotif('ARTWORK_SOLD'),
      makeNotif('OFFER_ACCEPTED'),
    ];
    const auction = notifs.filter((n) => n.domain === 'auction');
    expect(auction).toHaveLength(2);
  });

  it('excludes non-notifiable events via notifiable flag', () => {
    const allTypes = Object.keys(EVENT_CLASSIFICATIONS);
    const notifiable = allTypes.filter((t) => EVENT_CLASSIFICATIONS[t].notifiable);
    const adminNotifiable = notifiable.filter(
      (t) => EVENT_CLASSIFICATIONS[t].domain === 'admin'
    );
    // No admin events should be notifiable (they go to operator streams only)
    expect(adminNotifiable.length).toBe(0);
  });
});
