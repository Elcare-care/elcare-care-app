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
  Auction,
} from "@/lib/contract";
import { fetchAuctions } from "@/lib/indexer";
import { uploadImageToIPFS, uploadMetadataToIPFS, ArtworkMetadata } from "@/lib/ipfs";
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

export interface CreateAuctionInput {
  title: string;
  description: string;
  artistName: string;
  year: string;
  category: string;
  imageFile: File;
  reservePriceXlm: number;
  durationHours: number;
  royaltyBps?: number;
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
        // Step 1: Upload image to IPFS.
        setProgress("Uploading image to IPFS…");
        const imageResult = await uploadImageToIPFS(input.imageFile, input.title);

        // Step 2: Build metadata JSON.
        const metadata: ArtworkMetadata = {
          title: input.title,
          description: input.description,
          artist: input.artistName,
          image: `ipfs://${imageResult.cid}`,
          year: input.year,
          category: input.category,
        };

        // Step 3: Upload metadata to IPFS.
        setProgress("Uploading metadata to IPFS…");
        const metadataResult = await uploadMetadataToIPFS(metadata, input.title);

        // Step 4: Validate token and call the Soroban contract via useTxToast.
        setProgress("Creating on-chain auction…");
        const token = await assertSupportedTokenAddress(
          input.tokenAddress ?? DEFAULT_TOKEN.address,
          "auction"
        );
        const durationSeconds = input.durationHours * 3600;
        const auctionId = await run(
          () =>
            createAuction(
              creatorPublicKey,
              metadataResult.cid,
              input.reservePriceXlm,
              durationSeconds,
              input.royaltyBps,
              [],
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
