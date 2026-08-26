// ─────────────────────────────────────────────────────────────
// hooks/useAuctions.ts — Auction data + actions hooks
// ─────────────────────────────────────────────────────────────

"use client";

import { useState, useEffect, useCallback } from "react";
import {
  getAllAuctions,
  getAuction,
  getArtistAuctions,
  createAuction,
  placeBid,
  finalizeAuction,
  cancelAuction,
  refundLosingBid,
  Auction,
} from "@/lib/contract";
import { fetchAuctions } from "@/lib/indexer";
import { getReadableErrorMessage } from "@/lib/errors";
import { useTransientErrorToast } from "./useTransientErrorToast";
import { useTxToast } from "./useTxToast";
import { assertSupportedTokenAddress } from "@/lib/token-support";
import { DEFAULT_TOKEN } from "@/config/tokens";
import {
  useReconciliation,
  generatePendingId,
  type ConfirmedSnapshot,
} from "./useReconciliation";

// ── useAuctions ──────────────────────────────────────────────

/**
 * Fetches all auctions — prefers the indexer, falls back to on-chain.
 */
export function useAuctions() {
  const [auctions, setAuctions] = useState<Auction[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useTransientErrorToast(error);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      try {
        const raw = await fetchAuctions();
        if (raw.length >= 0) {
          setAuctions(raw as Auction[]);
          return;
        }
      } catch {
        // Indexer unreachable — fall through to on-chain
      }
      const all = await getAllAuctions();
      setAuctions(all);
    } catch (err: unknown) {
      setError(getReadableErrorMessage(err, "Failed to load auctions"));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { auctions, isLoading, error, refresh };
}

// ── useArtistAuctions ────────────────────────────────────────

/**
 * Fetches all auctions created by a specific artist.
 */
export function useArtistAuctions(artistPublicKey: string | null) {
  const [auctions, setAuctions] = useState<Auction[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useTransientErrorToast(error);

  const refresh = useCallback(async () => {
    if (!artistPublicKey) return;
    setIsLoading(true);
    setError(null);
    try {
      try {
        const raw = await fetchAuctions({ creator: artistPublicKey });
        if (raw && raw.length >= 0) {
          setAuctions(raw as Auction[]);
          return;
        }
      } catch (e) {
        console.warn("[indexer] useArtistAuctions fallback:", e);
      }

      const ids = await getArtistAuctions(artistPublicKey);
      const resolved = await Promise.all(ids.map((id) => getAuction(id)));
      setAuctions(resolved);
    } catch (err: unknown) {
      setError(getReadableErrorMessage(err, "Failed to load artist auctions"));
    } finally {
      setIsLoading(false);
    }
  }, [artistPublicKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { auctions, isLoading, error, refresh };
}

// ── useCreateAuction ─────────────────────────────────────────
//
// Auction creation escrows an NFT the creator already owns — mirrors
// useCreateListing in useMarketplace.ts. Recipients, reserve price and
// duration map 1:1 onto the contract's create_auction bounds (Issue #527).

export interface CreateAuctionInput {
  /** Address of the NFT collection contract the token belongs to. */
  collectionAddress: string;
  /** Token ID within the collection. */
  nftTokenId: number;
  /** Reserve price in the selected token's display units (e.g. XLM). */
  reservePriceXlm: number;
  /** Auction duration in seconds — contract minimum is 1 hour. */
  durationSeconds: number;
  /** Royalty split recipients — defaults to 100% creator when omitted. */
  recipients?: Array<{ address: string; percentage: number }>;
  tokenAddress?: string;
}

export function useCreateAuction(creatorPublicKey: string | null) {
  const [isCreating, setIsCreating] = useState(false);
  const [progress, setProgress] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  useTransientErrorToast(error);
  const { run } = useTxToast();

  const create = useCallback(
    async (input: CreateAuctionInput): Promise<number | null> => {
      if (!creatorPublicKey) {
        setError("Wallet not connected");
        return null;
      }

      setIsCreating(true);
      setError(null);

      try {
        setProgress("Validating payment token…");
        const token = await assertSupportedTokenAddress(
          input.tokenAddress ?? DEFAULT_TOKEN.address,
          "auction"
        );

        setProgress("Creating on-chain auction…");
        const auctionId = await run(
          () =>
            createAuction(
              creatorPublicKey,
              input.collectionAddress,
              input.nftTokenId,
              input.reservePriceXlm,
              input.durationSeconds,
              input.recipients ?? [],
              token.address
            ),
          { action: "Auction" }
        );

        if (auctionId === null) return null;

        setProgress("Auction created successfully!");
        return auctionId;
      } catch (err: unknown) {
        setError(getReadableErrorMessage(err, "Failed to create auction"));
        return null;
      } finally {
        setIsCreating(false);
      }
    },
    [creatorPublicKey, run]
  );

  return { create, isCreating, progress, error };
}

// ── useEditAuctionBeforeFirstBid ─────────────────────────────
//
// The marketplace contract has no `update_auction` entry point — reserve
// price, duration, asset, and recipients are immutable for the lifetime of
// an auction once created. The only way to change them is to cancel (which
// the contract only permits while `highest_bid == 0`, i.e. before any bid
// has landed) and recreate with the new values. This hook wraps that
// two-step flow as a single "edit" action so the UI can present it as one
// operation; callers MUST also gate the edit affordance on
// `auction.highest_bid === 0n` so users never attempt this once a bid has
// escrowed real funds (the contract would reject the cancel with
// `AuctionHasBids` and leave the original auction untouched).

export function useEditAuctionBeforeFirstBid(creatorPublicKey: string | null) {
  const [isSaving, setIsSaving] = useState(false);
  const [progress, setProgress] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  useTransientErrorToast(error);
  const { run } = useTxToast();

  const save = useCallback(
    async (
      auction: Auction,
      input: CreateAuctionInput
    ): Promise<number | null> => {
      if (!creatorPublicKey) {
        setError("Wallet not connected");
        return null;
      }
      if (auction.highest_bid > 0n) {
        setError(
          "This auction already has a bid — reserve price, duration, asset, and recipients are now immutable."
        );
        return null;
      }

      setIsSaving(true);
      setError(null);
      try {
        setProgress("Cancelling previous configuration…");
        const cancelled = await run(
          () => cancelAuction(creatorPublicKey, auction.auction_id),
          { action: "Cancel auction" }
        );
        if (cancelled === null) return null;

        setProgress("Validating payment token…");
        const token = await assertSupportedTokenAddress(
          input.tokenAddress ?? DEFAULT_TOKEN.address,
          "auction"
        );

        setProgress("Recreating auction with updated settings…");
        const newAuctionId = await run(
          () =>
            createAuction(
              creatorPublicKey,
              input.collectionAddress,
              input.nftTokenId,
              input.reservePriceXlm,
              input.durationSeconds,
              input.recipients ?? [],
              token.address
            ),
          { action: "Auction" }
        );
        if (newAuctionId === null) return null;

        setProgress("Auction updated successfully!");
        return newAuctionId;
      } catch (err: unknown) {
        setError(getReadableErrorMessage(err, "Failed to update auction"));
        return null;
      } finally {
        setIsSaving(false);
      }
    },
    [creatorPublicKey, run]
  );

  return { save, isSaving, progress, error };
}

// ── useFinalizeAuction ───────────────────────────────────────

export function useFinalizeAuction(callerPublicKey: string | null) {
  const { run, isRunning: isFinalizing } = useTxToast();

  const finalize = useCallback(
    async (auctionId: number): Promise<boolean> => {
      if (!callerPublicKey) return false;
      const result = await run(
        () => finalizeAuction(callerPublicKey, auctionId),
        { action: "Finalize auction" }
      );
      return result !== null;
    },
    [callerPublicKey, run]
  );

  return { finalize, isFinalizing, error: null };
}

// ── useCancelAuction ─────────────────────────────────────────
//
// Only valid while the auction is Active and has zero bids — the contract
// rejects with AuctionHasBids otherwise. Callers should hide/disable the
// triggering control once `auction.highest_bid > 0n`.

export function useCancelAuction(creatorPublicKey: string | null) {
  const { run, isRunning: isCancelling } = useTxToast();

  const cancel = useCallback(
    async (auctionId: number): Promise<boolean> => {
      if (!creatorPublicKey) return false;
      const result = await run(
        () => cancelAuction(creatorPublicKey, auctionId),
        { action: "Cancel auction" }
      );
      return result !== null;
    },
    [creatorPublicKey, run]
  );

  return { cancel, isCancelling, error: null };
}

// ── useRefundLosingBid ───────────────────────────────────────
//
// Refund-guidance action for a losing bidder on a terminal (Finalized or
// Cancelled) auction. Most losing bids are refunded automatically the
// moment they're outbid inside place_bid — this covers the edge case where
// the frontend believes a refund is still outstanding after finalization.

export function useRefundLosingBid(bidderPublicKey: string | null) {
  const { run, isRunning: isRefunding } = useTxToast();

  const refund = useCallback(
    async (auctionId: number): Promise<boolean> => {
      if (!bidderPublicKey) return false;
      const result = await run(
        () => refundLosingBid(bidderPublicKey, auctionId),
        { action: "Claim refund" }
      );
      return result !== null;
    },
    [bidderPublicKey, run]
  );

  return { refund, isRefunding, error: null };
}

// ── useAuctionsWithReconciliation (Issue #302) ────────────────────────────────
//
// Wraps useAuctions with provisional state tracking for bid and finalize actions.

import { useRef } from "react";

export function useAuctionsWithReconciliation() {
  const auctionsHook = useAuctions();
  const recon = useReconciliation<Auction>({ mutationTtlMs: 60_000 });

  const prevRef = useRef<Auction[]>([]);
  useEffect(() => {
    if (auctionsHook.auctions === prevRef.current) return;
    prevRef.current = auctionsHook.auctions;

    const snapshots: ConfirmedSnapshot<Auction>[] = auctionsHook.auctions.map((a) => ({
      resourceId: String(a.auction_id),
      data: a,
      ledger: (a as any).updatedAtLedger ?? 0,
    }));
    recon.applyConfirmedData(snapshots);
  }, [auctionsHook.auctions]); // eslint-disable-line react-hooks/exhaustive-deps

  const addAuctionMutation = useCallback(
    (
      action: "bid" | "finalize" | "create",
      auction: Auction,
      txHash: string | null = null
    ): string => {
      const pendingId = generatePendingId(`auction-${action}`);
      recon.addMutation({
        pendingId,
        txHash,
        kind: "auction",
        resourceId: String(auction.auction_id),
        optimisticValue: auction,
      });
      return pendingId;
    },
    [recon]
  );

  const getAuctionState = useCallback(
    (auctionId: string | number) =>
      recon.getResourceState(String(auctionId), "auction"),
    [recon]
  );

  return {
    ...auctionsHook,
    pendingMutations: recon.pendingMutations,
    addAuctionMutation,
    getAuctionState,
    resolveMutation: recon.resolveMutation,
    rejectMutation: recon.rejectMutation,
  };
}
