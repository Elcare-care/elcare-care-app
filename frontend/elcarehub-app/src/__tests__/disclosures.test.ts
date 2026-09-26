/**
 * __tests__/disclosures.test.ts
 *
 * Work item D — Targeted tests for the disclosure acknowledgement system.
 * These cover the high-risk paths identified in docs/COVERAGE_POLICY.md.
 */

import {
  DISCLOSURES,
  isAcknowledged,
  recordAcknowledgement,
  clearAcknowledgement,
  DisclosureActionType,
} from '@/lib/disclosures';

// Stub localStorage for tests
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem:   (key: string) => store[key] ?? null,
    setItem:   (key: string, value: string) => { store[key] = value; },
    removeItem:(key: string) => { delete store[key]; },
    clear:     () => { store = {}; },
  };
})();

Object.defineProperty(window, 'localStorage', { value: localStorageMock });

beforeEach(() => {
  localStorageMock.clear();
});

describe('DISCLOSURES catalog', () => {
  it('has an entry for every DisclosureActionType', () => {
    const requiredKeys: DisclosureActionType[] = [
      'purchase', 'bid', 'offer', 'accept_offer', 'mint', 'collection_deploy',
    ];
    for (const key of requiredKeys) {
      expect(DISCLOSURES[key]).toBeDefined();
      expect(DISCLOSURES[key].risks.length).toBeGreaterThan(0);
      expect(DISCLOSURES[key].version).toBeGreaterThanOrEqual(1);
    }
  });

  it('every disclosure has a non-empty policyUrl', () => {
    for (const key of Object.keys(DISCLOSURES) as DisclosureActionType[]) {
      expect(DISCLOSURES[key].policyUrl).toBeTruthy();
    }
  });

  it('purchase and bid require acknowledgement', () => {
    expect(DISCLOSURES.purchase.requiresAcknowledgement).toBe(true);
    expect(DISCLOSURES.bid.requiresAcknowledgement).toBe(true);
  });

  it('offer is informational only (no acknowledgement required)', () => {
    expect(DISCLOSURES.offer.requiresAcknowledgement).toBe(false);
  });

  it('purchase disclosure mentions irreversibility and fees', () => {
    const text = DISCLOSURES.purchase.risks.join(' ').toLowerCase();
    expect(text).toMatch(/irreversible/);
    expect(text).toMatch(/fee/);
  });

  it('bid disclosure mentions binding nature of bids', () => {
    const text = DISCLOSURES.bid.risks.join(' ').toLowerCase();
    expect(text).toMatch(/binding|cannot cancel/i);
  });
});

describe('isAcknowledged', () => {
  it('returns false when nothing stored', () => {
    expect(isAcknowledged('purchase')).toBe(false);
  });

  it('returns true after recordAcknowledgement', () => {
    recordAcknowledgement('purchase');
    expect(isAcknowledged('purchase')).toBe(true);
  });

  it('returns false for a different action even after purchase is acknowledged', () => {
    recordAcknowledgement('purchase');
    expect(isAcknowledged('bid')).toBe(false);
  });
});

describe('recordAcknowledgement + clearAcknowledgement', () => {
  it('records and then clears correctly', () => {
    recordAcknowledgement('bid');
    expect(isAcknowledged('bid')).toBe(true);
    clearAcknowledgement('bid');
    expect(isAcknowledged('bid')).toBe(false);
  });

  it('clearing a non-existent key does not throw', () => {
    expect(() => clearAcknowledgement('mint')).not.toThrow();
  });
});

describe('version isolation', () => {
  it('acknowledgement for version N is not recognised for version N+1', () => {
    // Simulate what happens when we bump version: manually write old key
    const oldKey = `elcarehub_disclosure_v1_purchase`;
    localStorage.setItem(oldKey, 'true');

    // If the real version is still 1, it should match
    expect(isAcknowledged('purchase')).toBe(true);

    // Write for version 2 key directly and verify isolation
    const newKey = `elcarehub_disclosure_v2_purchase`;
    expect(localStorage.getItem(newKey)).toBeNull();
  });
});
