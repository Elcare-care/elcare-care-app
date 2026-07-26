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
  Offer,
  Listing,
} from "@/lib/contract";
import { getReadableErrorMessage } from "@/lib/errors";
import { useTransientErrorToast } from "./useTransientErrorToast";
import {
  useReconciliation,
  generatePendingId,
  type ConfirmedSnapshot,
} from "./useReconciliation";
import { useTxToast } from "./useTxToast";

// ── useOffererOffers ─────────────────────────────────────────

/**
 * Fetches all offers placed by a user, enriched with listing data.
 */
export interface OffererOffer extends Offer {
  listing?: Listing;
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

      // Enrich each offer with its listing data.
      const enriched: OffererOffer[] = await Promise.all(
        resolved.map(async (offer) => {
          try {
            const listing = await getListing(offer.listing_id);
            return { ...offer, listing };
          } catch {
            return { ...offer };
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

  const withdraw = useCallback(
    async (offerId: number): Promise<boolean> => {
      if (!publicKey) return false;
      const result = await run(
        () => withdrawOffer(publicKey, offerId),
        { action: "Withdraw offer" }
      );
      return result !== null;
    },
    [publicKey, run]
  );

  return { withdraw, isWithdrawing, error: null };
}

// ── useReclaimOffer ──────────────────────────────────────────

export function useReclaimOffer(publicKey: string | null) {
  const { run, isRunning: isReclaiming } = useTxToast();

  const reclaim = useCallback(
    async (offerId: number): Promise<boolean> => {
      if (!publicKey) return false;
      const result = await run(
        () => reclaimOffer(publicKey, offerId),
        { action: "Reclaim offer funds" }
      );
      return result !== null;
    },
    [publicKey, run]
  );

  return { reclaim, isReclaiming, error: null };
}

// ── useAcceptOffer ───────────────────────────────────────────

export function useAcceptOffer(publicKey: string | null) {
  const { run, isRunning: isAccepting } = useTxToast();

  const accept = useCallback(
    async (offerId: number): Promise<boolean> => {
      if (!publicKey) return false;
      const result = await run(
        () => acceptOffer(publicKey, offerId),
        { action: "Accept offer" }
      );
      return result !== null;
    },
    [publicKey, run]
  );

  return { accept, isAccepting, error: null };
}

// ── useRejectOffer ───────────────────────────────────────────

export function useRejectOffer(publicKey: string | null) {
  const { run, isRunning: isRejecting } = useTxToast();

  const reject = useCallback(
    async (offerId: number): Promise<boolean> => {
      if (!publicKey) return false;
      const result = await run(
        () => rejectOffer(publicKey, offerId),
        { action: "Reject offer" }
      );
      return result !== null;
    },
    [publicKey, run]
  );

  return { reject, isRejecting, error: null };
}

// ── useMakeOffer ─────────────────────────────────────────────

export function useMakeOffer(publicKey: string | null) {
  const { run, isRunning: isOffering } = useTxToast();

  const make = useCallback(
    async (listingId: number, amountXlm: number, tokenAddress: string): Promise<boolean> => {
      if (!publicKey) return false;
      const result = await run(
        () => makeOffer(publicKey, listingId, amountXlm, tokenAddress),
        { action: "Offer" }
      );
      return result !== null;
    },
    [publicKey, run]
  );

  return { make, isOffering, error: null };
}


// ── useOffersWithReconciliation (Issue #302) ──────────────────────────────────
//
// Wraps useOffererOffers with provisional state so the UI can display a
// "pending" badge on an offer while its transaction is in-flight, and
// roll back to the confirmed snapshot if the tx fails.

export function useOffersWithReconciliation(publicKey: string | null) {
  const offersHook = useOffererOffers(publicKey);
  const recon = useReconciliation<OffererOffer>({ mutationTtlMs: 60_000 });

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
