// ─────────────────────────────────────────────────────────────
// hooks/useFreshListing.ts
//
// Issue #309 / #44 — Authoritative preflight check
//
// Before allowing the user to submit a sensitive transaction
// (buy, bid, accept offer, cancel), this hook fetches the
// freshest chain state for a listing or auction and compares
// it against what the UI is currently showing.
//
// Usage:
//   const { preflight, isChecking, conflict } = useFreshListing();
//
//   const ok = await preflight(listing);
//   if (!ok) {
//     // conflict contains the updated listing — refresh UI
//   }
//
// The caller must show a stale-data warning and discard the old
// confirmation when a conflict is detected.
// ─────────────────────────────────────────────────────────────

"use client";

import { useState, useCallback } from "react";
import { Listing, getListing } from "@/lib/contract";

// ── Types ─────────────────────────────────────────────────────

export type PreflightConflict =
  | "LISTING_GONE"      // listing no longer exists or is no longer Active
  | "PRICE_CHANGED"     // price changed since we last fetched
  | "TOKEN_CHANGED"     // payment token changed
  | "STATUS_CHANGED";   // status is no longer Active (sold/cancelled)

export interface PreflightResult {
  /** True when the listing still matches the local snapshot */
  ok: boolean;
  conflict?: PreflightConflict;
  /** The fresh listing from chain (populated even when ok=false) */
  freshListing?: Listing;
}

// ── Hook ──────────────────────────────────────────────────────

export function useFreshListing() {
  const [isChecking, setIsChecking] = useState(false);
  const [conflict, setConflict] = useState<PreflightConflict | null>(null);
  const [freshListing, setFreshListing] = useState<Listing | null>(null);

  /**
   * Fetches the latest on-chain listing state and compares it to
   * the snapshot the caller is holding.
   *
   * Returns true when the listing matches and the action is safe.
   * Returns false when a material difference is detected — the caller
   * MUST surface the conflict to the user and require re-confirmation.
   */
  const preflight = useCallback(
    async (snapshot: Listing): Promise<boolean> => {
      setIsChecking(true);
      setConflict(null);
      setFreshListing(null);

      try {
        const fresh = await getListing(snapshot.listing_id);
        setFreshListing(fresh);

        if (!fresh || fresh.status !== "Active") {
          const c: PreflightConflict =
            !fresh ? "LISTING_GONE" : "STATUS_CHANGED";
          setConflict(c);
          return false;
        }

        if (fresh.price !== snapshot.price) {
          setConflict("PRICE_CHANGED");
          return false;
        }

        if (fresh.token !== snapshot.token) {
          setConflict("TOKEN_CHANGED");
          return false;
        }

        return true;
      } catch {
        // If we can't reach the chain/indexer, treat as potentially stale
        setConflict("LISTING_GONE");
        return false;
      } finally {
        setIsChecking(false);
      }
    },
    []
  );

  /** Clears any conflict so the caller can reset confirmation state. */
  const reset = useCallback(() => {
    setConflict(null);
    setFreshListing(null);
  }, []);

  return { preflight, isChecking, conflict, freshListing, reset };
}

// ── Conflict message helper ───────────────────────────────────

/**
 * Returns a user-facing message for a preflight conflict.
 */
export function preflightConflictMessage(conflict: PreflightConflict): string {
  switch (conflict) {
    case "LISTING_GONE":
      return "This listing is no longer available. It may have been sold or cancelled.";
    case "STATUS_CHANGED":
      return "The listing status has changed since you last viewed this page. Please review the updated details.";
    case "PRICE_CHANGED":
      return "The listing price has changed. Please review the new price before confirming.";
    case "TOKEN_CHANGED":
      return "The payment token for this listing has changed. Please review the updated details.";
  }
}
