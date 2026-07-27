/**
 * offerStates.test.ts
 *
 * Unit tests for:
 *  - deriveOfferUIStatus  (contract.ts)
 *  - isOfferActionable    (contract.ts)
 *  - All seven UI states: Pending, Active (Stale), Expired, Accepted,
 *    Rejected, Withdrawn, Stale
 *
 * No React rendering required — pure function tests.
 */

import { deriveOfferUIStatus, isOfferActionable } from "@/lib/contract";
import type { Offer, OfferUIStatus } from "@/lib/contract";

// ── Helpers ───────────────────────────────────────────────────────────────────

const NOW_MS = 1_700_000_000_000; // fixed reference instant

function baseOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    offer_id: 1,
    listing_id: 10,
    offerer: "GOFFERER",
    amount: 5_000_000n,
    token: "CTOKEN",
    status: "Pending",
    created_at: 1_699_000_000,
    ...overrides,
  };
}

// ── deriveOfferUIStatus ───────────────────────────────────────────────────────

describe("deriveOfferUIStatus", () => {
  // ── Active Pending (expires_at in the future) ────────────────────────────
  it('returns "Pending" for a fresh pending offer with no expiry', () => {
    const offer = baseOffer({ status: "Pending" });
    expect(deriveOfferUIStatus(offer, NOW_MS)).toBe("Pending");
  });

  it('returns "Pending" for a pending offer whose expiry is in the future', () => {
    const futureExpiry = Math.floor(NOW_MS / 1000) + 3600; // +1 h
    const offer = baseOffer({ status: "Pending", expires_at: futureExpiry });
    expect(deriveOfferUIStatus(offer, NOW_MS)).toBe("Pending");
  });

  // ── Expired ──────────────────────────────────────────────────────────────
  it('returns "Expired" for a pending offer whose expiry is exactly now', () => {
    const expiry = Math.floor(NOW_MS / 1000);
    const offer = baseOffer({ status: "Pending", expires_at: expiry });
    expect(deriveOfferUIStatus(offer, NOW_MS)).toBe("Expired");
  });

  it('returns "Expired" for a pending offer whose expiry is in the past', () => {
    const pastExpiry = Math.floor(NOW_MS / 1000) - 1;
    const offer = baseOffer({ status: "Pending", expires_at: pastExpiry });
    expect(deriveOfferUIStatus(offer, NOW_MS)).toBe("Expired");
  });

  // ── Stale ────────────────────────────────────────────────────────────────
  it('returns "Stale" for a pending offer when isStale=true (no expiry)', () => {
    const offer = baseOffer({ status: "Pending" });
    expect(deriveOfferUIStatus(offer, NOW_MS, true)).toBe("Stale");
  });

  it('still returns "Expired" (not "Stale") when offer is both expired and stale', () => {
    // Expired wins because the UI must offer reclaim, not just a soft warning.
    const pastExpiry = Math.floor(NOW_MS / 1000) - 60;
    const offer = baseOffer({ status: "Pending", expires_at: pastExpiry });
    // Expired check runs before the stale check inside the function.
    expect(deriveOfferUIStatus(offer, NOW_MS, true)).toBe("Expired");
  });

  it('does NOT mark a non-Pending offer as Stale', () => {
    const offer = baseOffer({ status: "Accepted" });
    // Stale flag only applies to Pending offers per the spec.
    expect(deriveOfferUIStatus(offer, NOW_MS, true)).toBe("Accepted");
  });

  // ── Terminal on-chain states ─────────────────────────────────────────────
  it('passes through "Accepted" unchanged', () => {
    const offer = baseOffer({ status: "Accepted" });
    expect(deriveOfferUIStatus(offer, NOW_MS)).toBe("Accepted");
  });

  it('passes through "Rejected" unchanged', () => {
    const offer = baseOffer({ status: "Rejected" });
    expect(deriveOfferUIStatus(offer, NOW_MS)).toBe("Rejected");
  });

  it('passes through "Withdrawn" unchanged', () => {
    const offer = baseOffer({ status: "Withdrawn" });
    expect(deriveOfferUIStatus(offer, NOW_MS)).toBe("Withdrawn");
  });

  // ── Edge cases ───────────────────────────────────────────────────────────
  it('uses Date.now() when nowMs is not provided', () => {
    const offer = baseOffer({ status: "Pending" });
    // Should not throw and return a valid OfferUIStatus
    const result = deriveOfferUIStatus(offer);
    expect(["Pending", "Expired", "Stale"]).toContain(result);
  });

  it('handles an accepted offer with a past expires_at without calling it expired', () => {
    // Once accepted on-chain, the status is "Accepted" regardless of expires_at.
    const pastExpiry = Math.floor(NOW_MS / 1000) - 1;
    const offer = baseOffer({ status: "Accepted", expires_at: pastExpiry });
    expect(deriveOfferUIStatus(offer, NOW_MS)).toBe("Accepted");
  });
});

// ── isOfferActionable ─────────────────────────────────────────────────────────

describe("isOfferActionable", () => {
  const actionable: OfferUIStatus[] = ["Pending", "Stale"];
  const notActionable: OfferUIStatus[] = ["Accepted", "Rejected", "Withdrawn", "Expired"];

  for (const s of actionable) {
    it(`returns true for "${s}"`, () => {
      expect(isOfferActionable(s)).toBe(true);
    });
  }

  for (const s of notActionable) {
    it(`returns false for "${s}"`, () => {
      expect(isOfferActionable(s)).toBe(false);
    });
  }
});

// ── Status transition table ───────────────────────────────────────────────────
// Verify all seven documented UI states produce correct actionability.

describe("offer state machine — action gate", () => {
  const cases: Array<[string, Partial<Offer>, boolean, boolean, OfferUIStatus]> = [
    // label, overrides, isStale, hasExpiry+past, expectedUI, expectedActionable
    ["active pending — no expiry",    { status: "Pending" },                               false, false, "Pending"],
    ["active pending — future expiry",{ status: "Pending", expires_at: Math.floor(NOW_MS / 1000) + 3600 }, false, false, "Pending"],
    ["stale pending",                 { status: "Pending" },                               true,  false, "Stale"],
    ["expired pending",               { status: "Pending", expires_at: Math.floor(NOW_MS / 1000) - 1 }, false, true, "Expired"],
    ["accepted",                      { status: "Accepted" },                              false, false, "Accepted"],
    ["rejected",                      { status: "Rejected" },                              false, false, "Rejected"],
    ["withdrawn",                     { status: "Withdrawn" },                             false, false, "Withdrawn"],
  ];

  // Rebuild the expected table with correct OfferUIStatus values
  const transitions: Array<[string, OfferUIStatus, boolean]> = [
    ["active pending — no expiry",     "Pending",  true],
    ["active pending — future expiry", "Pending",  true],
    ["stale pending",                  "Stale",    true],
    ["expired pending",                "Expired",  false],
    ["accepted",                       "Accepted", false],
    ["rejected",                       "Rejected", false],
    ["withdrawn",                      "Withdrawn",false],
  ];

  for (const [label, expectedUI, expectedActionable] of transitions) {
    it(`[${label}] → UIStatus="${expectedUI}", actionable=${expectedActionable}`, () => {
      // Derive the offer used in the cases table above by matching label
      const caseRow = cases.find((c) => c[0] === label);
      if (!caseRow) throw new Error(`Case not found: ${label}`);
      const [, overrides, isStale] = caseRow;
      const offer = baseOffer(overrides);
      const uiStatus = deriveOfferUIStatus(offer, NOW_MS, isStale);
      expect(uiStatus).toBe(expectedUI);
      expect(isOfferActionable(uiStatus)).toBe(expectedActionable);
    });
  }
});
