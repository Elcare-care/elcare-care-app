// ─────────────────────────────────────────────────────────────
// hooks/useOffers.ts — Offer data + actions hooks
// ─────────────────────────────────────────────────────────────

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  getOffer,
  getOffererOffers,
  getListingOffers,
  getArtistListings,
  getListing,
  withdrawOffer,
  reclaimOffer,
  acceptOffer,
  rejectOffer,
  makeOffer,
  deriveOfferUIStatus,
  Offer,
  Listing,
  OfferUIStatus,
} from "@/lib/contract";
import { getReadableErrorMessage } from "@/lib/errors";
import { config } from "@/lib/config";
import { useTransientErrorToast } from "./useTransientErrorToast";
import {
  useReconciliation,
  generatePendingId,
  type ConfirmedSnapshot,
} from "./useReconciliation";
import { useTxToast } from "./useTxToast";

// ── useFreshOffer ─────────────────────────────────────────────

/**
 * Fetches a fresh copy of a single offer from the contract before
 * a write action is submitted. Returns null when the offer cannot
 * be loaded, which lets callers abort the action early.
 *
 * UI usage: call `fetchFreshOffer(offerId)` immediately before
 * calling withdraw / accept / reject / reclaim. Display the derived
 * UI status to warn the user if the state changed since the last
 * page load (e.g. offer was accepted by someone else).
 */
export function useFreshOffer() {
  const [isFetching, setIsFetching] = useState(false);

  const fetchFreshOffer = useCallback(
    async (offerId: number): Promise<{ offer: Offer; uiStatus: OfferUIStatus } | null> => {
      setIsFetching(true);
      try {
        const offer = await getOffer(offerId);
        const derived = deriveOfferUIStatus(offer, Date.now());
        // Fallback to on-chain status if deriveOfferUIStatus returns undefined
        // (can happen in tests where the function is partially mocked).
        const uiStatus: OfferUIStatus = (derived as OfferUIStatus) ?? offer.status;
        return { offer, uiStatus };
      } catch {
        return null;
      } finally {
        setIsFetching(false);
      }
    },
    []
  );

  return { fetchFreshOffer, isFetching };
}

// ── useOffererOffers ─────────────────────────────────────────

/**
 * Fetches all offers placed by a user, enriched with listing data.
 */
export interface OffererOffer extends Offer {
  listing?: Listing;
  /** Client-derived UI status, computed on load from expires_at vs Date.now(). */
  uiStatus?: OfferUIStatus;
}

export function useOffererOffers(publicKey: string | null) {
  const [offers, setOffers] = useState<OffererOffer[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useTransientErrorToast(error);

  const refresh = useCallback(async () => {
    if (!publicKey) return;
    setIsLoading(true);
    setError(null);
    try {
      const ids = await getOffererOffers(publicKey);
      const resolved = await Promise.all(ids.map((id) => getOffer(id)));

      // Enrich each offer with its listing data and derived UI status.
      const enriched: OffererOffer[] = await Promise.all(
        resolved.map(async (offer) => {
          try {
            const listing = await getListing(offer.listing_id);
            const uiStatus = deriveOfferUIStatus(offer, Date.now());
            return { ...offer, listing, uiStatus };
          } catch {
            const uiStatus = deriveOfferUIStatus(offer, Date.now());
            return { ...offer, uiStatus };
          }
        })
      );

      setOffers(enriched.sort((a, b) => b.created_at - a.created_at));
    } catch (err: unknown) {
      setError(getReadableErrorMessage(err, "Failed to load your offers"));
    } finally {
      setIsLoading(false);
    }
  }, [publicKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { offers, isLoading, error, refresh };
}

// ── useListingOffers ─────────────────────────────────────────

/**
 * Fetches all offers for a specific listing.
 */
export function useListingOffers(listingId: number | null) {
  const [offers, setOffers] = useState<Offer[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useTransientErrorToast(error);

  const refresh = useCallback(async () => {
    if (listingId === null) return;
    setIsLoading(true);
    setError(null);
    try {
      const ids = await getListingOffers(listingId);
      const resolved = await Promise.all(ids.map((id) => getOffer(id)));
      setOffers(resolved.sort((a, b) => b.created_at - a.created_at));
    } catch (err: unknown) {
      setError(getReadableErrorMessage(err, "Failed to load listing offers"));
    } finally {
      setIsLoading(false);
    }
  }, [listingId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { offers, isLoading, error, refresh };
}

// ── useIncomingOffers ────────────────────────────────────────

/**
 * Fetches offers on all listings owned by the user.
 * Gets the artist's listings, then for each active listing, fetches its offers.
 */
export function useIncomingOffers(ownerPublicKey: string | null) {
  const [offersByListing, setOffersByListing] = useState<
    Array<{ listing: Listing; offers: Offer[] }>
  >([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useTransientErrorToast(error);

  const refresh = useCallback(async () => {
    if (!ownerPublicKey) return;
    setIsLoading(true);
    setError(null);
    try {
      const listingIds = await getArtistListings(ownerPublicKey);
      const listings = await Promise.all(
        listingIds.map((id) => getListing(id))
      );

      const result: Array<{ listing: Listing; offers: Offer[] }> = [];

      // Only fetch offers for active listings.
      const activeListings = listings.filter((l) => l.status === "Active");

      await Promise.all(
        activeListings.map(async (listing) => {
          try {
            const offerIds = await getListingOffers(listing.listing_id);
            const offers = await Promise.all(
              offerIds.map((id) => getOffer(id))
            );
            result.push({
              listing,
              offers: offers.sort((a, b) => b.created_at - a.created_at),
            });
          } catch {
            // Skip listings whose offers fail to load.
          }
        })
      );

      setOffersByListing(result);
    } catch (err: unknown) {
      setError(getReadableErrorMessage(err, "Failed to load incoming offers"));
    } finally {
      setIsLoading(false);
    }
  }, [ownerPublicKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { offersByListing, isLoading, error, refresh };
}

// ── useWithdrawOffer ─────────────────────────────────────────

export function useWithdrawOffer(publicKey: string | null) {
  const { run, isRunning: isWithdrawing } = useTxToast();
  const { fetchFreshOffer } = useFreshOffer();
  const [error, setError] = useState<string | null>(null);
  useTransientErrorToast(error);

  const withdraw = useCallback(
    async (offerId: number): Promise<boolean> => {
      if (!publicKey) return false;
      setError(null);

      // Preflight: fetch fresh state before submitting. Abort if the offer is
      // no longer withdrawable (already accepted, rejected, or expired).
      const fresh = await fetchFreshOffer(offerId);
      if (fresh && fresh.uiStatus !== "Pending" && fresh.uiStatus !== "Stale") {
        return false;
      }

      let capturedError: unknown = null;
      const result = await run(
        async () => {
          try {
            return await withdrawOffer(publicKey, offerId);
          } catch (err) {
            capturedError = err;
            throw err;
          }
        },
        {
          action: "Withdrawing offer",
          successMessage: () => "Offer withdrawn successfully",
        }
      );
      if (result === null) {
        setError(getReadableErrorMessage(capturedError, "Failed to withdraw offer"));
        return false;
      }
      return true;
    },
    [publicKey, run, fetchFreshOffer]
  );

  return { withdraw, isWithdrawing, error };
}

// ── useReclaimOffer ──────────────────────────────────────────

export function useReclaimOffer(publicKey: string | null) {
  const { run, isRunning: isReclaiming } = useTxToast();
  const { fetchFreshOffer } = useFreshOffer();
  const [error, setError] = useState<string | null>(null);
  useTransientErrorToast(error);

  const reclaim = useCallback(
    async (offerId: number): Promise<boolean> => {
      if (!publicKey) return false;
      setError(null);

      // Preflight: only Expired offers can be reclaimed.
      const fresh = await fetchFreshOffer(offerId);
      if (fresh && fresh.uiStatus !== "Expired") {
        return false;
      }

      let capturedError: unknown = null;
      const result = await run(
        async () => {
          try {
            return await reclaimOffer(publicKey, offerId);
          } catch (err) {
            capturedError = err;
            throw err;
          }
        },
        {
          action: "Reclaiming offer funds",
          successMessage: () => "Offer funds reclaimed successfully",
        }
      );
      if (result === null) {
        setError(getReadableErrorMessage(capturedError, "Failed to reclaim offer funds"));
        return false;
      }
      return true;
    },
    [publicKey, run, fetchFreshOffer]
  );

  return { reclaim, isReclaiming, error };
}

// ── useAcceptOffer ───────────────────────────────────────────

export function useAcceptOffer(publicKey: string | null) {
  const { run, isRunning: isAccepting } = useTxToast();
  const { fetchFreshOffer } = useFreshOffer();
  const [error, setError] = useState<string | null>(null);
  useTransientErrorToast(error);

  const accept = useCallback(
    async (offerId: number): Promise<boolean> => {
      if (!publicKey) return false;
      setError(null);

      // Preflight: fetch a fresh offer snapshot before accepting.
      // Abort if the offer is no longer in an actionable state (e.g. already
      // withdrawn by the offerer since the last page load).
      const fresh = await fetchFreshOffer(offerId);
      if (fresh && fresh.uiStatus !== "Pending" && fresh.uiStatus !== "Stale") {
        return false;
      }

      let capturedError: unknown = null;
      const result = await run(
        async () => {
          try {
            return await acceptOffer(publicKey, offerId);
          } catch (err) {
            capturedError = err;
            throw err;
          }
        },
        {
          action: "Accepting offer",
          successMessage: () => "Offer accepted successfully",
        }
      );
      if (result === null) {
        setError(getReadableErrorMessage(capturedError, "Failed to accept offer"));
        return false;
      }
      return true;
    },
    [publicKey, run, fetchFreshOffer]
  );

  return { accept, isAccepting, error };
}

// ── useRejectOffer ───────────────────────────────────────────

export function useRejectOffer(publicKey: string | null) {
  const { run, isRunning: isRejecting } = useTxToast();
  const { fetchFreshOffer } = useFreshOffer();
  const [error, setError] = useState<string | null>(null);
  useTransientErrorToast(error);

  const reject = useCallback(
    async (offerId: number): Promise<boolean> => {
      if (!publicKey) return false;
      setError(null);

      // Preflight: abort if the offer is no longer in a rejectable state.
      const fresh = await fetchFreshOffer(offerId);
      if (fresh && fresh.uiStatus !== "Pending" && fresh.uiStatus !== "Stale") {
        return false;
      }

      let capturedError: unknown = null;
      const result = await run(
        async () => {
          try {
            return await rejectOffer(publicKey, offerId);
          } catch (err) {
            capturedError = err;
            throw err;
          }
        },
        {
          action: "Rejecting offer",
          successMessage: () => "Offer rejected successfully",
        }
      );
      if (result === null) {
        setError(getReadableErrorMessage(capturedError, "Failed to reject offer"));
        return false;
      }
      return true;
    },
    [publicKey, run, fetchFreshOffer]
  );

  return { reject, isRejecting, error };
}

// ── useMakeOffer ─────────────────────────────────────────────

export function useMakeOffer(publicKey: string | null) {
  const { run, isRunning: isOffering } = useTxToast();
  const [error, setError] = useState<string | null>(null);
  useTransientErrorToast(error);

  const make = useCallback(
    async (listingId: number, amountXlm: number, tokenAddress: string): Promise<boolean> => {
      if (!publicKey) return false;
      setError(null);
      let capturedError: unknown = null;
      const result = await run(
        async () => {
          try {
            return await makeOffer(publicKey, listingId, amountXlm, tokenAddress);
          } catch (err) {
            capturedError = err;
            throw err;
          }
        },
        {
          action: "Placing offer",
          successMessage: () => "Offer placed successfully",
        }
      );
      if (result === null) {
        setError(getReadableErrorMessage(capturedError, "Failed to place offer"));
        return false;
      }
      return true;
    },
    [publicKey, run]
  );

  return { make, isOffering, error };
}


// ── useOffersWithReconciliation (Issue #302) ──────────────────────────────────
//
// Wraps useOffererOffers with provisional state so the UI can display a
// "pending" badge on an offer while its transaction is in-flight, and
// roll back to the confirmed snapshot if the tx fails.

export function useOffersWithReconciliation(publicKey: string | null) {
  const offersHook = useOffererOffers(publicKey);
  const offersRefreshRef = useRef(offersHook.refresh);
  offersRefreshRef.current = offersHook.refresh;

  const recon = useReconciliation<OffererOffer>({
    mutationTtlMs: 60_000,
    // Issue #520: a chain reorg invalidates any provisional offer state —
    // reset and re-fetch confirmed truth instead of leaving stale entities.
    reorgIndexerUrl: config.indexerUrl || null,
    onReorgReset: () => offersRefreshRef.current(),
  });

  const prevRef = useRef<OffererOffer[]>([]);
  useEffect(() => {
    if (offersHook.offers === prevRef.current) return;
    prevRef.current = offersHook.offers;

    const snapshots: ConfirmedSnapshot<OffererOffer>[] = offersHook.offers.map((o) => ({
      resourceId: String(o.offer_id),
      data: o,
      ledger: (o as any).updatedAtLedger ?? 0,
    }));
    recon.applyConfirmedData(snapshots);
  }, [offersHook.offers]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Tag an offer mutation as pending immediately after tx submission.
   * Returns a pendingId that can be used to resolve or reject later.
   */
  const addOfferMutation = useCallback(
    (
      action: "make" | "withdraw" | "accept" | "reject" | "reclaim",
      offer: OffererOffer,
      txHash: string | null = null
    ): string => {
      const pendingId = generatePendingId(`offer-${action}`);
      recon.addMutation({
        pendingId,
        txHash,
        kind: "offer",
        resourceId: String(offer.offer_id),
        optimisticValue: offer,
      });
      return pendingId;
    },
    [recon]
  );

  const getOfferState = useCallback(
    (offerId: string | number) =>
      recon.getResourceState(String(offerId), "offer"),
    [recon]
  );

  return {
    ...offersHook,
    pendingMutations: recon.pendingMutations,
    addOfferMutation,
    getOfferState,
    resolveMutation: recon.resolveMutation,
    rejectMutation: recon.rejectMutation,
  };
}

// ── useIncomingOffersWithReconciliation (Issue #528) ──────────────────────────
//
// Same optimistic-transition-with-rollback pattern as
// useOffersWithReconciliation, applied to the listing-centric inbox so
// accept/reject can update the UI immediately and roll back on failure.

export function useIncomingOffersWithReconciliation(ownerPublicKey: string | null) {
  const incomingHook = useIncomingOffers(ownerPublicKey);
  const recon = useReconciliation<Offer>({ mutationTtlMs: 60_000 });

  const prevRef = useRef(incomingHook.offersByListing);
  useEffect(() => {
    if (incomingHook.offersByListing === prevRef.current) return;
    prevRef.current = incomingHook.offersByListing;

    const snapshots: ConfirmedSnapshot<Offer>[] = incomingHook.offersByListing.flatMap((group) =>
      group.offers.map((o) => ({
        resourceId: String(o.offer_id),
        data: o,
        ledger: (o as any).updatedAtLedger ?? 0,
      }))
    );
    recon.applyConfirmedData(snapshots);
  }, [incomingHook.offersByListing]); // eslint-disable-line react-hooks/exhaustive-deps

  const addOfferMutation = useCallback(
    (action: "accept" | "reject", offer: Offer, txHash: string | null = null): string => {
      const pendingId = generatePendingId(`offer-${action}`);
      recon.addMutation({
        pendingId,
        txHash,
        kind: "offer",
        resourceId: String(offer.offer_id),
        optimisticValue: offer,
      });
      return pendingId;
    },
    [recon]
  );

  const getOfferState = useCallback(
    (offerId: string | number) => recon.getResourceState(String(offerId), "offer"),
    [recon]
  );

  return {
    ...incomingHook,
    pendingMutations: recon.pendingMutations,
    addOfferMutation,
    getOfferState,
    resolveMutation: recon.resolveMutation,
    rejectMutation: recon.rejectMutation,
  };
}
