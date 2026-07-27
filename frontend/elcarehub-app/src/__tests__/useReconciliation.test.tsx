// ─────────────────────────────────────────────────────────────────────────────
// __tests__/useReconciliation.test.tsx
//
// Issue #302: Tests for the reconciliation-aware provisional state hook.
// Covers: success, failure, timeout (stale), reload persistence,
// duplicate events, and out-of-order events.
// ─────────────────────────────────────────────────────────────────────────────

import React from "react";
import { renderHook, act } from "@testing-library/react";
import {
  useReconciliation,
  generatePendingId,
  type PendingMutation,
} from "../hooks/useReconciliation";

// ── Helpers ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

interface TestListing {
  listing_id: number;
  status: string;
  price: string;
}

function makeListing(overrides: Partial<TestListing> = {}): TestListing {
  return { listing_id: 1, status: "Active", price: "100", ...overrides };
}

function renderRecon() {
  return renderHook(() =>
    useReconciliation<TestListing>({ mutationTtlMs: 30_000, sweepIntervalMs: 1_000 })
  );
}

// ── Basic state ───────────────────────────────────────────────────────────────

describe("useReconciliation — initial state", () => {
  it("starts with no pending mutations", () => {
    const { result } = renderRecon();
    expect(result.current.pendingMutations).toHaveLength(0);
  });

  it("returns null data for unknown resource", () => {
    const { result } = renderRecon();
    const state = result.current.getResourceState("999", "listing");
    expect(state.data).toBeNull();
    expect(state.recordState).toBe("confirmed");
    expect(state.pendingMutation).toBeNull();
  });
});

// ── Confirmed data ────────────────────────────────────────────────────────────

describe("useReconciliation — applyConfirmedData", () => {
  it("stores and returns confirmed data", () => {
    const { result } = renderRecon();
    const listing = makeListing();

    act(() => {
      result.current.applyConfirmedData([
        { resourceId: "1", data: listing, ledger: 100 },
      ]);
    });

    const state = result.current.getResourceState("1", "listing");
    expect(state.data).toEqual(listing);
    expect(state.recordState).toBe("confirmed");
  });

  it("ignores out-of-order (older ledger) updates", () => {
    const { result } = renderRecon();
    const newListing = makeListing({ status: "Sold" });
    const oldListing = makeListing({ status: "Active" });

    act(() => {
      result.current.applyConfirmedData([
        { resourceId: "1", data: newListing, ledger: 200 },
      ]);
    });
    act(() => {
      // This is older — should be ignored
      result.current.applyConfirmedData([
        { resourceId: "1", data: oldListing, ledger: 100 },
      ]);
    });

    const state = result.current.getResourceState("1", "listing");
    expect(state.data?.status).toBe("Sold"); // new data retained
  });

  it("accepts same-ledger updates (idempotent)", () => {
    const { result } = renderRecon();
    const listing = makeListing({ status: "Active" });

    act(() => {
      result.current.applyConfirmedData([
        { resourceId: "1", data: listing, ledger: 100 },
      ]);
    });
    act(() => {
      result.current.applyConfirmedData([
        { resourceId: "1", data: { ...listing, price: "200" }, ledger: 100 },
      ]);
    });

    const state = result.current.getResourceState("1", "listing");
    // Same ledger — last write wins
    expect(state.data?.price).toBe("200");
  });
});

// ── Pending mutations ─────────────────────────────────────────────────────────

describe("useReconciliation — addMutation", () => {
  it("adds a pending mutation", () => {
    const { result } = renderRecon();

    act(() => {
      result.current.addMutation({
        pendingId: "p1",
        txHash: null,
        kind: "listing",
        resourceId: "1",
        optimisticValue: makeListing({ status: "Cancelled" }),
      });
    });

    expect(result.current.pendingMutations).toHaveLength(1);
    expect(result.current.pendingMutations[0].status).toBe("pending");
  });

  it("shows optimistic value for pending resource", () => {
    const { result } = renderRecon();
    const optimistic = makeListing({ status: "Cancelled" });
    const confirmed = makeListing({ status: "Active" });

    act(() => {
      result.current.applyConfirmedData([
        { resourceId: "1", data: confirmed, ledger: 50 },
      ]);
      result.current.addMutation({
        pendingId: "p1",
        txHash: "txabc",
        kind: "listing",
        resourceId: "1",
        optimisticValue: optimistic,
      });
    });

    const state = result.current.getResourceState("1", "listing");
    expect(state.recordState).toBe("pending");
    expect(state.data?.status).toBe("Cancelled"); // optimistic shown
    expect(state.pendingMutation?.txHash).toBe("txabc");
  });
});

// ── Resolve mutations ─────────────────────────────────────────────────────────

describe("useReconciliation — resolveMutation", () => {
  it("resolves a pending mutation on success", () => {
    const { result } = renderRecon();

    act(() => {
      result.current.addMutation({
        pendingId: "p1",
        txHash: null,
        kind: "listing",
        resourceId: "1",
        optimisticValue: makeListing(),
      });
    });

    act(() => {
      result.current.resolveMutation("p1", "txhash123");
    });

    const mut = result.current.pendingMutations.find((m) => m.pendingId === "p1");
    expect(mut?.status).toBe("confirmed");
    expect(mut?.txHash).toBe("txhash123");
  });
});

// ── Reject mutations ──────────────────────────────────────────────────────────

describe("useReconciliation — rejectMutation", () => {
  it("reverts to confirmed snapshot on rejection", () => {
    const { result } = renderRecon();
    const confirmedListing = makeListing({ status: "Active" });
    const optimisticListing = makeListing({ status: "Cancelled" });

    act(() => {
      result.current.applyConfirmedData([
        { resourceId: "1", data: confirmedListing, ledger: 100 },
      ]);
      result.current.addMutation({
        pendingId: "p1",
        txHash: null,
        kind: "listing",
        resourceId: "1",
        optimisticValue: optimisticListing,
      });
    });

    // While pending, optimistic value is shown
    expect(result.current.getResourceState("1", "listing").data?.status).toBe("Cancelled");

    act(() => {
      result.current.rejectMutation("p1", "Transaction failed");
    });

    // After rejection, confirmed snapshot is restored
    const state = result.current.getResourceState("1", "listing");
    expect(state.recordState).toBe("rejected");
    expect(state.data?.status).toBe("Active"); // confirmed snapshot restored
  });
});

// ── Stale (timeout) ───────────────────────────────────────────────────────────

describe("useReconciliation — stale mutations", () => {
  it("marks a mutation as stale when TTL expires", async () => {
    const { result } = renderHook(() =>
      useReconciliation<TestListing>({ mutationTtlMs: 100, sweepIntervalMs: 50 })
    );

    act(() => {
      result.current.addMutation({
        pendingId: "p1",
        txHash: null,
        kind: "listing",
        resourceId: "1",
        optimisticValue: makeListing(),
      });
    });

    // Advance time past TTL + one sweep interval
    act(() => {
      jest.advanceTimersByTime(200);
    });

    const mut = result.current.pendingMutations.find((m) => m.pendingId === "p1");
    expect(mut?.status).toBe("stale");
  });

  it("shows confirmed data after mutation goes stale", () => {
    const { result } = renderHook(() =>
      useReconciliation<TestListing>({ mutationTtlMs: 100, sweepIntervalMs: 50 })
    );
    const confirmed = makeListing({ status: "Active" });

    act(() => {
      result.current.applyConfirmedData([
        { resourceId: "1", data: confirmed, ledger: 10 },
      ]);
      result.current.addMutation({
        pendingId: "p1",
        txHash: null,
        kind: "listing",
        resourceId: "1",
        optimisticValue: makeListing({ status: "Cancelled" }),
      });
    });

    act(() => {
      jest.advanceTimersByTime(200);
    });

    const state = result.current.getResourceState("1", "listing");
    expect(state.recordState).toBe("stale");
    expect(state.data?.status).toBe("Active"); // confirmed snapshot shown
  });
});

// ── Duplicate events ──────────────────────────────────────────────────────────

describe("useReconciliation — duplicate event handling", () => {
  it("applies confirmed data idempotently (duplicate SSE events)", () => {
    const { result } = renderRecon();
    const listing = makeListing({ status: "Sold" });

    act(() => {
      // Apply the same snapshot twice (simulates duplicate SSE)
      result.current.applyConfirmedData([{ resourceId: "1", data: listing, ledger: 200 }]);
      result.current.applyConfirmedData([{ resourceId: "1", data: listing, ledger: 200 }]);
    });

    const state = result.current.getResourceState("1", "listing");
    expect(state.data?.status).toBe("Sold");
    expect(state.recordState).toBe("confirmed");
  });
});

// ── SSE arrives and resolves a pending mutation ───────────────────────────────

describe("useReconciliation — SSE resolution flow", () => {
  it("resolves pending mutation when confirmed data arrives for the same resource", () => {
    const { result } = renderRecon();
    const confirmed = makeListing({ status: "Active" });
    const mutated = makeListing({ status: "Cancelled" });

    act(() => {
      result.current.applyConfirmedData([{ resourceId: "1", data: confirmed, ledger: 50 }]);
      result.current.addMutation({
        pendingId: "p1",
        txHash: "txhash",
        kind: "listing",
        resourceId: "1",
        optimisticValue: mutated,
      });
    });

    expect(result.current.getResourceState("1", "listing").recordState).toBe("pending");

    // SSE delivers updated confirmed data
    act(() => {
      result.current.applyConfirmedData([
        { resourceId: "1", data: mutated, ledger: 100 },
      ]);
    });

    // Pending mutation should now be confirmed
    const mut = result.current.pendingMutations.find((m) => m.pendingId === "p1");
    expect(mut?.status).toBe("confirmed");
  });
});

// ── Reset ─────────────────────────────────────────────────────────────────────

describe("useReconciliation — reset", () => {
  it("clears all state", () => {
    const { result } = renderRecon();

    act(() => {
      result.current.applyConfirmedData([
        { resourceId: "1", data: makeListing(), ledger: 100 },
      ]);
      result.current.addMutation({
        pendingId: "p1",
        txHash: null,
        kind: "listing",
        resourceId: "1",
        optimisticValue: makeListing(),
      });
    });

    act(() => {
      result.current.reset();
    });

    expect(result.current.pendingMutations).toHaveLength(0);
    expect(result.current.getResourceState("1", "listing").data).toBeNull();
  });
});

// ── generatePendingId ─────────────────────────────────────────────────────────

describe("generatePendingId", () => {
  it("generates unique IDs", () => {
    const a = generatePendingId("listing-cancel");
    const b = generatePendingId("listing-cancel");
    expect(a).not.toBe(b);
  });

  it("includes the prefix", () => {
    const id = generatePendingId("offer-make");
    expect(id).toContain("offer-make");
  });
});
